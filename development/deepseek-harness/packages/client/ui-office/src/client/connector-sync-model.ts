/** Explicit synchronized reads and private historical data share one identity-fenced dialog owner. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnectorActionsView, OfficeConnectorSyncDetail, OfficeConnectorSyncId, OfficeConnectorSyncInput,
  OfficeConnectorSyncSummary, OfficeConnectorView, OfficeIntegrationId, OfficeMember } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

interface SyncRequest {
  readonly input: OfficeConnectorSyncInput
  readonly label: string
  readonly phase: 'review' | 'sending' | 'uncertain' | 'blocked' | 'complete'
  readonly receipt: OfficeConnectorSyncDetail | null
  readonly error: OfficeKey | null
}
interface SyncSnapshot {
  readonly integrationId: OfficeIntegrationId | null
  readonly entries: readonly OfficeConnectorSyncSummary[]
  readonly next: OfficeConnectorSyncId | null
  readonly loading: boolean
  readonly error: OfficeKey | null
  readonly request: SyncRequest | null
  readonly detail: {
    readonly id: OfficeConnectorSyncId
    readonly loading: boolean
    readonly receipt: OfficeConnectorSyncDetail | null
    readonly error: OfficeKey | null
  } | null
}
type SyncRemote = Pick<ClientRemote['office'], 'syncConnectorAction' | 'connectorSyncPage' | 'connectorSyncDetail'>
const empty: SyncSnapshot = { integrationId: null, entries: [], next: null, loading: false, error: null, request: null, detail: null }

/** No background synchronization: only a confirmed review can initiate a customer read. */
export class OfficeConnectorSyncModel {
  /** JSON-only review, bounded metadata pages and one explicitly selected historical result. */
  readonly state = createSnapshotStore<SyncSnapshot>(empty)
  private member: Pick<OfficeMember, 'id' | 'role'> | null = null
  private epoch = 0
  private pageRead = 0
  private detailRead = 0
  private disposed = false
  private view: OfficeConnectorView | null = null
  private directory: OfficeConnectorActionsView | null = null

  constructor(private readonly remote: SyncRemote, private readonly notify: (key: OfficeKey) => void) {}

  /**
   * Release private fields and pending request identities on account or role replacement.
   * @param member - Currently authenticated employee, or null while authentication is unknown.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    if (this.disposed || (this.member?.id === member?.id && this.member?.role === member?.role)) return
    this.member = member ? { id: member.id, role: member.role } : null
    this.close()
  }

  /**
   * Remove stale displayed data without rewriting an attempted request or issuing another read.
   * @param view - Current connection metadata and advertised synchronization capability.
   * @param directory - Latest explicitly loaded action declarations, if available.
   */
  synchronize(view: OfficeConnectorView | null, directory: OfficeConnectorActionsView | null): void {
    this.view = view
    this.directory = directory
    if (this.disposed) return
    const snapshot = this.state.getSnapshot()
    const request = snapshot.request
    const detail = snapshot.detail
    const stale = request && !this.reviewCurrent(request.input)
    const hidden = (receipt: OfficeConnectorSyncDetail) => this.visible(receipt)
    this.patch({
      ...(request ? { request: { ...request,
        phase: stale && request.phase === 'review' ? 'blocked' : request.phase,
        error: stale && request.phase === 'review' ? 'conflict' : request.error,
        receipt: request.receipt ? hidden(request.receipt) : null } } : {}),
      ...(detail?.receipt ? { detail: { ...detail, receipt: hidden(detail.receipt) } } : {}),
    })
  }

  /** Close the dialog; an admitted read can still finish server-side and be recovered from history. */
  close(): void { this.epoch++; this.pageRead++; this.detailRead++; this.state.set(empty) }

