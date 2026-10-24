/** Audit browsers share local-field validation; each service adapter resolves its own defaults and cursor. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'

/** Blank fields omit exact filters; datetime controls use this device's local timezone. */
export interface OfficeAuditFilters {
  readonly source: string
  readonly actorId: string
  readonly targetId: string
  readonly action: string
  readonly since: string
  readonly until: string
}

/**
 * Resolve local form fields without inventing timestamps or accepting sources outside the owning service.
 * @param fields - Current reviewed text from the audit form.
 * @param sources - Exact supported source names owned by the service adapter.
 * @returns Validated nullable filters, or null when a field needs correction before any request.
 */
export function readOfficeAuditFields<S extends string>(fields: OfficeAuditFilters, sources: readonly S[]): {
  source: S | null
  actorId: OfficeMemberId | null
  targetId: string | null
  action: string | null
  since: number | null
  until: number | null
} | null {
  const source = sources.find(value => value === fields.source)
  const actorId = fields.actorId.trim()
  const targetId = fields.targetId.trim()
  const action = fields.action.trim()
  const since = fields.since ? new Date(fields.since).getTime() : null
  const until = fields.until ? new Date(fields.until).getTime() : null
  if((fields.source && !source) || (actorId && !/^[a-zA-Z0-9_-]{1,128}$/u.test(actorId)) ||
    targetId.length > 128 || action.length > 100 ||
    (since !== null && (!Number.isSafeInteger(since) || since < 0)) ||
    (until !== null && (!Number.isSafeInteger(until) || until < 0)) ||
    (since !== null && until !== null && since > until)) return null
  return { source: source ?? null, actorId: actorId ? brandString<OfficeMemberId>(actorId) : null,
    targetId: targetId || null, action: action || null, since, until }
}
