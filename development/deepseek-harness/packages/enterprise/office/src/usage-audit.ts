/** Allowlisted external execution stages and provider-reported usage retain their original evidence coordinates. */
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import { collaborationCounter as counter, checkCollaborationCapacity, collaborationAdministrator } from './collaboration-access.ts'
import type { OfficeCollaborationAccess } from './collaboration-access.ts'
import type { OfficeCollaborationLimits } from './collaboration-types.ts'
import type { OfficeMemberId, OfficeMember, OfficeAuditRecord, OfficeMemberInvite } from './types.ts'

const usage = z.object({
  inputTokens: counter, outputTokens: counter, totalTokens: counter.optional(),
  cacheReadTokens: counter.optional(), cacheWriteTokens: counter.optional(), reasoningTokens: counter.optional(),
}).strict()
const observation = z.object({
  sessionId: z.string().min(1).max(128), seq: counter, memberId: officeMemberId, time: counter,
  kind: z.enum(['message', 'attempt']), usage: usage.nullable(), inherited: z.boolean(),
}).strict()
const state = z.object({ entries: z.array(observation).max(100000) }).strict().refine(value =>
  new Set(value.entries.map(entry => JSON.stringify([entry.sessionId, entry.seq]))).size === value.entries.length)
/** Dedicated usage metadata has no model text, request content, route credentials or price estimates. */
export const officeUsageDomain = defineDomain({
  name: 'enterprise_office_usage', version: 1,
  global: { schema: state, initial: { entries: [] } }, tables: {},
})
/** Trusted Session settlement coordinate; never admitted as a browser mutation. */
export type OfficeUsageObservation = z.infer<typeof observation>
/** Usage query and governance audit query share exact bounded time/member filters. */
export const officeUsageQuery = z.object({ memberId: officeMemberId.nullable(), since: counter, until: counter }).strict()
  .refine(value => value.since <= value.until)
/** One metadata row has a stable cross-source continuation key. */
export interface OfficeGovernanceAuditRow {
  readonly key: string
  readonly source: string
  readonly actorId: OfficeMemberId
  readonly targetId: string
  readonly action: string
  readonly time: number
  readonly decision: 'allowed' | 'denied' | 'reserved' | 'dispatched' | 'confirmed' | 'unknown' | 'cancelled'
}
/** Closed audit filters reject arbitrary diagnostics and embedded business data. */
export const officeGovernanceAuditQuery = z.object({
  limit: counter.min(1).max(100),
  before: z.object({ time: counter, key: z.string().min(1).max(250) }).strict().nullable(),
  actorId: officeMemberId.nullable(), targetId: z.string().min(1).max(128).nullable(),
  source: z.enum(['business', 'identity', 'organization', 'drive', 'integration', 'connection', 'request_denial',
    'execution', 'invitation', 'policy', 'group', 'usage']).nullable(),
  action: z.string().min(1).max(100).nullable(), since: counter, until: counter,
}).strict().refine(value => value.since <= value.until)
/** Existing connector evidence supplies stages without projecting its input values or result. */
export interface OfficeExecutionAuditInput {
  readonly id: string
  readonly memberId: OfficeMemberId
  readonly history: readonly {
    readonly stage: 'reserved' | 'dispatched' | 'succeeded' | 'rejected' | 'unknown' | 'cancelled'
    readonly at: number
  }[]
}

