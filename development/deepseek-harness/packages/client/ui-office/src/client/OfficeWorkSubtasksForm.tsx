/** Work checklists retain their reviewed parent revision and publish only on explicit save. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { OfficeItem, OfficeSubtaskId, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

type EditProps = OfficeProps & { view: OfficeView; item: OfficeItem; onClose(this: void): void }
type Row = { key: string; id: OfficeSubtaskId | null; title: string; completed: boolean }
function fields(item: OfficeItem): Row[] {
  return (item.subtasks ?? []).map(entry => ({ ...entry, key: entry.id }))
}

/** Editing and cancellation retain parent ownership; explicit latest-record loading replaces a stale checklist draft. */
export function OfficeWorkSubtasksForm(props: EditProps) {
  const { t, view, item, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const [original, setOriginal] = useState(item)
  const [rows, setRows] = useState(() => fields(item))
  const latest = view.items.find(entry => entry.id === original.id)
  const stale = !latest || latest.revision !== original.revision
  const closed = latest?.status === 'completed' || latest?.status === 'cancelled'
  const allowed = view.me.role === 'admin' || original.creatorId === view.me.id || latest?.ownerId === view.me.id
  const invalid = rows.some(entry => !entry.title.trim())
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || stale || closed || !allowed || invalid) return
    const subtasks = rows.map(entry => ({ id: entry.id, title: entry.title, completed: entry.completed }))
    if (await props.updateWorkSubtasks(original, { subtasks })) { props.load(original.date); onClose() }
  }
  return <Modal open title={t('manageSubtasks')} closeLabel={t('close')}
    className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}
    onClose={() => { if (!busy) onClose() }}>
    <form className={css.form} onSubmit={(event) => { void submit(event) }}>
      <p>{original.title}</p>
      <p>{t('subtaskScope')}</p>
      {stale && <div role="alert"><p>{t('workChanged')}</p><Button disabled={busy || !latest} onClick={() => {
        if (latest) { setOriginal(latest); setRows(fields(latest)) }
      }}>{t('loadLatestWork')}</Button></div>}
      {closed && <p role="alert">{t('workClosed')}</p>}
      <p>{t('subtaskProgress')} · {rows.filter(entry => entry.completed).length}/{rows.length}</p>
      <fieldset disabled={busy || stale || closed || !allowed}>
        <legend>{t('subtasks')}</legend>
        {rows.map((entry, index) => <fieldset key={entry.key}>
          <legend>{t('subtask')} {index + 1}</legend>
          <label>{t('title')}<Input required maxLength={200} value={entry.title}
            onChange={(event) => {
              setRows(rows.map(row => row.key === entry.key ? { ...row, title: event.target.value } : row))
            }} /></label>
          <Checkbox label={t('subtaskDone')} checked={entry.completed}
            onChange={(checked) => { setRows(rows.map(row => row.key === entry.key ? { ...row, completed: checked } : row)) }} />
          <Button onClick={() => { setRows(rows.filter(row => row.key !== entry.key)) }}>{t('removeSubtask')} {index + 1}</Button>
        </fieldset>)}
        <Button disabled={rows.length >= 100} onClick={() => {
          setRows([...rows, { key: randomUUID(), id: null, title: '', completed: false }])
        }}>{t('addSubtask')}</Button>
      </fieldset>
      <div className={css.row}>
        <Button disabled={busy} onClick={onClose}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || stale || closed || !allowed || invalid}>{t('save')}</Button>
      </div>
    </form>
  </Modal>
}
