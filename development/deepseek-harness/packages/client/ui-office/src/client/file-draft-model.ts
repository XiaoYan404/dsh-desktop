/** Durable private contact selections retain handles and encoded retries outside hook snapshots. */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bytesToBase64, randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeChatAttachment, OfficeChatFileDraft, OfficeChatFileDraftInput, OfficeChatFileDraftSendInput,
  OfficeChatFileDraftView, OfficeChatFileInput, OfficeChatFileLimits, OfficeChatMessage, OfficeChatPeer, OfficeMemberId, OfficeMessageId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../types.ts'
import type { OfficeKey } from './locales.ts'
import { recordValue } from './values.ts'

interface Selection { readonly id: string; readonly name: string; readonly byteLength: number }
interface Contact {
  readonly peer: OfficeChatPeer | null
  readonly files: readonly Selection[]
  readonly saving: boolean
  readonly sending: boolean
  readonly dirty: boolean
  readonly blocked: boolean
  readonly saveError: OfficeKey | null
  readonly error: OfficeKey | null
  readonly pendingSend: OfficeChatFileDraftSendInput | null
}
interface DraftState {
  readonly mode: 'loading' | 'durable' | 'local' | 'failed'
  readonly loading: boolean
  readonly error: OfficeKey | null
  readonly ownerQuotaBytes: number
  readonly ownerUsedBytes: number
  readonly contacts: Readonly<Record<string, Contact>>
}
type Remote = Pick<ClientRemote['office'], 'chatFileDrafts' | 'saveChatFileDraft' | 'downloadChatFileDraft' | 'sendChatFileDraft'>
interface Choice extends Selection {
  readonly file: File | null
  readonly stored: { readonly revision: number; readonly metadata: OfficeChatAttachment } | null
}
interface SaveAttempt { readonly ids: readonly string[]; readonly input: OfficeChatFileDraftInput }
const empty = (): Contact => ({ peer: null, files: [], saving: false, sending: false, dirty: false, blocked: false,
  saveError: null, error: null, pendingSend: null })
const initial = (): DraftState => ({ mode: 'loading', loading: false, error: null, ownerQuotaBytes: 0, ownerUsedBytes: 0, contacts: {} })
const inlineBound = 8 * 1024 * 1024
class DraftFailure extends Error { constructor(readonly key: OfficeKey) { super(key) } }

/** One account owns contact versions, local files and exact save/send retries across panel remounts. */
export class OfficeFileDraftModel {
  /** Only authorized JSON metadata and visible save state reach the UI. */
  readonly state = createSnapshotStore<DraftState>(initial())
  private readonly choices = new Map<OfficeMemberId, readonly Choice[]>()
  private readonly bases = new Map<OfficeMemberId, OfficeChatFileDraft>()
  private readonly attempts = new Map<OfficeMemberId, SaveAttempt>()
  private readonly clears = new Map<OfficeMemberId, OfficeChatFileDraftInput>()
  private principal: OfficeMemberId | null = null
  private epoch = 0
  private generation = 0
  private disposed = false

  constructor(
    private readonly remote: Remote,
    private readonly limits: () => OfficeChatFileLimits | null,
    private readonly notify: (key: OfficeKey, success: boolean) => void,
    private readonly published: () => Promise<void>,
  ) {}

  /**
   * Fence all pending work and discard the previous employee's handles before restoring private metadata.
   * @param principal - Confirmed active employee, or null at sign-out.
   */
  bind(principal: OfficeMemberId | null): void {
    if (this.disposed || principal === this.principal) return
    this.principal = principal
    this.epoch++
    this.generation++
    this.choices.clear()
    this.bases.clear()
    this.attempts.clear()
    this.clears.clear()
    this.state.set(initial())
    if (principal) void this.load()
  }

