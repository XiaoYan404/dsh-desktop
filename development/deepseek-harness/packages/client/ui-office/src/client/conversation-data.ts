/** Browser navigation records contain identities only; native Sessions own prompts, attachments and history. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Read-only predecessor retained during the IndexedDB migration. */
export const OFFICE_NAVIGATION_LEGACY_KEY = 'dsh.office.conversations.v1'
/** Same-origin transactional database for office navigation. */
export const OFFICE_NAVIGATION_DATABASE = 'dsh.office.conversations.v2'
/** Small committed-revision notification; it contains no Conversation content. */
export const OFFICE_NAVIGATION_SIGNAL_KEY = 'dsh.office.conversations.v2.changed'

/** One employee's recorded use of an existing native input. */
export interface OfficeNavigationEntry {
  readonly principal: string
  readonly sessionId: SessionId
  readonly kind: 'ordinary' | 'item'
}

/** Employee return targets and immutable Session classifications. */
export interface OfficeNavigationData {
  readonly entries: readonly OfficeNavigationEntry[]
  readonly ordinary: Readonly<Record<string, SessionId>>
}

/** One completely committed navigation generation. */
export interface OfficeNavigationRecord {
  readonly formatVersion: 1
  readonly revision: number
  readonly data: OfficeNavigationData
}

/**
 * Validate the predecessor's identity-only data without changing its accepted ids.
 * @param value - Browser storage or structured-clone value.
 * @returns Validated navigation with own-property dictionaries.
 */
export function parseOfficeNavigationData(value: unknown): OfficeNavigationData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid office conversation navigation')
  const data = value as Record<string, unknown>
  if (!Array.isArray(data.entries) || data.entries.length > 2000 || !data.ordinary ||
    typeof data.ordinary !== 'object' || Array.isArray(data.ordinary)) throw new Error('Invalid office conversation navigation')
  const entries: OfficeNavigationEntry[] = []
  const seen = new Set<string>()
  for (const value of data.entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid office conversation entry')
    const entry = value as Record<string, unknown>
    if (typeof entry.principal !== 'string' || !entry.principal || typeof entry.sessionId !== 'string' || !entry.sessionId ||
      (entry.kind !== 'ordinary' && entry.kind !== 'item') || seen.has(entry.sessionId)) throw new Error('Invalid office conversation entry')
    seen.add(entry.sessionId)
    entries.push({ principal: entry.principal, sessionId: entry.sessionId as SessionId, kind: entry.kind })
  }
  const ordinary = Object.fromEntries(Object.entries(data.ordinary).map(([principal, id]) => {
    if (typeof id !== 'string' || !entries.some(entry =>
      entry.principal === principal && entry.sessionId === id && entry.kind === 'ordinary')) {
      throw new Error('Invalid ordinary conversation target')
    }
    return [principal, id as SessionId]
  }))
  return { entries, ordinary }
}

/**
 * Read the durable generation; a missing or unsupported record is never an empty database.
 * @param value - IndexedDB record loaded from the initialized object store.
 * @returns Validated generation.
 */
export function parseOfficeNavigationRecord(value: unknown): OfficeNavigationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid office navigation record')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['formatVersion', 'revision', 'data'].includes(key)) ||
    record.formatVersion !== 1 || typeof record.revision !== 'number' ||
    !Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error('Invalid office navigation record')
  return { formatVersion: 1, revision: record.revision, data: parseOfficeNavigationData(record.data) }
}

/**
 * Import the predecessor only while creating a new database.
 * @returns Existing identities, or an empty first-use record.
 */
export function legacyOfficeNavigation(): OfficeNavigationData {
  const saved = localStorage.getItem(OFFICE_NAVIGATION_LEGACY_KEY)
  if (saved === null) return { entries: [], ordinary: {} }
  const value: unknown = JSON.parse(saved)
  return parseOfficeNavigationData(value)
}
