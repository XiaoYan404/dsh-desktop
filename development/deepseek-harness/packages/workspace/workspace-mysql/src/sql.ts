/** Bound R7 Workspace reads and single-transaction publication, without DDL or generic KV rows. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MysqlExecutor, MysqlResult, MysqlRow } from '@deepseek-ai/dsh-mysql'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { decimal, globalValue, increment, nonempty, recordValue, sameBytes, text, validateImage,
  WorkspaceAdapterError, workspaceIdentity } from './model.ts'
import type { StoredWorkspace, WorkspaceImage, WorkspacePlan, WorkspaceLease } from './model.ts'

/** Fixed positional statements; the independent protocol fixture rejects statements outside this set. */
export const workspaceSql = {
  store: 'SELECT store_id,workspace_domain_version,registry_initialized,default_workspace_external_id,registry_revision,search_epoch,workspace_global_written,workspace_owner_token,workspace_fence,(workspace_lease_expires>UTC_TIMESTAMP(6)) AS lease_valid FROM dsh_stores WHERE store_key=? FOR UPDATE',
  records: 'SELECT workspace_pk,external_workspace_id,canonical_path,title,created_at_iso,updated_at_iso,record_revision FROM dsh_workspaces WHERE store_id=? ORDER BY workspace_pk FOR UPDATE',
  order: 'SELECT workspace_pk,position_no FROM dsh_workspace_order WHERE store_id=? ORDER BY position_no FOR UPDATE',
  candidates: 'SELECT m.workspace_pk,m.slot_id,m.position_no,s.external_session_id FROM dsh_workspace_sessions m JOIN dsh_session_slots s ON s.store_id=m.store_id AND s.slot_id=m.slot_id WHERE m.store_id=? ORDER BY m.workspace_pk,m.position_no FOR UPDATE',
  preferences: 'SELECT p.slot_id,p.is_archived,p.pin_position,p.archive_position,s.external_session_id FROM dsh_session_preferences p JOIN dsh_session_slots s ON s.store_id=p.store_id AND s.slot_id=p.slot_id WHERE p.store_id=? ORDER BY p.slot_id FOR UPDATE',
  byId: 'SELECT workspace_pk,external_workspace_id,canonical_path FROM dsh_workspaces WHERE store_id=? AND external_id_hash=UNHEX(SHA2(?,256)) FOR UPDATE',
  byPath: 'SELECT workspace_pk,external_workspace_id,canonical_path FROM dsh_workspaces WHERE store_id=? AND path_hash=UNHEX(SHA2(?,256)) FOR UPDATE',
  slot: 'SELECT slot_id,external_session_id FROM dsh_session_slots WHERE store_id=? AND external_id_hash=UNHEX(SHA2(?,256)) FOR UPDATE',
  addSlot: 'INSERT INTO dsh_session_slots (store_id,external_session_id) VALUES (?,?) ON DUPLICATE KEY UPDATE slot_id=slot_id',
  clearOrder: 'DELETE FROM dsh_workspace_order WHERE store_id=?',
  clearCandidates: 'DELETE FROM dsh_workspace_sessions WHERE store_id=?',
  removeRecord: 'DELETE FROM dsh_workspaces WHERE store_id=? AND workspace_pk=? AND record_revision=?',
  addRecord: 'INSERT INTO dsh_workspaces (store_id,external_workspace_id,canonical_path,title,created_at_iso,updated_at_iso,record_revision) VALUES (?,?,?,?,?,?,?)',
  replaceRecord: 'INSERT INTO dsh_workspaces (workspace_pk,store_id,external_workspace_id,canonical_path,title,created_at_iso,updated_at_iso,record_revision) VALUES (?,?,?,?,?,?,?,?)',
  orderItem: 'INSERT INTO dsh_workspace_order (store_id,workspace_pk,position_no) VALUES (?,?,?)',
  candidate: 'INSERT INTO dsh_workspace_sessions (store_id,workspace_pk,slot_id,position_no) VALUES (?,?,?,?)',
  clearPreferences: 'DELETE FROM dsh_session_preferences WHERE store_id=?',
  preference: 'INSERT INTO dsh_session_preferences (store_id,slot_id,is_archived,pin_position,archive_position) VALUES (?,?,?,?,?)',
  advance: 'UPDATE dsh_stores SET registry_initialized=?,default_workspace_external_id=?,workspace_global_written=?,registry_revision=registry_revision+1,search_epoch=search_epoch+1 WHERE store_id=? AND registry_revision=?',
  acquire: 'UPDATE dsh_stores SET workspace_owner_token=?,workspace_fence=workspace_fence+1,workspace_lease_expires=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(6)) WHERE store_id=? AND workspace_fence=?',
  renew: 'UPDATE dsh_stores SET workspace_lease_expires=TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(6)) WHERE store_key=? AND workspace_owner_token=? AND workspace_fence=? AND workspace_lease_expires>UTC_TIMESTAMP(6)',
  release: 'UPDATE dsh_stores SET workspace_owner_token=NULL,workspace_lease_expires=NULL WHERE store_key=? AND workspace_owner_token=? AND workspace_fence=?',
} as const

