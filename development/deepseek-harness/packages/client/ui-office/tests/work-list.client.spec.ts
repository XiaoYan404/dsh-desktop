/** Date boundaries and ownership/status projections over an authorized snapshot. */
import { describe, expect, it } from 'vitest'
import type { OfficeItem, OfficeItemId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeWorkList, shiftOfficeDate } from '../src/client/work-list.ts'

const me = 'local' as OfficeMemberId
const peer = 'peer' as OfficeMemberId
function item(id: string, patch: Partial<OfficeItem> = {}): OfficeItem {
  return {
    id: id as OfficeItemId, kind: 'todo', title: id, description: '', date: '2026-10-16',
    creatorId: me, ownerId: me, status: 'pending', location: '', participants: [],
    revision: 1, createdAt: 1, updatedAt: 1, ...patch,
  }
}

describe('office work groups', () => {
  it('keeps separate ownership counts, omits meetings and preserves closed work', () => {
    const records = [
      item('incoming', { creatorId: peer }), item('outgoing', { ownerId: peer }),
      item('done', { status: 'completed' }), item('cancelled', { status: 'cancelled' }),
      item('meeting', { kind: 'schedule', time: '09:00', endTime: '10:00' }),
    ]
    const all = officeWorkList(records, me, 'all', 'all')
    expect(all.counts).toEqual({ mine: 3, dispatched: 3, all: 4 })
    expect(all.total).toBe(4)
    expect(officeWorkList(records, me, 'mine', 'pending').groups[0]?.items.map(entry => entry.id)).toEqual(['incoming'])
    expect(officeWorkList(records, me, 'dispatched', 'pending').groups[0]?.items.map(entry => entry.id)).toEqual(['outgoing'])
    expect(officeWorkList(records, me, 'all', 'completed').counts).toEqual(all.counts)
    expect(officeWorkList(records, me, 'all', 'cancelled').total).toBe(1)
  })

  it('orders dates then times then creation and identity without mutating source order', () => {
    const records = [
      item('untimed'), item('late', { time: '15:00' }), item('b', { time: '09:00', createdAt: 2 }),
      item('a', { time: '09:00', createdAt: 2 }), item('earlier', { time: '09:00' }),
      item('yesterday', { date: '2026-10-15' }),
    ]
    const original = [...records]
    expect(officeWorkList(records, me, 'all', 'all').groups.map(group => [group.date, group.items.map(entry => entry.id)])).toEqual([
      ['2026-10-15', ['yesterday']], ['2026-10-16', ['earlier', 'a', 'b', 'late', 'untimed']],
    ])
    expect(records).toEqual(original)
    expect(officeWorkList(records, me, 'all', 'in_progress')).toEqual({ counts: { mine: 6, dispatched: 6, all: 6 }, total: 0, groups: [] })
  })
})

describe('office local date navigation', () => {
  it.each([
    ['2028-02-28', 1, '2028-02-29'], ['2028-02-29', 1, '2028-03-01'],
    ['2026-03-01', -1, '2026-02-28'], ['2026-12-31', 1, '2027-01-01'],
    ['0000-01-01', -1, null], ['9999-12-31', 1, null],
    ['0001-01-01', -1, '0000-12-31'], ['0099-12-31', 1, '0100-01-01'],
    ['2026-02-30', 1, null], ['2026-13-01', 0, null], ['invalid', 1, null],
    ['2026-10-16', 0.5, null], ['2026-10-16', Number.MAX_SAFE_INTEGER, null],
  ] as const)('moves %s by %s days to %s', (date, offset, expected) => {
    expect(shiftOfficeDate(date, offset)).toBe(expected)
  })
})
