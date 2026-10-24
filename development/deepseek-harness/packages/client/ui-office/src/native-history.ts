/** Employee Host fold retains office affiliation across compaction, resume and tool-plugin reload. */
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { OfficeMemberId, OfficeRole } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeRunClaims, type OfficeRunClaim } from './native-claims.ts'

/** Derived restriction evidence; the live authenticated connection remains authoritative. */
export interface OfficeRunHistoryState {
  readonly owner: { readonly memberId: OfficeMemberId; readonly role: OfficeRole } | null
  readonly mixed: boolean
  readonly invalid: boolean
  /** Present only after this log has committed its own required inheritance record. */
  readonly inherited?: true | undefined
  /** The current role was first seen in pending input and has not yet been claimed or inherited. */
  readonly pendingRole?: true | undefined
}

/** Logged child affiliation restricts later work; it grants no tool or employee authority. */
export interface OfficeRunInheritance {
  readonly parentSession: SessionId
  readonly owner: NonNullable<OfficeRunHistoryState['owner']>
  readonly mixed: boolean
  readonly invalid: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Pins a child's inherited employee at creation, before it can accept work.
     * Log-only restriction evidence; no model surface or authorization grant.
     * Readers that do not recognize this required event must refuse the log.
     */
    'office/run-inherited': OfficeRunInheritance
  }
}

const officeRunIdentitySchema = z.object({
  memberId: z.string().min(1).max(512).transform(value => value as OfficeMemberId),
  role: z.enum(['employee', 'manager', 'admin']),
}).strict()

/** Validated cache state; malformed or incompatible checkpoints are discarded by the projection owner. */
export const officeRunHistorySchema = z.object({
  owner: officeRunIdentitySchema.nullable(),
  mixed: z.boolean(), invalid: z.boolean(),
  inherited: z.literal(true).optional(),
  pendingRole: z.literal(true).optional(),
}).strict().refine(value => value.owner !== null || !value.mixed && !value.invalid && !value.inherited && !value.pendingRole,
  'An empty office history cannot have an ownership conflict')

const officeRunInheritanceSchema = z.object({
  parentSession: z.string().min(1).max(512), owner: officeRunIdentitySchema,
  mixed: z.boolean(), invalid: z.boolean(),
}).strict()

/**
 * Restore one child affiliation without replacing earlier employee or role evidence.
 * @param state - Restrictions established by preceding records.
 * @param input - Stored inheritance payload, validated before use.
 * @returns Next restriction state; malformed records fail instead of clearing ownership.
 */
export function foldOfficeRunInheritance(state: OfficeRunHistoryState, input: unknown): OfficeRunHistoryState {
  const inherited = officeRunInheritanceSchema.parse(input)
  const folded = foldOfficeRunHistory(state, [{ ...inherited.owner, matchesConversation: true }], false)
  const mixed = folded.mixed || inherited.mixed
  const invalid = folded.invalid || inherited.invalid
  const owner = folded.pendingRole && folded.owner?.memberId === inherited.owner.memberId ? inherited.owner : folded.owner
  if (folded.mixed === mixed && folded.invalid === invalid && folded.inherited && !folded.pendingRole) return folded
  const { pendingRole: _pendingRole, ...retained } = folded
  return { ...retained, owner, mixed, invalid, inherited: true }
}

/**
 * Fold one admitted or claimed input without letting a future queued role authorize current work.
 * @param state - Restriction evidence over the preceding log.
 * @param claims - Descriptive identities in one input.
 * @param claimed - True only when the input entered the conversation, rather than its pending queue.
 * @returns Original state when unchanged, otherwise the next restriction evidence.
 */
export function foldOfficeRunHistory(state: OfficeRunHistoryState, claims: readonly OfficeRunClaim[],
  claimed: boolean): OfficeRunHistoryState {
  const first = claims[0]
  if (!first) return state
  const memberId = state.owner?.memberId ?? first.memberId
  const role = claimed && first.memberId === memberId ? first.role : state.owner?.role ?? first.role
  const mixed = state.mixed || claims.some(claim => claim.memberId !== memberId)
  const invalid = claimed || state.owner === null ? claims.some(claim => claim.role !== first.role) : state.invalid
  const pendingRole = !claimed && (state.owner === null || state.pendingRole === true)
  if (state.owner?.memberId === memberId && state.owner.role === role && state.mixed === mixed && state.invalid === invalid
    && Boolean(state.pendingRole) === pendingRole) return state
  const { pendingRole: _pendingRole, ...retained } = state
  return { ...retained, owner: { memberId, role }, mixed, invalid, ...(pendingRole ? { pendingRole: true as const } : {}) }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host-only office affiliation rebuilt from Native input events; never a permission grant. */
    officeRunOwnership: OfficeRunHistoryState
  }
}

/** The framework maintains this restriction state without an additional historical-read API. */
export const officeRunHistoryProjection = {
  key: 'officeRunOwnership', stateVersion: 3, stateSchema: officeRunHistorySchema,
  init: (): OfficeRunHistoryState => ({ owner: null, mixed: false, invalid: false }),
  apply(state, event) {
    if (event.type === 'office/run-inherited') return foldOfficeRunInheritance(state, event.data)
    if (event.type === 'user/message') return foldOfficeRunHistory(state, officeRunClaims(event.data), true)
    if (event.type !== 'agent/inbox/spliced') return state
    return event.data.inserted.reduce((current, message) => foldOfficeRunHistory(current, officeRunClaims(message), false), state)
  },
} satisfies ProjectionDefinition<'officeRunOwnership'>