function rows(result: MysqlResult): readonly MysqlRow[] {
  if (result.kind !== 'rows') throw new WorkspaceAdapterError('malformed-medium')
  return result.rows
}

function oneWrite(result: MysqlResult): string {
  if (result.kind !== 'write' || result.affectedRows !== 1) throw new WorkspaceAdapterError('record-conflict')
  return decimal(result.insertId)
}

function flag(value: unknown): boolean {
  if (value === 1) return true
  if (value === 0) return false
  throw new WorkspaceAdapterError('malformed-medium')
}

function only(values: readonly MysqlRow[]): MysqlRow | undefined {
  if (values.length > 1) throw new WorkspaceAdapterError('malformed-medium')
  return values[0]
}

/** Read one consistent normalized registry while holding its store lock.
 * @param tx - Existing transaction scope, using the real MysqlExecutor protocol.
 * @param storeKey - Adopted namespace; never implicitly created.
 * @returns Current typed global, records, exact CAS revisions and internal keys.
 */
export async function readWorkspaceImage(tx: MysqlExecutor, storeKey: string): Promise<WorkspaceImage> {
  const store = only(rows(await tx.execute(workspaceSql.store, [storeKey])))
  if (!store) throw new WorkspaceAdapterError('store-missing')
  if (store['workspace_domain_version'] !== 2) throw new WorkspaceAdapterError('version-mismatch')
  const storeId = decimal(store['store_id']), revision = decimal(store['registry_revision'])
  decimal(store['search_epoch'])
  const records = new Map<string, StoredWorkspace>(), byPk = new Map<string, string>()
  for (const row of rows(await tx.execute(workspaceSql.records, [storeId]))) {
    const id = nonempty(row['external_workspace_id']), pk = decimal(row['workspace_pk'])
    if (records.has(id) || byPk.has(pk)) throw new WorkspaceAdapterError('malformed-medium')
    records.set(id, { pk, revision: decimal(row['record_revision']), value: recordValue({
      path: row['canonical_path'], title: row['title'], createdAt: row['created_at_iso'],
      updatedAt: row['updated_at_iso'], sessionIds: [],
    }) })
    byPk.set(pk, id)
  }
  const workspaceIds = rows(await tx.execute(workspaceSql.order, [storeId])).map((row, position) => {
    if (decimal(row['position_no']) !== String(position)) throw new WorkspaceAdapterError('malformed-medium')
    const id = byPk.get(decimal(row['workspace_pk']))
    if (id === undefined) throw new WorkspaceAdapterError('malformed-medium')
    return workspaceIdentity(id)
  })
  const candidateIds = new Set<string>()
  for (const row of rows(await tx.execute(workspaceSql.candidates, [storeId]))) {
    const id = byPk.get(decimal(row['workspace_pk']))
    const stored = id === undefined ? undefined : records.get(id)
    const session = nonempty(row['external_session_id'])
    decimal(row['slot_id'])
    if (!stored || candidateIds.has(session) || decimal(row['position_no']) !== String(stored.value.sessionIds.length)) {
      throw new WorkspaceAdapterError('malformed-medium')
    }
    stored.value.sessionIds.push(brandString<SessionId>(session))
    candidateIds.add(session)
  }
  const pinned = new Map<number, SessionId>(), archived = new Map<number, SessionId>(), seenPreferences = new Set<string>()
  for (const row of rows(await tx.execute(workspaceSql.preferences, [storeId]))) {
    const id = nonempty(row['external_session_id'])
    decimal(row['slot_id'])
    if (seenPreferences.has(id)) throw new WorkspaceAdapterError('malformed-medium')
    seenPreferences.add(id)
    const isArchived = flag(row['is_archived'])
    if (isArchived !== (row['archive_position'] !== null) || (isArchived && row['pin_position'] !== null)) throw new WorkspaceAdapterError('malformed-medium')
    if (row['archive_position'] !== null) {
      const position = Number(decimal(row['archive_position']))
      if (!Number.isSafeInteger(position) || archived.has(position)) throw new WorkspaceAdapterError('malformed-medium')
      archived.set(position, brandString<SessionId>(id))
    }
    if (row['pin_position'] !== null) {
      const position = Number(decimal(row['pin_position']))
      if (!Number.isSafeInteger(position) || pinned.has(position)) throw new WorkspaceAdapterError('malformed-medium')
      pinned.set(position, brandString<SessionId>(id))
    }
  }
  const defaultId = store['default_workspace_external_id']
  const global = globalValue({ initialized: flag(store['registry_initialized']), workspaceIds,
    ...(defaultId === null ? {} : { defaultWorkspaceId: workspaceIdentity(text(defaultId)) }),
    archivedSessionIds: ordered(archived), pinnedSessionIds: ordered(pinned) })
  const globalWritten = flag(store['workspace_global_written'])
  if (!globalWritten && (global.initialized || global.defaultWorkspaceId !== undefined || workspaceIds.length
    || global.archivedSessionIds.length || global.pinnedSessionIds.length)) throw new WorkspaceAdapterError('malformed-medium')
  validateImage(global, new Map([...records].map(([id, stored]) => [id, stored.value])))
  return { storeId, revision, global, globalWritten, records }
}

