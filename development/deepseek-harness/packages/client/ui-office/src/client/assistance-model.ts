/** Recheck office visibility before opening a native, account-qualified item conversation. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeItem, OfficeItemId, OfficeMemberId, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OfficeSection } from './contracts.ts'
import type { OfficeKey } from './locales.ts'

interface ItemContext {
  readonly item: OfficeItem
  readonly creator: string
  readonly owner: string
  readonly source: OfficeSection
  readonly date: string
}

/** One mounted employee owns pending opens and authorized context-card snapshots. */
export class OfficeAssistanceModel {
  /** Plain context data only; native services continue to own all input, attachments and history. */
  readonly state = createSnapshotStore<{
    readonly openingId: OfficeItemId | null
    readonly contexts: Readonly<Record<string, ItemContext>>
  }>({ openingId: null, contexts: {} })
  private principal: OfficeMemberId | null | undefined
  private pending: AbortController | undefined
  private disposed = false
  private readonly retained = new Map<SessionId, () => void>()

  constructor(
    private readonly remote: Pick<ClientRemote['office'], 'view'>,
    private readonly current: () => OfficeView | null,
    private readonly openSession: (key: string, prompt: string, signal: AbortSignal) => Promise<SessionId | undefined>,
    private readonly t: (key: OfficeKey) => string,
    private readonly report: (key: OfficeKey) => void,
    private readonly retain: (sessionId: SessionId) => () => void,
  ) {}

  /**
   * Drop another employee's context and fence their pending navigation.
   * @param principal - Confirmed employee, or null after losing office authentication.
   */
  bind(principal: OfficeMemberId | null): void {
    if (principal === this.principal) return
    this.principal = principal
    this.cancel()
    this.releaseSessions()
    this.state.set({ openingId: null, contexts: {} })
  }

  /**
   * Fetch current authorized item data and open its distinct native input without sending.
   * @param id - Directory-independent office item identity.
   * @param source - Office panel to return to, retaining its own declared view store.
   * @returns True after the linked native Session opens.
   */
  async open(id: OfficeItemId, source: OfficeSection): Promise<boolean> {
    const principal = this.principal
    if (this.disposed || !principal || this.pending) return false
    const controller = new AbortController()
    this.pending = controller
    this.state.set({ ...this.state.getSnapshot(), openingId: id })
    try {
      const result = await this.remote.view(this.current()?.day.date)
      if (!this.isCurrent(controller)) return false
      if (!result.ok) { this.report('unavailable'); return false }
      if (!result.value.ok) { this.report(result.value.code); return false }
      const view = result.value.value
      if (view.me.id !== principal) { this.report('unauthenticated'); return false }
      const item = view.items.find(entry => entry.id === id)
      if (!item) { this.report('not_found'); return false }
      const name = (memberId: OfficeMemberId) => view.members.find(member => member.id === memberId)?.name ?? memberId
      const context: ItemContext = { item, creator: name(item.creatorId), owner: name(item.ownerId), source, date: view.day.date }
      const prompt = `${this.t('itemPromptIntro')}\n\n${JSON.stringify({
        id: item.id, kind: item.kind, title: item.title, description: item.description,
        creator: context.creator, owner: context.owner, date: item.date, time: item.time, endTime: item.endTime,
        location: item.location, status: item.status,
        participants: item.participants.map(person => ({ name: name(person.memberId), reply: person.reply })),
      }, null, 2)}`
      const key = JSON.stringify(['office.item.v1', principal, id])
      const sessionId = await this.openSession(key, prompt, controller.signal)
      if (!this.isCurrent(controller) || !sessionId) return false
      if (!this.retained.has(sessionId)) this.retained.set(sessionId, this.retain(sessionId))
      this.state.set({ openingId: null, contexts: { ...this.state.getSnapshot().contexts, [sessionId]: context } })
      return true
    } catch {
      if (this.isCurrent(controller)) this.report('unavailable')
      return false
    } finally {
      if (this.pending === controller) {
        this.pending = undefined
        this.state.set({ ...this.state.getSnapshot(), openingId: null })
      }
    }
  }

  /** Fence a pending open when an employee navigates elsewhere. */
  cancel(): void {
    const pending = this.pending
    this.pending = undefined
    pending?.abort()
    this.state.set({ ...this.state.getSnapshot(), openingId: null })
  }

  /** Release pending navigation and account-private cards on plugin unload. */
  dispose(): void {
    this.disposed = true
    this.cancel()
    this.releaseSessions()
    this.state.set({ openingId: null, contexts: {} })
  }

  private isCurrent(controller: AbortController): boolean {
    return !this.disposed && this.pending === controller && !controller.signal.aborted
  }

  private releaseSessions(): void {
    for (const release of this.retained.values()) release()
    this.retained.clear()
  }
}
