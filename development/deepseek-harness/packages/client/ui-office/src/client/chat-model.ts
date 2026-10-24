/** Confirmed private conversations, per-recipient send failures and idempotent retries. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { withoutKey } from './values.ts'
import type {
  ClientRemote,
  RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeChatMessage,
  OfficeChatView,
  OfficeMemberId,
  OfficeMessageId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

interface ChatSnapshot {
  readonly view: OfficeChatView | null
  readonly loading: boolean
  readonly loadingOlder: boolean
  readonly pending: readonly OfficeMemberId[]
  readonly sendErrors: Readonly<Record<string, OfficeKey>>
  readonly error: OfficeKey | null
}
type ChatRemote = Pick<
  ClientRemote['office'],
  'chat' | 'sendMessage' | 'readChat'
>

/** One model belongs to one office identity and is fenced at plugin unload. */
export class OfficeChatModel {
  /** Authorized server data and request state; unsent drafts belong to the panel store. */
  readonly state = createSnapshotStore<ChatSnapshot>({
    view: null,
    loading: true,
    loadingOlder: false,
    pending: [],
    sendErrors: {},
    error: null,
  })
  private peer: OfficeMemberId | undefined
  private generation = 0
  private disposed = false
  private principal: OfficeMemberId | null | undefined
  private identityEpoch = 0
  private readonly retries = new Map<
    OfficeMemberId,
    { id: OfficeMessageId; text: string }
  >()
  private readonly reading = new Set<OfficeMemberId>()

  constructor(
    private readonly remote: ChatRemote,
    private readonly newId = () => randomUUID() as OfficeMessageId,
  ) {}

  /**
   * Fence data, retries and pending replies when the office identity changes.
   * @param principal - Confirmed employee, or null after membership denial.
   */
  bind(principal: OfficeMemberId | null): void {
    if (this.principal === principal) return
    this.principal = principal
    this.identityEpoch++
    this.generation++
    this.peer = undefined
    this.retries.clear()
    this.reading.clear()
    this.state.set({
      view: null,
      loading: principal !== null,
      loadingOlder: false,
      pending: [],
      sendErrors: {},
      error: null,
    })
  }

  /**
   * Refresh current threads and conversation without accepting stale navigation responses.
   * @param peer - Conversation identity, or null for just the private list.
   * @returns After a confirmed read or a localized failure.
   */
  async load(peer: OfficeMemberId | null = this.peer ?? null): Promise<void> {
    if (this.isDisposed() || this.principal === null) return
    this.peer = peer ?? undefined
    const generation = ++this.generation
    this.patch({ loading: true, error: null })
    try {
      const result = await this.remote.chat(this.peer, undefined)
      if (this.isDisposed() || generation !== this.generation) return
      const error = this.denial(result)
      if (error) {
        this.fail(error)
        return
      }
      if (!result.ok || !result.value.ok) return
      const latest = result.value.value
      if (this.principal !== undefined && latest.meId !== this.principal) {
        this.fail('forbidden')
        return
      }
      const old = this.state.getSnapshot().view
      let view = latest
      if (
        old &&
        latest.peer &&
        old.peer?.id === latest.peer.id &&
        old.messages.length > 0 &&
        (old.messages[0]?.sequence ?? 0) <
          (latest.messages[0]?.sequence ?? Infinity)
      ) {
        view = {
          ...latest,
          messages: this.merge(old.messages, latest.messages),
          hasMore: old.hasMore,
        }
      }
      this.patch({ view, loading: false, error: null })
    } catch {
      if (!this.isDisposed() && generation === this.generation)
        this.fail('unavailable')
    }
  }

  /** Load an older bounded page while preserving a newer refresh or ignoring a switched conversation. */
  async older(): Promise<void> {
    const current = this.state.getSnapshot()
    const peer = this.peer
    const epoch = this.identityEpoch
    const before = current.view?.messages[0]?.sequence
    if (
      this.isDisposed() ||
      current.loadingOlder ||
      !current.view?.hasMore ||
      !peer ||
      !before
    )
      return
    this.patch({ loadingOlder: true })
    try {
      const result = await this.remote.chat(peer, before)
      if (
        this.isDisposed() ||
        epoch !== this.identityEpoch ||
        this.peer !== peer
      )
        return
      const error = this.denial(result)
      if (error) {
        this.fail(error)
        return
      }
      const view = this.state.getSnapshot().view
      if (result.ok && result.value.ok && view?.peer?.id === peer)
        this.patch({
          view: {
            ...view,
            messages: this.merge(result.value.value.messages, view.messages),
            hasMore: result.value.value.hasMore,
          },
        })
    } catch {
      if (
        !this.isDisposed() &&
        epoch === this.identityEpoch &&
        this.peer === peer
      )
        this.fail('unavailable')
    } finally {
      if (!this.isDisposed() && epoch === this.identityEpoch)
        this.patch({ loadingOlder: false })
    }
  }

