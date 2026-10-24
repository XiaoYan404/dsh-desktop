/** Office image authority: real raster admission with queued source ownership supplied by Office. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { prepareImageFile } from '@deepseek-ai/dsh-attachment-local'
import type { OfficeConversationFileReference, OfficeMemberId } from './types.ts'
import { OfficeError } from './error.ts'
import { officeConversationFileSchemas } from './conversation-files.ts'
import { officeDriveRequestSchemas } from './drive.ts'
import type { OfficeConversationImageRead, OfficeConversationImageReadInput, OfficeImagePolicy } from './image-types.ts'

const media = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const policySchema = z.object({
  maxSourceBytes: z.number().int().min(1).max(20 * 1024 * 1024),
  maxSourcePixels: z.number().int().min(1).max(64 * 1024 * 1024),
  maxSourceDimension: z.number().int().min(1).max(8192),
  maxResponseBytes: z.number().int().min(128).max(16 * 1024 * 1024),
  mediaTypes: z.array(media).min(1).max(4).refine(values => new Set(values).size === values.length),
}).strict()

const coordinates = officeConversationFileSchemas.readDocx.pick({ captureId: true, fileId: true })
/** Strict one-operation input for the explicit RPC allowlist; no actor, URL, path or attachment identity is accepted. */
export const officeImageReadInput = z.discriminatedUnion('kind', [
  coordinates.extend({ kind: z.literal('read') }).strict(),
  coordinates.extend({ kind: z.literal('recheck'), versionId: officeDriveRequestSchemas.versionId,
    sha256: z.string().regex(/^[a-f\d]{64}$/u) }).strict(),
])

/** Existing Office queue owns both source callbacks; publish performs its checks and projection without an await. */
export interface OfficeImageSourcePort {
  /** Authorize current active employee/capture role/Drive ancestry/head, load bounded real bytes and verify their digest. */
  load(actor: OfficeMemberId, input: OfficeConversationImageReadInput, maxBytes: number,
    signal: AbortSignal): Promise<{ readonly file: OfficeConversationFileReference; readonly bytes: Buffer }>
  /** Recheck the same authority and exact captured file, then call project synchronously before releasing the queue. */
  publish<T>(actor: OfficeMemberId, input: OfficeConversationImageReadInput,
    project: (file: OfficeConversationFileReference) => T): T | Promise<T>
}

/** Actual decoder receives verified source bytes; it never creates a Native attachment or reports OCR text. */
export type OfficeImageDecoder = (bytes: Uint8Array, mediaType: ImageMediaType, policy: OfficeImagePolicy) => Promise<void>

/**
 * Resolve explicit limits, preserving an omitted optional deployment as disabled.
 * @param input - Optional imageRead object from the owning Office configuration parser.
 * @returns Complete validated policy, or undefined while disabled.
 */
export function resolveOfficeImagePolicy(input: unknown): OfficeImagePolicy | undefined {
  if (input === undefined) return undefined
  const parsed = policySchema.safeParse(input)
  if (!parsed.success) throw new OfficeError('invalid_input', 'Image reading requires complete finite explicit limits')
  return parsed.data
}

function sourceDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameSource(a: OfficeConversationFileReference, b: OfficeConversationFileReference): boolean {
  return a.id === b.id && a.versionId === b.versionId && a.sha256 === b.sha256 && a.byteLength === b.byteLength
    && a.mediaType === b.mediaType && a.name === b.name
}

function signature(bytes: Buffer): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
  return undefined
}

/**
 * Fully decode supported raster bytes through the existing public attachment-local implementation without storing data.
 * @param bytes - Digest-verified immutable encoded source.
 * @param mediaType - Allowlisted declared media already matched to its signature.
 * @param policy - Explicit source byte, pixel and per-side limits.
 * @returns Completion only after real decoding/normalization; the authority still returns the original source bytes.
 */
