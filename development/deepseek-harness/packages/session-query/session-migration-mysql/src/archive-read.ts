/** Bounded archive reads use one open file and reject concurrent size changes without reading its growth. */
import type { FileHandle } from 'node:fs/promises'
import { MigrationError } from './error.ts'

/**
 * Read the exact initial size and probe one byte for growth; caller owns and closes the handle.
 * @param file - Open regular archive file, retained for this entire read.
 * @param maximum - Remaining complete-input byte budget, including this file.
 * @param signal - Stops before allocation and between reads without modifying the file.
 * @returns Complete bytes or CAPACITY/SOURCE_CHANGED; no oversized growth is materialized.
 */
export async function readOpenArchiveFile(file: FileHandle, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new MigrationError('CAPACITY')
  const info = await file.stat()
  signal?.throwIfAborted()
  if (!info.isFile()) throw new MigrationError('INVALID_ARCHIVE')
  if (info.size > maximum) throw new MigrationError('CAPACITY')
  const bytes = Buffer.allocUnsafe(info.size)
  let offset = 0
  while (offset < bytes.byteLength) {
    signal?.throwIfAborted()
    const result = await file.read(bytes, offset, bytes.byteLength - offset, offset)
    if (result.bytesRead === 0) throw new MigrationError('SOURCE_CHANGED')
    offset += result.bytesRead
  }
  signal?.throwIfAborted()
  const extra = await file.read(Buffer.allocUnsafe(1), 0, 1, offset)
  signal?.throwIfAborted()
  if (extra.bytesRead !== 0) throw new MigrationError('SOURCE_CHANGED')
  return bytes
}
