/** Pure company-time projections of stored work and meeting fields; no status writes or scheduling. */
import { Temporal } from '@js-temporal/polyfill'
import { OfficeError } from './error.ts'
import { officeDate, officeTime } from './spec.ts'
import type { OfficeItem } from './types.ts'

type CalendarItem = Pick<OfficeItem, 'kind' | 'date' | 'time' | 'endTime' | 'status' | 'lifecycle'>

/** Work deadlines and meeting phases are derived independently of the persisted item status. */
export type OfficeItemTime =
  | { readonly kind: 'work'; readonly dueAt: number; readonly overdue: boolean }
  | {
    readonly kind: 'schedule'
    readonly startsAt: number
    readonly endsAt: number
    readonly phase: 'upcoming' | 'ongoing' | 'ended'
  }

function parseDate(value: string): Temporal.PlainDate {
  if (!officeDate.safeParse(value).success) {
    throw new OfficeError('invalid_input', 'The office item date must be an existing YYYY-MM-DD date in years 0000–9999.')
  }
  return Temporal.PlainDate.from(value)
}

function parseTime(value: string | undefined, field: string): Temporal.PlainTime {
  const parsed = officeTime.safeParse(value)
  if (!parsed.success) {
    throw new OfficeError('invalid_input', `The office item ${field} must be a time in HH:mm format.`)
  }
  return Temporal.PlainTime.from(parsed.data)
}

/** Match Native Schedule's overlap choice and reject a gap through the local-field round trip. */
function localInstant(date: Temporal.PlainDate, time: Temporal.PlainTime, timeZone: string, field: string): number {
  const local = date.toPlainDateTime(time)
  let zoned: Temporal.ZonedDateTime
  try {
    zoned = local.toZonedDateTime(timeZone, { disambiguation: 'earlier' })
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    throw new OfficeError('invalid_input', 'The office timezone must identify a supported time zone.', { cause: error })
  }
  if (!zoned.toPlainDateTime().equals(local)) {
    throw new OfficeError('invalid_input', `The office item ${field} does not exist in the office timezone ${timeZone}.`)
  }
  return zoned.epochMilliseconds
}

/**
 * Resolve company wall-clock fields without changing the item or its persisted status.
 * An omitted work time expires at the following date's midnight, rather than after 24 elapsed hours.
 * Missing local instants are rejected; repeated instants use the earlier offset. A derived date must
 * remain within the persisted 0000–9999 year range. Completed, cancelled and inactive work is never overdue.
 * @param item - Stored calendar fields using the office date and minute-precision time formats.
 * @param timeZone - The persisted company timezone; the host's local timezone is not consulted.
 * @param now - The caller's observation instant in epoch milliseconds.
 * @returns Deadline and unfinished-overdue flag, or the meeting's start/end instants and phase.
 * @throws OfficeError with code `invalid_input` for invalid fields, timezone, a missing local instant or a next-day overflow.
 */
export function projectOfficeItemTime(item: CalendarItem, timeZone: string, now: number): OfficeItemTime {
  const date = parseDate(item.date)
  if (item.kind === 'schedule') {
    const start = parseTime(item.time, 'start time')
    const end = parseTime(item.endTime, 'end time')
    if (Temporal.PlainTime.compare(start, end) >= 0) {
      throw new OfficeError('invalid_input', 'The office meeting end time must be later than its start time on the same date.')
    }
    const startsAt = localInstant(date, start, timeZone, 'start time')
    const endsAt = localInstant(date, end, timeZone, 'end time')
    return { kind: 'schedule', startsAt, endsAt, phase: now < startsAt ? 'upcoming' : now < endsAt ? 'ongoing' : 'ended' }
  }

  let dueAt: number
  if (item.time === undefined) {
    const nextDate = date.add({ days: 1 })
    if (nextDate.year > 9999) {
      throw new OfficeError('invalid_input', 'The office item on 9999-12-31 requires an explicit time; its next-day deadline exceeds the office date range.')
    }
    dueAt = localInstant(nextDate, Temporal.PlainTime.from('00:00'), timeZone, 'next-day deadline')
  } else {
    dueAt = localInstant(date, parseTime(item.time, 'deadline'), timeZone, 'deadline')
  }
  const unfinished = item.status === 'pending' || item.status === 'in_progress'
  return { kind: 'work', dueAt, overdue: unfinished && item.lifecycle === undefined && now >= dueAt }
}
