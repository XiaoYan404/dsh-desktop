/** Immutable opaque file objects; directory metadata is published only after durable bytes. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rm, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { OfficeError } from './error.ts'

/** Whole-request uploads are bounded; streamed/chunked large-file upload remains separate work. */
export const OFFICE_DRIVE_MAX_FILE_BYTES = 8 * 1024 * 1024
/** Referenced file versions owned by one employee share this initial quota. */
export const OFFICE_DRIVE_OWNER_BYTES = 256 * 1024 * 1024

/** The raw object identity and digest are kept in server metadata, never accepted as a download path. */
export interface OfficeDriveBlob {
  readonly id: string
  readonly sha256: string
  readonly byteLength: number
}

/** Local object store below the deployment's Harness home, independent of native workspace files. */
export class OfficeDriveBlobStore {
  private readonly root: string
  constructor(root: string) {
    this.root = resolve(root)
  }

  /**
   * Write a new exclusive object and fsync before returning its identity.
   * @param data - Already admitted bounded bytes.
   * @returns Immutable metadata; no directory entry has been published yet.
   */
  async write(data: Uint8Array): Promise<OfficeDriveBlob> {
    if (data.byteLength > OFFICE_DRIVE_MAX_FILE_BYTES)
      throw new OfficeError('invalid_input', 'File exceeds the upload limit')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const id = randomUUID()
    const path = this.path(id)
    const handle = await open(path, 'wx', 0o600)
    let complete = false
    try {
      await handle.writeFile(data)
      await handle.sync()
      complete = true
    } finally {
      await handle.close()
      // This exclusive create owns the path. No metadata references an incomplete object.
      if (!complete) await rm(path, { force: true })
    }
    if (process.platform !== 'win32') {
      const directory = await open(this.root, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    return { id, sha256: createHash('sha256').update(data).digest('hex'), byteLength: data.byteLength }
  }

  /**
   * Read only a server-selected object and verify its complete bytes before returning them.
   * @param blob - Persisted metadata from an authorized entry.
   * @returns Verified bytes; missing, replaced and corrupt objects publish no content.
   */
  async read(blob: OfficeDriveBlob): Promise<Buffer> {
    const path = this.path(blob.id)
    const stat = await lstat(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== blob.byteLength ||
      stat.size > OFFICE_DRIVE_MAX_FILE_BYTES
    )
      throw new OfficeError('conflict', 'Stored file object does not match its metadata')
    const handle = await open(path, 'r')
    const data = Buffer.alloc(blob.byteLength)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size !== blob.byteLength || opened.ino !== stat.ino || opened.dev !== stat.dev)
        throw new OfficeError('conflict', 'Stored file object changed during open')
      let offset = 0
      while (offset < data.byteLength) {
        const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset)
        if (bytesRead === 0) throw new OfficeError('conflict', 'Stored file object is truncated')
        offset += bytesRead
      }
      if ((await handle.stat()).size !== blob.byteLength)
        throw new OfficeError('conflict', 'Stored file object changed during read')
    } finally {
      await handle.close()
    }
    if (data.byteLength !== blob.byteLength || createHash('sha256').update(data).digest('hex') !== blob.sha256)
      throw new OfficeError('conflict', 'Stored file integrity check failed')
    return data
  }

  /**
   * Remove only a server-selected object path after a durable cleanup decision.
   * @param id - Persisted opaque object identity, never a caller-supplied filesystem path.
   * @returns After unlink and the supported directory durability barrier; a missing object is already collected.
   */
  async remove(id: string): Promise<void> {
    const path = this.path(id)
    try { await unlink(path) }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    if (process.platform !== 'win32') {
      const directory = await open(this.root, 'r')
      try { await directory.sync() }
      finally { await directory.close() }
    }
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))
      throw new OfficeError('invalid_input', 'Invalid immutable object identity')
    const path = join(this.root, `${id}.bin`)
    if (dirname(path) !== this.root) throw new OfficeError('invalid_input', 'Object path escaped its configured root')
    return path
  }
}
