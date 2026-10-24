/** Employee-private execution pages and explicit result reads are fenced across identity, role, system and request changes. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnectorExecutionId, OfficeConnectorExecutionPage, OfficeConnectorExecutionReceipt,
  OfficeConnectorExecutionSummary, OfficeIntegrationId, OfficeMember, OfficeMemberId,
  OfficeConnectorExecutionCheck } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

interface ExecutionSnapshot {
  readonly integrationId: OfficeIntegrationId | null
  readonly entries: readonly OfficeConnectorExecutionSummary[]
  readonly next: OfficeConnectorExecutionId | null
  readonly loading: boolean
  readonly error: OfficeKey | null
  readonly detail: {
    readonly id: OfficeConnectorExecutionId
    readonly loading: boolean
    readonly receipt: OfficeConnectorExecutionReceipt | null
    readonly error: OfficeKey | null
    readonly check?: {
      readonly loading: boolean
      readonly status: OfficeConnectorExecutionCheck['status'] | null
      readonly error: OfficeKey | null
    }
  } | null
}
type ExecutionRemote = Pick<ClientRemote['office'], 'connectorExecutionPage' | 'connectorExecutionDetail' | 'checkConnectorExecution'>
const empty: ExecutionSnapshot = { integrationId: null, entries: [], next: null, loading: false, error: null, detail: null }

/** Explicit history browsing owns no business submission or automatic replay operation. */
export class OfficeExecutionsModel {
  /** Small list rows and at most one explicitly selected complete receipt. */
  readonly state = createSnapshotStore<ExecutionSnapshot>(empty)
  private identity: string | null = null
  private memberId: OfficeMemberId | null = null
  private epoch = 0
  private pageRead = 0
  private detailRead = 0
  private disposed = false

  constructor(private readonly remote: ExecutionRemote, private readonly notify: (key: OfficeKey) => void) {}

  /**
   * Release private history immediately when the current identity or authorization role changes.
   * @param member - Current authenticated office member, or null when authority is unavailable.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    const identity = member ? `${member.id}:${member.role}` : null
    if (this.disposed || this.identity === identity) return
    this.identity = identity
    this.memberId = member?.id ?? null
    this.epoch++
    this.close()
  }

  /** Close the current system and invalidate every pending page/detail callback. */
  close(): void {
    this.pageRead++
    this.detailRead++
    this.state.set(empty)
  }

  /**
   * Explicitly refresh one system's own history, clearing old private details before the request starts.
   * @param integrationId - Current company registration selected by the employee.
   * @returns When the accepted request settles; stale responses cannot reopen another system or account.
   */
  async open(integrationId: OfficeIntegrationId): Promise<void> {
    if (this.disposed || !this.identity) return
    this.close()
    this.patch({ integrationId })
    await this.page(false)
  }

  /**
   * Read the next explicit older page; concurrent clicks cannot duplicate an already pending request.
   * Keep outcome checks already confirmed on displayed rows while the older page is pending.
   * @returns When its accepted page read settles.
   */
  async more(): Promise<void> { await this.page(true) }

