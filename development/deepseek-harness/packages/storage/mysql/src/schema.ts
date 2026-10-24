/** Immutable ordered migrations verify current schemas or explicitly upgrade a recognized predecessor. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { MysqlError } from './error.ts'
import type { MysqlParameter, MysqlResult, MysqlRow, MysqlSchemaStatus } from './types.ts'
import { canonicalMysqlCheck, mysqlChecks } from './schema-checks.ts'
import { loadWorkspaceMigration, workspaceBackfill } from './schema-workspace.ts'
import type { MysqlWorkspaceAdoption } from './schema-workspace.ts'

/** Database structure generation, independent of the released Session event format. */
export const MYSQL_SCHEMA_VERSION = 3
/** Stable receipt name for the latest append-only schema migration. */
export const MYSQL_MIGRATION_NAME = 'workspace-order-and-lease'
const INITIAL_NAME = 'r7-initial-20-tables'
const INITIAL_SHA256 = '4f897d35c8472182eaaab3117d313f382e078d7f4f8288a35bb9b24f708e9be9'

interface Column {
  name: string
  type: string
  nullable: boolean
  charset: string | null
  collation: string | null
  generated: string | undefined
  defaultValue: string | null
  extra: string
}
interface ForeignKey { name: string; columns: string[]; target: string; targetColumns: string[] }
interface Index { name: string; columns: string[]; unique: boolean; fulltext: boolean }
interface Table {
  name: string
  columns: Column[]
  foreignKeys: ForeignKey[]
  checks: Array<{ name: string; expression: string }>
  indexes: Index[]
}

/** The bundled executable bytes determine the migration receipt; database provisioning is deliberately separate. */
export interface MysqlMigration {
  readonly version: number
  readonly migrationName: string
  readonly scriptSha256: string
  readonly statements: readonly string[]
  readonly tables: readonly Table[]
}

/** Private migration operations retain prepared parameters and allow only bundled DDL as literal statements. */
export interface MysqlMigrationConnection {
  /** @param sql - Metadata or receipt SQL. @param parameters - Bound data. @returns Server result. */
  execute(sql: string, parameters: readonly MysqlParameter[]): Promise<MysqlResult>
  /** @param sql - One statement taken from the checked, bundled migration. @returns After the server acknowledges it. */
  scriptStatement(sql: string): Promise<void>
}

function columns(value: string): string[] { return value.split(',').map(column => column.trim()) }
function group(match: RegExpMatchArray, index: number): string {
  const value = match[index]
  if (value === undefined) throw new MysqlError('configuration', 'The bundled MySQL R7 SQL could not be read. Restore the complete migration asset.')
  return value
}
function foreignKeys(source: string): ForeignKey[] {
  return [...source.matchAll(/CONSTRAINT\s+(\w+)\s+FOREIGN KEY\s*\(([^)]+)\)\s+REFERENCES\s+(\w+)\s*\(([^)]+)\)/g)]
    .map(match => ({ name: group(match, 1), columns: columns(group(match, 2)),
      target: group(match, 3), targetColumns: columns(group(match, 4)) }))
}

/** Load and check R7's executable asset without connecting to any database.
 * @returns Byte checksum and the complete twenty-table migration in execution order.
 * @throws MysqlError if the packaged asset is missing or no longer contains the required R7 inventory.
 */
