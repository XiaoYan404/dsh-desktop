/** Bounded browser transfers retain private handles and publish only JSON progress. */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bytesToBase64, randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeDriveDownloadInfo,
  OfficeDriveEntry,
  OfficeDriveId,
  OfficeDriveVersionId,
  OfficeDriveLocation,
  OfficeDriveTransferLimits,
  OfficeDriveUploadDeclaration,
  OfficeDriveUploadId,
  OfficeDriveUploadTicket,
  OfficeMemberId,
  OfficeMember,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'

type TransferRemote = Pick<ClientRemote['office'],
  | 'beginDriveUpload' | 'driveUploads' | 'getDriveUpload' | 'appendDriveUpload'
  | 'completeDriveUpload' | 'cancelDriveUpload' | 'driveFileInfo' | 'driveVersionInfo' | 'downloadDriveRange'>
type UploadPhase = 'hashing' | 'uploading' | 'finishing' | 'cancelling' | 'failed' | 'completed' | 'cancelled' | 'expired' | 'stopped'
type DownloadPhase = 'preparing' | 'downloading' | 'verifying' | 'failed' | 'completed' | 'cancelled'
interface Progress<P> {
  readonly name: string
  readonly byteLength: number
  readonly done: number
  readonly phase: P
  readonly error: OfficeKey | null
}
interface UploadProgress extends Progress<UploadPhase> {
  readonly hashed: number
  readonly ticketId: OfficeDriveUploadId | null
  readonly cancelRequested: boolean
}
interface TransferState {
  readonly upload: UploadProgress | null
  readonly download: Progress<DownloadPhase> | null
  readonly pending: readonly OfficeDriveUploadTicket[]
  readonly pendingLoading: boolean
  readonly pendingError: OfficeKey | null
}
interface UploadJob {
  readonly epoch: number
  readonly file: File | null
  readonly location: OfficeDriveLocation
  readonly requestId: string
  readonly name: string
  readonly target: OfficeDriveUploadDeclaration['target']
  declaration: OfficeDriveUploadDeclaration | null
  ticket: OfficeDriveUploadTicket | null
  cancel: boolean
  running: boolean
}
interface DownloadJob {
  readonly epoch: number
  readonly id: OfficeDriveId
  cancel: boolean
}
const initial = (): TransferState => ({ upload: null, download: null, pending: [], pendingLoading: false, pendingError: null })
const terminal = (phase: UploadPhase): boolean => ['completed', 'cancelled', 'expired', 'stopped'].includes(phase)
class TransferFailure extends Error {
  constructor(readonly key: OfficeKey) { super(key) }
}
class Stopped extends Error {}

/** One account owns its selected File, retry declaration, receipts and download buffers. */
export class OfficeDriveTransfers {
  /** Only serializable metadata reaches components; bytes never enter this source. */
  readonly state = createSnapshotStore<TransferState>(initial())
  private principal: OfficeMemberId | null = null
  private epoch = 0
  private disposed = false
  private limits: OfficeDriveTransferLimits | null = null
  private upload: UploadJob | null = null
  private download: DownloadJob | null = null
  private lastDownload: { id: OfficeDriveId; versionId?: OfficeDriveVersionId | undefined; historical: boolean } | null = null
  private role: OfficeMember['role'] | undefined
  private listing = 0

  constructor(
    private readonly remote: TransferRemote,
    private readonly notify: (key: OfficeKey, success: boolean) => void,
    private readonly published: () => Promise<void>,
    private readonly save: (info: OfficeDriveDownloadInfo, content: Blob) => void,
  ) {}

  /**
   * Discard old handles before another employee can receive progress or bytes.
   * @param principal - Confirmed employee, or null on sign-out.
   * @param role - Known current role; a changed role also fences pending saves and file handles.
   */
  bind(principal: OfficeMemberId | null, role?: OfficeMember['role']): void {
    if (this.disposed || this.principal === principal && (role === undefined || this.role === role)) return
    this.principal = principal
    this.role = role
    this.epoch++
    this.listing++
    this.upload = null
    this.download = null
    this.lastDownload = null
    this.limits = null
    this.state.set(initial())
  }

  /**
   * Use advertised bounds; an older server receives no chunk-protocol requests.
   * @param limits - Capabilities from a confirmed authorized drive view.
   */
  configure(limits: OfficeDriveTransferLimits | undefined): void {
    if (this.disposed || !this.principal) return
    const first = this.limits === null && limits !== undefined
    this.limits = limits ?? null
    if (first) void this.refresh()
  }

