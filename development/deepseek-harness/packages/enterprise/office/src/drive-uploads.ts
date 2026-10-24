/** Upload receipts and reservations are separate from the released drive-directory schema. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import { officeDriveRequestSchemas as drive } from './drive.ts'
import type { OfficeDriveRepository } from './drive.ts'
import { OfficeDriveTransferFiles } from './drive-transfer-files.ts'
import type {
  OfficeDriveTransferLimits, OfficeDriveUploadChunkInput, OfficeDriveUploadDeclaration,
  OfficeDriveUploadId, OfficeDriveUploadTicket, OfficeMember, OfficeMemberId,
} from './types.ts'

/** Chunk-protocol envelope bounds; deployment configuration can select stricter limits. */
export const DRIVE_TRANSFER_MAX_FILE_BYTES = 1024 * 1024 * 1024
/** Largest encoded chunk admitted by the shared office request parser. */
export const DRIVE_TRANSFER_MAX_CHUNK_BYTES = 2 * 1024 * 1024
/** Smallest negotiated chunk keeps receipt arrays bounded within the protocol envelope. */
export const DRIVE_TRANSFER_MIN_CHUNK_BYTES = 64 * 1024
const maxParts = DRIVE_TRANSFER_MAX_FILE_BYTES / DRIVE_TRANSFER_MIN_CHUNK_BYTES
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

/** Opaque server resource identity, checked before every ticket lookup. */
export const officeDriveUploadId = z.uuid().transform(value => brandString<OfficeDriveUploadId>(value))
/** Reviewed logical destination and complete-file integrity declaration. */
export const officeDriveUploadDeclaration = drive.folderInput.extend({
  requestId: z.uuid(), mediaType: drive.uploadInput.shape.mediaType,
  byteLength: counter.max(DRIVE_TRANSFER_MAX_FILE_BYTES), sha256,
  target: z.object({ id: drive.id, revision: counter.positive() }).strict().optional(),
}).strict()
/** A single bounded canonical chunk; the authority validates its negotiated position and length. */
export const officeDriveUploadChunk = z.object({
  uploadId: officeDriveUploadId, index: counter.max(maxParts - 1), sha256,
  dataBase64: z.string().max(Math.ceil(DRIVE_TRANSFER_MAX_CHUNK_BYTES / 3) * 4),
}).strict()
/** Version-bound download coordinates, independent of native filesystem paths. */
export const officeDriveRangeInput = z.object({
  id: drive.id, versionId: z.uuid().transform(value => brandString<import('./types.ts').OfficeDriveVersionId>(value)),
  offset: counter.max(DRIVE_TRANSFER_MAX_FILE_BYTES), byteLength: counter.max(DRIVE_TRANSFER_MAX_CHUNK_BYTES),
}).strict()

const part = z.object({ index: counter.max(maxParts - 1),
  byteLength: counter.positive().max(DRIVE_TRANSFER_MAX_CHUNK_BYTES), sha256 }).strict()
const ticket = officeDriveUploadDeclaration.extend({
  id: officeDriveUploadId, ownerId: officeMemberId, createdAt: counter, expiresAt: counter,
  chunkBytes: counter.min(DRIVE_TRANSFER_MIN_CHUNK_BYTES).max(DRIVE_TRANSFER_MAX_CHUNK_BYTES),
  status: z.enum(['uploading', 'completed', 'cancelled', 'expired']),
  fileId: drive.id.nullable(), finishedAt: counter.nullable(), fingerprint: sha256,
  parts: z.array(part).max(maxParts).readonly(),
}).strict().superRefine((value, ctx) => {
  if (value.expiresAt <= value.createdAt || (value.status === 'uploading') !== (value.finishedAt === null)
    || (value.status === 'completed') !== (value.fileId !== null)
    || value.status !== 'uploading' && value.parts.length !== 0
    || new Set(value.parts.map(part => part.index)).size !== value.parts.length
    || value.parts.some(part => part.index >= Math.ceil(value.byteLength / value.chunkBytes)
      || part.byteLength !== Math.min(value.chunkBytes, value.byteLength - part.index * value.chunkBytes))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid upload receipt state' })
  }
})
const state = z.object({ revision: counter, entries: z.array(ticket).max(100_000).readonly() }).strict().superRefine((value, ctx) => {
  if (new Set(value.entries.map(ticket => ticket.id)).size !== value.entries.length
    || new Set(value.entries.map(ticket => ticket.requestId)).size !== value.entries.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate upload identities' })
  }
})
type Ticket = z.infer<typeof ticket>

