/** Public office sign-in state. Passwords and bearer tokens never become snapshots or browser storage. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ClientRemote,
  RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeIdentityOverview,
  OfficeLoginInput,
  OfficeMemberInviteCapability,
  OfficeMemberId,
  OfficePasswordChangeInput,
  OfficeSessionId,
  OfficeSessionInfo,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnection, OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

interface ConnectionSnapshot {
  readonly connection: OfficeConnection | null
  readonly loading: boolean
  readonly busy: boolean
  readonly error: OfficeKey | null
  readonly sessions: readonly OfficeSessionInfo[] | null
  readonly enrollment: OfficeIdentityOverview | null
  readonly memberInvitations?: OfficeMemberInviteCapability | null
  readonly invitedMemberId?: OfficeMemberId | null
}
type ConnectionRemote = Pick<
  ClientRemote['office'],
  | 'connection'
  | 'signIn'
  | 'signOut'
  | 'identitySessions'
  | 'revokeIdentitySession'
  | 'changeIdentityPassword'
  | 'identityOverview'
  | 'setIdentityPassword'
> & Partial<Pick<ClientRemote['office'], 'memberInviteCapability'>>
const initial = (): ConnectionSnapshot => ({
  connection: null,
  loading: true,
  busy: false,
  error: null,
  sessions: null,
  enrollment: null,
})

/** One mounted office connection fences previous-account reads and reports only confirmed authentication. */
export class OfficeConnectionModel {
  /** Safe identity, loading state and own-session metadata for slot hooks. */
  readonly state = createSnapshotStore<ConnectionSnapshot>(initial())
  private disposed = false
  private epoch = 0
  private generation = 0
  private capabilityRead = 0

  constructor(
    private readonly remote: ConnectionRemote,
    private readonly changed: (initial: boolean) => void,
    private readonly notify: (key: OfficeKey, success: boolean) => void,
  ) {}

  /** Revalidate the Host session and role; authentication writes defer reads, and network errors retain confirmed identity. */
  async load(): Promise<void> {
    if (this.disposed || this.state.getSnapshot().busy) return
    const epoch = this.epoch
    const generation = ++this.generation
    try {
      const result = await this.remote.connection()
      if (this.stale(epoch) || generation !== this.generation) return
      const error = this.denial(result)
      if (error) {
        this.fail(error)
        return
      }
      if (result.ok && result.value.ok) this.publish(result.value.value)
    } catch {
      if (!this.stale(epoch) && generation === this.generation)
        this.fail('unavailable')
    }
  }

  /**
   * Sign in with reviewed form values; the Host stores the session before confirming identity.
   * @param input - Employee id and password, retained only for this call.
   * @returns Whether sign-in was confirmed.
   */
  signIn(input: OfficeLoginInput): Promise<boolean> {
    return this.mutate(
      () => this.remote.signIn(input),
      (value) => {
        this.publish(value, true)
      },
    )
  }

  /**
   * Durably sign out and then discard private office caches.
   * @returns Whether the server confirmed sign-out.
   */
  signOut(): Promise<boolean> {
    return this.mutate(
      () => this.remote.signOut(),
      () => {
        this.disconnect()
        void this.load()
      },
    )
  }

  /**
   * Change the own password and require a fresh login after every prior session is revoked.
   * @param input - Current and replacement passwords.
   * @returns Whether the server confirmed the replacement.
   */
  changePassword(input: OfficePasswordChangeInput): Promise<boolean> {
    return this.mutate(
      () => this.remote.changeIdentityPassword(input),
      () => {
        this.disconnect()
        void this.load()
      },
    )
  }

  /** Refresh only this authenticated employee's device-session list. */
  async loadSessions(): Promise<void> {
    await this.query(
      () => this.remote.identitySessions(),
      (sessions) =>{  this.patch({ sessions }) },
    )
  }

  /** Refresh administrator-only credential presence without reading secrets. */
  async loadEnrollment(): Promise<void> {
    await this.query(
      () => this.remote.identityOverview(),
      (enrollment) =>{  this.patch({ enrollment }) },
    )
  }

  /**
   * Revoke an own session, refreshing identity if this was the current session.
   * @param id - Public own-session handle.
   * @returns Whether the revocation committed.
   */
  revoke(id: OfficeSessionId): Promise<boolean> {
    return this.mutate(
      () => this.remote.revokeIdentitySession(id),
      () => {
        void this.load()
        void this.loadSessions()
      },
    )
  }