  /** Refresh only the current employee's durable unfinished declarations. */
  async refresh(): Promise<void> {
    if (!this.available()) return
    const epoch = this.epoch
    const generation = ++this.listing
    this.patch({ pendingLoading: true, pendingError: null })
    try {
      const tickets = await this.result(this.remote.driveUploads())
      if (!this.current(epoch) || generation !== this.listing) return
      this.patch({ pending: tickets, pendingLoading: false })
    } catch (error) {
      if (this.current(epoch) && generation === this.listing) {
        const key = this.errorKey(error)
        this.patch({ pendingLoading: false, pendingError: key, ...(key === 'unauthenticated' ? { pending: [] } : {}) })
        if (key === 'unauthenticated') this.notify(key, false)
      }
    }
  }

  /**
   * Admit one reviewed selection, or a reselected file for a retained ticket.
   * @param file - Private native file handle, never serialized or persisted.
   * @param location - Captured logical destination, independent of later navigation.
   * @param ticketId - Optional own unfinished ticket selected for resumption.
   * @returns Whether this window admitted the transfer.
   */
  start(file: File, location: OfficeDriveLocation, ticketId?: OfficeDriveUploadId): boolean {
    return this.admit(file, location, ticketId)
  }

  /**
   * Upload a reviewed replacement while preserving the logical name and original file revision.
   * @param file - Privately selected source whose native filename does not rename the target.
   * @param entry - Exact file metadata reviewed before selecting replacement bytes.
   * @returns Whether this window admitted the replacement; authorization is rechecked by the Host.
   */
  startVersion(file: File, entry: OfficeDriveEntry): boolean {
    if (entry.kind !== 'file' || !entry.canUpdate) return false
    return this.admit(file, { space: entry.space, folderId: entry.parentId }, undefined, entry)
  }

  private admit(file: File, location: OfficeDriveLocation, ticketId?: OfficeDriveUploadId, replacement?: OfficeDriveEntry): boolean {
    const limits = this.limits
    if (!this.available() || !limits || this.upload && !terminal(this.state.getSnapshot().upload?.phase ?? 'failed')) return false
    const ticket = ticketId ? this.state.getSnapshot().pending.find(value => value.id === ticketId) : null
    if (ticketId && !ticket) return false
    if (!ticket && file.size > limits.maxFileBytes) {
      this.notify('uploadTooLarge', false)
      return false
    }
    const job: UploadJob = {
      epoch: this.epoch, file, location: ticket ?? location, requestId: ticket?.requestId ?? randomUUID(),
      name: ticket?.name ?? replacement?.name ?? file.name,
      target: ticket?.target ?? (replacement ? { id: replacement.id, revision: replacement.revision } : undefined),
      declaration: ticket ?? null, ticket: ticket ?? null, cancel: false, running: false,
    }
    this.upload = job
    this.patch({ upload: {
      name: job.name, byteLength: ticket?.byteLength ?? file.size, done: ticket?.receivedBytes ?? 0,
      hashed: 0, phase: 'hashing', error: null, ticketId: ticket?.id ?? null, cancelRequested: false,
    } })
    void this.runUpload(job)
    return true
  }

  /** Retry the same declaration and query receipts before transmitting missing chunks. */
  retry(): void {
    const job = this.upload
    if (!job || job.running || !this.current(job.epoch) || this.state.getSnapshot().upload?.phase !== 'failed') return
    void this.runUpload(job)
  }

  /**
   * Replace an unreadable or mismatching handle while retaining the original declaration.
   * @param file - New selection whose bytes must match the declared digest.
   */
  reselect(file: File): void {
    const previous = this.upload
    const limits = this.limits
    if (!this.available() || !limits || !previous || previous.running || previous.cancel ||
      this.state.getSnapshot().upload?.phase !== 'failed') return
    if (!previous.declaration && file.size > limits.maxFileBytes) {
      this.notify('uploadTooLarge', false)
      return
    }
    const job: UploadJob = { ...previous, file, running: false,
      name: !previous.declaration && !previous.target ? file.name : previous.name }
    this.upload = job
    if (!job.declaration) this.uploadPatch({ name: job.name, byteLength: file.size, done: 0 })
    void this.runUpload(job)
  }

