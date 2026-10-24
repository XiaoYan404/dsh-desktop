/** Bounded actual Drive bytes are verified before entering any knowledge parser. */
import { createHash } from 'node:crypto'
import type { OfficeDriveBlob } from './drive-blobs.ts'
import type { OfficeDriveTransferFiles } from './drive-transfer-files.ts'
import { OfficeError } from './error.ts'

/**
 * Read only a previously authorized server-selected immutable Drive object.
 * @param files - Existing Drive storage provider, retaining its physical-file verification.
 * @param blob - Server-owned exact source metadata, never a path from a request.
 * @param maximum - Resolved source/format input bound, checked before allocation.
 * @param chunkBytes - Existing deployment transfer chunk size.
 * @param signal - Original operation lifetime, checked between awaited reads.
 * @returns Digest- and length-verified original bytes; caller rechecks authority after parsing.
 */
export async function readOfficeKnowledgeSource(files: OfficeDriveTransferFiles, blob: OfficeDriveBlob,
  maximum: number, chunkBytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  if (blob.byteLength > maximum) throw new OfficeError('context_too_large', 'Knowledge source exceeds its input byte limit')
  if (!blob.byteLength) await files.verify(blob)
  const bytes = Buffer.alloc(blob.byteLength)
  for (let offset = 0; offset < bytes.length;) {
    signal.throwIfAborted()
    const part = await files.readRange(blob, offset, Math.min(chunkBytes, bytes.length - offset))
    if (!part.length) throw new OfficeError('conflict', 'Knowledge source read made no progress')
    part.copy(bytes, offset)
    offset += part.length
  }
  signal.throwIfAborted()
  if (createHash('sha256').update(bytes).digest('hex') !== blob.sha256)
    throw new OfficeError('conflict', 'Knowledge source digest changed')
  return bytes
}