export async function loadMysqlMigration(): Promise<MysqlMigration> {
  let bytes: Buffer
  try { bytes = await readFile(new URL('../assets/001-r7.sql', import.meta.url)) }
  catch (_error) { throw new MysqlError('configuration', 'The packaged MySQL R7 migration asset is missing or unreadable. Restore the complete package.') }
  const source = bytes.toString('utf8')
  const statements = source.split(/;\s*(?=(?:SET|CREATE TABLE|ALTER TABLE)\b|$)/u).map(value => value.trim()).filter(Boolean)
  const tables: Table[] = [...source.matchAll(/CREATE TABLE (dsh_[a-z_]+) \(\n([\s\S]*?)\n\) ENGINE=InnoDB[^;]*;/g)].map((match) => {
    const body = group(match, 2)
    const columnPattern = '^  ([a-z][a-z0-9_]*)\\s+((?:BIGINT|INT|BOOLEAN|VARCHAR|LONGTEXT|JSON|BINARY|DATETIME)'
      + '(?:\\(\\d+\\))?(?: UNSIGNED)?)([\\s\\S]*?)(?=^  (?:[a-z][a-z0-9_]*\\s|PRIMARY|UNIQUE|KEY|FULLTEXT|CONSTRAINT)|$(?![\\s\\S]))'
    const columnRows = [...body.matchAll(new RegExp(columnPattern, 'gm'))]
    const indexes: Index[] = [...body.matchAll(/(PRIMARY KEY|UNIQUE KEY (\w+)|FULLTEXT KEY (\w+)|KEY (\w+))\s*\(([^)]+)\)/g)]
      .map(index => ({ name: index[2] ?? index[3] ?? index[4] ?? 'PRIMARY', columns: columns(group(index, 5)),
        unique: group(index, 1).startsWith('PRIMARY') || group(index, 1).startsWith('UNIQUE'), fulltext: index[3] !== undefined }))
    return { name: group(match, 1), columns: columnRows.map((column) => {
      const options = group(column, 3)
      const textual = /^(?:VARCHAR|LONGTEXT)/.test(group(column, 2))
      const characterSet = textual ? /CHARACTER SET (\w+)/.exec(options)?.[1] ?? 'utf8mb4' : null
      return { name: group(column, 1), type: column[2] === 'BOOLEAN' ? 'tinyint(1)' : group(column, 2).toLowerCase(),
        nullable: !/\bNOT NULL\b/.test(options), charset: characterSet,
        collation: textual ? /COLLATE (\w+)/.exec(options)?.[1] ?? 'utf8mb4_0900_bin' : null,
        generated: /GENERATED ALWAYS AS \((.*)\) STORED/.exec(options)?.[1],
        defaultValue: /\bDEFAULT (CURRENT_TIMESTAMP\(6\)|FALSE|-?\d+|'[^']*')/.exec(options)?.[1]
          ?.replace(/^'|'$/g, '').replace(/^FALSE$/u, '0').toLowerCase() ?? null,
        extra: /AUTO_INCREMENT/u.test(options) ? 'auto_increment' : /GENERATED ALWAYS/u.test(options) ? 'stored generated'
          : /ON UPDATE CURRENT_TIMESTAMP/u.test(options) ? 'default_generated on update current_timestamp(6)'
            : /DEFAULT CURRENT_TIMESTAMP/u.test(options) ? 'default_generated' : '',
      }
    }), foreignKeys: foreignKeys(body), checks: mysqlChecks(body), indexes }
  })
  const slots = tables.find(table => table.name === 'dsh_session_slots')
  const alter = /ALTER TABLE dsh_session_slots\s+([\s\S]*?);/.exec(source)?.[1]
  if (slots && alter) slots.foreignKeys.push(...foreignKeys(alter))
  for (const table of tables) {
    for (const key of table.foreignKeys) {
      if (!table.indexes.some(index => !index.fulltext && key.columns.every((column, offset) => index.columns[offset] === column))) {
        table.indexes.push({ name: key.name, columns: [...key.columns], unique: false, fulltext: false })
      }
    }
  }
  const count = tables.reduce((total, table) => total + table.foreignKeys.length, 0)
  if (tables.length !== 20 || new Set(tables.map(table => table.name)).size !== 20 || count !== 25 || statements.length !== 23 ||
    statements[0] !== 'SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin' || statements[1] !== "SET time_zone = '+00:00'" ||
    tables.some(table => table.columns.length === 0 || table.indexes.length === 0)) {
    throw new MysqlError('configuration', 'The MySQL migration must contain R7\'s complete twenty tables, twenty-five foreign keys and ordered initialization statements.')
  }
  const scriptSha256 = createHash('sha256').update(bytes).digest('hex')
  if (scriptSha256 !== INITIAL_SHA256) throw new MysqlError('configuration', 'The immutable MySQL schema v1 asset differs. Restore its original bytes; append a new migration instead of rewriting an applied generation.')
  return { version: 1, migrationName: INITIAL_NAME, scriptSha256, statements, tables }
}

/** Load the immutable initial schema and its checked successor in application order.
 * @returns Per-generation checksums, DDL and complete expected structure.
 * @throws MysqlError when the successor changes anything beyond the two reviewed integer CHECKs.
 */
