/** Advisory overlaps over the caller's already-authorized office projection. */
import type { OfficeItem, OfficeItemId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'

type ScheduleWindow = {
  date: string
  startTime: string
  endTime: string
  memberIds: readonly OfficeMemberId[]
  excludeId?: OfficeItemId
}

/**
 * Return live, visible meetings sharing an attending member and a nonempty time interval.
 * @param items - The current employee's already-authorized records.
 * @param window - Draft local date, time interval, selected members and optional edited event.
 * @returns Overlapping meetings with affected attendees, sorted by time and title; invalid draft intervals yield no advice.
 */
export function officeScheduleOverlaps(items: readonly OfficeItem[], window: ScheduleWindow):
readonly { readonly item: OfficeItem; readonly memberIds: readonly OfficeMemberId[] }[] {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  if (!time.test(window.startTime) || !time.test(window.endTime) || window.startTime >= window.endTime) return []
  const selected = new Set(window.memberIds)
  return items.flatMap((item) => {
    if (item.kind !== 'schedule' || item.id === window.excludeId || item.date !== window.date
      || item.status === 'completed' || item.status === 'cancelled' || !item.time || !item.endTime
      || window.startTime >= item.endTime || window.endTime <= item.time) return []
    const memberIds = item.participants.filter(participant => participant.reply !== 'declined' && selected.has(participant.memberId))
      .map(participant => participant.memberId)
    return memberIds.length ? [{ item, memberIds }] : []
  }).sort((a, b) => (a.item.time ?? '').localeCompare(b.item.time ?? '')
    || a.item.title.localeCompare(b.item.title) || a.item.id.localeCompare(b.item.id))
}