  /** Stop new chunks and cancel observed tickets; unobserved reservations retain server expiry and failed cleanup is retryable. */
  cancel(): void {
    const job = this.upload
    if (!job || !this.current(job.epoch) || terminal(this.state.getSnapshot().upload?.phase ?? 'failed')) return
    job.cancel = true
    this.uploadPatch({ phase: 'cancelling', cancelRequested: true, error: null })
    if (!job.running) void this.runUpload(job)
  }

  /**
   * Cancel an owned durable ticket after a window reload without requiring its file.
   * @param id - Ticket from the current employee's confirmed unfinished list.
   */
  cancelPending(id: OfficeDriveUploadId): void {
    if (!this.available() || this.upload && !terminal(this.state.getSnapshot().upload?.phase ?? 'failed')) return
    const ticket = this.state.getSnapshot().pending.find(value => value.id === id)
    if (!ticket) return
    const job: UploadJob = {
      epoch: this.epoch, file: null, location: ticket, requestId: ticket.requestId,
      name: ticket.name, target: ticket.target,
      declaration: ticket, ticket, cancel: true, running: false,
    }
    this.upload = job
    this.patch({ upload: {
      name: ticket.name, byteLength: ticket.byteLength, done: ticket.receivedBytes, hashed: 0,
      phase: 'cancelling', error: null, ticketId: id, cancelRequested: true,
    } })
    void this.runUpload(job)
  }

  /** Dismiss a settled result; a failed transfer retains its declaration for retry or cancellation. */
  dismissUpload(): void {
    if (!this.upload || !terminal(this.state.getSnapshot().upload?.phase ?? 'failed')) return
    this.upload = null
    this.patch({ upload: null })
  }

  /**
   * Read bounded immutable ranges and save only after every digest confirms.
   * @param id - Authorized logical file selection.
   * @param versionId - Optional reviewed version; replacement rejects before reading bytes, including retries.
   */
  async downloadFile(id: OfficeDriveId, versionId?: OfficeDriveVersionId): Promise<void> {
    return this.readDownload(id, versionId, false)
  }

  /**
   * Download an explicitly selected historical version under current file and ancestor permissions.
   * @param id - Authorized logical file identity.
   * @param versionId - Immutable selection from the current history view.
   * @returns After confirmation, failure or cancellation; retries keep this same historical selection.
   */
  async downloadVersion(id: OfficeDriveId, versionId: OfficeDriveVersionId): Promise<void> {
    return this.readDownload(id, versionId, true)
  }

  private async readDownload(id: OfficeDriveId, versionId: OfficeDriveVersionId | undefined, historical: boolean): Promise<void> {
    if (!this.available() || this.download && !this.download.cancel) return
    const job: DownloadJob = { epoch: this.epoch, id, cancel: false }
    this.download = job
    this.lastDownload = { id, versionId, historical }
    this.patch({ download: { name: '', byteLength: 0, done: 0, phase: 'preparing', error: null } })
    const hash = sha256.create()
    const pieces: Uint8Array<ArrayBuffer>[] = []
    try {
      const info = await this.result(historical && versionId !== undefined
        ? this.remote.driveVersionInfo(id, versionId) : this.remote.driveFileInfo(id))
      this.checkDownload(job)
      if (info.id !== id || info.chunkBytes <= 0) throw new TransferFailure('downloadCorrupt')
      if (versionId !== undefined && info.versionId !== versionId) throw new TransferFailure('conflict')
      this.patch({ download: { name: info.name, byteLength: info.byteLength, done: 0, phase: 'downloading', error: null } })
      for (let offset = 0; offset < info.byteLength;) {
        this.checkDownload(job)
        const byteLength = Math.min(info.chunkBytes, info.byteLength - offset)
        const range = await this.result(this.remote.downloadDriveRange({ id, versionId: info.versionId, offset, byteLength }))
        this.checkDownload(job)
        const bytes = Uint8Array.from(atob(range.dataBase64), character => character.charCodeAt(0))
        if (range.id !== id || range.versionId !== info.versionId || range.offset !== offset ||
          range.byteLength !== byteLength || bytes.length !== byteLength || bytesToHex(sha256(bytes)) !== range.sha256)
          throw new TransferFailure('downloadCorrupt')
        hash.update(bytes)
        pieces.push(bytes)
        offset += byteLength
        this.downloadPatch({ done: offset })
      }
      this.downloadPatch({ phase: 'verifying' })
      if (bytesToHex(hash.digest()) !== info.sha256) throw new TransferFailure('downloadCorrupt')
      this.checkDownload(job)
      this.save(info, new Blob(pieces, { type: info.mediaType }))
      this.downloadPatch({ phase: 'completed' })
    } catch (error) {
      if (this.current(job.epoch) && this.download === job && !job.cancel) {
        const key = this.errorKey(error)
        this.downloadPatch({ phase: 'failed', error: key })
        this.notify(key, false)
      }
    } finally {
      hash.destroy()
      pieces.length = 0
      if (this.download === job && this.current(job.epoch)) this.download = null
    }
  }

