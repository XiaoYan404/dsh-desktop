/** Current-employee conversation associations; native input and execution keep their existing owners. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConversationId, OfficeConversationLinks, OfficeConversationLinksInput, OfficeConversationLinksView,
  OfficeMember, OfficeToolReference } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

interface AssociationSnapshot {
  readonly conversationId: OfficeConversationId | null
  readonly view: OfficeConversationLinksView | null
  readonly loading: boolean
  readonly busy: boolean
  readonly error: OfficeKey | null
}

/** A confirmed operation, a definitive business denial, or an uncertain acknowledgement requiring the original retry. */
export type AssociationSaveOutcome = { readonly ok: true } | {
  readonly ok: false
  readonly error: OfficeKey | null
  readonly uncertain: boolean
}
type AssociationRemote = Pick<ClientRemote['office'], 'conversationLinks' | 'saveConversationLinks'>

/** One mounted principal and target own all reads, edits and automatic tool choices. */
export class OfficeAssociationsModel {
  /** Plain versioned metadata only; no credentials, file handles, native documents or service objects are published. */
  readonly state = createSnapshotStore<AssociationSnapshot>({
    conversationId: null, view: null, loading: false, busy: false, error: null,
  })
  private memberId: OfficeMember['id'] | null = null
  private identity: string | null = null
  private epoch = 0
  private read = 0
  private disposed = false
  private automatic: OfficeConversationLinksInput | null = null

  /**
   * @param remote - Authenticated employee BFF with the association protocol.
   * @param notify - Action results hosted outside the current dialog; authorization denials also clear office identity.
   */
  constructor(private readonly remote: AssociationRemote, private readonly notify: (key: OfficeKey, success: boolean) => void) {}

  /**
   * Withdraw the previous employee's choices before adopting another account or authority role.
   * @param member - Confirmed current employee, or null while signed out.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    const identity = member ? `${member.id}:${member.role}` : null
    if (this.disposed || this.identity === identity) return
    this.identity = identity
    this.memberId = member?.id ?? null
    this.clear()
  }

  /**
   * Read the selected native conversation without allowing another target's late response to replace it.
   * @param id - Captured native logical conversation identity.
   * @param force - Supersede an outstanding read after an explicit reload or confirmed write.
   * @returns Fresh accepted metadata, or null after failure, authorization loss or supersession.
   */
  async load(id: OfficeConversationId, force = false): Promise<OfficeConversationLinksView | null> {
    if (this.disposed || !this.identity) return null
    if (this.state.getSnapshot().conversationId !== id) {
      this.clear()
      this.patch({ conversationId: id })
    }
    if (!force && (this.state.getSnapshot().loading || this.state.getSnapshot().busy)) return null
    const epoch = this.epoch
    const read = ++this.read
    this.patch({ loading: true })
    try {
      const result = await this.remote.conversationLinks(id)
      if (!this.current(epoch, id) || read !== this.read) return null
      const denial = this.denial(result)
      if (denial) { this.fail(denial); return null }
      if (!result.ok || !result.value.ok) return null
      const view = result.value.value
      if (view.meId !== this.memberId || view.selection.conversationId !== id ||
        view.selection.revision < (this.state.getSnapshot().view?.selection.revision ?? 0)) {
        this.patch({ loading: false, error: 'associationUnavailable' })
        return null
      }
      this.patch({ view, loading: false, error: null })
      return view
    } catch {
      if (this.current(epoch, id) && read === this.read) this.patch({ loading: false, error: 'associationUnavailable' })
      return null
    }
  }

