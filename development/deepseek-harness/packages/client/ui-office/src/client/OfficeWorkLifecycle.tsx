/** Confirmed work archive, recycle-bin deletion and restoration retain reviewed revisions and explanations. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeItem, OfficeView, OfficeWorkLifecycleInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

const labels = { archive: 'archiveWork', delete: 'deleteWork', restore: 'restoreWork' } as const
const historyLabels = { archive: 'workArchivedNotice', delete: 'workDeletedNotice', restore: 'workRestoredNotice' } as const
type LifecycleProps = Pick<OfficeProps, 't' | 'useOffice' | 'changeWorkLifecycle'> & {
  view: OfficeView
  item: OfficeItem
  onClose(this: void): void
}

/** Only the creator or administrator may confirm actions; other participants retain read-only history. */
export function OfficeWorkLifecycle({ t, useOffice, changeWorkLifecycle, view, item, onClose }: LifecycleProps) {
  const busy = useOffice(state => state.busy)
  const [reviewed, setReviewed] = useState<{ item: OfficeItem; kind: OfficeWorkLifecycleInput['kind'] } | null>(null)
  const [reason, setReason] = useState('')
  const allowed = item.creatorId === view.me.id || view.me.role === 'admin'
  const stale = reviewed !== null && reviewed.item.revision !== item.revision
  const permitted = allowed && (reviewed?.kind === 'archive' ? item.lifecycle === undefined
    : reviewed?.kind === 'restore' ? item.lifecycle !== undefined : item.lifecycle !== 'deleted')
  const open = (kind: OfficeWorkLifecycleInput['kind']) => { setReviewed({ item, kind }); setReason('') }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !permitted || !reviewed || stale || !reason.trim()) return
    if (await changeWorkLifecycle(reviewed.item, { kind: reviewed.kind, reason })) onClose()
  }
  return <section aria-label={t('workLifecycleTitle')}>
    <h2>{t('workLifecycleTitle')}</h2><p>{t('workLifecycleScope')}</p>
    {allowed && <div className={css.row}>
      {item.lifecycle === undefined ? <Button disabled={busy || reviewed !== null}
        onClick={() => { open('archive') }}>{t('archiveWork')}</Button> : <Button disabled={busy || reviewed !== null}
        onClick={() => { open('restore') }}>{t('restoreWork')}</Button>}
      {item.lifecycle !== 'deleted' && <Button disabled={busy || reviewed !== null}
        onClick={() => { open('delete') }}>{t('deleteWork')}</Button>}
    </div>}
    {reviewed && <form className={css.form} aria-label={t(labels[reviewed.kind])}
      onSubmit={(event) => { void submit(event) }}>
      <p>{t('workLifecycleConfirm')}</p>
      {stale && <div role="alert"><p>{t('workChanged')}</p><Button disabled={busy}
        onClick={() => { setReviewed({ ...reviewed, item }) }}>{t('loadLatestWork')}</Button></div>}
      <label>{t('workLifecycleReason')}<textarea aria-label={t('workLifecycleReason')} required maxLength={2000}
        value={reason} onChange={(event) => { setReason(event.target.value) }} /></label>
      <div className={css.row}><Button disabled={busy} onClick={() => { setReviewed(null) }}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || !permitted || stale || !reason.trim()}>
          {t('confirmWorkAction')}
        </Button></div>
    </form>}
    <ol>{item.lifecycleActions?.map(entry => <li key={entry.revision}>
      <p>{t(historyLabels[entry.kind])} · {view.members.find(member => member.id === entry.actorId)?.name ?? entry.actorId}
        {' · '}{new Intl.DateTimeFormat(undefined, { timeZone: view.timeZone, dateStyle: 'short', timeStyle: 'short' }).format(entry.time)}</p>
      <p className={css.deliveryReason}>{entry.reason}</p>
    </li>)}</ol>
  </section>
}
