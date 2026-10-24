// @vitest-environment jsdom
/** Server reminder occurrences join the inbox without manufacturing actors or bypassing read acknowledgement. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type {
  OfficeAnnouncementId, OfficeItem, OfficeItemId, OfficeMemberId, OfficeNotificationId,
  OfficeReminder, OfficeReminderId, OfficeView,
} from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeNotifications } from '../src/client/OfficeNotifications.tsx'
import { officeInbox } from '../src/client/inbox.ts'
import { en, zh } from '../src/client/locales.ts'
import type { OfficeKey } from '../src/client/locales.ts'

const me = { id: 'lin' as OfficeMemberId, name: 'Lin', role: 'employee' as const, active: true,
  department: 'Operations', jobTitle: 'Employee', email: '', phone: '' }
const work: OfficeItem = { id: '70000000-0000-4000-8000-000000000001' as OfficeItemId,
  kind: 'todo', title: 'Review the contract', description: '', date: '2026-10-19', time: '09:00',
  location: '', status: 'pending', creatorId: me.id, ownerId: me.id, participants: [],
  revision: 1, createdAt: 1, updatedAt: 1 }
const meeting: OfficeItem = { ...work, id: '70000000-0000-4000-8000-000000000002' as OfficeItemId,
  kind: 'schedule', title: 'Planning meeting', time: '10:00', endTime: '11:00',
  participants: [{ memberId: me.id, reply: 'accepted' }] }
const due: OfficeReminder = { id: '80000000-0000-4000-8000-000000000001' as OfficeReminderId,
  recipientId: me.id, itemId: work.id, kind: 'work_due', occursAt: 1_000, deliveredAt: 3_000,
  read: false, itemTitle: work.title }
const started: OfficeReminder = { ...due, id: '80000000-0000-4000-8000-000000000002' as OfficeReminderId,
  itemId: meeting.id, kind: 'meeting_start', occursAt: 2_000, deliveredAt: 4_000, read: true, itemTitle: meeting.title }
const base: OfficeView = { revision: 1, companyName: 'Company', timeZone: 'Asia/Shanghai', me, members: [me],
  items: [work, meeting], notifications: [], reminders: { protocol: 1, entries: [due, started] },
  day: { date: '2026-10-19', items: [], pending: 0, completed: 0, cancelled: 0, work: 0, schedules: 0, completionRate: 0 } }

function props(view = base, copy = en): ComponentProps<typeof OfficeNotifications> {
  return { view, t: (key: OfficeKey) => copy[key], useOffice: select => select({ view, busy: false, loading: false, error: null }),
    markRead: vi.fn(async () => true), markReminderRead: vi.fn(async () => true),
    markAnnouncementRead: vi.fn(async () => true), onClose: vi.fn(), onOpenItem: vi.fn(), onOpenAnnouncement: vi.fn() }
}

afterEach(cleanup)

it('orders actual deliveries with legacy notices, filters undelivered announcements and accepts an older projection', () => {
  const announcement = { id: '90000000-0000-4000-8000-000000000001' as OfficeAnnouncementId,
    revision: 1, title: 'Company news', body: '', publisherId: me.id, publisherName: me.name,
    publishedAt: 3_500, audience: 'company' as const, recipientCount: 1, recipient: true, read: false, withdrawn: false }
  const view: OfficeView = { ...base,
    notifications: [{ id: '60000000-0000-4000-8000-000000000001' as OfficeNotificationId,
      recipientId: me.id, actorId: me.id, itemId: work.id, kind: 'assigned', createdAt: 2_500, read: false }],
    announcements: { revision: 3, maxEntries: 10, rotationMs: 5_000, entries: [announcement,
      { ...announcement, id: '90000000-0000-4000-8000-000000000002' as OfficeAnnouncementId, withdrawn: true },
      { ...announcement, id: '90000000-0000-4000-8000-000000000003' as OfficeAnnouncementId, recipient: false }] } }
  const original = JSON.stringify(view)
  expect(officeInbox(view).map(entry => [entry.kind, entry.value.id, entry.time])).toEqual([
    ['reminder', started.id, 4_000], ['announcement', announcement.id, 3_500], ['reminder', due.id, 3_000],
    ['item', view.notifications[0]?.id, 2_500],
  ])
  expect(officeInbox({ ...view, reminders: { protocol: 1, entries: [due, { ...started, deliveredAt: due.deliveredAt }] } })
    .filter(entry => entry.kind === 'reminder').map(entry => entry.value.id)).toEqual([started.id, due.id])
  const { reminders: omitted, ...legacy } = view
  expect(omitted).toBeDefined()
  expect(officeInbox(legacy).map(entry => entry.kind)).toEqual(['announcement', 'item'])
  expect(JSON.stringify(view)).toBe(original)
})

it.each([['English', en], ['Chinese', zh]] as const)('shows localized reminders and waits for durable acknowledgement in %s', async (_language, copy) => {
  const pending = Promise.withResolvers<boolean>()
  const value = props(base, copy)
  const acknowledge = vi.fn(() => pending.promise)
  value.markReminderRead = acknowledge
  render(<OfficeNotifications {...value} />)
  const dialog = within(screen.getByRole('dialog', { name: copy.notifications }))
  expect(dialog.getByRole('button', { name: new RegExp(copy.workDueReminder) }).textContent).toContain(`${copy.workDueReminder} · ${copy.unread}`)
  expect(dialog.getByRole('button', { name: new RegExp(copy.meetingStartReminder) }).textContent).toContain(`${copy.meetingStartReminder} · ${copy.read}`)
  expect(dialog.queryByText(me.name)).toBeNull()
  expect(dialog.queryByText(me.id)).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: copy.notificationUnread }))
  expect(dialog.queryByText(meeting.title)).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: new RegExp(work.title) }))
  expect(acknowledge).toHaveBeenCalledWith(due.id)
  expect(value.onOpenItem).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(true); await pending.promise })
  expect(value.onOpenItem).toHaveBeenCalledExactlyOnceWith(work.id)
  expect(value.markRead).not.toHaveBeenCalled()
  expect(value.markAnnouncementRead).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: copy.notificationAll }))
  fireEvent.click(dialog.getByRole('button', { name: new RegExp(meeting.title) }))
  expect(value.onOpenItem).toHaveBeenLastCalledWith(meeting.id)
  expect(acknowledge).toHaveBeenCalledTimes(1)
})

it('keeps a failed read acknowledgement visible and lets the same occurrence be retried', async () => {
  const value = props()
  const acknowledge = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  value.markReminderRead = acknowledge
  render(<OfficeNotifications {...value} />)
  const row = screen.getByRole('button', { name: new RegExp(work.title) })
  await act(async () => { fireEvent.click(row) })
  expect(value.onOpenItem).not.toHaveBeenCalled()
  expect(row.textContent).toContain(en.unread)
  await act(async () => { fireEvent.click(row) })
  expect(acknowledge.mock.calls).toEqual([[due.id], [due.id]])
  expect(value.onOpenItem).toHaveBeenCalledExactlyOnceWith(work.id)
})

it('does not navigate to an item absent from the current authorized projection', async () => {
  const value = props({ ...base, items: [], reminders: { protocol: 1, entries: [due] } })
  const mounted = render(<OfficeNotifications {...value} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(work.title) })) })
  expect(value.markReminderRead).toHaveBeenCalledWith(due.id)
  expect(value.onOpenItem).not.toHaveBeenCalled()
  mounted.rerender(<OfficeNotifications {...props({ ...base, items: [], reminders: { protocol: 1, entries: [] } })} />)
  expect(screen.getByText(en.noNotifications)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.notificationUnread }))
  expect(screen.getByText(en.noUnreadNotifications)).toBeTruthy()
})
