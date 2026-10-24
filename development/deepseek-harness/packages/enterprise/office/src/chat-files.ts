/** File-message intents and immutable objects publish through the existing private-chat sequence. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { officeDriveRequestSchemas } from './drive.ts'
import { OfficeDriveTransferFiles } from './drive-transfer-files.ts'
import type { DriveUploadPart } from './drive-transfer-files.ts'
import { officeMemberId } from './spec.ts'
import { OfficeError } from './error.ts'
import type { OfficeChatState } from './chat.ts'
import type {
  OfficeChatAttachment, OfficeChatAttachmentId, OfficeChatFileCoordinates, OfficeChatFileDownload,
  OfficeChatFileLimits, OfficeChatFilesInput, OfficeChatMessage, OfficeChatView,
  OfficeMember, OfficeMemberId, OfficeMessageId,
} from './types.ts'

/** Whole-message protocol envelope fits the existing authenticated JSON ingress. */
export const OFFICE_CHAT_INLINE_BYTES = 8 * 1024 * 1024
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const messageId = z.uuid().transform(value => brandString<OfficeMessageId>(value))
const attachmentId = z.uuidv4().transform(value => brandString<OfficeChatAttachmentId>(value))
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const byteLength = counter.max(OFFICE_CHAT_INLINE_BYTES)
const fileFields = {
  name: officeDriveRequestSchemas.folderInput.shape.name,
  mediaType: officeDriveRequestSchemas.uploadInput.shape.mediaType,
  byteLength,
}
/** Shared bounded inline-file parser; each owning operation verifies canonical byte content. */
export const officeChatFileInput = z.object({ ...fileFields,
  dataBase64: z.string().max(Math.ceil(OFFICE_CHAT_INLINE_BYTES / 3) * 4),
}).strict()

/** Strict file-message admission; byte counts and canonical base64 are checked before intent creation. */
export const officeChatFilesInput = z.object({
  id: messageId, recipientId: officeMemberId, text: z.string().max(16000), files: z.array(officeChatFileInput).min(1).max(20).readonly(),
}).strict().refine(value => value.files.reduce((sum, file) => sum + file.byteLength, 0) <= OFFICE_CHAT_INLINE_BYTES)
/** Only the message and its opaque file id are accepted for downloads. */
export const officeChatFileCoordinates = z.object({ messageId, attachmentId }).strict()
const file = z.object({ ...fileFields, id: attachmentId, sha256: digest }).strict()
const intent = z.object({
  id: messageId, senderId: officeMemberId, recipientId: officeMemberId,
  messageText: z.string().min(1).max(16000), fingerprint: digest,
  phase: z.enum(['preparing', 'ready', 'published']), files: z.array(file).min(1).max(20).readonly(),
  chunkBytes: counter.min(64 * 1024).max(2 * 1024 * 1024),
  createdAt: counter, expiresAt: counter, stagingClean: z.boolean(),
}).strict().refine(value => value.senderId !== value.recipientId && value.expiresAt > value.createdAt
  && value.files.reduce((sum, item) => sum + item.byteLength, 0) <= OFFICE_CHAT_INLINE_BYTES)
const state = z.object({
  revision: counter, chatRevisionFloor: counter, intents: z.array(intent).max(100000).readonly(),
}).strict().superRefine((value, ctx) => {
  const ids = value.intents.flatMap(entry => entry.files.map(item => item.id))
  if (new Set(value.intents.map(entry => entry.id)).size !== value.intents.length || new Set(ids).size !== ids.length ||
    value.intents.length > 0 && value.chatRevisionFloor === 0)
    ctx.addIssue({ code: 'custom', message: 'Invalid chat-file identities or missing chat watermark' })
})

/** Separate domain leaves the released office and private-text schemas unchanged. */
export const officeChatFilesDomain = defineDomain({
  name: 'enterprise_office_chat_files', version: 1,
  global: { schema: state, initial: { revision: 0, chatRevisionFloor: 0, intents: [] } }, tables: {},
})
type Intent = z.infer<typeof intent>
type Frame = Omit<OfficeChatAttachment, 'id'> & { readonly bytes: Buffer }

