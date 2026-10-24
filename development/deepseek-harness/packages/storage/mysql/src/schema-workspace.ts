/** Workspace schema successor and explicit source decisions; no archive order is inferred from old booleans. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { MysqlError } from './error.ts'
import { mysqlChecks } from './schema-checks.ts'
import type { MysqlMigration, MysqlMigrationConnection } from './schema.ts'
import type { MysqlResult, MysqlRow } from './types.ts'

/** An operator-reviewed source decision for every existing store in an exclusively drained migration window. */
export interface MysqlWorkspaceAdoption {
  readonly storeKey: string
  /** Explicitly adopt normalized columns as materialized, or preserve source global:null as unwritten. */
  readonly globalWritten: boolean
  /** Exact source order, including an explicit empty array; a boolean archive set supplies no order. */
  readonly archivedSessionIds: readonly string[]
}

function rows(result: MysqlResult): readonly MysqlRow[] {
  if (result.kind !== 'rows') throw new MysqlError('schema_incomplete', 'Workspace migration metadata was not a row set.')
  return result.rows
}

/** Load only the reviewed additive successor; original migration inventory and bytes remain unchanged.
 * @param previous - Immutable schema v2 inventory.
 * @returns Complete schema v3 structure and its executable checksum.
 */
export async function loadWorkspaceMigration(previous: MysqlMigration): Promise<MysqlMigration> {
  const bytes = await readFile(new URL('../assets/003-workspace-order-and-lease.sql', import.meta.url))
  const scriptSha256 = createHash('sha256').update(bytes).digest('hex')
  if (scriptSha256 !== '8d5d538438359362259189bc19e006732a1ebc61d2fa80f752e76a92d066ccbf') {
    throw new MysqlError('configuration', 'The reviewed v3 asset differs; append a successor instead of replacing migration bytes.')
  }
  const source = bytes.toString('utf8')
  const statements = source.split(';').map(value => value.trim()).filter(Boolean)
  if (statements.length !== 4 || !statements[0]?.startsWith('ALTER TABLE dsh_session_preferences\n')
    || !statements[1]?.startsWith('ALTER TABLE dsh_stores\n') || !statements[2]?.startsWith('ALTER TABLE dsh_session_preferences\n')
    || !statements[3]?.startsWith('ALTER TABLE dsh_stores\n')) {
    throw new MysqlError('configuration', 'The workspace schema successor must contain its four reviewed additive statements.')
  }
  const tables = structuredClone(previous.tables)
  const stores = tables.find(table => table.name === 'dsh_stores')
  const preferences = tables.find(table => table.name === 'dsh_session_preferences')
  if (!stores || !preferences) throw new MysqlError('configuration', 'The predecessor has no workspace inventory.')
  const column = (name: string, type: string, nullable: boolean, defaultValue: string | null = null) => ({
    name, type, nullable, defaultValue, charset: null, collation: null, generated: undefined, extra: '',
  })
  stores.columns.push(column('workspace_global_written', 'tinyint(1)', false, '0'),
    column('workspace_owner_token', 'binary(16)', true), column('workspace_fence', 'bigint unsigned', false, '0'),
    column('workspace_lease_expires', 'datetime(6)', true))
  preferences.columns.push(column('archive_position', 'bigint unsigned', true))
  preferences.indexes.push({ name: 'uq_archive_order', columns: ['store_id', 'archive_position'], unique: true, fulltext: false })
  stores.checks.push(...mysqlChecks(statements[1]))
  preferences.checks.push(...mysqlChecks(statements[2]))
  return { version: 3, migrationName: 'workspace-order-and-lease',
    scriptSha256, statements, tables }
}

/** Validate all explicit decisions before any DDL; missing sources and ambiguous ordinals fail without writes.
 * @param connection - Exclusively owned schema connection; all application writers are externally drained.
 * @param decisions - One explicit source/adoption decision per existing store.
 * @returns Backfill callback for the nullable-column stage; partial failure never grants a receipt.
 */
