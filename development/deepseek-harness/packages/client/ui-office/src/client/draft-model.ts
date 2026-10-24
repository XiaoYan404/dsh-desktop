/** Durable private drafts with local editing, reviewed versions and explicit conflict resolution. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { recordValue, withoutKey } from './values.ts'
import type {
  ClientRemote,
  RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeChatDraft,
  OfficeChatDraftInput,
  OfficeMemberId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'
import { OfficeChatDraftStore } from './store.ts'

interface DraftStatus {
  readonly loading: boolean
  readonly ready: boolean
  readonly pending: readonly OfficeMemberId[]
  readonly unsaved: readonly OfficeMemberId[]
  readonly errors: Readonly<Record<string, OfficeKey>>
  readonly error: OfficeKey | null
}
type DraftRemote = Pick<ClientRemote['office'], 'chatDrafts' | 'saveChatDraft'>
const initial = (): DraftStatus => ({
  loading: true,
  ready: false,
  pending: [],
  unsaved: [],
  errors: {},
  error: null,
})

/** Drafts belong to one confirmed employee; no raw draft is put in browser storage. */
export class OfficeChatDraftModel {
  private readonly drafts = new OfficeChatDraftStore()
  /** Editable text indexed by contact; retained during failed saves and window conflicts. */
  readonly state = this.drafts.state
  /** Loading, unsaved text and per-contact failures make durability visible. */
  readonly status = createSnapshotStore<DraftStatus>(initial())
  private principal: OfficeMemberId | null = null
  private epoch = 0
  private readGeneration = 0
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly versions = new Map<OfficeMemberId, number>()
  private readonly dirty = new Set<OfficeMemberId>()
  private readonly pending = new Set<OfficeMemberId>()
  private readonly requests = new Map<OfficeMemberId, OfficeChatDraftInput>()

  constructor(
    private readonly remote: DraftRemote,
    private readonly newId = () => randomUUID(),
  ) {}

  /**
   * Discard the previous employee's local text before any new identity can render.
   * @param principal - Confirmed employee, or null when authorization is lost.
   */
  bind(principal: OfficeMemberId | null): void {
    if (this.disposed || principal === this.principal) return
    this.epoch++
    this.readGeneration++
    this.principal = principal
    this.cancelTimer()
    this.versions.clear()
    this.dirty.clear()
    this.pending.clear()
    this.requests.clear()
    this.drafts.bind(principal)
    this.status.set({ ...initial(), loading: principal !== null })
    if (principal) void this.load()
  }

  /** Re-read saved drafts, updating only contacts that have no local unsaved edits. */
  async load(): Promise<void> {
    if (this.disposed || !this.principal) return
    const epoch = this.epoch
    const generation = ++this.readGeneration
    this.patch({ loading: !this.status.getSnapshot().ready, error: null })
    try {
      const result = await this.remote.chatDrafts()
      if (this.stale(epoch) || generation !== this.readGeneration) return
      const error = this.denial(result)
      if (error) {
        this.fail(error)
        return
      }
      if (!result.ok || !result.value.ok) return
      const view = result.value.value
      if (view.meId !== this.principal) {
        this.fail('forbidden')
        return
      }
      const saved = new Map(view.drafts.map(entry => [entry.peerId, entry]))
      for (const peer of new Set([...this.versions.keys(), ...saved.keys()])) {
        if (this.dirty.has(peer) || this.pending.has(peer)) continue
        const entry = saved.get(peer)
        this.versions.set(peer, entry?.revision ?? 0)
        this.drafts.set(peer, entry?.text ?? '')
      }
      this.patch({ ready: true, loading: false, error: null })
    } catch {
      if (!this.stale(epoch) && generation === this.readGeneration)
        this.fail('unavailable')
    }
  }

  /**
   * Edit one contact and debounce durable saves; editing during a save remains possible.
   * @param peer - Contact captured by the composer.
   * @param text - Exact unsent text, including whitespace and line breaks.
   */
  set(peer: OfficeMemberId, text: string): void {
    if (
      this.disposed ||
      !this.principal ||
      !this.status.getSnapshot().ready ||
      text.length > 16_000
    )
      return
    this.drafts.set(peer, text)
    this.dirty.add(peer)
    this.patch({ unsaved: [...this.dirty] })
    this.schedule()
  }

  /**
   * Clear only the text that was confirmed sent, preserving newer typing.
   * @param peer - Recipient of the confirmed send.
   * @param expected - Exact text submitted to messaging.
   */
  clear(peer: OfficeMemberId, expected: string): void {
    if (recordValue(this.state.getSnapshot(), peer) === expected) this.set(peer, '')
  }

  /**
   * Ignore an earlier account's completed send before conditionally clearing captured text.
   * @param principal - Account captured before awaiting message confirmation.
   * @param peer - Recipient captured at that same user gesture.
   * @param expected - Exact submitted caption, preserving later text edits.
   */
  clearFor(principal: OfficeMemberId, peer: OfficeMemberId, expected: string): void {
    if (this.principal === principal) this.clear(peer, expected)
  }

  /** Immediately admit all unsaved contacts except explicit unresolved failures. */
  async flush(): Promise<void> {
    this.cancelTimer()
    await Promise.all([...this.dirty].map(peer => this.save(peer)))
  }

