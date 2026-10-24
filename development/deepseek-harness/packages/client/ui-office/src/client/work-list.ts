/** Work-list projections consume only the Host-authorized employee snapshot. */
import type { OfficeItem, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'

/** Employee ownership views; all still means only the records authorized by the Host. */
export type OfficeWorkFilter = 'mine' | 'dispatched' | 'all'

/** One ordered local calendar day in the work list. */
export interface OfficeWorkGroup {
  readonly date: string
  readonly items: readonly OfficeItem[]
}

/** Counts describe each ownership view before the optional status filter. */
export interface OfficeWorkList {
  readonly counts: Readonly<Record<OfficeWorkFilter, number>>
  readonly total: number
  readonly groups: readonly OfficeWorkGroup[]
}

/**
 * Group human tasks and to-dos by date without modifying the confirmed snapshot.
 * @param items - Records already filtered by the Host's employee authorization.
 * @param meId - Current employee used for the ownership tabs.
 * @param filter - Selected ownership view.
 * @param status - One item status, or all.
 * @returns Stable date/time groups and unfiltered ownership counts.
 */
export function officeWorkList(
  items: readonly OfficeItem[],
  meId: OfficeMemberId,
  filter: OfficeWorkFilter,
  status: string,
): OfficeWorkList {
  const work = items.filter(item => item.kind !== 'schedule')
  const mine = (item: OfficeItem) => item.ownerId === meId
  const dispatched = (item: OfficeItem) => item.creatorId === meId
  const selected = work.filter(item =>
    (filter === 'all' || (filter === 'mine' ? mine(item) : dispatched(item))) &&
    (status === 'all' || item.status === status),
  ).sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.time ?? '99:99').localeCompare(b.time ?? '99:99') ||
    a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  )
  const groups = new Map<string, OfficeItem[]>()
  for (const item of selected) {
    const group = groups.get(item.date)
    if (group) group.push(item)
    else groups.set(item.date, [item])
  }
  return {
    counts: { mine: work.filter(mine).length, dispatched: work.filter(dispatched).length, all: work.length },
    total: selected.length,
    groups: [...groups].map(([date, entries]) => ({ date, items: entries })),
  }
}

/**
 * Move a local Gregorian day without timezone conversion or extended-year strings.
 * @param date - Four-digit ISO local date from the confirmed office view.
 * @param days - Integer day offset.
 * @returns Another four-digit date, or null for invalid input or an out-of-range year.
 */
export function shiftOfficeDate(date: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(days)) return null
  const value = new Date(`${date}T12:00:00Z`)
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) return null
  value.setUTCDate(value.getUTCDate() + days)
  if (!Number.isFinite(value.getTime()) || value.getUTCFullYear() < 0 || value.getUTCFullYear() > 9999) return null
  return value.toISOString().slice(0, 10)
}
