/** Calendar advice uses authorized records, local intervals and actual attendance. */
import { describe, expect, it } from 'vitest'
import type { OfficeItem, OfficeItemId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeScheduleOverlaps } from '../src/client/schedule-overlaps.ts'

const me = 'local' as OfficeMemberId
const peer = 'peer' as OfficeMemberId
const other = 'other' as OfficeMemberId
const date = '2026-10-20'
const window = { date, startTime: '10:00', endTime: '11:00', memberIds: [me] }
function meeting(id: string, fields: Partial<OfficeItem> = {}): OfficeItem {
  return { id: id as OfficeItemId, kind: 'schedule', title: id, description: '', date, time: '10:00', endTime: '11:00',
    creatorId: me, ownerId: me, status: 'pending', location: '', revision: 1, createdAt: 1, updatedAt: 1,
    participants: [{ memberId: me, reply: 'accepted' }, { memberId: peer, reply: 'pending' }], ...fields }
}

describe('visible meeting overlaps', () => {
  it('finds equal, enclosing and partial intervals while preserving source records', () => {
    const records = [meeting('partial', { time: '10:30', endTime: '12:00' }),
      meeting('same'), meeting('enclosing', { time: '09:00', endTime: '12:00' }),
      meeting('inside', { time: '10:15', endTime: '10:45' })]
    const original = structuredClone(records)
    expect(officeScheduleOverlaps(records, window).map(entry => entry.item.id)).toEqual(['enclosing', 'same', 'inside', 'partial'])
    expect(records).toEqual(original)
  })

  it('excludes adjacent, different-day, closed, ordinary and currently edited records', () => {
    const records = [meeting('before', { time: '09:00', endTime: '10:00' }),
      meeting('after', { time: '11:00', endTime: '12:00' }), meeting('tomorrow', { date: '2026-10-21' }),
      meeting('cancelled', { status: 'cancelled' }), meeting('completed', { status: 'completed' }),
      meeting('todo', { kind: 'todo' }), meeting('task', { kind: 'task' }), meeting('editing')]
    expect(officeScheduleOverlaps(records, { ...window, excludeId: records.at(-1)!.id })).toEqual([])
  })

  it('checks selected attending members and excludes their declined invitations', () => {
    const records = [meeting('declined', { participants: [{ memberId: me, reply: 'declined' }, { memberId: peer, reply: 'accepted' }] }),
      meeting('accepted'), meeting('pending', { status: 'in_progress', participants: [{ memberId: other, reply: 'pending' }] })]
    expect(officeScheduleOverlaps(records, window).map(entry => [entry.item.id, entry.memberIds])).toEqual([['accepted', [me]]])
    expect(officeScheduleOverlaps(records, { ...window, memberIds: [peer, peer] }).map(entry => [entry.item.id, entry.memberIds]))
      .toEqual([['accepted', [peer]], ['declined', [peer]]])
    expect(officeScheduleOverlaps(records, { ...window, memberIds: [other] }).map(entry => entry.item.id)).toEqual(['pending'])
    expect(officeScheduleOverlaps(records, { ...window, memberIds: [] })).toEqual([])
  })

  it.each([['', '11:00'], ['1:00', '11:00'], ['24:00', '25:00'], ['10:60', '11:00'],
    ['11:00', '11:00'], ['12:00', '11:00']])('withholds advice for an incomplete or invalid draft interval %s to %s', (startTime, endTime) => {
    expect(officeScheduleOverlaps([meeting('visible')], { ...window, startTime, endTime })).toEqual([])
  })

  it('recalculates after changing dates, times and the supplied authorized view', () => {
    const visible = meeting('visible')
    expect(officeScheduleOverlaps([], window)).toEqual([])
    expect(officeScheduleOverlaps([visible], { ...window, date: '2026-10-21' })).toEqual([])
    expect(officeScheduleOverlaps([visible], { ...window, startTime: '11:00', endTime: '12:00' })).toEqual([])
    expect(officeScheduleOverlaps([visible], window)).toEqual([{ item: visible, memberIds: [me] }])
  })
})
