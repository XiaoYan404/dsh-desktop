/** SQL observation for the reviewed round144 instance; profile acceptance never initializes or migrates it. */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createConnection } from 'mysql2/promise'
import type { Connection, RowDataPacket } from 'mysql2/promise'

export const profileServerUuid = '81698848-cb10-11f1-900d-30560fa55c04'
const database = 'dsh_round144_834f9e84adbd40ca95b4a3e9efb8f0ce'

async function descriptor(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(source.replace(/^\uFEFF/, '')) }
  catch (_error) { throw new Error('Invalid owned profile descriptor; contents omitted.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an owned descriptor object.')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('A required owned descriptor field is absent.')
  return value
}
function canonical(path: string): string {
  const absolute = realpathSync.native(path).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
function contained(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}

async function reviewedTarget(repo: string) {
  const path = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!path) throw new Error('DSH_MYSQL_TEST_INSTANCE is required; no database was contacted.')
  const ready = await descriptor(resolve(path))
  const privatePath = string(ready['privateConnectionFile'])
  const directory = canonical(dirname(privatePath))
  if (!contained(canonical(resolve(repo, '../.local-run')), directory)
    || !basename(directory).startsWith('enterprise-round144-mysql-instance-')) throw new Error('Not an owned round144 directory.')
  const target = await descriptor(privatePath)
  const dataDir = canonical(string(target['dataDir']))
  const valid = ready['host'] === '127.0.0.1' && target['host'] === ready['host']
    && ready['port'] === 11406 && target['port'] === ready['port'] && target['pid'] === ready['pid']
    && ready['version'] === '8.4.11' && target['database'] === database && contained(directory, dataDir)
  if (!valid) throw new Error('Profile acceptance refuses an unreviewed database target.')
  const user = string(target['user']), password = string(target['password'])
  return { user, password, dataDir }
}

/** A missing credential must fail before any MySQL transport is created. No connection or schema operation occurs here. */
export async function profileEnvironmentWithoutCredential(repo: string): Promise<Record<string, string>> {
  const { user } = await reviewedTarget(repo)
  return { DSH_MYSQL_HOST: '127.0.0.1', DSH_MYSQL_PORT: '11406', DSH_MYSQL_DATABASE: database,
    DSH_MYSQL_USER: user, DSH_MYSQL_STORE_KEY: 'missing-credential-no-sql' }
}

/** One exact namespace created by this case; private credentials never leave its environment materializer. */
export async function ownedProfileInstance(repo: string) {
  const { user, password, dataDir } = await reviewedTarget(repo)
  const connection = await createConnection({ host: '127.0.0.1', port: 11406, database, user, password,
    charset: 'utf8mb4', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false })
  try {
    const [identity] = await connection.execute<RowDataPacket[]>(
      'SELECT @@GLOBAL.server_uuid AS uuid,@@GLOBAL.datadir AS dataDir,VERSION() AS version,DATABASE() AS db')
    const actual = identity[0]
    if (!actual || actual['uuid'] !== profileServerUuid || actual['version'] !== '8.4.11' || actual['db'] !== database
      || canonical(string(actual['dataDir'])) !== dataDir) throw new Error('Unexpected profile acceptance server identity.')
    const receipts = await profileReceipts(connection)
    if (receipts.length !== 2) throw new Error('The existing reviewed schema must have exactly its two receipts.')
    const storeKey = 'profiles-' + randomUUID().replaceAll('-', '')
    await connection.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)',
      [storeKey, 'Owned built profile acceptance', JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 })])
    const [stores] = await connection.execute<RowDataPacket[]>('SELECT store_id FROM dsh_stores WHERE store_key=?', [storeKey])
    const storeId = string(stores[0]?.['store_id'])
    return { connection, storeKey, receipts,
      environment: (): Record<string, string> => ({ DSH_MYSQL_HOST: '127.0.0.1', DSH_MYSQL_PORT: '11406',
        DSH_MYSQL_DATABASE: database, DSH_MYSQL_USER: user, DSH_MYSQL_PASSWORD: password, DSH_MYSQL_STORE_KEY: storeKey }),
      read: async () => {
        const [logs] = await connection.execute<RowDataPacket[]>(
          'SELECT s.external_session_id AS id,s.slot_id,HEX(s.current_lifecycle_id) AS lifecycle,s.current_format_version AS version,l.header_json,l.event_count,l.log_revision,w.fence_token,w.owner_token,w.lifecycle_id AS lease_lifecycle,w.expires_at FROM dsh_session_slots s JOIN dsh_session_logs l ON l.store_id=s.store_id AND l.slot_id=s.slot_id AND l.lifecycle_id=s.current_lifecycle_id AND l.format_version=s.current_format_version JOIN dsh_writer_leases w ON w.store_id=s.store_id AND w.slot_id=s.slot_id WHERE s.store_id=?', [storeId])
        if (logs.length !== 1 || !logs[0]) throw new Error('Expected exactly one owned Session log.')
        const row = logs[0]
        const [events] = await connection.execute<RowDataPacket[]>(
          'SELECT event_json FROM dsh_session_events WHERE store_id=? AND slot_id=? AND lifecycle_id=UNHEX(?) AND format_version=? ORDER BY seq',
          [storeId, string(row['slot_id']), string(row['lifecycle']), row['version']])
        return { row, header: JSON.parse(string(row['header_json'])) as Record<string, unknown>,
          events: events.map((event) => { const value: unknown = JSON.parse(string(event['event_json'])); return value }) }
      },
    }
  } catch (error) { await connection.end(); throw error }
}

export async function profileReceipts(connection: Connection): Promise<RowDataPacket[]> {
  const [receipts] = await connection.execute<RowDataPacket[]>(
    'SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version')
  return receipts
}
