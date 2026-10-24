/** Lose one genuine COMMIT OK after independent confirmation, then observe native receipt reconciliation. */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import MysqlRuntime from '@deepseek-ai/dsh-mysql'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise'
import MysqlSessionPersistence from '../src/index.ts'
import { MysqlSessionRepository } from '../src/repository.ts'
import type { FrozenBatch, WriterIdentity } from '../src/types.ts'
import { profileReceipts, profileServerUuid } from './fixtures/owned-profile-instance.ts'
import { createCommitAckProxy, type CommitAckProxy } from './fixtures/mysql-commit-proxy.ts'

const repo = resolve(import.meta.dirname, '../../../..')
const database = 'dsh_round144_834f9e84adbd40ca95b4a3e9efb8f0ce'
const expectedReceipts = [
  ['1', 'r7-initial-20-tables', '4f897d35c8472182eaaab3117d313f382e078d7f4f8288a35bb9b24f708e9be9'],
  ['2', 'json-safe-integers', '94e5c1d36047cd6a0c43d3d00d0e44af38d2c896e352d39b8ee7a56e83ce6a07'],
]

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('A required owned wire-fixture field is absent.')
  return value
}
function canonical(path: string): string {
  const result = realpathSync.native(path).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? result.toLowerCase() : result
}
function contained(parent: string, child: string): boolean {
  const result = relative(parent, child)
  return !isAbsolute(result) && result !== '..' && !result.startsWith('..' + sep)
}
async function object(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(source.replace(/^\uFEFF/, '')) }
  catch (_error) { throw new Error('Invalid owned wire descriptor JSON; contents omitted.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid owned wire descriptor object.')
  return value as Record<string, unknown>
}

async function isolated() {
  const path = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!path) throw new Error('Set the reviewed DSH_MYSQL_TEST_INSTANCE descriptor; no database was contacted.')
  const ready = await object(resolve(path))
  const privatePath = text(ready['privateConnectionFile'])
  const instance = canonical(dirname(privatePath))
  if (!contained(canonical(resolve(repo, '../.local-run')), instance)
    || !basename(instance).startsWith('enterprise-round144-mysql-instance-')) throw new Error('Not the owned round144 wire-fault instance.')
  const target = await object(privatePath)
  const dataDir = canonical(text(target['dataDir']))
  if (ready['host'] !== '127.0.0.1' || target['host'] !== ready['host'] || ready['port'] !== 11406
    || target['port'] !== 11406 || target['pid'] !== ready['pid'] || ready['version'] !== '8.4.11'
    || target['database'] !== database || !contained(instance, dataDir)) throw new Error('Unreviewed wire-fault database endpoint or data directory.')
  const user = text(target['user']), password = text(target['password'])
  if (user.toLowerCase() === 'root') throw new Error('The wire fixture requires the provided database-scoped account.')
  const observer = await createConnection({ host: '127.0.0.1', port: 11406, database, user, password,
    charset: 'utf8mb4', jsonStrings: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    timezone: 'Z', multipleStatements: false, connectTimeout: 5000 })
  try {
    const [identity] = await observer.execute<RowDataPacket[]>(
      'SELECT @@GLOBAL.server_uuid AS uuid,@@GLOBAL.datadir AS dataDir,VERSION() AS version,DATABASE() AS db')
    const actual = identity[0]
    if (!actual || actual['uuid'] !== profileServerUuid || actual['version'] !== '8.4.11' || actual['db'] !== database
      || canonical(text(actual['dataDir'])) !== dataDir) throw new Error('The connected wire-fault server is not the approved instance.')
    const receipts = await profileReceipts(observer)
    const receiptIdentity = receipts.map(row => [String(row['schema_version']), text(row['migration_name']), text(row['checksum']).toLowerCase()])
    expect(receiptIdentity).toEqual(expectedReceipts)
    const storeKey = 'wire-' + randomUUID().replaceAll('-', '')
    console.log('Owned wire namespace: ' + storeKey)
    await observer.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)',
      [storeKey, 'Owned wire COMMIT acknowledgement fault', JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 })])
    const [stores] = await observer.execute<RowDataPacket[]>('SELECT store_id FROM dsh_stores WHERE store_key=?', [storeKey])
    const storeId = text(stores[0]?.['store_id'])
    // Provisioning is complete; every later statement on this independent connection is read-only.
    await observer.query('SET SESSION TRANSACTION READ ONLY')
    const [mode] = await observer.query<RowDataPacket[]>('SELECT @@SESSION.transaction_read_only AS readOnly')
    expect(Number(mode[0]?.['readOnly'])).toBe(1)
    return { observer, storeKey, storeId, user, password, receipts }
  } catch (error) {
    const failures = [error]
    try { await observer.end() } catch (closeError) { failures.push(closeError) }
    throw failures.length === 1 ? error : new AggregateError(failures, 'Owned wire observer setup and cleanup failed.')
  }
}