function ordered(values: ReadonlyMap<number, SessionId>): SessionId[] {
  return Array.from({ length: values.size }, (_unused, position) => {
    const id = values.get(position)
    if (id === undefined) throw new WorkspaceAdapterError('malformed-medium')
    return id
  })
}

/** Acquire the single registry cache owner under the common store-first lock order.
 * @param tx - Transaction that will publish the opened image only after ACK.
 * @param storeKey - Explicit namespace.
 * @param owner - Fresh private random owner.
 * @param ttlMs - Configured lease lifetime.
 * @returns Fixed owner/fence; an unexpired previous owner refuses admission.
 */
export async function acquireWorkspace(tx: MysqlExecutor, storeKey: string, owner: Buffer, ttlMs: number): Promise<WorkspaceLease> {
  const row = only(rows(await tx.execute(workspaceSql.store, [storeKey])))
  if (!row) throw new WorkspaceAdapterError('store-missing')
  if (row['workspace_owner_token'] !== null && Number(row['lease_valid']) === 1) throw new WorkspaceAdapterError('already-owned')
  const fence = decimal(row['workspace_fence'])
  const next = increment(fence)
  oneWrite(await tx.execute(workspaceSql.acquire, [owner, ttlMs * 1000, decimal(row['store_id']), fence]))
  return { owner, fence: next }
}

/** Check the durable owner without ever reacquiring an expired lease.
 * @param tx - Store-first transaction.
 * @param storeKey - Exact namespace.
 * @param lease - Original owner/fence.
 */
export async function assertWorkspaceOwner(tx: MysqlExecutor, storeKey: string, lease: WorkspaceLease): Promise<void> {
  const row = only(rows(await tx.execute(workspaceSql.store, [storeKey])))
  if (!row || !(row['workspace_owner_token'] instanceof Uint8Array) || !Buffer.from(row['workspace_owner_token']).equals(lease.owner)
    || row['workspace_fence'] !== lease.fence || Number(row['lease_valid']) !== 1) throw new WorkspaceAdapterError('ownership-lost')
}

function compareOpened(current: WorkspaceImage, opened: WorkspaceImage): void {
  if (current.storeId !== opened.storeId || current.revision !== opened.revision) {
    throw new WorkspaceAdapterError('registry-conflict')
  }
  if (current.records.size !== opened.records.size) throw new WorkspaceAdapterError('record-conflict')
  for (const [id, record] of opened.records) {
    const stored = current.records.get(id)
    if (!stored || stored.pk !== record.pk || stored.revision !== record.revision) {
      throw new WorkspaceAdapterError('record-conflict')
    }
  }
}

async function checkHash(tx: MysqlExecutor, statement: typeof workspaceSql.byId | typeof workspaceSql.byPath,
  storeId: string, value: string): Promise<void> {
  const row = only(rows(await tx.execute(statement, [storeId, value])))
  const field = statement === workspaceSql.byId ? 'external_workspace_id' : 'canonical_path'
  if (row && !sameBytes(text(row[field]), value)) throw new WorkspaceAdapterError('hash-collision')
}

async function resolveSlot(tx: MysqlExecutor, storeId: string, id: string): Promise<string> {
  let row = only(rows(await tx.execute(workspaceSql.slot, [storeId, id])))
  if (!row) {
    await tx.execute(workspaceSql.addSlot, [storeId, id])
    row = only(rows(await tx.execute(workspaceSql.slot, [storeId, id])))
  }
  if (!row) throw new WorkspaceAdapterError('malformed-medium')
  if (!sameBytes(text(row['external_session_id']), id)) throw new WorkspaceAdapterError('hash-collision')
  return decimal(row['slot_id'])
}

