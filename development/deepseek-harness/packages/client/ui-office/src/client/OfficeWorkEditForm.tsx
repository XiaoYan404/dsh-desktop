/** Task and to-do editing retains the reviewed version until an explicit latest-record action. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeItem, OfficeView, OfficeWorkPriority, OfficeWorkUpdateInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'
import { officeWorkPriorities, priorityKeys } from './item-priority.ts'

type EditProps = OfficeProps & { view: OfficeView; item: OfficeItem; onClose(this: void): void }
function fields(item: OfficeItem): OfficeWorkUpdateInput {
  return { title: item.title, description: item.description, date: item.date,
    priority: item.priority ?? 'normal', ...(item.time ? { time: item.time } : {}) }
}

/** Preserve unsaved content when a task decision or another edit supersedes the reviewed record. */
export function OfficeWorkEditForm(props: EditProps) {
  const { t, view, item, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const [original, setOriginal] = useState(item)
  const [draft, setDraft] = useState<OfficeWorkUpdateInput>(() => fields(item))
  const latest = view.items.find(entry => entry.id === original.id)
  const stale = !latest || latest.revision !== original.revision
  const closed = latest?.status === 'completed' || latest?.status === 'cancelled'
  const allowed = view.me.role === 'admin' || original.creatorId === view.me.id || latest?.ownerId === view.me.id
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || stale || closed || !allowed || !draft.title.trim()) return
    if (await props.updateWork(original, draft)) { props.load(draft.date); onClose() }
  }
  return <Modal open title={t('editWork')} closeLabel={t('close')}
    className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''} onClose={() => { if (!busy) onClose() }}>
    <form className={css.form} onSubmit={(event) => { void submit(event) }}>
      {stale && <div role="alert"><p>{t('workChanged')}</p><Button disabled={busy || !latest} onClick={() => {
        if (latest) { setOriginal(latest); setDraft(fields(latest)) }
      }}>{t('loadLatestWork')}</Button></div>}
      {closed && <p role="alert">{t('workClosed')}</p>}
      <label>{t('title')}<Input value={draft.title} required maxLength={200} data-modal-autofocus
        onChange={(event) => { setDraft({ ...draft, title: event.target.value }) }} /></label>
      <label>{t('date')}<Input type="date" value={draft.date} required
        onChange={(event) => { setDraft({ ...draft, date: event.target.value }) }} /></label>
      <label>{t('time')}<Input type="time" value={draft.time ?? ''}
        onChange={(event) => { setDraft({ ...draft, time: event.target.value || undefined }) }} /></label>
      <label>{t('priority')}<select aria-label={t('priority')} value={draft.priority ?? 'normal'}
        onChange={(event) => { setDraft({ ...draft, priority: event.target.value as OfficeWorkPriority }) }}>
        {officeWorkPriorities.map(value => <option key={value} value={value}>{t(priorityKeys[value])}</option>)}
      </select></label>
      <label>{t('description')}<textarea aria-label={t('description')} value={draft.description ?? ''} maxLength={16_000}
        onChange={(event) => { setDraft({ ...draft, description: event.target.value }) }} /></label>
      <p>{t('workEditHint')}</p>
      <div className={css.row}>
        <Button disabled={busy} onClick={onClose}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || stale || closed || !allowed || !draft.title.trim()}>{t('save')}</Button>
      </div>
    </form>
  </Modal>
}
