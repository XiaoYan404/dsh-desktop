/** Company-clock deadlines and meeting phases use real timezone transitions without timers or writes. */
import { describe, expect, it } from 'vitest'
import { OfficeError } from '../src/error.ts'
import { projectOfficeItemTime } from '../src/calendar-time.ts'
import { officeDate, officeTime } from '../src/spec.ts'

type CalendarItem = Parameters<typeof projectOfficeItemTime>[0]

function work(fields: Partial<CalendarItem> = {}): CalendarItem {
  return { kind: 'task', date: '2026-10-19', status: 'pending', ...fields }
}

function meeting(fields: Partial<CalendarItem> = {}): CalendarItem {
  return { kind: 'schedule', date: '2026-10-19', time: '10:00', endTime: '11:00', status: 'pending', ...fields }
}

function invalid(operation: () => unknown, diagnostic: string): void {
  expect(operation).toThrow(OfficeError)
  expect(operation).toThrow(expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining(diagnostic) }))
}

describe('work deadline projections', () => {
  it.each(['task', 'todo'] as const)('expires a timed %s at the company-zone instant, including the boundary', (kind) => {
    const item = work({ kind, time: '09:30' })
    const dueAt = Date.parse('2026-10-19T01:30:00Z')
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', dueAt - 1)).toEqual({ kind: 'work', dueAt, overdue: false })
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', dueAt)).toEqual({ kind: 'work', dueAt, overdue: true })
  })

  it('keeps an untimed work item open until the following company midnight', () => {
    const item = work()
    const dueAt = Date.parse('2026-10-19T16:00:00Z')
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', Date.parse('2026-10-19T00:01:00Z')))
      .toEqual({ kind: 'work', dueAt, overdue: false })
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', dueAt - 1)).toEqual({ kind: 'work', dueAt, overdue: false })
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', dueAt)).toEqual({ kind: 'work', dueAt, overdue: true })
    expect(item.date).toBe('2026-10-19')
  })

  it('projects the same stored date across opposite sides of company midnight', () => {
    const item = work()
    const now = Date.parse('2026-10-19T16:01:00Z')
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', now)).toEqual({ kind: 'work', dueAt: Date.parse('2026-10-19T16:00:00Z'), overdue: true })
    expect(projectOfficeItemTime(item, 'America/Los_Angeles', now)).toEqual({ kind: 'work', dueAt: Date.parse('2026-10-20T07:00:00Z'), overdue: false })
  })

  it.each([
    { date: '2026-03-08', end: '2026-03-09T04:00:00Z', start: '2026-03-08T05:00:00Z', hours: 23 },
    { date: '2026-11-01', end: '2026-11-02T05:00:00Z', start: '2026-11-01T04:00:00Z', hours: 25 },
  ])('expires untimed work after $date, lasting $hours elapsed hours', ({ date, end, start, hours }) => {
    const dueAt = Date.parse(end)
    expect(projectOfficeItemTime(work({ date }), 'America/New_York', dueAt - 1))
      .toEqual({ kind: 'work', dueAt, overdue: false })
    expect(dueAt - Date.parse(start)).toBe(hours * 60 * 60 * 1000)
  })

  it.each(['completed', 'cancelled'] as const)('never marks %s work as unfinished overdue', (status) => {
    expect(projectOfficeItemTime(work({ status }), 'UTC', Date.parse('2026-10-21T00:00:00Z')))
      .toEqual({ kind: 'work', dueAt: Date.parse('2026-10-20T00:00:00Z'), overdue: false })
  })

  it.each(['archived', 'deleted'] as const)('never marks %s work as unfinished overdue', (lifecycle) => {
    expect(projectOfficeItemTime(work({ status: 'in_progress', lifecycle }), 'UTC', Date.parse('2026-10-21T00:00:00Z')))
      .toEqual({ kind: 'work', dueAt: Date.parse('2026-10-20T00:00:00Z'), overdue: false })
  })
})

describe('local timezone transitions', () => {
  it('rejects an explicit local time in a spring-forward gap', () => {
    invalid(() => projectOfficeItemTime(work({ date: '2026-03-08', time: '02:30' }), 'America/New_York', 0), 'deadline does not exist')
  })

  it('uses the earlier offset of a repeated local deadline without moving it on a later read', () => {
    const item = Object.freeze(work({ date: '2026-11-01', time: '01:30' }))
    const dueAt = Date.parse('2026-11-01T05:30:00Z')
    expect(projectOfficeItemTime(item, 'America/New_York', dueAt - 1)).toEqual({ kind: 'work', dueAt, overdue: false })
    expect(projectOfficeItemTime(item, 'America/New_York', dueAt)).toEqual({ kind: 'work', dueAt, overdue: true })
    expect(projectOfficeItemTime(item, 'America/New_York', Date.parse('2026-11-01T06:00:00Z')))
      .toEqual({ kind: 'work', dueAt, overdue: true })
  })

  it('rejects an untimed deadline when the following company midnight does not exist', () => {
    invalid(() => projectOfficeItemTime(work({ date: '2018-11-03' }), 'America/Sao_Paulo', 0), 'next-day deadline does not exist')
  })

  it('handles a half-hour overlap and rejects a half-hour gap', () => {
    const dueAt = Date.parse('2026-04-04T14:45:00Z')
    expect(projectOfficeItemTime(work({ date: '2026-04-05', time: '01:45' }), 'Australia/Lord_Howe', dueAt))
      .toEqual({ kind: 'work', dueAt, overdue: true })
    invalid(() => projectOfficeItemTime(work({ date: '2026-10-04', time: '02:15' }), 'Australia/Lord_Howe', 0), 'deadline does not exist')
  })

  it('reports an unsupported company timezone as an office input failure', () => {
    invalid(() => projectOfficeItemTime(work(), 'Missing/Company', 0), 'office timezone')
  })
})

