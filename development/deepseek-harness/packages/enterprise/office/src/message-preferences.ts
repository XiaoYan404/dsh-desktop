/** Recipient preferences and desktop delivery receipts extend the original central inbox. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import { collaborationCounter as counter, collaborationRevision, checkCollaborationCapacity } from './collaboration-access.ts'
import type { OfficeCollaborationAccess } from './collaboration-access.ts'
import type { OfficeCollaborationLimits, OfficeMessagePreferences, OfficeUnifiedNotice } from './collaboration-types.ts'
import type { OfficeMemberId, OfficeMember, OfficeView, OfficeChatView } from './types.ts'

const source = z.enum(['item', 'announcement', 'reminder', 'chat', 'group', 'mention'])
const minute = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
const zone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true }
  catch(error) { if(error instanceof RangeError) return false; throw error }
}, 'An IANA timezone is required')
const preferences = z.object({
  revision: counter, desktop: z.boolean(), timeZone: zone,
  sources: z.array(source).max(6).refine(value => new Set(value).size === value.length),
  quiet: z.object({ start: minute, end: minute }).strict().refine(value => value.start !== value.end).nullable(),
}).strict()
const saved = z.object({ memberId: officeMemberId, value: preferences }).strict()
const delivery = z.object({
  id: z.uuid(), memberId: officeMemberId, deviceId: z.uuid(), key: z.string().min(1).max(200),
  attempt: counter.min(1), stage: z.enum(['pending', 'delivered', 'failed', 'unknown']), claimedAt: counter,
  leaseUntil: counter, preferenceRevision: counter,
}).strict().refine(value => value.leaseUntil > value.claimedAt)
const state = z.object({ preferences: z.array(saved).max(100000), deliveries: z.array(delivery).max(100000) }).strict()
  .refine(value => new Set(value.preferences.map(entry => entry.memberId)).size === value.preferences.length
    && new Set(value.deliveries.map(entry => entry.id)).size === value.deliveries.length
    && new Set(value.deliveries.map(entry => JSON.stringify([entry.memberId, entry.deviceId,
      entry.key]))).size === value.deliveries.length)

/** Separate v1 receipts store no notification titles, message bodies or independent read flags. */
export const officeMessagePreferencesDomain = defineDomain({
  name: 'enterprise_office_message_preferences', version: 1,
  global: { schema: state, initial: { preferences: [], deliveries: [] } }, tables: {},
})
/** Strict preference, filtering and per-device delivery operations. */
export const officeMessageSchemas = {
  preferences,
  query: z.object({
    source: source.nullable(), unreadOnly: z.boolean(), before: z.object({
      time: counter,
      key: z.string().min(1).max(200),
    }).strict().nullable(), limit: counter.min(1).max(100),
  }).strict(),
  claim: z.object({ deviceId: z.uuid(), key: z.string().min(1).max(200), retry: z.boolean() }).strict(),
  settle: z.object({ id: z.uuid(), deviceId: z.uuid(), attempt: counter.min(1), stage: z.enum(['delivered', 'failed']) }).strict(),
}
/** Bounded unified inbox query. */
export type OfficeUnifiedInboxQuery = z.input<typeof officeMessageSchemas.query>
/** Recipient-owned desktop attempt, without business text. */
export type OfficeDesktopDelivery = z.infer<typeof delivery>

/**
 * Merge already-authorized original inbox rows and chat projections without persisting duplicate content.
 * @param view - Current original recipient projection.
 * @param chat - Current original private-thread projection.
 * @param groups - Current member-authorized group and mention rows.
 * @returns Complete authorized rows; original read owners remain authoritative.
 */
export function projectUnifiedOfficeInbox(view: OfficeView, chat: OfficeChatView | null,
  groups: readonly OfficeUnifiedNotice[]): readonly OfficeUnifiedNotice[] {
  return [
    ...view.notifications.map(value => ({
      key: `item:${value.id}`, source: 'item' as const, targetId: value.itemId,
      title: value.itemTitle ?? view.items.find(item => item.id === value.itemId)?.title ?? '', time: value.createdAt, read:
        value.read,
    })),
    ...(view.announcements?.entries ?? []).filter(value => value.recipient && !value.withdrawn).map(value => ({
      key: `announcement:${value.id}`,
      source: 'announcement' as const, targetId: value.id, title: value.title, time: value.publishedAt, read: value.read,
    })),
    ...(view.reminders?.entries ?? []).map(value => ({
      key: `reminder:${value.id}`, source: 'reminder' as const, targetId:
        value.itemId,
      title: value.itemTitle, time: value.deliveredAt, read: value.read,
    })),
    ...(chat?.threads ?? []).map(value => ({
      key: `chat:${value.latest.id}`, source: 'chat' as const, targetId: value.peer.id,
      title: value.peer.name, time: value.latest.createdAt, read: value.unread === 0,
    })),
    ...groups,
  ]
}

