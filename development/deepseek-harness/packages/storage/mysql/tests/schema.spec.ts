/** The executable asset preserves R7's complete tables and validates migration identity without a database. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadMysqlMigration, MYSQL_MIGRATION_NAME, MYSQL_SCHEMA_VERSION } from '../src/schema.ts'
import { mysqlFailure } from '../src/error.ts'
import { Config, MysqlError } from '../src/index.ts'

describe('R7 schema asset', () => {
  it('retains all twenty tables, twenty-five restrictive relationships and the canonical script bytes', async () => {
    const migration = await loadMysqlMigration()
    expect(MYSQL_SCHEMA_VERSION).toBe(3)
    expect(MYSQL_MIGRATION_NAME).toBe('workspace-order-and-lease')
    expect(migration.tables.map(table => table.name)).toEqual([
      'dsh_schema_migrations', 'dsh_stores', 'dsh_session_slots', 'dsh_workspaces', 'dsh_workspace_order',
      'dsh_workspace_sessions', 'dsh_session_preferences', 'dsh_session_logs', 'dsh_session_events',
      'dsh_event_sources', 'dsh_writer_leases', 'dsh_append_batches', 'dsh_projection_checkpoints',
      'dsh_projection_states', 'dsh_search_builds', 'dsh_search_state', 'dsh_search_documents',
      'dsh_search_jobs', 'dsh_import_runs', 'dsh_import_items',
    ])
    expect(migration.tables.reduce((total, table) => total + table.foreignKeys.length, 0)).toBe(25)
    expect(migration.statements).toHaveLength(23)
    const bytes = await readFile(new URL('../assets/001-r7.sql', import.meta.url))
    expect(migration.scriptSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(migration.scriptSha256).toBe('4f897d35c8472182eaaab3117d313f382e078d7f4f8288a35bb9b24f708e9be9')
    expect(bytes.toString('utf8')).not.toMatch(/CREATE DATABASE|^USE /m)
    const events = migration.tables.find(table => table.name === 'dsh_session_events')
    expect(events?.columns.find(column => column.name === 'event_json')).toMatchObject({ type: 'longtext', nullable: false })
    expect(events?.checks.map(check => check.name)).toContain('ck_event_json')
    expect(migration.tables.find(table => table.name === 'dsh_session_slots')?.foreignKeys).toContainEqual({
      name: 'fk_slot_current_log', columns: ['store_id', 'slot_id', 'current_lifecycle_id', 'current_format_version'],
      target: 'dsh_session_logs', targetColumns: ['store_id', 'slot_id', 'lifecycle_id', 'format_version'],
    })
  })
})

const endpoint = { host: '127.0.0.1', port: 33306, database: 'dsh_test', user: 'test', passwordRef: 'MYSQL_TEST_PASSWORD' }

describe('explicit MySQL configuration', () => {
  it('defaults to verification and bounded resources, leaving initialization explicit', () => {
    const config = Config(endpoint)
    expect(config.schemaMode).toBe('verify')
    expect(config.connectionLimit).toBe(4)
    expect(config.operationTimeoutMs).toBe(15000)
    expect(config.connectTimeoutMs).toBe(5000)
  })

  it.each([
    { port: 0 }, { port: 65536 }, { database: 'other; DROP DATABASE x' },
    { host: 'mysql://user:private@localhost' }, { passwordRef: 'inline private password!' },
    { connectionLimit: 0 }, { schemaMode: 'reset' }, { operationTimeoutMs: 0 },
  ])('rejects invalid endpoint or resource choices before connection setup', async (invalid) => {
    const validation = await Config['~standard'].validate({ ...endpoint, ...invalid })
    expect(validation).toHaveProperty('issues')
  })

  it.each([
    ['ER_ACCESS_DENIED_ERROR', 'authentication_failed'], ['ECONNREFUSED', 'connection_unavailable'],
    ['ER_DUP_ENTRY', 'constraint_failed'], ['ER_CHECK_CONSTRAINT_VIOLATED', 'constraint_failed'],
    ['ER_LOCK_DEADLOCK', 'deadlock'], ['ER_LOCK_WAIT_TIMEOUT', 'lock_timeout'], ['PRIVATE_UNRECOGNIZED', 'statement_failed'],
  ])('maps %s without leaking driver SQL or data', (driverCode, expected) => {
    const failure = mysqlFailure({ code: driverCode, message: 'private parameter', sql: 'private SQL', password: 'private password' })
    expect(failure).toBeInstanceOf(MysqlError)
    expect(failure.code).toBe(expected)
    expect(JSON.stringify(failure) + failure.message).not.toMatch(/private parameter|private SQL|private password/)
  })
})
