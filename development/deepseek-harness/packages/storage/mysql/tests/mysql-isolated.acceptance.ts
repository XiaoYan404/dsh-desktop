/** Explicit isolated-instance acceptance never discovers credentials or connects to installed MySQL services. */
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createConnection } from 'mysql2/promise'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import MysqlRuntime, { MysqlError } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { MysqlExecutor, MysqlResult } from '../src/types.ts'
import { loadMysqlMigration, loadMysqlMigrations } from '../src/schema.ts'

const repo = resolve(import.meta.dirname, '../../../..')
const roots: string[] = []
const contexts: Context[] = []
const observers: Connection[] = []

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The isolated MySQL descriptor is invalid')
  return value as Record<string, unknown>
}
function string(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error('A required isolated MySQL descriptor field is absent')
  return field
}
async function json(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, 'utf8')
  try { return object(JSON.parse(source.replace(/^\uFEFF/, ''))) }
  catch (_error) { throw new Error('The isolated MySQL descriptor is not valid JSON; its contents are omitted') }
}
function first(result: MysqlResult) {
  if (result.kind !== 'rows' || !result.rows[0]) throw new Error('The MySQL acceptance query returned no row')
  return result.rows[0]
}
function sameDirectory(left: string, right: string): boolean {
  const canonical = (path: string): string => {
    const native = realpathSync.native(path).replace(/[\\/]+$/u, '')
    return process.platform === 'win32' ? native.toLowerCase() : native
  }
  return canonical(left) === canonical(right)
}

async function isolated() {
  const descriptor = process.env['DSH_MYSQL_TEST_INSTANCE']
  if (!descriptor) throw new Error('Set DSH_MYSQL_TEST_INSTANCE to the explicitly provisioned round144 public descriptor; no database was contacted')
  const ready = await json(resolve(descriptor))
  const path = string(ready, 'privateConnectionFile')
  const allowed = await realpath(resolve(repo, '../.local-run'))
  const privatePath = await realpath(path)
  const within = relative(allowed, privatePath)
  if (isAbsolute(within) || within.startsWith('..' + sep) || !within.split(sep)[0]?.startsWith('enterprise-round144-mysql-instance-')) {
    throw new Error('Only the explicitly provisioned round144 MySQL instance directory is accepted')
  }
  const connection = await json(privatePath)
  if (ready['host'] !== '127.0.0.1' || connection['host'] !== ready['host'] ||
    typeof ready['port'] !== 'number' || connection['port'] !== ready['port'] ||
    typeof ready['pid'] !== 'number' || connection['pid'] !== ready['pid'] || !string(ready, 'version').startsWith('8.4.')) {
    throw new Error('The isolated MySQL process, loopback endpoint or version does not match its public descriptor')
  }
  const database = string(connection, 'database')
  if (!/^dsh_[A-Za-z0-9_]+$/.test(database)) throw new Error('The isolated MySQL database name is not a test database')
  const dataDir = await realpath(string(connection, 'dataDir'))
  const instanceDir = dirname(privatePath)
  const dataWithin = relative(instanceDir, dataDir)
  if (isAbsolute(dataWithin) || dataWithin.startsWith('..' + sep)) throw new Error('MySQL data is outside the declared isolated instance')
  const user = string(connection, 'user')
  const password = string(connection, 'password')
  const observer = await createConnection({ host: '127.0.0.1', port: ready['port'], database, user, password,
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z', multipleStatements: false })
  observers.push(observer)
  const [identity] = await observer.execute<RowDataPacket[]>(
    'SELECT @@GLOBAL.server_uuid AS serverUuid, @@GLOBAL.datadir AS dataDir, VERSION() AS version, DATABASE() AS databaseName')
  const server = identity[0]
  const serverUuid: unknown = server?.['serverUuid']
  const serverVersion = string(ready, 'version')
  if (!server || typeof server['dataDir'] !== 'string' || !sameDirectory(server['dataDir'], dataDir) ||
    server['version'] !== serverVersion || server['databaseName'] !== database || typeof serverUuid !== 'string') {
    throw new Error('The connected server is not the explicitly provisioned isolated MySQL process')
  }
  return { observer, host: '127.0.0.1', port: ready['port'], database, user, password, serverUuid,
    version: serverVersion, dataDir }
}

async function boot(target: Awaited<ReturnType<typeof isolated>>, schemaMode: 'verify' | 'initialize',
  overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mysql-acceptance-'))
  roots.push(root)
  const ref = 'DSH_MYSQL_TEST_' + randomUUID().replaceAll('-', '').toUpperCase()
  const seed = new Context()
  try {
    await seed.plugin(CredentialsLocal, { dshHome: root, watch: false })
    await seed.credentials.set(credentialRef(ref), target.password)
  } finally { await seed.fiber.dispose() }
  const config = { host: target.host, port: target.port, database: target.database, user: target.user,
    passwordRef: ref, schemaMode, connectionLimit: 1, operationTimeoutMs: 20000, ...overrides }
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: root, watch: false } },
    { name: '@deepseek-ai/dsh-mysql', config },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal], ['@deepseek-ai/dsh-mysql', MysqlRuntime],
  ])
  const internal = ctx.loader.internal
  if (!internal) throw new Error('The real Node Loader is required')
  ctx.loader.internal = new Proxy(internal, { get(owner, key) {
    if (key === 'import') return async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error('Unexpected isolated MySQL fixture module')
      return modules.get(specifier)
    }
    const value: unknown = Reflect.get(owner, key, owner)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(owner) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const mysqlEntry = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-mysql')
  if (mysqlEntry?.fiber) {
    try { await mysqlEntry.fiber.await() }
    catch (error) {
      if (error instanceof MysqlError) {
        await writeFile(resolve(repo, '../.local-run/enterprise-round144-mysql-last-failure.json'),
          JSON.stringify({ code: error.code, driverCode: error.driverCode, message: error.message }) + '\n', { mode: 0o600 })
      }
      throw error
    }
  }
  if (!ctx.get('mysql')) throw new Error('The MySQL connection service did not activate')
  return ctx
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const observer of observers.splice(0)) await observer.end()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-mysql-acceptance-')) {
      throw new Error('Unexpected isolated MySQL acceptance directory')
    }
    await rm(root, { recursive: true, force: true })
  }
})

