/** Migration selection and failure states are checked without initializing or resetting a real database. */
import { describe, expect, it } from 'vitest'
import { canonicalMysqlCheck } from '../src/schema-checks.ts'
import { loadMysqlMigrations, prepareMysqlSchema } from '../src/schema.ts'
import type { MysqlMigration, MysqlMigrationConnection } from '../src/schema.ts'
import type { MysqlParameter, MysqlResult, MysqlRow } from '../src/types.ts'

const migrations = await loadMysqlMigrations()
const initial = migrations[0]!
const second = migrations[1]!
const latest = migrations.at(-1)!

class Fixture implements MysqlMigrationConnection {
  readonly records: MysqlRow[] = []
  readonly operations: string[] = []
  readonly checks = new Map<string, string>()
  empty = false
  failSecondAlter = false
  private inventory: MysqlMigration
  constructor(current: MysqlMigration = initial) {
    this.inventory = current
    for (const migration of migrations.slice(0, current.version)) this.records.push({ schema_version: migration.version,
      migration_name: migration.migrationName, scriptSha256: migration.scriptSha256, applied_at: 'unchanged-v1-utc' })
    for (const table of current.tables) for (const check of table.checks) this.checks.set(check.name, check.expression)
  }
  async scriptStatement(sql: string): Promise<void> {
    this.operations.push(sql)
    if (sql.startsWith('CREATE TABLE')) this.empty = false
    if (latest.statements.includes(sql)) {
      this.inventory = latest
      for (const table of latest.tables) for (const check of table.checks) this.checks.set(check.name, check.expression)
    }
    for (const table of second.tables) {
      if (!sql.startsWith('ALTER TABLE ' + table.name + '\n')) continue
      if (this.failSecondAlter && table.name === 'dsh_session_events') throw new Error('Controlled second ALTER refusal')
      for (const check of table.checks) this.checks.set(check.name, check.expression)
    }
  }
  async execute(sql: string, parameters: readonly MysqlParameter[]): Promise<MysqlResult> {
    const rows = (values: readonly MysqlRow[]): MysqlResult => ({ kind: 'rows', rows: values })
    if (sql.startsWith('SELECT VERSION()')) return rows([{ version: '8.4.11', tokenSize: 2, stopwords: 0 }])
    if (sql.includes('FROM information_schema.SCHEMATA')) return rows([{ charsetName: 'utf8mb4', collationName: 'utf8mb4_0900_bin' }])
    if (sql.startsWith('SELECT GET_LOCK')) return rows([{ acquired: 1 }])
    if (sql.startsWith('SELECT RELEASE_LOCK')) return rows([{ released: 1 }])
    if (sql.startsWith('SELECT store_id,store_key')) return rows([])
    if (sql.includes('FROM information_schema.TABLES')) return rows(this.empty ? [] : initial.tables.map(table => ({
      TABLE_NAME: table.name, ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_0900_bin',
    })))
    if (sql.includes('FROM information_schema.COLUMNS')) return rows(this.inventory.tables.flatMap(table => table.columns.map(column => ({
      TABLE_NAME: table.name, COLUMN_NAME: column.name, COLUMN_TYPE: column.type, IS_NULLABLE: column.nullable ? 'YES' : 'NO',
      CHARACTER_SET_NAME: column.charset, COLLATION_NAME: column.collation, GENERATION_EXPRESSION: column.generated ?? '',
      COLUMN_DEFAULT: column.defaultValue, EXTRA: column.extra,
    }))))
    if (sql.includes('FROM information_schema.KEY_COLUMN_USAGE')) return rows(initial.tables.flatMap(table => table.foreignKeys
      .flatMap(key => key.columns.map((column, index) => ({ TABLE_NAME: table.name, CONSTRAINT_NAME: key.name,
        COLUMN_NAME: column, REFERENCED_TABLE_NAME: key.target, REFERENCED_COLUMN_NAME: key.targetColumns[index],
        ORDINAL_POSITION: index + 1, DELETE_RULE: 'RESTRICT', UPDATE_RULE: 'RESTRICT' })))))
    if (sql.includes('FROM information_schema.TABLE_CONSTRAINTS')) return rows(this.inventory.tables.flatMap(table => table.checks.map(check => ({
      TABLE_NAME: table.name, CONSTRAINT_NAME: check.name, ENFORCED: 'YES', CHECK_CLAUSE: this.checks.get(check.name),
    }))))
    if (sql.includes('FROM information_schema.STATISTICS')) return rows(this.inventory.tables.flatMap(table => table.indexes.flatMap(index => index
      .columns.map((column, offset) => ({ TABLE_NAME: table.name, INDEX_NAME: index.name, COLUMN_NAME: column,
        NON_UNIQUE: index.unique ? 0 : 1, INDEX_TYPE: index.fulltext ? 'FULLTEXT' : 'BTREE', SEQ_IN_INDEX: offset + 1 })))))
    if (sql.startsWith('SHOW CREATE TABLE')) return rows([{ 'Create Table': 'FULLTEXT KEY ft_document_body (body) WITH PARSER `ngram`' }])
    if (sql.startsWith('SELECT schema_version')) return rows(this.records)
    if (sql.startsWith('INSERT INTO dsh_schema_migrations')) {
      this.operations.push('receipt:' + String(parameters[0]))
      const digest = parameters[2]
      if (!(digest instanceof Uint8Array)) throw new Error('Missing bound migration checksum')
      this.records.push({ schema_version: parameters[0], migration_name: parameters[1], scriptSha256: Buffer.from(digest).toString('hex') })
      return { kind: 'write', affectedRows: 1, insertId: '0', warningStatus: 0 }
    }
    throw new Error('Unexpected migration fixture query')
  }
}