/** An additive domain retains resumable receipts without rewriting any original drive or office records. */
export const officeDriveUploadDomain = defineDomain({
  name: 'enterprise_office_uploads', version: 1,
  global: { schema: state, initial: { revision: 0, entries: [] } }, tables: {},
})

/** Explicit deployment policy resolved once by OfficeService. */
export interface DriveUploadAuthorityLimits extends Omit<OfficeDriveTransferLimits, 'protocol'> {
  readonly maxEntries: number
  readonly retentionMs: number
}

/** Membership, sessions, directory changes and every operation here share OfficeService's queue. */
export class OfficeDriveUploadRepository {
  constructor(
    private readonly domain: Domain<typeof officeDriveUploadDomain>,
    private readonly directory: OfficeDriveRepository,
    private readonly objectRoot: string,
    private readonly limits: DriveUploadAuthorityLimits,
    private readonly reportCleanup: (error: unknown) => void,
  ) {}

  /**
   * Advertise the additive protocol while the legacy whole-file bounds remain unchanged.
   * @returns Validated current deployment limits.
   */
  capabilities(): OfficeDriveTransferLimits {
    return { protocol: 1, maxFileBytes: this.limits.maxFileBytes, ownerQuotaBytes: this.limits.ownerQuotaBytes,
      chunkBytes: this.limits.chunkBytes, maxPendingUploads: this.limits.maxPendingUploads, expiresAfterMs: this.limits.expiresAfterMs }
  }

  /**
   * Reject upload state detached from its original retained employee directory.
   * @param members - Active and inactive historical employees.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    if (this.domain.global.get().entries.some(ticket => !ids.has(ticket.ownerId))) {
      throw new OfficeError('conflict', 'Saved uploads require their original employee directory')
    }
    for (const ticket of this.domain.global.get().entries) this.directory.uploadQuotaOwner(ticket.ownerId, ticket)
  }

  /**
   * Reserve declared bytes until cancellation, expiry cleanup or confirmed directory publication.
   * @param ownerId - Employee whose whole and chunked uploads share one quota.
   * @param exceptRequest - This request's existing reservation, excluded during its own recheck.
   * @returns Pending bytes, including expired records whose cleanup has not succeeded.
   */
  reservedBytes(ownerId: OfficeMemberId, exceptRequest?: string): number {
    return this.domain.global.get().entries.filter(ticket => this.directory.uploadQuotaOwner(ticket.ownerId, ticket) === ownerId && ticket.status === 'uploading'
      && ticket.requestId !== exceptRequest && !this.directory.retainsRequest(ticket.requestId))
      .reduce((total, ticket) => total + ticket.byteLength, 0)
  }

  /**
   * Keep an unfinished or cancelled chunk identity from being reused through the legacy whole-file endpoint.
   * @param requestId - Caller retry identity; ownership is not exposed by a rejection.
   */
  requireWholeRequest(requestId: string): void {
    if (this.domain.global.get().entries.some(ticket => ticket.requestId === requestId && ticket.status !== 'completed')) {
      throw new OfficeError('conflict', 'This request belongs to a resumable upload')
    }
  }

  /**
   * Create or recover one owner's immutable declaration after checking current destination and quota.
   * @param actor - Currently authenticated active employee.
   * @param input - Reviewed declaration, never an owner or storage path.
   * @returns The durable ticket or an identical prior outcome.
   */
  async begin(actor: OfficeMember, input: OfficeDriveUploadDeclaration): Promise<OfficeDriveUploadTicket> {
    const parsed = officeDriveUploadDeclaration.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid upload declaration')
    await this.sweep()
    const value = parsed.data
    const fingerprint = this.fingerprint(actor, value)
    const current = this.domain.global.get()
    const existing = current.entries.find(ticket => ticket.requestId === value.requestId)
    if (existing !== undefined) {
      if (existing.ownerId !== actor.id || existing.fingerprint !== fingerprint) throw new OfficeError('conflict', 'Upload retry identity was reused')
      if (existing.status === 'uploading') { this.writable(existing); this.directory.prepareUpload(actor, existing) }
      return this.project(existing)
    }
    const committed = this.directory.prepareUpload(actor, value)
    if (current.entries.length >= this.limits.maxEntries
      || committed === null && current.entries.filter(ticket => ticket.ownerId === actor.id && ticket.status === 'uploading').length >= this.limits.maxPendingUploads) {
      throw new OfficeError('conflict', 'Upload session capacity reached')
    }
    const now = Date.now()
    const next: Ticket = { ...value, id: brandString<OfficeDriveUploadId>(randomUUID()), ownerId: actor.id,
      createdAt: now, expiresAt: now + this.limits.expiresAfterMs, chunkBytes: this.limits.chunkBytes, fingerprint,
      status: committed === null ? 'uploading' : 'completed', fileId: committed?.id ?? null,
      finishedAt: committed === null ? null : now, parts: [] }
    await this.save([...current.entries, next])
    return this.project(next)
  }