/** Publish the complete final order, candidate ledger and pins alongside changed records in this one transaction.
 * @param tx - Scope that expires with the callback; no retry, schema or transaction-control SQL is issued here.
 * @param storeKey - Same explicit adopted namespace as open.
 * @param opened - Last ACKed image; stale registry and record revisions cannot overwrite another writer.
 * @param plan - Fully validated target, including archive ordinals; unrecovered pending markers are refused.
 * @param lease - Original registry cache owner and fence.
 * @returns Tentative image; callers must not publish it until MysqlClient.transaction resolves after COMMIT.
 */
export async function commitWorkspaceImage(tx: MysqlExecutor, storeKey: string, opened: WorkspaceImage,
  plan: WorkspacePlan, lease: WorkspaceLease): Promise<WorkspaceImage> {
  await assertWorkspaceOwner(tx, storeKey, lease)
  const current = await readWorkspaceImage(tx, storeKey)
  compareOpened(current, opened)
  const nextRevision = increment(current.revision), storeId = current.storeId
  // The store lock protects this counter from both Workspace and Session writers until COMMIT.
  const store = only(rows(await tx.execute(workspaceSql.store, [storeKey])))
  if (!store) throw new WorkspaceAdapterError('store-missing')
  increment(decimal(store['search_epoch']))
  for (const id of plan.touched) {
    const value = plan.records.get(id)
    if (!value) continue
    await checkHash(tx, workspaceSql.byId, storeId, id)
    await checkHash(tx, workspaceSql.byPath, storeId, value.path)
  }
  const slots = new Map<string, string>()
  const required = new Set([...plan.records.values()].flatMap(value => value.sessionIds)
    .concat(plan.global.pinnedSessionIds, plan.global.archivedSessionIds))
  for (const id of [...required].sort()) slots.set(id, await resolveSlot(tx, storeId, id))
  await tx.execute(workspaceSql.clearOrder, [storeId])
  await tx.execute(workspaceSql.clearCandidates, [storeId])
  // Removing all touched rows first permits path swaps without a transient UNIQUE violation.
  for (const id of plan.touched) {
    const old = current.records.get(id)
    if (old) oneWrite(await tx.execute(workspaceSql.removeRecord, [storeId, old.pk, old.revision]))
  }
  const records = new Map<string, StoredWorkspace>()
  for (const [id, value] of plan.records) {
    const old = current.records.get(id)
    if (!plan.touched.has(id)) {
      if (!old) throw new WorkspaceAdapterError('malformed-medium')
      records.set(id, old)
      continue
    }
    const revision = old ? increment(old.revision) : '1'
    const values = [storeId, id, value.path, value.title, value.createdAt, value.updatedAt, revision]
    const pk = old
      ? (oneWrite(await tx.execute(workspaceSql.replaceRecord, [old.pk, ...values])), old.pk)
      : oneWrite(await tx.execute(workspaceSql.addRecord, values))
    records.set(id, { pk, revision, value })
  }
  for (const [position, id] of plan.global.workspaceIds.entries()) {
    const stored = records.get(id)
    if (!stored) throw new WorkspaceAdapterError('malformed-medium')
    oneWrite(await tx.execute(workspaceSql.orderItem, [storeId, stored.pk, String(position)]))
  }
  for (const stored of records.values()) {
    for (const [position, session] of stored.value.sessionIds.entries()) {
      const slot = slots.get(session)
      if (slot === undefined) throw new WorkspaceAdapterError('malformed-medium')
      oneWrite(await tx.execute(workspaceSql.candidate, [storeId, stored.pk, slot, String(position)]))
    }
  }
  await tx.execute(workspaceSql.clearPreferences, [storeId])
  for (const [position, id] of plan.global.pinnedSessionIds.entries()) {
    const slot = slots.get(id)
    if (slot === undefined) throw new WorkspaceAdapterError('malformed-medium')
    oneWrite(await tx.execute(workspaceSql.preference, [storeId, slot, 0, String(position), null]))
  }
  for (const [position, id] of plan.global.archivedSessionIds.entries()) {
    const slot = slots.get(id)
    if (slot === undefined) throw new WorkspaceAdapterError('malformed-medium')
    oneWrite(await tx.execute(workspaceSql.preference, [storeId, slot, 1, null, String(position)]))
  }
  const result = await tx.execute(workspaceSql.advance,
    [plan.global.initialized, plan.global.defaultWorkspaceId ?? null, plan.globalWritten, storeId, current.revision])
  if (result.kind !== 'write' || result.affectedRows !== 1) throw new WorkspaceAdapterError('registry-conflict')
  return { storeId, revision: nextRevision, global: plan.global, globalWritten: plan.globalWritten, records }
}
