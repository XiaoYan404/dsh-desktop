/** Office-owned composition keeps the extension repositories on the original mutation queue. */
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import type { OfficeCollaborationAccess } from './collaboration-access.ts'
import { officeCollaborationLimits } from './collaboration-access.ts'
import type { OfficeCollaborationLimits, OfficeGroupAttachment, OfficeUnifiedNotice } from './collaboration-types.ts'
import type { OfficeMember, OfficeMemberId, OfficeAuditRecord, OfficeMemberInvite, OfficeView, OfficeChatView } from './types.ts'
import { OfficeError } from './error.ts'
import { officeGroupsDomain, OfficeGroupsRepository } from './group-chat.ts'
import { officeIdentityGovernanceDomain, OfficeIdentityGovernanceRepository } from './identity-governance.ts'
import type { OfficeOffboardingCleanup } from './identity-governance.ts'
import { officeMessagePreferencesDomain, OfficeMessagePreferencesRepository, projectUnifiedOfficeInbox }
  from './message-preferences.ts'
import { officeMeetingSeriesDomain, OfficeMeetingSeriesRepository } from './meeting-series.ts'
import type { OfficeMeetingOccurrence } from './meeting-series.ts'
import {
  officeUsageDomain, OfficeUsageRepository, projectOfficeExecutionAudit, projectOfficeInvitationAudit,
  projectOriginalOfficeAudit, queryOfficeGovernanceAudit, officeGovernanceAuditQuery,
} from './usage-audit.ts'
import type { OfficeExecutionAuditInput } from './usage-audit.ts'
import type { z } from 'zod'
import { officeRpcDenialsDomain, OfficeRpcDenialsRepository } from './rpc-denials.ts'

/** Adapters expose only current office authority and original resource operations. */
export interface OfficeCollaborationOptions {
  readonly limits: OfficeCollaborationLimits
  readonly access: OfficeCollaborationAccess
  readonly rawAccess: OfficeCollaborationAccess
  open<S extends DomainSpec>(this: void, spec: S): Promise<Domain<S>>
  timeZone(this: void): string
  view(this: void, actorId: OfficeMemberId): OfficeView
  chat(this: void, actorId: OfficeMemberId): OfficeChatView
  checkFile(this: void, actor: OfficeMember, file: OfficeGroupAttachment): void
  commitSchedules(this: void, actorId: OfficeMemberId, items: readonly OfficeMeetingOccurrence[]): Promise<void>
  baseAudit(this: void, actorId: OfficeMemberId): readonly OfficeAuditRecord[]
  executionAudit(this: void): readonly OfficeExecutionAuditInput[]
  invitationAudit(this: void): readonly OfficeMemberInvite[]
  readonly cleanup: OfficeOffboardingCleanup
}
/** All repositories remain private to the owning Office service and its explicit typed operations. */
export interface OfficeCollaborationRuntime {
  readonly groups: OfficeGroupsRepository
  readonly governance: OfficeIdentityGovernanceRepository
  readonly messages: OfficeMessagePreferencesRepository
  readonly meetings: OfficeMeetingSeriesRepository
  readonly usage: OfficeUsageRepository
  readonly rpcDenials: OfficeRpcDenialsRepository
  verifyDirectory(this: void, members: readonly OfficeMember[]): void
  assertEmpty(this: void): void
  notices(this: void, actorId: OfficeMemberId): readonly OfficeUnifiedNotice[]
  audit(this: void, actorId: OfficeMemberId, query: z.input<typeof officeGovernanceAuditQuery>):
  ReturnType<typeof queryOfficeGovernanceAudit>
}
/**
 * Open independent v1 ledgers through the original owner so teardown closes them after admitted mutations drain.
 * @param options - Explicit deployment bounds, original queue and current authority/resource callbacks.
 * @returns Repositories whose calls are usable only while the original Office owner is open.
 */
export async function openOfficeCollaboration(options: OfficeCollaborationOptions): Promise<OfficeCollaborationRuntime> {
  const limits = officeCollaborationLimits.parse(options.limits)
  const groupDomain = await options.open(officeGroupsDomain)
  const governanceDomain = await options.open(officeIdentityGovernanceDomain)
  const messageDomain = await options.open(officeMessagePreferencesDomain)
  const meetingDomain = await options.open(officeMeetingSeriesDomain)
  const usageDomain = await options.open(officeUsageDomain)
  const denialDomain = await options.open(officeRpcDenialsDomain)
  const governance = new OfficeIdentityGovernanceRepository(governanceDomain, options.rawAccess, limits, options.cleanup)
  const chatAccess: OfficeCollaborationAccess = { ...options.access, member: id => governance.assert(id, 'chat') }
  const groups = new OfficeGroupsRepository(groupDomain, chatAccess, limits, (actor, file) => {
    governance.assert(actor.id, 'files')
    options.checkFile(actor, file)
  }, options.access.member)
  const notices = (actorId: OfficeMemberId) => {
    const view = options.view(actorId)
    try { governance.assert(actorId, 'chat') }
    catch(error) {
      if(error instanceof OfficeError && error.code === 'forbidden') return projectUnifiedOfficeInbox(view, null, [])
      throw error
    }
    return projectUnifiedOfficeInbox(view, options.chat(actorId), groups.notices(actorId))
  }
  const messages = new OfficeMessagePreferencesRepository(messageDomain, options.access, limits, options.timeZone, notices)
  const meetings = new OfficeMeetingSeriesRepository(meetingDomain, options.access, limits, options.timeZone, options.commitSchedules)
  const usage = new OfficeUsageRepository(usageDomain, options.access, limits)
  const rpcDenials = new OfficeRpcDenialsRepository(denialDomain, limits)
  return {
    groups, governance, messages, meetings, usage, rpcDenials, notices,
    verifyDirectory: (members) => {
      governance.verifyDirectory(members); groups.verifyDirectory(members); messages.verifyDirectory(members)
      meetings.verifyDirectory(members); usage.verifyDirectory(members)
      const ids = new Set(members.map(member => member.id))
      if(denialDomain.global.get().entries.some(entry => !ids.has(entry.actorId)))
        throw new OfficeError('conflict', 'RPC audit requires its original employee directory')
    },
    assertEmpty: () => {
      if(groupDomain.global.get().groups.length || governanceDomain.global.get().revision ||
        messageDomain.global.get().preferences.length
        || messageDomain.global.get().deliveries.length || meetingDomain.global.get().entries.length ||
        usageDomain.global.get().entries.length
        || denialDomain.global.get().entries.length)
        throw new OfficeError('conflict', 'Retained collaboration ledgers require their original office directory')
    },
    audit: (actorId, query) => {
      const actor = governance.assert(actorId, 'office')
      if(actor.role !== 'admin') throw new OfficeError('forbidden', 'Only an administrator may read governance audit')
      return queryOfficeGovernanceAudit([
        ...projectOriginalOfficeAudit(options.baseAudit(actorId)), ...projectOfficeExecutionAudit(options.executionAudit()),
        ...projectOfficeInvitationAudit(options.invitationAudit()), ...governance.audit(actorId), ...groups.audit(actorId),
        ...usage.audit(actorId),
        ...rpcDenials.audit(),
      ], query)
    },
  }
}
