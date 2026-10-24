/** Central deny decisions commit before offboarding cleanup and survive directory reactivation. */
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import { collaborationCounter as counter, collaborationRevision, checkCollaborationCapacity, collaborationAdministrator }
  from './collaboration-access.ts'
import type { OfficeCollaborationAccess } from './collaboration-access.ts'
import type { OfficeMember, OfficeMemberId } from './types.ts'
import type { OfficeCollaborationLimits } from './collaboration-types.ts'
import type { OfficeGovernanceAuditRow } from './usage-audit.ts'

const scope = z.enum(['office', 'files', 'connectors', 'chat', 'sessions'])
const policy = z.object({
  revision: counter, allowedRoles: z.object({
    office: z.array(z.enum(['admin', 'manager', 'employee'])).max(3), files: z.array(z.enum(['admin', 'manager', 'employee'])).max(3),
    connectors: z.array(z.enum(['admin', 'manager', 'employee'])).max(3), chat: z.array(z.enum(['admin', 'manager', 'employee'])).max(3),
    sessions: z.array(z.enum(['admin', 'manager', 'employee'])).max(3),
  }).strict(),
}).strict().refine(value => value.allowedRoles.office.includes('admin'))
const member = z.object({
  memberId: officeMemberId, revision: counter.min(1), blocked: z.boolean(),
  revokedScopes: z.array(scope).max(5), requestId: z.uuid(), initiatedBy: officeMemberId,
  stage: z.enum(['blocked', 'revoked', 'restored']), sessionsRevoked: counter, invitationsRevoked: counter,
  countsScope: z.literal('completing_cleanup_attempt'),
}).strict().refine(value => new Set(value.revokedScopes).size === value.revokedScopes.length)
const audit = z.object({
  revision: counter.min(1), actorId: officeMemberId, targetId: officeMemberId,
  action: z.enum(['member_access_blocked', 'member_access_revoked', 'member_access_restored', 'central_policy_saved',
    'directory_authority_reviewed']), time: counter,
}).strict()
const state = z.object({
  revision: counter, policy: policy.nullable(), members: z.array(member).max(100000), audit:
    z.array(audit).max(100000),
}).strict()
  .refine(value => new Set(value.members.map(entry => entry.memberId)).size === value.members.length
    && new Set(value.members.map(entry => entry.requestId)).size === value.members.length
    && value.audit.every(entry => entry.revision <= value.revision))
/** Independent v1 governance preserves original directory, credentials, ACLs and connector histories. */
export const officeIdentityGovernanceDomain = defineDomain({
  name: 'enterprise_office_identity_governance', version: 1,
  global: { schema: state, initial: { revision: 0, policy: null, members: [], audit: [] } }, tables: {},
})
/** Explicit server-bound administration operations; no profile labels or external identity claims are accepted. */
export const officeGovernanceSchemas = {
  scope,
  policy,
  suspend: z.object({ memberId: officeMemberId, revision: counter, requestId: z.uuid() }).strict(),
  restore: z.object({
    memberId: officeMemberId, revision: counter.min(1), requestId: z.uuid(),
    revokedScopes: z.array(scope).max(5).refine(value => new Set(value).size === value.length),
  }).strict(),
}
/** Supported scope names refer to service-enforced permissions. */
export type OfficeAccessScope = z.infer<typeof scope>
/** Complete explicit policy replacement. */
export type OfficeCentralPolicy = z.infer<typeof policy>
/** Durable fail-closed offboarding receipt. */
export type OfficeOffboardingReceipt = z.infer<typeof member>
/** Queued first-phase revocation input. */
export type OfficeOffboardingInput = z.input<typeof officeGovernanceSchemas.suspend>

/** Cleanup callbacks execute inside the original queue, without recursively enqueueing another mutation. */
export interface OfficeOffboardingCleanup {
  revokeSessions(this: void, initiator: OfficeMemberId, target: OfficeMemberId): Promise<number>
  revokeInvitations(this: void, initiator: OfficeMemberId, target: OfficeMemberId): Promise<number>
}