export async function loadMysqlMigrations(): Promise<readonly MysqlMigration[]> {
  const initial = await loadMysqlMigration()
  let bytes: Buffer
  try { bytes = await readFile(new URL('../assets/002-json-safe-integers.sql', import.meta.url)) }
  catch (_error) { throw new MysqlError('configuration', 'The packaged MySQL schema v2 asset is missing or unreadable. Restore the complete package.') }
  const source = bytes.toString('utf8')
  const statements = source.split(';').map(value => value.trim()).filter(Boolean)
  const targets = [{ table: 'dsh_session_logs', check: 'ck_log_header' }, { table: 'dsh_session_events', check: 'ck_event_json' }]
  const tables = initial.tables.map(table => ({ ...table, checks: table.checks.map(check => ({ ...check })) }))
  for (const [index, target] of targets.entries()) {
    const statement = statements[index]
    const table = tables.find(value => value.name === target.table)
    const check = table?.checks.find(value => value.name === target.check)
    if (!statement || !check) throw new MysqlError('configuration', 'The MySQL schema v2 migration is incomplete.')
    const replacement = check.expression.replace(/(JSON_TYPE\(JSON_EXTRACT\([^)]*\)\)) = 'INTEGER'/g,
      "$1 IN ('INTEGER','UNSIGNED INTEGER')")
    const expected = 'ALTER TABLE ' + target.table + ' DROP CHECK ' + target.check
      + ', ADD CONSTRAINT ' + target.check + ' CHECK (' + replacement + ')'
    const found = mysqlChecks(statement)
    if (expression(statement) !== expression(expected) || found.length !== 1 || !found[0]
      || canonicalMysqlCheck(found[0].expression) !== canonicalMysqlCheck(replacement)) {
      throw new MysqlError('configuration', 'The MySQL schema v2 asset must change only the four reviewed JSON integer predicates; original constraints must be retained.')
    }
    check.expression = replacement
  }
  if (statements.length !== 2) throw new MysqlError('configuration', 'The MySQL schema v2 asset must contain exactly two ALTER statements.')
  const second = { version: 2, migrationName: 'json-safe-integers',
    scriptSha256: createHash('sha256').update(bytes).digest('hex'), statements, tables }
  if (second.scriptSha256 !== '94e5c1d36047cd6a0c43d3d00d0e44af38d2c896e352d39b8ee7a56e83ce6a07') {
    throw new MysqlError('configuration', 'The immutable MySQL v2 asset differs. Restore it and append a successor.')
  }
  return [initial, second, await loadWorkspaceMigration(second)]
}

