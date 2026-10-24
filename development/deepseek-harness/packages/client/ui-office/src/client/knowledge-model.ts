/** Employee-bound knowledge commands discard late replies and retain exact mutation retries. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeDriveId, OfficeDriveDownloadInfo, OfficeMember, OfficeKnowledgeCitation,
  OfficeKnowledgePublication, OfficeKnowledgePublishInput, OfficeKnowledgeWithdrawInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

type Remote = Pick<ClientRemote['office'], 'driveFileInfo' | 'knowledgePublication' | 'publishKnowledge' |
  'withdrawKnowledge' | 'searchKnowledge' | 'readKnowledgeCitation'>
interface KnowledgeState {
  readonly enabled: boolean
  readonly busy: boolean
  readonly query: string | null
  readonly queryError: OfficeKey | null
  readonly entries: readonly OfficeKnowledgeCitation[]
  readonly citation: OfficeKnowledgeCitation | null
  readonly hasMore: boolean
  readonly review: { readonly file: OfficeDriveDownloadInfo; readonly publication: OfficeKnowledgePublication | null } | null
  readonly pending: boolean
  readonly saving: boolean
  readonly reviewOpen: boolean
  readonly error: OfficeKey | null
}

/** A model stores authoritative replies; components receive only bound hooks and plain callbacks. */
export class OfficeKnowledgeModel {
  /** Current authorized results and review state, never persisted in browser storage. */
  readonly state = createSnapshotStore<KnowledgeState>({ enabled: false, busy: false, query: null, queryError: null,
    entries: [], citation: null, hasMore: false, review: null, pending: false, saving: false, reviewOpen: false, error: null })
  private identity: string | null = null
  private epoch = 0
  private read = 0
  private maxResults = 1
  private pending: { kind: 'publish'; input: OfficeKnowledgePublishInput }
    | { kind: 'withdraw'; input: OfficeKnowledgeWithdrawInput } | null = null

  constructor(private readonly remote: Remote, private readonly notify: (key: OfficeKey, success: boolean) => void) {}

  /**
   * Withdraw private results before a different employee, role or disabled capability is rendered.
   * @param member - Current confirmed employee, or null when disconnected.
   * @param capability - Current authority capability; omission disables knowledge controls.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null, capability?: { readonly protocol: 1; readonly maxResults: number }): void {
    const identity = member && capability?.protocol === 1 ? `${member.id}:${member.role}` : null
    if (identity === this.identity) {
      this.maxResults = capability?.maxResults ?? 1
      const snapshot = this.state.getSnapshot()
      if (snapshot.entries.length > this.maxResults) this.patch({ entries: snapshot.entries.slice(0, this.maxResults), hasMore: true })
      return
    }
    this.identity = identity
    this.maxResults = capability?.maxResults ?? 1
    this.epoch++; this.read++; this.pending = null
    this.state.set({ enabled: identity !== null, busy: false, query: null, queryError: null, entries: [], citation: null, hasMore: false,
      review: null, pending: false, saving: false, reviewOpen: false, error: null })
  }

  /**
   * Search the current authority rather than a browser body cache.
   * @param query - Employee-entered literal text.
   * @returns After the matching request settles; identity changes discard its body.
   */
  async search(query: string): Promise<void> {
    const literal = query.trim()
    if (!this.identity || this.state.getSnapshot().busy || !literal) return
    const epoch = this.epoch, read = ++this.read
    this.patch({ busy: true, query: literal, queryError: null, entries: [], citation: null, hasMore: false, error: null })
    try {
      const result = await this.remote.searchKnowledge({ query: literal, limit: this.maxResults })
      if (!this.current(epoch, read)) return
      const value = this.unwrap(result, 'queryError')
      if (value) {
        this.patch({ entries: value.entries.slice(0, this.maxResults), hasMore: value.hasMore || value.entries.length > this.maxResults })
      }
    } catch { if (this.current(epoch, read)) this.patch({ queryError: 'knowledgeUnavailable' }) }
    finally { if (this.current(epoch, read)) this.patch({ busy: false }) }
  }

  /**
   * Resolve the exact saved source again before exposing its current citation body.
   * @param citation - Employee-selected result from the latest authorized search.
   * @returns After current publication/source checks settle; a denied result is removed.
   */
  async open(citation: OfficeKnowledgeCitation): Promise<void> {
    if (!this.identity || this.state.getSnapshot().busy) return
    const epoch = this.epoch, read = ++this.read
    this.patch({ busy: true, citation: null, error: null })
    try {
      const result = await this.remote.readKnowledgeCitation({ fileId: citation.file.id, versionId: citation.file.versionId,
        sha256: citation.file.sha256, revision: citation.revision, chunk: citation.chunk })
      if (!this.current(epoch, read)) return
      const value = this.unwrap(result)
      if (value) this.patch({ citation: value })
      else this.patch({ entries: [], hasMore: false })
    } catch { if (this.current(epoch, read)) this.patch({ entries: [], hasMore: false, error: 'knowledgeUnavailable' }) }
    finally { if (this.current(epoch, read)) this.patch({ busy: false }) }
  }