  /** Stop a download before any later response can create a browser download. */
  cancelDownload(): void {
    if (!this.download) return
    this.download.cancel = true
    this.downloadPatch({ phase: 'cancelled', error: null })
  }

  /** Retry a failed download through a fresh authorized immutable-version lookup. */
  retryDownload(): void {
    if (this.lastDownload && this.state.getSnapshot().download?.phase === 'failed')
      void this.readDownload(this.lastDownload.id, this.lastDownload.versionId, this.lastDownload.historical)
  }

  /** Remove a settled download result without retaining any content buffers. */
  dismissDownload(): void {
    if (this.download && !this.download.cancel) return
    this.lastDownload = null
    this.patch({ download: null })
  }

  /** Release handles and fence every asynchronous completion at plugin unload. */
  dispose(): void {
    this.bind(null)
    this.disposed = true
  }

  private async runUpload(job: UploadJob): Promise<void> {
    if (job.running) return
    job.running = true
    try {
      this.checkUpload(job)
      job.declaration = await this.declare(job)
      this.checkUpload(job)
      const receipt = job.ticket
        ? await this.result(this.remote.getDriveUpload(job.ticket.id))
        : await this.result(this.remote.beginDriveUpload(job.declaration))
      this.acceptTicket(job, receipt)
      if (!this.isUpload(job)) return
      if (await this.finishTerminal(job)) return
      this.checkUpload(job)
      const ticket = job.ticket
      const file = job.file
      if (!ticket || !file) throw new Error('Upload requires a negotiated ticket and selected file')
      this.uploadPatch({ phase: 'uploading', error: null, done: ticket.receivedBytes, ticketId: ticket.id })
      const received = new Set(ticket.received)
      for (let index = 0; index * ticket.chunkBytes < file.size; index++) {
        this.checkUpload(job)
        if (received.has(index)) continue
        const bytes = await this.read(file, index * ticket.chunkBytes, ticket.chunkBytes)
        this.checkUpload(job)
        const receipt = await this.result(this.remote.appendDriveUpload({
          uploadId: ticket.id, index, sha256: bytesToHex(sha256(bytes)), dataBase64: bytesToBase64(bytes),
        }))
        if (!this.isUpload(job)) return
        this.acceptTicket(job, receipt)
        this.uploadPatch({ done: receipt.receivedBytes })
      }
      this.checkUpload(job)
      this.uploadPatch({ phase: 'finishing' })
      this.acceptTicket(job, await this.result(this.remote.completeDriveUpload(ticket.id)))
      if (!this.isUpload(job)) return
      if (!await this.finishTerminal(job)) throw new TransferFailure('unavailable')
    } catch (error) {
      if (!this.isUpload(job)) return
      if (job.cancel) {
        try { await this.finishCancellation(job) }
        catch (cancelError) { if (this.isUpload(job)) this.uploadFailure(cancelError) }
      } else this.uploadFailure(error)
    } finally {
      job.running = false
    }
  }