describe('MySQL append-only schema lineage', () => {
  it('keeps the frozen v1 bytes and changes only the two CHECK definitions', () => {
    expect(initial.scriptSha256).toBe('4f897d35c8472182eaaab3117d313f382e078d7f4f8288a35bb9b24f708e9be9')
    expect(second).toMatchObject({ version: 2, migrationName: 'json-safe-integers' })
    expect(second.statements).toHaveLength(2)
    expect(second.statements.join('\n').match(/IN \('INTEGER','UNSIGNED INTEGER'\)/g)).toHaveLength(4)
    expect(second.tables.map(table => ({ ...table, checks: [] }))).toEqual(initial.tables.map(table => ({ ...table, checks: [] })))
  })

  it('verifies latest without DDL or receipt writes and refuses v1 without implicit upgrade', async () => {
    const current = new Fixture(latest)
    expect(await prepareMysqlSchema(current, 'verify', 'owned', 0)).toMatchObject({ version: 3, scriptSha256: latest.scriptSha256 })
    expect(current.operations).toEqual([])
    const previous = new Fixture()
    await expect(prepareMysqlSchema(previous, 'verify', 'owned', 0)).rejects.toMatchObject({ code: 'schema_conflict' })
    await expect(prepareMysqlSchema(previous, 'initialize', 'owned', 0)).rejects.toMatchObject({ code: 'schema_conflict' })
    expect(previous.operations).toEqual([])
    expect(previous.records).toHaveLength(1)
  })

  it('derives the five InnoDB foreign-key support indexes from immutable R7 declarations', () => {
    const automatic = initial.tables.flatMap(table => table.indexes.filter(index => index.name.startsWith('fk_')).map(index => index.name))
    expect(automatic).toEqual(['fk_slot_current_log', 'fk_search_state_build', 'fk_document_event', 'fk_import_item_run', 'fk_import_item_slot'])
  })

  it('upgrades only the exact complete v1 and retains its original receipt', async () => {
    const fixture = new Fixture()
    const before = structuredClone(fixture.records[0])
    expect(await prepareMysqlSchema(fixture, 'upgrade', 'owned', 0)).toMatchObject({ version: 3, migrationName: latest.migrationName })
    expect(fixture.operations).toEqual([...second.statements, 'receipt:2', ...latest.statements, 'receipt:3'])
    expect(fixture.records[0]).toEqual(before)
    expect(fixture.records[1]).toMatchObject({ schema_version: 2, scriptSha256: second.scriptSha256 })
    expect(fixture.records[2]).toMatchObject({ schema_version: 3, scriptSha256: latest.scriptSha256 })
  })

  it('initializes an empty target in order with one verified receipt per migration', async () => {
    const fixture = new Fixture()
    fixture.empty = true
    fixture.records.splice(0)
    await prepareMysqlSchema(fixture, 'initialize', 'owned', 0)
    expect(fixture.operations).toEqual([...initial.statements, 'receipt:1', ...second.statements, 'receipt:2',
      ...latest.statements, 'receipt:3'])
  })

  it('refuses empty, already-current and altered-receipt upgrade targets without a write', async () => {
    const empty = new Fixture()
    empty.empty = true
    const current = new Fixture(latest)
    const altered = new Fixture()
    altered.records[0] = { ...altered.records[0], scriptSha256: '0'.repeat(64) }
    await expect(prepareMysqlSchema(empty, 'upgrade', 'owned', 0)).rejects.toMatchObject({ code: 'schema_missing' })
    await expect(prepareMysqlSchema(current, 'upgrade', 'owned', 0)).rejects.toMatchObject({ code: 'schema_conflict' })
    await expect(prepareMysqlSchema(altered, 'upgrade', 'owned', 0)).rejects.toMatchObject({ code: 'schema_conflict' })
    expect([...empty.operations, ...current.operations, ...altered.operations]).toEqual([])
  })

  it('keeps a partial two-table migration visible and never automatically completes it', async () => {
    const fixture = new Fixture()
    fixture.failSecondAlter = true
    const before = structuredClone(fixture.records)
    await expect(prepareMysqlSchema(fixture, 'upgrade', 'owned', 0)).rejects.toMatchObject({ code: 'schema_incomplete' })
    expect(fixture.records).toEqual(before)
    const attempted = fixture.operations.length
    fixture.failSecondAlter = false
    await expect(prepareMysqlSchema(fixture, 'upgrade', 'owned', 0)).rejects.toMatchObject({ code: 'schema_incomplete' })
    expect(fixture.operations).toHaveLength(attempted)
  })

  it('normalizes Oracle formatting while retaining boolean grouping, binary casts and literal case', () => {
    expect(canonicalMysqlCheck('OCTET_LENGTH(id)>0')).toBe(canonicalMysqlCheck('(length(`id`) > 0)'))
    expect(canonicalMysqlCheck('CAST(kind AS BINARY)')).toBe(canonicalMysqlCheck('cast(`kind` as char charset binary)'))
    expect(canonicalMysqlCheck("kind='OBJECT' AND (x=1 OR y=2)"))
      .toBe(canonicalMysqlCheck("((`kind` = _utf8mb4\\'OBJECT\\') and ((`x`=1) or (`y`=2)))"))
    expect(canonicalMysqlCheck("kind IN ('staging','active')"))
      .toBe(canonicalMysqlCheck("(`kind` in (_ascii\\'staging\\',_ascii\\'active\\'))"))
    expect(() => canonicalMysqlCheck("kind=_ascii'非ASCII'")).toThrow()
    expect(canonicalMysqlCheck('x=1 AND (y=2 OR z=3)')).not.toBe(canonicalMysqlCheck('(x=1 AND y=2) OR z=3'))
    expect(canonicalMysqlCheck("kind='object'")).not.toBe(canonicalMysqlCheck("kind='OBJECT'"))
    expect(() => canonicalMysqlCheck('x LIKE 1')).toThrow()
  })
})
