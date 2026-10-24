/** Lossless logical Session records remain independent of MySQL's derived columns and physical codecs. */
import { createHash, randomBytes } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  assertVersion, materializeAppendBatch, materializeCreateHeader, validateStoredEvents,
  SessionFormatUnsupportedError, SessionPersistenceCorruptionError,
} from '@deepseek-ai/dsh-session-persistence'
import { isSessionFormatJsonObject, snapshotSessionFormatJson, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import type { MysqlResult, MysqlRow } from '@deepseek-ai/dsh-mysql'
import type { FrozenBatch, SlotId, StoredLog, StoreId } from './types.ts'

/** Reject values utf8mb4 cannot represent without silently changing native identities or payloads.
 * @param value - Detached lossless JSON or identity text.
 */
export function assertRepresentable(value: unknown): void {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const item = pending.pop()
    if (typeof item === 'string' && Buffer.from(item, 'utf8').toString('utf8') !== item) {
      throw new TypeError('R7 MySQL requires well-formed Unicode. The original value was retained; no replacement was stored.')
    }
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        pending.push(key, child)
      }
    }
  }
}

/** Admit one row set from a database response.
 * @param result - Prepared statement result.
 * @returns Rows without coercing their unknown column values.
 */
export function rows(result: MysqlResult): readonly MysqlRow[] {
  if (result.kind !== 'rows') throw corrupt('Session metadata query returned no rows.')
  return result.rows
}

/** Classify damaged persisted metadata without exposing SQL or data values.
 * @param message - Provider-owned diagnostic.
 * @returns A native persistence corruption error.
 */
export function corrupt(message: string): SessionPersistenceCorruptionError {
  return new SessionPersistenceCorruptionError(message, { cause: new Error('R7 Session record validation failed') })
}

/** Read an exact database text field.
 * @param row - Untrusted database record.
 * @param key - Column name.
 * @returns Its string value, including empty text when the column allows it.
 */
export function text(row: MysqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw corrupt('A Session database text field is invalid.')
  return value
}

/** Admit a business counter after checking the JavaScript safe-integer bound.
 * @param value - Database numeric value.
 * @returns A non-negative safe integer.
 */
export function count(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw corrupt('A Session database counter is invalid.')
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || Object.is(number, -0)) throw corrupt('A Session database counter is unsafe.')
  return number
}

/** Read a fixed-width binary database identity.
 * @param value - Database column.
 * @returns A detached sixteen-byte identity.
 */
export function binaryId(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16) throw corrupt('A Session database lifecycle or owner is invalid.')
  return Buffer.from(value)
}

/** Admit an exact internal SQL key without number conversion.
 * @param value - mysql2 BIGINT column.
 * @returns Branded store key text.
 */
export function storeId(value: unknown): StoreId {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw corrupt('A Session store key is invalid.')
  return brandString<StoreId>(value)
}

/** Admit an exact internal slot key without number conversion.
 * @param value - mysql2 BIGINT column.
 * @returns Branded slot key text.
 */
export function slotId(value: unknown): SlotId {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw corrupt('A Session slot key is invalid.')
  return brandString<SlotId>(value)
}

/** Validate current header metadata while preserving absent optional fields in the stored JSON.
 * @param source - Native creation header.
 * @returns Detached header with its original optional-field presence.
 */
export function creationHeader(source: SessionHeader): SessionHeader {
  const header = materializeCreateHeader(source)
  assertVersion(header)
  if (!header.id.length) throw new TypeError('A MySQL Session id must not be empty.')
  assertRepresentable(header)
  sessionFormatCatalog.readHeader({ type: 'session', ...header, delegationDepth: header.delegationDepth ?? 0 })
  return header
}

/** Decode header JSON from durable storage, refusing a future generation before current-field validation.
 * @param raw - JSON text returned with mysql2 jsonStrings enabled.
 * @param expectedId - Original external Session identity.
 * @returns Current logical metadata.
 */
export function storedHeader(raw: string, expectedId: SessionId): SessionHeader {
  const value: unknown = JSON.parse(raw)
  if (!isSessionFormatJsonObject(value) || typeof value['version'] !== 'number') throw corrupt('A stored Session header is invalid.')
  assertVersion({ id: expectedId, version: value['version'] })
  if (value['id'] !== expectedId || typeof value['createdAt'] !== 'number' || typeof value['isSeeded'] !== 'boolean') {
    throw corrupt('A stored Session header does not match its identity.')
  }
  sessionFormatCatalog.readHeader({ type: 'session', ...value, delegationDepth: value['delegationDepth'] ?? 0 })
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION, id: expectedId, createdAt: value['createdAt'], isSeeded: value['isSeeded'],
    ...(typeof value['cwd'] === 'string' ? { cwd: value['cwd'] } : {}),
    ...(typeof value['parentSession'] === 'string' ? { parentSession: SessionId(value['parentSession']) } : {}),
    ...(value['origin'] === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(typeof value['delegationDepth'] === 'number' ? { delegationDepth: value['delegationDepth'] } : {}),
    ...(typeof value['agentPreset'] === 'string' ? { agentPreset: value['agentPreset'] } : {}),
  }
  return creationHeader(header)
}