async function boot(ctx: Context, home: string, target: Awaited<ReturnType<typeof isolated>>, port: number): Promise<void> {
  const ref = 'MYSQL_WIRE_' + randomUUID().replaceAll('-', '').toUpperCase()
  const seed = new Context()
  const seedFailures: unknown[] = []
  try {
    await seed.plugin(CredentialsLocal, { dshHome: home, watch: false })
    await seed.credentials.set(credentialRef(ref), target.password)
  } catch (error) { seedFailures.push(error) }
  try { await seed.fiber.dispose() } catch (error) { seedFailures.push(error) }
  if (seedFailures.length > 0) throw new AggregateError(seedFailures, 'Owned wire fixture credential provisioning failed.')
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal], ['@deepseek-ai/dsh-mysql', MysqlRuntime],
    ['@deepseek-ai/dsh-session-persistence-mysql', MysqlSessionPersistence],
  ])
  const config = [
    { name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: home, watch: false } },
    { name: '@deepseek-ai/dsh-mysql', config: { host: '127.0.0.1', port, database, user: target.user,
      passwordRef: ref, schemaMode: 'verify', connectionLimit: 1, operationTimeoutMs: 10000, schemaTimeoutMs: 15000 } },
    { name: '@deepseek-ai/dsh-session-persistence-mysql', config: {
      storeKey: target.storeKey, heartbeatIntervalMs: 60000, leaseTtlMs: 180000,
    } },
  ]
  const path = join(home, 'cordis.yml')
  await writeFile(path, JSON.stringify(config))
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const original = ctx.loader.internal
  if (!original) throw new Error('The owned wire fixture requires the actual Node Loader.')
  ctx.loader.internal = new Proxy(original, { get(owner, key) {
    if (key === 'import') return async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error('Unexpected module in the owned wire fixture composition.')
      return modules.get(specifier)
    }
    const value: unknown = Reflect.get(owner, key, owner)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(owner) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) if (entry.fiber) await entry.fiber.await()
  if (!ctx.get('sessionPersistence') || !ctx.get('mysql')) throw new Error('The actual MySQL provider composition did not activate.')
}

async function snapshot(connection: Connection, storeId: string) {
  const [logs] = await connection.execute<RowDataPacket[]>(
    'SELECT s.external_session_id AS id,l.slot_id,HEX(l.lifecycle_id) AS lifecycle,l.format_version,l.header_json,l.event_count,l.log_revision,w.fence_token,(w.owner_token IS NULL) AS lease_released FROM dsh_session_slots s JOIN dsh_session_logs l ON l.store_id=s.store_id AND l.slot_id=s.slot_id AND l.lifecycle_id=s.current_lifecycle_id AND l.format_version=s.current_format_version JOIN dsh_writer_leases w ON w.store_id=s.store_id AND w.slot_id=s.slot_id WHERE s.store_id=?', [storeId])
  expect(logs.length).toBe(1)
  const log = logs[0]
  if (!log) throw new Error('The owned wire log is not committed.')
  const key = [storeId, text(log['slot_id']), text(log['lifecycle']), Number(log['format_version'])]
  const [events] = await connection.execute<RowDataPacket[]>(
    'SELECT seq,event_json FROM dsh_session_events WHERE store_id=? AND slot_id=? AND lifecycle_id=UNHEX(?) AND format_version=? ORDER BY seq', key)
  const [receipts] = await connection.execute<RowDataPacket[]>(
    'SELECT HEX(batch_id) AS batch_id,first_seq,batch_event_count,LOWER(HEX(payload_sha256)) AS digest,committed_revision,writer_fence FROM dsh_append_batches WHERE store_id=? AND slot_id=? AND lifecycle_id=UNHEX(?) AND format_version=?', key)
  return { log, events, receipts }
}

