/** Combined metadata browsing reuses the original audit fields and never exports unreviewed response text. */
import { readOfficeAuditFields } from './audit-filter-fields.ts'
import type { OfficeAuditFilters } from './audit-filter-fields.ts'
import type OfficeService from '@deepseek-ai/dsh-enterprise-office'

/** Existing server operation supplies the complete query and page types. */
export type CollaborationAuditQuery = Parameters<OfficeService['governanceAudit']>[1]
/** One already authorized server page; content is not a second export authority. */
export type CollaborationAuditPage = ReturnType<OfficeService['governanceAudit']>
/** Downloadable allowlisted rows after every displayed record has been reauthorized. */
export interface CollaborationAuditFile {
  readonly content: string
  readonly mediaType: 'application/x-ndjson'
}

/** Sources use the existing server query discriminants, without creating new ledgers. */
export const collaborationAuditSources = ['business', 'identity', 'organization', 'drive', 'integration', 'connection',
  'request_denial', 'execution', 'invitation', 'policy', 'group', 'usage'] as const

/** @returns A fresh private filter form without shared mutable defaults. */
export function emptyAuditFields(): OfficeAuditFilters {
  return { source: '', actorId: '', targetId: '', action: '', since: '', until: '' }
}

/** @param fields - Reviewed device-local form values. @returns First bounded query, or null for invalid fields. */
export function collaborationAuditQuery(fields: OfficeAuditFilters): CollaborationAuditQuery | null {
  const resolved = readOfficeAuditFields(fields, collaborationAuditSources)
  return resolved ? { ...resolved, since: resolved.since ?? 0, until: resolved.until ?? Number.MAX_SAFE_INTEGER,
    limit: 50, before: null } : null
}

/**
 * Reject repeated, unordered or nonadvancing pages before exposing continuation controls.
 * @param page - Current generated Remote page.
 * @param query - Exact query used for this batch.
 * @param previous - Existing rows only when loading an older continuation.
 * @returns Whether the page preserves unique descending-time, ascending-key pagination.
 */
export function consistentAuditPage(page: CollaborationAuditPage, query: CollaborationAuditQuery,
  previous: CollaborationAuditPage['entries'] = []): boolean {
  const rows = [...previous, ...page.entries]
  if(page.entries.length > query.limit || new Set(rows.map(row => row.key)).size !== rows.length) return false
  for(const [index, row] of rows.entries()) {
    const prior = rows[index - 1]
    if(prior && (row.time > prior.time || row.time === prior.time && row.key <= prior.key)) return false
  }
  const before = query.before
  if(before && page.entries.some(row => row.time > before.time || row.time === before.time && row.key <= before.key)) return false
  const last = page.entries.at(-1)
  return page.next === null || !!last && page.next.time === last.time && page.next.key === last.key
}

/**
 * Compare every displayed metadata field with its fresh authorized result before a download can be dispatched.
 * @param rows - Reauthorized bounded batch.
 * @param expected - Exact displayed rows for that position.
 * @returns Whether all displayed values remain current; changed data requires a new search.
 */
export function sameAuditRows(rows: CollaborationAuditPage['entries'], expected: CollaborationAuditPage['entries']): boolean {
  return rows.length === expected.length && rows.every((row, index) => {
    const original = expected[index]
    return original && row.key === original.key && row.source === original.source && row.actorId === original.actorId &&
      row.targetId === original.targetId && row.action === original.action && row.time === original.time &&
      row.decision === original.decision
  })
}

/** @param rows - Reauthorized displayed metadata only. @returns NDJSON file with exactly the seven supported metadata fields. */
export function auditMetadataFile(rows: CollaborationAuditPage['entries']): CollaborationAuditFile {
  return { mediaType: 'application/x-ndjson', content: rows.map(row => JSON.stringify({ key: row.key, source: row.source,
    actorId: row.actorId, targetId: row.targetId, action: row.action, time: row.time, decision: row.decision }) + '\n').join('') }
}
