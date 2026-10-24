/** Private reviewed file references retain employee, role, target and exact retry ownership. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConversationFileLimits, OfficeConversationFileReference, OfficeConversationFiles,
  OfficeConversationFilesInput, OfficeConversationFilesView, OfficeConversationId, OfficeDriveDownloadInfo,
  OfficeDriveId, OfficeMember } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'
import { officeDrivePreviewKind } from './drive-preview-model.ts'

/**
 * Match the authority's advertised reference readers without copying or trusting file contents.
 * @param file - Current authority-resolved metadata.
 * @param limits - Current submitted-file capability; omitted document capabilities preserve older authorities.
 * @returns Whether this file can be reviewed for one of the advertised readers.
 */
export function officeFileReferenceSupported(file: Pick<OfficeDriveDownloadInfo, 'name' | 'mediaType' | 'byteLength'>,
  limits: OfficeConversationFileLimits): boolean {
  const media = file.mediaType.split(';', 1)[0]?.trim().toLowerCase()
  if (media?.startsWith('image/')) return limits.image?.protocol === 1 && file.byteLength > 0
    && file.byteLength <= limits.image.maxBytes && limits.image.mediaTypes.some(allowed => allowed === file.mediaType)
  if (file.mediaType.split(';', 1)[0]?.trim().toLowerCase() === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    || /\.pptx$/iu.test(file.name)) return limits.pptx !== undefined && file.byteLength <= limits.pptx.maxBytes
  if (file.mediaType.split(';', 1)[0]?.trim().toLowerCase() === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || /\.xlsx$/iu.test(file.name)) return limits.xlsx !== undefined && file.byteLength <= limits.xlsx.maxBytes
  if (file.mediaType.split(';', 1)[0]?.trim().toLowerCase() === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || /\.docx$/iu.test(file.name)) return limits.docx !== undefined && file.byteLength <= limits.docx.maxBytes
  if (file.mediaType.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf' || /\.pdf$/iu.test(file.name))
    return limits.pdf !== undefined && file.byteLength <= limits.pdf.maxBytes
  return officeDrivePreviewKind(file) === 'text' && file.byteLength <= limits.maxTextBytes
}

type FileCoordinates = Pick<OfficeConversationFileReference, 'id' | 'versionId'>
type FileRemote = Pick<ClientRemote['office'], 'conversationFiles' | 'saveConversationFiles' | 'driveFileInfo'>
interface FileAssociationsState {
  readonly conversationId: OfficeConversationId | null
  readonly view: OfficeConversationFilesView | null
  readonly limits: OfficeConversationFileLimits | null
  readonly loading: boolean
  readonly busy: boolean
  readonly preparing: boolean
  readonly choosing: boolean
  readonly pending: boolean
  readonly error: OfficeKey | null
}

/** One plugin owns JSON metadata; native preparation and every file read keep their existing owners. */
export class OfficeFileAssociationsModel {
  /** Current private references and action state, without native handles or file contents. */
  readonly state = createSnapshotStore<FileAssociationsState>({ conversationId: null, view: null, limits: null,
    loading: false, busy: false, preparing: false, choosing: false, pending: false, error: null })
  private member: Pick<OfficeMember, 'id' | 'role'> | null = null
  private identity: string | null = null
  private observed: OfficeConversationId | null = null
  private epoch = 0
  private read = 0
  private disposed = false
  private scope = new AbortController()
  private preparation: AbortController | null = null
  private pending: OfficeConversationFilesInput | null = null

  constructor(
    private readonly remote: FileRemote,
    private readonly prepare: (file: OfficeDriveDownloadInfo, signal: AbortSignal) => Promise<boolean>,
    private readonly notify: (key: OfficeKey, success: boolean) => void,
  ) {}

  /**
   * Withdraw old references and operations before another employee, role or protocol is published.
   * @param member - Confirmed employee, or null while signed out.
   * @param limits - Optional server capability; absent authorities retain their original UI.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null, limits?: OfficeConversationFileLimits): void {
    const identity = member && limits?.protocol === 1 ? `${member.id}:${member.role}` : null
    if (this.disposed) return
    if (identity === this.identity) { this.patch({ limits: identity ? limits ?? null : null }); return }
    this.cancelPreparation()
    this.resetTarget(null)
    this.identity = identity
    this.member = identity ? member : null
    this.patch({ limits: identity ? limits ?? null : null })
  }

  /**
   * Follow an observed native target; another target cancels an outstanding preparation.
   * @param id - Current employee's observed conversation, or null when no input is selected.
   */
  observe(id: OfficeConversationId | null): void {
    if (this.disposed || this.observed === id) return
    this.observed = id
    if (this.state.getSnapshot().conversationId === id) return
    this.cancelPreparation()
    this.resetTarget(id)
    if (id && this.identity) void this.load(id)
  }

  /**
   * Refresh current references without accepting another identity's late metadata.
   * @param id - Exact native logical conversation.
   * @param force - Supersede a background read when explicitly refreshing.
   * @param signal - Optional native preparation lifetime.
   * @returns Current authorized selection metadata, or null after failure or cancellation.
   */
  async load(id: OfficeConversationId, force = false, signal?: AbortSignal): Promise<OfficeConversationFilesView | null> {
    if (!this.identity || this.disposed || signal?.aborted) return null
    if (this.state.getSnapshot().conversationId !== id) this.resetTarget(id)
    const snapshot = this.state.getSnapshot()
    if (snapshot.busy || !force && snapshot.loading) return null
    const epoch = this.epoch
    const read = ++this.read
    const lifetime = AbortSignal.any([this.scope.signal, ...(signal ? [signal] : [])])
    this.patch({ loading: true })
    try {
      const result = await this.remote.conversationFiles(id)
      if (!this.current(epoch, id) || read !== this.read || lifetime.aborted) return null
      const error = this.denial(result)
      if (error) { this.fail(error); return null }
      if (!result.ok || !result.value.ok) return null
      const view = result.value.value
      if (view.meId !== this.member?.id || view.role !== this.member.role || view.conversationId !== id ||
        view.revision < (this.state.getSnapshot().view?.revision ?? 0)) {
        this.patch({ view: null, loading: false, error: 'fileAssociationsUnavailable' })
        return null
      }
      if (this.pending && this.matches(view, this.pending)) this.pending = null
      this.patch({ view, loading: false, pending: this.pending !== null,
        error: this.pending ? 'fileAssociationSaveUnknown' : null })
      return view
    } catch {
      if (this.current(epoch, id) && read === this.read && !lifetime.aborted) this.fail('fileAssociationsUnavailable')
      return null
    } finally {
      if (this.current(epoch, id) && read === this.read) this.patch({ loading: false })
    }
  }

  /**
   * Open the shared drive for this exact input without sending or changing its native draft.
   * @param id - Input whose references the employee is choosing.
   * @returns Whether the same target is ready for drive selection.
   */
  async choose(id: OfficeConversationId): Promise<boolean> {
    const view = await this.load(id, true)
    if (!view) return false
    this.patch({ choosing: true })
    return true
  }

  /** Close drive selection without modifying saved references. */
  endChoosing(): void { this.patch({ choosing: false }) }

  /**
   * Resolve current file metadata before invoking the native navigation owner.
   * @param id - Employee-selected drive file, never a caller-supplied path or metadata blob.
   * @returns Whether the exact current preparation confirmed its reference and opened the input.
   */
  async useFile(id: OfficeDriveId): Promise<boolean> {
    if (!this.identity || this.disposed || this.preparation || this.pending) return false
    const controller = new AbortController()
    this.preparation = controller
    this.patch({ preparing: true, error: null })
    try {
      const result = await this.remote.driveFileInfo(id)
      if (!this.currentPreparation(controller)) return false
      const error = this.denial(result)
      if (error) { this.fail(error); return false }
      if (!result.ok || !result.value.ok) return false
      const file = result.value.value
      const limits = this.state.getSnapshot().limits
      if (file.id !== id || !limits || !officeFileReferenceSupported(file, limits)) {
        this.fail('fileAssociationTextOnly')
        return false
      }
      const prepared = await this.prepare(file, controller.signal)
      if (!this.currentPreparation(controller)) return false
      if (prepared) this.patch({ choosing: false })
      return prepared
    } catch {
      if (this.currentPreparation(controller)) this.fail('fileAssociationsUnavailable')
      return false
    } finally {
      if (this.preparation === controller) { this.preparation = null; this.patch({ preparing: false }) }
    }
  }

  /** Cancel native preparation; an admitted association write can still commit and retains its exact retry. */
  cancelPreparation(): void {
    this.preparation?.abort()
    this.preparation = null
    this.patch({ preparing: false })
  }

  /**
   * Add a freshly authority-resolved immutable version while preserving the other current references.
   * @param id - Exact input prepared by the native owner.
   * @param file - Fresh metadata resolved by useFile, without copied contents.
   * @param signal - Native preparation lifetime.
   * @returns True after an exact confirmed selection commit or an already selected version.
   */
  async add(id: OfficeConversationId, file: OfficeDriveDownloadInfo, signal: AbortSignal): Promise<boolean> {
    const view = await this.load(id, true, signal)
    if (!view || signal.aborted || this.pending) return false
    if (view.files.some(row => row.id === file.id && row.versionId === file.versionId)) return true
    const files: FileCoordinates[] = [...view.files.filter(row => row.id !== file.id).map(({ id, versionId }) => ({ id, versionId })),
      { id: file.id, versionId: file.versionId }]
    if (files.length > view.limits.maxSelectedFiles) { this.fail('fileAssociationCapacity'); return false }
    return this.replace(files, signal)
  }

  /**
   * Remove one reviewed reference; null explicitly clears all references, including inaccessible files.
   * @param id - Selected file identity or null for an empty replacement.
   * @returns Whether the current target's exact replacement was confirmed.
   */
  async remove(id: OfficeDriveId | null): Promise<boolean> {
    const view = this.state.getSnapshot().view
    if (!view || this.pending) return false
    return this.replace(id === null ? [] : view.files.filter(row => row.id !== id).map(({ id, versionId }) => ({ id, versionId })))
  }

  /**
   * Retry the unchanged reviewed request after uncertain acknowledgement.
   * @returns Whether the original replacement was confirmed; no new UUID or review version is created.
   */
  retry(): Promise<boolean> { return this.pending ? this.save(this.pending) : Promise.resolve(false) }

  /** Cancel owned preparation and withdraw private references when the optional plugin unloads. */
  dispose(): void {
    this.cancelPreparation()
    this.resetTarget(null)
    this.disposed = true
    this.member = null
    this.identity = null
    this.patch({ limits: null })
  }

  private replace(files: readonly FileCoordinates[], signal?: AbortSignal): Promise<boolean> {
    const snapshot = this.state.getSnapshot()
    if (!snapshot.view || snapshot.busy || this.pending || !this.identity || signal?.aborted) return Promise.resolve(false)
    return this.save({ conversationId: snapshot.view.conversationId, revision: snapshot.view.revision,
      requestId: randomUUID(), files }, signal)
  }

  private async save(input: OfficeConversationFilesInput, signal?: AbortSignal): Promise<boolean> {
    const id = input.conversationId
    if (this.disposed || !this.identity || this.state.getSnapshot().busy || this.state.getSnapshot().conversationId !== id) return false
    const epoch = this.epoch
    const lifetime = AbortSignal.any([this.scope.signal, ...(signal ? [signal] : [])])
    this.read++
    this.pending = input
    this.patch({ busy: true, pending: true, loading: false, error: null })
    try {
      const result = await this.remote.saveConversationFiles(input)
      if (!this.current(epoch, id)) return false
      const error = this.denial(result)
      if (error) {
        if (result.ok) { this.pending = null; this.patch({ pending: false }) }
        this.fail(result.ok ? error : 'fileAssociationSaveUnknown')
        return false
      }
      if (!result.ok || !result.value.ok || lifetime.aborted || !this.matches(result.value.value, input)) {
        this.fail('fileAssociationSaveUnknown')
        return false
      }
      const view = this.state.getSnapshot().view
      if (!view) return false
      this.pending = null
      this.patch({ view: { ...view, ...result.value.value }, pending: false, error: null })
      this.notify('fileAssociationSaved', true)
      return true
    } catch {
      if (this.current(epoch, id)) this.fail('fileAssociationSaveUnknown')
      return false
    } finally {
      if (this.current(epoch, id)) this.patch({ busy: false })
    }
  }

  private matches(value: OfficeConversationFiles, input: OfficeConversationFilesInput): boolean {
    const coordinates = value.files.map(({ id, versionId }) => ({ id, versionId }))
    return value.conversationId === input.conversationId && value.revision === input.revision + 1 &&
      value.requestId === input.requestId && JSON.stringify(coordinates) === JSON.stringify(input.files)
  }
  private currentPreparation(controller: AbortController): boolean {
    return !this.disposed && this.identity !== null && this.preparation === controller && !controller.signal.aborted
  }
  private resetTarget(id: OfficeConversationId | null): void {
    this.scope.abort()
    this.scope = new AbortController()
    this.epoch++
    this.read++
    this.pending = null
    this.patch({ conversationId: id, view: null, loading: false, busy: false, choosing: false, pending: false, error: null })
  }
  private current(epoch: number, id: OfficeConversationId): boolean {
    return !this.disposed && this.identity !== null && epoch === this.epoch && this.state.getSnapshot().conversationId === id
  }
  private denial<T>(result: RemoteResult<OfficeOutcome<T>>): OfficeKey | null {
    return !result.ok ? 'fileAssociationsUnavailable' : !result.value.ok ? result.value.code : null
  }
  private fail(error: OfficeKey): void {
    if (error === 'unauthenticated') { this.bind(null); this.notify(error, false); return }
    this.patch({ loading: false, error })
  }
  private patch(patch: Partial<FileAssociationsState>): void { this.state.set({ ...this.state.getSnapshot(), ...patch }) }
}
