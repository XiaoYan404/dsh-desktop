/** Real Native Agent and Loader integration on the explicitly provisioned round144 instance only. */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import MysqlRuntime, { MysqlError } from '@deepseek-ai/dsh-mysql'
import SessionStore, { appendPluginRecord, pluginRecordOf, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionReadOnlyError, SessionOwnershipLostError,
  SessionPersistenceNotFoundError, SessionHandleClosedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { createConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import MysqlSessionPersistence from '../src/index.ts'
import { decodeEvent } from '../src/records.ts'
import { MysqlSessionRepository } from '../src/repository.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:mysql-acceptance/state': { text: string } }
}

const repo = resolve(import.meta.dirname, '../../../..')
const cleanup: Array<() => Promise<void>> = []

async function json(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(source.replace(/^\uFEFF/, '')) }
  catch (_error) { throw new Error('The isolated MySQL descriptor is invalid JSON; contents omitted.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The isolated MySQL descriptor is invalid.')
  return value as Record<string, unknown>
}
function field(value: Record<string, unknown>, key: string): string {
  const item = value[key]
  if (typeof item !== 'string' || !item.length) throw new Error('A required isolated descriptor field is missing.')
  return item
}
function canonical(path: string): string {
  const native = realpathSync.native(path).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? native.toLowerCase() : native
}

async function isolated() {
  const descriptor = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!descriptor) throw new Error('DSH_MYSQL_TEST_INSTANCE must name the explicitly provisioned public descriptor; no database was contacted.')
  const ready = await json(resolve(descriptor))
  const privatePath = field(ready, 'privateConnectionFile')
  const instanceDir = dirname(privatePath)
  const within = relative(canonical(resolve(repo, '../.local-run')), canonical(instanceDir))
  if (isAbsolute(within) || within.startsWith('..' + sep)
    || !basename(instanceDir).startsWith('enterprise-round144-mysql-instance-')) throw new Error('The descriptor is outside the owned isolated instance.')
  const target = await json(privatePath)
  if (ready['host'] !== '127.0.0.1' || target['host'] !== ready['host'] || typeof ready['port'] !== 'number'
    || target['port'] !== ready['port'] || target['pid'] !== ready['pid'] || !field(ready, 'version').startsWith('8.4.')) {
    throw new Error('The isolated process identity or loopback endpoint does not match.')
  }
  const database = field(target, 'database')
  if (!/^dsh_round144_[a-f0-9]+$/.test(database)) throw new Error('Only the provided isolated database is accepted.')
  const dataDir = canonical(field(target, 'dataDir'))
  const dataWithin = relative(canonical(instanceDir), dataDir)
  if (isAbsolute(dataWithin) || dataWithin.startsWith('..' + sep)) throw new Error('The isolated data directory is outside its instance.')
  const user = field(target, 'user')
  const password = field(target, 'password')
  const observer = await createConnection({ host: '127.0.0.1', port: ready['port'], database, user, password,
    charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true, multipleStatements: false })
  cleanup.push(async () => { await observer.end() })
  const [identity] = await observer.execute<RowDataPacket[]>(
    'SELECT @@GLOBAL.server_uuid AS serverUuid,@@GLOBAL.datadir AS dataDir,VERSION() AS version,DATABASE() AS databaseName')
  const server = identity[0]
  const uuid: unknown = server?.['serverUuid']
  if (!server || typeof server['dataDir'] !== 'string' || canonical(server['dataDir']) !== dataDir
    || server['version'] !== ready['version'] || server['databaseName'] !== database || typeof uuid !== 'string') {
    throw new Error('The connected server is not the declared isolated process.')
  }
  const storeKey = 'session-acceptance-' + randomUUID().replaceAll('-', '')
  await observer.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)',
    [storeKey, 'Owned Session provider acceptance', JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 })])
  const [stores] = await observer.execute<RowDataPacket[]>('SELECT store_id FROM dsh_stores WHERE store_key=?', [storeKey])
  const store: unknown = stores[0]?.['store_id']
  if (typeof store !== 'string') throw new Error('The acceptance store key is not exact text.')
  return { observer, host: '127.0.0.1', port: ready['port'], database, user, password, storeKey, storeId: store,
    serverUuid: uuid, version: field(ready, 'version') }
}

