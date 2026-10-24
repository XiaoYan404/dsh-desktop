/** One identity-fenced model extends the original inbox, group and calendar operations. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type OfficeService from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeOutcome } from '../types.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeMember, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type {
  OfficeGroup, OfficeGroupPage, OfficeGroupId, OfficeGroupAttachment, OfficeMessagePreferences,
  OfficeUnifiedNotice, OfficeInboxSource,
} from '@deepseek-ai/dsh-enterprise-office/src/collaboration-types.ts'
import type { CollaborationKey } from './collaboration-copy.ts'
import type { OfficeAuditFilters } from './audit-filter-fields.ts'
import { auditMetadataFile, collaborationAuditQuery, consistentAuditPage, emptyAuditFields, sameAuditRows } from './collaboration-audit.ts'
import type { CollaborationAuditFile, CollaborationAuditQuery } from './collaboration-audit.ts'

type Method = 'groupList' | 'createGroup' | 'updateGroup' | 'leaveGroup' | 'groupPage' | 'sendGroupMessage' | 'readGroup'
  | 'downloadGroupAttachment' | 'messagePreferences' | 'saveMessagePreferences' | 'unifiedInbox' | 'claimDesktopDelivery'
  | 'settleDesktopDelivery' | 'identityGovernance' | 'saveCentralPolicy' | 'offboardMember' | 'restoreMemberAccess'
  | 'createMeetingSeries' | 'usageSummary' | 'governanceAudit' | 'readUnifiedNotice'
type Tail<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest] ? Rest : never
/** Structural generated Remote face; all signatures derive from the actual owning service. */
export type OfficeCollaborationRemote = {
  [K in Method]: (...args:
  Tail<Parameters<OfficeService[K]>>) => Promise<RemoteResult<OfficeOutcome<Awaited<ReturnType<OfficeService[K]>>>>>
}
/** Actual platform notification handles are owned and closed by this model's identity lifetime. */
export interface OfficeDesktopPort {
  permission(this: void): string
  requestPermission(this: void): Promise<string>
  show(this: void, notice: OfficeUnifiedNotice, open: () => void): { close(): void }
}
type Inbox = ReturnType<OfficeService['unifiedInbox']>
type Governance = ReturnType<OfficeService['identityGovernance']>
type Usage = ReturnType<OfficeService['usageSummary']>
type Audit = ReturnType<OfficeService['governanceAudit']>
/** Bare observable snapshot; UI consumes it through the renderer's injected hook. */
export interface OfficeCollaborationSnapshot {
  readonly visible: boolean
  readonly epoch: number
  readonly principal: OfficeMember | null
  readonly members: readonly OfficeMember[]
  readonly pending: boolean
  readonly error: CollaborationKey | null
  readonly preferences: OfficeMessagePreferences | null
  readonly inbox: Inbox | null
  readonly groups: readonly OfficeGroup[]
  readonly group: OfficeGroupPage | null
  readonly governance: Governance | null
  readonly usage: Usage | null
  readonly audit: Audit | null
  readonly auditFilters?: OfficeAuditFilters
  readonly auditApplied?: CollaborationAuditQuery | null
  readonly auditStale?: boolean
  readonly auditValidation?: CollaborationKey | null
  readonly source: OfficeInboxSource | null
  readonly unreadOnly: boolean
  readonly pendingMessages?: readonly GroupDraft[]
  readonly feedback?: { readonly id: number; readonly key: CollaborationKey; readonly success: boolean }
  readonly governanceErrors?: { readonly usage: CollaborationKey | null; readonly audit: CollaborationKey | null }
}
interface GroupDraft {
  readonly id: string
  readonly groupId: OfficeGroupId
  readonly text: string
  readonly mentions: OfficeMemberId[]
  readonly attachments: OfficeGroupAttachment[]
}
class CollaborationFailure extends Error { constructor(readonly code: string) { super(code) } }
function unwrap<T>(outcome: RemoteResult<OfficeOutcome<T>>): T {
  if(!outcome.ok) throw new CollaborationFailure('network')
  if(!outcome.value.ok) throw new CollaborationFailure(outcome.value.code)
  return outcome.value.value
}
/** Local unsent retry ids and desktop handles never enter browser storage or another identity's snapshot. */
export class OfficeCollaborationModel {
  /** Confirmed server projections and local interaction progress. */
  readonly state = createSnapshotStore<OfficeCollaborationSnapshot>({
    visible: false, epoch: 0, principal: null, members: [],
    pending: false, error: null, preferences: null, inbox: null, groups: [], group: null, governance: null, usage: null, audit: null,
    source: null, unreadOnly: false,
    auditFilters: emptyAuditFields(), auditApplied: null, auditStale: false, auditValidation: null,
  })
  private generation = 0
  private identity = 0
  private disposed = false
  private feedbackSequence = 0
  private navigate: ((notice: OfficeUnifiedNotice) => void) | undefined
  private readonly retries = new Map<OfficeGroupId, GroupDraft>()
  private readonly desktopHandles = new Set<{ close(): void }>()
  constructor(private readonly remote: OfficeCollaborationRemote, private readonly desktop: OfficeDesktopPort) { }

