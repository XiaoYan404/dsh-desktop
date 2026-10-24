/** Authorized immutable Drive material reads run inside Office's existing write queue without recursively enqueuing. */
import { z } from 'zod'
import { OfficeError } from './error.ts'
import type { OfficeDriveBlob } from './drive-blobs.ts'
import type { OfficeDriveTransferFiles } from './drive-transfer-files.ts'
import type { OfficeOaMaterialReader } from './oa-v2.ts'

/**
 * Reuse Office's verified immutable file ranges with current authorization before and after each asynchronous read.
 * @param authorize - Synchronous owning-queue lookup rechecking the current actor/role, ancestor ACL and exact version.
 * @param files - Existing Office object reader; not a new filesystem root or path resolver.
 * @param limits - Explicit deployment file-byte and existing Drive chunk bounds.
 * @returns Material reader for OA v2 only; no upload, credential resolution or external request occurs here.
 */
export function createOfficeOaMaterialReader(
  authorize: (request: Parameters<OfficeOaMaterialReader['read']>[0], reference: Parameters<OfficeOaMaterialReader['read']>[1]) => {
    readonly blob: OfficeDriveBlob
    readonly name: string
    readonly mediaType: string
  }, files: () => OfficeDriveTransferFiles, limits: { readonly maxFileBytes: number; readonly chunkBytes: number },
): OfficeOaMaterialReader {
  const config = z.object({ maxFileBytes: z.number().int().min(1).max(16777216),
    chunkBytes: z.number().int().min(1).max(16777216) }).strict().parse(limits)
  function current(request: Parameters<OfficeOaMaterialReader['read']>[0], reference: Parameters<OfficeOaMaterialReader['read']>[1]) {
    request.signal.throwIfAborted()
    const file = authorize(request, reference)
    if (file.blob.id !== reference.version || file.blob.sha256 !== reference.sha256 ||
      file.blob.byteLength > config.maxFileBytes) throw new OfficeError('conflict', 'Reviewed OA material version changed or exceeds its bound')
    return file
  }
  return { async read(request, reference) {
    const file = current(request, reference)
    const parts: Uint8Array[] = []
    if (!file.blob.byteLength) await files().verify(file.blob)
    for (let offset = 0; offset < file.blob.byteLength; offset += config.chunkBytes) {
      current(request, reference)
      parts.push(await files().readRange(file.blob, offset, Math.min(config.chunkBytes, file.blob.byteLength - offset)))
      current(request, reference)
    }
    const verified = current(request, reference)
    return { bytes: Buffer.concat(parts), name: verified.name, mediaType: verified.mediaType }
  }, assertCurrent(request, references) {
    for (const reference of references) current(request, reference)
    return Promise.resolve()
  } }
}
