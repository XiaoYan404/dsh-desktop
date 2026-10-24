/** Bounded, verified transient previews never persist file contents or browser handles. */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeDriveDownloadInfo, OfficeDriveId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

type PreviewRemote = Pick<ClientRemote['office'], 'driveFileInfo' | 'downloadDriveRange'>
type PreviewContent = { readonly kind: 'text'; readonly text: string } |
  { readonly kind: 'image'; readonly data: Uint8Array<ArrayBuffer>; readonly mediaType: string }
interface PreviewState {
  readonly id: OfficeDriveId | null
  readonly name: string
  readonly phase: 'closed' | 'loading' | 'ready' | 'failed'
  readonly info: OfficeDriveDownloadInfo | null
  readonly content: PreviewContent | null
  readonly done: number
  readonly error: OfficeKey | null
}
interface PreviewJob { readonly id: OfficeDriveId; readonly controller: AbortController }
const initial = (): PreviewState => ({ id: null, name: '', phase: 'closed', info: null, content: null, done: 0, error: null })
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
class PreviewFailure extends Error {
  constructor(readonly key: OfficeKey) { super(key) }
}
/**
 * Classify inert preview formats without reading content.
 * @param info - File name and declared media type.
 * @returns Supported body kind, or null for a download-only format.
 */
export function officeDrivePreviewKind(info: Pick<OfficeDriveDownloadInfo, 'name' | 'mediaType'>): PreviewContent['kind'] | null {
  const mediaType = (info.mediaType.split(';')[0] ?? '').trim().toLowerCase()
  if (imageTypes.has(mediaType)) return 'image'
  if (mediaType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript',
    'application/yaml'].includes(mediaType) ||
    mediaType === 'application/octet-stream' && /\.(txt|md|csv|json|log|yaml|yml)$/iu.test(info.name)) return 'text'
  return null
}
function sameVersion(a: OfficeDriveDownloadInfo, b: OfficeDriveDownloadInfo): boolean {
  return a.id === b.id && a.versionId === b.versionId && a.byteLength === b.byteLength &&
    a.sha256 === b.sha256 && a.mediaType === b.mediaType
}