function assertCommitted(saved: Awaited<ReturnType<typeof snapshot>>, batch: FrozenBatch, writer: WriterIdentity,
  header: SessionHeader): void {
  expect(saved.log['id']).toBe(header.id)
  expect(JSON.parse(text(saved.log['header_json'])) as unknown).toEqual(header)
  expect(text(saved.log['lifecycle']).toLowerCase()).toBe(writer.lifecycle.toString('hex'))
  expect(Number(saved.log['format_version'])).toBe(header.version)
  expect(Number(saved.log['event_count'])).toBe(batch.events.length)
  expect(saved.events.map(row => JSON.parse(text(row['event_json'])) as unknown)).toEqual(batch.events)
  expect(saved.events.map(row => Number(row['seq']))).toEqual([0, 1])
  expect(saved.receipts.length).toBe(1)
  const receipt = saved.receipts[0]
  if (!receipt) throw new Error('The owned wire append receipt is absent.')
  expect(text(receipt['batch_id']).toLowerCase()).toBe(batch.batchId.toString('hex'))
  expect(Number(receipt['first_seq'])).toBe(batch.firstSeq)
  expect(Number(receipt['batch_event_count'])).toBe(batch.events.length)
  expect(receipt['digest']).toBe(batch.sha256.toString('hex'))
  expect(String(receipt['committed_revision'])).toBe(String(saved.log['log_revision']))
  expect(String(receipt['writer_fence'])).toBe(writer.fence)
  expect(String(saved.log['fence_token'])).toBe(writer.fence)
}

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => { reject(new Error('Owned wire fixture deadline: ' + label)) }, 12000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