  /** Refresh authorized saved selections while preserving local edits and unresolved outcomes. */
  async load(): Promise<void> {
    if (!this.current(this.epoch) || this.state.getSnapshot().mode === 'local') return
    const epoch = this.epoch
    const generation = ++this.generation
    this.patch({ loading: true, error: null })
    try {
      const view = await this.result(this.remote.chatFileDrafts())
      if (!this.current(epoch) || generation !== this.generation) return
      this.authorize(view)
      this.patch({ mode: 'durable', loading: false, ownerQuotaBytes: view.ownerQuotaBytes, ownerUsedBytes: view.ownerUsedBytes })
      for (const saved of view.drafts) {
        const local = this.contact(saved.peerId)
        if (local.dirty || local.saving || local.sending || local.pendingSend ||
          saved.revision < (this.bases.get(saved.peerId)?.revision ?? 0))
          continue
        this.adopt(saved)
      }
    } catch (error) {
      if (!this.current(epoch) || generation !== this.generation) return
      const key = this.key(error)
      if (key === 'invalid_input' && this.state.getSnapshot().mode !== 'durable') {
        // Older authenticated gateways reject the unknown operation; retain their existing file-message path.
        this.patch({ mode: 'local', loading: false, error: null })
      } else {
        this.patch({ mode: this.state.getSnapshot().mode === 'durable' ? 'durable' : 'failed', loading: false, error: key })
        if (key === 'unauthenticated') this.notify(key, false)
      }
    }
  }

  /**
   * Select and automatically save bounded files for the captured contact.
   * @param peer - Current recipient, independent of later navigation.
   * @param files - Private browser handles, never published to stores.
   */
  add(peer: OfficeMemberId, files: readonly File[]): void {
    const limits = this.limits()
    if (!this.editable(peer) || !limits || files.length === 0) return
    const choices = this.choices.get(peer) ?? []
    const total = [...choices.map(value => value.byteLength), ...files.map(file => file.size)]
    if (choices.length + files.length > limits.maxFilesPerMessage ||
      files.some(file => file.size > Math.min(limits.maxFileBytes, inlineBound)) ||
      total.reduce((sum, value) => sum + value, 0) > Math.min(limits.maxMessageBytes, inlineBound)) {
      this.setContact(peer, { ...this.contact(peer), error: 'chatFileSelectionTooLarge' })
      return
    }
    const next = [...choices, ...files.map(file => ({ id: randomUUID(), name: file.name, byteLength: file.size, file, stored: null }))]
    this.choices.set(peer, next)
    this.setContact(peer, { ...this.contact(peer), files: this.metadata(next), dirty: true, error: null,
      saveError: this.contact(peer).saveError === 'conflict' ? 'conflict' : null })
    void this.persist(peer)
  }

  /**
   * Remove one idle selection and durably retain its resulting contact version, including an empty tombstone.
   * @param peer - Contact owning the selection.
   * @param id - Opaque current selection identity.
   */
  remove(peer: OfficeMemberId, id: string): void {
    if (!this.editable(peer)) return
    const next = (this.choices.get(peer) ?? []).filter(value => value.id !== id)
    this.choices.set(peer, next)
    this.setContact(peer, { ...this.contact(peer), files: this.metadata(next), dirty: true, error: null,
      saveError: this.contact(peer).saveError === 'conflict' ? 'conflict' : null })
    void this.persist(peer)
  }

  /**
   * Retry the captured private save without changing its identity or reviewed version.
   * @param peer - Contact with a retained failed save.
   * @returns Whether the exact selection is now confirmed durable.
   */
  async retry(peer: OfficeMemberId): Promise<boolean> { return this.clears.has(peer) ? this.clear(peer) : this.persist(peer) }