  /**
   * Review fresh file/version/digest and the current publication revision before a human confirms a write.
   * @param fileId - Selected real Drive file.
   * @returns After the same employee's exact review is ready.
   */
  async review(fileId: OfficeDriveId): Promise<void> {
    if (!this.identity) return
    if (this.pending) {
      if (fileId === this.pending.input.fileId) this.patch({ reviewOpen: true, error: null })
      return
    }
    if (this.state.getSnapshot().busy) return
    const epoch = this.epoch, read = ++this.read
    this.patch({ busy: true, review: null, reviewOpen: true, error: null })
    try {
      const fileResult = await this.remote.driveFileInfo(fileId)
      if (!this.current(epoch, read)) return
      const file = this.unwrap(fileResult)
      if (!file) return
      const publicationResult = await this.remote.knowledgePublication(fileId)
      if (!this.current(epoch, read)) return
      if (!publicationResult.ok || !publicationResult.value.ok) { this.unwrap(publicationResult); return }
      const publication = publicationResult.value.value
      if (publication && publication.file.versionId !== file.versionId) { this.patch({ error: 'conflict' }); return }
      this.patch({ review: { file, publication } })
    } catch { if (this.current(epoch, read)) this.patch({ error: 'knowledgeUnavailable' }) }
    finally { if (this.current(epoch, read)) this.patch({ busy: false }) }
  }

  /** Dismiss the dialog; an uncertain write retains its exact source and UUID for explicit reopening. */
  closeReview(): void {
    if (this.pending) { this.patch({ reviewOpen: false }); return }
    if (!this.state.getSnapshot().reviewOpen) return
    this.read++
    this.patch({ busy: false, review: null, reviewOpen: false, error: null })
  }

  /**
   * Commit or retry the exact reviewed publication mutation.
   * @param kind - Human-confirmed publication or withdrawal; a pending retry retains its original kind and UUID.
   * @returns After a confirmed result or visible unknown outcome.
   */
  async save(kind: 'publish' | 'withdraw'): Promise<void> {
    const review = this.state.getSnapshot().review
    if (!this.identity || !review || this.state.getSnapshot().busy) return
    const epoch = this.epoch, read = ++this.read
    this.pending ??= kind === 'publish' ? { kind, input: { fileId: review.file.id, versionId: review.file.versionId,
      revision: review.publication?.revision ?? 0, requestId: randomUUID() } }
      : { kind, input: { fileId: review.file.id, revision: review.publication?.revision ?? 0, requestId: randomUUID() } }
    const pending = this.pending
    this.patch({ busy: true, pending: true, saving: true, error: null })
    try {
      const result = pending.kind === 'publish' ? await this.remote.publishKnowledge(pending.input)
        : await this.remote.withdrawKnowledge(pending.input)
      if (!this.current(epoch, read)) return
      if (!result.ok) { this.patch({ error: 'knowledgeSaveUnknown' }); return }
      if (!result.value.ok) { this.pending = null; this.patch({ pending: false, error: result.value.code }); return }
      const value = result.value.value
      if (value.file.id !== pending.input.fileId || value.revision !== pending.input.revision + 1) {
        this.patch({ error: 'knowledgeSaveUnknown' }); return
      }
      this.pending = null
      this.patch({ pending: false, review: { file: review.file, publication: value },
        query: null, queryError: null, entries: [], citation: null, hasMore: false })
      this.notify('knowledgeSaved', true)
    } catch { if (this.current(epoch, read)) this.patch({ error: 'knowledgeSaveUnknown' }) }
    finally { if (this.current(epoch, read)) this.patch({ busy: false, saving: false }) }
  }

  /** Invalidate all late requests when the plugin unloads. */
  dispose(): void { this.bind(null); this.epoch++ }
  private current(epoch: number, read: number): boolean { return this.identity !== null && epoch === this.epoch && read === this.read }
  private unwrap<T>(result: RemoteResult<OfficeOutcome<T>>, target: 'error' | 'queryError' = 'error'): T | null {
    if (!result.ok || !result.value.ok) {
      const code = !result.ok ? 'knowledgeUnavailable' : result.value.ok ? null : result.value.code
      if (target === 'queryError') this.patch({ queryError: code })
      else this.patch({ error: code })
      return null
    }
    return result.value.value
  }
  private patch(value: Partial<KnowledgeState>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
}