/** Deployment-resolved message bounds, pending recovery lifetime and filesystem block size. */
export interface ChatFileAuthorityLimits extends Omit<OfficeChatFileLimits, 'protocol' | 'ownerUsedBytes'> {
  readonly maxEntries: number
  readonly chunkBytes: number
}

/** Caller serializes every operation with the original chat and validates current membership. */
export class OfficeChatFileRepository {
  private readonly reader: OfficeDriveTransferFiles
  constructor(
    private readonly domain: Domain<typeof officeChatFilesDomain>,
    private readonly objectRoot: string,
    private readonly limits: ChatFileAuthorityLimits,
    private readonly chat: () => OfficeChatState,
    private readonly report: (error: unknown) => void,
  ) {
    this.reader = new OfficeDriveTransferFiles(objectRoot, { maxFileBytes: OFFICE_CHAT_INLINE_BYTES, chunkBytes: OFFICE_CHAT_INLINE_BYTES })
  }

  /**
   * Resolve the active employee's limits without disclosing other employees' usage.
   * @param actor - Authenticated member.
   * @returns Current file policy and retained logical bytes.
   */
  capabilities(actor: OfficeMemberId): OfficeChatFileLimits {
    return { protocol: 1, maxFileBytes: this.limits.maxFileBytes, maxMessageBytes: this.limits.maxMessageBytes,
      maxFilesPerMessage: this.limits.maxFilesPerMessage, ownerQuotaBytes: this.limits.ownerQuotaBytes,
      ownerUsedBytes: this.used(actor), maxPendingMessages: this.limits.maxPendingMessages, expiresAfterMs: this.limits.expiresAfterMs }
  }

  /**
   * Refuse a lost original directory, chat or an inconsistent published association.
   * @param members - Retained directory including inactive identities.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const saved = this.domain.global.get()
    const messages = new Map(this.chat().messages.map(message => [message.id, message]))
    if (saved.chatRevisionFloor > this.chat().revision || saved.intents.some(entry =>
      !members.some(member => member.id === entry.senderId) || !members.some(member => member.id === entry.recipientId)))
      throw new OfficeError('conflict', 'Chat files require their original directory and chat history')
    for (const entry of saved.intents) {
      const message = messages.get(entry.id)
      if (entry.phase === 'published' && !message || message && (entry.phase === 'preparing' || !this.matches(entry, message)))
        throw new OfficeError('conflict', 'Chat-file publication does not match its original message')
    }
  }

  /**
   * Prevent the text-only operation from publishing an unfinished file-message identity.
   * @param id - Original message retry coordinate.
   * @returns Whether a file declaration owns this identity.
   */
  hasIntent(id: OfficeMessageId): boolean { return this.domain.global.get().intents.some(entry => entry.id === id) }

