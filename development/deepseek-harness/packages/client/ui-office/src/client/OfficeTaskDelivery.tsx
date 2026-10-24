/** Reasoned task delivery and review retain an explicit parent revision through concurrent edits. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeItem, OfficeTaskDeliveryInput, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

const labels = { submit: 'taskDeliverySubmit', accept: 'taskDeliveryAccept', return: 'taskDeliveryReturn' } as const
const historyLabels = { submit: 'taskDeliverySubmitted', accept: 'taskDeliveryAccepted', return: 'taskDeliveryReturned' } as const
type DeliveryProps = Pick<OfficeProps, 't' | 'useOffice' | 'reviewTaskDelivery'> & { view: OfficeView; item: OfficeItem }

/** Show immutable submission/review history and actions available to the current assignee or reviewer. */
export function OfficeTaskDelivery({ t, view, item, useOffice, reviewTaskDelivery }: DeliveryProps) {
  const busy = useOffice(state => state.busy)
  const [reviewed, setReviewed] = useState<{ item: OfficeItem; kind: OfficeTaskDeliveryInput['kind'] } | null>(null)
  const [reason, setReason] = useState('')
  const last = item.deliveries?.at(-1)
  const pending = last?.kind === 'submit' && last.revision === item.revision && last.ownerId === item.ownerId
  const closed = item.lifecycle !== undefined || item.status === 'completed' || item.status === 'cancelled'
  const owner = item.ownerId === view.me.id
  const reviewer = item.creatorId === view.me.id || view.me.role === 'admin'
  const canSubmit = !closed && owner && item.status === 'in_progress' && !pending
  const canReview = !closed && reviewer && item.status === 'in_progress' && pending
  const stale = reviewed !== null && reviewed.item.revision !== item.revision
  const permitted = reviewed?.kind === 'submit' ? canSubmit : canReview
  const open = (kind: OfficeTaskDeliveryInput['kind']) => { setReviewed({ item, kind }); setReason('') }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !reviewed || stale || closed || !permitted || !reason.trim()) return
    if (await reviewTaskDelivery(reviewed.item, { kind: reviewed.kind, reason })) setReviewed(null)
  }
  return <section aria-label={t('taskDeliveryTitle')}>
    <h2>{t('taskDeliveryTitle')}</h2>
    <p>{t('taskDeliveryScope')}</p>
    {pending && <p role="status">{t('taskDeliveryPending')}</p>}
    {last?.kind === 'submit' && !pending && !closed && <p>{t('taskDeliveryOutdated')}</p>}
    {owner && item.status === 'pending' && <p>{t('taskDeliveryStartHint')}</p>}
    <div className={css.row}>
      {owner && <Button disabled={busy || !canSubmit || reviewed !== null} onClick={() => { open('submit') }}>
        {t('taskDeliverySubmit')}
      </Button>}
      {reviewer && <>
        <Button disabled={busy || !canReview || reviewed !== null} onClick={() => { open('accept') }}>{t('taskDeliveryAccept')}</Button>
        <Button disabled={busy || !canReview || reviewed !== null} onClick={() => { open('return') }}>{t('taskDeliveryReturn')}</Button>
      </>}
    </div>
    {reviewed && <form className={css.form} aria-label={t(labels[reviewed.kind])} onSubmit={(event) => { void submit(event) }}>
      {stale && <div role="alert"><p>{t('workChanged')}</p><Button disabled={busy} onClick={() => {
        setReviewed({ ...reviewed, item })
      }}>{t('loadLatestWork')}</Button></div>}
      {closed && <p role="alert">{t('workClosed')}</p>}
      <label>{t('taskDeliveryReason')}<textarea aria-label={t('taskDeliveryReason')} value={reason} required maxLength={2000}
        onChange={(event) => { setReason(event.target.value) }} /></label>
      <div className={css.row}>
        <Button disabled={busy} onClick={() => { setReviewed(null) }}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || stale || closed || !permitted || !reason.trim()}>{t('save')}</Button>
      </div>
    </form>}
    <ol>{item.deliveries?.map(entry => <li key={entry.revision}>
      <p>{t(historyLabels[entry.kind])} · {view.members.find(member => member.id === entry.actorId)?.name ?? entry.actorId}
        {' · '}{new Intl.DateTimeFormat(undefined, { timeZone: view.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(entry.time)}</p>
      <p className={css.deliveryReason}>{entry.reason}</p>
    </li>)}</ol>
  </section>
}
