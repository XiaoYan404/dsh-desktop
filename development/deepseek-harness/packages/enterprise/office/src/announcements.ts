/** Immutable company publications and recipient-owned acknowledgements share one durable commit. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type {
  OfficeAnnouncement, OfficeAnnouncementId, OfficeAnnouncementInput, OfficeAnnouncementView, OfficeMember,
} from './types.ts'

/** Stable opaque publication coordinate used by HTTP and Remote callers. */
export const officeAnnouncementId = z.uuid().transform(value => brandString<OfficeAnnouncementId>(value))
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const title = z.string().trim().normalize('NFC').min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u)
const body = z.string().trim().normalize('NFC').min(1).max(20_000).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/u)

/** Bounded plain text and an explicit delivery scope; no executable or HTML payload. */
export const officeAnnouncementInput = z.object({
  requestId: z.uuid(), title, body, audience: z.enum(['company', 'members']),
  recipientIds: z.array(officeMemberId).max(10_000).readonly(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.recipientIds).size !== value.recipientIds.length
    || (value.audience === 'company' ? value.recipientIds.length !== 0 : value.recipientIds.length === 0)) {
    ctx.addIssue({ code: 'custom', message: 'Announcement delivery scope is invalid' })
  }
})

const entry = z.object({
  id: officeAnnouncementId, revision: counter.positive(), title, body,
  publisherId: officeMemberId, publisherName: z.string().min(1), publishedAt: counter,
  audience: z.enum(['company', 'members']), recipients: z.array(officeMemberId).min(1).readonly(),
  readBy: z.array(officeMemberId).readonly(), requestId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  withdrawal: z.object({ actorId: officeMemberId, time: counter }).nullable(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.recipients).size !== value.recipients.length
    || new Set(value.readBy).size !== value.readBy.length
    || value.readBy.some(id => !value.recipients.includes(id))
    || value.revision !== (value.withdrawal === null ? 1 : 2)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid announcement recipients or revision' })
  }
})
const state = z.object({ revision: counter, entries: z.array(entry).readonly() }).strict().superRefine((value, ctx) => {
  if (new Set(value.entries.map(item => item.id)).size !== value.entries.length
    || new Set(value.entries.map(item => item.requestId)).size !== value.entries.length
    || value.revision < value.entries.length) ctx.addIssue({ code: 'custom', message: 'Invalid announcement ledger' })
})
type Entry = z.infer<typeof entry>

/** Separate storage preserves every earlier office, chat, drive and identity schema. */
export const officeAnnouncementDomain = defineDomain({
  name: 'enterprise_office_announcements', version: 1,
  global: { schema: state, initial: { revision: 0, entries: [] } }, tables: {},
})

/** Mutations run within the office membership/session queue, never in a separate competing writer. */
export class OfficeAnnouncementRepository {
  constructor(
    private readonly domain: Domain<typeof officeAnnouncementDomain>,
    private readonly changed: () => Promise<void>,
    private readonly limits: { readonly maxEntries: number; readonly rotationMs: number },
  ) {}

  /**
   * Reject publication history detached from its original employee directory.
   * @param members - Complete retained directory, including inactive authors and recipients.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    if (this.domain.global.get().entries.some(item => !ids.has(item.publisherId)
      || item.recipients.some(id => !ids.has(id)) || item.withdrawal !== null && !ids.has(item.withdrawal.actorId))) {
      throw new OfficeError('conflict', 'Saved announcements require their original employee directory')
    }
  }

  /**
   * Project current recipient publications; administrator management is explicit.
   * @param actor - Already authenticated active employee.
   * @returns Public text and only this employee's acknowledgement state.
   */
  view(actor: OfficeMember): OfficeAnnouncementView {
    const current = this.domain.global.get()
    return { revision: current.revision, ...this.limits,
      entries: current.entries.filter(item => actor.role === 'admin'
        || item.withdrawal === null && item.recipients.includes(actor.id)).map(item => this.project(item, actor)) }
  }

