/** Fixed R7 normalized-table statements and canonical complete-prefix reads; no DDL or authority writes. */
import type { MysqlExecutor, MysqlResult, MysqlRow } from '@deepseek-ai/dsh-mysql'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { assertVersion } from '@deepseek-ai/dsh-session-persistence'
import { assertMysqlSessionRepresentable as assertRepresentable, mysqlSessionBinaryId as binaryId,
  mysqlSessionCount as count, decodeMysqlSessionEvent as decodeEvent, decodeMysqlSessionLog as decodeLog,
  mysqlSessionRows as rows, mysqlSessionSlotId as slotId, mysqlSessionStoreId as storeId,
  mysqlSessionText as text, validateMysqlSessionPrefix as validatePrefix } from '@deepseek-ai/dsh-session-persistence-mysql'
import type { MysqlStoredSessionLog as StoredLog } from '@deepseek-ai/dsh-session-persistence-mysql'
import type { CheckpointRecord } from '@deepseek-ai/dsh-session-projection-cache'
import { captureRecord, decimal, increment, matches, projectionKey, ProjectionAdapterError } from './model.ts'
import type { ProjectionAdapterConfig } from './model.ts'

/** Trusted positional SQL; the protocol fixture independently models its tables and transaction acknowledgements. */
export const projectionSql = {
  keyMetadata: "SELECT CHARACTER_SET_NAME,COLLATION_NAME,CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dsh_projection_states' AND COLUMN_NAME='projection_key'",
  store: 'SELECT store_id,store_key FROM dsh_stores WHERE store_key=?',
  storeLock: 'SELECT store_id FROM dsh_stores WHERE store_id=? FOR UPDATE',
  slot: 'SELECT slot_id,external_session_id,current_lifecycle_id,current_format_version FROM dsh_session_slots WHERE store_id=? AND external_id_hash=UNHEX(SHA2(?,256)) FOR UPDATE',
  log: 'SELECT store_id,slot_id,lifecycle_id,format_version,log_state,IF(OCTET_LENGTH(CAST(header_json AS CHAR CHARACTER SET utf8mb4))<=?,CAST(header_json AS CHAR CHARACTER SET utf8mb4),NULL) AS header_json,inherited_event_count,event_count,log_revision FROM dsh_session_logs WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? FOR UPDATE',
  events: 'SELECT seq,OCTET_LENGTH(event_json) AS event_bytes FROM dsh_session_events WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND seq>=? AND seq<? ORDER BY seq LIMIT ?',
  eventValue: 'SELECT IF(OCTET_LENGTH(event_json)<=?,event_json,NULL) AS event_json FROM dsh_session_events WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND seq=?',
  head: 'SELECT cache_record_version,IF(OCTET_LENGTH(CAST(identity_json AS CHAR CHARACTER SET utf8mb4))<=?,CAST(identity_json AS CHAR CHARACTER SET utf8mb4),NULL) AS identity_json,checkpoint_revision,observed_log_revision,observed_event_count,unit_count FROM dsh_projection_checkpoints WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? FOR UPDATE',
  states: 'SELECT projection_key,state_version,last_seq,OCTET_LENGTH(CAST(state_json AS CHAR CHARACTER SET utf8mb4)) AS state_bytes FROM dsh_projection_states WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND (? IS NULL OR projection_key>?) ORDER BY projection_key LIMIT ?',
  stateValue: 'SELECT IF(OCTET_LENGTH(CAST(state_json AS CHAR CHARACTER SET utf8mb4))<=?,CAST(state_json AS CHAR CHARACTER SET utf8mb4),NULL) AS state_json FROM dsh_projection_states WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND projection_key=?',
  addHead: 'INSERT INTO dsh_projection_checkpoints (store_id,slot_id,lifecycle_id,format_version,cache_record_version,identity_json,checkpoint_revision,observed_log_revision,observed_event_count,unit_count) VALUES (?,?,?,?,7,?,?,?,?,?)',
  replaceHead: 'UPDATE dsh_projection_checkpoints SET cache_record_version=7,identity_json=?,checkpoint_revision=?,observed_log_revision=?,observed_event_count=?,unit_count=? WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND checkpoint_revision=?',
  clearStates: 'DELETE FROM dsh_projection_states WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=?',
  addState: 'INSERT INTO dsh_projection_states (store_id,slot_id,lifecycle_id,format_version,projection_key,state_version,last_seq,state_json) VALUES (?,?,?,?,?,?,?,?)',
} as const

