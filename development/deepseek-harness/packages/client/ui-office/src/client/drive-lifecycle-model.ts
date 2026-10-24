/** Authorized Drive history and recycle-bin views retain reviewed actions across failed acknowledgements. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { OfficeDrivePurgeInput, OfficeDrivePurgePlan, OfficeDrivePurgeReceipt,
  OfficeDrivePurgeRequestId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeDriveHistory, OfficeDriveId, OfficeDriveLifecycleInput, OfficeDriveTrash,
  OfficeMember } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

type Remote = Pick<ClientRemote['office'], 'driveHistory' | 'driveTrash' | 'changeDriveLifecycle'
  | 'drivePurgePlan' | 'drivePurgeStatus' | 'purgeDrive' | 'retryDrivePurge'>
interface PurgeReview {
  readonly id: OfficeDriveId
  readonly plan: OfficeDrivePurgePlan | null
  readonly receipt: OfficeDrivePurgeReceipt | null
  readonly uncertain: boolean
}
interface Snapshot {
  readonly panel: 'history' | 'trash' | null
  readonly history: OfficeDriveHistory | null
  readonly trash: OfficeDriveTrash | null
  readonly loading: boolean
  readonly busy: boolean
  readonly error: OfficeKey | null
  readonly purge: PurgeReview | null
}
const initial = (): Snapshot => ({ panel: null, history: null, trash: null, loading: false, busy: false, error: null, purge: null })
class Failure extends Error { constructor(readonly key: OfficeKey) { super(key) } }

/** One employee and role own all reads and reviewed mutations; closing fences late popup updates. */
export class OfficeDriveLifecycleModel {
  /** Only metadata and popup state reach framework-bound components. */
  readonly state = createSnapshotStore<Snapshot>(initial())
  private member: Pick<OfficeMember, 'id' | 'role'> | null = null
  private pending: AbortController | undefined
  private target: OfficeDriveId | null = null
  private purgeInput: OfficeDrivePurgeInput | null = null
  private disposed = false

  constructor(private readonly remote: Remote, private readonly published: () => Promise<void>,
    private readonly unauthenticated: () => void) {}

  /**
   * Withdraw old metadata before another employee or role can observe it.
   * @param member - Confirmed current identity, or null after loss of access.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    if (this.disposed || this.member?.id === member?.id && this.member?.role === member?.role) return
    this.close()
    this.member = member ? { id: member.id, role: member.role } : null
  }

  /**
   * Open current authorized history without reading file bytes.
   * @param id - Logical file selected from the authorized directory.
   */
  openHistory(id: OfficeDriveId): void {
    if (this.disposed || !this.member) return
    this.close()
    this.target = id
    this.patch({ panel: 'history' })
    void this.refresh()
  }

  /** Open this employee's current recoverable roots without changing directory navigation. */
  openTrash(): void {
    if (this.disposed || !this.member) return
    this.close()
    this.patch({ panel: 'trash' })
    void this.refresh()
  }