async function boot(target: Awaited<ReturnType<typeof isolated>>, response = 'native response') {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mysql-session-acceptance-'))
  cleanup.push(async () => {
    if (dirname(home) !== resolve(tmpdir()) || !basename(home).startsWith('dsh-mysql-session-acceptance-')) throw new Error('Unexpected fixture path.')
    await rm(home, { recursive: true, force: true })
  })
  const ref = 'DSH_MYSQL_SESSION_' + randomUUID().replaceAll('-', '').toUpperCase()
  const seed = new Context()
  try {
    await seed.plugin(CredentialsLocal, { dshHome: home, watch: false })
    await seed.credentials.set(credentialRef(ref), target.password)
  }
  finally { await seed.fiber.dispose() }
  const adapter = new MockAdapter([textResponse(response)])
  const model = { name: 'mysql-acceptance-model', inject: ['llm'], apply(ctx: Context) {
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  } }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal], ['@deepseek-ai/dsh-mysql', MysqlRuntime],
    ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-persistence-mysql', MysqlSessionPersistence], ['mysql-acceptance-model', model],
  ])
  const config = [
    { name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: home, watch: false } },
    { name: '@deepseek-ai/dsh-mysql', config: { host: target.host, port: target.port, database: target.database,
      user: target.user, passwordRef: ref, schemaMode: 'verify', connectionLimit: 4 } },
    ...['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent'].map(name => ({ name })),
    { name: '@deepseek-ai/dsh-session-persistence-mysql', config: { storeKey: target.storeKey } },
    { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } }, { name: 'mysql-acceptance-model' },
  ]
  const path = join(home, 'cordis.yml')
  await writeFile(path, JSON.stringify(config))
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose() })
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (!internal) throw new Error('The Node Loader is unavailable.')
  ctx.loader.internal = new Proxy(internal, { get(owner, key) {
    if (key === 'import') return async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error('Unexpected acceptance fixture module.')
      return modules.get(specifier)
    }
    const value: unknown = Reflect.get(owner, key, owner)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(owner) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) if (entry.fiber) await entry.fiber.await()
  if (!ctx.get('sessionPersistence') || !ctx.get('agents')) throw new Error('The real Native provider composition did not activate.')
  return { ctx, adapter }
}

function own<T extends SessionHandle>(handle: T): T {
  cleanup.push(async () => { await handle.close() })
  return handle
}
async function readAll(ctx: Context, id: ReturnType<typeof SessionId>) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try { return (await handle.read()).events }
  finally { await handle.close() }
}
async function runTurn(ctx: Context, agent: Agent, prompt: string): Promise<void> {
  const settled = Promise.withResolvers<undefined>()
  const remove = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject === agent && status === 'idle') settled.resolve(undefined)
  })
  const timeout = setTimeout(() => { settled.reject(new Error('The owned Native turn did not reach idle.')) }, 15000)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await settled.promise
    await ctx.sessionPersistence.flush()
  } finally { clearTimeout(timeout); remove() }
}

afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Explicit MySQL provider fixture cleanup failed.')
})

it('preserves Session handle errors, delayed publication, frozen receipts and stale-fence refusal', async () => {
  const target = await isolated()
  const { ctx } = await boot(target)
  const id = SessionId('句柄 / unchanged 😀')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 1000, isSeeded: false }
  const abandoned = own(await ctx.sessionPersistence.create(header))
  await expect(ctx.sessionPersistence.create(header)).rejects.toBeInstanceOf(SessionAlreadyExistsError)
  await expect(ctx.sessionPersistence.open(id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
  const other = await boot(target)
  expect(await other.ctx.sessionPersistence.stat(id)).toBeUndefined()
  await expect(other.ctx.sessionPersistence.open(id, 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  await abandoned.close()
  expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
  const writer = own(await ctx.sessionPersistence.create(header))
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const capture = vi.spyOn(MysqlSessionRepository.prototype, 'append')
  const transaction = vi.spyOn(ctx.mysql, 'transaction').mockImplementationOnce(async () => {
    throw new MysqlError('transaction_unknown', 'Controlled lost acknowledgement; not a wire-fault claim.', 'unknown')
  })
  await expect(writer.append(events)).rejects.toMatchObject({ outcome: 'unknown' })
  transaction.mockRestore()
  await writer.flush()
  expect(capture.mock.calls).toHaveLength(2)
  expect(capture.mock.calls[0]?.[4].batchId.equals(capture.mock.calls[1]?.[4].batchId ?? Buffer.alloc(0))).toBe(true)
  capture.mockRestore()
  const reader = own(await ctx.sessionPersistence.open(id, 'read'))
  expect((await reader.read()).events).toEqual(events)
  await expect(reader.append([])).rejects.toBeInstanceOf(SessionReadOnlyError)
  await expect(reader.flush()).rejects.toBeInstanceOf(SessionReadOnlyError)
  const [receipts] = await target.observer.execute<RowDataPacket[]>(
    'SELECT LOWER(HEX(payload_sha256)) AS digest FROM dsh_append_batches WHERE store_id=?', [target.storeId])
  expect(receipts).toHaveLength(1)
  expect(receipts[0]?.['digest']).toBe(createHash('sha256').update(JSON.stringify(events)).digest('hex'))
  await target.observer.execute('UPDATE dsh_writer_leases SET expires_at=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP(6)) WHERE store_id=?', [target.storeId])
  const successor = own(await other.ctx.sessionPersistence.open(id, 'write'))
  await expect(writer.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }]))
    .rejects.toBeInstanceOf(SessionOwnershipLostError)
  await writer.close()
  await successor.append([{ type: 'turn/start', seq: SessionSeq(2), time: 3, data: { turn: 2 } }])
  expect((await reader.read()).events).toHaveLength(3)
  await successor.close()
  await expect(successor.read()).rejects.toBeInstanceOf(SessionHandleClosedError)
})