/** One exact header CAS, including unreadable cache data that may be replaced by a rebuild. */
export interface CheckpointHead {
  readonly revision: string
  readonly observedRevision: string
  readonly eventCount: number
  readonly raw: MysqlRow
}

/** Private observation material; its lifecycle never comes from a caller-selected record identity. */
export interface ProjectionWitness {
  readonly log: StoredLog
  readonly revision: string | null
}

function only(result: MysqlResult): MysqlRow | undefined {
  const found = rows(result)
  if (found.length > 1) throw new ProjectionAdapterError('malformed-checkpoint')
  return found[0]
}
/** @param log - Private canonical identity. @returns Bound composite SQL key. */
export function keyOf(log: StoredLog) : readonly [StoredLog['storeId'], StoredLog['slotId'], StoredLog['lifecycle'], StoredLog['version']] { return [log.storeId, log.slotId, log.lifecycle, log.version] as const }

/** Verify an exact pre-provisioned namespace and projection-key column semantics; no schema changes are attempted.
 * @param tx - Existing consumer transaction executor.
 * @param config - Reviewed namespace and policy.
 * @returns The exact SQL store key.
 */
export async function initializeProjectionStore(tx: MysqlExecutor, config: ProjectionAdapterConfig): Promise<string> {
  const metadata = only(await tx.execute(projectionSql.keyMetadata, []))
  if (!metadata || metadata['CHARACTER_SET_NAME'] !== 'utf8mb4' || metadata['COLLATION_NAME'] !== 'utf8mb4_0900_bin'
    || Number(metadata['CHARACTER_MAXIMUM_LENGTH']) !== 191) throw new ProjectionAdapterError('configuration')
  const store = only(await tx.execute(projectionSql.store, [config.storeKey]))
  if (!store || text(store, 'store_key') !== config.storeKey) throw new ProjectionAdapterError('configuration')
  return storeId(store['store_id'])
}

/** Lock slot before log, matching the native writer's lock order and retaining exact external-id bytes.
 * @param tx - One transaction owner.
 * @param store - Verified namespace key.
 * @param id - Native external Session id.
 * @returns Only the active current generation; no unresolved slot, old format or sealed generation is used.
 */
export async function currentLog(tx: MysqlExecutor, store: string, id: SessionId, config: ProjectionAdapterConfig): Promise<StoredLog> {
  assertRepresentable(id)
  if (!id.length) throw new ProjectionAdapterError('missing-session')
  await tx.execute(projectionSql.storeLock, [store])
  const slot = only(await tx.execute(projectionSql.slot, [store, id]))
  if (!slot || slot['current_lifecycle_id'] === null || slot['current_format_version'] === null)
    throw new ProjectionAdapterError('missing-session')
  if (text(slot, 'external_session_id') !== id) throw new ProjectionAdapterError('identity-mismatch')
  const version = count(slot['current_format_version'])
  assertVersion({ id, version })
  const row = only(await tx.execute(projectionSql.log,
    [config.maxInputBytes, store, slotId(slot['slot_id']), binaryId(slot['current_lifecycle_id']), version]))
  if (!row || row['log_state'] !== 'active') throw new ProjectionAdapterError('missing-session')
  if (row['header_json'] === null) throw new ProjectionAdapterError('capacity')
  const log = decodeLog(row, id)
  if (log.storeId !== store || log.slotId !== slotId(slot['slot_id']) || log.version !== version
    || !log.lifecycle.equals(binaryId(slot['current_lifecycle_id']))) throw new ProjectionAdapterError('identity-mismatch')
  decimal(log.revision)
  return log
}

