/** Central recipient reminders retain occurrence identities independently of business notifications. */
import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { projectOfficeItemTime } from './calendar-time.ts'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type { OfficeItem, OfficeItemId, OfficeMember, OfficeReminder, OfficeReminderConfig,
  OfficeReminderId, OfficeRemindersView } from './types.ts'

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const itemId = z.uuid().transform(value => brandString<OfficeItemId>(value))

/** Stable server-created UUID accepted by the explicit reminder acknowledgement RPC. */
export const officeReminderId = z.uuid().transform(value => brandString<OfficeReminderId>(value))

const record = z.object({
  id: officeReminderId, recipientId: officeMemberId, itemId,
  kind: z.enum(['work_due', 'meeting_start']),
  occursAt: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), deliveredAt: counter, read: z.boolean(),
}).strict().refine(value => value.deliveredAt >= value.occursAt, 'A reminder cannot precede its occurrence')
type Record = z.infer<typeof record>
type Occurrence = Pick<Record, 'kind' | 'occursAt'>

function occurrenceKey(value: Pick<Record, 'itemId' | 'recipientId' | 'kind' | 'occursAt'>): string {
  return JSON.stringify([value.itemId, value.kind, value.occursAt, value.recipientId])
}

const state = z.object({ revision: counter, entries: z.array(record).max(100000).readonly() }).strict()
  .superRefine((value, context) => {
    if ((value.revision === 0) !== (value.entries.length === 0)
      || new Set(value.entries.map(entry => entry.id)).size !== value.entries.length
      || new Set(value.entries.map(occurrenceKey)).size !== value.entries.length) {
      context.addIssue({ code: 'custom', message: 'Invalid reminder history or repeated occurrence' })
    }
  })

/** Separate v1 storage leaves office business state, notifications and Native data unchanged. */
export const officeRemindersDomain = defineDomain({ name: 'enterprise_office_reminders', version: 1,
  global: { schema: state, initial: { revision: 0, entries: [] } }, tables: {} })

const configuration = z.object({
  pollIntervalMs: z.number().int().min(1).max(2147483647),
  catchUpWindowMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  maxEntries: z.number().int().min(1).max(100000),
  maxBytes: z.number().int().min(1).max(268435456),
}).strict().refine(value => value.catchUpWindowMs >= value.pollIntervalMs, 'Reminder catch-up must cover the polling delay')

/** Optional object fields remain required when configured; omission never constructs polling defaults. */
export const officeReminderConfig: Schema<OfficeReminderConfig> = Schema.union([Schema.object({
  pollIntervalMs: Schema.natural().min(1).max(2147483647).required(),
  catchUpWindowMs: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxEntries: Schema.natural().min(1).max(100000).required(),
  maxBytes: Schema.natural().min(1).max(268435456).required(),
})])

/**
 * Validate complete deployment configuration before opening storage or scheduling a timer.
 * @param input - Explicit polling, catch-up and retained-ledger limits.
 * @returns Validated configuration; the polling delay fits Node's signed 32-bit timer range.
 */
export function resolveOfficeReminderConfig(input: OfficeReminderConfig): OfficeReminderConfig {
  return configuration.parse(input)
}

function occurrence(item: OfficeItem, timeZone: string, now: number): Occurrence | undefined {
  if (item.lifecycle !== undefined || item.status !== 'pending' && item.status !== 'in_progress') return
  try {
    const projected = projectOfficeItemTime(item, timeZone, now)
    if (projected.kind === 'work') return projected.overdue ? { kind: 'work_due', occursAt: projected.dueAt } : undefined
    return projected.phase === 'ongoing' ? { kind: 'meeting_start', occursAt: projected.startsAt } : undefined
  } catch (error) {
    if (!(error instanceof OfficeError) || error.code !== 'invalid_input') throw error
    // The existing calendar projection exposes this item's unresolved time for employee review.
  }
}

function recipients(item: OfficeItem): ReadonlySet<OfficeMember['id']> {
  return item.kind === 'schedule'
    ? new Set([item.creatorId, ...item.participants.filter(value => value.reply !== 'declined').map(value => value.memberId)])
    : new Set([item.ownerId])
}

/** Mutations share the office queue; no independent writer, employee actor or external delivery is created. */
export class OfficeRemindersRepository {
  constructor(private readonly domain: Domain<typeof officeRemindersDomain>,
    private readonly config: OfficeReminderConfig, private readonly changed: () => Promise<void>) {}