export const decodeOfficeImage: OfficeImageDecoder = async (bytes, mediaType, policy) => {
  try {
    await prepareImageFile({ data: bytes, mediaType }, {
      maxImageBytes: policy.maxSourceBytes, maxImagePixels: policy.maxSourcePixels,
      maxImageDimension: policy.maxSourceDimension, maxImagesPerMessage: 1,
      maxMessageImageBytes: policy.maxSourceBytes, mediaTypes: policy.mediaTypes,
    }, { maxPixels: policy.maxSourcePixels, maxDimension: policy.maxSourceDimension, maxBytes: policy.maxSourceBytes })
  } catch (cause) {
    if (!(cause instanceof AttachmentError)) throw cause
    const limited = ['IMAGE_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE'].includes(cause.code)
    throw new OfficeError(limited ? 'context_too_large' : 'invalid_input', 'Submitted image failed raster admission', { cause })
  }
}

function boundedResult(value: OfficeConversationImageRead, maxBytes: number): OfficeConversationImageRead {
  if (Buffer.byteLength(JSON.stringify({ ok: true, value }), 'utf8') > maxBytes)
    throw new OfficeError('context_too_large', 'Complete image response exceeds its byte limit')
  return value
}

/** Optional service module intended to execute wholly inside the existing Office enqueue operation. */
export class OfficeImageReader {
  /** Complete explicit limits; undefined disables image reads and capability advertisement. */
  readonly policy: OfficeImagePolicy | undefined

  /**
   * @param source - Current Office authority callbacks; no replacement permission system is provided here.
   * @param config - Optional explicit deployment limits; undefined stays disabled.
   * @param decode - Real decoder; an owning test may wrap it to observe an awaited decode boundary.
   */
  constructor(private readonly source: OfficeImageSourcePort, config: unknown,
    private readonly decode: OfficeImageDecoder = decodeOfficeImage) {
    this.policy = resolveOfficeImagePolicy(config)
  }

  /**
   * Read exact submitted raster bytes or recheck the same source after Native normalization.
   * @param actor - Authenticated employee, supplied by withSession rather than request fields.
   * @param input - One strict read/recheck operation using the original capture and file.
   * @param signal - Original transport/tool cancellation combined with Office lifetime by the owner.
   * @returns Full-envelope-bounded original bytes after decoding and final current authorization, or metadata-only recheck.
   */
  async read(actor: OfficeMemberId, input: OfficeConversationImageReadInput, signal: AbortSignal): Promise<OfficeConversationImageRead> {
    signal.throwIfAborted()
    const policy = this.policy
    if (!policy) throw new OfficeError('forbidden', 'Submitted image reading is not enabled')
    const parsed = officeImageReadInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid submitted image operation')
    const value = parsed.data
    if (value.kind === 'recheck') return this.source.publish(actor, value, file => {
      signal.throwIfAborted()
      if (file.versionId !== value.versionId || file.sha256 !== value.sha256)
        throw new OfficeError('conflict', 'Submitted image source changed')
      return boundedResult({ kind: 'recheck', file }, policy.maxResponseBytes)
    })
    const { file, bytes } = await this.source.load(actor, value, policy.maxSourceBytes, signal)
    signal.throwIfAborted()
    if (bytes.length < 1 || bytes.length > policy.maxSourceBytes)
      throw new OfficeError('context_too_large', 'Submitted image exceeds its source byte limit')
    if (bytes.length !== file.byteLength || sourceDigest(bytes) !== file.sha256)
      throw new OfficeError('conflict', 'Submitted image source verification failed')
    const actual = signature(bytes)
    if (!actual || actual !== file.mediaType || !policy.mediaTypes.includes(actual))
      throw new OfficeError('invalid_input', 'Submitted image signature or media type is unsupported')
    await this.decode(bytes, actual, policy)
    signal.throwIfAborted()
    if (sourceDigest(bytes) !== file.sha256)
      throw new OfficeError('conflict', 'Submitted image bytes changed during decoding')
    return this.source.publish(actor, value, current => {
      signal.throwIfAborted()
      if (!sameSource(file, current)) throw new OfficeError('conflict', 'Submitted image source changed')
      // Account for all metadata and the canonical base64 expansion before allocating that string.
      const empty = { kind: 'read' as const, file: current, dataBase64: '' }
      const encodedBytes = 4 * Math.ceil(bytes.length / 3)
      if (Buffer.byteLength(JSON.stringify({ ok: true, value: empty }), 'utf8') + encodedBytes > policy.maxResponseBytes)
        throw new OfficeError('context_too_large', 'Complete image response exceeds its byte limit')
      return boundedResult({ ...empty, dataBase64: bytes.toString('base64') }, policy.maxResponseBytes)
    })
  }
}