it('resolves the original append from its receipt after a genuine COMMIT OK is dropped', async () => {
  const runId = randomUUID().replaceAll('-', '')
  let target: Awaited<ReturnType<typeof isolated>> | undefined
  let proxy: CommitAckProxy | undefined
  let ctx: Context | undefined
  let home: string | undefined
  let writer: SessionHandle | undefined
  let append: Promise<{ ok: true } | { error: unknown }> | undefined
  let restoreCapture: (() => void) | undefined
  const failures: unknown[] = []
  let evidence: Record<string, unknown> | undefined
  try {
    target = await isolated()
    proxy = await createCommitAckProxy()
    home = await mkdtemp(join(tmpdir(), 'dsh-mysql-wire-'))
    ctx = new Context()
    await boot(ctx, home, target, proxy.port)
    const header: SessionHeader = { id: SessionId('wire-ack / ' + runId), version: SESSION_FORMAT_VERSION,
      createdAt: Date.now(), isSeeded: false }
    writer = await ctx.sessionPersistence.create(header)
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: header.createdAt, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: header.createdAt + 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const capture = vi.spyOn(MysqlSessionRepository.prototype, 'append')
    restoreCapture = () => { capture.mockRestore() }
    proxy.arm()
    let appendSettled = false
    append = writer.append(events).then(
      () => { appendSettled = true; return { ok: true } as const },
      (error: unknown) => { appendSettled = true; return { error } },
    )
    const held = await deadline(proxy.held(), 'awaiting the real upstream COMMIT OK')
    expect(appendSettled).toBe(false)
    expect(capture.mock.calls.length).toBe(1)
    const call = capture.mock.calls[0]
    if (!call) throw new Error('The provider did not prepare its native append batch.')
    const identity = call[0], batch = call[4]
    expect(batch.sha256.toString('hex')).toBe(createHash('sha256').update(JSON.stringify(events)).digest('hex'))
    const beforeDisconnect = await snapshot(target.observer, target.storeId)
    assertCommitted(beforeDisconnect, batch, identity, header)
    expect(appendSettled).toBe(false)
    expect(proxy.stats()).toMatchObject({ targetedCommitCommands: 1, heldCommitOks: 1, droppedCommitOks: 0,
      receiptReadbacks: 0, eventInserts: 2, receiptInserts: 1 })
    await proxy.drop()
    const settled = await deadline(append, 'waiting for native receipt readback')
    if ('error' in settled) throw settled.error
    expect(capture.mock.calls.length).toBe(1)
    const afterReadback = await snapshot(target.observer, target.storeId)
    assertCommitted(afterReadback, batch, identity, header)
    expect(afterReadback).toEqual(beforeDisconnect)
    await writer.flush()
    expect(capture.mock.calls.length).toBe(1)
    await writer.close()
    writer = undefined
    const afterClose = await snapshot(target.observer, target.storeId)
    assertCommitted(afterClose, batch, identity, header)
    expect(Number(afterClose.log['lease_released'])).toBe(1)
    expect(afterClose.events).toEqual(beforeDisconnect.events)
    expect(afterClose.receipts).toEqual(beforeDisconnect.receipts)
    expect(await profileReceipts(target.observer)).toEqual(target.receipts)
    const stats = proxy.stats()
    expect(stats).toMatchObject({ targetedCommitCommands: 1, heldCommitOks: 1, droppedCommitOks: 1,
      eventInserts: 2, receiptInserts: 1, eventInsertsAfterDrop: 0, receiptInsertsAfterDrop: 0 })
    expect(stats.receiptReadbacks).toBe(1)
    expect(stats.connections).toBeGreaterThan(held.connection)
    proxy.assertHealthy()
    evidence = { serverUuid: profileServerUuid, host: '127.0.0.1', upstreamPort: 11406, database,
      proxyPort: proxy.port, storeKey: target.storeKey, schemaMode: 'verify', schemaReceiptsUnchanged: true,
      observerReadOnly: true, appendCalls: capture.mock.calls.length, appendOutcome: 'resolved-after-durable-receipt-readback',
      frozenBatchSha256: batch.sha256.toString('hex'), events: 2, receipts: 1, heldUpstreamOk: held, wire: stats,
      excluded: ['server-restart', 'heartbeat-failure', 'receipt-readback-unavailable', 'external-tool-exactly-once'] }
  } catch (error) { failures.push(error) }

  const clean = async (work: () => Promise<unknown>): Promise<void> => {
    try { await work() } catch (error) { failures.push(error) }
  }
  // Release held ACK ownership before awaiting the original append or provider teardown.
  if (proxy) await clean(() => proxy.drop())
  if (append) await clean(async () => {
    const result = await deadline(append, 'settling an admitted append during cleanup')
    if ('error' in result && !failures.includes(result.error)) failures.push(result.error)
  })
  if (writer) await clean(() => writer.close())
  if (ctx) await clean(() => ctx.fiber.dispose())
  if (proxy) await clean(() => proxy.close())
  if (target) await clean(() => target.observer.end())
  restoreCapture?.()
  if (home) await clean(async () => {
    if (dirname(home) !== resolve(tmpdir()) || !basename(home).startsWith('dsh-mysql-wire-')) throw new Error('Unexpected owned wire home.')
    await rm(home, { recursive: true, force: true })
  })
  if (failures.length > 1) throw new AggregateError(failures, 'The wire-COMMIT scenario and all owned cleanup outcomes were retained.')
  if (failures.length === 1) throw failures[0]
  if (!evidence) throw new Error('The wire-COMMIT scenario produced no completed evidence.')
  const artifact = resolve(repo, '../.local-run/enterprise-wire-commit-' + runId + '.json')
  await writeFile(artifact, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
  console.log('Owned wire-COMMIT evidence: ' + basename(artifact))
})
