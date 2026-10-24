/** Reviewed work references use current Drive permissions and retain drafts until explicit save. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeDriveId, OfficeItem, OfficeView, OfficeWorkAttachment,
  OfficeWorkAttachmentsView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

type AttachmentProps = OfficeProps & { item: OfficeItem }
type EditProps = AttachmentProps & { view: OfficeView; onClose(this: void): void }
type Row = OfficeWorkAttachment & { name?: string | undefined }

/** File metadata is loaded separately from work records; unavailable entries never receive cached private names. */
export function OfficeWorkAttachments({ t, item, loadWorkAttachments, downloadWorkAttachment }: AttachmentProps) {
  const [value, setValue] = useState<OfficeWorkAttachmentsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [generation, refresh] = useState(0)
  useEffect(() => {
    const lifetime = new AbortController()
    setValue(null)
    setLoading(true)
    void loadWorkAttachments(item.id).then((result) => {
      if (!lifetime.signal.aborted) { setValue(result); setLoading(false) }
    }).catch(() => { if (!lifetime.signal.aborted) setLoading(false) })
    return () => { lifetime.abort() }
  }, [item.id, generation, loadWorkAttachments])
  return <section aria-label={t('itemMaterials')}>
    <h2>{t('itemMaterials')}</h2>
    {loading ? <p role="status">{t('loading')}</p> : value ? <>
      {value.files.length === 0 && <p>{t('noItemMaterials')}</p>}
      <ul>{value.files.map(file => <li key={file.id}>{file.available ? <>
        {file.name} · {file.byteLength} B <Button onClick={() => { void downloadWorkAttachment(item, file.id) }}>
          {t('downloadFile')}
        </Button>
      </> : t('workAttachmentUnavailable')}</li>)}</ul>
    </> : <p role="alert">{t('unavailable')}</p>}
    <Button disabled={loading} onClick={() => { refresh(value => value + 1) }}>{t('refresh')}</Button>
  </section>
}

/** Explicit save replaces only references; selection, cancellation and folder browsing do not mutate the work item. */
export function OfficeWorkAttachmentsForm(props: EditProps) {
  const { t, view, item, onClose, loadWorkAttachments, browseAttachmentFiles } = props
  const busy = props.useOffice(state => state.busy)
  const drive = props.useDrive(state => state)
  const [original, setOriginal] = useState(item)
  const [rows, setRows] = useState<Row[]>(() => [...(item.attachments ?? [])])
  const [selecting, setSelecting] = useState(false)
  const [error, setError] = useState(false)
  const lifetime = useRef<AbortController | null>(null)
  const latest = view.items.find(value => value.id === original.id)
  const stale = !latest || latest.revision !== original.revision
  const closed = latest?.status === 'completed' || latest?.status === 'cancelled'
  const allowed = view.me.role === 'admin' || original.creatorId === view.me.id || latest?.ownerId === view.me.id
  const disabled = busy || stale || closed || !allowed || selecting
  const limit = view.workAttachmentLimits?.maxFiles ?? 20
  useEffect(() => {
    browseAttachmentFiles({ space: 'private', folderId: null })
  }, [browseAttachmentFiles])
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setSelecting(false)
    setError(false)
    void loadWorkAttachments(original.id).then((value) => {
      if (controller.signal.aborted || value?.revision !== original.revision) return
      setRows(rows => rows.map((row) => {
        const file = value.files.find(file => file.id === row.id && file.versionId === row.versionId)
        return { ...row, name: file?.available ? file.name : undefined }
      }))
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => { controller.abort() }
  }, [original, loadWorkAttachments])
  const select = async (id: OfficeDriveId) => {
    const controller = lifetime.current
    if (disabled || !controller || rows.length >= limit && !rows.some(row => row.id === id)) return
    setSelecting(true)
    setError(false)
    try {
      const value = await props.resolveWorkAttachmentFile(id)
      if (controller.signal.aborted) return
      if (!value) { setError(true); return }
      setRows(rows => rows.some(row => row.id === value.id)
        ? rows.map(row => row.id === value.id ? { id: value.id, versionId: value.versionId, name: value.name } : row)
        : [...rows, { id: value.id, versionId: value.versionId, name: value.name }])
    } catch { if (!controller.signal.aborted) setError(true) }
    finally { if (!controller.signal.aborted) setSelecting(false) }
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled) return
    const files = rows.map(({ id, versionId }) => ({ id, versionId }))
    if (await props.updateWorkAttachments(original, { files })) { props.load(original.date); onClose() }
  }
  return <Modal open title={t('manageWorkAttachments')} closeLabel={t('close')}
    className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}
    onClose={() => { if (!busy) onClose() }}>
    <form className={css.form} onSubmit={(event) => { void submit(event) }}>
      <p>{original.title}</p><p>{t('workAttachmentScope')}</p>
      {stale && <div role="alert"><p>{t('workChanged')}</p><Button disabled={busy || !latest} onClick={() => {
        if (latest) { setOriginal(latest); setRows([...(latest.attachments ?? [])]) }
      }}>{t('loadLatestWork')}</Button></div>}
      {closed && <p role="alert">{t('workClosed')}</p>}
      {error && <p role="alert">{t('workAttachmentUnavailable')}</p>}
      <fieldset disabled={disabled}>
        <legend>{t('itemMaterials')} · {rows.length}/{limit}</legend>
        <ul>{rows.map((row, index) => <li key={row.id}>
          {row.name ?? t('workAttachmentUnavailable')} <Button onClick={() => {
            setRows(rows.filter(value => value.id !== row.id))
          }}>{t('removeWorkAttachment')} {index + 1}</Button>
        </li>)}</ul>
        <nav aria-label={t('chooseWorkAttachment')} className={css.row}>
          {(['private', 'shared'] as const).map(space => <Button key={space} onClick={() => {
            browseAttachmentFiles({ space, folderId: null })
          }}>{t(space === 'private' ? 'privateDrive' : 'sharedDrive')}</Button>)}
          {drive.view?.path.map(folder => <Button key={folder.id} onClick={() => {
            browseAttachmentFiles({ space: folder.space, folderId: folder.id })
          }}>{folder.name}</Button>)}
        </nav>
        {drive.loading ? <p role="status">{t('loading')}</p> : drive.error ? <p role="alert">{t(drive.error)}</p> :
          <ul>{drive.view?.entries.map(entry => <li key={entry.id}>
            {entry.kind === 'folder' ? <Button onClick={() => {
              browseAttachmentFiles({ space: entry.space, folderId: entry.id })
            }}>{entry.name}</Button> : <><span>{entry.name}</span> <Button
              disabled={rows.length >= limit && !rows.some(row => row.id === entry.id)}
              onClick={() => { void select(entry.id) }}>{t('chooseWorkAttachment')} {entry.name}</Button></>}
          </li>)}</ul>}
      </fieldset>
      <div className={css.row}><Button disabled={busy} onClick={onClose}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={disabled}>{t('save')}</Button></div>
    </form>
  </Modal>
}
