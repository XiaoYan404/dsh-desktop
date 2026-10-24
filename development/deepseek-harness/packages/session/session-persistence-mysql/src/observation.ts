/** Provider-owned complete source cuts; callers keep the supplied transaction open for a bounded consistent export. */
import type { MysqlExecutor } from '@deepseek-ai/dsh-mysql'
import { SessionPersistenceNotFoundError, assertVersion } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { assertRepresentable, binaryId, count, corrupt, decodeEvent, decodeLog, rows, slotId, text, validatePrefix } from './records.ts'
import type { StoredLog } from './types.ts'

/** Explicit limits are checked on metadata before fetching JSON payloads from the driver. */
export interface MysqlSessionObservationPolicy {
  readonly storeKey: string
  readonly maxEvents: number
  readonly maxInputBytes: number
  readonly readPageSize: number
}
/** Full current canonical prefix and exact database identity; no opaque public revision is parsed. */
export interface MysqlSessionCut { readonly log: StoredLog; readonly events: readonly SessionEvent[] }

/** Read one complete validated current prefix under store→slot→log locks on the caller's transaction.
 * @param tx - Existing transaction-scoped executor; no transaction, lease, schema, receipt or authority writes occur here.
 * @param id - Exact external Session ID.
 * @param policy - Explicit namespace and allocation limits.
 * @returns Fixed lifecycle/format/revision/count and all native events, including exact seed metadata.
 * @throws On future formats, gaps, invalid vocabulary or capacity; the transaction owns rollback/release.
 */
export async function observeMysqlSessionCut(tx: MysqlExecutor, id: SessionId,
  policy: MysqlSessionObservationPolicy): Promise<MysqlSessionCut> {
  assertRepresentable(id)
  if (!id.length || !/^[\x21-\x7e]{1,128}$/u.test(policy.storeKey)
    || [policy.maxEvents, policy.maxInputBytes, policy.readPageSize].some(value => !Number.isSafeInteger(value) || value < 1)
    || policy.readPageSize > policy.maxEvents) throw new TypeError('Invalid MySQL Session observation policy.')
  const store = rows(await tx.execute('SELECT store_id,store_key FROM dsh_stores WHERE store_key=? FOR UPDATE', [policy.storeKey]))[0]
  if (!store || store['store_key'] !== policy.storeKey) throw new SessionPersistenceNotFoundError(id)
  const slot = rows(await tx.execute('SELECT slot_id,external_session_id,current_lifecycle_id,current_format_version FROM dsh_session_slots WHERE store_id=? AND external_id_hash=UNHEX(SHA2(?,256)) FOR UPDATE', [text(store, 'store_id'), id]))[0]
  if (!slot || slot['current_lifecycle_id'] === null || slot['current_format_version'] === null) throw new SessionPersistenceNotFoundError(id)
  if (slot['external_session_id'] !== id) throw corrupt('An observed Session slot hash differs from its exact identity.')
  const version = count(slot['current_format_version'])
  assertVersion({ id, version })
  const key = [text(store, 'store_id'), slotId(slot['slot_id']), binaryId(slot['current_lifecycle_id']), version] as const
  const row = rows(await tx.execute('SELECT store_id,slot_id,lifecycle_id,format_version,log_state,IF(OCTET_LENGTH(CAST(header_json AS CHAR CHARACTER SET utf8mb4))<=?,CAST(header_json AS CHAR CHARACTER SET utf8mb4),NULL) AS header_json,inherited_event_count,event_count,log_revision FROM dsh_session_logs WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? FOR UPDATE', [policy.maxInputBytes, ...key]))[0]
  if (!row || row['log_state'] !== 'active') throw new SessionPersistenceNotFoundError(id)
  if (row['header_json'] === null) throw new RangeError('The Session header exceeds the complete observation byte limit.')
  const log = decodeLog(row, id)
  if (log.eventCount > policy.maxEvents) throw new RangeError('The Session prefix exceeds the observation event limit.')
  let bytes = Buffer.byteLength(JSON.stringify(log.header)) + 2
  if (bytes > policy.maxInputBytes) throw new RangeError('The Session header exceeds the observation byte limit.')
  const events: SessionEvent[] = []
  while (events.length < log.eventCount) {
    const page = rows(await tx.execute('SELECT seq,OCTET_LENGTH(event_json) AS event_bytes FROM dsh_session_events WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND seq>=? AND seq<? ORDER BY seq LIMIT ?',
      [...key, events.length, log.eventCount, policy.readPageSize]))
    if (!page.length || page.length > policy.readPageSize) throw corrupt('The Session observation has a missing or oversized page.')
    for (const metadata of page) {
      const seq = count(metadata['seq']), size = count(metadata['event_bytes'])
      bytes += size + (events.length ? 1 : 0)
      if (bytes > policy.maxInputBytes) throw new RangeError('The Session prefix exceeds the complete observation byte limit.')
      if (seq !== events.length || seq >= log.eventCount) throw corrupt('The Session observation is not contiguous.')
      const body = rows(await tx.execute('SELECT IF(OCTET_LENGTH(event_json)<=?,event_json,NULL) AS event_json FROM dsh_session_events WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND seq=?', [size, ...key, seq]))[0]
      if (!body || body['event_json'] === null) throw corrupt('An observed immutable Session event changed or disappeared.')
      const source = text(body, 'event_json')
      if (Buffer.byteLength(source) !== size) throw corrupt('The observed Session event byte count differs.')
      const event = decodeEvent(source)
      if (event.seq !== seq) throw corrupt('The observed Session envelope has a different seq.')
      events.push(event)
    }
  }
  validatePrefix(log, events, true)
  return { log, events: Object.freeze(events) }
}
