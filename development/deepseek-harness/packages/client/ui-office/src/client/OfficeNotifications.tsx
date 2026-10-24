/** Recipient-owned inbox; notification copy is derived only from the authorized view. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import type { OfficeAnnouncementId, OfficeItemId, OfficeNotification, OfficeReminder, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import css from './OfficePage.module.css'
import { officeInbox } from './inbox.ts'
import type { OfficeInboxEntry } from './inbox.ts'

const kindKeys: Record<OfficeNotification['kind'], OfficeKey> = {
  assigned: 'assignedNotice',
  invited: 'invitedNotice',
  invitation_reply: 'replyNotice',
  schedule_updated: 'scheduleUpdatedNotice',
  schedule_removed: 'scheduleRemovedNotice',
  task_accepted: 'taskAcceptedNotice',
  task_rejected: 'taskRejectedNotice',
  task_transferred: 'taskTransferredNotice',
  work_updated: 'workUpdatedNotice',
  work_subtasks_updated: 'workSubtasksUpdatedNotice',
  work_attachments_updated: 'workAttachmentsUpdatedNotice',
  work_archived: 'workArchivedNotice',
  work_deleted: 'workDeletedNotice',
  work_restored: 'workRestoredNotice',
  delivery_submitted: 'taskDeliverySubmittedNotice',
  delivery_accepted: 'taskDeliveryAcceptedNotice',
  delivery_returned: 'taskDeliveryReturnedNotice',
  todo_reassigned: 'todoReassignedNotice',
  work_prioritized: 'workPrioritizedNotice',
  status_changed: 'statusNotice',
}
const reminderKindKeys: Record<OfficeReminder['kind'], OfficeKey> = {
  work_due: 'workDueReminder',
  meeting_start: 'meetingStartReminder',
}
type NotificationProps = Pick<OfficeProps, 't' | 'markRead' | 'markReminderRead' | 'markAnnouncementRead' | 'useOffice'> & {
  view: OfficeView
  onClose(this: void): void
  onOpenCollaboration?(this: void): void
  onOpenItem(this: void, id: OfficeItemId): void
  onOpenAnnouncement(this: void, id: OfficeAnnouncementId): void
}

/** Open a recipient's inbox without exposing records outside the authorized projection. */
export function OfficeNotifications(
  { t, view, markRead, markReminderRead, markAnnouncementRead, useOffice, onClose, onOpenItem, onOpenAnnouncement, onOpenCollaboration }: NotificationProps,
) {
  const busy = useOffice(state => state.busy)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: view.timeZone,
  })
  const entries = officeInbox(view).filter(entry => !unreadOnly || !entry.value.read)
  const open = async (entry: OfficeInboxEntry) => {
    if (entry.kind === 'announcement') {
      if (!entry.value.read && !(await markAnnouncementRead(entry.value.id))) return
      onOpenAnnouncement(entry.value.id)
      return
    }
    if (!entry.value.read) {
      const acknowledged = entry.kind === 'reminder'
        ? await markReminderRead(entry.value.id) : await markRead(entry.value.id)
      if (!acknowledged) return
    }
    if ([...view.items, ...(view.inactiveWork ?? [])].some(item => item.id === entry.value.itemId)) onOpenItem(entry.value.itemId)
  }
  return (
    <Modal open title={t('notifications')} closeLabel={t('close')} onClose={onClose}>
      <div className={css.row}>
        {onOpenCollaboration && <Button onClick={onOpenCollaboration}>{t('collaborationTitle')}</Button>}
        <Button aria-pressed={!unreadOnly} onClick={() => { setUnreadOnly(false) }}>{t('notificationAll')}</Button>
        <Button aria-pressed={unreadOnly} onClick={() => { setUnreadOnly(true) }}>{t('notificationUnread')}</Button>
      </div>
      <div className={css.notifications}>
        {entries.length === 0 ? (
          <p className={css.empty}>{t(unreadOnly ? 'noUnreadNotifications' : 'noNotifications')}</p>
        ) : (
          entries.map((entry) => {
            const value = entry.value
            const item = entry.kind === 'item'
              ? [...view.items, ...(view.inactiveWork ?? [])].find(item => item.id === entry.value.itemId) : undefined
            const title = entry.kind === 'announcement' ? entry.value.title
              : entry.kind === 'reminder' ? entry.value.itemTitle : item?.title ?? entry.value.itemTitle ?? t('not_found')
            const actor = entry.kind === 'item' ? view.members.find(member => member.id === entry.value.actorId)?.name ?? entry.value.actorId
              : entry.kind === 'announcement' ? entry.value.publisherName : null
            const notice = entry.kind === 'reminder' ? reminderKindKeys[entry.value.kind]
              : entry.kind === 'announcement' ? 'announcementNotice' : kindKeys[entry.value.kind]
            return (
              <Button
                key={`${entry.kind}:${value.id}`}
                variant="ghost"
                className={css.notification}
                disabled={busy}
                onClick={() => {
                  void open(entry)
                }}
              >
                <span>{title}</span>
                <span className={css.notificationMeta}>
                  {actor !== null && <>{actor} · </>}{t(notice)} · {t(value.read ? 'read' : 'unread')}
                </span>
                <time className={css.notificationMeta} dateTime={new Date(entry.time).toISOString()}>
                  {formatter.format(entry.time)}
                </time>
              </Button>
            )
          })
        )}
      </div>
    </Modal>
  )
}