/** Access decisions derive from current directory authority plus explicit server-reviewed policy. */
export class OfficeIdentityGovernanceRepository {
  constructor(private readonly domain: Domain<typeof officeIdentityGovernanceDomain>, private readonly access:
  OfficeCollaborationAccess,
  private readonly limits: OfficeCollaborationLimits, private readonly cleanup: OfficeOffboardingCleanup) { }
  /**
   * Check retained targets and administrators without silently reseeding governance.
   * @param members - Complete original employee directory.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(entry => entry.id))
    const current = this.domain.global.get()
    if(current.members.some(entry => !ids.has(entry.memberId) || !ids.has(entry.initiatedBy))
      || current.audit.some(entry => !ids.has(entry.actorId) || !ids.has(entry.targetId)))
      throw new OfficeError('conflict', 'Identity policy requires its original employee directory')
    this.capacity(current)
  }
  /**
   * Enforce the current scope directly in the operation that reads or mutates protected resources.
   * @param actorId - Authenticated directory identity.
   * @param requested - Server-selected scope, never a client-selected authority.
   * @returns Current active employee or a uniform forbidden denial.
   */
  assert(actorId: OfficeMemberId, requested: OfficeAccessScope): OfficeMember {
    const actor = this.access.member(actorId)
    const current = this.domain.global.get()
    const entry = current.members.find(value => value.memberId === actorId)
    if(entry?.blocked || entry?.revokedScopes.includes('office') || entry?.revokedScopes.includes(requested)
      || current.policy !== null && (!current.policy.allowedRoles.office.includes(actor.role) ||
        !current.policy.allowedRoles[requested].includes(actor.role)))
      throw new OfficeError('forbidden', 'Current identity policy denies this access')
    return actor
  }
  /**
   * Read central policy and offboarding receipts only as a current authorized administrator.
   * @param actorId - Current administrator.
   * @returns Credential-free retained policy and member access facts.
   */
  view(actorId: OfficeMemberId) : {
        revision: number;
        policy: {
            revision: number;
            allowedRoles: {
                office: ("admin" | "manager" | "employee")[];
                files: ("admin" | "manager" | "employee")[];
                connectors: ("admin" | "manager" | "employee")[];
                chat: ("admin" | "manager" | "employee")[];
                sessions: ("admin" | "manager" | "employee")[];
            };
        } | null;
        members: {
            memberId: OfficeMemberId;
            revision: number;
            blocked: boolean;
            revokedScopes: ("chat" | "office" | "files" | "connectors" | "sessions")[];
            requestId: string;
            initiatedBy: OfficeMemberId;
            stage: "blocked" | "revoked" | "restored";
            sessionsRevoked: number;
            invitationsRevoked: number;
            countsScope: "completing_cleanup_attempt";
        }[];
    } {
    this.admin(actorId)
    const current = this.domain.global.get()
    return structuredClone({ revision: current.revision, policy: current.policy, members: current.members })
  }
  /**
   * Replace complete role policy after an optimistic review; only directory roles are considered.
   * @param actorId - Authenticated current administrator.
   * @param input - Explicit allowed roles for every supported scope and prior policy revision.
   * @returns New retained policy revision.
   */
  savePolicy(actorId: OfficeMemberId, input: OfficeCentralPolicy): Promise<OfficeCentralPolicy> {
    const value = policy.parse(input)
    return this.access.enqueue(async () => {
      this.admin(actorId)
      const current = this.domain.global.get()
      if((current.policy?.revision ?? 0) !== value.revision) throw new OfficeError('conflict', 'Central policy changed after review')
      const next = { ...value, revision: collaborationRevision(value.revision) }
      await this.commit(current, { ...current, policy: next }, actorId, actorId, 'central_policy_saved')
      return structuredClone(next)
    })
  }
  /**
   * Persist immediate denial before revoking token hashes and outstanding first-password invitations.
   * @param actorId - Current administrator; self-offboarding is rejected to preserve a cleanup actor.
   * @param input - Reviewed member revision and stable operation retry UUID.
   * @returns Durable revocation receipt; a cleanup failure leaves the member blocked and supports an exact retry.
   */
  suspend(actorId: OfficeMemberId, input: OfficeOffboardingInput): Promise<OfficeOffboardingReceipt> {
    const value = officeGovernanceSchemas.suspend.parse(input)
    return this.access.enqueue(async () => {
      this.admin(actorId)
      if(actorId === value.memberId) throw new OfficeError('invalid_input', 'Another administrator must offboard this account')
      const current = this.domain.global.get()
      const target = this.access.members().find(entry => entry.id === value.memberId)
      if(!target) throw new OfficeError('not_found', 'Employee is unavailable')
      const previous = current.members.find(entry => entry.memberId === value.memberId)
      if(current.members.some(entry => entry.requestId === value.requestId && entry.memberId !== value.memberId))
        throw new OfficeError('conflict', 'Offboarding retry changed its employee')
      let blocked: OfficeOffboardingReceipt
      if(previous?.requestId === value.requestId) {
        if(!previous.blocked || previous.initiatedBy !== actorId) throw new OfficeError('conflict', 'Offboarding retry changed')
        if(previous.stage === 'revoked') return structuredClone(previous)
        blocked = previous
      } else {
        if((previous?.revision ?? 0) !== value.revision) throw new OfficeError('conflict', 'Employee access changed after review')
        if(target.role === 'admin' && !this.access.members().some(entry => entry.id !== target.id && entry.active &&
          entry.role === 'admin'
          && !current.members.some(saved => saved.memberId === entry.id && (saved.blocked || saved.revokedScopes.includes('office')))))
          throw new OfficeError('invalid_input', 'Keep an active authorized administrator')
        blocked = {
          memberId: target.id, revision: collaborationRevision(previous?.revision ?? 0), blocked: true,
          revokedScopes: scope.options, requestId: value.requestId, initiatedBy: actorId, stage: 'blocked', sessionsRevoked: 0,
          invitationsRevoked: 0,
          countsScope: 'completing_cleanup_attempt',
        }
        await this.commit(current, { ...current, members: [...current.members.filter(entry => entry.memberId !== target.id), blocked] }
          ,
          actorId, target.id, 'member_access_blocked')
      }
      try {
        const sessionsRevoked = await this.cleanup.revokeSessions(blocked.initiatedBy, blocked.memberId)
        const invitationsRevoked = await this.cleanup.revokeInvitations(blocked.initiatedBy, blocked.memberId)
        const latest = this.domain.global.get()
        const completed: OfficeOffboardingReceipt = {
          ...blocked, revision: collaborationRevision(blocked.revision), stage: 'revoked',
          sessionsRevoked: blocked.sessionsRevoked + sessionsRevoked, invitationsRevoked:
            blocked.invitationsRevoked + invitationsRevoked,
        }
        await this.commit(latest, {
          ...latest, members: latest.members.map(entry => entry.memberId === completed.memberId ? completed :
            entry),
        },
        blocked.initiatedBy, blocked.memberId, 'member_access_revoked')
        return structuredClone(completed)
      } catch(error) {
        throw new OfficeError('conflict',
          'Employee access is blocked; revocation cleanup is not yet confirmed. Retry the same operation.', { cause: error })
      }
    })
  }
  /**
   * Restore only explicitly reviewed scopes after old sessions and invitations were confirmed revoked.
   * @param actorId - Current administrator.
   * @param input - Reviewed target revision, a fresh request id and scopes that remain denied.
   * @returns Restored receipt; toggling a directory active flag alone cannot restore access.
   */
  restore(actorId: OfficeMemberId, input: z.input<typeof officeGovernanceSchemas.restore>): Promise<OfficeOffboardingReceipt> {
    const value = officeGovernanceSchemas.restore.parse(input)
    return this.access.enqueue(async () => {
      this.admin(actorId)
      const current = this.domain.global.get()
      const prior = current.members.find(entry => entry.memberId === value.memberId)
      if(!prior || prior.stage !== 'revoked' || prior.revision !== value.revision || !prior.blocked)
        throw new OfficeError('conflict', 'Review confirmed offboarding before restoring access')
      this.access.member(value.memberId)
      if(current.members.some(entry => entry.requestId === value.requestId)) throw new OfficeError('conflict',
        'A fresh restore request is required')
      const updated: OfficeOffboardingReceipt = {
        ...prior, revision: collaborationRevision(prior.revision), requestId:
          value.requestId,
        blocked: false, revokedScopes: value.revokedScopes, stage: 'restored',
      }
      await this.commit(current, { ...current, members: current.members.map(entry => entry === prior ? updated : entry) },
        actorId, prior.memberId, 'member_access_restored')
      return structuredClone(updated)
    })
  }
  /**
   * Return safe administrator audit records with the original offboarding initiator retained through retries.
   * @param actorId - Current authorized administrator.
   * @returns Metadata rows without bearer material, password fields or connector credentials.
   */
  audit(actorId: OfficeMemberId): readonly OfficeGovernanceAuditRow[] {
    this.admin(actorId)
    return this.domain.global.get().audit.map(entry => ({
      ...entry, key: `policy:${entry.revision}`, source: 'policy', decision:
        'confirmed',
    }))
  }
  /**
   * Read the checked employee and exact policy revision in one synchronous observation.
   * @param actorId - Current server-bound employee.
   * @param requested - Service-selected access scope.
   * @returns Current member and monotonic governance revision, including changes later restored to previous values.
   */
  authority(actorId: OfficeMemberId, requested: OfficeAccessScope) : {
        member: OfficeMember;
        revision: number;
    } {
    const member = this.assert(actorId, requested)
    return { member, revision: this.domain.global.get().revision }
  }

