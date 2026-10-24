/** Bounded private draft bytes commit atomically with versions and send-recovery identities. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import { OFFICE_CHAT_INLINE_BYTES, officeChatFileInput } from './chat-files.ts'
import type { OfficeChatState } from './chat.ts'
import type {
  OfficeChatAttachmentId, OfficeChatFileDraft, OfficeChatFileDraftCoordinates, OfficeChatFileDraftDownload,
  OfficeChatFileDraftInput, OfficeChatFileDraftSendInput, OfficeChatFileDraftView, OfficeChatFilesInput,
  OfficeChatMessage, OfficeMember, OfficeMemberId, OfficeMessageId,
} from './types.ts'

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = revision.refine(value => value > 0)
const messageId = z.uuid().transform(value => brandString<OfficeMessageId>(value))
const fileId = z.uuidv4().transform(value => brandString<OfficeChatAttachmentId>(value))
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
/** Strict contact/version update, independent of another employee's identity. */
export const officeChatFileDraftInput = z.object({ peerId: officeMemberId, revision, requestId: z.uuid(),
  files: z.array(officeChatFileInput).max(20).readonly(),
}).strict().refine(value => value.files.reduce((sum, item) => sum + item.byteLength, 0) <= OFFICE_CHAT_INLINE_BYTES)
/** Only an already reviewed contact version and opaque file identity are accepted. */
export const officeChatFileDraftCoordinates = z.object({ peerId: officeMemberId, revision: positive, attachmentId: fileId }).strict()
/** A pending send captures the entire caption and its message identity before publication. */
export const officeChatFileDraftSendInput = z.object({ id: messageId, peerId: officeMemberId, revision: positive,
  text: z.string().max(16000),
}).strict()

const storedFile = officeChatFileInput.extend({ id: fileId, sha256: digest }).superRefine((value, ctx) => {
  const bytes = Buffer.from(value.dataBase64, 'base64')
  if (bytes.length !== value.byteLength || bytes.toString('base64') !== value.dataBase64 || hash(bytes) !== value.sha256)
    ctx.addIssue({ code: 'custom', message: 'Invalid durable draft file content' })
})
const draft = z.object({ ownerId: officeMemberId, peerId: officeMemberId, revision: positive,
  requestId: z.uuid().nullable(), fingerprint: digest.nullable(), updatedAt: revision,
  files: z.array(storedFile).max(20).readonly(), pendingSend: officeChatFileDraftSendInput.nullable(),
  lastSend: officeChatFileDraftSendInput.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.ownerId === value.peerId || value.files.reduce((sum, file) => sum + file.byteLength, 0) > OFFICE_CHAT_INLINE_BYTES ||
    (value.requestId === null) !== (value.fingerprint === null) ||
    value.pendingSend && (value.files.length === 0 || value.pendingSend.peerId !== value.peerId ||
      value.pendingSend.revision !== value.revision) ||
    value.lastSend && (value.files.length > 0 || value.lastSend.peerId !== value.peerId || value.lastSend.revision + 1 !== value.revision))
    ctx.addIssue({ code: 'custom', message: 'Invalid private file draft identity or send state' })
})
type Draft = z.infer<typeof draft>
const state = z.object({ chatRevisionFloor: revision, drafts: z.array(draft).max(100000).readonly() }).strict()
  .superRefine((value, ctx) => {
    const keys = value.drafts.map(item => `${item.ownerId}:${item.peerId}`)
    const ids = value.drafts.flatMap(item => item.files.map(file => file.id))
    const sends = value.drafts.flatMap(item => item.pendingSend ? [item.pendingSend.id] : item.lastSend ? [item.lastSend.id] : [])
    if (new Set(keys).size !== keys.length || new Set(ids).size !== ids.length || new Set(sends).size !== sends.length ||
      value.drafts.some(item => item.pendingSend || item.lastSend) && value.chatRevisionFloor === 0)
      ctx.addIssue({ code: 'custom', message: 'Duplicate draft identity or missing chat watermark' })
  })