describe('meeting time projections', () => {
  it('changes only its projected phase at the start and end boundaries', () => {
    const item = Object.freeze(meeting({ status: 'in_progress' }))
    const original = { ...item }
    const startsAt = Date.parse('2026-10-19T02:00:00Z')
    const endsAt = Date.parse('2026-10-19T03:00:00Z')
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', startsAt - 1)).toEqual({ kind: 'schedule', startsAt, endsAt, phase: 'upcoming' })
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', startsAt)).toEqual({ kind: 'schedule', startsAt, endsAt, phase: 'ongoing' })
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', endsAt - 1)).toEqual({ kind: 'schedule', startsAt, endsAt, phase: 'ongoing' })
    expect(projectOfficeItemTime(item, 'Asia/Shanghai', endsAt)).toEqual({ kind: 'schedule', startsAt, endsAt, phase: 'ended' })
    expect(item).toEqual(original)
  })

  it('projects both endpoints through an overlap using the earlier offset', () => {
    expect(projectOfficeItemTime(meeting({ date: '2026-11-01', time: '01:15', endTime: '01:45' }), 'America/New_York', Date.parse('2026-11-01T05:30:00Z')))
      .toEqual({ kind: 'schedule', startsAt: Date.parse('2026-11-01T05:15:00Z'), endsAt: Date.parse('2026-11-01T05:45:00Z'), phase: 'ongoing' })
  })

  it('rejects either meeting endpoint in a local gap', () => {
    invalid(() => projectOfficeItemTime(meeting({ date: '2026-03-08', time: '02:15', endTime: '03:15' }), 'America/New_York', 0), 'start time does not exist')
    invalid(() => projectOfficeItemTime(meeting({ date: '2026-03-08', time: '01:15', endTime: '02:15' }), 'America/New_York', 0), 'end time does not exist')
  })

  it('retains the same-day meeting range and required endpoint rules', () => {
    invalid(() => projectOfficeItemTime(meeting({ time: undefined }), 'UTC', 0), 'start time must be')
    invalid(() => projectOfficeItemTime(meeting({ endTime: undefined }), 'UTC', 0), 'end time must be')
    invalid(() => projectOfficeItemTime(meeting({ endTime: '10:00' }), 'UTC', 0), 'same date')
    invalid(() => projectOfficeItemTime(meeting({ time: '23:00', endTime: '01:00' }), 'UTC', 0), 'same date')
  })

  it.each(['completed', 'cancelled'] as const)('keeps a %s meeting status separate from its elapsed phase', (status) => {
    const item = Object.freeze(meeting({ status }))
    const projected = projectOfficeItemTime(item, 'UTC', Date.parse('2026-10-21T00:00:00Z'))
    expect(projected).toMatchObject({ kind: 'schedule', phase: 'ended' })
    expect(projected).not.toHaveProperty('overdue')
    expect(item.status).toBe(status)
  })
})

describe('persisted office date and time formats', () => {
  it.each(['0000-02-29', '0099-12-31', '9999-12-31'])('preserves the accepted date %s with an explicit time', (date) => {
    expect(officeDate.safeParse(date).success).toBe(true)
    expect(projectOfficeItemTime(work({ date, time: '00:00' }), 'UTC', 0))
      .toEqual({ kind: 'work', dueAt: Date.parse(`${date}T00:00:00Z`), overdue: Date.parse(`${date}T00:00:00Z`) <= 0 })
  })

  it('keeps year zero when advancing an untimed leap day', () => {
    expect(projectOfficeItemTime(work({ date: '0000-02-29' }), 'UTC', 0))
      .toEqual({ kind: 'work', dueAt: Date.parse('0000-03-01T00:00:00Z'), overdue: true })
  })

  it('rejects a next-day deadline beyond year 9999 without truncation', () => {
    expect(officeDate.safeParse('9999-12-31').success).toBe(true)
    invalid(() => projectOfficeItemTime(work({ date: '9999-12-31' }), 'UTC', 0), 'next-day deadline exceeds')
  })

  it.each(['2026-02-29', '2026-2-01', '10000-01-01', '-000001-01-01'])('rejects %s with the existing date schema', (date) => {
    expect(officeDate.safeParse(date).success).toBe(false)
    invalid(() => projectOfficeItemTime(work({ date, time: '12:00' }), 'UTC', 0), 'existing YYYY-MM-DD')
  })

  it.each(['24:00', '09:30:00', '9:30'])('rejects %s with the existing time schema', (time) => {
    expect(officeTime.safeParse(time).success).toBe(false)
    invalid(() => projectOfficeItemTime(work({ time }), 'UTC', 0), 'HH:mm')
  })
})