  /**
   * Keep retained occurrences attached to their original employee and item directory.
   * @param members - Complete directory, including inactive employees.
   * @param items - Complete retained work, including archived and deleted records.
   */
  verifyDirectory(members: readonly OfficeMember[], items: readonly OfficeItem[]): void {
    const current = this.domain.global.get()
    this.capacity(current)
    const memberIds = new Set(members.map(member => member.id))
    const itemIds = new Set(items.map(item => item.id))
    if (current.entries.some(entry => !memberIds.has(entry.recipientId) || !itemIds.has(entry.itemId)))
      throw new OfficeError('conflict', 'Saved reminders require their original employee and work directory')
  }

  /**
   * Project only this active recipient's still-current eligible occurrences.
   * @param actor - Current active employee; administrator status does not reveal other recipients.
   * @param items - Items already authorized by the office service for this employee.
   * @param timeZone - Saved company timezone.
   * @param now - The same observation used by the enclosing OfficeView calendar projection.
   * @returns Current recipient reminders with derived item titles and no persisted content snapshots.
   */
  view(actor: OfficeMember, items: readonly OfficeItem[], timeZone: string, now: number): OfficeRemindersView {
    const available = new Map(items.map(item => [item.id, item]))
    const entries: OfficeReminder[] = []
    for (const entry of this.domain.global.get().entries) {
      if (entry.recipientId !== actor.id) continue
      const item = available.get(entry.itemId)
      if (!item || !recipients(item).has(actor.id)) continue
      const current = occurrence(item, timeZone, now)
      if (current?.kind === entry.kind && current.occursAt === entry.occursAt)
        entries.push({ ...entry, itemTitle: item.title })
    }
    return { protocol: 1, entries }
  }

  /**
   * Atomically retain every newly eligible recipient occurrence within the configured catch-up window.
   * @param items - Current complete work snapshot read after queue admission.
   * @param members - Current retained membership; inactive employees receive nothing.
   * @param timeZone - Saved company timezone.
   * @param now - One observation for this complete scan.
   * @returns After durable commit and notification; failure publishes no new delivery.
   */
  async deliver(items: readonly OfficeItem[], members: readonly OfficeMember[], timeZone: string, now: number): Promise<void> {
    const current = this.domain.global.get()
    const active = new Set(members.filter(member => member.active).map(member => member.id))
    const known = new Set(current.entries.map(occurrenceKey))
    const added: Record[] = []
    for (const item of items) {
      const projected = occurrence(item, timeZone, now)
      if (!projected || now - projected.occursAt > this.config.catchUpWindowMs) continue
      for (const recipientId of recipients(item)) {
        const fields = { ...projected, itemId: item.id, recipientId }
        const key = occurrenceKey(fields)
        if (!active.has(recipientId) || known.has(key)) continue
        if (current.entries.length + added.length >= this.config.maxEntries)
          throw new OfficeError('conflict', 'Reminder ledger reached its configured capacity')
        added.push({ ...fields, id: brandString<OfficeReminderId>(randomUUID()), deliveredAt: now, read: false })
        known.add(key)
      }
    }
    if (!added.length) return
    const next = { revision: this.nextRevision(current.revision), entries: [...current.entries, ...added] }
    this.capacity(next)
    await this.domain.global.set(next)
    await this.changed()
  }

  /**
   * Persist only the current recipient's acknowledgement of a still-visible occurrence.
   * @param actor - Current active employee, checked inside the shared queue.
   * @param id - Server-created delivered reminder UUID.
   * @param items - Currently authorized items for the caller.
   * @param timeZone - Saved company timezone.
   * @param now - Current authorization-time observation.
   * @returns After durability; an exact repeated acknowledgement writes nothing.
   */
  async markRead(actor: OfficeMember, id: OfficeReminderId, items: readonly OfficeItem[], timeZone: string, now: number): Promise<void> {
    const visible = this.view(actor, items, timeZone, now).entries.find(entry => entry.id === id)
    if (!visible) throw new OfficeError('not_found', 'Reminder is unavailable')
    if (visible.read) return
    const current = this.domain.global.get()
    const next = { revision: this.nextRevision(current.revision),
      entries: current.entries.map(entry => entry.id === id ? { ...entry, read: true } : entry) }
    this.capacity(next)
    await this.domain.global.set(next)
    await this.changed()
  }

  private nextRevision(revision: number): number {
    if (revision === Number.MAX_SAFE_INTEGER) throw new OfficeError('conflict', 'Reminder history exhausted its revision capacity')
    return revision + 1
  }

  private capacity(value: z.infer<typeof state>): void {
    if (value.entries.length > this.config.maxEntries || Buffer.byteLength(JSON.stringify(value), 'utf8') > this.config.maxBytes)
      throw new OfficeError('conflict', 'Reminder ledger reached its configured capacity')
  }
}
