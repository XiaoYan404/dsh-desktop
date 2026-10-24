/** Submitted raster normalization and final source recheck before publishing a Native image block. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import { defineTool, validateArgs } from '@deepseek-ai/dsh-tools'
import type { InferArgs, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { OfficeConversationFileReference, OfficeConversationFilesCapture } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeBffRequest, officeToolDriver } from './driver.ts'
import type { OfficeWorkReview } from './work-approval.ts'
import type { OfficeImageAuthority, OfficeImageToolPolicy } from './image-authority-contract.ts'

/** Native tool identity for an explicitly enabled submitted-image read. */
export const READ_IMAGE_TOOL = 'office_read_image'
const parameters = {
  file_id: { type: 'string', required: true, description: 'Exact file_id of one image submitted with this input.' },
} as const

function assertPolicy(policy: OfficeImageToolPolicy): void {
  for (const value of [policy.maxSourceBytes, policy.maxNormalizedResultBytes])
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Office image byte limits must be positive safe integers')
}

function imageMediaType(file: OfficeConversationFileReference): ImageMediaType {
  const media = file.mediaType.split(';', 1)[0]?.trim().toLowerCase()
  if (media === 'image/png' || media === 'image/jpeg' || media === 'image/webp' || media === 'image/gif') return media
  throw new HarnessError('Select a submitted PNG, JPEG, WebP or GIF image.', 'OFFICE_IMAGE_MEDIA_UNSUPPORTED')
}

function sameSource(expected: OfficeConversationFileReference, actual: OfficeConversationFileReference): boolean {
  return expected.id === actual.id && expected.versionId === actual.versionId && expected.sha256 === actual.sha256
    && expected.byteLength === actual.byteLength && expected.mediaType === actual.mediaType && expected.name === actual.name
}

