/** Bounded daily/weekly recurrence expands into original schedules and their existing reminders. */
import { createHash } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId, officeScheduleInput } from './spec.ts'
import { projectOfficeItemTime } from './calendar-time.ts'
import { checkCollaborationCapacity } from './collaboration-access.ts'
import type { OfficeCollaborationAccess } from './collaboration-access.ts'
import type { OfficeCollaborationLimits, OfficeMeetingSeriesId, OfficeMeetingSeriesReceipt } from './collaboration-types.ts'
import type { OfficeItemId, OfficeMemberId, OfficeMember, OfficeScheduleInput } from './types.ts'

const id = z.uuid().transform(value => brandString<OfficeMeetingSeriesId>(value))
const itemId = z.uuid().transform(value => brandString<OfficeItemId>(value))
const input = z.object({
  id, schedule: officeScheduleInput, timeZone: z.string().min(1).max(100),
  frequency: z.enum(['daily', 'weekly']), interval: z.number().int().min(1).max(52), count: z.number().int().min(1).max(366),
},
).strict()
const record = z.object({
  id, creatorId: officeMemberId, input,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), companyTimeZone: z.string().min(1).max(100),
  stage: z.enum(['reserved', 'committed']), itemIds: z.array(itemId).min(1).max(366),
}).strict().refine(value => value.id === value.input.id && value.itemIds.length === value.input.count
  && value.fingerprint === fingerprint(value.input) && new Set(value.itemIds).size === value.itemIds.length)
const state = z.object({ entries: z.array(record).max(100000) }).strict()
  .refine(value => new Set(value.entries.map(entry => entry.id)).size === value.entries.length
    && new Set(value.entries.flatMap(entry => entry.itemIds)).size === value.entries.reduce((total,
      entry) => total + entry.itemIds.length, 0))
/** Recurrence intent is separate; original schedules, notifications and Native formats retain their readers. */
export const officeMeetingSeriesDomain = defineDomain({
  name: 'enterprise_office_meeting_series', version: 1,
  global: { schema: state, initial: { entries: [] } }, tables: {},
})
/** Closed recurrence input; arbitrary RRULEs and infinite expansion are not admitted. */
export const officeMeetingSeriesInput = input
/** One bounded repeat meeting request. */
export type OfficeMeetingSeriesInput = z.input<typeof input>
/** Original schedule fields plus a deterministic immutable identity. */
export interface OfficeMeetingOccurrence {
  readonly id: OfficeItemId
  readonly schedule: OfficeScheduleInput
}

/** The original office queue owns reservation, original schedule commit and retry recovery. */
export class OfficeMeetingSeriesRepository {
  constructor(private readonly domain: Domain<typeof officeMeetingSeriesDomain>, private readonly access: OfficeCollaborationAccess,
    private readonly limits: OfficeCollaborationLimits, private readonly companyTimeZone: () => string,
    private readonly commitSchedules: (actorId: OfficeMemberId, occurrences: readonly OfficeMeetingOccurrence[]) => Promise<void>) { }
  /**
   * Retain original organizers and invitees through restore and disabled-account history.
   * @param members - Complete company directory.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    const current = this.domain.global.get()
    if(current.entries.some(entry => !ids.has(entry.creatorId) || entry.input.schedule.inviteeIds.some(id => !ids.has(id))))
      throw new OfficeError('conflict', 'Meeting series require their original employee directory')
    checkCollaborationCapacity(current, current.entries.length, this.limits)
  }
  /**
   * Create a finite daily/weekly series with gap rejection and deterministic recovery after an uncertain response.
   * @param actorId - Current active organizer.
   * @param submitted - Explicit recurrence, timezone and original schedule fields.
   * @returns Existing original schedule ids; retry never duplicates invitations or reminders.
   */
  create(actorId: OfficeMemberId, submitted: OfficeMeetingSeriesInput): Promise<OfficeMeetingSeriesReceipt> {
    const value = input.parse(submitted)
    return this.access.enqueue(async () => {
      this.access.member(actorId)
      const current = this.domain.global.get()
      const previous = current.entries.find(entry => entry.id === value.id)
      if(previous && (previous.creatorId !== actorId || previous.fingerprint !== fingerprint(value)))
        throw new OfficeError('conflict', 'Meeting-series retry changed')
      if(previous?.stage === 'committed') return { id: previous.id, itemIds: [...previous.itemIds], stage: previous.stage }
      if(value.count > this.limits.maxOccurrences) throw new OfficeError('invalid_input',
        'Meeting series exceeds its configured occurrence limit')
      for(const id of value.schedule.inviteeIds) this.access.member(id)
      const companyTimeZone = previous?.companyTimeZone ?? this.companyTimeZone()
      if(companyTimeZone !== this.companyTimeZone()) throw new OfficeError('conflict',
        'Company timezone changed; review the reserved meeting series')
      const occurrences = planOfficeMeetingSeries(value, companyTimeZone)
      const reserved = previous ?? record.parse({
        id: value.id, creatorId: actorId, input: value,
        fingerprint: fingerprint(value), companyTimeZone, stage: 'reserved', itemIds: occurrences.map(entry => entry.id),
      })
      if(!previous) {
        const next = { entries: [...current.entries, reserved] }
        checkCollaborationCapacity(next, next.entries.length, this.limits)
        await this.domain.global.set(next)
      }
      await this.commitSchedules(actorId, occurrences)
      const latest = this.domain.global.get()
      const next = {
        entries: latest.entries.map(entry => entry.id === reserved.id ? { ...entry, stage: 'committed' as const } :
          entry),
      }
      checkCollaborationCapacity(next, next.entries.length, this.limits)
      await this.domain.global.set(next)
      await this.access.changed()
      return { id: reserved.id, itemIds: [...reserved.itemIds], stage: 'committed' }
    })
  }
}
/**
 * Convert each recurrence's local date independently, preserving wall-clock intent across DST changes.
 * @param submitted - Validated finite repeat request.
 * @param companyTimeZone - Current saved office timezone used by all original schedules.
 * @returns Same-day company schedule occurrences; a missing local instant or cross-day meeting rejects the entire plan.
 */
