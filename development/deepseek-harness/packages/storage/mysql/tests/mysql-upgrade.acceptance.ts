/** Explicit v1 preflight and a separately reviewed two-ALTER upgrade on the owned round144 instance. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createConnection } from 'mysql2/promise'
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { mysqlFailure } from '../src/error.ts'
import { loadMysqlMigrations, prepareMysqlSchema, verifyMysqlMigrationInventory } from '../src/schema.ts'
import type { MysqlMigrationConnection } from '../src/schema.ts'
import type { MysqlParameter, MysqlResult } from '../src/types.ts'

const repo = resolve(import.meta.dirname, '../../../..')
const ownedUuid = '81698848-cb10-11f1-900d-30560fa55c04'
const connections: Connection[] = []

async function descriptor(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, 'utf8')
  let value: unknown
  try { value = JSON.parse(source.replace(/^\uFEFF/, '')) }
  catch (_error) { throw new Error('Invalid isolated MySQL descriptor JSON; contents omitted.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid isolated MySQL descriptor; contents omitted.')
  return value as Record<string, unknown>
}
function field(object: Record<string, unknown>, key: string): string {
  const value = object[key]
  if (typeof value !== 'string' || !value.length) throw new Error('An isolated descriptor field is missing; contents omitted.')
  return value
}
function canonical(path: string): string {
  const native = realpathSync.native(path).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? native.toLowerCase() : native
}
async function isolated() {
  const path = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!path) throw new Error('DSH_MYSQL_TEST_INSTANCE must name the reviewed round144 public descriptor.')
  const ready = await descriptor(resolve(path))
  const privatePath = field(ready, 'privateConnectionFile')
  const instance = canonical(dirname(privatePath))
  const within = relative(canonical(resolve(repo, '../.local-run')), instance)
  if (isAbsolute(within) || within.startsWith('..' + sep) || !basename(instance).startsWith('enterprise-round144-mysql-instance-')) {
    throw new Error('The migration descriptor is outside the owned isolated instance.')
  }
  const target = await descriptor(privatePath)
  if (ready['host'] !== '127.0.0.1' || target['host'] !== ready['host'] || ready['port'] !== 11406
    || target['port'] !== ready['port'] || target['pid'] !== ready['pid'] || ready['version'] !== '8.4.11') {
    throw new Error('Only the reviewed round144 loopback process can be used for this migration acceptance.')
  }
  const database = field(target, 'database')
  if (database !== 'dsh_round144_834f9e84adbd40ca95b4a3e9efb8f0ce') throw new Error('The database is not the reviewed isolated target.')
  const dataDir = canonical(field(target, 'dataDir'))
  const dataWithin = relative(instance, dataDir)
  if (isAbsolute(dataWithin) || dataWithin.startsWith('..' + sep)) throw new Error('The datadir is outside the owned instance.')
  let db: Connection
  try {
    db = await createConnection({ host: '127.0.0.1', port: 11406, database, user: field(target, 'user'),
      password: field(target, 'password'), charset: 'utf8mb4', timezone: 'Z', dateStrings: true,
      jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  } catch (error) { throw mysqlFailure(error, 'not-started') }
  connections.push(db)
  const execute = async (sql: string, parameters: readonly MysqlParameter[]): Promise<MysqlResult> => {
    try {
      const [value] = await db.execute<RowDataPacket[] | ResultSetHeader>(sql, parameters.map(parameter =>
        typeof parameter === 'bigint' ? parameter.toString() : parameter instanceof Uint8Array ? Buffer.from(parameter) : parameter))
      return Array.isArray(value) ? { kind: 'rows', rows: value }
        : { kind: 'write', affectedRows: value.affectedRows, insertId: String(value.insertId), warningStatus: value.warningStatus }
    } catch (error) { throw mysqlFailure(error) }
  }
  const identity = await execute('SELECT @@GLOBAL.server_uuid AS serverUuid,@@GLOBAL.datadir AS dataDir,VERSION() AS version,DATABASE() AS databaseName', [])
  const server = identity.kind === 'rows' ? identity.rows[0] : undefined
  if (!server || server['serverUuid'] !== ownedUuid || server['version'] !== ready['version'] || server['databaseName'] !== database
    || typeof server['dataDir'] !== 'string' || canonical(server['dataDir']) !== dataDir) {
    throw new Error('The connected server is not the reviewed isolated migration target.')
  }
  await execute('SET SESSION time_zone = ?', ['+00:00'])
  await execute('SET SESSION sql_mode = ?', ['STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'])
  await db.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin')
  const scripts: string[] = []
  const connection: MysqlMigrationConnection = { execute, scriptStatement: async (sql) => {
    scripts.push(sql)
    try { await db.query(sql) } catch (error) { throw mysqlFailure(error) }
  } }
  return { db, connection, scripts, database }
}

async function receipts(connection: MysqlMigrationConnection) {
  const result = await connection.execute('SELECT schema_version,migration_name,LOWER(HEX(script_sha256)) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version', [])
  if (result.kind !== 'rows') throw new Error('Missing migration receipt rows.')
  return result.rows
}
async function eventHash(connection: MysqlMigrationConnection) {
  const result = await connection.execute('SELECT store_id,slot_id,HEX(lifecycle_id) AS lifecycle,format_version,seq,event_json FROM dsh_session_events ORDER BY store_id,slot_id,lifecycle_id,format_version,seq', [])
  if (result.kind !== 'rows') throw new Error('Missing event prefix rows.')
  return { count: result.rows.length, sha256: createHash('sha256').update(JSON.stringify(result.rows)).digest('hex') }
}

afterEach(async () => { for (const db of connections.splice(0).reverse()) await db.end() })

it('recognizes the exact isolated v1 without writing or applying an implicit upgrade', async () => {
  const target = await isolated()
  const before = await receipts(target.connection)
  expect(before).toHaveLength(1)
  await expect(prepareMysqlSchema(target.connection, 'verify', target.database, 0)).rejects.toMatchObject({ code: 'schema_conflict' })
  expect(target.scripts).toEqual([])
  expect(await receipts(target.connection)).toEqual(before)
})

it('applies the reviewed v2 upgrade and preserves receipts, original events and strict JSON predicates', async () => {
  const migrations = await loadMysqlMigrations()
  const latest = migrations[1]
  if (!latest || process.env['DSH_MYSQL_UPGRADE_REVIEWED_SHA256'] !== latest.scriptSha256) {
    throw new Error('Review the exact v2 asset and set its public SHA-256 before this explicit upgrade acceptance.')
  }
  const target = await isolated()
  const before = await receipts(target.connection)
  expect(before).toHaveLength(1)
  const prefix = await eventHash(target.connection)
  const status = await prepareMysqlSchema(target.connection, 'upgrade', target.database, 0)
  expect(status).toMatchObject({ version: 2, migrationName: latest.migrationName, scriptSha256: latest.scriptSha256 })
  expect(target.scripts).toEqual(latest.statements)
  const after = await receipts(target.connection)
  expect(after).toHaveLength(2)
  expect(after[0]).toEqual(before[0])
  expect(await prepareMysqlSchema(target.connection, 'verify', target.database, 0)).toEqual(status)
  expect(target.scripts).toHaveLength(2)
  expect(await eventHash(target.connection)).toEqual(prefix)

  const checked = await checkIntegerPredicates(target)
  expect(await eventHash(target.connection)).toEqual(prefix)
  await writeFile(resolve(repo, '../.local-run/enterprise-round147-mysql-schema-v2-acceptance.json'), JSON.stringify({
    host: '127.0.0.1', port: 11406, serverUuid: ownedUuid, status, v1ReceiptUnchanged: true,
    originalEventCount: prefix.count, originalEventsSha256: prefix.sha256, checksRejected: checked,
    checks: ['exact-v1-preflight', 'two-reviewed-alters', 'new-v2-receipt', 'v1-receipt-preserved', 'verify-no-ddl',
      'original-event-bytes-preserved', 'real-millisecond-timestamp', 'fraction-string-refusal', 'derived-column-mismatch'],
  }, null, 2) + '\n', { mode: 0o600 })
})

async function checkIntegerPredicates(target: Awaited<ReturnType<typeof isolated>>): Promise<number> {
  const storeKey = 'schema-v2-acceptance-' + randomUUID().replaceAll('-', '')
  const now = Date.now()
  const header = { id: 'timestamp-preserved', version: 4, createdAt: now, isSeeded: false }
  const life = randomBytes(16)
  let checked = 0
  await target.db.beginTransaction()
  try {
    await target.connection.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)', [storeKey, 'Schema v2 predicate acceptance', '{}'])
    const stores = await target.connection.execute('SELECT store_id FROM dsh_stores WHERE store_key=?', [storeKey])
    const store: unknown = stores.kind === 'rows' ? stores.rows[0]?.['store_id'] : undefined
    if (typeof store !== 'string') throw new Error('The predicate store id is not exact text.')
    await target.connection.execute('INSERT INTO dsh_session_slots (store_id,external_session_id) VALUES (?,?)', [store, header.id])
    const slots = await target.connection.execute('SELECT slot_id FROM dsh_session_slots WHERE store_id=?', [store])
    const slot: unknown = slots.kind === 'rows' ? slots.rows[0]?.['slot_id'] : undefined
    if (typeof slot !== 'string') throw new Error('The predicate slot id is not exact text.')
    const insertHeader = (value: unknown, createdAt: number, lifecycle: Buffer) => target.connection.execute(
      'INSERT INTO dsh_session_logs (store_id,slot_id,lifecycle_id,format_version,log_state,header_json,session_created_at_ms,is_seeded) VALUES (?,?,?,?,?,?,?,?)',
      [store, slot, lifecycle, 4, 'active', JSON.stringify(value), createdAt, 0])
    await insertHeader(header, now, life)
    for (const bad of [{ ...header, version: 4.5 }, { ...header, version: '4' },
      { ...header, createdAt: now + 0.5 }, { ...header, createdAt: String(now) }, { ...header, createdAt: now + 1 }]) {
      await expect(insertHeader(bad, now, randomBytes(16))).rejects.toMatchObject({ driverCode: 'ER_CHECK_CONSTRAINT_VIOLATED' })
      checked++
    }
    const insertEvent = (seq: number, value: unknown) => target.connection.execute(
      'INSERT INTO dsh_session_events (store_id,slot_id,lifecycle_id,format_version,seq,event_type,event_time_ms,event_json) VALUES (?,?,?,?,?,?,?,?)',
      [store, slot, life, 4, seq, 'turn/start', now, JSON.stringify(value)])
    const event = { seq: 0, type: 'turn/start', time: now, data: { turn: 1 } }
    await insertEvent(0, event)
    const stored = await target.connection.execute('SELECT event_json FROM dsh_session_events WHERE store_id=?', [store])
    expect(stored.kind === 'rows' ? stored.rows[0]?.['event_json'] : undefined).toBe(JSON.stringify(event))
    for (const bad of [{ ...event, seq: 1.5 }, { ...event, seq: '1' }, { ...event, seq: 1, time: now + 0.5 },
      { ...event, seq: 1, time: String(now) }, { ...event, seq: 2 }, { ...event, seq: 1, time: now + 1 }]) {
      await expect(insertEvent(1, bad)).rejects.toMatchObject({ driverCode: 'ER_CHECK_CONSTRAINT_VIOLATED' })
      checked++
    }
  } finally { await target.db.rollback() }
  return checked
}

it('records only the reviewed missing v2 receipt after complete inspection without repeating ALTER', async () => {
  const migrations = await loadMysqlMigrations()
  const initial = migrations[0]
  const latest = migrations[1]
  if (!initial || !latest || process.env['DSH_MYSQL_RECEIPT_RECOVERY_REVIEWED_SHA256'] !== latest.scriptSha256) {
    throw new Error('This one-time isolated receipt recovery requires separate review of its exact v2 checksum.')
  }
  const target = await isolated()
  const before = await receipts(target.connection)
  expect(before).toHaveLength(1)
  expect(before[0]).toMatchObject({ schema_version: 1, migration_name: initial.migrationName, checksum: initial.scriptSha256 })
  const prefix = await eventHash(target.connection)
  const lockName = 'dsh-schema:' + createHash('sha256').update(target.database).digest('hex').slice(0, 48)
  const lock = await target.connection.execute('SELECT GET_LOCK(?,0) AS acquired', [lockName])
  expect(lock.kind === 'rows' ? Number(lock.rows[0]?.['acquired']) : 0).toBe(1)
  try {
    expect(await receipts(target.connection)).toEqual(before)
    const deployment = await target.connection.execute('SELECT @@GLOBAL.ngram_token_size AS tokenSize,@@GLOBAL.innodb_ft_enable_stopword AS stopwords', [])
    expect(deployment.kind === 'rows' ? Number(deployment.rows[0]?.['tokenSize']) : 0).toBe(2)
    expect(deployment.kind === 'rows' ? Number(deployment.rows[0]?.['stopwords']) : 1).toBe(0)
    await verifyMysqlMigrationInventory(target.connection, latest)
    await target.connection.execute('INSERT INTO dsh_schema_migrations (schema_version,migration_name,script_sha256) VALUES (?,?,?)',
      [latest.version, latest.migrationName, Buffer.from(latest.scriptSha256, 'hex')])
  } finally { await target.connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName]) }
  const status = await prepareMysqlSchema(target.connection, 'verify', target.database, 0)
  expect(status).toMatchObject({ version: 2, scriptSha256: latest.scriptSha256 })
  const after = await receipts(target.connection)
  expect(after).toHaveLength(2)
  expect(after[0]).toEqual(before[0])
  expect(target.scripts).toEqual([])
  const checked = await checkIntegerPredicates(target)
  expect(await eventHash(target.connection)).toEqual(prefix)
  await writeFile(resolve(repo, '../.local-run/enterprise-round147-mysql-schema-v2-recovery.json'), JSON.stringify({
    host: '127.0.0.1', port: 11406, serverUuid: ownedUuid, status, v1ReceiptUnchanged: true,
    baseline: 'post-DDL inspection before receipt recovery', baselineEventCount: prefix.count,
    baselineEventsSha256: prefix.sha256, checksRejected: checked,
    checks: ['full-v2-structure', 'separately-reviewed-receipt-only-recovery', 'no-repeated-alter', 'v1-receipt-preserved',
      'latest-verify', 'baseline-event-bytes-preserved', 'real-millisecond-timestamp', 'fraction-string-refusal', 'derived-column-mismatch'],
  }, null, 2) + '\n', { mode: 0o600 })
})