function sourceBytes(file: OfficeConversationFileReference, dataBase64: string): Buffer {
  const encodedLength = 4 * Math.ceil(file.byteLength / 3)
  if (dataBase64.length !== encodedLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(dataBase64))
    throw new HarnessError('Submitted image bytes do not match their declared encoding.', 'OFFICE_IMAGE_SOURCE_CHANGED')
  const bytes = Buffer.from(dataBase64, 'base64')
  if (bytes.length !== file.byteLength || bytes.toString('base64') !== dataBase64
    || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
    throw new HarnessError('Submitted image bytes do not match their reviewed source.', 'OFFICE_IMAGE_SOURCE_CHANGED')
  return bytes
}

async function assertImageInput(ctx: Context, exec: ToolExecution, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const agent = exec.agent
  const routed = agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? agent?.options.provider
  const model = routed?.model ?? agent?.options.model
  const llm = ctx.get('llm')
  if (!llm || provider === undefined || model === undefined)
    throw new HarnessError('The calling model route could not be resolved for image input.', 'OFFICE_IMAGE_MODEL_UNSUPPORTED')
  const resolved = await llm.resolveModelInfo(provider, model, signal)
  signal.throwIfAborted()
  if (resolved.inputModalities?.includes('image') !== true)
    throw new HarnessError('The calling model must explicitly declare image input before this picture can be read.',
      'OFFICE_IMAGE_MODEL_UNSUPPORTED')
}

/**
 * Describe the exact source and configured limits before the existing Native read approval.
 * @param input - Immutable original tool arguments.
 * @param capture - Submitted source metadata owned by this Agent/turn.
 * @param policy - Enabled tool's source and hard normalized-byte limits.
 * @param limits - Current mounted Native source pixel/side admission limits.
 * @returns Bilingual review or undefined for an unselected/unsupported file or invalid call.
 */
export function reviewOfficeImageRead(input: unknown, capture: OfficeConversationFilesCapture,
  policy: OfficeImageToolPolicy, limits: Pick<ImageAttachmentLimits, 'maxImagePixels' | 'maxImageDimension'>): OfficeWorkReview | undefined {
  if (validateArgs(parameters, input).length) return undefined
  const args = input as InferArgs<typeof parameters>
  const file = capture.selection.files.find(entry => entry.id === args.file_id)
  if (!file || file.byteLength < 1 || file.byteLength > policy.maxSourceBytes) return undefined
  try { imageMediaType(file) } catch (error) {
    if (error instanceof HarnessError) return undefined
    throw error
  }
  return {
    en: ['Read submitted company image', `File: ${JSON.stringify(file.name)}`, `File id: ${JSON.stringify(file.id)}`,
      `Version: ${JSON.stringify(file.versionId)}`, `SHA-256: ${file.sha256}`, `Source byte limit: ${policy.maxSourceBytes}`,
      `Source pixel limit: ${limits.maxImagePixels}`, `Source side limit: ${limits.maxImageDimension}`,
      `Normalized result byte limit: ${policy.maxNormalizedResultBytes}`, `Employee: ${JSON.stringify(capture.memberId)}`].join('\n'),
    zh: ['读取已提交的公司图片', `文件：${JSON.stringify(file.name)}`, `文件标识：${JSON.stringify(file.id)}`,
      `版本：${JSON.stringify(file.versionId)}`, `SHA-256：${file.sha256}`, `源文件字节上限：${policy.maxSourceBytes}`,
      `源图片像素上限：${limits.maxImagePixels}`, `源图片单边上限：${limits.maxImageDimension}`,
      `规范化结果字节上限：${policy.maxNormalizedResultBytes}`, `员工：${JSON.stringify(capture.memberId)}`].join('\n'),
  }
}

/**
 * Build the image reader with the authenticated employee BFF capability.
 * @param ctx - Native Agent, model and durable attachment services.
 * @param capture - Original submitted file capture; it does not independently grant read access.
 * @param lifetime - Owning tool plugin's cancellation.
 * @param authority - Authenticated source read/recheck BFF, without caller-selected identity or URL.
 * @param policy - Explicit enabled-image limits; no implicit enablement or unbounded output.
 * @returns A tool with real image-block rendering after Native normalization and final authority checks.
 */
export function officeImageTool(ctx: Context, capture: OfficeConversationFilesCapture, lifetime: AbortSignal,
  authority: OfficeImageAuthority, policy: OfficeImageToolPolicy): ToolDefinition {
  assertPolicy(policy)
  return defineTool({
    name: READ_IMAGE_TOOL,
    description: 'Read the actual picture from one exact submitted PNG, JPEG, WebP or GIF image. '
      + 'Use file_id from Submitted company files. The calling model must explicitly support images. '
      + 'The source version, digest, employee and current file/ancestor access are checked before reading and again after image normalization. '
      + 'Native image admission limits source bytes, pixels and side length. Large images may be resized or re-encoded; '
      + 'the result identifies both source metadata and the normalized image. GIF or animated input represents its normalized first frame only. '
      + 'This tool returns the image itself and does not perform OCR or invent an image description.',
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        file: { type: 'object', required: true, additionalProperties: false, properties: {
          id: { type: 'string', required: true }, versionId: { type: 'string', required: true },
          name: { type: 'string', required: true }, mediaType: { type: 'string', required: true },
          byteLength: { type: 'integer', required: true }, sha256: { type: 'string', required: true },
        } },
        image: { type: 'object', required: true, additionalProperties: false, properties: {
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
          bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
          name: { type: 'string' }, originalDimensions: { type: 'object', additionalProperties: false, properties: {
            width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
          } },
        } },
      } },
      render: (_args, value) => {
        const image: ImageAttachmentRef = { attachmentId: AttachmentId(value.image.attachmentId),
          mediaType: value.image.mediaType, bytes: value.image.bytes, width: value.image.width, height: value.image.height,
          ...value.image.name === undefined ? {} : { name: value.image.name },
          ...value.image.originalDimensions === undefined ? {} : { originalDimensions: value.image.originalDimensions } }
        return [{ type: 'text', text: JSON.stringify({ file: value.file, image }) }, { type: 'image', attachment: image }]
      },
    },
    async execute(args, exec) {
      officeToolDriver(ctx, exec, capture, lifetime)
      const signal = AbortSignal.any([lifetime, exec.signal])
      signal.throwIfAborted()
      const selected = capture.selection.files.find(entry => entry.id === args.file_id)
      if (!selected) throw new HarnessError('This image was not submitted in the calling context.', 'OFFICE_IMAGE_NOT_SUBMITTED')
      const mediaType = imageMediaType(selected)
      const attachments = ctx.get('attachments')
      if (!attachments) throw new HarnessError('A durable Native image attachment provider is required.', 'OFFICE_IMAGE_STORE_REQUIRED')
      if (selected.byteLength < 1 || selected.byteLength > Math.min(policy.maxSourceBytes, attachments.imageLimits.maxImageBytes))
        throw new HarnessError('The submitted image exceeds its source byte limit.', 'OFFICE_IMAGE_SOURCE_TOO_LARGE')
      await assertImageInput(ctx, exec, signal)
      officeToolDriver(ctx, exec, capture, lifetime)
      signal.throwIfAborted()
      const read = await officeBffRequest(() => authority.readConversationImage({ kind: 'read', captureId: capture.id,
        fileId: selected.id }, signal))
      officeToolDriver(ctx, exec, capture, lifetime)
      if (!read.ok) throw new HarnessError(`Submitted company image was not read (${read.code}).`, 'OFFICE_IMAGE_READ_DENIED')
      if (read.value.kind !== 'read' || !sameSource(selected, read.value.file))
        throw new HarnessError('The image read did not match its submitted source.', 'OFFICE_IMAGE_SOURCE_CHANGED')
      const bytes = sourceBytes(selected, read.value.dataBase64)
      signal.throwIfAborted()
      let image: ImageAttachmentRef
      try { image = await attachments.saveImage({ data: bytes, mediaType, name: selected.name }) }
      catch (cause) {
        signal.throwIfAborted()
        throw new HarnessError('Submitted company image could not be decoded within the configured image limits.',
          'OFFICE_IMAGE_DECODE_FAILED', { cause })
      }
      officeToolDriver(ctx, exec, capture, lifetime)
      signal.throwIfAborted()
      if (image.bytes > policy.maxNormalizedResultBytes)
        throw new HarnessError('The normalized image exceeds its hard result byte limit.', 'OFFICE_IMAGE_RESULT_TOO_LARGE')
      const checked = await officeBffRequest(() => authority.readConversationImage({ kind: 'recheck', captureId: capture.id,
        fileId: selected.id, versionId: selected.versionId, sha256: selected.sha256 }, signal))
      officeToolDriver(ctx, exec, capture, lifetime)
      if (!checked.ok) throw new HarnessError(`Submitted company image authority changed (${checked.code}).`, 'OFFICE_IMAGE_READ_DENIED')
      if (checked.value.kind !== 'recheck' || !sameSource(selected, checked.value.file))
        throw new HarnessError('The image recheck did not match its original submitted source.', 'OFFICE_IMAGE_SOURCE_CHANGED')
      signal.throwIfAborted()
      return { file: selected, image }
    },
    presentCall: args => ({ card: 'generic', title: 'Read submitted company image', kind: 'other', rawInput: args }),
  })
}