  /**
   * Commit the exact reviewed request without replacing its version with a background read.
   * @param input - Original list, review version and UUID retained by the form across uncertain retries.
   * @param announce - Show a success notice for an explicit association edit; automatic tool preparation owns its notice.
   * @returns A confirmed commit or a current-target failure; obsolete callbacks never publish results.
   */
  async save(input: OfficeConversationLinksInput, announce = true): Promise<AssociationSaveOutcome> {
    const id = input.conversationId
    const snapshot = this.state.getSnapshot()
    if (this.disposed || !this.identity || snapshot.busy || snapshot.conversationId !== id || !snapshot.view) {
      return { ok: false, error: null, uncertain: false }
    }
    const epoch = this.epoch
    this.read++
    this.patch({ busy: true, loading: false, error: null })
    try {
      const result = await this.remote.saveConversationLinks(input)
      if (!this.current(epoch, id)) return { ok: false, error: null, uncertain: false }
      const denial = this.denial(result)
      if (denial) {
        const uncertain = !result.ok
        if (denial === 'conflict') await this.load(id, true)
        if (this.current(epoch, id)) this.fail(uncertain ? 'associationSaveUnknown' : denial)
        return { ok: false, error: this.current(epoch, id) ? uncertain ? 'associationSaveUnknown' : denial : null, uncertain }
      }
      if (!result.ok || !result.value.ok) return { ok: false, error: null, uncertain: false }
      const saved = result.value.value
      const sameChoice = input.kind === 'tools' ? JSON.stringify(saved.tools) === JSON.stringify(input.tools)
        : JSON.stringify(saved.integrations) === JSON.stringify(input.integrations)
      if (saved.conversationId !== id || saved.requestId !== input.requestId || saved.revision !== input.revision + 1 || !sameChoice) {
        this.patch({ error: 'associationSaveUnknown' })
        return { ok: false, error: 'associationSaveUnknown', uncertain: true }
      }
      this.accept(saved)
      if (announce) this.notify('associationSaved', true)
      await this.load(id, true)
      return this.current(epoch, id) ? { ok: true } : { ok: false, error: null, uncertain: false }
    } catch {
      if (this.current(epoch, id)) this.patch({ error: 'associationSaveUnknown' })
      return { ok: false, error: this.current(epoch, id) ? 'associationSaveUnknown' : null, uncertain: this.current(epoch, id) }
    } finally {
      if (this.current(epoch, id)) this.patch({ busy: false })
    }
  }

  /**
   * Associate a user-selected tool before preparing its native input, preserving other reviewed choices.
   * @param id - Real target conversation prepared by the native navigation owner.
   * @param tool - Explicitly selected installed skill or request template.
   * @param signal - Caller navigation/account lifetime; an admitted write can still commit after cancellation.
   * @returns True only after the current target's confirmed association; preparation must not proceed after false.
   */
  async addTool(id: OfficeConversationId, tool: OfficeToolReference, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.disposed || !this.identity) return false
    const view = await this.load(id, true)
    if (!view || this.cancelled(signal)) return false
    const epoch = this.epoch
    if (this.automatic) {
      const original = this.automatic
      const confirmed = await this.save(original, false)
      if (!this.current(epoch, id) || this.cancelled(signal)) return false
      if (!confirmed.ok) { if (!confirmed.uncertain) this.automatic = null; return false }
      this.automatic = null
      if (original.kind === 'tools' && original.tools.some(value => value.kind === tool.kind && value.name === tool.name)) return true
    }
    const latest = this.state.getSnapshot().view
    if (!latest || this.cancelled(signal)) return false
    if (latest.selection.tools.some(value => value.kind === tool.kind && value.name === tool.name)) return true
    const tools = [...latest.selection.tools, tool]
    const input: OfficeConversationLinksInput = { conversationId: id, kind: 'tools', tools,
      revision: latest.selection.revision, requestId: randomUUID() }
    const result = await this.save(input, false)
    if (!this.current(epoch, id)) return false
    this.automatic = !result.ok && result.uncertain ? input : null
    return !this.cancelled(signal) && result.ok
  }

  /** Withdraw the current target when its employee or plugin no longer owns the display. */
  clear(): void {
    this.epoch++
    this.read++
    this.automatic = null
    this.state.set({ conversationId: null, view: null, loading: false, busy: false, error: null })
  }

  /** Fence every late callback and release private association metadata when the optional plugin unloads. */
  dispose(): void { this.clear(); this.disposed = true }

  private current(epoch: number, id: OfficeConversationId): boolean {
    return !this.disposed && this.identity !== null && epoch === this.epoch && this.state.getSnapshot().conversationId === id
  }
  private cancelled(signal: AbortSignal): boolean { return signal.aborted }
  private accept(selection: OfficeConversationLinks): void {
    const view = this.state.getSnapshot().view
    if (view && selection.revision >= view.selection.revision) this.patch({ view: { ...view, selection }, error: null })
  }
  private fail(error: OfficeKey): void {
    if (error === 'unauthenticated' || error === 'forbidden') { this.bind(null); this.notify(error, false); return }
    this.patch({ loading: false, error })
  }
  private denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
    return !result.ok ? 'associationUnavailable' : !result.value.ok ? result.value.code : null
  }
  private patch(patch: Partial<AssociationSnapshot>): void { this.state.set({ ...this.state.getSnapshot(), ...patch }) }
}
