/** Browser-local navigation commits atomically while native Sessions retain every input resource. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { OFFICE_NAVIGATION_SIGNAL_KEY } from './conversation-data.ts'
import type { OfficeNavigationData, OfficeNavigationRecord } from './conversation-data.ts'
import { OfficeNavigationRepository } from './conversation-repository.ts'

/** JSON identity of the ordinary input retained for this employee and window. */
export interface OfficeOrdinaryInput {
  readonly sessionId: SessionId
  readonly principal: OfficeMemberId
  readonly generation: number
}

/** Keep ordinary returns and item links separate, publishing ownership only after database commit. */
export class OfficeConversationModel {
  /** Identities and readiness only; prompts, file handles and database connections stay with their owners. */
  readonly state = createSnapshotStore<{
    readonly hidden: readonly SessionId[]
    readonly restoring: boolean
    readonly selected: SessionId | null
    readonly phase: 'loading' | 'ready' | 'unavailable'
    readonly ordinary: OfficeOrdinaryInput | null
    readonly generation: number
  }>({ hidden: [], restoring: false, selected: null, phase: 'loading', ordinary: null, generation: 0 })
  private data: OfficeNavigationData = { entries: [], ordinary: {} }
  private revision = -1
  private phase: 'loading' | 'ready' | 'unavailable' = 'loading'
  private principal: OfficeMemberId | null | undefined
  private selected: SessionId | undefined
  private ordinaryId: SessionId | undefined
  private pending: AbortController | undefined
  private lifetime = new AbortController()
  private generation = 0
  private readSequence = 0
  private visitSequence = 0
  private disposed = false
  private readonly references = new Map<SessionId, () => void>()
  private readonly repository: OfficeNavigationRepository

  constructor(
    private readonly retain: (id: SessionId) => () => void,
    private readonly available: (id: SessionId) => boolean,
    private readonly open: (id: SessionId) => void,
    private readonly create: (signal: AbortSignal) => Promise<boolean>,
    private readonly report: (reason?: 'storage' | 'notification') => void,
  ) {
    this.repository = new OfficeNavigationRepository(() => {
      if (this.disposed) return
      this.phase = 'unavailable'
      this.selected = undefined
      this.publish()
      void this.synchronize(null)
    })
  }

  /**
   * Release the previous employee before loading a committed index for the new identity.
   * @param principal - Confirmed employee, or null on authorization loss.
   * @returns Completion of the current identity's initial read.
   */
  async bind(principal: OfficeMemberId | null): Promise<void> {
    if (this.disposed || this.principal === principal) return
    this.generation++
    this.readSequence++
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.cancel()
    for (const release of this.references.values()) release()
    this.references.clear()
    this.principal = principal
    this.selected = undefined
    this.ordinaryId = undefined
    this.phase = principal === null ? 'ready' : 'loading'
    this.publish()
    if (principal) await this.reload(this.generation, this.lifetime.signal)
  }

  /**
   * Claim or revisit one native input through an exclusive transaction.
   * @param id - Existing native Session.
   * @param principal - Header's captured employee, checked again after storage awaits.
   * @param kind - Item inputs never replace an ordinary return target.
   * @returns Completion after commit, refusal, cancellation or a reported storage failure.
   */
  async observe(id: SessionId, principal: OfficeMemberId, kind: 'ordinary' | 'item'): Promise<void> {
    if (this.disposed || this.principal !== principal || !this.available(id)) return
    const generation = this.generation
    const signal = this.lifetime.signal
    const visit = ++this.visitSequence
    const admission: { kind: 'ordinary' | 'item' | null } = { kind: null }
    let committed = false
    try {
      const result = await this.repository.update((data) => {
        signal.throwIfAborted()
        this.assertConsistent(data)
        const entry = data.entries.find(value => value.sessionId === id)
        if (entry && entry.principal !== principal) return data
        const effectiveKind = entry?.kind ?? kind
        if (!entry && data.entries.length >= 2000) throw new Error('Office conversation navigation is full')
        admission.kind = effectiveKind
        if (entry && (effectiveKind === 'item' || data.ordinary[principal] === id)) return data
        return {
          entries: entry ? data.entries : [...data.entries, { principal, sessionId: id, kind: effectiveKind }],
          ordinary: effectiveKind === 'ordinary' ? { ...data.ordinary, [principal]: id } : data.ordinary,
        }
      }, signal)
      if (this.stale(generation)) return
      this.accept(result.record)
      committed = true
      this.readSequence++
      this.phase = 'ready'
      if (!result.notified) this.report('notification')
      if (admission.kind !== null && this.available(id)) {
        if (admission.kind === 'ordinary' && !this.references.has(id)) this.references.set(id, this.retain(id))
        if (visit === this.visitSequence) {
          this.selected = id
          if (admission.kind === 'ordinary') this.ordinaryId = id
        }
      }
      this.publish()
    } catch {
      if (this.stale(generation)) return
      if (!committed) this.fail()
      else this.report()
    }
  }

  /**
   * Read the last confirmed visible input without restoring or creating one.
   * @returns This employee's selected input while its native Session remains available.
   */
  current(): SessionId | null {
    return !this.disposed && this.phase === 'ready' && this.principal && this.selected && this.available(this.selected)
      ? this.selected : null
  }

