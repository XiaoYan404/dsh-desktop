/** Real Loader shutdown retains late Native events on the pre-existing isolated schema, without DDL or receipt changes. */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import MysqlRuntime from '@deepseek-ai/dsh-mysql'
import type { MysqlConsumer } from '@deepseek-ai/dsh-mysql'
import SessionStore, { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import MysqlSessionPersistence from '../src/index.ts'
import { decodeEvent } from '../src/records.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:mysql-shutdown/state': { text: string } }
}

const repo = resolve(import.meta.dirname, '../../../..')
const uuid = '81698848-cb10-11f1-900d-30560fa55c04'
const cleanup: Array<() => Promise<void>> = []

async function object(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(source.replace(/^\uFEFF/, '')) }
  catch (_error) { throw new Error('Invalid isolated MySQL descriptor JSON; contents omitted.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid isolated descriptor object.')
  return value as Record<string, unknown>
}
function field(object: Record<string, unknown>, key: string): string {
  const value = object[key]
  if (typeof value !== 'string' || !value.length) throw new Error('A required isolated descriptor field is missing.')
  return value
}
function canonical(path: string): string {
  const result = realpathSync.native(path).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? result.toLowerCase() : result
}
async function isolated() {
  const descriptor = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!descriptor) throw new Error('Set the reviewed DSH_MYSQL_TEST_INSTANCE descriptor; no database was contacted.')
  const ready = await object(resolve(descriptor))
  const privatePath = field(ready, 'privateConnectionFile')
  const instance = canonical(dirname(privatePath))
  const within = relative(canonical(resolve(repo, '../.local-run')), instance)
  if (isAbsolute(within) || within.startsWith('..' + sep) || !basename(instance).startsWith('enterprise-round144-mysql-instance-')) {
    throw new Error('The shutdown fixture accepts only the owned round144 instance directory.')
  }
  const target = await object(privatePath)
  const dataDir = canonical(field(target, 'dataDir'))
  const dataWithin = relative(instance, dataDir)
  const database = field(target, 'database')
  if (ready['host'] !== '127.0.0.1' || target['host'] !== ready['host'] || ready['port'] !== 11406
    || target['port'] !== ready['port'] || target['pid'] !== ready['pid'] || ready['version'] !== '8.4.11'
    || database !== 'dsh_round144_834f9e84adbd40ca95b4a3e9efb8f0ce' || isAbsolute(dataWithin) || dataWithin.startsWith('..' + sep)) {
    throw new Error('The shutdown fixture target is not the reviewed loopback database.')
  }
  const user = field(target, 'user')
  const password = field(target, 'password')
  const observer = await createConnection({ host: '127.0.0.1', port: 11406, database, user, password, charset: 'utf8mb4',
    jsonStrings: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  cleanup.push(async () => { await observer.end() })
  const [identity] = await observer.execute<RowDataPacket[]>(
    'SELECT @@GLOBAL.server_uuid AS uuid,@@GLOBAL.datadir AS dataDir,VERSION() AS version,DATABASE() AS databaseName')
  const actual = identity[0]
  if (!actual || actual['uuid'] !== uuid || actual['version'] !== ready['version'] || actual['databaseName'] !== database
    || typeof actual['dataDir'] !== 'string' || canonical(actual['dataDir']) !== dataDir) throw new Error('Unexpected isolated server identity.')
  const [receipts] = await observer.execute<RowDataPacket[]>(
    'SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version')
  expect(receipts).toHaveLength(2)
  const storeKey = 'shutdown-' + randomUUID().replaceAll('-', '')
  await observer.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)',
    [storeKey, 'Owned shutdown acceptance', JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 })])
  const [stores] = await observer.execute<RowDataPacket[]>('SELECT store_id FROM dsh_stores WHERE store_key=?', [storeKey])
  const storeId: unknown = stores[0]?.['store_id']
  if (typeof storeId !== 'string') throw new Error('The shutdown store id must remain exact text.')
  return { observer, user, password, database, storeKey, storeId, receipts }
}

class ClosingAdapter extends LlmAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  readonly aborted = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'durable partial 完整😀' }
    const aborted = (): void => { this.aborted.resolve(undefined) }
    options.signal?.addEventListener('abort', aborted, { once: true })
    if (options.signal?.aborted) aborted()
    this.entered.resolve(undefined)
    try { await this.aborted.promise; await this.release.promise }
    finally { options.signal?.removeEventListener('abort', aborted) }
    throw new Error('Controlled adapter exit after cancellation')
  }
}