/** One employee owns one preview; every range and every renewal is authorized by the server. */
export class OfficeDrivePreviewModel {
  /** Transient image buffers are borrowed read-only; no content enters layout or Session JSON. */
  readonly state = createSnapshotStore<PreviewState>(initial())
  private principal: OfficeMemberId | null = null
  private job: PreviewJob | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly remote: PreviewRemote, private readonly notify: (key: OfficeKey, success: boolean) => void) {}

  /**
   * Withdraw bytes before an identity change can publish another employee's view.
   * @param principal - Current confirmed employee, or null on sign-out.
   */
  bind(principal: OfficeMemberId | null): void {
    if (this.disposed || principal === this.principal) return
    this.close()
    this.principal = principal
  }

  /**
   * Open an authorized selection, dropping an older selection before any asynchronous work.
   * @param id - Logical file identity; metadata and content are always read afresh.
   */
  async open(id: OfficeDriveId): Promise<void> {
    if (this.disposed || !this.principal) return
    this.close()
    const job: PreviewJob = { id, controller: new AbortController() }
    this.job = job
    this.state.set({ ...initial(), id, phase: 'loading' })
    try {
      const info = await this.result(this.remote.driveFileInfo(id))
      this.check(job)
      if (info.id !== id || !Number.isSafeInteger(info.byteLength) || info.byteLength < 0 ||
        !Number.isSafeInteger(info.chunkBytes) || info.chunkBytes <= 0 ||
        !/^[a-f\d]{64}$/u.test(info.sha256)) throw new PreviewFailure('downloadCorrupt')
      this.state.set({ ...this.state.getSnapshot(), name: info.name, info })
      const kind = officeDrivePreviewKind(info)
      if (!kind) throw new PreviewFailure('drivePreviewUnsupported')
      if (info.byteLength > (kind === 'text' ? 1024 * 1024 : 8 * 1024 * 1024))
        throw new PreviewFailure('drivePreviewTooLarge')
      const bytes = new Uint8Array(info.byteLength)
      for (let offset = 0; offset < info.byteLength;) {
        const byteLength = Math.min(info.chunkBytes, 1024 * 1024, info.byteLength - offset)
        const range = await this.result(this.remote.downloadDriveRange({ id, versionId: info.versionId, offset, byteLength }))
        this.check(job)
        const part = Uint8Array.from(atob(range.dataBase64), character => character.charCodeAt(0))
        if (range.id !== id || range.versionId !== info.versionId || range.offset !== offset ||
          range.byteLength !== byteLength || part.length !== byteLength || bytesToHex(sha256(part)) !== range.sha256)
          throw new PreviewFailure('downloadCorrupt')
        bytes.set(part, offset)
        offset += byteLength
        this.state.set({ ...this.state.getSnapshot(), done: offset })
      }
      if (bytesToHex(sha256(bytes)) !== info.sha256) throw new PreviewFailure('downloadCorrupt')
      // This also authorizes empty files and catches a revocation after the last range.
      const confirmed = await this.result(this.remote.driveFileInfo(id))
      this.check(job)
      if (!sameVersion(info, confirmed)) throw new PreviewFailure('drivePreviewChanged')
      let content: PreviewContent
      if (kind === 'image') content = { kind, data: bytes, mediaType: (info.mediaType.split(';')[0] ?? '').trim().toLowerCase() }
      else {
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        catch { throw new PreviewFailure('drivePreviewEncoding') }
        if (text.includes('\0')) throw new PreviewFailure('drivePreviewEncoding')
        content = { kind, text }
      }
      this.state.set({ id, name: confirmed.name, phase: 'ready', info: confirmed, content, done: info.byteLength, error: null })
      this.renew(job, confirmed)
    } catch (error) { this.fail(job, error) }
  }

  /** Retry the selection through fresh metadata, authorization and version checks. */
  retry(): void {
    const id = this.state.getSnapshot().id
    if (id) void this.open(id)
  }

  /** Cancel pending work and release every published byte immediately. */
  close(): void {
    this.job?.controller.abort()
    this.job = null
    clearTimeout(this.timer)
    this.timer = undefined
    this.state.set(initial())
  }

  /** Recheck an open preview when the directory is explicitly refreshed. */
  refresh(): void {
    const info = this.state.getSnapshot().info
    if (this.job && info && this.state.getSnapshot().phase === 'ready') {
      clearTimeout(this.timer)
      void this.validate(this.job, info)
    }
  }

  /** Withdraw content and end renewal at plugin unload. */
  dispose(): void { this.close(); this.principal = null; this.disposed = true }

  private renew(job: PreviewJob, info: OfficeDriveDownloadInfo): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.validate(job, info) }, 5000)
  }
  private async validate(job: PreviewJob, info: OfficeDriveDownloadInfo): Promise<void> {
    try {
      const current = await this.result(this.remote.driveFileInfo(job.id))
      this.check(job)
      if (!sameVersion(info, current)) throw new PreviewFailure('drivePreviewChanged')
      this.renew(job, current)
    } catch (error) { this.fail(job, error) }
  }
  private check(job: PreviewJob): void {
    job.controller.signal.throwIfAborted()
    if (this.job !== job || this.disposed || !this.principal) throw new DOMException('Preview ended', 'AbortError')
  }
  private fail(job: PreviewJob, error: unknown): void {
    if (this.job !== job || job.controller.signal.aborted || this.disposed) return
    job.controller.abort()
    clearTimeout(this.timer)
    const key = error instanceof PreviewFailure ? error.key : 'unavailable'
    this.state.set({ ...this.state.getSnapshot(), content: null, phase: 'failed', error: key })
    if (key === 'unauthenticated') this.notify(key, false)
  }
  private async result<T>(operation: Promise<RemoteResult<OfficeOutcome<T>>>): Promise<T> {
    const response = await operation
    if (!response.ok) throw new PreviewFailure('unavailable')
    if (!response.value.ok) throw new PreviewFailure(response.value.code)
    return response.value.value
  }
}
