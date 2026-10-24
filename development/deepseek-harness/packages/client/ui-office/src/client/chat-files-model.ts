/** Private contact file handles and retry payloads publish only serializable viewing state. */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bytesToBase64, randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeChatAttachment, OfficeChatFileCoordinates, OfficeChatFileInput, OfficeChatFileLimits,
  OfficeChatFilesInput, OfficeChatMessage, OfficeMemberId, OfficeMessageId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'
import { recordValue, withoutKey } from './values.ts'

interface Selection { readonly id: string; readonly name: string; readonly byteLength: number }
interface ContactFiles { readonly files: readonly Selection[]; readonly sending: boolean; readonly error: OfficeKey | null }
interface FileState {
  readonly limits: OfficeChatFileLimits | null
  readonly loading: boolean
  readonly policyError: OfficeKey | null
  readonly contacts: Readonly<Record<string, ContactFiles>>
  readonly downloads: readonly string[]
  readonly downloadErrors: Readonly<Record<string, OfficeKey>>
}
type Remote = Pick<ClientRemote['office'], 'chatFileLimits' | 'sendMessageFiles' | 'downloadChatFile'>
interface Choice extends Selection { readonly file: File }
interface Attempt { readonly selection: readonly string[]; readonly text: string; readonly input: OfficeChatFilesInput }
class FileFailure extends Error { constructor(readonly key: OfficeKey) { super(key) } }
const emptyContact = (): ContactFiles => ({ files: [], sending: false, error: null })
const initial = (): FileState => ({ limits: null, loading: false, policyError: null, contacts: {}, downloads: [], downloadErrors: {} })
const inlineBound = 8 * 1024 * 1024

/** One authenticated account owns all contact selections, send attempts and pending downloads. */
export class OfficeChatFilesModel {
  /** File handles and encoded bytes never enter hook snapshots. */
  readonly state = createSnapshotStore<FileState>(initial())
  private readonly choices = new Map<OfficeMemberId, readonly Choice[]>()
  private readonly attempts = new Map<OfficeMemberId, Attempt>()
  private principal: OfficeMemberId | null = null
  private epoch = 0
  private policyGeneration = 0
  private disposed = false

  constructor(
    private readonly remote: Remote,
    private readonly notify: (key: OfficeKey, success: boolean) => void,
    private readonly published: () => Promise<void>,
    private readonly save: (file: OfficeChatAttachment, blob: Blob) => void,
  ) {}

  /**
   * Clear private selections and fence every asynchronous read or write when the account changes.
   * @param principal - Confirmed employee, or null after sign-out.
   */
  bind(principal: OfficeMemberId | null): void {
    if (this.disposed || this.principal === principal) return
    this.principal = principal
    this.epoch++
    this.policyGeneration++
    this.choices.clear()
    this.attempts.clear()
    this.state.set(initial())
    if (principal) void this.load()
  }

  /** Refresh only the active sender's policy and quota; text chat stays available if unsupported. */
  async load(): Promise<void> {
    if (!this.current(this.epoch)) return
    const epoch = this.epoch
    const generation = ++this.policyGeneration
    this.patch({ loading: true, policyError: null })
    try {
      const limits = await this.result(this.remote.chatFileLimits())
      if (!this.current(epoch) || generation !== this.policyGeneration) return
      this.patch({ limits, loading: false, policyError: null })
    } catch (error) {
      if (this.current(epoch) && generation === this.policyGeneration) {
        const key = this.key(error)
        this.patch({ limits: null, loading: false, policyError: key })
        if (key === 'unauthenticated') this.notify(key, false)
      }
    }
  }

  /**
   * Review a bounded contact-specific selection before reading or sending bytes.
   * @param peer - Captured contact, independent of subsequent navigation.
   * @param files - Browser file picker handles retained privately by this account.
   */
  add(peer: OfficeMemberId, files: readonly File[]): void {
    const limits = this.state.getSnapshot().limits
    if (!limits || !this.current(this.epoch) || this.contact(peer).sending || files.length === 0) return
    const existing = this.choices.get(peer) ?? []
    const all = [...existing.map(value => value.file), ...files]
    if (all.length > limits.maxFilesPerMessage || all.some(file => file.size > Math.min(limits.maxFileBytes, inlineBound)) ||
      all.reduce((total, file) => total + file.size, 0) > Math.min(limits.maxMessageBytes, inlineBound)) {
      this.setContact(peer, { ...this.contact(peer), error: 'chatFileSelectionTooLarge' })
      return
    }
    const choices = [...existing, ...files.map(file => ({ id: randomUUID(), name: file.name, byteLength: file.size, file }))]
    this.choices.set(peer, choices)
    this.setContact(peer, { files: choices.map(({ file: _file, ...meta }) => meta), sending: false, error: null })
  }

  /**
   * Remove a file from an idle contact draft, including after a rejected send.
   * @param peer - Contact owning the selection.
   * @param id - Opaque window selection identity.
   */
  remove(peer: OfficeMemberId, id: string): void {
    if (!this.current(this.epoch) || this.contact(peer).sending) return
    const choices = (this.choices.get(peer) ?? []).filter(value => value.id !== id)
    this.choices.set(peer, choices)
    this.attempts.delete(peer)
    this.setContact(peer, { ...emptyContact(), files: choices.map(({ file: _file, ...meta }) => meta) })
  }

