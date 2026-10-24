/** Invitation metadata stays in volatile UI state; activation passwords and issued codes never enter snapshots. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeMember, OfficeMemberId, OfficeMemberInviteCapability, OfficeMemberInviteIssueInput,
  OfficeMemberInviteIssueReceipt, OfficeMemberInviteRevokeInput, OfficeMemberInviteView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnection, OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

type InviteRemote = Pick<ClientRemote['office'], 'memberInvite' | 'issueMemberInvite' | 'revokeMemberInvite' | 'acceptMemberInvite'>
interface InviteSnapshot {
  readonly epoch: number
  readonly mode: 'closed' | 'member' | 'activate'
  readonly member: OfficeMember | null
  readonly view: OfficeMemberInviteView | null
  readonly maxTtlMs: number
  readonly loading: boolean
  readonly busy: boolean
  readonly pending: 'issue' | 'revoke' | null
  readonly error: OfficeKey | null
}
const initial = (): InviteSnapshot => ({ epoch: 0, mode: 'closed', member: null, view: null, maxTtlMs: 0,
  loading: false, busy: false, pending: null, error: null })

/** One independent overlay fences every query and command to its current employee or unauthenticated activation. */
export class OfficeMemberInvitesModel {
  /** Safe public metadata and action state; raw codes and passwords are intentionally absent. */
  readonly state = createSnapshotStore<InviteSnapshot>(initial())
  private connection: OfficeConnection | null = null
  private capability: OfficeMemberInviteCapability | null = null
  private members: readonly OfficeMember[] = []
  private identity = ''
  private generation = 0
  private reading = 0
  private disposed = false
  private pendingIssue: OfficeMemberInviteIssueInput | null = null
  private pendingRevoke: OfficeMemberInviteRevokeInput | null = null

  constructor(private readonly remote: InviteRemote, private readonly activated: (memberId: OfficeMemberId) => void,
    private readonly notify: (key: OfficeKey, success: boolean) => void) {}

  /**
   * Withdraw private metadata and in-flight publication when identity, role, target authority or capability changes.
   * @param connection - Confirmed configured gateway state, never a user-supplied destination.
   * @param capability - Optional safe authority feature discovery.
   * @param members - Current authorized directory used only to prepare reviewed role evidence.
   */
  bind(connection: OfficeConnection | null, capability: OfficeMemberInviteCapability | null | undefined,
    members: readonly OfficeMember[]): void {
    if (this.disposed) return
    const identity = connection?.mode === 'gateway' && capability?.protocol === 1
      ? `${connection.gateway}:${connection.connected}:${connection.member?.id ?? ''}:${connection.member?.role ?? ''}` : ''
    const selected = this.state.getSnapshot().member
    const current = selected ? members.find(member => member.id === selected.id) : null
    if (identity !== this.identity || selected && (!current || !current.active || current.role !== selected.role)) this.close()
    this.identity = identity
    this.connection = connection
    this.capability = capability ?? null
    this.members = members
  }

  /**
   * Open reviewed member management, or first-password activation without an existing employee login.
   * @param memberId - Current directory identity; null selects activation.
   */
  open(memberId: OfficeMemberId | null): void {
    if (this.disposed || !this.identity || !this.capability) return
    this.close()
    if (memberId === null) {
      if (!this.connection?.connected) this.patch({ mode: 'activate' })
      return
    }
    const member = this.members.find(row => row.id === memberId && row.active)
    if (!member || this.connection?.member?.role !== 'admin' || !this.connection.connected) return
    this.patch({ mode: 'member', member, maxTtlMs: this.capability.maxTtlMs })
    void this.load()
  }