/** Independent inline drafts preserve original chat, text-draft and sent-file schemas. */
export const officeChatFileDraftDomain = defineDomain({ name: 'enterprise_office_chat_file_drafts', version: 1,
  global: { schema: state, initial: { chatRevisionFloor: 0, drafts: [] } }, tables: {},
})
/** Resolved deployment limits bound atomic JSON/storage commits independently of sent-file quotas. */
export interface ChatFileDraftLimits {
  readonly maxFileBytes: number
  readonly maxMessageBytes: number
  readonly maxFilesPerMessage: number
  readonly ownerQuotaBytes: number
  readonly totalQuotaBytes: number
  readonly maxEntries: number
}
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const size = (files: readonly { readonly byteLength: number }[]): number => files.reduce((sum, file) => sum + file.byteLength, 0)

/** The office service supplies current authentication and its shared write queue for every mutation. */
export class OfficeChatFileDraftRepository {
  constructor(
    private readonly domain: Domain<typeof officeChatFileDraftDomain>,
    private readonly limits: ChatFileDraftLimits,
    private readonly chat: () => OfficeChatState,
    private readonly message: (id: OfficeMessageId) => OfficeChatMessage | undefined,
    private readonly changed: () => Promise<void>,
  ) {}

  /**
   * Refuse a replaced directory or rolled-back original chat, and reconcile admitted sends on startup.
   * @param members - Original retained directory including inactive employees.
   */
  async recover(members: readonly OfficeMember[]): Promise<void> {
    const saved = this.domain.global.get()
    if (saved.chatRevisionFloor > this.chat().revision || saved.drafts.some(entry =>
      !members.some(member => member.id === entry.ownerId) || !members.some(member => member.id === entry.peerId)))
      throw new OfficeError('conflict', 'Restore the original directory and chat before activating file drafts')
    for (const entry of saved.drafts) {
      const receipt = entry.pendingSend ?? entry.lastSend
      if (!receipt) continue
      const message = this.message(receipt.id)
      if (entry.lastSend && !message) throw new OfficeError('conflict', 'Published file-draft message is missing')
      if (message) await this.completeSend(entry.ownerId, receipt, message)
    }
  }

  /**
   * Project only one authenticated owner's metadata, including empty version tombstones.
   * @param actor - Active employee identity.
   * @returns Own contact versions and bounded logical usage without bytes or other employees' records.
   */
  view(actor: OfficeMemberId): OfficeChatFileDraftView {
    const drafts = this.domain.global.get().drafts.filter(value => value.ownerId === actor)
    return { meId: actor, ownerQuotaBytes: this.limits.ownerQuotaBytes,
      ownerUsedBytes: drafts.reduce((sum, item) => sum + size(item.files), 0),
      drafts: drafts.map(value => this.project(value)) }
  }

  /**
   * Reserve admitted message identities against text-only or unrelated file-message publication.
   * @param id - Requested private-message identity.
   * @returns Whether a retained file-draft send owns the identity.
   */
  hasSend(id: OfficeMessageId): boolean { return this.domain.global.get().drafts.some(entry => entry.pendingSend?.id === id) }

  /**
   * Keep a previously authorized contact readable after offboarding, including an empty version tombstone.
   * @param actor - Authenticated draft owner.
   * @param peer - Retained contact identity.
   * @returns Whether this owner has a durable file-draft relationship with that contact.
   */
  hasContact(actor: OfficeMemberId, peer: OfficeMemberId): boolean { return this.find(actor, peer) !== undefined }

