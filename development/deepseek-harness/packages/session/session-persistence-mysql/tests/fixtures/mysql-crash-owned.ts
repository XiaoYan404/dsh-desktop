/** One new crash namespace, read-only SQL observation, and caller-owned built profile processes. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { LaunchedAcpTestAgent } from '@deepseek-ai/dsh-session-snapshot'
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise'
import { canonical, json, text } from './mysql-corpus/owned-instance.ts'

/** The single reviewed owned MySQL 8.4 instance used by this new scenario. */
export const crashServerUuid = '81698848-cb10-11f1-900d-30560fa55c04'
const database = 'dsh_round144_834f9e84adbd40ca95b4a3e9efb8f0ce'
const migrations = [
  ['1', 'r7-initial-20-tables', '4f897d35c8472182eaaab3117d313f382e078d7f4f8288a35bb9b24f708e9be9'],
  ['2', 'json-safe-integers', '94e5c1d36047cd6a0c43d3d00d0e44af38d2c896e352d39b8ee7a56e83ce6a07'],
]

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}

/**
 * Verify server identity and unchanged schema receipts, create only one fresh crash-* store, then restrict SQL to reads.
 * @param repo - Repository whose sibling .local-run owns the reviewed descriptor.
 * @returns A separate read-only SQL observer and private credential materializers.
 */
export async function ownedCrashInstance(repo: string) {
  const path = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!path) throw new Error('DSH_MYSQL_TEST_INSTANCE is required; no database was contacted.')
  const ready = await json(resolve(path)), privatePath = text(ready['privateConnectionFile'])
  const instance = canonical(dirname(privatePath))
  if (!contained(canonical(resolve(repo, '../.local-run')), instance)
    || basename(instance) !== 'enterprise-round144-mysql-instance-053f0f89f6f448d093a6821ff5858fda') {
    throw new Error('The crash fixture refuses another instance directory.')
  }
  const target = await json(privatePath), dataDir = canonical(text(target['dataDir']))
  if (ready['host'] !== '127.0.0.1' || target['host'] !== ready['host'] || ready['port'] !== 11406
    || target['port'] !== 11406 || target['pid'] !== ready['pid'] || ready['version'] !== '8.4.11'
    || target['database'] !== database || !contained(instance, dataDir)) throw new Error('Unreviewed crash database target.')
  const user = text(target['user']), password = text(target['password'])
  if (user.toLowerCase() === 'root') throw new Error('The crash fixture requires the provided database-scoped account.')
  const observer = await createConnection({ host: '127.0.0.1', port: 11406, database, user, password,
    charset: 'utf8mb4', jsonStrings: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    timezone: 'Z', multipleStatements: false, connectTimeout: 5000 })
  try {
    const [identity] = await observer.execute<RowDataPacket[]>(
      'SELECT @@GLOBAL.server_uuid AS uuid,@@GLOBAL.datadir AS dataDir,VERSION() AS version,DATABASE() AS db')
    const actual = identity[0]
    if (!actual || actual['uuid'] !== crashServerUuid || actual['version'] !== '8.4.11' || actual['db'] !== database
      || canonical(text(actual['dataDir'])) !== dataDir) throw new Error('The actual crash server differs from the reviewed instance.')
    const receipts = async () => {
      const [rows] = await observer.execute<RowDataPacket[]>(
        'SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version')
      return rows
    }
    const before = await receipts()
    const identities = before.map(row => [String(row['schema_version']), text(row['migration_name']), text(row['checksum']).toLowerCase()])
    if (JSON.stringify(identities) !== JSON.stringify(migrations)) throw new Error('The crash fixture requires the two unchanged schema receipts.')
    const storeKey = 'crash-' + randomUUID().replaceAll('-', '')
    await observer.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)',
      [storeKey, 'Owned process crash and natural writer expiry', JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 })])
    const [stores] = await observer.execute<RowDataPacket[]>('SELECT store_id FROM dsh_stores WHERE store_key=?', [storeKey])
    const storeId = text(stores[0]?.['store_id'])
    await observer.query('SET SESSION TRANSACTION READ ONLY')
    const [mode] = await observer.query<RowDataPacket[]>('SELECT @@SESSION.transaction_read_only AS readOnly')
    if (Number(mode[0]?.['readOnly']) !== 1) throw new Error('The crash SQL observer did not become read-only.')
    return { observer, storeKey, storeId, before, receipts,
      mysqlConfig: (ref: string) => ({ host: '127.0.0.1', port: 11406, database, user, passwordRef: ref, schemaMode: 'verify' as const }),
      seedCredential: async (ctx: Context, ref: string): Promise<void> => { await ctx.credentials.set(credentialRef(ref), password) },
      environment: (): NodeJS.ProcessEnv => ({ DSH_MYSQL_HOST: '127.0.0.1', DSH_MYSQL_PORT: '11406',
        DSH_MYSQL_DATABASE: database, DSH_MYSQL_USER: user, DSH_MYSQL_PASSWORD: password, DSH_MYSQL_STORE_KEY: storeKey }),
    }
  } catch (error) {
    try { await observer.end() }
    catch (closeError) { throw new AggregateError([error, closeError], 'Crash observer setup and cleanup failed.') }
    throw error
  }
}