async function boot(target: Awaited<ReturnType<typeof isolated>>, order: 'backend-first' | 'loop-first' = 'backend-first') {
  const home = await mkdtemp(join(tmpdir(), 'dsh-mysql-shutdown-'))
  cleanup.push(async () => {
    if (dirname(home) !== resolve(tmpdir()) || !basename(home).startsWith('dsh-mysql-shutdown-')) throw new Error('Unexpected owned fixture home.')
    await rm(home, { recursive: true, force: true })
  })
  const ref = 'MYSQL_SHUTDOWN_' + randomUUID().replaceAll('-', '').toUpperCase()
  const seed = new Context()
  try {
    await seed.plugin(CredentialsLocal, { dshHome: home, watch: false })
    await seed.credentials.set(credentialRef(ref), target.password)
  } finally { await seed.fiber.dispose() }
  const adapter = new ClosingAdapter()
  cleanup.push(async () => { adapter.release.resolve(undefined) })
  const model = { name: 'shutdown-model', inject: ['llm'], apply(ctx: Context) {
    ctx.effect(() => ctx.llm.registerAdapter(['shutdown'], adapter))
  } }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal], ['@deepseek-ai/dsh-mysql', MysqlRuntime],
    ['@deepseek-ai/dsh-session', SessionStore], ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry], ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-persistence-mysql', MysqlSessionPersistence], ['shutdown-model', model],
  ])
  const backend = [
    { name: '@deepseek-ai/dsh-mysql', config: { host: '127.0.0.1', port: 11406, database: target.database, user: target.user,
      passwordRef: ref, schemaMode: 'verify', connectionLimit: 1 } },
    { name: '@deepseek-ai/dsh-session-persistence-mysql', config: { storeKey: target.storeKey, batchDelayMs: 60000 } },
  ]
  const loop = { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } }
  const config = [{ name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: home, watch: false } },
    ...['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent'].map(name => ({ name })),
    ...(order === 'backend-first' ? [...backend, loop] : [loop, ...backend]), { name: 'shutdown-model' }]
  const path = join(home, 'cordis.yml')
  await writeFile(path, JSON.stringify(config))
  const ctx = new Context()
  cleanup.push(async () => { adapter.release.resolve(undefined); await ctx.fiber.dispose() })
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const original = ctx.loader.internal
  if (!original) throw new Error('The actual Node Loader is unavailable.')
  ctx.loader.internal = new Proxy(original, { get(owner, key) {
    if (key === 'import') return async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error('Unexpected shutdown fixture module.')
      return modules.get(specifier)
    }
    const value: unknown = Reflect.get(owner, key, owner)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(owner) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) if (entry.fiber) await entry.fiber.await()
  if (!ctx.get('sessionPersistence') || !ctx.get('agents')) throw new Error('The shutdown Native composition failed activation.')
  return { ctx, adapter }
}

function snapshot(session: Session): readonly SessionEvent[] {
  return session.snapshotEvents()
}
async function verify(target: Awaited<ReturnType<typeof isolated>>, session: Session, label: string) {
  const [rows] = await target.observer.execute<RowDataPacket[]>(
    'SELECT e.event_json FROM dsh_session_events e JOIN dsh_session_slots s ON s.store_id=e.store_id AND s.slot_id=e.slot_id AND s.current_lifecycle_id=e.lifecycle_id AND s.current_format_version=e.format_version WHERE s.store_id=? AND s.external_session_id=? ORDER BY e.seq', [target.storeId, session.id])
  const events = rows.map((row) => {
    const json: unknown = row['event_json']
    if (typeof json !== 'string') throw new Error('The shutdown event text is absent.')
    return decodeEvent(json)
  })
  expect(events).toEqual(snapshot(session))
  expect(events.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'aborted' } } })
  expect(events.some(event => event.type === 'assistant/message' && event.data.interrupted && event.data.stream?.length)).toBe(true)
  const [leases] = await target.observer.execute<RowDataPacket[]>('SELECT owner_token,lifecycle_id,expires_at FROM dsh_writer_leases WHERE store_id=?', [target.storeId])
  expect(leases).toHaveLength(1)
  expect(leases[0]).toMatchObject({ owner_token: null, lifecycle_id: null, expires_at: null })
  const [receipts] = await target.observer.execute<RowDataPacket[]>(
    'SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version')
  expect(receipts).toEqual(target.receipts)
  await writeFile(resolve(repo, '../.local-run/enterprise-round150-mysql-shutdown-' + label + '.json'), JSON.stringify({
    host: '127.0.0.1', port: 11406, serverUuid: uuid, storeKey: target.storeKey, eventCount: events.length,
    prefixSha256: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
    checks: ['actual-loader', 'active-native-cancel', 'late-closing-events', 'complete-prefix', 'lease-released', 'schema-receipts-unchanged'],
  }, null, 2) + '\n', { mode: 0o600 })
}
async function start(fixture: Awaited<ReturnType<typeof boot>>) {
  const owned = await fixture.ctx.agents.create({ sessionId: SessionId('shutdown-native-' + randomUUID()),
    meta: { cwd: tmpdir() }, agentOptions: { provider: 'shutdown', model: 'mock' } })
  cleanup.push(async () => { fixture.adapter.release.resolve(undefined); await owned.dispose() })
  owned.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'owned active shutdown' }], source: { kind: 'user' } }))
  await fixture.adapter.entered.promise
  appendPluginRecord(owned.agent.session, 'plugin:mysql-shutdown/state', { text: 'buffered before shutdown 完整😀' })
  return owned
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned shutdown fixture cleanup failed.')
})