/** Read every event in the locked immutable prefix, reusing the actual kernel decoder and complete-prefix validator.
 * @param tx - Same transaction that locked the log metadata.
 * @param log - Canonical current generation.
 * @param config - Explicit event, full input-byte and pagination limits.
 * @returns Complete validated native events from seq 0, including empty-prefix support.
 */
export async function completePrefix(tx: MysqlExecutor, log: StoredLog, config: ProjectionAdapterConfig): Promise<SessionEvent[]> {
  if (log.eventCount > config.maxEvents) throw new ProjectionAdapterError('capacity')
  const events: SessionEvent[] = []
  let bytes = Buffer.byteLength(JSON.stringify(log.header)) + 2
  if (bytes > config.maxInputBytes) throw new ProjectionAdapterError('capacity')
  while (events.length < log.eventCount) {
    const page = rows(await tx.execute(projectionSql.events, [...keyOf(log), events.length, log.eventCount, config.readPageSize]))
    if (!page.length || page.length > config.readPageSize) throw new ProjectionAdapterError('malformed-checkpoint')
    for (const row of page) {
      const size = count(row['event_bytes'])
      if (bytes + size + (events.length > 0 ? 1 : 0) > config.maxInputBytes) throw new ProjectionAdapterError('capacity')
      const value = only(await tx.execute(projectionSql.eventValue, [size, ...keyOf(log), count(row['seq'])]))
      if (!value || value['event_json'] === null) throw new ProjectionAdapterError('capacity')
      const source = text(value, 'event_json')
      bytes += Buffer.byteLength(source) + (events.length > 0 ? 1 : 0)
      if (bytes > config.maxInputBytes) throw new ProjectionAdapterError('capacity')
      const event = decodeEvent(source)
      if (count(row['seq']) !== events.length || event.seq !== events.length || events.length >= log.eventCount)
        throw new ProjectionAdapterError('malformed-checkpoint')
      events.push(event)
    }
  }
  validatePrefix(log, events, true)
  return events
}

/** @param tx - Current locked generation transaction. @param log - Exact key. @returns Existing header and CAS, if any. */
export async function readHead(tx: MysqlExecutor, log: StoredLog, config: ProjectionAdapterConfig): Promise<CheckpointHead | undefined> {
  const row = only(await tx.execute(projectionSql.head, [config.maxCheckpointBytes, ...keyOf(log)]))
  if (!row) return undefined
  return { revision: decimal(row['checkpoint_revision']), observedRevision: decimal(row['observed_log_revision']),
    eventCount: count(row['observed_event_count']), raw: row }
}

/** Decode only structurally and identity-valid current cache rows; malformed derived values become a rebuildable miss.
 * @param tx - Same source-cut transaction.
 * @param log - Complete authoritative prefix metadata.
 * @param head - Original CAS retained even if the cache body is unusable.
 * @param config - Full checkpoint bounds.
 * @returns A whole current checkpoint, or undefined without modifying any table.
 */