function rows(result: MysqlResult): readonly MysqlRow[] {
  if (result.kind !== 'rows') throw new MysqlError('schema_conflict', 'MySQL schema inspection returned no row set. Check the selected database and adapter version.')
  return result.rows
}
function string(row: MysqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new MysqlError('schema_conflict', 'MySQL schema metadata is incomplete or incompatible. Inspect the selected database before retrying.')
  return value
}
function same(actual: readonly string[], expected: readonly string[]): boolean {
  const sorted = [...expected].sort()
  return actual.length === expected.length && [...actual].sort().every((value, index) => value === sorted[index])
}
function expression(value: string): string { return value.replace(/[`\s]/g, '').toLowerCase() }

/** Read-only structural inspection for an explicitly loaded generation; it never grants or writes a migration receipt.
 * @param connection - Owned connection; the caller supplies server and advisory-lock checks.
 * @param migration - Complete immutable bundle inventory for the intended generation.
 * @returns Only after actual metadata matches; unknown or partial structures reject.
 */
export async function verifyMysqlMigrationInventory(connection: MysqlMigrationConnection, migration: MysqlMigration): Promise<void> {
  const tables = rows(await connection.execute(
    'SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()', []))
  if (!same(tables.map(row => string(row, 'TABLE_NAME')), migration.tables.map(table => table.name)) ||
    tables.some(row => row['ENGINE'] !== 'InnoDB' || row['TABLE_COLLATION'] !== 'utf8mb4_0900_bin')) {
    throw new MysqlError('schema_incomplete', 'The selected database does not have exactly R7\'s twenty InnoDB tables with the required collation. Preserve it for inspection; no repair or reset was attempted.')
  }
  const liveColumns = rows(await connection.execute(
    'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, CHARACTER_SET_NAME, COLLATION_NAME, GENERATION_EXPRESSION, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION', []))
  const liveForeignKeys = rows(await connection.execute(
    'SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, k.ORDINAL_POSITION, r.DELETE_RULE, r.UPDATE_RULE FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION', []))
  const liveChecks = rows(await connection.execute(
    'SELECT t.TABLE_NAME, t.CONSTRAINT_NAME, t.ENFORCED, c.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.CONSTRAINT_TYPE=?', ['CHECK']))
  const liveIndexes = rows(await connection.execute(
    'SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', []))
  for (const table of migration.tables) {
    const fields = liveColumns.filter(row => row['TABLE_NAME'] === table.name)
    if (!same(fields.map(row => string(row, 'COLUMN_NAME')), table.columns.map(column => column.name))) {
      throw new MysqlError('schema_incomplete', 'A MySQL R7 table has missing or extra columns. Preserve the database and inspect the migration before changing it.')
    }
    for (const column of table.columns) {
      const field = fields.find(row => row['COLUMN_NAME'] === column.name)
      if (!field) throw new MysqlError('schema_incomplete', 'A required MySQL R7 column is absent. Preserve the database for inspection.')
      if (field['COLUMN_TYPE'] !== column.type || field['IS_NULLABLE'] !== (column.nullable ? 'YES' : 'NO') ||
        field['CHARACTER_SET_NAME'] !== column.charset || field['COLLATION_NAME'] !== column.collation ||
        expression(string(field, 'GENERATION_EXPRESSION')) !== expression(column.generated ?? '') ||
        (typeof field['COLUMN_DEFAULT'] === 'string' ? field['COLUMN_DEFAULT'].toLowerCase() : field['COLUMN_DEFAULT']) !== column.defaultValue ||
        string(field, 'EXTRA').toLowerCase() !== column.extra) {
        throw new MysqlError('schema_incomplete', 'A MySQL R7 column type, nullability, collation or generated expression differs. Preserve the database for inspection.')
      }
    }
    const foreign = liveForeignKeys.filter(row => row['TABLE_NAME'] === table.name)
    if (!same([...new Set(foreign.map(row => string(row, 'CONSTRAINT_NAME')))], table.foreignKeys.map(key => key.name))) {
      throw new MysqlError('schema_incomplete', 'A MySQL R7 foreign key is missing or unexpected. Cross-store integrity has not been verified.')
    }
    for (const key of table.foreignKeys) {
      const parts = foreign.filter(row => row['CONSTRAINT_NAME'] === key.name)
      if (parts.length !== key.columns.length || parts.some((part, index) => part['COLUMN_NAME'] !== key.columns[index] ||
        part['REFERENCED_TABLE_NAME'] !== key.target || part['REFERENCED_COLUMN_NAME'] !== key.targetColumns[index] ||
        !['RESTRICT', 'NO ACTION'].includes(string(part, 'DELETE_RULE')) || !['RESTRICT', 'NO ACTION'].includes(string(part, 'UPDATE_RULE')))) {
        throw new MysqlError('schema_incomplete', 'A MySQL R7 foreign-key target, column order or deletion rule differs. Preserve the database for inspection.')
      }
    }
    const checks = liveChecks.filter(row => row['TABLE_NAME'] === table.name)
    if (!same(checks.map(row => string(row, 'CONSTRAINT_NAME')), table.checks.map(check => check.name)) ||
      checks.some(row => row['ENFORCED'] !== 'YES')) {
      throw new MysqlError('schema_incomplete', 'MySQL R7 CHECK constraints are missing or not enforced. Preserve the database for inspection.')
    }
    for (const check of table.checks) {
      const live = checks.find(row => row['CONSTRAINT_NAME'] === check.name)
      if (!live || canonicalMysqlCheck(string(live, 'CHECK_CLAUSE')) !== canonicalMysqlCheck(check.expression)) {
        throw new MysqlError('schema_incomplete', 'A MySQL CHECK expression differs from the recognized schema generation. Preserve this unknown or partially migrated database for inspection.')
      }
    }
    const indexes = liveIndexes.filter(row => row['TABLE_NAME'] === table.name)
    if (!same([...new Set(indexes.map(row => string(row, 'INDEX_NAME')))], table.indexes.map(index => index.name))) {
      throw new MysqlError('schema_incomplete', 'MySQL indexes differ from the recognized schema inventory. Preserve the database for inspection.')
    }
    for (const index of table.indexes) {
      const parts = liveIndexes.filter(row => row['TABLE_NAME'] === table.name && row['INDEX_NAME'] === index.name)
      if (parts.length !== index.columns.length || parts.some((part, offset) => part['COLUMN_NAME'] !== index.columns[offset] ||
        Number(part['NON_UNIQUE']) !== (index.unique ? 0 : 1) || part['INDEX_TYPE'] !== (index.fulltext ? 'FULLTEXT' : 'BTREE'))) {
        throw new MysqlError('schema_incomplete', 'A required MySQL R7 index differs. Preserve the database and review its schema before serving data.')
      }
    }
  }
  const searchCreate = rows(await connection.execute('SHOW CREATE TABLE dsh_search_documents', []))[0]
  if (!searchCreate || !/WITH PARSER `ngram`/i.test(string(searchCreate, 'Create Table'))) {
    throw new MysqlError('schema_incomplete', 'The MySQL full-text index does not use the required ngram parser. Reconcile the deployment before indexing history.')
  }
}

async function verifyServer(connection: MysqlMigrationConnection): Promise<void> {
  const server = rows(await connection.execute(
    'SELECT VERSION() AS version, @@GLOBAL.ngram_token_size AS tokenSize, @@GLOBAL.innodb_ft_enable_stopword AS stopwords', []))[0]
  if (!server || !/^8\.4\./.test(string(server, 'version'))) {
    throw new MysqlError('unsupported_server', 'This MySQL provider requires Oracle MySQL 8.4. Select the intended isolated or approved 8.4 database.')
  }
  if (Number(server['tokenSize']) !== 2 || Number(server['stopwords']) !== 0) {
    throw new MysqlError('schema_conflict', 'R7 requires ngram_token_size=2 and innodb_ft_enable_stopword=OFF before creating or verifying the full-text index.')
  }
  const database = rows(await connection.execute(
    'SELECT DEFAULT_CHARACTER_SET_NAME AS charsetName, DEFAULT_COLLATION_NAME AS collationName FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()', []))[0]
  if (!database || database['charsetName'] !== 'utf8mb4' || database['collationName'] !== 'utf8mb4_0900_bin') {
    throw new MysqlError('schema_conflict', 'The explicitly selected database must already use utf8mb4 and utf8mb4_0900_bin. No database was created or selected implicitly.')
  }
}

async function receipts(connection: MysqlMigrationConnection, migrations: readonly MysqlMigration[]): Promise<number> {
  const records = rows(await connection.execute(
    'SELECT schema_version, migration_name, LOWER(HEX(script_sha256)) AS scriptSha256 FROM dsh_schema_migrations ORDER BY schema_version', []))
  if (records.length === 0) throw new MysqlError('schema_incomplete', 'MySQL migration receipts are absent. Preserve the partial schema; no automatic completion or reset was attempted.')
  if (records.length > migrations.length || records.some((record, index) => {
    const expected = migrations[index]
    return !expected || Number(record['schema_version']) !== expected.version || record['migration_name'] !== expected.migrationName
      || record['scriptSha256'] !== expected.scriptSha256
  })) throw new MysqlError('schema_conflict', 'The MySQL schema generation or migration checksum is unrecognized. Preserve all existing receipts and use a reviewed version migration.')
  return records.length
}

async function applyMigration(connection: MysqlMigrationConnection, migration: MysqlMigration,
  backfill?: () => Promise<void>): Promise<void> {
  let phase = 'DDL'
  try {
    for (const [index, statement] of migration.statements.entries()) {
      if (migration.version === 3 && index === 2) {
        phase = 'explicit workspace backfill'
        await backfill?.()
        phase = 'DDL'
      }
      await connection.scriptStatement(statement)
    }
    phase = 'structural verification'
    await verifyMysqlMigrationInventory(connection, migration)
    phase = 'receipt insertion'
    await connection.execute('INSERT INTO dsh_schema_migrations (schema_version, migration_name, script_sha256) VALUES (?, ?, ?)',
      [migration.version, migration.migrationName, Buffer.from(migration.scriptSha256, 'hex')])
  } catch (error) {
    if (error instanceof MysqlError && (error.code === 'cancelled' || error.code === 'timeout' || error.code === 'closed')) throw error
    const detail = error instanceof MysqlError ? ' ' + error.message : ''
    throw new MysqlError('schema_incomplete', 'MySQL schema v' + String(migration.version) + ' failed during ' + phase
      + ' and may have committed partial DDL. Preserve the database and earlier receipts for inspection.' + detail,
    error instanceof MysqlError ? error.outcome : 'unknown', false, error instanceof MysqlError ? error.driverCode : undefined)
  }
}

/** Verify, initialize an empty database, or upgrade a recognized complete predecessor under an advisory lock.
 * @param connection - Exclusively owned, UTC and strict-mode connection to the configured database.
 * @param mode - Verify never writes; initialize requires an empty database; upgrade requires recognized predecessor receipts.
 * @param database - Explicit database name, used only to derive the advisory-lock scope.
 * @param lockTimeoutSeconds - Bounded MySQL GET_LOCK wait.
 * @param workspaceSources - Explicit source/adoption decisions for every existing store before the v3 nullable-column backfill.
 * @returns The validated migration receipt after all twenty tables and twenty-five foreign keys pass inspection.
 * @throws MysqlError for incompatible servers, partial DDL, drift or checksum conflicts; no automatic repair or rollback of DDL.
 */
export async function prepareMysqlSchema(connection: MysqlMigrationConnection, mode: 'verify' | 'initialize' | 'upgrade',
  database: string, lockTimeoutSeconds: number, workspaceSources?: readonly MysqlWorkspaceAdoption[]): Promise<MysqlSchemaStatus> {
  const migrations = await loadMysqlMigrations()
  const initial = migrations[0]
  const migration = migrations.at(-1)
  if (!initial || !migration) throw new MysqlError('configuration', 'The complete ordered MySQL migrations are unavailable.')
  await verifyServer(connection)
  const lockName = 'dsh-schema:' + createHash('sha256').update(database).digest('hex').slice(0, 48)
  const lock = rows(await connection.execute('SELECT GET_LOCK(?, ?) AS acquired', [lockName, lockTimeoutSeconds]))[0]
  if (Number(lock?.['acquired']) !== 1) throw new MysqlError('lock_timeout', 'Another MySQL schema operation holds the migration lock. Retry after it completes.', 'not-started', true)
  try {
    const existing = rows(await connection.execute(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()', []))
    if (existing.length === 0) {
      if (mode !== 'initialize') throw new MysqlError('schema_missing', 'The selected MySQL database is empty. Initialize R7 explicitly with schemaMode: initialize after reviewing the target.')
      for (const step of migrations) await applyMigration(connection, step)
    } else if (!existing.some(row => row['TABLE_NAME'] === 'dsh_schema_migrations')) {
      throw new MysqlError('schema_conflict', 'The selected database already contains unrecognized tables. Initialization only accepts an empty database; nothing was reset.')
    }
    let applied = await receipts(connection, migrations)
    if (applied < migrations.length) {
      const predecessor = migrations[applied - 1]
      if (!predecessor) throw new MysqlError('schema_incomplete', 'The predecessor receipt is absent.')
      await verifyMysqlMigrationInventory(connection, predecessor)
      if (mode !== 'upgrade') throw new MysqlError('schema_conflict', 'This complete MySQL predecessor requires an explicit reviewed schemaMode: upgrade. Verification and initialization never upgrade existing history.')
      const backfill = await workspaceBackfill(connection, workspaceSources)
      for (const step of migrations.slice(applied)) await applyMigration(connection, step, backfill)
      applied = await receipts(connection, migrations)
    } else if (mode === 'upgrade') {
      throw new MysqlError('schema_conflict', 'This MySQL schema is already current; select schemaMode: verify.')
    }
    if (applied !== migrations.length) throw new MysqlError('schema_incomplete', 'MySQL migration receipts do not cover the latest schema. Preserve the database for inspection.')
    await verifyMysqlMigrationInventory(connection, migration)
    return { version: MYSQL_SCHEMA_VERSION, migrationName: MYSQL_MIGRATION_NAME, scriptSha256: migration.scriptSha256,
      tableCount: migration.tables.length, foreignKeyCount: migration.tables.reduce((total, table) => total + table.foreignKeys.length, 0) }
  } finally {
    // A failed release rejects the operation; the owning provider discards that connection.
    await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lockName])
  }
}