it.each(['backend-first', 'loop-first'] as const)('root shutdown drains active Native closing events in %s order', async (order) => {
  const target = await isolated()
  const fixture = await boot(target, order)
  const native = await start(fixture)
  const persistence = fixture.ctx.sessionPersistence
  const mysql = fixture.ctx.mysql
  let finished = false
  const closing = fixture.ctx.fiber.dispose().then(() => { finished = true })
  await fixture.adapter.aborted.promise
  await setImmediate()
  expect(finished).toBe(false)
  await expect(mysql.execute('SELECT 1', [])).rejects.toMatchObject({ code: 'closed' })
  await expect(persistence.create(native.agent.session.header)).rejects.toMatchObject({ code: 'closed' })
  fixture.adapter.release.resolve(undefined)
  await closing
  await native.dispose()
  await verify(target, native.agent.session, 'root-' + order)
})

it.each(['provider', 'connection'] as const)('independent %s unload drains its exact Native producer', async (owner) => {
  const target = await isolated()
  const fixture = await boot(target)
  const native = await start(fixture)
  const mysql = fixture.ctx.mysql
  const service = owner === 'provider' ? '@deepseek-ai/dsh-session-persistence-mysql' : '@deepseek-ai/dsh-mysql'
  const entry = [...fixture.ctx.loader.entries()].find(value => value.options.name === service)
  if (!entry?.fiber) throw new Error('The actual owner fiber is missing.')
  const closing = entry.fiber.dispose()
  await fixture.adapter.aborted.promise
  fixture.adapter.release.resolve(undefined)
  await closing
  await native.dispose()
  await verify(target, native.agent.session, 'independent-' + owner)
  if (owner === 'provider') expect((await mysql.execute('SELECT 1', [])).kind).toBe('rows')
  else await expect(mysql.execute('SELECT 1', [])).rejects.toMatchObject({ code: 'closed' })
})

it('retains a consumer drain failure while other consumers finish and Cordis logs the owner failure', async () => {
  const target = await isolated()
  const fixture = await boot(target)
  const mysql = fixture.ctx.mysql
  const logger = fixture.ctx.logger
  const beforeLog = logger.buffer.length
  const failure = new Error('Controlled consumer drain refusal')
  let attempts = 0
  const bad = mysql.registerConsumer(async () => { attempts++; throw failure })
  const good: MysqlConsumer = mysql.registerConsumer(async () => {
    await good.execute('UPDATE dsh_stores SET display_name=? WHERE store_id=?', ['Drained before connection close', target.storeId])
  })
  await fixture.ctx.fiber.dispose()
  await expect(bad.dispose()).rejects.toMatchObject({ errors: [failure] })
  expect(attempts).toBe(1)
  expect(logger.buffer.slice(beforeLog).some(message => message.type === 'error' && message.args.includes(failure))).toBe(true)
  await expect(good.execute('SELECT 1', [])).rejects.toMatchObject({ code: 'closed' })
  await expect(mysql.execute('SELECT 1', [])).rejects.toMatchObject({ code: 'closed' })
  const [stored] = await target.observer.execute<RowDataPacket[]>('SELECT display_name FROM dsh_stores WHERE store_id=?', [target.storeId])
  expect(stored[0]?.['display_name']).toBe('Drained before connection close')
})