export function planOfficeMeetingSeries(submitted: OfficeMeetingSeriesInput, companyTimeZone: string):
readonly OfficeMeetingOccurrence[] {
  const value = input.parse(submitted)
  try {
    const first = Temporal.PlainDate.from(value.schedule.date)
    return Array.from({ length: value.count }, (_, index) => {
      const date = first.add({ days: index * value.interval * (value.frequency === 'weekly' ? 7 : 1) }).toString()
      const local = projectOfficeItemTime({
        kind: 'schedule', date, time: value.schedule.startTime,
        endTime: value.schedule.endTime, status: 'pending',
      }, value.timeZone, 0)
      if(local.kind !== 'schedule') throw new OfficeError('invalid_input', 'Invalid meeting interval')
      const start = Temporal.Instant.fromEpochMilliseconds(local.startsAt).toZonedDateTimeISO(companyTimeZone)
      const end = Temporal.Instant.fromEpochMilliseconds(local.endsAt).toZonedDateTimeISO(companyTimeZone)
      if(!start.toPlainDate().equals(end.toPlainDate())) throw new OfficeError('invalid_input',
        'A meeting must remain on one company-calendar date')
      const schedule = officeScheduleInput.parse({
        ...value.schedule, date: start.toPlainDate().toString(),
        startTime: start.toPlainTime().toString({ smallestUnit: 'minute' }), endTime: end.toPlainTime().toString({
          smallestUnit:
            'minute',
        }),
      })
      projectOfficeItemTime({
        kind: 'schedule', date: schedule.date, time: schedule.startTime, endTime: schedule.endTime, status:
          'pending',
      }, companyTimeZone, 0)
      return { id: occurrenceId(value.id, index), schedule }
    })
  } catch(error) {
    if(error instanceof OfficeError) throw error
    throw new OfficeError('invalid_input', 'Repeat dates, interval or timezone could not be resolved', { cause: error })
  }
}
function fingerprint(value: z.infer<typeof input>): string {
  return createHash('sha256').update(JSON.stringify({
    id: value.id, schedule: value.schedule, timeZone: value.timeZone,
    frequency: value.frequency, interval: value.interval, count: value.count,
  })).digest('hex')
}
function occurrenceId(series: OfficeMeetingSeriesId, index: number): OfficeItemId {
  const bytes = createHash('sha256').update(JSON.stringify([series, index])).digest().subarray(0, 16)
  bytes[6] = (bytes.readUInt8(6) & 15) | 128
  bytes[8] = (bytes.readUInt8(8) & 63) | 128
  const hex = bytes.toString('hex')
  return brandString<OfficeItemId>(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`)
}