  /**
   * Fence requests, dialogs, unsent retries and native notification handles when server identity or authority changes.
   * @param principal - Current confirmed employee, or null on sign-out/denial.
   * @param members - Current authorized directory used only for picker labels.
   */
  bind(principal: OfficeMember | null, members: readonly OfficeMember[] = []): void {
    const current = this.state.getSnapshot()
    if(current.principal?.id === principal?.id && current.principal?.role === principal?.role &&
      current.principal?.active === principal?.active) {
      this.patch({ principal, members }); return
    }
    this.identity++
    this.generation++
    this.retries.clear()
    this.closeHandles()
    this.navigate = undefined
    this.state.set({
      visible: false, epoch: current.epoch + 1, principal, members, pending: false, error: null,
      preferences: null, inbox: null, groups: [], group: null, governance: null, usage: null, audit: null, source: null, unreadOnly:
        false,
      auditFilters: emptyAuditFields(), auditApplied: null, auditStale: false, auditValidation: null,
    })
  }
  /**
   * Open the existing employee's collaboration overlay and current authorized server projections.
   * @param navigate - Parent-owned jump callback; group jumps stay in this overlay.
   * @returns After a current load or a contained visible failure.
   */
  async open(navigate?: (notice: OfficeUnifiedNotice) => void): Promise<void> {
    if(this.disposed || !this.state.getSnapshot().principal) return
    this.navigate = navigate
    this.patch({ visible: true, epoch: this.state.getSnapshot().epoch + 1 })
    await this.refresh()
  }
  /** Discard visible private data and late replies when the dialog closes. */
  close(): void {
    this.generation++
    this.navigate = undefined
    this.closeHandles()
    this.patch({
      visible: false, pending: false, preferences: null, inbox: null, groups: [], group: null, governance: null, usage:
        null, audit: null, error: null,
      auditFilters: emptyAuditFields(), auditApplied: null, auditStale: false, auditValidation: null,
    })
  }
  /**
   * Refresh independent recipient views without letting a late generation overwrite a newer identity or navigation.
   * @returns After all requested views settle; unavailable group policy clears group data only.
   */
  async refresh(): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if(this.disposed || !snapshot.visible || !snapshot.principal || snapshot.pending) return
    const generation = ++this.generation
    const identity = this.identity
    this.patch({ pending: true, error: null })
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.remote.messagePreferences()),
        Promise.resolve().then(() => this.remote.unifiedInbox({
          source: snapshot.source, unreadOnly: snapshot.unreadOnly, before: null, limit: 50,
        })),
        Promise.resolve().then(() => this.remote.groupList()),
      ])
      if(!this.current(identity, generation)) return
      const [preference, inbox, groups] = results
      if(preference.status === 'rejected' || inbox.status === 'rejected') throw new CollaborationFailure('network')
      const preferences = unwrap(preference.value)
      const notices = unwrap(inbox.value)
      if(groups.status === 'rejected') throw groups.reason
      if(!groups.value.ok) throw new CollaborationFailure('network')
      if(!groups.value.value.ok && groups.value.value.code !== 'forbidden') unwrap(groups.value)
      const visibleGroups = groups.value.value.ok ? groups.value.value.value : []
      const group = snapshot.group && visibleGroups.some(entry => entry.id === snapshot.group?.group.id &&
        entry.revision === snapshot.group.group.revision)
        ? snapshot.group : null
      this.patch({ preferences, inbox: notices, groups: visibleGroups, group, pending: false })
    } catch(error) { if(this.current(identity, generation)) this.failed(error, false) }
  }
  /**
   * Change the original inbox's source/unread filters and refresh its first page.
   * @param source - Exact source or null for all.
   * @param unreadOnly - Whether to show only original unread rows.
   * @returns After a fenced read.
   */
  async filter(source: OfficeInboxSource | null, unreadOnly: boolean): Promise<void> {
    if(this.state.getSnapshot().pending) return
    this.patch({ source, unreadOnly })
    await this.refresh()
  }
  /** @returns After loading one current older inbox batch. */
  async moreInbox(): Promise<void> {
    const snapshot = this.state.getSnapshot()
    const before = snapshot.inbox?.next
    if(!before) return
    await this.run(async () => {
      const page = unwrap(await this.remote.unifiedInbox({
        source: snapshot.source, unreadOnly: snapshot.unreadOnly, before, limit:
          50,
      }))
      return () => {
        this.patch({ inbox: { ...page, entries: [...(this.state.getSnapshot().inbox?.entries ?? []), ...page.entries] } },
        )
      }
    }, false)
  }
  /** @param input - Reviewed complete preferences. @returns Whether the original owner confirmed the save. */
  savePreferences(input: OfficeMessagePreferences): Promise<boolean> {
    return this.run(async () => {
      unwrap(await this.remote.saveMessagePreferences(input))
    })
  }
  /** @returns Whether the employee explicitly granted the actual browser desktop permission. */
  async allowDesktop(): Promise<boolean> {
    const identity = this.identity
    const epoch = this.state.getSnapshot().epoch
    try {
      const allowed = await this.desktop.requestPermission()
      if(!this.current(identity) || epoch !== this.state.getSnapshot().epoch) return false
      if(allowed !== 'granted') { this.announce('collaborationDesktopDenied', false); return false }
      const preferences = this.state.getSnapshot().preferences
      return preferences ? this.savePreferences({ ...preferences, desktop: true }) : false
    } catch(_error) {
      if(this.current(identity) && epoch === this.state.getSnapshot().epoch) this.announce('collaborationDesktopDenied', false)
      return false
    }
  }
  /** @param input - Original group creation request. @returns Whether creation committed. */
  createGroup(input: Parameters<OfficeService['createGroup']>[1]): Promise<boolean> {
    return this.run(async () => {
      const group = unwrap(await this.remote.createGroup(input))
      return () => { this.patch({ group: { group, messages: [], next: null, readThrough: 0 } }) }
    })
  }
  /** @param input - Complete reviewed membership. @returns Whether the server confirmed current-owner authority and saved it. */
  updateGroup(input: Parameters<OfficeService['updateGroup']>[1]): Promise<boolean> {
    return this.run(async () => {
      const group = unwrap(await this.remote.updateGroup(input))
      return () => {
        const current = this.state.getSnapshot()
        if(current.group?.group.id === group.id) this.patch({ group: group.closed ||
          !group.members.some(member => member.memberId === current.principal?.id)
          ? null : { ...current.group, group } })
      }
    })
  }
  /**
   * @param id - Current authorized group.
   * @param older - Whether to append an older batch.
   * @param search - Exact message text search.
   * @returns After the current page request settles.
   */
  async loadGroup(id: OfficeGroupId, older = false, search = ''): Promise<void> {
    const snapshot = this.state.getSnapshot()
    await this.run(async () => {
      const page = unwrap(await this.remote.groupPage({ id, before: older ? snapshot.group?.next ?? null : null, limit: 50, search }))
      return () => {
        this.patch({
          group: older && snapshot.group?.group.id === id
            ? { ...page, messages: [...snapshot.group.messages, ...page.messages] } : page,
        })
      }
    }, false)
  }
  /** @returns Whether the current reviewed membership was left. */
  leaveGroup(): Promise<boolean> {
    const group = this.state.getSnapshot().group?.group
    if(!group) return Promise.resolve(false)
    return this.run(async () => {
      unwrap(await this.remote.leaveGroup({ id: group.id, revision: group.revision })); return () => {
        this.patch({ group: null })
      }
    })
  }
  /**
   * Retry one unchanged unconfirmed message identity without creating duplicate server messages.
   * @param id - Current group.
   * @param text - Exact message draft.
   * @param mentions - Explicit selected current member ids.
   * @param attachments - Existing immutable drive references.
   * @returns Whether a server-confirmed message exists; failed drafts stay with their component.
   */
  async send(id: OfficeGroupId, text: string, mentions: readonly OfficeMemberId[], attachments: readonly OfficeGroupAttachment[]):
  Promise<boolean> {
    if(this.state.getSnapshot().pending || !this.state.getSnapshot().visible) return false
    const prior = this.retries.get(id)
    if(prior && (prior.text !== text || JSON.stringify(prior.mentions) !== JSON.stringify(mentions) ||
      JSON.stringify(prior.attachments) !== JSON.stringify(attachments))) {
      this.patch({ error: 'collaborationPreviousSend' }); return false
    }
    const submitted = prior ?? { id: randomUUID(), groupId: id, text, mentions: [...mentions], attachments: [...attachments] }
    this.retries.set(id, submitted)
    this.patch({ pendingMessages: [...this.retries.values()] })
    const confirmed = await this.run(async () => {
      unwrap(await this.remote.sendGroupMessage(submitted))
      return () => { this.retries.delete(id); this.patch({ pendingMessages: [...this.retries.values()] }) }
    })
    if(!confirmed && this.state.getSnapshot().error === 'collaborationInvalid') {
      this.retries.delete(id)
      this.patch({ pendingMessages: [...this.retries.values()] })
    }
    if(confirmed && this.state.getSnapshot().group?.group.id === id) await this.loadGroup(id)
    return confirmed
  }
  /** @param input - Finite original calendar recurrence. @returns Whether all original schedule identities committed. */
  createMeetings(input: Parameters<OfficeService['createMeetingSeries']>[1]): Promise<boolean> {
    return this.run(async () => {
      unwrap(await this.remote.createMeetingSeries(input))
    })
  }
  /**
   * @param key - Original authorized inbox key.
   * @param jump - Whether to use the owner's destination after confirmed read.
   * @returns Whether acknowledgement committed.
   */
  async openNotice(key: string, jump = true): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    const notice = snapshot.inbox?.entries.find(entry => entry.key === key)
    if(!notice) return false
    const identity = this.identity
    const confirmed = await this.run(async () => { unwrap(await this.remote.readUnifiedNotice(key)) })
    if(!confirmed || this.disposed || identity !== this.identity) return false
    if(jump && (notice.source === 'group' || notice.source === 'mention')) await this.loadGroup(notice.targetId as OfficeGroupId)
    else if(jump) { const navigate = this.navigate; this.close(); navigate?.(notice) }
    return true
  }
  /**
   * @param key - Current unread row.
   * @param deviceId - Stable nonsecret device id owned by the existing client settings.
   * @param retry - Explicit retry after confirmed failure.
   * @returns Whether the actual desktop API accepted presentation.
   */
  async showDesktop(key: string, deviceId: string, retry = false): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    const notice = snapshot.inbox?.entries.find(entry => entry.key === key && !entry.read)
    if(!notice || this.desktop.permission() !== 'granted') return false
    const identity = this.identity
    const epoch = snapshot.epoch
    try {
      const receipt = unwrap(await this.remote.claimDesktopDelivery({ key, deviceId, retry }))
      if(!receipt || !this.current(identity) || this.state.getSnapshot().epoch !== epoch
        || !this.state.getSnapshot().inbox?.entries.some(entry => entry.key === key && !entry.read)
        || this.state.getSnapshot().preferences?.revision !== receipt.preferenceRevision) return false
      let stage: 'delivered' | 'failed' = 'failed'
      try {
        const handle = this.desktop.show(notice, () => {
          if(this.current(identity) && this.state.getSnapshot().epoch === epoch) void this.openNotice(key)
        })
        this.desktopHandles.add(handle)
        stage = 'delivered'
      } catch(_error) { this.announce('collaborationFailed', false) }
      const settled = unwrap(await this.remote.settleDesktopDelivery({ id: receipt.id, deviceId, attempt: receipt.attempt, stage }))
      if(!this.current(identity) || this.state.getSnapshot().epoch !== epoch) return false
      return settled?.stage === 'delivered'
    } catch(error) {
      if(this.current(identity) && this.state.getSnapshot().epoch === epoch) {
        const code = error instanceof CollaborationFailure ? error.code : 'network'
        const denied = code === 'forbidden' || code === 'unauthenticated' || code === 'not_found'
        if(denied) this.failed(error, false)
        this.announce(denied ? 'collaborationDenied' : 'collaborationNetwork', false)
      }
      return false
    }
  }
  /** @returns Current admin-only policy, actual accounting and one safe export batch. */
  async loadGovernance(): Promise<void> {
    const query = collaborationAuditQuery(this.state.getSnapshot().auditFilters ?? emptyAuditFields())
    await this.run(async () => {
      const [policy, usage, audit] = await Promise.allSettled([
        Promise.resolve().then(() => this.remote.identityGovernance()),
        Promise.resolve().then(() => this.remote.usageSummary({ memberId: null, since: 0, until: Number.MAX_SAFE_INTEGER })),
        Promise.resolve().then(() => query ? this.remote.governanceAudit(query) : null),
      ])
      if(policy.status === 'rejected') throw policy.reason
      const governance = unwrap(policy.value)
      const usageValue = usage.status === 'fulfilled' && usage.value.ok && usage.value.value.ok ? usage.value.value.value : null
      const auditValue = audit.status === 'fulfilled' && audit.value?.ok && audit.value.value.ok ? audit.value.value.value : null
      const validAudit = auditValue && query && consistentAuditPage(auditValue, query) ? auditValue : null
      const values = { governance, usage: usageValue, audit: validAudit, auditApplied: validAudit ? query : null,
        auditStale: false, auditValidation: query ? null : 'collaborationAuditInvalid' as const,
        governanceErrors: { usage: usageValue ? null : 'collaborationUsageUnavailable' as const,
          audit: validAudit || !query ? null : 'collaborationAuditUnavailable' as const } }
      return () => { this.patch(values) }
    }, false)
  }

  /** @param key - Existing audit form field. @param value - Exact local input; fields are locked during an admitted operation. */
  fieldAudit(key: keyof OfficeAuditFilters, value: string): void {
    const snapshot = this.state.getSnapshot()
    if(!this.current(this.identity) || snapshot.principal?.role !== 'admin' || snapshot.pending) return
    this.generation++
    this.patch({ auditFilters: { ...(snapshot.auditFilters ?? emptyAuditFields()), [key]: value }, auditApplied: null,
      audit: null, auditStale: false, auditValidation: null,
      error: null,
      governanceErrors: { usage: snapshot.governanceErrors?.usage ?? null, audit: null } })
  }

  /** @returns Whether the exact reviewed filters produced a current first page. */
  async searchAudit(): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    if(snapshot.principal?.role !== 'admin') return false
    const query = collaborationAuditQuery(snapshot.auditFilters ?? emptyAuditFields())
    if(!query) { this.patch({ auditValidation: 'collaborationAuditInvalid' }); return false }
    return this.run(async () => {
      const page = unwrap(await this.remote.governanceAudit(query))
      if(!consistentAuditPage(page, query)) throw new CollaborationFailure('conflict')
      return () => { this.patch({ audit: page, auditApplied: query, auditStale: false, auditValidation: null,
        governanceErrors: { usage: this.state.getSnapshot().governanceErrors?.usage ?? null, audit: null } }) }
    }, false)
  }

  /** @returns Whether an older batch was appended under the currently applied filters. */
  async moreAudit(): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    if(snapshot.principal?.role !== 'admin' || !snapshot.auditApplied || !snapshot.audit?.next || snapshot.auditStale) return false
    const query = { ...snapshot.auditApplied, before: snapshot.audit.next }
    const saved = await this.run(async () => {
      const page = unwrap(await this.remote.governanceAudit(query))
      if(!consistentAuditPage(page, query, snapshot.audit?.entries)) throw new CollaborationFailure('conflict')
      return () => { this.patch({ audit: { ...page, entries: [...(snapshot.audit?.entries ?? []), ...page.entries] } }) }
    }, false)
    if(!saved && this.state.getSnapshot().error === 'collaborationConflict') this.patch({ auditStale: true })
    return saved
  }

  /**
   * Reauthorize every displayed row in bounded batches before producing one allowlisted metadata file.
   * @returns The complete reviewed file, or null after any failure, changed result, close or authority loss; never a partial file.
   */
  async exportAudit(): Promise<CollaborationAuditFile | null> {
    const snapshot = this.state.getSnapshot()
    if(snapshot.principal?.role !== 'admin' || !snapshot.auditApplied || !snapshot.audit?.entries.length || snapshot.auditStale) return null
    const identity = this.identity
    const epoch = snapshot.epoch
    const expected = snapshot.audit.entries
    const applied = snapshot.auditApplied
    let file: CollaborationAuditFile | null = null
    const exported = await this.run(async () => {
      let before: CollaborationAuditQuery['before'] = null
      for(let offset = 0; offset < expected.length;) {
        const limit = Math.min(100, expected.length - offset)
        const query: CollaborationAuditQuery = { ...applied, limit, before }
        const page: Audit = unwrap(await this.remote.governanceAudit(query))
        if(!this.current(identity) || this.state.getSnapshot().epoch !== epoch) return
        if(!consistentAuditPage(page, query) || !sameAuditRows(page.entries, expected.slice(offset, offset + limit)))
          throw new CollaborationFailure('conflict')
        offset += page.entries.length
        before = page.next
        if(offset < expected.length && !before) throw new CollaborationFailure('conflict')
      }
      return () => { file = auditMetadataFile(expected) }
    }, false)
    if(!exported && this.current(identity) && this.state.getSnapshot().epoch === epoch) {
      const changed = this.state.getSnapshot().error === 'collaborationConflict'
      if(changed) this.patch({ auditStale: true })
      this.announce(changed ? 'collaborationAuditChanged' : 'collaborationAuditExportFailed', false)
    }
    return exported && this.current(identity) && this.state.getSnapshot().epoch === epoch ? file : null
  }
  /** @param input - Reviewed actual member-access revision. @returns Whether fail-closed offboarding completed. */
  async offboard(input: Parameters<OfficeService['offboardMember']>[1]): Promise<boolean> {
    return this.mutateGovernance(async () => { unwrap(await this.remote.offboardMember(input)) })
  }
  /** @param input - Complete role scopes from the service-owned policy. @returns Whether the reviewed policy committed. */
  async savePolicy(input: Parameters<OfficeService['saveCentralPolicy']>[1]): Promise<boolean> {
    return this.mutateGovernance(async () => { unwrap(await this.remote.saveCentralPolicy(input)) })
  }
  /** @param input - Explicit reviewed access restoration. @returns Whether old-session-free access was restored. */
  async restore(input: Parameters<OfficeService['restoreMemberAccess']>[1]): Promise<boolean> {
    return this.mutateGovernance(async () => { unwrap(await this.remote.restoreMemberAccess(input)) })
  }
  /** Invalidate every pending reply before plugin teardown; owned desktop presentations are closed. */
  dispose(): void {
    this.disposed = true; this.identity++; this.generation++; this.retries.clear(); this.closeHandles()
    this.navigate = undefined
  }

  private async mutateGovernance(operation: () => Promise<void>): Promise<boolean> {
    const identity = this.identity
    const epoch = this.state.getSnapshot().epoch
    const saved = await this.run(operation)
    if(this.current(identity) && this.state.getSnapshot().epoch === epoch) await this.loadGovernance()
    return saved
  }

  private async run(operation: () => Promise<void | (() => void)>, refresh = true): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    if(this.disposed || !snapshot.visible || !snapshot.principal || snapshot.pending) return false
    const identity = this.identity
    const generation = ++this.generation
    this.patch({ pending: true, error: null })
    try {
      const publish = await operation()
      if(!this.current(identity, generation)) return false
      publish?.()
      if(refresh) this.announce('collaborationSaved', true)
      this.patch({ pending: false })
      if(refresh) await this.refresh()
      return this.current(identity) && this.state.getSnapshot().error !== 'collaborationDenied'
    } catch(error) {
      if(this.current(identity, generation)) {
        this.failed(error, false)
        if(refresh) this.announce(this.state.getSnapshot().error ?? 'collaborationFailed', false)
      }
      return false
    }
  }
  private failed(error: unknown, clear: boolean): void {
    const code = error instanceof CollaborationFailure ? error.code : 'network'
    const denied = code === 'forbidden' || code === 'unauthenticated' || code === 'not_found'
    if(denied) { this.identity++; this.generation++; this.retries.clear(); this.closeHandles() }
    this.patch({
      pending: false, error: denied ? 'collaborationDenied' : code === 'conflict' ? 'collaborationConflict'
        : code === 'invalid_input' ? 'collaborationInvalid' : 'collaborationNetwork',
      ...clear || denied ? { preferences: null, inbox: null, groups: [], group: null, governance: null, usage: null, audit: null,
        auditFilters: emptyAuditFields(), auditApplied: null, auditStale: false, auditValidation: null,
        governanceErrors: { usage: null, audit: null }, pendingMessages: [], epoch: this.state.getSnapshot().epoch + 1 } : {},
    })
  }
  private current(identity: number, generation?: number): boolean {
    return !this.disposed && identity === this.identity && (generation === undefined || generation === this.generation) &&
      this.state.getSnapshot().visible
  }
  private patch(value: Partial<OfficeCollaborationSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
  private announce(key: CollaborationKey, success: boolean): void {
    this.patch({ feedback: { id: ++this.feedbackSequence, key, success } })
  }
  private closeHandles(): void { for(const handle of this.desktopHandles) handle.close(); this.desktopHandles.clear() }
}