  /**
   * Load one currently listed own receipt after the employee selects it.
   * @param id - Visible execution identity; arbitrary ids cannot be used to fetch another account through this model.
   * @returns When its accepted read settles; older reads and failures never reveal stale result fields.
   */
  async detail(id: OfficeConnectorExecutionId): Promise<void> {
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.identity || !snapshot.entries.some(entry => entry.id === id)) return
    const epoch = this.epoch
    const read = ++this.detailRead
    const integrationId = snapshot.integrationId
    this.patch({ detail: { id, loading: true, receipt: null, error: null } })
    try {
      const result = await this.remote.connectorExecutionDetail(id)
      if (!this.current(epoch, integrationId) || read !== this.detailRead) return
      const error = denial(result)
      if (error) { this.fail(error, true); return }
      if (!result.ok || !result.value.ok) return
      const receipt = result.value.value
      if (receipt.id !== id || receipt.integrationId !== integrationId || receipt.memberId !== this.memberId) {
        this.fail('conflict', true); return
      }
      this.patch({ detail: { id, loading: false, receipt, error: null } })
    } catch {
      if (this.current(epoch, integrationId) && read === this.detailRead) this.fail('unavailable', true)
    }
  }

  /** Clear the selected result without discarding the current small history page. */
  closeDetail(): void { this.detailRead++; this.patch({ detail: null }) }

  /**
   * Explicitly query the original customer outcome for the selected unknown receipt without invoking a business write.
   * @returns When its accepted check settles; account/role/system/detail changes fence every late private result.
   */
  async check(): Promise<void> {
    const snapshot = this.state.getSnapshot()
    const detail = snapshot.detail
    if (this.disposed || !this.identity || !detail?.receipt || detail.receipt.status !== 'unknown' || detail.check?.loading) return
    const epoch = this.epoch
    const read = ++this.detailRead
    const integrationId = snapshot.integrationId
    this.patch({ detail: { ...detail, check: { loading: true, status: null, error: null } } })
    try {
      const result = await this.remote.checkConnectorExecution(detail.id)
      if (!this.current(epoch, integrationId) || read !== this.detailRead) return
      const error = denial(result)
      if (error) { this.checkFailure(error); return }
      if (!result.ok || !result.value.ok) return
      const checked = result.value.value
      const receipt = checked.receipt
      if (receipt.id !== detail.id || receipt.integrationId !== integrationId || receipt.memberId !== this.memberId ||
        receipt.revision < detail.receipt.revision) { this.checkFailure('conflict'); return }
      const { result: _result, history: _history, ...summary } = receipt
      this.patch({ entries: this.state.getSnapshot().entries.map(entry => entry.id === receipt.id ? summary : entry),
        detail: { ...detail, receipt, check: { loading: false, status: checked.status, error: null } } })
    } catch {
      if (this.current(epoch, integrationId) && read === this.detailRead) this.checkFailure('unavailable')
    }
  }

  /** Release all private state and permanently fence late callbacks when the office plugin unloads. */
  dispose(): void { this.close(); this.disposed = true; this.epoch++ }

  private async page(older: boolean): Promise<void> {
    const snapshot = this.state.getSnapshot()
    const integrationId = snapshot.integrationId
    if (this.disposed || !this.identity || !integrationId || snapshot.loading || (older && !snapshot.next)) return
    const epoch = this.epoch
    const read = ++this.pageRead
    const before = older ? snapshot.next : null
    this.patch({ loading: true, error: null })
    try {
      const result = await this.remote.connectorExecutionPage({ integrationId, ...before ? { before } : {} })
      if (!this.current(epoch, integrationId) || read !== this.pageRead) return
      const error = denial(result)
      if (error) { this.fail(error, false); return }
      if (!result.ok || !result.value.ok) return
      const page: OfficeConnectorExecutionPage = result.value.value
      if (page.integrationId !== integrationId || page.entries.some(entry => entry.integrationId !== integrationId ||
        entry.memberId !== this.memberId)) { this.fail('conflict', false); return }
      const entries = older ? [...this.state.getSnapshot().entries, ...page.entries] : page.entries
      if (new Set(entries.map(entry => entry.id)).size !== entries.length ||
        (page.next && (page.next === before || page.next !== page.entries.at(-1)?.id))) {
        this.fail('conflict', false); return
      }
      this.patch({ entries, next: page.next, loading: false, error: null })
    } catch {
      if (this.current(epoch, integrationId) && read === this.pageRead) this.fail('unavailable', false)
    }
  }

  private current(epoch: number, integrationId: OfficeIntegrationId | null): boolean {
    return !this.disposed && epoch === this.epoch && this.state.getSnapshot().integrationId === integrationId
  }
  private checkFailure(error: OfficeKey): void {
    if (error === 'unauthenticated' || error === 'forbidden') { this.fail(error, true); return }
    const detail = this.state.getSnapshot().detail
    if (detail) this.patch({ detail: { ...detail, check: { loading: false, status: null, error } } })
  }
  private patch(value: Partial<ExecutionSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
  private fail(error: OfficeKey, detail: boolean): void {
    if (error === 'unauthenticated' || error === 'forbidden') {
      this.close()
      if (error === 'unauthenticated') this.bind(null)
      this.notify(error)
      return
    }
    const previous = this.state.getSnapshot().detail
    this.patch(detail && previous ? { detail: { ...previous, loading: false, receipt: null, error } } : { loading: false, error })
  }
}

function denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
  return !result.ok ? 'unavailable' : !result.value.ok ? result.value.code : null
}
