/** Bounded staged chunks and immutable large objects share the existing drive object directory. */
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { OfficeDriveBlob } from './drive-blobs.ts'
import { OfficeError } from './error.ts'

/** Deployment-resolved file and individual chunk bounds. */
export interface DriveTransferFileLimits {
  readonly maxFileBytes: number
  readonly chunkBytes: number
}

/** Durable chunk coordinates retained by the upload authority; no filesystem path crosses that boundary. */
export interface DriveUploadPart {
  readonly index: number
  readonly byteLength: number
  readonly sha256: string
}

type Content = Pick<OfficeDriveBlob, 'byteLength' | 'sha256'>
type CheckedFile = { handle: FileHandle; signature: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu

/** Caller admission owns employee authority, reservations and the decision to discard an unpublished object. */
export class OfficeDriveTransferFiles {
  private readonly root: string
  private readonly staging: string
  private readonly verified = new WeakMap<OfficeDriveBlob, string>()
  private readonly publications = new Map<string, Promise<undefined>>()

  constructor(root: string, private readonly limits: DriveTransferFileLimits) {
    this.root = resolve(root)
    this.staging = join(this.root, 'uploads')
  }

  /**
   * Fsync a bounded chunk before its authority records receipt; identical retries reuse its bytes.
   * @param uploadId - Server-minted upload identity from an authorized record.
   * @param index - Zero-based chunk position.
   * @param data - Admitted decoded bytes.
   * @returns Immutable chunk metadata; a conflicting retry leaves the original file intact.
   */
  async stageChunk(uploadId: string, index: number, data: Uint8Array): Promise<DriveUploadPart> {
    this.chunkIndex(index)
    const maximum = Math.min(this.limits.chunkBytes, this.limits.maxFileBytes - index * this.limits.chunkBytes)
    if (data.byteLength < 1 || data.byteLength > maximum) throw new OfficeError('invalid_input', 'Invalid upload chunk size')
    const part = { index, byteLength: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') }
    const directory = this.stageDirectory(uploadId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OfficeError('conflict', 'Upload staging directory was replaced')
    await this.writeImmutable(join(directory, `${index}.part`), part, [data], this.limits.chunkBytes)
    await this.syncDirectory(this.staging)
    await this.syncDirectory(this.root)
    return part
  }

  /**
   * Assemble all admitted chunks into a stable immutable object; exact retries reuse the published bytes.
   * @param uploadId - Server-owned identity also naming the final object.
   * @param content - Declared complete length and SHA-256.
   * @param parts - Durably acknowledged chunks, in any arrival order.
   * @returns Verified immutable metadata; directory publication remains the authority's next operation.
   */
  async merge(uploadId: string, content: Content, parts: readonly DriveUploadPart[]): Promise<OfficeDriveBlob> {
    this.content(content, this.limits.maxFileBytes)
    const ordered = [...parts].sort((a, b) => a.index - b.index)
    if (ordered.length !== Math.ceil(content.byteLength / this.limits.chunkBytes)
      || ordered.some((part, index) => part.index !== index
        || part.byteLength !== Math.min(this.limits.chunkBytes, content.byteLength - index * this.limits.chunkBytes))) {
      throw new OfficeError('conflict', 'Upload chunks are incomplete')
    }
    const blob = { id: uploadId, byteLength: content.byteLength, sha256: content.sha256 }
    await this.writeImmutable(this.objectPath(uploadId), content, this.parts(uploadId, ordered), this.limits.maxFileBytes)
    return blob
  }

  /**
   * Validate a complete immutable object with bounded memory before advertising a download.
   * @param blob - Server-selected authorized version metadata.
   */
  async verify(blob: OfficeDriveBlob): Promise<void> {
    const file = await this.openVerified(this.objectPath(blob.id), blob, this.limits.maxFileBytes, blob)
    await file.handle.close()
  }

  /**
   * Read an authorized bounded range from one immutable version, checking identity and complete-file integrity.
   * @param blob - Server-selected version metadata, never a client-selected path.
   * @param offset - Byte position within that version.
   * @param byteLength - At most one configured chunk, entirely within the version.
   * @returns Verified range bytes; changed or corrupt objects return no content.
   */
  async readRange(blob: OfficeDriveBlob, offset: number, byteLength: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 0
      || byteLength > this.limits.chunkBytes || offset > blob.byteLength - byteLength) {
      throw new OfficeError('invalid_input', 'Invalid file download range')
    }
    return this.readSpan(this.objectPath(blob.id), blob, offset, byteLength, this.limits.maxFileBytes, blob)
  }

  /**
   * Remove this upload's staging and partial writes; the authority decides whether its final object is unpublished.
   * @param uploadId - Identity retained by the durable upload ledger.
   * @param unpublished - True only after proving no drive version references this object.
   */
  async discard(uploadId: string, unpublished: boolean): Promise<void> {
    const directory = this.stageDirectory(uploadId)
    try {
      const stat = await lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OfficeError('conflict', 'Upload staging directory was replaced')
      await rm(directory, { recursive: true, force: true })
      await this.syncDirectory(this.staging)
    } catch (error) {
      if (!this.missing(error)) throw error
    }
    const object = this.objectPath(uploadId)
    if (unpublished) await rm(object, { force: true })
    try {
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        const prefix = `${uploadId}.bin.`
        if (entry.name.startsWith(prefix) && entry.name.endsWith('.partial')
          && uuid.test(entry.name.slice(prefix.length, -'.partial'.length)) && entry.isFile() && !entry.isSymbolicLink()) {
          await rm(join(this.root, entry.name))
        }
      }
      await this.syncDirectory(this.root)
    } catch (error) {
      if (!this.missing(error)) throw error
    }
  }

  private async *parts(uploadId: string, parts: readonly DriveUploadPart[]): AsyncGenerator<Uint8Array> {
    if (parts.length === 0) return
    const directory = this.stageDirectory(uploadId)
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OfficeError('conflict', 'Upload staging directory was replaced')
    for (const part of parts) {
      yield await this.readSpan(join(directory, `${part.index}.part`), part, 0, part.byteLength, this.limits.chunkBytes)
    }
  }

  private async writeImmutable(
    path: string, content: Content, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maximum: number,
  ): Promise<void> {
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    const previous = this.publications.get(key)
    const publication = Promise.withResolvers<undefined>()
    this.publications.set(key, publication.promise)
    try {
      if (previous) await previous
      await this.publishImmutable(path, content, chunks, maximum)
    } finally {
      publication.resolve(undefined)
      if (this.publications.get(key) === publication.promise) this.publications.delete(key)
    }
  }

  private async publishImmutable(
    path: string, content: Content, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maximum: number,
  ): Promise<void> {
    this.content(content, maximum)
    try {
      const existing = await this.openVerified(path, content, maximum)
      await existing.handle.close()
      return
    } catch (error) {
      if (!this.missing(error)) throw error
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.partial`
    const output = await open(temporary, 'wx', 0o600)
    try {
      const digest = createHash('sha256')
      let length = 0
      for await (const bytes of chunks) {
        length += bytes.byteLength
        if (length > content.byteLength) throw new OfficeError('conflict', 'Upload length exceeds its declaration')
        digest.update(bytes)
        await output.writeFile(bytes)
      }
      if (length !== content.byteLength || digest.digest('hex') !== content.sha256) {
        throw new OfficeError('conflict', 'Upload complete-file integrity check failed')
      }
      await output.sync()
      try { await link(temporary, path) }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
        const existing = await this.openVerified(path, content, maximum)
        await existing.handle.close()
      }
      await this.syncDirectory(dirname(path))
    } finally {
      await output.close()
      await rm(temporary, { force: true })
    }
  }

  private async openVerified(path: string, content: Content, maximum: number, key?: OfficeDriveBlob): Promise<CheckedFile> {
    this.content(content, maximum)
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(content.byteLength)) {
      throw new OfficeError('conflict', 'Stored file object does not match its metadata')
    }
    const handle = await open(path, 'r')
    try {
      const signature = this.signature(before)
      if (this.signature(await handle.stat({ bigint: true })) !== signature) throw new OfficeError('conflict', 'Stored file changed during open')
      if (key === undefined || this.verified.get(key) !== signature) {
        const buffer = Buffer.alloc(Math.min(this.limits.chunkBytes, Math.max(1, content.byteLength)))
        const digest = createHash('sha256')
        let offset = 0
        while (offset < content.byteLength) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, content.byteLength - offset), offset)
          if (bytesRead === 0) throw new OfficeError('conflict', 'Stored file object is truncated')
          digest.update(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
        if (digest.digest('hex') !== content.sha256) throw new OfficeError('conflict', 'Stored file integrity check failed')
        await this.unchanged(handle, signature)
        if (key !== undefined) this.verified.set(key, signature)
      }
      return { handle, signature }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  private async readSpan(
    path: string, content: Content, offset: number, length: number, maximum: number, key?: OfficeDriveBlob,
  ): Promise<Buffer> {
    const file = await this.openVerified(path, content, maximum, key)
    try {
      const data = Buffer.alloc(length)
      let read = 0
      while (read < length) {
        const { bytesRead } = await file.handle.read(data, read, length - read, offset + read)
        if (bytesRead === 0) throw new OfficeError('conflict', 'Stored file object is truncated')
        read += bytesRead
      }
      await this.unchanged(file.handle, file.signature)
      return data
    } finally { await file.handle.close() }
  }

  private signature(stat: BigIntStats): string {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  }

  private async unchanged(handle: FileHandle, signature: string): Promise<void> {
    if (this.signature(await handle.stat({ bigint: true })) !== signature) throw new OfficeError('conflict', 'Stored file changed during read')
  }

  private content(value: Content, maximum: number): void {
    if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > maximum
      || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
      throw new OfficeError('invalid_input', 'Invalid immutable file declaration')
    }
  }

  private chunkIndex(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(this.limits.maxFileBytes / this.limits.chunkBytes)) {
      throw new OfficeError('invalid_input', 'Invalid upload chunk index')
    }
  }

  private objectPath(id: string): string {
    if (!uuid.test(id)) throw new OfficeError('invalid_input', 'Invalid immutable object identity')
    return join(this.root, `${id}.bin`)
  }

  private stageDirectory(id: string): string {
    if (!uuid.test(id)) throw new OfficeError('invalid_input', 'Invalid upload identity')
    const directory = join(this.staging, id)
    if (dirname(directory) !== this.staging) throw new OfficeError('invalid_input', 'Upload path escaped its configured root')
    return directory
  }

  private async syncDirectory(directory: string): Promise<void> {
    if (process.platform === 'win32') return
    const handle = await open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }

  private missing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
}