  /**
   * Send captured immutable files once, retaining an exact payload for an uncertain-result retry.
   * @param peer - Active recipient captured at the user gesture.
   * @param text - Caption captured independently from later text edits.
   * @returns True only after the Host confirms this exact message under the same account.
   */
  async send(peer: OfficeMemberId, text: string): Promise<boolean> {
    const selection = this.choices.get(peer) ?? []
    if (!this.current(this.epoch) || !this.state.getSnapshot().limits || this.contact(peer).sending || selection.length === 0) return false
    const epoch = this.epoch
    this.setContact(peer, { ...this.contact(peer), sending: true, error: null })
    try {
      let attempt = this.attempts.get(peer)
      if (!attempt || attempt.text !== text || attempt.selection.join() !== selection.map(value => value.id).join()) {
        const files: OfficeChatFileInput[] = []
        for (const item of selection) {
          let buffer: ArrayBuffer
          try { buffer = await item.file.arrayBuffer() }
          catch (error) { throw new FileFailure(error instanceof FileFailure ? error.key : 'fileReadFailed') }
          if (!this.current(epoch)) return false
          if (buffer.byteLength !== item.byteLength) throw new FileFailure('fileReadFailed')
          files.push({ name: item.name.normalize('NFC'), mediaType: item.file.type || 'application/octet-stream',
            byteLength: item.byteLength, dataBase64: bytesToBase64(new Uint8Array(buffer)) })
        }
        attempt = { text, selection: selection.map(value => value.id), input: {
          id: randomUUID() as OfficeMessageId, recipientId: peer, text, files,
        } }
        this.attempts.set(peer, attempt)
      }
      const message = await this.result(this.remote.sendMessageFiles(attempt.input))
      if (!this.current(epoch)) return false
      this.checkMessage(message, attempt.input)
      this.attempts.delete(peer)
      this.choices.delete(peer)
      this.setContact(peer, emptyContact())
      // Publication is already confirmed; refreshing history cannot turn it into a failed send.
      void this.published().catch(() => { if (this.current(epoch)) this.notify('unavailable', false) })
      void this.load()
      return true
    } catch (error) {
      if (this.current(epoch)) {
        const key = this.key(error)
        this.setContact(peer, { ...this.contact(peer), sending: false, error: key })
        if (key === 'unauthenticated') this.notify(key, false)
      }
      return false
    }
  }

  /**
   * Download through participant authorization and save only complete matching bytes.
   * @param coordinates - Retained message and file identities from the authorized conversation.
   * @param expected - Displayed immutable metadata, checked against the response and bytes.
   */
  async download(coordinates: OfficeChatFileCoordinates, expected: OfficeChatAttachment): Promise<void> {
    const id = coordinates.attachmentId
    const state = this.state.getSnapshot()
    if (!this.current(this.epoch) || state.downloads.includes(id)) return
    const epoch = this.epoch
    this.patch({ downloads: [...state.downloads, id], downloadErrors: withoutKey(state.downloadErrors, id) })
    try {
      const file = await this.result(this.remote.downloadChatFile(coordinates))
      if (!this.current(epoch)) return
      if (file.id !== id || file.messageId !== coordinates.messageId || file.name !== expected.name ||
        file.mediaType !== expected.mediaType || file.byteLength !== expected.byteLength || file.sha256 !== expected.sha256 ||
        file.byteLength > inlineBound || file.dataBase64.length > Math.ceil(inlineBound / 3) * 4)
        throw new FileFailure('downloadCorrupt')
      let bytes: Uint8Array<ArrayBuffer>
      try { bytes = Uint8Array.from(atob(file.dataBase64), value => value.charCodeAt(0)) }
      catch (error) { throw new FileFailure(error instanceof FileFailure ? error.key : 'downloadCorrupt') }
      if (bytes.length !== expected.byteLength || bytesToHex(sha256(bytes)) !== expected.sha256 ||
        bytesToBase64(bytes) !== file.dataBase64) throw new FileFailure('downloadCorrupt')
      this.save(expected, new Blob([bytes], { type: expected.mediaType }))
    } catch (error) {
      if (this.current(epoch)) {
        const key = this.key(error)
        this.patch({ downloadErrors: { ...this.state.getSnapshot().downloadErrors, [id]: key } })
        if (key === 'unauthenticated') this.notify(key, false)
      }
    } finally {
      if (this.current(epoch)) this.patch({ downloads: this.state.getSnapshot().downloads.filter(value => value !== id) })
    }
  }

  /** Release all retained handles and payloads; late completions cannot publish or save files. */
  dispose(): void { this.bind(null); this.disposed = true }

  private checkMessage(message: OfficeChatMessage, input: OfficeChatFilesInput): void {
    if (message.id !== input.id || message.senderId !== this.principal || message.recipientId !== input.recipientId ||
      message.text !== (input.text.trim() ? input.text : input.files.map(file => file.name).join('\n')) ||
      message.attachments?.length !== input.files.length || input.files.some((file, index) => {
      const attachment = message.attachments?.[index]
      return !attachment || attachment.name !== file.name || attachment.mediaType !== file.mediaType ||
          attachment.byteLength !== file.byteLength
    })) throw new FileFailure('unavailable')
  }
  private contact(peer: OfficeMemberId): ContactFiles { return recordValue(this.state.getSnapshot().contacts, peer) ?? emptyContact() }
  private setContact(peer: OfficeMemberId, value: ContactFiles): void {
    this.patch({ contacts: { ...this.state.getSnapshot().contacts, [peer]: value } })
  }
  private patch(value: Partial<FileState>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
  private current(epoch: number): boolean { return !this.disposed && this.principal !== null && this.epoch === epoch }
  private key(error: unknown): OfficeKey { return error instanceof FileFailure ? error.key : 'unavailable' }
  private async result<T>(promise: Promise<RemoteResult<OfficeOutcome<T>>>): Promise<T> {
    const response = await promise
    if (!response.ok) throw new FileFailure('unavailable')
    if (!response.value.ok) throw new FileFailure(response.value.code)
    return response.value.value
  }
}