export async function workspaceBackfill(connection: MysqlMigrationConnection,
  decisions?: readonly MysqlWorkspaceAdoption[]): Promise<() => Promise<void>> {
  const stores = rows(await connection.execute(
    'SELECT store_id,store_key,registry_initialized,default_workspace_external_id,registry_revision FROM dsh_stores ORDER BY store_id', []))
  if ((decisions?.length ?? 0) !== stores.length || new Set(decisions?.map(value => value.storeKey)).size !== stores.length) {
    throw new MysqlError('schema_conflict', 'Workspace schema upgrade requires an explicit source decision for every existing store before DDL. Pause and drain writers; never infer global presence or archive order.')
  }
  const plans: Array<{ store: MysqlRow; decision: MysqlWorkspaceAdoption; slots: readonly MysqlRow[] }> = []
  for (const store of stores) {
    const decision = decisions?.find(value => value.storeKey === store['store_key'])
    if (!decision || typeof decision.globalWritten !== 'boolean' || new Set(decision.archivedSessionIds).size !== decision.archivedSessionIds.length) {
      throw new MysqlError('schema_conflict', 'An explicit workspace source decision is missing or repeated.')
    }
    const id = store['store_id']
    if (typeof id !== 'string') throw new MysqlError('schema_incomplete', 'Workspace migration store identity is invalid.')
    const slots = rows(await connection.execute(
      'SELECT p.slot_id,s.external_session_id FROM dsh_session_preferences p JOIN dsh_session_slots s ON s.store_id=p.store_id AND s.slot_id=p.slot_id WHERE p.store_id=? AND p.is_archived=1 ORDER BY p.slot_id', [id]))
    if (slots.length !== decision.archivedSessionIds.length || slots.some(row => !decision.archivedSessionIds.includes(String(row['external_session_id'])))) {
      throw new MysqlError('schema_conflict', 'The authoritative archive list does not exactly match the stored archive set; no order was fabricated.')
    }
    if (!decision.globalWritten) {
      const state = rows(await connection.execute(
        'SELECT (SELECT COUNT(*) FROM dsh_workspace_order WHERE store_id=?) AS orders,(SELECT COUNT(*) FROM dsh_session_preferences WHERE store_id=? AND (is_archived=1 OR pin_position IS NOT NULL)) AS preferences', [id, id]))[0]
      if (Number(store['registry_initialized']) !== 0 || store['default_workspace_external_id'] !== null
        || Number(state?.['orders']) !== 0 || Number(state?.['preferences']) !== 0) {
        throw new MysqlError('schema_conflict', 'A source global:null decision conflicts with normalized registry state.')
      }
    }
    plans.push({ store, decision, slots })
  }
  return async () => {
    const current = rows(await connection.execute(
      'SELECT store_id,store_key,registry_initialized,default_workspace_external_id,registry_revision FROM dsh_stores ORDER BY store_id', []))
    if (JSON.stringify(current) !== JSON.stringify(stores)) throw new MysqlError('schema_conflict', 'Workspace state changed during the exclusive migration window.')
    for (const { store, decision, slots } of plans) {
      const id = String(store['store_id'])
      for (const [position, external] of decision.archivedSessionIds.entries()) {
        const slot = slots.find(row => row['external_session_id'] === external)
        if (!slot || typeof slot['slot_id'] !== 'string') throw new MysqlError('schema_conflict', 'Archive source identity no longer matches.')
        const result = await connection.execute('UPDATE dsh_session_preferences SET archive_position=? WHERE store_id=? AND slot_id=? AND is_archived=1 AND archive_position IS NULL', [position, id, slot['slot_id']])
        if (result.kind !== 'write' || result.affectedRows !== 1) throw new MysqlError('schema_conflict', 'An archive backfill CAS failed; preserve the partial migration.')
      }
      const result = await connection.execute('UPDATE dsh_stores SET workspace_global_written=? WHERE store_id=? AND registry_revision=? AND workspace_global_written IS NULL',
        [decision.globalWritten, id, String(store['registry_revision'])])
      if (result.kind !== 'write' || result.affectedRows !== 1) throw new MysqlError('schema_conflict', 'A global-presence backfill CAS failed; preserve the partial migration.')
    }
  }
}