  /**
   * Retry the same uncertain write identity without risking duplicate commits.
   * @param peer - Contact whose save failed.
   */
  async retry(peer: OfficeMemberId): Promise<void> {
    if (recordValue(this.status.getSnapshot().errors, peer) === 'conflict') return
    const errors = withoutKey(this.status.getSnapshot().errors, peer)
    this.patch({ errors })
    await this.save(peer)
  }

  /**
   * Resolve a simultaneous-window conflict only after an explicit user choice.
   * @param peer - Conflicting contact.
   * @param keepLocal - True saves this window's input against the latest reviewed version.
   */
  async resolve(peer: OfficeMemberId, keepLocal: boolean): Promise<void> {
    if (this.disposed || !this.principal || this.pending.has(peer)) return
    const epoch = this.epoch
    const original = recordValue(this.state.getSnapshot(), peer) ?? ''
    try {
      const result = await this.remote.chatDrafts()
      if (this.stale(epoch)) return
      const error = this.denial(result)
      if (error) {
        this.fail(error)
        return
      }
      if (!result.ok || !result.value.ok) return
      if (result.value.value.meId !== this.principal) {
        this.fail('forbidden')
        return
      }
      const saved = result.value.value.drafts.find(
        entry => entry.peerId === peer,
      )
      // A discard choice must not remove text typed while the read was in flight.
      if (!keepLocal && (recordValue(this.state.getSnapshot(), peer) ?? '') !== original)
        return
      this.versions.set(peer, saved?.revision ?? 0)
      this.requests.delete(peer)
      const errors = withoutKey(this.status.getSnapshot().errors, peer)
      if (!keepLocal) {
        this.drafts.set(peer, saved?.text ?? '')
        this.dirty.delete(peer)
      }
      this.patch({ errors, unsaved: [...this.dirty], error: null })
      if (keepLocal) await this.save(peer)
    } catch {
      if (!this.stale(epoch)) this.fail('unavailable')
    }
  }

  /** Fence late reads/writes and clear private in-memory text at plugin unload. */
  dispose(): void {
    this.disposed = true
    this.epoch++
    this.readGeneration++
    this.cancelTimer()
    this.drafts.dispose()
    this.versions.clear()
    this.dirty.clear()
    this.pending.clear()
    this.requests.clear()
    this.status.set({ ...initial(), loading: false })
  }

  private async save(peer: OfficeMemberId): Promise<void> {
    if (
      this.disposed ||
      !this.principal ||
      !this.status.getSnapshot().ready ||
      !this.dirty.has(peer) ||
      this.pending.has(peer) ||
      recordValue(this.status.getSnapshot().errors, peer)
    )
      return
    const epoch = this.epoch
    const previous = this.requests.get(peer)
    // Finish an uncertain earlier write before admitting a different payload.
    const input = previous ?? {
      peerId: peer,
      text: recordValue(this.state.getSnapshot(), peer) ?? '',
      revision: this.versions.get(peer) ?? 0,
      requestId: this.newId(),
    }
    this.requests.set(peer, input)
    this.pending.add(peer)
    this.patch({ pending: [...this.pending] })
    try {
      const result = await this.remote.saveChatDraft(input)
      if (this.stale(epoch)) return
      const error = this.denial(result)
      if (error) {
        if (error === 'forbidden' || error === 'unauthenticated')
          this.fail(error)
        else
          this.patch({
            errors: { ...this.status.getSnapshot().errors, [peer]: error },
          })
        return
      }
      if (!result.ok || !result.value.ok) return
      const saved: OfficeChatDraft = result.value.value
      if (
        saved.peerId !== peer ||
        saved.text !== input.text ||
        saved.revision !== input.revision + 1
      ) {
        this.patch({
          errors: {
            ...this.status.getSnapshot().errors,
            [peer]: 'unavailable',
          },
        })
        return
      }
      this.versions.set(peer, saved.revision)
      this.requests.delete(peer)
      if ((recordValue(this.state.getSnapshot(), peer) ?? '') === input.text)
        this.dirty.delete(peer)
      this.patch({ unsaved: [...this.dirty] })
    } catch {
      if (!this.stale(epoch))
        this.patch({
          errors: {
            ...this.status.getSnapshot().errors,
            [peer]: 'unavailable',
          },
        })
    } finally {
      if (!this.stale(epoch)) {
        this.pending.delete(peer)
        this.patch({ pending: [...this.pending] })
        if (this.dirty.has(peer) && !recordValue(this.status.getSnapshot().errors, peer))
          this.schedule()
      }
    }
  }

  private patch(value: Partial<DraftStatus>): void {
    this.status.set({ ...this.status.getSnapshot(), ...value })
  }
  private stale(epoch: number): boolean {
    return this.disposed || epoch !== this.epoch
  }
  private schedule(): void {
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 350)
  }
  private cancelTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
  private denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
    return !result.ok
      ? 'unavailable'
      : !result.value.ok
        ? result.value.code
        : null
  }
  private fail(error: OfficeKey): void {
    if (error === 'forbidden' || error === 'unauthenticated') this.bind(null)
    this.patch({ loading: false, error })
  }
}
