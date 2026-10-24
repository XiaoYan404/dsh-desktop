/** New v3 cases; historical v1/v2 passing titles are not repeated. */
import { describe, expect, it } from 'vitest'
import { loadMysqlMigrations } from '../src/schema.ts'
import { workspaceBackfill } from '../src/schema-workspace.ts'
import type { MysqlMigrationConnection } from '../src/schema.ts'
import type { MysqlResult, MysqlRow } from '../src/types.ts'

const rows = (values: readonly MysqlRow[]): MysqlResult => ({ kind: 'rows', rows: values })
function fixture() {
  const writes: string[] = []
  const store = { store_id: '1', store_key: 'owned', registry_initialized: 0, default_workspace_external_id: null, registry_revision: '0' }
  const connection: MysqlMigrationConnection = {
    execute: async (sql) => {
      if (sql.startsWith('SELECT store_id,store_key')) return rows([store])
      if (sql.startsWith('SELECT p.slot_id')) return rows([{ slot_id: '2', external_session_id: '后归档' }, { slot_id: '3', external_session_id: '先归档' }])
      if (sql.startsWith('UPDATE')) { writes.push(sql); return { kind: 'write', affectedRows: 1, insertId: '0', warningStatus: 0 } }
      throw new Error('Unexpected v3 migration statement')
    },
    scriptStatement: async () => { throw new Error('Backfill must not execute DDL') },
  }
  return { connection, writes }
}
describe('Workspace schema successor v3', () => {
  it('retains both predecessor inventories and adds only workspace ordering/presence/ownership fields', async () => {
    const generations = await loadMysqlMigrations()
    expect(generations.map(value => value.version)).toEqual([1, 2, 3])
    expect(generations[1]?.scriptSha256).toBe('94e5c1d36047cd6a0c43d3d00d0e44af38d2c896e352d39b8ee7a56e83ce6a07')
    const latest = generations[2]!
    expect(latest.tables).toHaveLength(20)
    expect(latest.tables.flatMap(value => value.foreignKeys)).toHaveLength(25)
    expect(latest.statements).toHaveLength(4)
    expect(latest.tables.find(value => value.name === 'dsh_stores')?.columns.slice(-4).map(value => value.name))
      .toEqual(['workspace_global_written', 'workspace_owner_token', 'workspace_fence', 'workspace_lease_expires'])
    expect(latest.tables.find(value => value.name === 'dsh_session_events')).toEqual(generations[1]?.tables.find(value => value.name === 'dsh_session_events'))
  })
  it('refuses missing decisions and an unordered boolean archive set before any backfill', async () => {
    const target = fixture()
    await expect(workspaceBackfill(target.connection)).rejects.toMatchObject({ code: 'schema_conflict' })
    await expect(workspaceBackfill(target.connection, [{ storeKey: 'owned', globalWritten: true, archivedSessionIds: [] }]))
      .rejects.toMatchObject({ code: 'schema_conflict' })
    expect(target.writes).toEqual([])
  })
  it('uses the supplied original archive order and never inserts a schema receipt from a backfill', async () => {
    const target = fixture()
    const fill = await workspaceBackfill(target.connection, [{ storeKey: 'owned', globalWritten: true, archivedSessionIds: ['先归档', '后归档'] }])
    await fill()
    expect(target.writes).toHaveLength(3)
    expect(target.writes.every(value => !value.includes('dsh_schema_migrations'))).toBe(true)
  })
})