export async function readCheckpoint(tx: MysqlExecutor, log: StoredLog, head: CheckpointHead | undefined,
  config: ProjectionAdapterConfig): Promise<CheckpointRecord | undefined> {
  if (!head || head.raw['cache_record_version'] !== 7 || head.eventCount > log.eventCount
    || BigInt(head.observedRevision) > BigInt(log.revision)) return undefined
  let units: number
  try { units = count(head.raw['unit_count']) } catch (_error) { return undefined }
  if (units > config.maxUnits || head.raw['identity_json'] === null) return undefined
  const stored: MysqlRow[] = []
  let after: string | null = null
  while (stored.length <= units) {
    const limit = Math.min(config.readPageSize, units + 1 - stored.length)
    const page = rows(await tx.execute(projectionSql.states, [...keyOf(log), after, after, limit]))
    if (page.length > limit) return undefined
    if (!page.length) break
    stored.push(...page)
    const last = page.at(-1)
    if (!last) return undefined
    after = text(last, 'projection_key')
    if (stored.length > units) return undefined
  }
  if (stored.length !== units) return undefined
  const metadata: Array<{ name: string; seq: number; size: number; ver: number }> = []
  try {
    const keys = new Set<string>()
    let bytes = Buffer.byteLength(text(head.raw, 'identity_json')) + 24
    for (const row of stored) {
      const name = projectionKey(row['projection_key']), seq = Number(row['last_seq']), size = count(row['state_bytes'])
      if (keys.has(name) || !Number.isSafeInteger(seq) || seq < -1 || seq >= head.eventCount) return undefined
      keys.add(name)
      bytes += size + Buffer.byteLength(JSON.stringify(name)) + 64
      if (bytes > config.maxCheckpointBytes) return undefined
      metadata.push({ name, seq, size, ver: count(row['state_version']) })
    }
  } catch (_error) { return undefined }
  const entries: Array<[string, { ver: number; seq: number; val: unknown }]> = []
  for (const { name, seq, size, ver } of metadata) {
    const result = only(await tx.execute(projectionSql.stateValue, [size, ...keyOf(log), name]))
    if (!result || result['state_json'] === null) return undefined
    let value: unknown
    try { value = JSON.parse(text(result, 'state_json')) } catch (_error) { return undefined }
    entries.push([name, { ver, seq: seq === -1 ? -1 : SessionSeq(seq), val: value }])
  }
  try {
    const identity: unknown = JSON.parse(text(head.raw, 'identity_json'))
    const candidate = { identity, rows: Object.fromEntries(entries) }
    return captureRecord(candidate, log, config)
  } catch (_error) { return undefined }
}

function one(result: MysqlResult): void {
  if (result.kind !== 'write' || result.affectedRows !== 1) throw new ProjectionAdapterError('checkpoint-conflict')
}

/** Replace the complete set of keys under one checked lifecycle, prefix and CAS; events are never mutated.
 * @param tx - One acknowledged consumer transaction.
 * @param store - Verified namespace key.
 * @param witness - Original adapter-owned source cut and checkpoint CAS.
 * @param value - Already detached and bounded whole internal checkpoint.
 * @returns New CAS only after the surrounding transaction receives its COMMIT acknowledgement.
 */
export async function replaceCheckpoint(tx: MysqlExecutor, store: string, witness: ProjectionWitness,
  value: CheckpointRecord, config: ProjectionAdapterConfig): Promise<string> {
  const log = await currentLog(tx, store, witness.log.id, config)
  if (log.storeId !== witness.log.storeId || log.slotId !== witness.log.slotId || log.version !== witness.log.version
    || !log.lifecycle.equals(witness.log.lifecycle) || !matches(value.identity, log)) throw new ProjectionAdapterError('identity-mismatch')
  if (log.eventCount < witness.log.eventCount || BigInt(log.revision) < BigInt(witness.log.revision))
    throw new ProjectionAdapterError('watermark-regression')
  const head = await readHead(tx, log, config)
  if ((head?.revision ?? null) !== witness.revision) throw new ProjectionAdapterError('checkpoint-conflict')
  if (head && (head.eventCount > witness.log.eventCount || BigInt(head.observedRevision) > BigInt(witness.log.revision)))
    throw new ProjectionAdapterError('watermark-regression')
  const revision = head ? increment(head.revision) : '1'
  const metadata = [JSON.stringify(value.identity), revision, witness.log.revision, witness.log.eventCount, Object.keys(value.rows).length]
  if (head) one(await tx.execute(projectionSql.replaceHead, [...metadata, ...keyOf(log), head.revision]))
  else one(await tx.execute(projectionSql.addHead, [...keyOf(log), ...metadata]))
  await tx.execute(projectionSql.clearStates, keyOf(log))
  for (const [key, row] of Object.entries(value.rows))
    one(await tx.execute(projectionSql.addState, [...keyOf(log), key, row.ver, row.seq, JSON.stringify(row.val)]))
  return revision
}