/** All delivery claims recheck the original authorized unread projection after queue admission. */
export class OfficeMessagePreferencesRepository {
  constructor(private readonly domain: Domain<typeof officeMessagePreferencesDomain>, private readonly access:
  OfficeCollaborationAccess,
  private readonly limits: OfficeCollaborationLimits, private readonly companyTimeZone: () => string,
  private readonly notices: (actor: OfficeMemberId) => readonly OfficeUnifiedNotice[]) { }

  /**
   * Keep preference and device receipts attached to their original directory.
   * @param members - Complete retained employee directory.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    const current = this.domain.global.get()
    if(current.preferences.some(entry => !ids.has(entry.memberId)) || current.deliveries.some(entry => !ids.has(entry.memberId)))
      throw new OfficeError('conflict', 'Message preferences require their original employee directory')
    this.capacity(current)
  }
  /**
   * Read current per-recipient preferences; unsaved defaults suppress desktop delivery.
   * @param actorId - Authenticated active recipient.
   * @returns Safe preferences in the company timezone until the recipient saves a choice.
   */
  get(actorId: OfficeMemberId): OfficeMessagePreferences {
    this.access.member(actorId)
    return structuredClone(this.domain.global.get().preferences.find(entry => entry.memberId === actorId)?.value
      ?? { revision: 0, desktop: false, timeZone: zone.parse(this.companyTimeZone()), sources: source.options, quiet: null })
  }
  /**
   * Save only this employee's reviewed preference revision.
   * @param actorId - Authenticated active recipient.
   * @param input - Complete explicit preference selection.
   * @returns Committed next revision; stale devices cannot overwrite newer choices.
   */
  save(actorId: OfficeMemberId, input: OfficeMessagePreferences): Promise<OfficeMessagePreferences> {
    const value = preferences.parse(input)
    return this.access.enqueue(async () => {
      const previous = this.get(actorId)
      if(previous.revision !== value.revision) throw new OfficeError('conflict', 'Notification preferences changed on another device')
      const next = { ...value, revision: collaborationRevision(previous.revision) }
      const current = this.domain.global.get()
      const proposed = {
        ...current, preferences: [...current.preferences.filter(entry => entry.memberId !== actorId), {
          memberId:
            actorId, value: next,
        }],
      }
      this.capacity(proposed)
      await this.domain.global.set(proposed)
      await this.access.changed()
      return structuredClone(next)
    })
  }
  /**
   * Read a bounded cross-source page, filtering after current recipient authorization.
   * @param actorId - Authenticated employee.
   * @param input - Exact source/unread filters and exclusive stable position.
   * @returns Current unread count and page; no snapshot consistency is claimed between pages.
   */
  page(actorId: OfficeMemberId, input: OfficeUnifiedInboxQuery): {
    readonly entries: readonly OfficeUnifiedNotice[]
    readonly unread: number
    readonly next: {
      readonly time: number
      readonly key: string
    } | null
  } {
    const query = officeMessageSchemas.query.parse(input)
    this.access.member(actorId)
    const all = this.notices(actorId)
    const ordered = all.filter(entry => (query.source === null || entry.source === query.source) && (!query.unreadOnly || !entry.read))
      .sort((a, b) => b.time - a.time || compareKey(a.key, b.key))
    const before = query.before
    const remaining = before === null ? ordered : ordered.filter(entry => entry.time < before.time
      || entry.time === before.time && compareKey(entry.key, before.key) > 0)
    const entries = remaining.slice(0, query.limit)
    const last = entries.at(-1)
    return {
      entries, unread: all.filter(entry => !entry.read).length,
      next: remaining.length > entries.length && last ? { time: last.time, key: last.key } : null,
    }
  }
  /**
   * Claim a single per-device desktop attempt; a timed-out attempt is unknown and cannot automatically replay.
   * @param actorId - Current recipient bound by the transport.
   * @param input - Device UUID, current unread entry and explicit retry only after a confirmed failure.
   * @returns Durable pending receipt, or null when disabled, quiet, already read, delivered or uncertain.
   */
  claim(actorId: OfficeMemberId, input: z.input<typeof officeMessageSchemas.claim>): Promise<OfficeDesktopDelivery | null> {
    const value = officeMessageSchemas.claim.parse(input)
    return this.access.enqueue(async () => {
      const preference = this.get(actorId)
      const notice = this.notices(actorId).find(entry => entry.key === value.key)
      const now = Date.now()
      if(!notice || notice.read || !preference.desktop || !preference.sources.includes(notice.source) || quietNow(preference,
        now)) return null
      const current = this.domain.global.get()
      const prior = current.deliveries.find(entry => entry.memberId === actorId && entry.deviceId === value.deviceId &&
        entry.key === value.key)
      if(prior && (prior.stage !== 'failed' || !value.retry || prior.attempt >= this.limits.maxDeliveryAttempts)) return null
      const proposed: OfficeDesktopDelivery = {
        id: prior?.id ?? randomUUID(), memberId: actorId, deviceId: value.deviceId, key:
          value.key,
        attempt: (prior?.attempt ?? 0) + 1, stage: 'pending', claimedAt: now, leaseUntil: now + this.limits.deliveryLeaseMs,
        preferenceRevision: preference.revision,
      }
      const next = { ...current, deliveries: [...current.deliveries.filter(entry => entry !== prior), proposed] }
      this.capacity(next)
      await this.domain.global.set(next)
      return structuredClone(proposed)
    })
  }
  /**
   * Settle only the exact current device attempt while recipient authority and original unread access remain current.
   * @param actorId - Authenticated recipient.
   * @param input - Device-bound receipt and actual desktop API outcome.
   * @returns Persisted safe attempt, or null after authorization to the target was withdrawn.
   */
  settle(actorId: OfficeMemberId, input: z.input<typeof officeMessageSchemas.settle>): Promise<OfficeDesktopDelivery | null> {
    const value = officeMessageSchemas.settle.parse(input)
    return this.access.enqueue(async () => {
      this.access.member(actorId)
      const current = this.domain.global.get()
      const prior = current.deliveries.find(entry => entry.id === value.id && entry.memberId === actorId &&
        entry.deviceId === value.deviceId)
      if(!prior || prior.attempt !== value.attempt) throw new OfficeError('not_found', 'Desktop attempt is unavailable')
      if(!this.notices(actorId).some(entry => entry.key === prior.key && !entry.read)) return null
      if(prior.stage !== 'pending') return structuredClone(prior)
      const preference = this.get(actorId)
      const stage: OfficeDesktopDelivery['stage'] = Date.now() >= prior.leaseUntil ||
        preference.revision !== prior.preferenceRevision ? 'unknown' : value.stage
      const next = { ...prior, stage }
      const proposed = { ...current, deliveries: current.deliveries.map(entry => entry === prior ? next : entry) }
      this.capacity(proposed)
      await this.domain.global.set(proposed)
      return structuredClone(next)
    })
  }
  private capacity(value: z.infer<typeof state>): void {
    checkCollaborationCapacity(value, value.preferences.length + value.deliveries.length, this.limits)
  }
}
function compareKey(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
/**
 * Resolve quiet hours in the recipient's chosen timezone, including midnight-spanning windows and DST transitions.
 * @param preferences - Validated persisted recipient choices.
 * @param now - Server observation instant.
 * @returns Whether desktop presentation is currently suppressed; durable inbox delivery is unaffected.
 */
export function quietNow(preferences: OfficeMessagePreferences, now: number): boolean {
  if(!preferences.quiet) return false
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: preferences.timeZone, hour: '2-digit', minute: '2-digit', hourCycle:
      'h23',
  }).formatToParts(now)
  const time = `${parts.find(part => part.type === 'hour')?.value}:${parts.find(part => part.type === 'minute')?.value}`
  const { start, end } = preferences.quiet
  return start < end ? time >= start && time < end : time >= start || time < end
}