  /**
   * Advance authority before a queued directory role/active change so restoring old values cannot revive old work.
   * @param actorId - Current administrator performing the original directory mutation.
   * @param targetId - Retained employee whose role or active flag is changing.
   * @returns After durability; a later failed directory commit conservatively invalidates earlier observations.
   */
  async reviewDirectoryAuthority(actorId: OfficeMemberId, targetId: OfficeMemberId): Promise<void> {
    this.admin(actorId)
    if(!this.access.members().some(member => member.id === targetId)) throw new OfficeError('not_found', 'Employee is unavailable')
    const current = this.domain.global.get()
    await this.commit(current, current, actorId, targetId, 'directory_authority_reviewed')
  }

  private admin(actorId: OfficeMemberId): void {
    collaborationAdministrator(this.access, actorId)
    this.assert(actorId, 'office')
  }
  private capacity(value: z.infer<typeof state>): void {
    checkCollaborationCapacity(value, value.members.length + value.audit.length,
      this.limits)
  }
  private async commit(current: z.infer<typeof state>, proposed: z.infer<typeof state>, actorId: OfficeMemberId,
    targetId: OfficeMemberId, action: z.infer<typeof audit>['action']): Promise<void> {
    const revision = collaborationRevision(current.revision)
    const next = { ...proposed, revision, audit: [...current.audit, { revision, actorId, targetId, action, time: Date.now() }] }
    this.capacity(next)
    await this.domain.global.set(next)
    await this.access.changed()
  }
}