  /**
   * Persist an immutable declaration, verify all file objects, then admit message publication.
   * @param actor - Current active sender.
   * @param input - Parsed caption, recipient and ordered bounded files.
   * @returns Canonical nonempty message text; failure never publishes a chat message.
   */
  async prepare(actor: OfficeMemberId, input: OfficeChatFilesInput): Promise<string> {
    await this.sweep()
    const frames = input.files.map((value): Frame => {
      const bytes = Buffer.from(value.dataBase64, 'base64')
      if (bytes.length !== value.byteLength || bytes.toString('base64') !== value.dataBase64)
        throw new OfficeError('invalid_input', 'Chat file length or encoding does not match')
      return { name: value.name, mediaType: value.mediaType, byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes }
    })
    const fingerprint = createHash('sha256').update(JSON.stringify({ senderId: actor, recipientId: input.recipientId,
      text: input.text, files: frames.map(({ name, mediaType, byteLength: length, sha256 }) =>
        ({ name, mediaType, byteLength: length, sha256 })) }))
      .digest('hex')
    let record = this.domain.global.get().intents.find(entry => entry.id === input.id)
    const message = this.message(input.id)
    if (record && (record.senderId !== actor || record.fingerprint !== fingerprint) || message && !record)
      throw new OfficeError('conflict', 'File-message retry does not match its original declaration')
    if (!message) {
      const total = frames.reduce((sum, item) => sum + item.byteLength, 0)
      if (frames.length > this.limits.maxFilesPerMessage || frames.some(item => item.byteLength > this.limits.maxFileBytes) ||
        total > this.limits.maxMessageBytes || this.used(actor, input.id) + total > this.limits.ownerQuotaBytes)
        throw new OfficeError('invalid_input', 'Chat files exceed the current message or employee quota')
    }
    if (!record) {
      const saved = this.domain.global.get()
      if (saved.intents.length >= this.limits.maxEntries || saved.intents.filter(entry =>
        entry.senderId === actor && !this.message(entry.id)).length >= this.limits.maxPendingMessages)
        throw new OfficeError('conflict', 'Resolve pending file messages before sending more files')
      const now = Date.now()
      record = { id: input.id, senderId: actor, recipientId: input.recipientId,
        messageText: input.text.trim() ? input.text : frames.map(item => item.name).join('\n'), fingerprint,
        phase: 'preparing', files: frames.map(({ bytes: _bytes, ...meta }) => ({ ...meta, id: brandString<OfficeChatAttachmentId>(randomUUID()) })),
        chunkBytes: this.limits.chunkBytes, createdAt: now, expiresAt: now + this.limits.expiresAfterMs, stagingClean: false }
      await this.write(record)
    }
    if (message) {
      if (!this.matches(record, message) || record.phase === 'preparing')
        throw new OfficeError('conflict', 'Committed message does not match its ready files')
      for (const item of record.files) await this.reader.verify(item)
      return record.messageText
    }
    if (record.phase === 'preparing') {
      const writer = this.writer(record)
      for (let index = 0; index < record.files.length; index++) {
        const meta = record.files[index]
        const frame = frames[index]
        if (!meta || !frame) throw new OfficeError('conflict', 'Chat-file declaration is incomplete')
        const parts: DriveUploadPart[] = []
        for (let offset = 0; offset < frame.bytes.length; offset += record.chunkBytes)
          parts.push(await writer.stageChunk(meta.id, parts.length, frame.bytes.subarray(offset, offset + record.chunkBytes)))
        await writer.merge(meta.id, meta, parts)
      }
      if (Date.now() >= record.expiresAt) throw new OfficeError('conflict', 'Unpublished file-message declaration expired')
      record = { ...record, phase: 'ready', stagingClean: await this.clean(record, false) }
      await this.write(record)
    } else {
      for (const item of record.files) await this.reader.verify(item)
    }
    return record.messageText
  }

  /**
   * Retain publication acknowledgement after the original chat commit; a failed receipt is safely retried.
   * @param message - Committed original chat header.
   */
  async confirm(message: OfficeChatMessage): Promise<void> {
    const record = this.domain.global.get().intents.find(entry => entry.id === message.id)
    if (!record || record.phase === 'preparing' || !this.matches(record, message))
      throw new OfficeError('conflict', 'Message has no matching ready file declaration')
    if (record.phase !== 'published') await this.write({ ...record, phase: 'published' })
  }

  /**
   * Add authorized metadata without changing the original stored text message.
   * @param message - Header already selected through private-chat authorization.
   * @returns Header with immutable file metadata when its declaration is ready.
   */
  decorate(message: OfficeChatMessage): OfficeChatMessage {
    const record = this.domain.global.get().intents.find(entry => entry.id === message.id)
    if (!record) return message
    if (record.phase === 'preparing' || !this.matches(record, message))
      throw new OfficeError('conflict', 'Message does not match ready chat files')
    return { ...message, attachments: record.files }
  }

  /**
   * Decorate only a previously authorized page and its own thread summaries.
   * @param view - Original private-chat projection.
   * @returns Same coordinates, cursor and receipts with optional attachment metadata.
   */
  decorateView(view: OfficeChatView): OfficeChatView {
    return { ...view, messages: view.messages.map(message => this.decorate(message)),
      threads: view.threads.map(thread => ({ ...thread, latest: this.decorate(thread.latest) })) }
  }