  /**
   * List only this employee's unfinished uploads; terminal outcomes remain addressable until retention ends.
   * @param actor - Current active employee.
   * @returns At most the employee's admitted pending tickets.
   */
  async list(actor: OfficeMember): Promise<readonly OfficeDriveUploadTicket[]> {
    await this.sweep()
    return this.domain.global.get().entries.filter(ticket => ticket.ownerId === actor.id && ticket.status === 'uploading').map(ticket => this.project(ticket))
  }

  /**
   * Fetch the owner's confirmed receipt state without disclosing another employee's identity.
   * @param actor - Current active employee.
   * @param id - Server-owned upload coordinate.
   * @returns A private durable ticket snapshot.
   */
  async get(actor: OfficeMember, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket> {
    await this.sweep()
    return this.project(this.owned(actor, id))
  }

  /**
   * Verify a canonical chunk and current destination authority before durable staging and receipt acknowledgement.
   * @param actor - Current active employee held in the shared authority queue.
   * @param input - Stable upload identity, position, digest and bounded encoded bytes.
   * @returns The confirmed receipt state; failed receipt persistence can be retried with identical bytes.
   */
  async append(actor: OfficeMember, input: OfficeDriveUploadChunkInput): Promise<OfficeDriveUploadTicket> {
    const parsed = officeDriveUploadChunk.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid upload chunk')
    await this.sweep()
    const value = parsed.data
    const current = this.owned(actor, value.uploadId)
    this.writable(current)
    const committed = this.directory.prepareUpload(actor, current)
    if (committed !== null) return this.finishRecord(current, committed.id)
    const expected = Math.min(current.chunkBytes, current.byteLength - value.index * current.chunkBytes)
    const bytes = Buffer.from(value.dataBase64, 'base64')
    if (expected < 1 || bytes.byteLength !== expected || bytes.toString('base64') !== value.dataBase64
      || createHash('sha256').update(bytes).digest('hex') !== value.sha256) {
      throw new OfficeError('invalid_input', 'Upload chunk length or digest is invalid')
    }
    const previous = current.parts.find(part => part.index === value.index)
    if (previous !== undefined && previous.sha256 !== value.sha256) throw new OfficeError('conflict', 'Upload chunk retry changed')
    const part = await this.files(current).stageChunk(current.id, value.index, bytes)
    if (previous !== undefined) return this.project(current)
    const next = { ...current, parts: [...current.parts, part].sort((a, b) => a.index - b.index) }
    await this.replace(next)
    return this.project(next)
  }

  /**
   * Verify complete bytes and publish once; a lost receipt after directory commit is recovered on retry.
   * @param actor - Current active employee held in the shared queue.
   * @param id - Upload identity whose immutable declaration is being committed.
   * @returns The confirmed completed ticket and logical file identity.
   */
  async complete(actor: OfficeMember, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket> {
    await this.sweep()
    const current = this.owned(actor, id)
    if (current.status === 'completed') return this.project(current)
    this.writable(current)
    const committed = this.directory.prepareUpload(actor, current)
    if (committed !== null) return this.finishRecord(current, committed.id)
    const blob = await this.files(current).merge(current.id, current, current.parts)
    this.writable(current)
    const file = await this.directory.publishUpload(actor, current, blob)
    return this.finishRecord(current, file.id)
  }

  /**
   * Persist cancellation before collecting bytes; an already published file is reported as completed.
   * @param actor - Current active ticket owner; directory access is not needed to cancel owned staging.
   * @param id - Server-owned upload identity.
   * @returns A confirmed terminal outcome, retaining published files after an uncertain completion response.
   */
  async cancel(actor: OfficeMember, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket> {
    await this.sweep()
    const current = this.owned(actor, id)
    if (current.status !== 'uploading') return this.project(current)
    const fileId = this.directory.referencedFile(current.id)
    if (fileId !== null) return this.finishRecord(current, fileId)
    const next: Ticket = { ...current, status: 'cancelled', finishedAt: Math.max(Date.now(), current.createdAt), parts: [], fileId: null }
    await this.replace(next)
    await this.cleanup(next)
    return this.project(next)
  }

  /** Reclaim expired staging and retained terminal receipts under the office mutation queue. */
  async sweep(): Promise<void> {
    const current = this.domain.global.get()
    const now = Date.now()
    const next: Ticket[] = []
    let changed = false
    for (const ticket of current.entries) {
      const published = this.directory.referencedFile(ticket.id)
      if (ticket.status === 'uploading' && published !== null) {
        await this.cleanup(ticket)
        next.push({ ...ticket, status: 'completed', fileId: published, parts: [], finishedAt: Math.max(now, ticket.createdAt) })
        changed = true
        continue
      }
      if (ticket.status === 'uploading' && ticket.expiresAt > now) { next.push(ticket); continue }
      if (!await this.cleanup(ticket)) { next.push(ticket); continue }
      if (ticket.status === 'uploading') {
        const fileId = this.directory.referencedFile(ticket.id)
        next.push({ ...ticket, status: fileId === null ? 'expired' : 'completed', fileId,
          parts: [], finishedAt: Math.max(now, ticket.createdAt) })
        changed = true
      } else if (ticket.finishedAt !== null && ticket.finishedAt + this.limits.retentionMs <= now) changed = true
      else next.push(ticket)
    }
    if (changed) await this.save(next)
  }

  private async cleanup(ticket: Ticket): Promise<boolean> {
    try { await this.files(ticket).discard(ticket.id, this.directory.referencedFile(ticket.id) === null); return true }
    catch (error) { this.reportCleanup(error); return false }
  }

  private files(ticket: Ticket): OfficeDriveTransferFiles {
    return new OfficeDriveTransferFiles(this.objectRoot, { maxFileBytes: DRIVE_TRANSFER_MAX_FILE_BYTES, chunkBytes: ticket.chunkBytes })
  }

  private async finishRecord(ticket: Ticket, fileId: import('./types.ts').OfficeDriveId): Promise<OfficeDriveUploadTicket> {
    const next: Ticket = { ...ticket, status: 'completed', fileId, parts: [], finishedAt: Math.max(Date.now(), ticket.createdAt) }
    await this.replace(next)
    await this.cleanup(next)
    return this.project(next)
  }

  private owned(actor: OfficeMember, id: OfficeDriveUploadId): Ticket {
    if (!officeDriveUploadId.safeParse(id).success) throw new OfficeError('invalid_input', 'Invalid upload identity')
    const entry = this.domain.global.get().entries.find(ticket => ticket.id === id && ticket.ownerId === actor.id)
    if (entry === undefined) throw new OfficeError('not_found', 'Upload is unavailable')
    return entry
  }

  private writable(ticket: Ticket): void {
    if (ticket.status !== 'uploading' || ticket.expiresAt <= Date.now()) throw new OfficeError('conflict', 'Upload is closed or expired')
  }

  private project(ticket: Ticket): OfficeDriveUploadTicket {
    return { id: ticket.id, requestId: ticket.requestId, name: ticket.name, space: ticket.space, folderId: ticket.folderId,
      mediaType: ticket.mediaType, byteLength: ticket.byteLength, sha256: ticket.sha256, status: ticket.status,
      createdAt: ticket.createdAt, expiresAt: ticket.expiresAt, chunkBytes: ticket.chunkBytes, fileId: ticket.fileId,
      received: ticket.parts.map(part => part.index),
      ...(ticket.target ? { target: ticket.target } : {}),
      receivedBytes: ticket.status === 'completed' ? ticket.byteLength : ticket.parts.reduce((total, part) => total + part.byteLength, 0) }
  }

  private fingerprint(actor: OfficeMember, value: OfficeDriveUploadDeclaration): string {
    return createHash('sha256').update(JSON.stringify({ actorId: actor.id, space: value.space, folderId: value.folderId,
      name: value.name, mediaType: value.mediaType, byteLength: value.byteLength, sha256: value.sha256, target: value.target })).digest('hex')
  }

  private async replace(ticket: Ticket): Promise<void> {
    await this.save(this.domain.global.get().entries.map(entry => entry.id === ticket.id ? ticket : entry))
  }

  private async save(entries: readonly Ticket[]): Promise<void> {
    const revision = this.domain.global.get().revision + 1
    if (!Number.isSafeInteger(revision)) throw new OfficeError('conflict', 'Upload revision limit reached')
    const next = { revision, entries }
    if (!state.safeParse(next).success) throw new OfficeError('invalid_input', 'Invalid upload state')
    await this.domain.global.set(next)
  }
}