/** Provider counters are captured only from durable native Session settlements. */
export class OfficeUsageRepository {
  constructor(private readonly domain: Domain<typeof officeUsageDomain>, private readonly access: OfficeCollaborationAccess,
    private readonly limits: OfficeCollaborationLimits) { }
  /**
   * Reject a usage store detached from its retained employee directory.
   * @param members - Original directory, including offboarded employees.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    const current = this.domain.global.get()
    if(current.entries.some(entry => !ids.has(entry.memberId))) throw new OfficeError('conflict',
      'Usage requires its original employee directory')
    checkCollaborationCapacity(current, current.entries.length, this.limits)
  }
  /**
   * Capture one original Session event once; inherited fork-prefix events cannot double-count requests.
   * @param input - Trusted Session-derived observation with original provider counters or explicit absence.
   * @returns After durability; a changed event coordinate conflicts instead of replacing accounting.
   */
  capture(input: OfficeUsageObservation): Promise<void> {
    const value = observation.parse(input)
    return this.access.enqueue(async () => {
      if(!this.access.members().some(member => member.id === value.memberId)) throw new OfficeError('not_found',
        'Usage employee is unavailable')
      if(value.inherited) return
      const current = this.domain.global.get()
      const prior = current.entries.find(entry => entry.sessionId === value.sessionId && entry.seq === value.seq)
      if(prior) {
        if(JSON.stringify(prior) !== JSON.stringify(value)) throw new OfficeError('conflict', 'A settled usage coordinate changed')
        return
      }
      const next = { entries: [...current.entries, value] }
      checkCollaborationCapacity(next, next.entries.length, this.limits)
      await this.domain.global.set(next)
    })
  }
  /**
   * Sum only provider-reported disjoint counters, exposing missing coverage and absent optional counters.
   * @param actorId - Current active administrator; rechecked for every query/export.
   * @param input - Explicit retained-time range and optional employee selection.
   * @returns Actual captured token accounting, never inferred monetary cost or a full-log coverage claim.
   */
  summary(actorId: OfficeMemberId, input: z.input<typeof officeUsageQuery>) : {
        coverage: "captured_settlements";
        settlements: number;
        withUsage: number;
        missingUsage: number;
        attempts: number;
        counters: {
            [k: string]: {
                value: number | null;
                reported: number;
            };
        };
        cost: null;
    } {
    collaborationAdministrator(this.access, actorId)
    const query = officeUsageQuery.parse(input)
    const entries = this.domain.global.get().entries.filter(entry => entry.time >= query.since && entry.time <= query.until
      && (query.memberId === null || entry.memberId === query.memberId))
    const known = entries.flatMap(entry => entry.usage === null ? [] : [entry.usage])
    const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
    const counters = Object.fromEntries(fields.map((field) => {
      const reported = known.flatMap(entry => entry[field] === undefined ? [] : [entry[field]])
      let total = 0
      for(const value of reported) {
        total += value
        if(!Number.isSafeInteger(total)) throw new OfficeError('context_too_large', 'Usage total exceeds exact integer capacity')
      }
      return [field, { value: reported.length ? total : null, reported: reported.length }]
    }))
    return {
      coverage: 'captured_settlements' as const, settlements: entries.length, withUsage: known.length,
      missingUsage: entries.length - known.length, attempts: entries.filter(entry => entry.kind === 'attempt').length,
      counters, cost: null,
    }
  }
  /**
   * Project safe usage audit metadata after administrator authorization.
   * @param actorId - Current administrator.
   * @returns Metadata only; summaries retain the actual numeric counters.
   */
  audit(actorId: OfficeMemberId): readonly OfficeGovernanceAuditRow[] {
    collaborationAdministrator(this.access, actorId)
    return this.domain.global.get().entries.map(entry => ({
      key: `usage:${entry.sessionId}:${entry.seq}`, source: 'usage',
      actorId: entry.memberId, targetId: entry.sessionId, action: entry.usage === null ? 'usage_unreported' : 'usage_reported',
      time: entry.time, decision: 'confirmed',
    }))
  }
}
/**
 * Project original external intent and stage histories with safe stage labels.
 * @param entries - Original connector ledger records; only declared metadata is copied.
 * @returns Stage rows; dispatch is an attempt and remains distinct from confirmed success.
 */
