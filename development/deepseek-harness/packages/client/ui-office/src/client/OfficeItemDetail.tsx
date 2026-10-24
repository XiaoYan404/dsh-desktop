/** Item status and personal participation use separate Host-authorized operations. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeCalendarItemTime, OfficeItem, OfficeItemStatus, OfficeMemberId, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import { officeItemStatuses } from './item-status.ts'
import css from './OfficePage.module.css'
import { OfficeTaskActions } from './OfficeTaskActions.tsx'
import { OfficeTaskDelivery } from './OfficeTaskDelivery.tsx'
import { OfficeWorkAttachments } from './OfficeWorkAttachments.tsx'
import { OfficeWorkLifecycle } from './OfficeWorkLifecycle.tsx'
import { priorityKeys } from './item-priority.ts'
import { OfficeItemTimeBadge } from './OfficeItemTimeBadge.tsx'

type DetailProps = OfficeProps & {
  view: OfficeView
  item: OfficeItem
  time: OfficeCalendarItemTime | undefined
  onClose(this: void): void
  onEditSchedule(this: void, item: OfficeItem): void
  onEditWork(this: void, item: OfficeItem): void
  onEditSubtasks(this: void, item: OfficeItem): void
  onEditAttachments(this: void, item: OfficeItem): void
}

/** Render one confirmed record and this employee's invitation, when present. */
export function OfficeItemDetail(props: DetailProps) {
  const { t, view, item, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const preparing = props.useAssistance(state => state.openingId !== null)
  const name = (id: OfficeMemberId) => view.members.find(member => member.id === id)?.name ?? id
  const inactive = item.lifecycle !== undefined
  const canEdit = !inactive && (
    view.me.role === 'admin' ||
    item.creatorId === view.me.id ||
    (item.kind !== 'schedule' && item.ownerId === view.me.id))
  const invitation =
    item.creatorId !== view.me.id && item.participants.find(participant => participant.memberId === view.me.id)
  const closed = item.status === 'cancelled' || item.status === 'completed'
  return (
    <Modal open title={t('detail')} closeLabel={t('close')} onClose={onClose}
      className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}>
      <div className={css.form}>
        <h2>{item.title}</h2>
        <p>{item.description}</p>
        {inactive && <p role="status">{t(item.lifecycle === 'archived' ? 'archivedWork' : 'deletedWork')}</p>}
        {item.kind !== 'schedule' && view.inactiveWork !== undefined && <OfficeWorkLifecycle
          key={`${view.me.id}:${view.me.role}:${item.id}`} {...props} view={view} item={item} onClose={onClose} />}
        <dl>
          <dt>{t('itemSource')}</dt>
          <dd>{t('internalItem')} · {item.id}</dd>
          <dt>{t('creator')}</dt>
          <dd>{name(item.creatorId)}</dd>
          <dt>{t('owner')}</dt>
          <dd>{name(item.ownerId)}</dd>
          {item.kind !== 'schedule' && <>
            <dt>{t('priority')}</dt><dd>{t(priorityKeys[item.priority ?? 'normal'])}</dd>
          </>}
          <dt>{t('date')}</dt>
          <dd>
            {item.date} {item.time} {item.endTime}
          </dd>
          {props.time && <>
            <dt>{t('companyTimeStatus')}</dt>
            <dd>{view.timeZone} <OfficeItemTimeBadge t={t} time={props.time} /></dd>
          </>}
          <dt>{t('location')}</dt>
          <dd>{item.location}</dd>
          {(item.kind === 'schedule' || !view.workAttachmentLimits) && <>
            <dt>{t('itemMaterials')}</dt><dd>{t('noItemMaterials')}</dd>
          </>}
        </dl>
        {item.kind !== 'schedule' && view.workAttachmentLimits && <OfficeWorkAttachments
          key={`${view.me.id}:${view.me.role}:${view.revision}:${item.id}`} {...props} item={item} />}
        <label>
          {t('status')}
          <select
            aria-label={t('status')}
            value={item.status}
            disabled={busy || !canEdit}
            onChange={(event) => {
              void props.setStatus(item, event.target.value as OfficeItemStatus)
            }}
          >
            {officeItemStatuses.map(value => (
              <option key={value} value={value}
                disabled={value === 'completed' && item.kind === 'task' && (item.deliveries?.length ?? 0) > 0}>
                {t(value)}
              </option>
            ))}
          </select>
        </label>
        {item.kind !== 'schedule' && <OfficeTaskActions {...props} view={view} item={item} />}
        {item.kind === 'task' && <OfficeTaskDelivery {...props} view={view} item={item} />}
        {(item.subtasks?.length ?? 0) > 0 && <section aria-label={t('subtasks')}>
          <h2>{t('subtasks')}</h2>
          <p>{t('subtaskProgress')} · {item.subtasks?.filter(entry => entry.completed).length}/{item.subtasks?.length}</p>
          <ul>{item.subtasks?.map(entry => <li key={entry.id}>
            {entry.title} · {t(entry.completed ? 'completed' : 'pending')}
          </li>)}</ul>
        </section>}
        {invitation && (
          <section aria-label={t('yourInvitation')}>
            <h2>{t('yourInvitation')}</h2>
            <p>{t(invitation.reply === 'pending' ? 'invitationPending' : invitation.reply)}</p>
            {closed ? (
              <p>{t('invitationClosed')}</p>
            ) : (
              <div className={css.row}>
                <Button
                  disabled={busy || invitation.reply === 'accepted'}
                  onClick={() => {
                    void props.reply(item, 'accepted')
                  }}
                >
                  {t('acceptInvitation')}
                </Button>
                <Button
                  disabled={busy || invitation.reply === 'declined'}
                  onClick={() => {
                    void props.reply(item, 'declined')
                  }}
                >
                  {t('declineInvitation')}
                </Button>
              </div>
            )}
          </section>
        )}
        {item.participants.length > 0 && (
          <section>
            <h2>{t('participants')}</h2>
            {item.participants.map(participant => (
              <p key={participant.memberId}>
                {name(participant.memberId)} ·{' '}
                {t(participant.reply === 'pending' ? 'invitationPending' : participant.reply)}
              </p>
            ))}
          </section>
        )}
        {item.kind === 'schedule' && canEdit && (
          <Button disabled={busy || closed} onClick={() => { props.onEditSchedule(item) }}>{t('editSchedule')}</Button>
        )}
        {item.kind !== 'schedule' && canEdit && (
          <Button disabled={busy || closed} onClick={() => { props.onEditWork(item) }}>{t('editWork')}</Button>
        )}
        {item.kind !== 'schedule' && canEdit && (
          <Button disabled={busy || closed} onClick={() => { props.onEditSubtasks(item) }}>{t('manageSubtasks')}</Button>
        )}
        {item.kind !== 'schedule' && canEdit && view.workAttachmentLimits && (
          <Button disabled={busy || closed} onClick={() => { props.onEditAttachments(item) }}>{t('manageWorkAttachments')}</Button>
        )}
        <Button
          disabled={preparing || inactive}
          onClick={() => {
            void props.assistItem(item)
          }}
        >
          {t('assist')}
        </Button>
        {preparing && <Button onClick={props.cancelAssistance}>{t('cancel')}</Button>}
      </div>
    </Modal>
  )
}