/**
 * Read the sole current log and actual lease using the already read-only observer.
 * @param connection - Independently owned SQL observer.
 * @param storeId - This scenario's newly allocated store.
 * @returns Complete native JSON texts, append receipts, identity, and lease observations; owner bytes stay in memory.
 */
export async function crashSnapshot(connection: Connection, storeId: string) {
  const [logs] = await connection.execute<RowDataPacket[]>(
    'SELECT s.external_session_id AS id,l.slot_id,HEX(l.lifecycle_id) AS lifecycle,l.format_version,l.header_json,l.inherited_event_count,l.event_count,l.log_revision,w.fence_token,HEX(w.owner_token) AS owner,w.expires_at,(w.expires_at>UTC_TIMESTAMP(6)) AS valid,TIMESTAMPDIFF(MICROSECOND,UTC_TIMESTAMP(6),w.expires_at) AS remaining FROM dsh_session_slots s JOIN dsh_session_logs l ON l.store_id=s.store_id AND l.slot_id=s.slot_id AND l.lifecycle_id=s.current_lifecycle_id AND l.format_version=s.current_format_version JOIN dsh_writer_leases w ON w.store_id=s.store_id AND w.slot_id=s.slot_id WHERE s.store_id=?', [storeId])
  const log = logs[0]
  if (logs.length !== 1 || !log) throw new Error('The new crash store must contain exactly one materialized log.')
  const metadata = { id: text(log['id']), slot: text(log['slot_id']), lifecycle: text(log['lifecycle']),
    version: Number(log['format_version']), headerText: text(log['header_json']), inherited: Number(log['inherited_event_count']),
    eventCount: Number(log['event_count']), revision: String(log['log_revision']) }
  const key = [storeId, metadata.slot, metadata.lifecycle, metadata.version]
  const [events] = await connection.execute<RowDataPacket[]>(
    'SELECT seq,event_json FROM dsh_session_events WHERE store_id=? AND slot_id=? AND lifecycle_id=UNHEX(?) AND format_version=? ORDER BY seq', key)
  const [receipts] = await connection.execute<RowDataPacket[]>(
    'SELECT HEX(batch_id) AS batch_id,first_seq,batch_event_count,LOWER(HEX(payload_sha256)) AS digest,committed_revision,writer_fence FROM dsh_append_batches WHERE store_id=? AND slot_id=? AND lifecycle_id=UNHEX(?) AND format_version=? ORDER BY first_seq,batch_id', key)
  return { metadata, events: events.map(row => ({ seq: Number(row['seq']), text: text(row['event_json']) })), receipts,
    lease: { fence: String(log['fence_token']), owner: log['owner'] === null ? null : text(log['owner']),
      valid: Number(log['valid']) === 1, expiresAt: log['expires_at'] === null ? null : text(log['expires_at']),
      remainingMs: log['remaining'] === null ? null : Number(log['remaining']) / 1000 } }
}

/**
 * Read through a real public provider handle and always settle its close, preserving both failures.
 * @param persistence - Independently owned real Session provider.
 * @param id - Original Native Session id.
 * @returns The immutable header, inherited cut, and complete current typed events.
 */
export async function readCrashNative(persistence: SessionPersistence, id: SessionId) {
  const handle = await persistence.open(id, 'read')
  const result = await handle.read().then(
    events => ({ header: handle.header, inherited: handle.inheritedEventCount, events: events.events }),
    (error: unknown) => ({ error }))
  const [closing] = await Promise.allSettled([handle.close()])
  if ('error' in result) {
    if (closing.status === 'rejected') throw new AggregateError([result.error, closing.reason], 'Crash observer read and close failed.')
    throw result.error
  }
  if (closing.status === 'rejected') throw closing.reason
  return result
}

