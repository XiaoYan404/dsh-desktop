/** Office gestures initialize private choice metadata without assigning ordinary Native workspace inputs. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { OfficeConversationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'

type OwnershipRemote = Pick<ClientRemote['office'], 'conversationLinks' | 'saveConversationLinks' | 'prepareNativeInput'>

/** Confirm one employee's office input boundary before the Native sender may admit its message. */
export class OfficeInputOwnership {
  private principal: OfficeMemberId | null = null
  private epoch = 0
  private disposed = false
  private readonly pending = new Map<OfficeConversationId, Promise<boolean>>()

  /** @param remote - Authenticated office metadata operations; callers never provide an actor. */
  constructor(private readonly remote: OwnershipRemote) {}

  /**
   * Withdraw older submission approvals when the employee changes.
   * @param principal - Current employee, or null on sign-out.
   */
  bind(principal: OfficeMemberId | null): void {
    if (this.disposed || this.principal === principal) return
    this.principal = principal
    this.epoch++
    this.pending.clear()
  }

  /**
   * Confirm an existing office selection or initialize its empty version without replacing user choices.
   * @param id - Captured Native input identity.
   * @param signal - This submission's lifetime; admitted metadata writes may finish after cancellation.
   * @param principal - Employee captured by this gesture before navigation or other preparations.
   * @returns A revocable approval after confirmed metadata, or undefined after failure or supersession.
   */
  async prepare(id: OfficeConversationId, signal: AbortSignal, principal: OfficeMemberId): Promise<(() => boolean) | undefined> {
    if (this.disposed || this.principal !== principal) return undefined
    const epoch = this.epoch
    const approve = () => this.current(epoch) && !signal.aborted
    if (!approve()) return undefined
    let pending = this.pending.get(id)
    if (!pending) {
      pending = this.initialize(id, epoch)
      this.pending.set(id, pending)
      void pending.finally(() => { if (this.pending.get(id) === pending) this.pending.delete(id) })
    }
    if (!await pending || !approve()) return undefined
    const prepared = await this.remote.prepareNativeInput(id)
    return prepared.ok && prepared.value.ok && approve() ? approve : undefined
  }

  /** Withdraw all pending approvals when the office extension unloads. */
  dispose(): void { this.disposed = true; this.principal = null; this.epoch++; this.pending.clear() }

  private current(epoch: number): boolean { return !this.disposed && this.principal !== null && this.epoch === epoch }

  private async initialize(id: OfficeConversationId, epoch: number): Promise<boolean> {
    try {
      const result = await this.remote.conversationLinks(id)
      if (!this.current(epoch) || !result.ok || !result.value.ok) return false
      const view = result.value.value
      if (view.meId !== this.principal || view.selection.conversationId !== id) return false
      if (view.selection.revision > 0) return true
      if (view.selection.integrations.length || view.selection.tools.length) return false
      const input = { conversationId: id, revision: 0, requestId: randomUUID(), kind: 'integrations' as const, integrations: [] }
      const saved = await this.remote.saveConversationLinks(input)
      if (!this.current(epoch)) return false
      if (saved.ok && saved.value.ok) return saved.value.value.conversationId === id
        && saved.value.value.requestId === input.requestId && saved.value.value.revision === 1
        && saved.value.value.integrations.length === 0 && saved.value.value.tools.length === 0
      // Another window may have established or edited the choice while initialization was pending.
      if (saved.ok && !saved.value.ok && saved.value.code === 'conflict') {
        const latest = await this.remote.conversationLinks(id)
        return this.current(epoch) && latest.ok && latest.value.ok && latest.value.value.meId === this.principal
          && latest.value.value.selection.conversationId === id && latest.value.value.selection.revision > 0
      }
      return false
    } catch { return false }
  }
}