  /**
   * Prepare an exact review without a customer request or automatic confirmation.
   * @param directory - Role-filtered read declarations selected from current system details.
   * @param actionId - Exact declared read action.
   */
  begin(directory: OfficeConnectorActionsView, actionId: string): void {
    const action = directory.actions.find(entry => entry.id === actionId && entry.kind === 'read')
    if (this.disposed || !this.member || !action || this.state.getSnapshot().request?.phase === 'sending') return
    if (directory.status !== 'unverified' || !directory.readSupported || !directory.adapterRevision) return
    const input: OfficeConnectorSyncInput = { integrationId: directory.integrationId, actionId,
      connectionRevision: directory.connectionRevision, adapterRevision: directory.adapterRevision, requestId: randomUUID() }
    if (!this.reviewCurrent(input)) return
    this.close()
    this.patch({ integrationId: input.integrationId,
      request: { input, label: action.label, phase: 'review', receipt: null, error: null } })
  }

  /**
   * Confirm a reviewed read, or retry its exact original identity after an uncertain acknowledgement.
   * @returns After the current dialog's acknowledgement is accepted or fenced by closure or identity replacement.
   */
  async submit(): Promise<void> {
    const request = this.state.getSnapshot().request
    if (this.disposed || !this.member || !request || (request.phase !== 'review' && request.phase !== 'uncertain')) return
    if (request.phase === 'review' && !this.reviewCurrent(request.input)) {
      this.patch({ request: { ...request, phase: 'blocked', error: 'conflict' } }); return
    }
    const epoch = this.epoch
    this.patch({ request: { ...request, phase: 'sending', receipt: null, error: null } })
    try {
      const result = await this.remote.syncConnectorAction(request.input)
      if (!this.current(epoch)) return
      const error = denial(result)
      if (error) { this.submitFailure(request, error); return }
      if (!result.ok || !result.value.ok) return
      const receipt = result.value.value
      if (!this.matches(receipt, request.input)) { this.submitFailure(request, 'unavailable'); return }
      this.patch({ request: { ...request, phase: 'complete', receipt: this.visible(receipt), error: null } })
    } catch {
      if (this.current(epoch)) this.submitFailure(request, 'unavailable')
    }
  }

  /**
   * Open or refresh this employee's saved metadata without querying the customer system.
   * @param integrationId - Company system selected by the employee.
   * @returns After its first bounded metadata page settles.
   */
  async open(integrationId: OfficeIntegrationId): Promise<void> {
    if (this.disposed || !this.member || this.view?.synchronization?.protocol !== 1) return
    this.close()
    this.patch({ integrationId })
    await this.page(false)
  }

  /** Read the next explicit older page, retaining its original stable anchor. */
  async more(): Promise<void> { await this.page(true) }