  /**
   * Save complete bounded files and their contact version in a single atomic domain commit.
   * @param actor - Current owner, never supplied by the network request body.
   * @param input - Parsed reviewed version, exact retry identity and ordered bytes.
   * @returns Saved metadata; unknown outcomes are retried without replacing file identities.
   */
  async save(actor: OfficeMemberId, input: OfficeChatFileDraftInput): Promise<OfficeChatFileDraft> {
    if (actor === input.peerId) throw new OfficeError('invalid_input', 'A private draft requires another employee')
    const previous = this.find(actor, input.peerId)
    const files = input.files.map((file) => {
      const bytes = Buffer.from(file.dataBase64, 'base64')
      if (bytes.length !== file.byteLength || bytes.toString('base64') !== file.dataBase64)
        throw new OfficeError('invalid_input', 'File draft bytes do not match their declaration')
      return { ...file, sha256: hash(bytes) }
    })
    const fingerprint = hash(JSON.stringify({ actor, peerId: input.peerId, revision: input.revision,
      files: files.map(({ dataBase64: _data, ...metadata }) => metadata) }))
    if (previous?.requestId === input.requestId) {
      if (previous.fingerprint !== fingerprint) throw new OfficeError('conflict', 'Draft retry content changed')
      return this.project(previous)
    }
    if ((previous?.revision ?? 0) !== input.revision) {
      if (files.length === 0 && previous?.lastSend?.revision === input.revision) return this.project(previous)
      throw new OfficeError('conflict', 'Review the current private file draft')
    }
    if (previous?.pendingSend && files.length > 0)
      throw new OfficeError('conflict', 'Review the current file draft or resolve its pending send')
    if (previous?.pendingSend) {
      const published = this.message(previous.pendingSend.id)
      if (published) {
        await this.completeSend(actor, previous.pendingSend, published)
        const cleared = this.find(actor, input.peerId)
        if (!cleared) throw new OfficeError('conflict', 'Original private file draft is missing')
        return this.project(cleared)
      }
    }
    const saved = this.domain.global.get()
    const retained = saved.drafts.filter(entry => entry !== previous)
    const total = size(files)
    const ownerBytes = retained.filter(entry => entry.ownerId === actor).reduce((sum, item) => sum + size(item.files), total)
    if (files.length > 0 && (files.length > this.limits.maxFilesPerMessage ||
      files.some(file => file.byteLength > this.limits.maxFileBytes) ||
      total > this.limits.maxMessageBytes || ownerBytes > this.limits.ownerQuotaBytes ||
      retained.reduce((sum, item) => sum + size(item.files), total) > this.limits.totalQuotaBytes))
      throw new OfficeError('invalid_input', 'Private file draft exceeds file, message or storage limits')
    if (!previous && retained.length >= this.limits.maxEntries) throw new OfficeError('conflict', 'File draft record capacity reached')
    const next: Draft = { ownerId: actor, peerId: input.peerId, revision: input.revision + 1,
      requestId: input.requestId, fingerprint, updatedAt: Date.now(), pendingSend: null, lastSend: null,
      files: files.map(file => ({ ...file, id: brandString<OfficeChatAttachmentId>(randomUUID()) })) }
    await this.write(next)
    return this.project(next)
  }

  /**
   * Read one current owner-only file for draft restoration; the selected recipient has no access.
   * @param actor - Authenticated draft owner.
   * @param input - Reviewed contact version and file identity.
   * @returns Canonical verified complete content or the same not-found denial as an absent selection.
   */
  download(actor: OfficeMemberId, input: OfficeChatFileDraftCoordinates): OfficeChatFileDraftDownload {
    const entry = this.find(actor, input.peerId)
    const file = entry?.revision === input.revision ? entry.files.find(value => value.id === input.attachmentId) : undefined
    if (!file) throw new OfficeError('not_found', 'Private file draft is unavailable')
    const bytes = Buffer.from(file.dataBase64, 'base64')
    if (bytes.length !== file.byteLength || hash(bytes) !== file.sha256)
      throw new OfficeError('conflict', 'Restore the original private draft bytes')
    return { ...file, peerId: input.peerId, revision: input.revision }
  }

