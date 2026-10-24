/** Private reviewed drafts and exact save retries; no action sends requirements externally. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeCustomizationFields, OfficeCustomizationId, OfficeCustomizationInput, OfficeCustomizationPage,
  OfficeCustomizationRecord, OfficeMember } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeKey } from './locales.ts'

interface CustomizationSnapshot {
  readonly open: boolean
  readonly mode: 'list' | 'edit'
  readonly entries: OfficeCustomizationPage['entries']
  readonly next: number | null
  readonly draft: OfficeCustomizationInput | null
  readonly saved: OfficeCustomizationRecord | null
  readonly busy: boolean
  readonly error: OfficeKey | null
  readonly uncertain: boolean
  readonly stale: boolean
}
const empty: CustomizationSnapshot = { open: false, mode: 'list', entries: [], next: null,
  draft: null, saved: null, busy: false, error: null, uncertain: false, stale: false }
type Remote = Pick<ClientRemote['office'], 'customizationRequests' | 'customizationRequest' | 'saveCustomizationRequest'>

/** Identity changes and closed popups withdraw private bodies and pending download callbacks. */
export class OfficeCustomizationsModel {
  /** Private popup metadata, editable draft and save uncertainty for the current identity. */
  readonly state = createSnapshotStore<CustomizationSnapshot>(empty)
  private member: Pick<OfficeMember, 'id' | 'role'> | null = null
  private epoch = 0
  private disposed = false

  constructor(private readonly remote: Remote, private readonly notify: (key: OfficeKey) => void,
    private readonly deliver: (record: OfficeCustomizationRecord) => void) {}

  /**
   * Clear private popup state and fence pending results when the employee or role changes.
   * @param member - Current authenticated employee and role; null withdraws all private state.
   */
  bind(member: Pick<OfficeMember, 'id' | 'role'> | null): void {
    if (this.disposed || (member?.id === this.member?.id && member?.role === this.member?.role)) return
    this.member = member ? { id: member.id, role: member.role } : null
    this.close()
  }

  /**
   * Open an unsaved form without a write or external request.
   * @param target - Optional system or skill name.
   * @param contact - Current employee's display name.
   */
  create(target: string, contact: string): void {
    if (!this.member || this.disposed) return
    this.epoch++
    this.state.set({ ...empty, open: true, mode: 'edit',
      draft: { id: null, revision: 0, requestId: randomUUID(), target: target.slice(0, 80),
        contact: contact.slice(0, 80), requirements: '' } })
  }

  /**
   * Replace a draft field and renew its retry identity when the form permits editing.
   * @param key - One of the three editable requirement fields.
   * @param value - Employee-entered text.
   */
  field(key: keyof OfficeCustomizationFields, value: string): void {
    const view = this.state.getSnapshot()
    if (!view.draft || view.busy || view.uncertain || view.stale) return
    this.state.set({ ...view, draft: { ...view.draft, [key]: value, requestId: randomUUID() }, saved: null, error: null })
  }

  /**
   * Open the current employee's saved-request list, discarding the unsaved form.
   * @returns After the newest private metadata page is read; unsaved text is discarded.
   */
  async list(): Promise<void> {
    if (!this.member || this.disposed) return
    this.epoch++
    this.state.set({ ...empty, open: true })
    await this.page(null)
  }

  /**
   * Read the next metadata page only while the saved-request list is open and idle.
   * @returns After the next private metadata page is appended.
   */
  async more(): Promise<void> {
    const view = this.state.getSnapshot()
    if (view.open && view.mode === 'list' && !view.busy && view.next !== null) await this.page(view.next)
  }

  /**
   * Load the employee's saved request into a fresh form, ignoring results invalidated by identity or popup changes.
   * @param id - Own saved request.
   * @returns After the latest saved version replaces the form.
   */
  async edit(id: OfficeCustomizationId): Promise<void> {
    if (!this.member || this.disposed) return
    const epoch = ++this.epoch
    this.state.set({ ...empty, open: true, mode: 'edit', busy: true })
    try {
      const result = await this.remote.customizationRequest(id)
      if (!this.current(epoch)) return
      if (!result.ok) { this.fail('unavailable'); return }
      if (!result.value.ok) { this.fail(result.value.code); return }
      const record = result.value.value
      if (record.ownerId !== this.member.id || record.id !== id) { this.fail('conflict'); return }
      this.adopt(record, false)
    } catch {
      if (this.current(epoch)) this.fail('unavailable')
    }
  }