  /**
   * Fetch one listed historical result under current server authorization.
   * @param id - Selected own record identity from the current metadata page.
   * @returns After the latest selected detail settles; stale responses cannot restore discarded fields.
   */
  async detail(id: OfficeConnectorSyncId): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.member || !snapshot.entries.some(entry => entry.id === id)) return
    const epoch = this.epoch
    const read = ++this.detailRead
    this.patch({ detail: { id, loading: true, receipt: null, error: null } })
    try {
      const result = await this.remote.connectorSyncDetail(id)
      if (!this.current(epoch) || read !== this.detailRead) return
      const error = denial(result)
      if (error) { this.detailFailure(id, error); return }
      if (!result.ok || !result.value.ok) return
      const receipt = result.value.value
      if (receipt.meId !== this.member.id || receipt.summary.id !== id ||
        receipt.summary.integrationId !== snapshot.integrationId) { this.detailFailure(id, 'conflict'); return }
      this.patch({ detail: { id, loading: false, receipt: this.visible(receipt), error: null } })
    } catch {
      if (this.current(epoch) && read === this.detailRead) this.detailFailure(id, 'unavailable')
    }
  }

  /** Return to the retained metadata list, discarding private detail fields and late callbacks. */
  back(): void { this.detailRead++; this.patch({ detail: null }) }

  /** Release every retained field and fence pending remote acknowledgements. */
  dispose(): void { this.close(); this.disposed = true; this.member = null; this.view = null; this.directory = null }

  private async page(older: boolean): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.member || !snapshot.integrationId || snapshot.loading || (older && !snapshot.next)) return
    const integrationId = snapshot.integrationId
    const before = older ? snapshot.next : null
    const epoch = this.epoch
    const read = ++this.pageRead
    this.patch({ loading: true, error: null })
    try {
      const result = await this.remote.connectorSyncPage({ integrationId, ...(before ? { before } : {}) })
      if (!this.current(epoch) || read !== this.pageRead) return
      const error = denial(result)
      if (error) { this.pageFailure(error); return }
      if (!result.ok || !result.value.ok) return
      const page = result.value.value
      const entries = older ? [...snapshot.entries, ...page.entries] : page.entries
      if (page.meId !== this.member.id || page.integrationId !== integrationId ||
        page.entries.some(entry => entry.integrationId !== integrationId) ||
        new Set(entries.map(entry => entry.id)).size !== entries.length ||
        (page.next && (page.next === before || page.next !== page.entries.at(-1)?.id))) {
        this.pageFailure('conflict'); return
      }
      this.patch({ entries, next: page.next, loading: false, error: null })
    } catch {
      if (this.current(epoch) && read === this.pageRead) this.pageFailure('unavailable')
    }
  }

  private current(epoch: number): boolean { return !this.disposed && this.member !== null && epoch === this.epoch }
  private reviewCurrent(input: OfficeConnectorSyncInput): boolean {
    const connection = this.view?.entries.find(entry => entry.integrationId === input.integrationId)
    const directory = this.directory
    return this.view?.synchronization?.protocol === 1 && connection?.status === 'unverified' &&
      connection.revision === input.connectionRevision && directory?.integrationId === input.integrationId &&
      directory.status === 'unverified' && directory.connectionRevision === input.connectionRevision &&
      directory.adapterRevision === input.adapterRevision && directory.readSupported === true &&
      directory.actions.some(action => action.kind === 'read' && action.id === input.actionId)
  }
  private visible(receipt: OfficeConnectorSyncDetail): OfficeConnectorSyncDetail {
    const connection = this.view?.entries.find(entry => entry.integrationId === receipt.summary.integrationId)
    const directory = this.directory?.integrationId === receipt.summary.integrationId ? this.directory : null
    const available = receipt.available && connection?.status === 'unverified' &&
      connection.revision === receipt.summary.connectionRevision && (!directory ||
        (directory.status === 'unverified' && directory.readSupported === true &&
          directory.actions.some(action => action.id === receipt.summary.actionId && action.kind === 'read')))
    return available ? receipt : { ...receipt, available: false, data: null }
  }
  private matches(receipt: OfficeConnectorSyncDetail, input: OfficeConnectorSyncInput): boolean {
    return receipt.meId === this.member?.id && receipt.summary.integrationId === input.integrationId &&
      receipt.summary.actionId === input.actionId && receipt.summary.connectionRevision === input.connectionRevision &&
      receipt.summary.adapterRevision === input.adapterRevision
  }
  private unauthorized(error: OfficeKey): boolean {
    if (error !== 'unauthenticated' && error !== 'forbidden') return false
    this.close()
    if (error === 'unauthenticated') this.bind(null)
    this.notify(error)
    return true
  }
  private submitFailure(request: SyncRequest, error: OfficeKey): void {
    if (!this.unauthorized(error)) this.patch({ request: { ...request,
      phase: error === 'unavailable' ? 'uncertain' : 'blocked', receipt: null, error } })
  }
  private pageFailure(error: OfficeKey): void {
    if (!this.unauthorized(error)) this.patch({ loading: false, error })
  }
  private detailFailure(id: OfficeConnectorSyncId, error: OfficeKey): void {
    if (!this.unauthorized(error)) this.patch({ detail: { id, loading: false, receipt: null, error } })
  }
  private patch(value: Partial<SyncSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
}

function denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
  return !result.ok ? 'unavailable' : !result.value.ok ? result.value.code : null
}