it('creates a Native Agent, closes it, restores through a new Loader and appends without changing the complete prefix', async () => {
  const target = await isolated()
  const first = await boot(target, 'first native response 完整😀')
  const id = SessionId('native-original-id-' + randomUUID())
  const created = await first.ctx.agents.create({ sessionId: id, meta: { cwd: tmpdir() },
    agentOptions: { provider: 'mock', model: 'mock' } })
  cleanup.push(async () => { await created.dispose() })
  await runTurn(first.ctx, created.agent, 'first owned prompt')
  appendPluginRecord(created.agent.session, 'plugin:mysql-acceptance/state', { text: 'persistent plugin payload 😀' })
  await first.ctx.sessions.flush(created.agent.session)
  await created.dispose()
  const prefix = await readAll(first.ctx, id)
  const original = await first.ctx.sessionPersistence.stat(id)
  expect(prefix.some(event => event.type === 'assistant/message' && event.data.stream.length > 0)).toBe(true)
  expect(prefix.some(event => pluginRecordOf(event)?.type === 'plugin:mysql-acceptance/state')).toBe(true)
  const [persisted] = await target.observer.execute<RowDataPacket[]>(
    'SELECT e.event_json FROM dsh_session_events e JOIN dsh_session_slots s ON s.store_id=e.store_id AND s.slot_id=e.slot_id AND s.current_lifecycle_id=e.lifecycle_id AND s.current_format_version=e.format_version WHERE e.store_id=? AND s.external_session_id=? ORDER BY e.seq',
    [target.storeId, id])
  const durable = persisted.map((row) => {
    const value: unknown = row['event_json']
    if (typeof value !== 'string') throw new Error('The durable Native event text is missing.')
    return decodeEvent(value)
  })
  expect(durable).toEqual(prefix)
  await first.ctx.fiber.dispose()
  const second = await boot(target, 'second native response')
  const restored = await second.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
  cleanup.push(async () => { await restored.dispose() })
  expect(restored.agent.session.id).toBe(id)
  expect(restored.agent.session.header).toEqual(original?.header)
  await runTurn(second.ctx, restored.agent, 'continue the owned session')
  await restored.dispose()
  const complete = await readAll(second.ctx, id)
  expect(complete.slice(0, prefix.length)).toEqual(prefix)
  expect(complete.map(event => event.seq)).toEqual(complete.map((_, index) => index))
  expect(complete.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
  expect(second.adapter.requests).toHaveLength(1)
  const [jobs] = await target.observer.execute<RowDataPacket[]>(
    'SELECT target_event_count FROM dsh_search_jobs WHERE store_id=?', [target.storeId])
  expect(Number(jobs[0]?.['target_event_count'])).toBe(complete.length)
  await writeFile(resolve(repo, '../.local-run/enterprise-round147-mysql-session-native.json'), JSON.stringify({
    version: target.version, serverUuid: target.serverUuid, host: target.host, port: target.port, storeKey: target.storeKey,
    originalEventCount: prefix.length, restoredEventCount: complete.length,
    originalPrefixSha256: createHash('sha256').update(JSON.stringify(prefix)).digest('hex'),
    checks: ['native-create', 'explicit-close', 'fresh-loader-resume', 'full-durable-prefix', 'plugin-record', 'compact-stream',
      'continuous-seq', 'same-header', 'continue-turn', 'search-job-watermark'],
    excluded: ['root-concurrent-unload-drain', 'wire-commit-fault', 'jsonl-snapshot-harvester', 'cli-sdk-overlay'],
  }, null, 2) + '\n', { mode: 0o600 })
})