/** Prepare one immutable append identity; serializing each detached event once also builds R7's exact array hash.
 * @param events - Native logical events in order.
 * @returns The frozen batch, or undefined for an empty append.
 */
export function freezeBatch(events: readonly SessionEvent[]): FrozenBatch | undefined {
  const snapshot = materializeAppendBatch(events)
  if (snapshot.length === 0) return undefined
  assertRepresentable(snapshot)
  for (const event of snapshot) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(event.time) || event.time < 0) {
      throw new TypeError('R7 event seq and time must be non-negative safe integers; the original event was not changed.')
    }
  }
  const eventTexts = snapshot.map(event => JSON.stringify(event))
  const first = snapshot[0]
  if (!first) throw new TypeError('A nonempty Session batch has no first event.')
  return { batchId: randomBytes(16), events: snapshot, eventTexts, firstSeq: first.seq,
    sha256: createHash('sha256').update('[' + eventTexts.join(',') + ']', 'utf8').digest() }
}

function isNativeEvent(value: unknown): value is SessionEvent {
  return isSessionFormatJsonObject(value) && typeof value['type'] === 'string' && typeof value['seq'] === 'number'
    && typeof value['time'] === 'number' && value['data'] !== undefined
}

/** Decode an original logical event text; full native validation follows on the complete prefix.
 * @param source - Stored event_json.
 * @returns An owned event candidate.
 */
export function decodeEvent(source: string): SessionEvent {
  const value = snapshotSessionFormatJson(JSON.parse(source))
  if (!isNativeEvent(value)) throw corrupt('A stored Session event envelope is invalid.')
  return value
}

function formatEvent(source: string): SessionFormatEvent {
  const value = snapshotSessionFormatJson(JSON.parse(source))
  if (!isSessionFormatJsonObject(value) || typeof value['type'] !== 'string' || typeof value['seq'] !== 'number'
    || typeof value['time'] !== 'number' || value['data'] === undefined) throw corrupt('A Session format event is invalid.')
  return { ...value, type: value['type'], seq: value['seq'], time: value['time'], data: value['data'] }
}

/** Validate a complete current prefix without changing logical payloads or treating unknown records as supported.
 * @param log - Fixed generation and metadata.
 * @param events - Exclusively owned logical events.
 * @param reading - Reads refuse unknown required vocabulary; typed appends retain the shared append permissiveness.
 */
export function validatePrefix(log: Pick<StoredLog, 'header' | 'inheritedEventCount'>,
  events: SessionEvent[], reading: boolean): void {
  try {
    if (reading) validateStoredEvents(log.header, events)
    const unknownRequired = events.some(event => !KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true)
    if (unknownRequired && !reading) {
      Session.fromRestore(log.header.id, events, log.header, log.inheritedEventCount, 'detached', currentSessionMessageProjections)
      return
    }
    const restore = sessionFormatCatalog.createRestore(
      { type: 'session', ...log.header, delegationDepth: log.header.delegationDepth ?? 0 },
      { recovery: 'strict', validation: 'current' })
    for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(formatEvent(JSON.stringify(event))))
    const artifact = restore.finish()
    if (artifact.inheritedEventCount !== log.inheritedEventCount) throw corrupt('The stored Session inherited cut disagrees with its events.')
  } catch (error) {
    if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) throw error
    if (error instanceof SessionFormatUnsupportedMigrationError) throw new SessionFormatUnsupportedError(error.message)
    if (!reading) throw error
    throw new SessionPersistenceCorruptionError('The stored MySQL Session prefix failed native validation.', { cause: error })
  }
}

/** Decode the authoritative log header and counters selected under one database snapshot.
 * @param row - dsh_session_logs fields plus the external id and store/slot keys.
 * @param id - Original requested Session id.
 * @returns Validated fixed-generation metadata.
 */
export function decodeLog(row: MysqlRow, id: SessionId): StoredLog {
  const version = count(row['format_version'])
  assertVersion({ id, version })
  if (row['log_state'] !== 'active' && row['log_state'] !== 'sealed') throw corrupt('The Session log is not published or is quarantined.')
  const header = storedHeader(text(row, 'header_json'), id)
  const inheritedEventCount = SessionLogOffset(count(row['inherited_event_count']))
  const eventCount = count(row['event_count'])
  if (inheritedEventCount > eventCount || (!header.isSeeded && inheritedEventCount !== 0)) throw corrupt('The Session inherited cut is invalid.')
  return { id, storeId: storeId(row['store_id']), slotId: slotId(row['slot_id']), lifecycle: binaryId(row['lifecycle_id']),
    version, header, inheritedEventCount, eventCount, revision: text(row, 'log_revision') }
}
