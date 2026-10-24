/** Administrator searches project existing durable histories without returning stored business or credential fields. */
import { z } from 'zod'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type { OfficeAuditCursor, OfficeAuditPage, OfficeAuditQuery, OfficeAuditRecord, OfficeAuditSource,
  OfficeMemberId } from './types.ts'

const source = z.enum(['business', 'identity', 'organization', 'drive', 'integration', 'connection', 'request_denial'])
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const position = z.object({ time: timestamp, source,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()

/** Shared wire and Host validation for bounded audit reads and exports. */
export const officeAuditQuery = z.object({
  limit: z.number().int().min(1).max(100),
  before: position.nullable(),
  source: source.optional(),
  actorId: officeMemberId.optional(),
  targetId: z.string().min(1).max(128).optional(),
  action: z.string().min(1).max(100).optional(),
  since: timestamp.optional(),
  until: timestamp.optional(),
}).strict().refine(value => value.since === undefined || value.until === undefined || value.since <= value.until)

interface AuditMetadata {
  readonly revision: number
  readonly actorId: OfficeMemberId
  readonly targetId: string
  readonly time: number
}
interface OperationMetadata extends AuditMetadata {
  readonly action: string
}
interface AuditHistories {
  readonly business: readonly OperationMetadata[]
  readonly identity: readonly OperationMetadata[]
  readonly organization: readonly OperationMetadata[]
  readonly drive: readonly OperationMetadata[]
  readonly integration: readonly AuditMetadata[]
  readonly connection: readonly {
    readonly revision: number
    readonly actorId: OfficeMemberId
    readonly integrationId: string
    readonly time: number
  }[]
  readonly requestDenials: readonly (OperationMetadata & {
    readonly code: NonNullable<OfficeAuditRecord['denialCode']>
  })[]
}

function compare(left: OfficeAuditCursor, right: OfficeAuditCursor): number {
  return right.time - left.time || (left.source < right.source ? -1 : left.source > right.source ? 1 : 0) ||
    right.revision - left.revision
}

/**
 * Read one bounded page from synchronous committed histories after administrator authorization.
 * @param histories - Current operation and request-denial metadata; only named record fields are copied.
 * @param input - Exact filters and an exclusive continuation, without hidden defaults.
 * @returns New metadata objects in timestamp/source/revision order; no persistence state is exposed.
 */
export function queryOfficeAudit(histories: AuditHistories, input: OfficeAuditQuery): OfficeAuditPage {
  const parsed = officeAuditQuery.safeParse(input)
  if (!parsed.success) throw new OfficeError('invalid_input', 'Audit filters or page position are invalid')
  const query = parsed.data
  const records: OfficeAuditRecord[] = []
  const append = (source: OfficeAuditSource, entry: AuditMetadata, action: string,
    denialCode?: OfficeAuditRecord['denialCode']) => {
    if ((query.source !== undefined && source !== query.source) ||
      (query.actorId !== undefined && entry.actorId !== query.actorId) ||
      (query.targetId !== undefined && entry.targetId !== query.targetId) ||
      (query.action !== undefined && action !== query.action) ||
      (query.since !== undefined && entry.time < query.since) ||
      (query.until !== undefined && entry.time > query.until)) return
    records.push({ source, revision: entry.revision, actorId: entry.actorId,
      action, targetId: entry.targetId, time: entry.time, ...denialCode === undefined ? {} : { denialCode } })
  }
  for (const source of ['business', 'identity', 'organization', 'drive'] as const)
    for (const entry of histories[source]) append(source, entry, entry.action)
  for (const entry of histories.integration) append('integration', entry, 'integration_imported')
  for (const entry of histories.connection)
    append('connection', { revision: entry.revision, actorId: entry.actorId,
      targetId: entry.integrationId, time: entry.time }, 'connection_saved')
  for (const entry of histories.requestDenials) append('request_denial', entry, entry.action, entry.code)
  records.sort(compare)
  const before = query.before
  const older = before === null ? records : records.filter(entry => compare(entry, before) > 0)
  const entries = older.slice(0, query.limit)
  const last = entries.at(-1)
  return { entries, total: records.length, next: older.length > entries.length && last ?
    { time: last.time, source: last.source, revision: last.revision } : null }
}