  /**
   * Persist the exact admitted send before creating a file message, or recover its completed receipt.
   * @param actor - Authenticated sender.
   * @param input - Reviewed draft version, original caption and message identity.
   * @returns The complete private payload or a previously committed message; no draft bytes go to the recipient yet.
   */
  async beginSend(actor: OfficeMemberId, input: OfficeChatFileDraftSendInput): Promise<OfficeChatFilesInput | OfficeChatMessage> {
    let entry = this.find(actor, input.peerId)
    if (!entry) throw new OfficeError('not_found', 'Private file draft is unavailable')
    if (entry.lastSend && this.sameSend(entry.lastSend, input)) {
      const message = this.message(input.id)
      if (!message) throw new OfficeError('conflict', 'Published draft message is missing')
      return message
    }
    if (entry.revision !== input.revision || entry.files.length === 0 ||
      entry.pendingSend && !this.sameSend(entry.pendingSend, input))
      throw new OfficeError('conflict', 'File draft changed or another send requires recovery')
    if (this.domain.global.get().drafts.some(value => value !== entry &&
      (value.pendingSend?.id === input.id || value.lastSend?.id === input.id)))
      throw new OfficeError('conflict', 'Another private draft owns this message identity')
    if (this.message(input.id) && !entry.pendingSend) throw new OfficeError('conflict', 'Message identity is already in use')
    if (!entry.pendingSend) {
      entry = { ...entry, pendingSend: input }
      await this.write(entry, true)
    }
    return { id: input.id, recipientId: input.peerId, text: input.text,
      files: entry.files.map(({ id: _id, sha256: _sha, ...file }) => file) }
  }

  /**
   * Clear only the original published selection and retain its receipt for an uncertain response retry.
   * @param actor - Owner of the admitted draft.
   * @param input - Exact durable send identity and caption.
   * @param message - Committed message with verified immutable attachment metadata.
   */
  async completeSend(actor: OfficeMemberId, input: OfficeChatFileDraftSendInput, message: OfficeChatMessage): Promise<void> {
    const entry = this.find(actor, input.peerId)
    if (!entry) throw new OfficeError('conflict', 'Original private file draft is missing')
    if (entry.lastSend && this.sameSend(entry.lastSend, input)) {
      if (message.id !== input.id || message.senderId !== actor || message.recipientId !== input.peerId ||
        !message.attachments?.length || message.text !== (input.text.trim() ? input.text : message.attachments.map(file => file.name).join('\n')))
        throw new OfficeError('conflict', 'File draft receipt does not match its original message')
      return
    }
    if (!entry.pendingSend || !this.sameSend(entry.pendingSend, input) || message.id !== input.id || message.senderId !== actor ||
      message.recipientId !== input.peerId || message.text !== (input.text.trim() ? input.text : entry.files.map(file => file.name).join('\n')) ||
      message.attachments?.length !== entry.files.length || entry.files.some((file, index) => {
      const result = message.attachments?.[index]
      return !result || result.name !== file.name || result.mediaType !== file.mediaType ||
          result.byteLength !== file.byteLength || result.sha256 !== file.sha256
    })) throw new OfficeError('conflict', 'Published message does not match its original file draft')
    await this.write({ ...entry, files: [], revision: entry.revision + 1, requestId: null, fingerprint: null,
      updatedAt: Date.now(), pendingSend: null, lastSend: input }, true)
  }

  private project(entry: Draft): OfficeChatFileDraft {
    return { peerId: entry.peerId, revision: entry.revision, updatedAt: entry.updatedAt, pendingSend: entry.pendingSend,
      files: entry.files.map(({ dataBase64: _data, ...file }) => file) }
  }
  private find(actor: OfficeMemberId, peer: OfficeMemberId): Draft | undefined {
    return this.domain.global.get().drafts.find(entry => entry.ownerId === actor && entry.peerId === peer)
  }
  private sameSend(left: OfficeChatFileDraftSendInput, right: OfficeChatFileDraftSendInput): boolean {
    return left.id === right.id && left.peerId === right.peerId && left.revision === right.revision && left.text === right.text
  }
  private async write(entry: Draft, withChat = false): Promise<void> {
    const saved = this.domain.global.get()
    const chatRevisionFloor = withChat ? Math.max(saved.chatRevisionFloor, this.chat().revision) : saved.chatRevisionFloor
    await this.domain.global.set({ chatRevisionFloor,
      drafts: [...saved.drafts.filter(value => value.ownerId !== entry.ownerId || value.peerId !== entry.peerId), entry] })
    await this.changed()
  }
}