  /**
   * Refresh metadata explicitly; reviewed confirmation fields remain owned by their forms.
   * @returns True for a completed current popup read; false for skipped, failed or superseded refreshes.
   */
  async refresh(): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.member || snapshot.panel === null || snapshot.busy) return false
    this.pending?.abort()
    const pending = new AbortController()
    this.pending = pending
    this.patch({ loading: true, error: null })
    try {
      if (snapshot.panel === 'history' && this.target) {
        const history = await this.value(this.remote.driveHistory(this.target))
        if (this.current(pending)) this.patch({ history, loading: false })
      } else {
        const trash = await this.value(this.remote.driveTrash())
        if (!this.current(pending)) return false
        if (trash.meId !== this.member.id) throw new Failure('forbidden')
        if (this.current(pending)) this.patch({ trash, loading: false })
      }
      return this.current(pending)
    } catch (error) {
      if (this.current(pending)) this.failure(error, true)
      return false
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }

  /**
   * Submit the exact reviewed action; failures preserve the caller's draft and revision.
   * @param input - Captured identity, revision, action and optional restore name.
   * @returns Whether this still-open operation received confirmation; a late commit still refreshes the directory.
   */
  async change(input: OfficeDriveLifecycleInput): Promise<boolean> {
    if (this.disposed || !this.member || this.state.getSnapshot().busy || this.state.getSnapshot().loading) return false
    const member = this.member
    this.pending?.abort()
    const pending = new AbortController()
    this.pending = pending
    this.patch({ busy: true, error: null })
    try {
      await this.value(this.remote.changeDriveLifecycle(input))
      if (this.isDisposed() || this.member !== member) return false
      await this.published()
      if (!this.current(pending)) return false
      this.pending = undefined
      this.patch({ busy: false })
      return this.state.getSnapshot().panel === null ? true : await this.refresh()
    } catch (error) {
      if (this.current(pending)) this.failure(error, false)
      return false
    } finally {
      if (this.pending === pending) { this.pending = undefined; this.patch({ busy: false }) }
    }
  }

  /**
   * Inspect an existing approval before reviewing a new irreversible owner-only scope.
   * @param id - Root selected from the current employee's recycle bin.
   */
  openPurge(id: OfficeDriveId): void {
    if (this.disposed || !this.member || this.state.getSnapshot().busy || this.state.getSnapshot().loading) return
    this.purgeInput = null
    this.patch({ purge: { id, plan: null, receipt: null, uncertain: false }, error: null })
    void this.reviewPurge()
  }

  /** Explicitly check saved status before accepting a fresh current-scope review. */
  async reviewPurge(): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.member || !snapshot.purge || snapshot.busy || snapshot.loading) return
    const selected = snapshot.purge
    const member = this.member
    this.pending?.abort()
    const pending = new AbortController()
    this.pending = pending
    this.patch({ loading: true, error: null })
    try {
      const receipt = await this.value(this.remote.drivePurgeStatus(selected.id))
      if (!this.current(pending)) return
      if (receipt) {
        if (receipt.id !== selected.id) throw new Failure('conflict')
        this.purgeInput = null
        this.patch({ purge: { id: selected.id, plan: null, receipt, uncertain: false }, loading: false })
        return
      }
      const plan = await this.value(this.remote.drivePurgePlan(selected.id))
      if (!this.current(pending)) return
      if (plan.entry.id !== selected.id || plan.entry.ownerId !== member.id || !plan.entry.canPurge)
        throw new Failure('forbidden')
      this.purgeInput = { id: selected.id, revision: plan.entry.revision, digest: plan.digest,
        requestId: randomUUID() as OfficeDrivePurgeRequestId }
      this.patch({ purge: { id: selected.id, plan, receipt: null, uncertain: false }, loading: false })
    } catch (error) {
      if (this.current(pending)) {
        if (!selected.uncertain) this.purgeInput = null
        this.patch({ purge: { ...selected, plan: null } })
        this.failure(error, false)
      }
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }

  /**
   * Confirm the retained original request or continue a previously durable approval.
   * @param retry - True only for a known pending receipt; uncertain confirmations retain their exact body.
   */
  async confirmPurge(retry = false): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.member || !snapshot.purge || snapshot.busy || snapshot.loading) return
    const selected = snapshot.purge
    const input = this.purgeInput
    if (retry ? selected.receipt?.status !== 'pending' : input === null) return
    const member = this.member
    this.pending?.abort()
    const pending = new AbortController()
    this.pending = pending
    this.patch({ busy: true, error: null })
    try {
      let receipt: OfficeDrivePurgeReceipt
      if (retry) receipt = await this.value(this.remote.retryDrivePurge(selected.id))
      else if (input) receipt = await this.value(this.remote.purgeDrive(input))
      else return
      if (receipt.id !== selected.id || !retry && receipt.requestId !== input?.requestId) throw new Failure('conflict')
      if (this.isDisposed() || this.member !== member) return
      await this.published()
      if (!this.current(pending)) return
      this.purgeInput = null
      this.pending = undefined
      this.patch({ purge: { id: selected.id, plan: null, receipt, uncertain: false }, busy: false })
      await this.refresh()
    } catch (error) {
      if (this.current(pending)) {
        this.patch({ purge: { ...selected, uncertain: true } })
        this.failure(error, false)
      }
    } finally {
      if (this.pending === pending) { this.pending = undefined; this.patch({ busy: false }) }
    }
  }

  /** Dismiss the private review; already approved server work can still finish and refresh the directory. */
  closePurge(): void {
    this.pending?.abort()
    this.pending = undefined
    this.purgeInput = null
    this.patch({ purge: null, busy: false, loading: false, error: null })
  }

  /** Close the popup and release metadata; already admitted server writes may still commit. */
  close(): void {
    this.pending?.abort()
    this.pending = undefined
    this.target = null
    this.purgeInput = null
    this.state.set(initial())
  }

  /** Fence pending reads and writes when the office plugin unloads. */
  dispose(): void { this.close(); this.disposed = true }

  private current(pending: AbortController): boolean {
    return !this.disposed && this.member !== null && this.pending === pending && !pending.signal.aborted
  }
  private async value<T>(operation: Promise<RemoteResult<OfficeOutcome<T>>>): Promise<T> {
    const result = await operation
    if (!result.ok) throw new Failure('unavailable')
    if (!result.value.ok) throw new Failure(result.value.code)
    return result.value.value
  }
  private failure(error: unknown, clear: boolean): void {
    const key = error instanceof Failure ? error.key : 'unavailable'
    if (key === 'unauthenticated') { this.bind(null); this.unauthenticated(); return }
    this.patch({ error: key, loading: false, ...(clear ? { history: null, trash: null } : {}) })
  }
  private isDisposed(): boolean { return this.disposed }
  private patch(patch: Partial<Snapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...patch }) }
}
