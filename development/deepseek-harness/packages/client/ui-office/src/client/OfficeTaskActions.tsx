/** Task decisions and to-do transfers retain the reviewed work separately from its editable reason. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeItem, OfficeMemberId, OfficeTaskDecisionInput, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

type TaskProps = Pick<OfficeProps, 't' | 'useOffice' | 'decideTask'> & { view: OfficeView; item: OfficeItem }

/** Offer explicit decisions and durable history without replacing the ordinary status control. */
export function OfficeTaskActions({ t, view, item, useOffice, decideTask }: TaskProps) {
  const busy = useOffice(state => state.busy)
  const task = item.kind === 'task'
  const history = task ? item.taskActions : item.todoAssignments
  const [reviewed, setReviewed] = useState<OfficeItem | null>(null)
  const [kind, setKind] = useState<'reject' | 'transfer'>('reject')
  const [reason, setReason] = useState('')
  const [ownerId, setOwnerId] = useState<OfficeMemberId | ''>('')
  const closed = item.lifecycle !== undefined || item.status === 'completed' || item.status === 'cancelled'
  const isOwner = item.ownerId === view.me.id
  const canTransfer = isOwner || item.creatorId === view.me.id || view.me.role === 'admin'
  const stale = reviewed !== null && reviewed.revision !== item.revision
  const permitted = !closed && (kind === 'transfer' ? canTransfer : task && isOwner && item.status === 'pending')
  const target = view.members.find(member => member.id === ownerId && member.id !== item.ownerId)
  const name = (id: OfficeMemberId) => view.members.find(member => member.id === id)?.name ?? id
  const open = (action: 'reject' | 'transfer') => {
    setReviewed(item); setKind(action); setReason(''); setOwnerId('')
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !reviewed || stale || !permitted || !reason.trim() || (kind === 'transfer' && !target)) return
    const input: OfficeTaskDecisionInput = kind === 'transfer' && target
      ? { kind, ownerId: target.id, reason } : { kind: 'reject', reason }
    if (await decideTask(reviewed, input)) setReviewed(null)
  }
  return <section aria-label={t(task ? 'taskHistory' : 'todoAssignmentHistory')}>
    <div className={css.row}>
      {task && isOwner && <>
        <Button disabled={busy || closed || item.status !== 'pending' || reviewed !== null}
          onClick={() => { void decideTask(item, { kind: 'accept' }) }}>{t('acceptTask')}</Button>
        <Button disabled={busy || closed || item.status !== 'pending' || reviewed !== null}
          onClick={() => { open('reject') }}>{t('rejectTask')}</Button>
      </>}
      {canTransfer && <Button disabled={busy || closed || reviewed !== null}
        onClick={() => { open('transfer') }}>{t(task ? 'transferTask' : 'reassignTodo')}</Button>}
    </div>
    {reviewed && <form className={css.form} onSubmit={(event) => { void submit(event) }}>
      <h2>{t(task ? kind === 'reject' ? 'rejectTask' : 'transferTask' : 'reassignTodo')}</h2>
      {stale && <div role="alert"><p>{t(task ? 'taskChanged' : 'todoChanged')}</p><Button disabled={busy} onClick={() => {
        setReviewed(item); setOwnerId(''); setReason('')
      }}>{t(task ? 'loadLatestTask' : 'loadLatestTodo')}</Button></div>}
      {kind === 'transfer' && <label>{t('taskNewOwner')}<select aria-label={t('taskNewOwner')} value={ownerId} disabled={busy} required
        onChange={(event) => { setOwnerId(event.target.value as OfficeMemberId | '') }}>
        <option value="">{t('taskSelectOwner')}</option>
        {view.members.filter(member => member.id !== item.ownerId).map(member => (
          <option key={member.id} value={member.id}>{member.name}</option>
        ))}
      </select></label>}
      <label>{t('taskReason')}<textarea aria-label={t('taskReason')} value={reason} maxLength={2000} required disabled={busy}
        onChange={(event) => { setReason(event.target.value) }} /></label>
      <p>{t(task ? 'taskReasonRequired' : 'todoReasonRequired')}</p>
      <div className={css.row}>
        <Button disabled={busy} onClick={() => { setReviewed(null) }}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || stale || !permitted || !reason.trim() || (kind === 'transfer' && !target)}>{t('save')}</Button>
      </div>
    </form>}
    {(history?.length ?? 0) > 0 && <>
      <h2>{t(task ? 'taskHistory' : 'todoAssignmentHistory')}</h2>
      <ol>{history?.map(action => <li key={action.revision}>
        <p>{name(action.actorId)} · {t(!task ? 'todoReassignedNotice' : action.kind === 'accept'
          ? 'taskAcceptedNotice' : action.kind === 'reject' ? 'taskRejectedNotice' : 'taskTransferredNotice')}</p>
        {action.kind === 'transfer' && <p>{name(action.fromOwnerId)} → {name(action.toOwnerId)}</p>}
        {action.reason && <p>{action.reason}</p>}
        <time dateTime={new Date(action.time).toISOString()}>{new Intl.DateTimeFormat(undefined,
          { dateStyle: 'short', timeStyle: 'short', timeZone: view.timeZone }).format(action.time)}</time>
      </li>)}</ol>
    </>}
  </section>
}