it('initializes all twenty R7 tables through the real Loader and validates transport, constraints, transactions, cancellation and restart', async () => {
  const target = await isolated()
  const [before] = await target.observer.execute<RowDataPacket[]>(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=?', ['BASE TABLE'])
  if (before.length !== 0) throw new Error('This acceptance run requires the newly provisioned empty test database; existing tables were retained')
  await expect(boot(target, 'verify')).rejects.toMatchObject({ code: 'schema_missing' })
  await target.observer.query('CREATE TABLE dsh_acceptance_sentinel (id INT PRIMARY KEY) ENGINE=InnoDB')
  await target.observer.execute('INSERT INTO dsh_acceptance_sentinel (id) VALUES (?)', [7])
  await expect(boot(target, 'initialize')).rejects.toMatchObject({ code: 'schema_conflict' })
  const [sentinel] = await target.observer.execute<RowDataPacket[]>('SELECT id FROM dsh_acceptance_sentinel')
  expect(sentinel[0]?.['id']).toBe(7)
  // This table was created immediately above in the confirmed, otherwise empty database.
  await target.observer.query('DROP TABLE dsh_acceptance_sentinel')

  const ctx = await boot(target, 'initialize')
  const mysql = ctx.mysql
  const migration = await loadMysqlMigration()
  const latest = (await loadMysqlMigrations()).at(-1)
  if (!latest) throw new Error('The latest MySQL migration is absent')
  expect(mysql.status()).toEqual({ version: 2, migrationName: latest.migrationName, scriptSha256: latest.scriptSha256,
    tableCount: 20, foreignKeyCount: 25 })
  const session = first(await mysql.execute('SELECT @@session.time_zone AS zone, @@session.sql_mode AS mode, @@collation_connection AS collationName', []))
  expect(session['zone']).toBe('+00:00')
  expect(String(session['mode'])).toContain('STRICT_ALL_TABLES')
  expect(session['collationName']).toBe('utf8mb4_0900_bin')
  const privateText = "value'; DROP TABLE dsh_stores; -- 中文😀\u0000"
  const exact = first(await mysql.execute(
    'SELECT CAST(CAST(? AS CHAR) AS UNSIGNED) AS largeId, CAST(? AS DECIMAL(30,2)) AS exactDecimal, CAST(? AS DATETIME(6)) AS utcDate, ? AS boundText',
    [18446744073709551615n, '9007199254740993.25', '2026-10-19 03:04:05.123456', privateText]))
  expect(exact).toMatchObject({ largeId: '18446744073709551615', exactDecimal: '9007199254740993.25',
    utcDate: '2026-10-19 03:04:05.123456', boundText: privateText })
  const inserted = await mysql.execute('INSERT INTO dsh_stores (store_key, display_name, search_config_json) VALUES (?, ?, ?)',
    ['isolated-case', '公司 😀', JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 })])
  if (inserted.kind !== 'write') throw new Error('The MySQL insert did not return write metadata')
  expect(typeof inserted.insertId).toBe('string')
  const storeId = inserted.insertId
  await mysql.execute('UPDATE dsh_stores SET registry_revision=? WHERE store_id=?', [18446744073709551615n, storeId])
  expect(first(await mysql.execute('SELECT registry_revision FROM dsh_stores WHERE store_id=?', [storeId]))['registry_revision'])
    .toBe('18446744073709551615')
  await mysql.execute('UPDATE dsh_stores SET registry_revision=? WHERE store_id=?', [0n, storeId])
  await expect(mysql.execute('INSERT INTO dsh_stores (store_key, display_name, search_config_json) VALUES (?, ?, ?)',
    ['check-rejection', 'invalid', '[]'])).rejects.toMatchObject({ code: 'constraint_failed' })
  await expect(mysql.execute('INSERT INTO dsh_workspace_order (store_id, workspace_pk, position_no) VALUES (?, ?, ?)',
    [storeId, '18446744073709551614', 0])).rejects.toMatchObject({ code: 'constraint_failed' })
  await expect(mysql.execute('INSERT INTO dsh_stores (store_key, display_name, search_config_json) VALUES (?, ?, ?)',
    ['isolated-case', 'private duplicate data', '{}'])).rejects.toMatchObject({ code: 'constraint_failed' })
  await expect(mysql.transaction(async (tx) => {
    await tx.execute('UPDATE dsh_stores SET display_name=? WHERE store_id=?', ['must roll back', storeId])
    throw new Error('A deliberate callback failure')
  })).rejects.toBeDefined()
  expect(first(await mysql.execute('SELECT display_name FROM dsh_stores WHERE store_id=?', [storeId]))['display_name']).toBe('公司 😀')
  let expired: MysqlExecutor | undefined
  expect(await mysql.transaction(async (tx) => {
    expired = tx
    await tx.execute('UPDATE dsh_stores SET display_name=? WHERE store_id=?', ['committed', storeId])
    return 42
  })).toBe(42)
  if (!expired) throw new Error('The transaction executor was not captured')
  await expect(expired.execute('SELECT 1', [])).rejects.toMatchObject({ code: 'closed' })
  const controller = new AbortController()
  const checking = mysql.execute('SELECT SLEEP(10) AS sleeping', [], controller.signal)
  const cancelled = expect(checking).rejects.toMatchObject({ code: 'cancelled' })
  await expect.poll(async () => {
    const [active] = await target.observer.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS active FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND ID<>CONNECTION_ID()', ['SELECT SLEEP(10)%'])
    return Number(active[0]?.['active'])
  }, { timeout: 5000, interval: 10 }).toBe(1)
  await expect(mysql.execute('SELECT 1', [])).rejects.toMatchObject({ code: 'capacity' })
  controller.abort()
  await cancelled
  expect(first(await mysql.execute('SELECT display_name FROM dsh_stores WHERE store_id=?', [storeId]))['display_name']).toBe('committed')
  await ctx.fiber.dispose()
  expect(ctx.get('mysql')).toBeUndefined()
  await expect(mysql.execute('SELECT 1', [])).rejects.toMatchObject({ code: 'closed' })
  const reopened = await boot(target, 'verify')
  expect(reopened.mysql.status().scriptSha256).toBe(latest.scriptSha256)
  expect(first(await reopened.mysql.execute('SELECT display_name FROM dsh_stores WHERE store_id=?', [storeId]))['display_name']).toBe('committed')
  await reopened.fiber.dispose()
  await target.observer.execute('UPDATE dsh_schema_migrations SET script_sha256=? WHERE schema_version=?', [Buffer.alloc(32), 1])
  try { await expect(boot(target, 'verify')).rejects.toMatchObject({ code: 'schema_conflict' }) }
  finally { await target.observer.execute('UPDATE dsh_schema_migrations SET script_sha256=? WHERE schema_version=?', [Buffer.from(migration.scriptSha256, 'hex'), 1]) }
  await target.observer.query('ALTER TABLE dsh_stores MODIFY display_name VARCHAR(254) NOT NULL')
  try { await expect(boot(target, 'verify')).rejects.toMatchObject({ code: 'schema_incomplete' }) }
  finally { await target.observer.query("ALTER TABLE dsh_stores MODIFY display_name VARCHAR(255) NOT NULL COMMENT '显示名称'") }
  const verified = await boot(target, 'verify')
  const [receipts] = await target.observer.execute<RowDataPacket[]>(
    'SELECT schema_version, migration_name, LOWER(HEX(script_sha256)) AS scriptSha256 FROM dsh_schema_migrations ORDER BY schema_version')
  expect(receipts).toHaveLength(2)
  expect(receipts[0]).toMatchObject({ schema_version: 1, scriptSha256: migration.scriptSha256 })
  expect(receipts[1]).toMatchObject({ schema_version: 2, scriptSha256: latest.scriptSha256 })
  const [totals] = await target.observer.execute<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=?', ['BASE TABLE'])
  expect(Number(totals[0]?.['total'])).toBe(20)
  const evidence = { database: target.database, host: target.host, port: target.port, version: target.version,
    serverUuid: target.serverUuid, schema: verified.mysql.status(), caseIdSha256: createHash('sha256').update(storeId).digest('hex'),
    checks: ['twenty-tables', 'twenty-five-foreign-keys', 'checksum-receipt', 'strict-utc', 'bound-parameters', 'exact-bigint-decimal',
      'unicode', 'rollback', 'commit', 'expired-executor', 'cancellation', 'pool-capacity', 'unload', 'restart', 'checksum-conflict', 'column-drift'],
  }
  await writeFile(resolve(repo, '../.local-run/enterprise-round144-mysql-acceptance.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
})