  /**
   * Commit a publication and its frozen current-employee delivery list together.
   * @param actor - Current administrator, checked again after queue admission.
   * @param input - Reviewed text, scope and stable retry identity.
   * @param members - Current complete company directory.
   * @returns The durable publication, without leaking receipts of other employees.
   */
  async publish(actor: OfficeMember, input: OfficeAnnouncementInput, members: readonly OfficeMember[]): Promise<OfficeAnnouncement> {
    this.administrator(actor)
    const parsed = officeAnnouncementInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Announcement text or delivery scope is invalid')
    const value = parsed.data
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...value, recipientIds: [...value.recipientIds].sort() })).digest('hex')
    const current = this.domain.global.get()
    const previous = current.entries.find(item => item.requestId === value.requestId)
    if (previous !== undefined) {
      if (previous.publisherId !== actor.id || previous.fingerprint !== fingerprint) throw new OfficeError('conflict', 'Announcement retry identity was reused')
      return this.project(previous, actor)
    }
    if (current.entries.length >= this.limits.maxEntries) throw new OfficeError('conflict', 'Announcement ledger reached its configured capacity')
    const recipients = value.audience === 'company' ? members.filter(member => member.active).map(member => member.id) : [...value.recipientIds]
    if (recipients.some(id => !members.some(member => member.id === id && member.active))) {
      throw new OfficeError('invalid_input', 'Announcement recipients must be active employees')
    }
    const record: Entry = { id: brandString<OfficeAnnouncementId>(randomUUID()), revision: 1,
      title: value.title, body: value.body, publisherId: actor.id, publisherName: actor.name, publishedAt: Date.now(),
      audience: value.audience, recipients, readBy: recipients.includes(actor.id) ? [actor.id] : [],
      requestId: value.requestId, fingerprint, withdrawal: null }
    await this.domain.global.set({ revision: current.revision + 1, entries: [...current.entries, record] })
    await this.changed()
    return this.project(record, actor)
  }

  /**
   * Acknowledge only a currently delivered publication; a retry does not write twice.
   * @param actor - Current active recipient.
   * @param id - Delivered publication identity.
   */
  async markRead(actor: OfficeMember, id: OfficeAnnouncementId): Promise<void> {
    const current = this.domain.global.get()
    const record = current.entries.find(item => item.id === id && item.withdrawal === null && item.recipients.includes(actor.id))
    if (record === undefined) throw new OfficeError('not_found', 'Announcement is unavailable')
    if (record.readBy.includes(actor.id)) return
    await this.domain.global.set({ revision: current.revision + 1,
      entries: current.entries.map(item => item.id === id ? { ...item, readBy: [...item.readBy, actor.id] } : item) })
    await this.changed()
  }

  /**
   * Withdraw a reviewed publication without removing historical text or receipts.
   * @param actor - Current administrator.
   * @param id - Publication identity.
   * @param expectedRevision - Reviewed immutable content revision.
   */
  async withdraw(actor: OfficeMember, id: OfficeAnnouncementId, expectedRevision: number): Promise<void> {
    this.administrator(actor)
    const current = this.domain.global.get()
    const record = current.entries.find(item => item.id === id)
    if (record === undefined) throw new OfficeError('not_found', 'Announcement is unavailable')
    if (record.withdrawal !== null) return
    if (record.revision !== expectedRevision) throw new OfficeError('conflict', 'Announcement changed since review')
    await this.domain.global.set({ revision: current.revision + 1, entries: current.entries.map(item => item.id === id
      ? { ...item, revision: item.revision + 1, withdrawal: { actorId: actor.id, time: Date.now() } } : item) })
    await this.changed()
  }

  private administrator(actor: OfficeMember): void {
    if (actor.role !== 'admin') throw new OfficeError('forbidden', 'Only administrators publish or withdraw company announcements')
  }

  private project(item: Entry, actor: OfficeMember): OfficeAnnouncement {
    const recipient = item.recipients.includes(actor.id)
    return { id: item.id, revision: item.revision, title: item.title, body: item.body,
      publisherId: item.publisherId, publisherName: item.publisherName, publishedAt: item.publishedAt,
      audience: item.audience, recipientCount: item.recipients.length, recipient,
      read: !recipient || item.readBy.includes(actor.id), withdrawn: item.withdrawal !== null }
  }
}
