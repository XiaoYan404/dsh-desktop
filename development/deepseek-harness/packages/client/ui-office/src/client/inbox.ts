/** One employee's notifications, reminders and announcement receipts share an ordered inbox. */
import type { OfficeAnnouncement, OfficeNotification, OfficeReminder, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'

/** Local presentation union; the original item-notification persistence shape is unchanged. */
export type OfficeInboxEntry =
  | { readonly kind: 'item'; readonly value: OfficeNotification; readonly time: number }
  | { readonly kind: 'announcement'; readonly value: OfficeAnnouncement; readonly time: number }
  | { readonly kind: 'reminder'; readonly value: OfficeReminder; readonly time: number }

/**
 * Merge only authorized deliveries and recipient-owned item notifications and reminders.
 * @param view - Confirmed employee-authorized projection.
 * @returns Newest entries first with stable identity ordering for equal timestamps.
 */
export function officeInbox(view: OfficeView): readonly OfficeInboxEntry[] {
  const items: OfficeInboxEntry[] = view.notifications.map(value => ({ kind: 'item', value, time: value.createdAt }))
  const announcements: OfficeInboxEntry[] = (view.announcements?.entries ?? []).filter(value => value.recipient && !value.withdrawn)
    .map(value => ({ kind: 'announcement', value, time: value.publishedAt }))
  const reminders: OfficeInboxEntry[] = (view.reminders?.entries ?? []).map(value => ({ kind: 'reminder', value, time: value.deliveredAt }))
  return [...items, ...announcements, ...reminders].sort((a, b) => b.time - a.time || b.value.id.localeCompare(a.value.id))
}
