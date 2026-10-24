/** Session-specific native skill discovery and explicitly unsent office requests. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeMember, OfficeToolReference } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OfficeKey } from './locales.ts'

interface ToolsSnapshot {
  readonly sessionId: SessionId | null
  readonly skills: readonly SkillEntry[]
  readonly loading: boolean
  readonly preparing: boolean
  readonly error: OfficeKey | null
}

/** Native invocations are checked again before insertion; templates are ordinary user-authored requests. */
export type OfficeToolRequest =
  | { readonly kind: 'skill'; readonly name: string; readonly requirements: string }
  | { readonly kind: 'template'; readonly name: string; readonly prompt: string }

/** One mounted employee owns discovery and draft preparation, including every outstanding callback. */
export class OfficeToolsModel {
  /** Metadata only. Native input documents, references and file handles remain with Conversation. */
  readonly state = createSnapshotStore<ToolsSnapshot>({
    sessionId: null, skills: [], loading: false, preparing: false, error: null,
  })
  private identity: string | null = null
  private read: AbortController | undefined
  private pending: AbortController | undefined
  private disposed = false

  /**
   * @param list - Native Session catalog read, bounded by the caller's cancellation signal.
   * @param prepare - Native input adoption and navigation; it must never submit the draft.
   * @param notify - Result notice hosted outside the page so it survives navigation.
   */
  constructor(
    private readonly list: (id: SessionId, signal: AbortSignal) => Promise<readonly SkillEntry[]>,
    private readonly prepare: (id: SessionId | null, prompt: string, signal: AbortSignal, tool: OfficeToolReference) => Promise<boolean>,
    private readonly notify: (key: OfficeKey, success: boolean) => void,
  ) {}

  /**
   * Release old-account results before publishing another employee or role.
   * @param member - Confirmed office principal, or null after authorization loss.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    const identity = member ? `${member.id}:${member.role}` : null
    if (this.disposed || this.identity === identity) return
    this.identity = identity
    this.read?.abort()
    this.read = undefined
    this.cancel()
    this.state.set({ sessionId: null, skills: [], loading: false, preparing: false, error: null })
  }

  /**
   * Discover the exact native Session composition without creating or prompting an Agent.
   * @param id - Last selected employee-owned Conversation, or null before one has been selected.
   * @returns Completion after discovery or a visible query failure; obsolete responses never publish.
   */
  async load(id: SessionId | null): Promise<void> {
    if (this.disposed || !this.identity || this.pending) return
    this.read?.abort()
    const read = new AbortController()
    this.read = read
    const previous = this.state.getSnapshot()
    this.state.set({
      ...previous, sessionId: id, skills: previous.sessionId === id ? previous.skills : [], loading: id !== null, error: null,
    })
    if (id === null) { this.read = undefined; return }
    try {
      const skills = await this.list(id, read.signal)
      if (this.read !== read || read.signal.aborted || this.isDisposed()) return
      this.patch({ skills, loading: false })
    } catch {
      if (this.read === read && !read.signal.aborted && !this.isDisposed()) {
        this.patch({ loading: false, error: 'toolsCatalogUnavailable' })
      }
    } finally {
      if (this.read === read) this.read = undefined
    }
  }

  /**
   * Prepare the user's request through the native input owner, without submitting it.
   * @param request - Selected native skill or localized office task template and captured requirements.
   * @returns True only after the current employee's native Conversation accepted and opened its draft.
   */
  async use(request: OfficeToolRequest): Promise<boolean> {
    if (this.disposed || !this.identity || this.pending) return false
    const id = this.state.getSnapshot().sessionId
    if (request.kind === 'skill' && (!id || !request.requirements.trim())) return false
    if (request.kind === 'template' && !request.prompt.trim()) return false
    const pending = new AbortController()
    this.pending = pending
    this.read?.abort()
    this.read = undefined
    this.patch({ loading: false, preparing: true, error: null })
    try {
      if (request.kind === 'skill' && id) {
        const skills = await this.list(id, pending.signal)
        if (!this.current(pending)) return false
        this.patch({ skills })
        if (!skills.some(skill => skill.name === request.name)) {
          this.patch({ error: 'toolsSkillUnavailable' })
          return false
        }
      }
      if (!this.current(pending)) return false
      const prompt = request.kind === 'skill' ? `/${request.name} ${request.requirements.trim()}` : request.prompt.trim()
      const prepared = await this.prepare(id, prompt, pending.signal, { kind: request.kind, name: request.name })
      if (!this.current(pending)) return false
      if (!prepared) { this.patch({ error: 'toolsDraftUnavailable' }); return false }
      this.notify('toolsPrepared', true)
      return true
    } catch {
      if (this.current(pending)) this.patch({ error: 'toolsDraftUnavailable' })
      return false
    } finally {
      if (this.pending === pending) {
        this.pending = undefined
        this.patch({ preparing: false })
      }
    }
  }

  /** Cancel preparation when the user leaves, signs out or closes the request form. */
  cancel(): void {
    this.pending?.abort()
    this.pending = undefined
    this.patch({ preparing: false, error: null })
  }

  /** Withdraw every in-flight result and metadata snapshot on plugin unload. */
  dispose(): void {
    this.bind(null)
    this.disposed = true
  }

  private current(pending: AbortController): boolean {
    return !this.disposed && this.pending === pending && !pending.signal.aborted
  }
  private isDisposed(): boolean { return this.disposed }
  private patch(patch: Partial<ToolsSnapshot>): void {
    this.state.set({ ...this.state.getSnapshot(), ...patch })
  }
}