  /**
   * Preserve one retry identity for an unchanged draft after an uncertain transport result.
   * @param peer - Recipient captured when sending, independent of later navigation.
   * @param text - Draft captured when sending; the caller conditionally clears only that draft.
   * @returns Whether the Host confirmed this exact message.
   */
  async send(peer: OfficeMemberId, text: string): Promise<boolean> {
    const current = this.state.getSnapshot()
    if (
      this.isDisposed() ||
      this.principal === null ||
      !text.trim() ||
      current.pending.includes(peer)
    )
      return false
    const epoch = this.identityEpoch
    const retry = this.retries.get(peer)
    const input = retry?.text === text ? retry : { id: this.newId(), text }
    this.retries.set(peer, input)
    const errors = withoutKey(current.sendErrors, peer)
    this.patch({ pending: [...current.pending, peer], sendErrors: errors })
    try {
      const result = await this.remote.sendMessage({
        ...input,
        recipientId: peer,
      })
      if (this.isDisposed() || epoch !== this.identityEpoch) return false
      const error = this.denial(result)
      if (error) {
        this.patch({
          sendErrors: { ...this.state.getSnapshot().sendErrors, [peer]: error },
        })
        if (error === 'forbidden' || error === 'unauthenticated')
          this.fail(error)
        return false
      }
      this.retries.delete(peer)
      await this.load()
      return !this.isDisposed() && epoch === this.identityEpoch
    } catch {
      if (!this.isDisposed() && epoch === this.identityEpoch)
        this.patch({
          sendErrors: {
            ...this.state.getSnapshot().sendErrors,
            [peer]: 'unavailable',
          },
        })
      return false
    } finally {
      if (!this.isDisposed() && epoch === this.identityEpoch)
        this.patch({
          pending: this.state.getSnapshot().pending.filter(id => id !== peer),
        })
    }
  }

  /**
   * Mark an observed message sequence without duplicating in-flight acknowledgements.
   * @param peer - Displayed conversation.
   * @param through - Observed message sequence.
   * @returns After acknowledgement and refresh, or a visible failure.
   */
  async read(peer: OfficeMemberId, through: number): Promise<void> {
    if (this.isDisposed() || this.principal === null || this.reading.has(peer))
      return
    const epoch = this.identityEpoch
    this.reading.add(peer)
    try {
      const result = await this.remote.readChat(peer, through)
      if (this.isDisposed() || epoch !== this.identityEpoch) return
      const error = this.denial(result)
      if (error) {
        this.fail(error)
        return
      }
      await this.load()
    } catch {
      if (!this.isDisposed() && epoch === this.identityEpoch)
        this.fail('unavailable')
    } finally {
      if (epoch === this.identityEpoch) this.reading.delete(peer)
    }
  }

  /** Ignore all late responses and discard retry payloads at identity/plugin unload. */
  dispose(): void {
    this.disposed = true
    this.generation++
    this.retries.clear()
    this.reading.clear()
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  private patch(value: Partial<ChatSnapshot>): void {
    this.state.set({ ...this.state.getSnapshot(), ...value })
  }
  private fail(error: OfficeKey): void {
    if (error === 'unauthenticated') this.bind(null)
    const denied = error === 'forbidden' || error === 'unauthenticated'
    if (denied) this.generation++
    this.patch({ error, loading: false, ...(denied ? { view: null } : {}) })
  }
  private denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
    return !result.ok
      ? 'unavailable'
      : !result.value.ok
        ? result.value.code
        : null
  }
  private merge(
    first: readonly OfficeChatMessage[],
    second: readonly OfficeChatMessage[],
  ): OfficeChatMessage[] {
    return [
      ...new Map(
        [...first, ...second].map(entry => [entry.id, entry]),
      ).values(),
    ].sort((a, b) => a.sequence - b.sequence)
  }
}