  private async declare(job: UploadJob): Promise<OfficeDriveUploadDeclaration> {
    const file = job.file
    const chunkBytes = job.ticket?.chunkBytes ?? this.limits?.chunkBytes
    if (!file || !chunkBytes) throw new Stopped()
    if (job.declaration && job.declaration.byteLength !== file.size) throw new TransferFailure('resumeFileMismatch')
    this.uploadPatch({ phase: 'hashing', hashed: 0, error: null })
    const hash = sha256.create()
    try {
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        this.checkUpload(job)
        const bytes = await this.read(file, offset, chunkBytes)
        this.checkUpload(job)
        hash.update(bytes)
        this.uploadPatch({ hashed: Math.min(offset + bytes.length, file.size) })
      }
      const digest = bytesToHex(hash.digest())
      if (job.declaration && job.declaration.sha256 !== digest) throw new TransferFailure('resumeFileMismatch')
      return job.declaration ?? {
        ...job.location, requestId: job.requestId, name: job.name,
        mediaType: file.type || 'application/octet-stream', byteLength: file.size, sha256: digest,
        ...(job.target ? { target: job.target } : {}),
      }
    } finally { hash.destroy() }
  }

  private async read(file: File, offset: number, length: number): Promise<Uint8Array> {
    try {
      const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
      if (bytes.length !== Math.min(length, file.size - offset)) throw new TransferFailure('fileReadFailed')
      return bytes
    }
    catch { throw new TransferFailure('fileReadFailed') }
  }

  private acceptTicket(job: UploadJob, ticket: OfficeDriveUploadTicket): void {
    if (!this.isUpload(job)) return
    const declaration = job.declaration
    if (!declaration) throw new Error('Upload receipt requires its original declaration')
    if (ticket.requestId !== declaration.requestId || ticket.sha256 !== declaration.sha256 ||
      ticket.name !== declaration.name || ticket.byteLength !== declaration.byteLength ||
      ticket.space !== declaration.space || ticket.folderId !== declaration.folderId ||
      ticket.mediaType !== declaration.mediaType || ticket.target?.id !== declaration.target?.id ||
      ticket.target?.revision !== declaration.target?.revision ||
      job.ticket && ticket.id !== job.ticket.id) throw new TransferFailure('conflict')
    job.ticket = ticket
    this.uploadPatch({ ticketId: ticket.id, done: ticket.receivedBytes })
  }

  private async finishTerminal(job: UploadJob): Promise<boolean> {
    const ticket = job.ticket
    if (!ticket) throw new Error('Upload completion requires its negotiated ticket')
    if (ticket.status === 'uploading') return false
    this.uploadPatch({ phase: ticket.status, error: null, done: ticket.status === 'completed' ? ticket.byteLength : ticket.receivedBytes })
    this.patch({ pending: this.state.getSnapshot().pending.filter(value => value.id !== ticket.id) })
    if (ticket.status === 'completed') {
      this.notify('saved', true)
      await this.published()
    }
    return true
  }

  private async finishCancellation(job: UploadJob): Promise<void> {
    this.uploadPatch({ phase: 'cancelling', error: null })
    if (!job.declaration) {
      this.uploadPatch({ phase: 'cancelled' })
      return
    }
    if (!job.ticket) {
      const pending = await this.result(this.remote.driveUploads())
      if (!this.isUpload(job)) return
      const ticket = pending.find(value => value.requestId === job.requestId)
      this.patch({ pending })
      if (!ticket) {
        // No bytes can be sent before a ticket arrives; an unobserved late reservation expires on the server.
        this.uploadPatch({ phase: 'stopped' })
        return
      }
      this.acceptTicket(job, ticket)
    }
    const ticket = job.ticket
    if (!ticket) throw new Error('Upload cancellation requires its negotiated ticket')
    this.acceptTicket(job, await this.result(this.remote.cancelDriveUpload(ticket.id)))
    if (!this.isUpload(job)) return
    if (!await this.finishTerminal(job)) throw new TransferFailure('unavailable')
  }

  private async result<T>(operation: Promise<RemoteResult<OfficeOutcome<T>>>): Promise<T> {
    const response = await operation
    if (!response.ok) throw new TransferFailure('unavailable')
    if (!response.value.ok) throw new TransferFailure(response.value.code)
    return response.value.value
  }
  private errorKey(error: unknown): OfficeKey { return error instanceof TransferFailure ? error.key : 'unavailable' }
  private uploadFailure(error: unknown): void {
    const key = this.errorKey(error)
    this.uploadPatch({ phase: 'failed', error: key })
    this.notify(key, false)
  }
  private checkUpload(job: UploadJob): void { if (!this.isUpload(job) || job.cancel) throw new Stopped() }
  private isUpload(job: UploadJob): boolean { return this.current(job.epoch) && this.upload === job }
  private checkDownload(job: DownloadJob): void {
    if (!this.current(job.epoch) || this.download !== job || job.cancel) throw new Stopped()
  }
  private available(): boolean { return !this.disposed && this.principal !== null && this.limits !== null }
  private current(epoch: number): boolean { return !this.disposed && this.epoch === epoch && this.principal !== null }
  private patch(value: Partial<TransferState>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
  private uploadPatch(value: Partial<UploadProgress>): void {
    const upload = this.state.getSnapshot().upload
    if (upload) this.patch({ upload: { ...upload, ...value } })
  }
  private downloadPatch(value: Partial<Progress<DownloadPhase>>): void {
    const download = this.state.getSnapshot().download
    if (download) this.patch({ download: { ...download, ...value } })
  }
}