  /**
   * Restore the latest committed ordinary return, or prepare a fresh unsent native input.
   * @param signal - Optional caller's entry/preparation lifetime.
   * @param reveal - False prepares an existing ordinary input for an embedded home composer without opening or creating one.
   * @returns True only when navigation completes in the same employee lifetime.
   */
  async restore(signal?: AbortSignal, reveal = true): Promise<boolean> {
    if (this.disposed || !this.principal || this.pending || signal?.aborted) return false
    const generation = this.generation
    const controller = new AbortController()
    const abort = () => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    let readCompleted = false
    this.pending = controller
    this.publish()
    try {
      const result = await this.repository.read(controller.signal)
      if (!this.ownsRequest(controller, generation)) return false
      this.accept(result.record)
      this.phase = 'ready'
      readCompleted = true
      const saved = Object.hasOwn(this.data.ordinary, this.principal) ? this.data.ordinary[this.principal] : undefined
      const id = this.ordinaryId && this.available(this.ordinaryId) ? this.ordinaryId : saved
      if (id && this.available(id)) {
        if (reveal) { this.open(id); return true }
        await this.observe(id, this.principal, 'ordinary')
        return this.ownsRequest(controller, generation) && this.current() === id
      }
      if (!reveal) return false
      const opened = await this.create(controller.signal)
      return this.ownsRequest(controller, generation) && opened
    } catch {
      if (this.ownsRequest(controller, generation)) {
        if (readCompleted) this.report()
        else this.fail()
      }
      return false
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.pending === controller) { this.pending = undefined; this.publish() }
    }
  }

  /** Fence pending creation and late selection without releasing this employee's retained native drafts. */
  cancel(): void {
    this.visitSequence++
    this.pending?.abort()
    this.pending = undefined
    this.publish()
  }

  /**
   * Resolve a private lifetime for an authorized ordinary Session resource provider.
   * @returns Active input and cancellation lifetime; never a hook snapshot or persisted value.
   */
  ordinaryScope(): (OfficeOrdinaryInput & { readonly signal: AbortSignal }) | undefined {
    const ordinary = this.ordinaryInput()
    return ordinary ? { ...ordinary, signal: this.lifetime.signal } : undefined
  }

  /** Revalidate only the published identity after the native catalog changes; no draft or selection moves. */
  catalogChanged(): void {
    if (!this.disposed) this.publish()
  }

  /**
   * Read a committed generation after another window's notification, without adopting its selected input.
   * @param changedKey - Revision notification or null for an explicit refresh.
   * @returns Whether a current read completed; unrelated storage keys do nothing.
   */
  async synchronize(changedKey: string | null): Promise<boolean> {
    if (this.disposed || !this.principal || (changedKey !== null && changedKey !== OFFICE_NAVIGATION_SIGNAL_KEY)) return false
    return this.reload(this.generation, this.lifetime.signal)
  }

  /** Abort owned transactions and release each native input reference once. */
  dispose(): void {
    if (this.disposed) return
    void this.bind(null)
    this.lifetime.abort()
    this.disposed = true
    this.repository.dispose()
  }

  private async reload(generation: number, signal: AbortSignal): Promise<boolean> {
    const read = ++this.readSequence
    try {
      const result = await this.repository.read(signal)
      if (this.stale(generation) || read !== this.readSequence) return false
      this.accept(result.record)
      this.phase = 'ready'
      this.publish()
      return true
    } catch {
      if (!this.stale(generation) && read === this.readSequence) this.fail()
      return false
    }
  }

  private accept(record: OfficeNavigationRecord): void {
    if (record.revision < this.revision) return
    this.assertConsistent(record.data)
    this.data = record.data
    this.revision = record.revision
  }

  private assertConsistent(data: OfficeNavigationData): void {
    const entries = new Map(data.entries.map(entry => [entry.sessionId, entry]))
    for (const previous of this.data.entries) {
      const entry = entries.get(previous.sessionId)
      if (!entry || entry.principal !== previous.principal || entry.kind !== previous.kind) {
        throw new Error('Committed office conversation ownership changed')
      }
    }
  }

  private stale(generation: number): boolean {
    return this.disposed || generation !== this.generation || this.lifetime.signal.aborted
  }

  private ownsRequest(controller: AbortController, generation: number): boolean {
    return !this.stale(generation) && this.pending === controller && !controller.signal.aborted
  }

  private fail(): void {
    this.phase = 'unavailable'
    this.selected = undefined
    this.cancel()
    this.report('storage')
  }

  private publish(): void {
    this.state.set({
      hidden: this.data.entries.filter(entry => entry.principal !== this.principal).map(entry => entry.sessionId),
      restoring: this.pending !== undefined,
      selected: this.selected ?? null,
      phase: this.phase,
      ordinary: this.ordinaryInput(),
      generation: this.generation,
    })
  }

  private ordinaryInput(): OfficeOrdinaryInput | null {
    if (this.disposed || this.phase !== 'ready' || !this.principal || !this.ordinaryId || !this.available(this.ordinaryId)) return null
    const entry = this.data.entries.find(value => value.sessionId === this.ordinaryId)
    if (entry?.principal !== this.principal || entry.kind !== 'ordinary') return null
    const current = this.state.getSnapshot().ordinary
    return current?.sessionId === this.ordinaryId && current.principal === this.principal && current.generation === this.generation
      ? current : { sessionId: this.ordinaryId, principal: this.principal, generation: this.generation }
  }
}