  /**
   * Return complete verified bytes only when the active actor belongs to the original message.
   * @param actor - Current authenticated employee.
   * @param input - Parsed immutable message/file coordinates.
   * @returns Verified metadata and bytes; administrators have no participant bypass.
   */
  async download(actor: OfficeMemberId, input: OfficeChatFileCoordinates): Promise<OfficeChatFileDownload> {
    const message = this.message(input.messageId)
    if (!message || message.senderId !== actor && message.recipientId !== actor)
      throw new OfficeError('not_found', 'Chat file is unavailable')
    const record = this.domain.global.get().intents.find(entry => entry.id === input.messageId)
    const file = record?.files.find(item => item.id === input.attachmentId)
    if (!record || !file) throw new OfficeError('not_found', 'Chat file is unavailable')
    if (record.phase === 'preparing' || !this.matches(record, message))
      throw new OfficeError('conflict', 'Chat file is not ready')
    const bytes = await this.reader.readRange(file, 0, file.byteLength)
    return { ...file, messageId: message.id, dataBase64: bytes.toString('base64') }
  }

  /** Reconcile committed headers and collect only expired unpublished files owned by this ledger. */
  async sweep(): Promise<void> {
    if (this.domain.global.get().chatRevisionFloor > this.chat().revision)
      throw new OfficeError('conflict', 'Restore the original chat before collecting its files')
    const messages = new Map(this.chat().messages.map(message => [message.id, message]))
    for (const record of this.domain.global.get().intents) {
      const message = messages.get(record.id)
      if (message) {
        if (record.phase === 'preparing' || !this.matches(record, message))
          throw new OfficeError('conflict', 'Chat-file publication is inconsistent')
        let next = record
        if (!record.stagingClean && await this.clean(record, false)) next = { ...next, stagingClean: true }
        if (record.phase !== 'published') next = { ...next, phase: 'published' }
        if (next !== record) await this.write(next)
      } else if (record.phase === 'published') {
        throw new OfficeError('conflict', 'Restore the original chat before collecting its files')
      } else if (Date.now() >= record.expiresAt && await this.clean(record, true)) {
        await this.remove(record.id)
      }
    }
  }

  private used(actor: OfficeMemberId, except?: OfficeMessageId): number {
    return this.domain.global.get().intents.reduce((sum, record) => sum +
      (record.senderId === actor && record.id !== except ? record.files.reduce((total, item) => total + item.byteLength, 0) : 0), 0)
  }
  private message(id: OfficeMessageId): OfficeChatMessage | undefined { return this.chat().messages.find(entry => entry.id === id) }
  private matches(record: Intent, message: OfficeChatMessage): boolean {
    return record.id === message.id && record.senderId === message.senderId &&
      record.recipientId === message.recipientId && record.messageText === message.text
  }
  private writer(record: Intent): OfficeDriveTransferFiles {
    return new OfficeDriveTransferFiles(this.objectRoot, { maxFileBytes: OFFICE_CHAT_INLINE_BYTES, chunkBytes: record.chunkBytes })
  }
  private async clean(record: Intent, unpublished: boolean): Promise<boolean> {
    const writer = this.writer(record)
    let complete = true
    for (const file of record.files) {
      try { await writer.discard(file.id, unpublished) }
      catch (error) { complete = false; this.report(error) }
    }
    return complete
  }
  private async write(record: Intent): Promise<void> {
    const saved = this.domain.global.get()
    await this.domain.global.set({ revision: saved.revision + 1,
      chatRevisionFloor: Math.max(saved.chatRevisionFloor, this.chat().revision),
      intents: [...saved.intents.filter(entry => entry.id !== record.id), record] })
  }
  private async remove(id: OfficeMessageId): Promise<void> {
    const saved = this.domain.global.get()
    await this.domain.global.set({ ...saved, revision: saved.revision + 1, intents: saved.intents.filter(entry => entry.id !== id) })
  }
}