  /** Refresh only the currently selected administrator view without clearing an uncertain command. */
  async load(): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || snapshot.mode !== 'member' || !snapshot.member || snapshot.busy) return
    const generation = this.generation
    const memberId = snapshot.member.id
    const reading = ++this.reading
    this.patch({ loading: true })
    try {
      const result = await this.remote.memberInvite(memberId)
      if (!this.current(generation, 'member') || reading !== this.reading) return
      const error = this.denial(result)
      if (error) { this.fail(error); return }
      if (result.ok && result.value.ok && result.value.value.memberId === memberId) {
        this.patch({ view: result.value.value })
      } else this.fail('memberInviteUnavailable')
    } catch {
      if (this.current(generation, 'member') && reading === this.reading) this.fail('memberInviteUnavailable')
    } finally {
      if (this.current(generation, 'member') && reading === this.reading) this.patch({ loading: false })
    }
  }

  /**
   * Issue reviewed metadata or retry its unchanged request; the returned code is never retained by this model.
   * @param expiresAt - Explicit absolute expiry chosen in the form.
   * @param retry - Reuse the exact previous request after an uncertain acknowledgement.
   * @returns The confirmed receipt for the current view, or null after denial or withdrawal.
   */
  async issue(expiresAt: number, retry = false): Promise<OfficeMemberInviteIssueReceipt | null> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || snapshot.mode !== 'member' || !snapshot.member || !snapshot.view || snapshot.busy
      || snapshot.view.credentialPresent || snapshot.pending === 'revoke' || snapshot.pending === 'issue' && !retry) return null
    const input = retry ? this.pendingIssue : { requestId: randomUUID(), memberId: snapshot.member.id,
      expectedRole: snapshot.member.role, expiresAt }
    if (!input) return null
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0) { this.patch({ error: 'invalid_input' }); return null }
    const generation = this.generation
    this.pendingIssue = input
    this.reading++
    this.patch({ busy: true, pending: 'issue', loading: false, error: null })
    try {
      const result = await this.remote.issueMemberInvite(input)
      if (!this.current(generation, 'member')) return null
      const error = this.denial(result)
      if (error) {
        if (result.ok) { this.pendingIssue = null; this.patch({ pending: null }) }
        this.fail(result.ok ? error : 'memberInviteUnknown')
        return null
      }
      if (!result.ok || !result.value.ok || result.value.value.invitation.memberId !== input.memberId) {
        this.fail('memberInviteUnknown')
        return null
      }
      this.pendingIssue = null
      this.patch({ pending: null, view: { ...snapshot.view, invitation: result.value.value.invitation,
        expired: false, revoked: false, requiresReview: false, canAccept: true } })
      return result.value.value
    } catch {
      if (this.current(generation, 'member')) this.fail('memberInviteUnknown')
      return null
    } finally {
      if (this.current(generation, 'member')) { this.patch({ busy: false }); void this.load() }
    }
  }

  /**
   * Revoke only the reviewed invitation, retaining its exact request if acknowledgement is uncertain.
   * @returns Whether revocation was confirmed for this same employee and target.
   */
  async revoke(): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || snapshot.mode !== 'member' || snapshot.busy || snapshot.pending === 'issue' || !snapshot.view?.invitation) return false
    const input = this.pendingRevoke ?? { id: snapshot.view.invitation.id, revision: snapshot.view.invitation.revision }
    const generation = this.generation
    this.pendingRevoke = input
    this.reading++
    this.patch({ busy: true, pending: 'revoke', loading: false, error: null })
    try {
      const result = await this.remote.revokeMemberInvite(input)
      if (!this.current(generation, 'member')) return false
      const error = this.denial(result)
      if (error) {
        if (result.ok) { this.pendingRevoke = null; this.patch({ pending: null }) }
        this.fail(result.ok ? error : 'memberInviteUnknown')
        return false
      }
      if (!result.ok || !result.value.ok || result.value.value.id !== input.id) { this.fail('memberInviteUnknown'); return false }
      this.pendingRevoke = null
      this.patch({ pending: null, view: { ...snapshot.view, invitation: result.value.value, revoked: true, canAccept: false } })
      return true
    } catch {
      if (this.current(generation, 'member')) this.fail('memberInviteUnknown')
      return false
    } finally {
      if (this.current(generation, 'member')) { this.patch({ busy: false }); void this.load() }
    }
  }

  /**
   * Set a first password without keeping either secret or creating an authenticated session.
   * @param code - Code supplied explicitly by the recipient.
   * @param newPassword - Reviewed first password, retained only by this invocation and the form.
   * @returns Whether the authority confirmed its credential commit.
   */
  async accept(code: string, newPassword: string): Promise<boolean> {
    if (this.disposed || this.state.getSnapshot().mode !== 'activate' || this.state.getSnapshot().busy) return false
    const generation = this.generation
    this.patch({ busy: true, error: null })
    try {
      const result = await this.remote.acceptMemberInvite({ code, newPassword })
      if (!this.current(generation, 'activate')) return false
      if (!result.ok) { this.patch({ error: 'memberInviteAcceptUnknown' }); return false }
      if (!result.value.ok) { this.patch({ error: result.value.code === 'rate_limited' ? 'rate_limited' : 'memberInviteInvalid' }); return false }
      this.activated(result.value.value.memberId)
      this.close()
      this.notify('memberInviteAccepted', true)
      return true
    } catch {
      if (this.current(generation, 'activate')) this.patch({ error: 'memberInviteAcceptUnknown' })
      return false
    } finally {
      if (this.current(generation, 'activate')) this.patch({ busy: false })
    }
  }

  /** Close volatile metadata and prevent admitted commands from publishing into a later overlay. */
  close(): void {
    this.generation++
    this.reading++
    this.pendingIssue = null
    this.pendingRevoke = null
    this.state.set({ ...initial(), epoch: this.generation })
  }

  /** Withdraw all pending publication when the optional UI unloads. */
  dispose(): void { this.close(); this.disposed = true }

  private current(generation: number, mode: InviteSnapshot['mode']): boolean {
    return !this.disposed && generation === this.generation && this.state.getSnapshot().mode === mode
  }
  private denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
    return !result.ok ? 'memberInviteUnavailable' : !result.value.ok ? result.value.code : null
  }
  private fail(error: OfficeKey): void {
    if (error === 'unauthenticated' || error === 'forbidden') { this.close(); this.notify(error, false); return }
    this.patch({ error })
  }
  private patch(value: Partial<InviteSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
}