  /**
   * Clear only the reviewed selection, retaining any message already committed and fencing old queued retries.
   * @param peer - Contact whose original file draft the user explicitly clears.
   * @returns Whether its original cleared version was confirmed under the same account.
   */
  async clear(peer: OfficeMemberId): Promise<boolean> {
    const local = this.contact(peer)
    const revision = this.bases.get(peer)?.revision ?? 0
    if (!this.current(this.epoch) || this.state.getSnapshot().mode !== 'durable' || local.saving || local.sending) return false
    const epoch = this.epoch
    this.setContact(peer, { ...local, saving: true, saveError: null })
    try {
      const request = this.clears.get(peer) ?? { peerId: peer, revision, requestId: randomUUID(), files: [] }
      this.clears.set(peer, request)
      const saved = await this.result(this.remote.saveChatFileDraft(request))
      if (!this.current(epoch)) return false
      if (saved.peerId !== peer || saved.revision !== request.revision + 1 || saved.files.length !== 0)
        throw new DraftFailure('unavailable')
      this.attempts.delete(peer)
      this.clears.delete(peer)
      this.adopt(saved)
      void this.published().catch(() => { if (this.current(epoch)) this.notify('unavailable', false) })
      void this.load()
      return true
    } catch (error) {
      if (this.current(epoch)) this.saveFailure(peer, error)
      return false
    }
  }

  /**
   * Resolve a competing window only after explicitly loading or keeping the local selection.
   * @param peer - Contact whose reviewed version conflicted or whose save result is uncertain.
   * @param keepLocal - Adopt the latest version and resave local files, or replace them with the saved selection.
   */
  async resolve(peer: OfficeMemberId, keepLocal: boolean): Promise<void> {
    const local = this.contact(peer)
    if (!this.current(this.epoch) || local.saving || local.sending) return
    const epoch = this.epoch
    this.setContact(peer, { ...local, saving: true })
    try {
      const view = await this.result(this.remote.chatFileDrafts())
      if (!this.current(epoch)) return
      this.authorize(view)
      const latest = view.drafts.find(value => value.peerId === peer)
      if (!latest) {
        if (this.bases.has(peer)) throw new DraftFailure('conflict')
        this.bases.delete(peer)
      } else this.bases.set(peer, latest)
      if (!keepLocal) {
        this.attempts.delete(peer)
        this.clears.delete(peer)
        this.adopt(latest ?? { peerId: peer, revision: 0, files: [], updatedAt: 0, pendingSend: null })
      } else {
        if (latest?.pendingSend) throw new DraftFailure('conflict')
        this.clears.delete(peer)
        this.setContact(peer, { ...this.contact(peer), saving: false, dirty: true, blocked: false,
          pendingSend: null, error: null, saveError: null })
        await this.persist(peer, true)
      }
      if (this.current(epoch)) this.patch({ ownerUsedBytes: view.ownerUsedBytes, ownerQuotaBytes: view.ownerQuotaBytes })
    } catch (error) {
      if (this.current(epoch)) this.saveFailure(peer, error)
    } finally {
      if (this.current(epoch)) this.setContact(peer, { ...this.contact(peer), saving: false })
    }
  }