  /**
   * Submit the reviewed private draft and validate its receipt before adopting the saved version.
   * @returns After a durable receipt or a visible failure; an unknown outcome retains the exact input for retry.
   */
  async save(): Promise<void> {
    const view = this.state.getSnapshot()
    if (!this.member || this.disposed || !view.open || !view.draft || view.busy || view.stale) return
    const draft = view.draft
    const epoch = this.epoch
    this.state.set({ ...view, busy: true, error: null })
    try {
      const result = await this.remote.saveCustomizationRequest(draft)
      if (!this.current(epoch)) return
      if (!result.ok) { this.unknown(); return }
      if (!result.value.ok) {
        this.fail(result.value.code, result.value.code === 'conflict')
        return
      }
      const receipt = result.value.value
      const record = receipt.record
      if (receipt.meId !== this.member.id || record.ownerId !== this.member.id
        || (draft.id !== null && record.id !== draft.id) || record.revision !== draft.revision + 1
        || record.target !== draft.target.trim() || record.contact !== draft.contact.trim()
        || record.requirements !== draft.requirements
        || receipt.currentRevision < record.revision) { this.unknown(); return }
      this.adopt(record, receipt.currentRevision !== record.revision)
    } catch {
      if (this.current(epoch)) this.unknown()
    }
  }

  /**
   * Reauthorize the saved request and deliver it only if its identity and revision still match the reviewed version.
   * @returns After an unchanged, freshly authorized saved version is delivered to the browser download callback.
   */
  async export(): Promise<void> {
    const view = this.state.getSnapshot()
    if (!this.member || !view.open || !view.saved || view.busy || view.stale || view.uncertain) return
    const saved = view.saved
    const epoch = this.epoch
    this.state.set({ ...view, busy: true, error: null })
    try {
      const result = await this.remote.customizationRequest(saved.id)
      if (!this.current(epoch)) return
      if (!result.ok) { this.fail('unavailable'); return }
      if (!result.value.ok) { this.fail(result.value.code); return }
      const record = result.value.value
      if (record.ownerId !== this.member.id || record.id !== saved.id || record.revision !== saved.revision) {
        this.fail('conflict', true); return
      }
      this.deliver(record)
      this.state.set({ ...this.state.getSnapshot(), busy: false })
    } catch {
      if (this.current(epoch)) this.fail('unavailable')
    }
  }

  /** Clear private text and fence pending acknowledgements; an admitted server save may still finish. */
  close(): void { this.epoch++; this.state.set(empty) }
  /** Withdraw state and ignore every pending response after unload. */
  dispose(): void { this.bind(null); this.disposed = true }

  private async page(before: number | null): Promise<void> {
    const epoch = this.epoch
    const previous = this.state.getSnapshot()
    this.state.set({ ...previous, busy: true, error: null })
    try {
      const result = await this.remote.customizationRequests(before)
      if (!this.current(epoch)) return
      if (!result.ok) { this.fail('unavailable'); return }
      if (!result.value.ok) { this.fail(result.value.code); return }
      const page = result.value.value
      if (page.meId !== this.member?.id) { this.fail('conflict'); return }
      const entries = new Map(previous.entries.map(value => [value.id, value]))
      for (const entry of page.entries) entries.set(entry.id, entry)
      this.state.set({ ...this.state.getSnapshot(), entries: [...entries.values()], next: page.next, busy: false })
    } catch {
      if (this.current(epoch)) this.fail('unavailable')
    }
  }

  private current(epoch: number): boolean { return !this.disposed && this.member !== null && epoch === this.epoch }
  private adopt(record: OfficeCustomizationRecord, stale: boolean): void {
    this.state.set({ ...empty, open: true, mode: 'edit', saved: record, stale,
      draft: { id: record.id, revision: record.revision, requestId: randomUUID(),
        target: record.target, contact: record.contact, requirements: record.requirements } })
  }
  private unknown(): void {
    this.state.set({ ...this.state.getSnapshot(), busy: false, uncertain: true, saved: null,
      error: 'customizationUncertain' })
  }
  private fail(error: OfficeKey, stale = false): void {
    if (error === 'unauthenticated' || error === 'forbidden') { this.bind(null); this.notify(error) }
    else this.state.set({ ...this.state.getSnapshot(), busy: false, error, stale })
  }
}