/**
 * Install explicit optional artifacts into one isolated profile using normal package lookup.
 * @param repo - Repository containing existing built artifacts.
 * @param cwd - New child process directory, distinct from the Session's working directory.
 */
export async function installCrashProfile(repo: string, cwd: string): Promise<void> {
  const profile = join(cwd, '.dsh/profiles/acp')
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
  const dependencies: Record<string, string> = {}
  for (const path of ['packages/storage/mysql', 'packages/session/session-persistence-mysql']) {
    const dir = join(repo, path), pkg = await json(join(dir, 'package.json'))
    if (!existsSync(join(dir, 'lib/index.js'))) throw new Error('A required optional built artifact is absent; this test never builds it.')
    dependencies[text(pkg['name'])] = text(pkg['version'])
    await symlink(dir, join(profile, 'node_modules', text(pkg['name'])), process.platform === 'win32' ? 'junction' : 'dir')
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-owned-mysql-process-crash', version: '1.0.0',
    private: true, dependencies, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
}

/**
 * Remove inherited settings and real model credentials from a profile child's environment.
 * @param home - Fresh per-child directory supplying all user configuration roots.
 * @returns Explicit environment deletions plus the minimal Windows/Node process settings.
 */
export function crashEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
  const paths = [dirname(process.execPath)]
  if (process.env['SystemRoot']) paths.push(join(process.env['SystemRoot'], 'System32'))
  Object.assign(env, { PATH: paths.join(process.platform === 'win32' ? ';' : ':'), HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home, DSH_TELEMETRY_DISABLED: '1', DSH_EXAMPLE_MODE: 'lib',
    DSH_PRIMARY_RUNTIME: '', DSH_BUNDLED_OFFICE_CLI: '' })
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT']) env[key] = process.env[key]
  return env
}

/**
 * Bound a caller-owned operation without discarding its eventual rejection.
 * @param work - Already observed operation, whose owner still joins it during cleanup.
 * @param label - Safe operation description without process output or credentials.
 * @param timeoutMs - Failure deadline for this operation.
 * @returns The operation's original result.
 */
export async function crashDeadline<T>(work: Promise<T>, label: string, timeoutMs = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('Owned crash scenario deadline: ' + label)) }, timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

/**
 * Poll actual public/SQL observations; neither leases nor clocks are changed.
 * @param observe - One fully settled independent read.
 * @param matches - The required observed state.
 * @param label - Safe state description for a deadline failure.
 * @returns The first matching observed value.
 */
export async function crashUntil<T>(observe: () => Promise<T>, matches: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15000
  while (true) {
    const value = await observe()
    if (matches(value)) return value
    if (Date.now() >= deadline) throw new Error('Owned crash observation deadline: ' + label)
    await delay(40)
  }
}

/**
 * Force only this newly spawned owned child to exit; do not send EOF or run its graceful teardown first.
 * @param launched - Exact ChildProcess object returned by this scenario's public launcher.
 * @returns Actual OS exit status, including independent Windows code/signal observations.
 */
export async function crashOwnedChild(launched: LaunchedAcpTestAgent): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  await launched.spawned
  const child = launched.child
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('The intended owned child is not running.')
  return new Promise((done, reject) => {
    const clean = (): void => { clearTimeout(timer); child.off('exit', exited); child.off('error', failed) }
    const exited = (code: number | null, signal: NodeJS.Signals | null): void => { clean(); done({ code, signal }) }
    const failed = (error: Error): void => { clean(); reject(error) }
    const timer = setTimeout(() => { clean(); reject(new Error('The owned child did not exit after SIGKILL.')) }, 10000)
    child.once('exit', exited)
    child.once('error', failed)
    if (!child.kill('SIGKILL')) { clean(); reject(new Error('The owned child refused SIGKILL.')) }
  })
}

/**
 * Delete only one newly created run child directory; junctions are unlinked without following their targets.
 * @param root - Random run root created by this scenario under .local-run.
 * @param path - Exact direct child directory created and owned by this scenario.
 */
export async function removeCrashHome(root: string, path: string): Promise<void> {
  if (dirname(path) !== root || !basename(root).startsWith('enterprise-mysql-crash-')) throw new Error('Unexpected crash fixture home.')
  if (!existsSync(path)) return
  const remove = async (entry: string): Promise<void> => {
    const stat = await lstat(entry)
    if (stat.isSymbolicLink()) { await unlink(entry); return }
    if (stat.isDirectory()) {
      for (const child of await readdir(entry)) await remove(join(entry, child))
      await rmdir(entry)
    } else { await unlink(entry) }
  }
  await remove(path)
}