  /**
   * Set a managed employee's password through current central administrator authority.
   * @param memberId - Existing active employee selected from the directory.
   * @param password - Replacement password, never retained in the model.
   * @returns Whether the password and old-session revocations committed.
   */
  enroll(memberId: OfficeMemberId, password: string): Promise<boolean> {
    return this.mutate(
      () => this.remote.setIdentityPassword(memberId, password),
      () => {
        void this.load()
        void this.loadEnrollment()
      },
    )
  }

  /**
   * Prefill only the public member id after confirmed first-password activation, without signing in.
   * @param memberId - Identity returned by the configured authority after its credential commit.
   */
  prepareInvitedSignIn(memberId: OfficeMemberId): void {
    const connection = this.state.getSnapshot().connection
    if (!this.disposed && connection?.mode === 'gateway' && !connection.connected) this.patch({ invitedMemberId: memberId })
  }

  /** Cancel publication from old requests and discard private session metadata. */
  dispose(): void {
    this.disposed = true
    this.epoch++
    this.generation++
    this.state.set({ ...initial(), loading: false })
  }

  private async query<T>(
    operation: () => Promise<RemoteResult<OfficeOutcome<T>>>,
    accept: (value: T) => void,
  ): Promise<void> {
    if (this.disposed || !this.state.getSnapshot().connection?.connected)
      return
    const epoch = this.epoch
    try {
      const result = await operation()
      if (this.stale(epoch)) return
      const error = this.denial(result)
      if (error) {
        this.fail(error)
        return
      }
      if (result.ok && result.value.ok) {
        accept(result.value.value)
        this.patch({ error: null })
      }
    } catch {
      if (!this.stale(epoch)) this.fail('unavailable')
    }
  }
  private async mutate<T>(
    operation: () => Promise<RemoteResult<OfficeOutcome<T>>>,
    accept: (value: T) => void,
  ): Promise<boolean> {
    if (this.disposed || this.state.getSnapshot().busy) return false
    const epoch = ++this.epoch
    this.generation++
    this.patch({ busy: true, error: null })
    try {
      const result = await operation()
      if (this.stale(epoch)) return false
      const error = this.denial(result)
      if (error) {
        this.fail(error)
        this.notify(error, false)
        return false
      }
      if (!result.ok || !result.value.ok) return false
      accept(result.value.value)
      this.notify('saved', true)
      return true
    } catch {
      if (!this.stale(epoch)) {
        this.fail('unavailable')
        this.notify('unavailable', false)
      }
      return false
    } finally {
      if (!this.isDisposed()) this.patch({ busy: false })
    }
  }
  private publish(connection: OfficeConnection, force = false): void {
    const previous = this.state.getSnapshot().connection
    const changed =
      force ||
      previous?.member?.id !== connection.member?.id ||
      previous?.member?.role !== connection.member?.role ||
      previous?.connected !== connection.connected
    if (changed) {
      this.epoch++
      this.generation++
    }
    this.patch({
      connection,
      loading: false,
      error: null,
      ...(connection.connected ? { invitedMemberId: null } : {}),
      ...(changed ? { sessions: null, enrollment: null } : {}),
    })
    if (changed) this.changed(previous === null && !force)
    void this.loadMemberInviteCapability()
  }

  private async loadMemberInviteCapability(): Promise<void> {
    if (this.disposed) return
    const connection = this.state.getSnapshot().connection
    if (connection?.mode !== 'gateway') {
      this.patch({ memberInvitations: null })
      return
    }
    const epoch = this.epoch
    const read = ++this.capabilityRead
    try {
      const method = this.remote.memberInviteCapability
      if (!method) {
        this.patch({ memberInvitations: null })
        return
      }
      const result = await method()
      if (this.stale(epoch) || read !== this.capabilityRead) return
      this.patch({ memberInvitations: result.ok && result.value.ok ? result.value.value : null })
    } catch {
      if (!this.stale(epoch) && read === this.capabilityRead) this.patch({ memberInvitations: null })
    }
  }
  private disconnect(): void {
    const current = this.state.getSnapshot().connection
    if (current)
      this.publish(
        { ...current, connected: false, member: null, expiresAt: null },
        true,
      )
  }
  private fail(error: OfficeKey): void {
    if (error === 'unauthenticated') this.disconnect()
    if (error === 'forbidden') this.patch({ enrollment: null })
    this.patch({ loading: false, error })
  }
  private denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
    return !result.ok
      ? 'unavailable'
      : !result.value.ok
        ? result.value.code
        : null
  }
  private patch(value: Partial<ConnectionSnapshot>): void {
    this.state.set({ ...this.state.getSnapshot(), ...value })
  }
  private stale(epoch: number): boolean {
    return this.disposed || epoch !== this.epoch
  }
  private isDisposed(): boolean { return this.disposed }
}