  /**
   * Send only a confirmed durable selection, retaining the exact caption across uncertain responses.
   * @param peer - Captured recipient.
   * @param text - Original caption; an unresolved send requires that same text for retry.
   * @returns True only when the original file message and draft clearing are confirmed under this account.
   */
  async send(peer: OfficeMemberId, text: string): Promise<boolean> {
    const local = this.contact(peer)
    if (!this.current(this.epoch) || this.state.getSnapshot().mode !== 'durable' || local.saving || local.sending || local.dirty) return false
    const base = this.bases.get(peer)
    if (!base?.files.length) return false
    const input = local.pendingSend ?? { id: randomUUID() as OfficeMessageId, peerId: peer, revision: base.revision, text }
    if (input.text !== text) {
      this.setContact(peer, { ...local, error: 'chatFilePendingCaption' })
      return false
    }
    const epoch = this.epoch
    this.setContact(peer, { ...local, sending: true, pendingSend: input, error: null, blocked: true })
    try {
      const message = await this.result(this.remote.sendChatFileDraft(input))
      if (!this.current(epoch)) return false
      this.checkMessage(message, input, base.files)
      this.attempts.delete(peer)
      this.adopt({ peerId: peer, files: [], revision: input.revision + 1, updatedAt: Date.now(), pendingSend: null })
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

  /** Release account-private handles, payloads and late results on plugin unload. */
  dispose(): void { this.bind(null); this.disposed = true }

  private async persist(peer: OfficeMemberId, replace = false): Promise<boolean> {
    const local = this.contact(peer)
    if (!this.current(this.epoch) || this.state.getSnapshot().mode !== 'durable' || local.saving || local.sending ||
      local.pendingSend || local.saveError === 'conflict' && !replace) return false
    const epoch = this.epoch
    const choices = this.choices.get(peer) ?? []
    const previous = this.attempts.get(peer)
    this.setContact(peer, { ...local, saving: true, error: null, saveError: null })
    try {
      const ids = choices.map(value => value.id)
      const revision = this.bases.get(peer)?.revision ?? 0
      let attempt = previous
      if (!attempt || replace || attempt.input.revision !== revision || attempt.ids.join() !== ids.join()) {
        const files: OfficeChatFileInput[] = []
        for (const choice of choices) {
          const index = previous?.ids.indexOf(choice.id) ?? -1
          const retained = index >= 0 ? previous?.input.files[index] : undefined
          files.push(retained ?? await this.readChoice(peer, choice, epoch))
          if (!this.current(epoch)) return false
        }
        attempt = { ids, input: { peerId: peer, revision, requestId: randomUUID(), files } }
        this.attempts.set(peer, attempt)
      }
      const input = attempt.input
      const saved = await this.result(this.remote.saveChatFileDraft(input))
      if (!this.current(epoch)) return false
      if (saved.peerId !== peer || saved.revision !== revision + 1 || saved.files.length !== choices.length ||
        saved.files.some((file, index) => {
          const expected = input.files[index]
          return !expected || file.name !== expected.name || file.byteLength !== expected.byteLength ||
            file.mediaType !== expected.mediaType ||
            file.sha256 !== bytesToHex(sha256(Uint8Array.from(atob(expected.dataBase64), value => value.charCodeAt(0))))
        }))
        throw new DraftFailure('unavailable')
      this.attempts.delete(peer)
      this.adopt(saved, choices)
      void this.load()
      return true
    } catch (error) {
      if (this.current(epoch)) this.saveFailure(peer, error)
      return false
    }
  }

  private async readChoice(peer: OfficeMemberId, choice: Choice, epoch: number): Promise<OfficeChatFileInput> {
    if (choice.file) {
      let buffer: ArrayBuffer
      try { buffer = await choice.file.arrayBuffer() }
      catch (error) { throw new DraftFailure(error instanceof DraftFailure ? error.key : 'fileReadFailed') }
      if (!this.current(epoch) || buffer.byteLength !== choice.byteLength) throw new DraftFailure('fileReadFailed')
      if (choice.stored && bytesToHex(sha256(new Uint8Array(buffer))) !== choice.stored.metadata.sha256)
        throw new DraftFailure('fileReadFailed')
      return { name: choice.name.normalize('NFC'), mediaType: choice.file.type || 'application/octet-stream',
        byteLength: choice.byteLength, dataBase64: bytesToBase64(new Uint8Array(buffer)) }
    }
    const stored = choice.stored
    if (!stored) throw new DraftFailure('fileReadFailed')
    const file = await this.result(this.remote.downloadChatFileDraft({ peerId: peer, revision: stored.revision,
      attachmentId: stored.metadata.id }))
    if (!this.current(epoch)) throw new DraftFailure('unavailable')
    if (file.peerId !== peer || file.revision !== stored.revision || file.id !== stored.metadata.id ||
      file.byteLength !== choice.byteLength || file.byteLength > inlineBound || file.sha256 !== stored.metadata.sha256 ||
      file.name !== stored.metadata.name || file.mediaType !== stored.metadata.mediaType ||
      file.dataBase64.length > Math.ceil(inlineBound / 3) * 4) throw new DraftFailure('downloadCorrupt')
    let bytes: Uint8Array
    try { bytes = Uint8Array.from(atob(file.dataBase64), value => value.charCodeAt(0)) }
    catch (error) { throw new DraftFailure(error instanceof DraftFailure ? error.key : 'downloadCorrupt') }
    if (bytes.length !== file.byteLength || bytesToHex(sha256(bytes)) !== file.sha256 || bytesToBase64(bytes) !== file.dataBase64)
      throw new DraftFailure('downloadCorrupt')
    return { name: file.name, mediaType: file.mediaType, byteLength: file.byteLength, dataBase64: file.dataBase64 }
  }
  private checkMessage(message: OfficeChatMessage, input: OfficeChatFileDraftSendInput, files: readonly OfficeChatAttachment[]): void {
    if (message.id !== input.id || message.senderId !== this.principal || message.recipientId !== input.peerId ||
      message.text !== (input.text.trim() ? input.text : files.map(file => file.name).join('\n')) ||
      message.attachments?.length !== files.length || files.some((file, index) => {
      const received = message.attachments?.[index]
      return !received || received.name !== file.name || received.byteLength !== file.byteLength ||
          received.mediaType !== file.mediaType || received.sha256 !== file.sha256
    })) throw new DraftFailure('unavailable')
  }
  private authorize(view: OfficeChatFileDraftView): void {
    if (view.meId !== this.principal) throw new DraftFailure('unauthenticated')
  }
  private adopt(saved: OfficeChatFileDraft, retained?: readonly Choice[]): void {
    this.bases.set(saved.peerId, saved)
    const previous = this.choices.get(saved.peerId) ?? []
    const choices = saved.files.map((file, index) => ({ id: file.id, name: file.name, byteLength: file.byteLength,
      file: retained?.[index]?.file ?? previous.find(value => value.id === file.id)?.file ?? null,
      stored: { revision: saved.revision, metadata: file } }))
    this.choices.set(saved.peerId, choices)
    this.setContact(saved.peerId, { ...empty(), peer: saved.peer ?? this.contact(saved.peerId).peer,
      files: this.metadata(choices), pendingSend: saved.pendingSend, blocked: saved.pendingSend !== null })
  }
  private saveFailure(peer: OfficeMemberId, error: unknown): void {
    const key = this.key(error)
    if (key !== 'unavailable' && key !== 'conflict') this.attempts.delete(peer)
    this.setContact(peer, { ...this.contact(peer), saving: false, dirty: true, saveError: key, blocked: key === 'unavailable' })
    if (key === 'unauthenticated') this.notify(key, false)
  }
  private editable(peer: OfficeMemberId): boolean {
    const local = this.contact(peer)
    return this.current(this.epoch) && this.state.getSnapshot().mode === 'durable' &&
      !local.saving && !local.sending && !local.blocked && !local.pendingSend
  }
  private metadata(choices: readonly Choice[]): Selection[] { return choices.map(({ id, name, byteLength }) => ({ id, name, byteLength })) }
  private contact(peer: OfficeMemberId): Contact { return recordValue(this.state.getSnapshot().contacts, peer) ?? empty() }
  private setContact(peer: OfficeMemberId, value: Contact): void {
    this.patch({ contacts: { ...this.state.getSnapshot().contacts, [peer]: value } })
  }
  private patch(value: Partial<DraftState>): void { this.state.set({ ...this.state.getSnapshot(), ...value }) }
  private current(epoch: number): boolean { return !this.disposed && this.principal !== null && this.epoch === epoch }
  private key(error: unknown): OfficeKey { return error instanceof DraftFailure ? error.key : 'unavailable' }
  private async result<T>(promise: Promise<RemoteResult<OfficeOutcome<T>>>): Promise<T> {
    const result = await promise
    if (!result.ok) throw new DraftFailure('unavailable')
    if (!result.value.ok) throw new DraftFailure(result.value.code)
    return result.value.value
  }
}