export function projectOfficeExecutionAudit(entries: readonly OfficeExecutionAuditInput[]): readonly OfficeGovernanceAuditRow[] {
  return entries.flatMap(entry => entry.history.map((stage, index) => ({
    key: `execution:${entry.id}:${index}`,
    source: 'execution', actorId: entry.memberId, targetId: entry.id, action: `execution_${stage.stage}`, time: stage.at,
    decision: stage.stage === 'succeeded' ? 'confirmed' as const : stage.stage === 'rejected' ? 'denied' as const : stage.stage,
  })))
}
/**
 * Include invitation issuance and revocation without codes, hashes or an invented acceptance time.
 * @param entries - Credential-free original invitation metadata.
 * @returns Durable issuance/revocation rows attributed to their actual administrator.
 */
export function projectOfficeInvitationAudit(entries: readonly OfficeMemberInvite[]): readonly OfficeGovernanceAuditRow[] {
  return entries.flatMap(entry => [
    {
      key: `invitation:${entry.id}:issued`, source: 'invitation', actorId: entry.issuedBy, targetId: entry.memberId,
      action: 'invitation_issued', time: entry.issuedAt, decision: 'allowed' as const,
    },
    ...entry.revokedAt === null || entry.revokedBy === null ? [] : [{
      key: `invitation:${entry.id}:revoked`, source: 'invitation',
      actorId: entry.revokedBy, targetId: entry.memberId, action: 'invitation_revoked', time: entry.revokedAt, decision:
        'confirmed' as const,
    }],
  ])
}
/**
 * Convert the original seven-source allowlisted records without copying optional arbitrary fields.
 * @param records - Existing safe audit projections.
 * @returns Stable extension rows suitable for the combined administrator view.
 */
export function projectOriginalOfficeAudit(records: readonly OfficeAuditRecord[]): readonly OfficeGovernanceAuditRow[] {
  return records.map(entry => ({
    key: `${entry.source}:${entry.revision}`, source: entry.source, actorId: entry.actorId,
    targetId: entry.targetId, action: entry.action, time: entry.time, decision: entry.source === 'request_denial' ? 'denied' :
      'allowed',
  }))
}
/**
 * Page and export safe cross-source rows; the caller reauthorizes at every invocation.
 * @param rows - Current allowlisted projection from the authoritative domains.
 * @param input - Exact bounded filters and exclusive continuation.
 * @returns Sorted metadata, stable continuation and exact NDJSON bytes for this batch.
 */
export function queryOfficeGovernanceAudit(rows: readonly OfficeGovernanceAuditRow[], input:
z.input<typeof officeGovernanceAuditQuery>) : {
    entries: {
        key: string;
        source: string;
        actorId: OfficeMemberId;
        targetId: string;
        action: string;
        time: number;
        decision: "unknown" | "allowed" | "denied" | "reserved" | "dispatched" | "confirmed" | "cancelled";
    }[];
    total: number;
    next: {
        time: number;
        key: string;
    } | null;
    mediaType: "application/x-ndjson";
    content: string;
} {
  const query = officeGovernanceAuditQuery.parse(input)
  const filtered = rows.filter(row => row.time >= query.since && row.time <= query.until
    && (query.source === null || row.source === query.source) && (query.actorId === null || row.actorId === query.actorId)
    && (query.targetId === null || row.targetId === query.targetId) && (query.action === null || row.action === query.action))
    .sort((a, b) => b.time - a.time || compare(a.key, b.key))
  const before = query.before
  const remaining = before === null ? filtered : filtered.filter(row => row.time < before.time || row.time === before.time &&
    compare(row.key, before.key) > 0)
  const entries = remaining.slice(0, query.limit).map(row => ({
    key: row.key, source: row.source, actorId: row.actorId,
    targetId: row.targetId, action: row.action, time: row.time, decision: row.decision,
  }))
  const last = entries.at(-1)
  return {
    entries, total: filtered.length, next: remaining.length > entries.length && last ? { time: last.time, key: last.key } :
      null,
    mediaType: 'application/x-ndjson' as const, content: entries.map(entry => JSON.stringify(entry) + '\n').join(''),
  }
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
