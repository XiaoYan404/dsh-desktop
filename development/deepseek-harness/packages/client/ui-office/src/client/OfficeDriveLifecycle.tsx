/** Version history and recycle-bin forms keep reviewed metadata separate from refreshed results. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeDriveEntry, OfficeDriveTrashEntry, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficeDrive.module.css'
import pageCss from './OfficePage.module.css'

type Props = OfficeProps & {
  office: OfficeView
  deletion: OfficeDriveEntry | null
  latestDeletion: OfficeDriveEntry | null
  closeDeletion(this: void): void
  reviewDeletion(this: void, entry: OfficeDriveEntry): void
}
const size = (bytes: number): string => `${new Intl.NumberFormat().format(bytes)} B`
const time = (value: number): string => new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(value)

/** Metadata remains in the owning model; native File handles live only in this mounted employee form. */
export function OfficeDriveLifecycle(props: Props) {
  const { t, office } = props
  const state = props.useDriveLifecycle(value => value)
  const drive = props.useDrive(value => value)
  const transfers = props.useDriveTransfers(value => value)
  const upload = transfers.upload
  const [source, setSource] = useState<File | null>(null)
  const [reviewed, setReviewed] = useState<OfficeDriveEntry | null>(null)
  const [restoring, setRestoring] = useState<OfficeDriveTrashEntry | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  useEffect(() => { setSource(null); setReviewed(null); setRestoring(null) }, [state.panel])
  const history = state.history
  const locked = state.busy || state.loading
  const transferBusy = upload !== null && !['completed', 'cancelled', 'expired', 'stopped'].includes(upload.phase)
  const downloading = transfers.download !== null && ['preparing', 'downloading', 'verifying'].includes(transfers.download.phase)
  const limit = drive.view?.transfers?.maxFileBytes ?? 0
  const tooLarge = source !== null && source.size > limit
  const current = reviewed ? drive.view?.entries.find(entry => entry.id === reviewed.id) : undefined
  const changed = reviewed !== null && (!history || history.entry.revision !== reviewed.revision
    || !current || current.revision > reviewed.revision || !history.entry.canUpdate)
  const close = () => { props.closeDriveLifecycle(); setSource(null); setReviewed(null); setRestoring(null) }
  const latestRestore = state.trash?.entries.find(entry => entry.id === restoring?.id) ?? null
  return <>
    <Modal open={state.panel !== null} title={t(state.panel === 'trash' ? 'driveRecycleBin' : 'driveVersionHistory')}
      closeLabel={t('close')} onClose={close} className={css.previewModal ?? ''} contentClassName={css.previewBody ?? ''}>
      <div className={pageCss.form}>
        <div className={pageCss.row}>
          <Button disabled={locked} onClick={props.refreshDriveLifecycle}>{t('refresh')}</Button>
          {state.panel === 'history' && history && <Button disabled={locked || !history.entry.canUpdate || transferBusy}
            onClick={() => { picker.current?.click() }}>{t('driveUploadVersion')}</Button>}
        </div>
        {state.loading && <p role="status">{t('loading')}</p>}
        {downloading && <p role="status">{t('driveDownloading')}</p>}
        {state.error && <p role="alert" className={pageCss.error}>{t(state.error)}</p>}
        {state.panel === 'history' && history && <>
          <strong className={css.previewName}>{history.entry.name}</strong>
          <p>{t('driveHistoryHint')}</p>
          <input ref={picker} type="file" hidden aria-label={t('driveUploadVersion')} onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) { setSource(file); setReviewed(history.entry) }
            event.target.value = ''
          }} />
          {source && reviewed && <section aria-label={t('driveReviewVersion')} className={pageCss.form}>
            <strong>{t('driveReviewVersion')}</strong>
            <p>{t('driveReplacementTarget')}: {reviewed.name}</p>
            <p>{t('driveReplacementSource')}: {source.name} · {size(source.size)}</p>
            {tooLarge && <p role="alert">{t('uploadTooLarge')}</p>}
            {changed && <>
              <p role="alert">{t('driveChanged')}</p>
              <Button disabled={locked} onClick={() => {
                void props.reviewDriveHistory().then((entry) => { if (entry) setReviewed(entry) })
              }}>{t('loadLatestDrive')}</Button>
            </>}
            <div className={pageCss.row}>
              <Button disabled={locked} onClick={() => { setSource(null); setReviewed(null) }}>{t('cancel')}</Button>
              <Button variant="primary" disabled={locked || transferBusy || tooLarge || changed} onClick={() => {
                if (props.startDriveVersionUpload(source, reviewed)) close()
              }}>{t('driveConfirmVersion')}</Button>
            </div>
          </section>}
          <div className={css.lifecycleTable}>
            <table className={css.table} aria-label={t('driveVersionHistory')}>
              <thead><tr><th>{t('driveVersion')}</th><th>{t('modified')}</th><th>{t('driveVersionAuthor')}</th>
                <th>{t('fileSize')}</th><th>{t('driveLifecycleActions')}</th></tr></thead>
              <tbody>{history.versions.map((version, index) => {
                const ordinal = history.versions.length - index
                return <tr key={version.versionId} data-drive-version={version.versionId}>
                  <td>{t('driveVersion')} {ordinal}{version.current && <small> · {t('driveCurrentVersion')}</small>}</td>
                  <td>{time(version.createdAt)}</td>
                  <td>{office.members.find(member => member.id === version.actorId)?.name ?? version.actorId}</td>
                  <td>{size(version.byteLength)}</td><td><Button disabled={locked || downloading}
                    aria-label={`${t('driveDownloadVersion')} ${ordinal}`} onClick={() => {
                      void props.downloadDriveVersion(history.entry.id, version.versionId)
                    }}>{t('downloadFile')}</Button></td>
                </tr>
              })}</tbody>
            </table>
          </div>
        </>}
        {state.panel === 'trash' && state.trash && <>
          <p>{t('driveTrashHint')}</p>
          {state.trash.entries.length === 0 ? <p>{t('driveTrashEmpty')}</p> : <div className={css.lifecycleTable}>
            <table className={css.table} aria-label={t('driveRecycleBin')}>
              <thead><tr><th>{t('driveFileName')}</th><th>{t('driveOriginalSpace')}</th><th>{t('driveDeletedAt')}</th>
                <th>{t('driveLifecycleActions')}</th></tr></thead>
              <tbody>{state.trash.entries.map(entry => <tr key={entry.id} data-drive-trash={entry.id}>
                <td>{entry.name}</td><td>{t(entry.space === 'private' ? 'privateDrive' : 'sharedDrive')}</td>
                <td>{time(entry.deletedAt)}</td><td><Button disabled={locked || !entry.canTrash}
                  aria-label={`${t('driveRestoreFile')}: ${entry.name}`} onClick={() => { setRestoring(entry) }}>
                  {t('driveRestoreFile')}</Button>
                {drive.view?.cleanup === 1 && <Button disabled={locked || !entry.canPurge && !entry.purge}
                  aria-label={`${t(entry.purge ? 'drivePurgeStatus' : 'drivePurgeFile')}: ${entry.name}`}
                  onClick={() => { props.openDrivePurge(entry.id) }}>
                  {t(entry.purge ? 'drivePurgeStatus' : 'drivePurgeFile')}</Button>}
                </td>
              </tr>)}</tbody>
            </table>
          </div>}
        </>}
      </div>
    </Modal>
    {restoring && <RestoreForm key={restoring.id} {...props} entry={restoring} latest={latestRestore}
      onLatest={setRestoring} onClose={() => { setRestoring(null) }} />}
    {state.purge && <PurgeForm key={state.purge.id} {...props} />}
    {props.deletion && <DeleteForm {...props} entry={props.deletion} latest={props.latestDeletion} />}
  </>
}

function PurgeForm(props: Props) {
  const { t } = props
  const state = props.useDriveLifecycle(value => value)
  const review = state.purge
  const [accepted, setAccepted] = useState(false)
  const plan = review?.plan
  useEffect(() => { setAccepted(false) }, [plan, review?.receipt])
  if (!review) return null
  const receipt = review.receipt
  const totals = receipt ?? plan
  const locked = state.busy || state.loading
  return <Modal open title={t('drivePurgeFile')} closeLabel={t('close')} onClose={props.closeDrivePurge}
    className={css.previewModal ?? ''} contentClassName={css.previewBody ?? ''}>
    <div className={pageCss.form}>
      {plan && <strong className={css.previewName}>{plan.entry.name}</strong>}
      <p>{t('drivePurgeHint')}</p>
      {state.loading && <p role="status">{t('loading')}</p>}
      {state.error && <p role="alert" className={pageCss.error}>{t(state.error)}</p>}
      {totals && <p>{t('drivePurgeFiles')}: {totals.files} · {t('drivePurgeFolders')}: {totals.folders}
        {' · '}{t('drivePurgeVersions')}: {totals.versions} · {t('fileSize')}: {size(totals.byteLength)}</p>}
      {review.uncertain && <p role="status">{t('drivePurgeUncertain')}</p>}
      {receipt && <>
        <p role="status">{t(receipt.status === 'pending' ? 'drivePurgePending' : 'drivePurgeCompleted')}</p>
        <p>{t('drivePurgeRequest')}: {receipt.requestId}</p>
      </>}
      {plan && !receipt && !review.uncertain && <label>
        <input type="checkbox" checked={accepted} disabled={locked}
          onChange={(event) => { setAccepted(event.target.checked) }} /> {t('drivePurgeAccept')}
      </label>}
      <div className={pageCss.row}>
        <Button disabled={locked} onClick={props.closeDrivePurge}>{t(receipt ? 'close' : 'cancel')}</Button>
        {receipt?.status !== 'completed' && <Button disabled={locked} onClick={props.reviewDrivePurge}>
          {t(review.uncertain || receipt ? 'drivePurgeStatus' : 'loadLatestDrive')}</Button>}
        {receipt?.status === 'pending' && <Button variant="primary" disabled={locked}
          onClick={() => { props.confirmDrivePurge(true) }}>{t('drivePurgeRetry')}</Button>}
        {!receipt && (plan || review.uncertain) && <Button variant="primary"
          disabled={locked || !review.uncertain && !accepted} onClick={() => { props.confirmDrivePurge() }}>
          {t(review.uncertain ? 'drivePurgeRetryConfirmation' : 'drivePurgeConfirm')}</Button>}
      </div>
    </div>
  </Modal>
}

function DeleteForm(props: Props & { entry: OfficeDriveEntry; latest: OfficeDriveEntry | null }) {
  const { t, entry, latest } = props
  const state = props.useDriveLifecycle(value => value)
  const loading = props.useDrive(value => value.loading)
  const changed = !latest || latest.revision !== entry.revision || !latest.canTrash
  const close = () => { props.closeDriveLifecycle(); props.closeDeletion() }
  return <Modal open title={t('driveDeleteFile')} closeLabel={t('close')} onClose={close}
    className={css.previewModal ?? ''} contentClassName={css.previewBody ?? ''}>
    <div className={pageCss.form}>
      <strong className={css.previewName}>{latest ? entry.name : t('not_found')}</strong><p>{t('driveDeleteHint')}</p>
      {entry.kind === 'folder' && <p>{t('driveDeleteFolderHint')}</p>}
      {state.error && <p role="alert" className={pageCss.error}>{t(state.error)}</p>}
      {(changed || state.error === 'conflict') && <><p role="alert">{t('driveChanged')}</p><div className={pageCss.row}>
        <Button disabled={state.busy || loading} onClick={props.loadDrive}>{t('refresh')}</Button>
        {latest && changed && <Button disabled={state.busy || loading} onClick={() => {
          props.reviewDeletion(latest)
        }}>{t('loadLatestDrive')}</Button>}
      </div></>}
      <div className={pageCss.row}>
        <Button disabled={state.busy} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={state.busy || loading || changed} onClick={() => {
          void props.changeDriveLifecycle({ id: entry.id, revision: entry.revision, action: 'trash' }).then((ok) => { if (ok) close() })
        }}>{t('driveConfirmDelete')}</Button>
      </div>
    </div>
  </Modal>
}

function RestoreForm(props: Props & {
  entry: OfficeDriveTrashEntry
  latest: OfficeDriveTrashEntry | null
  onLatest(this: void, entry: OfficeDriveTrashEntry): void
  onClose(this: void): void
}) {
  const { t, entry, latest } = props
  const state = props.useDriveLifecycle(value => value)
  const [name, setName] = useState(entry.name)
  const changed = !latest || latest.revision !== entry.revision || !latest.canTrash
  return <Modal open title={t('driveRestoreFile')} closeLabel={t('close')} onClose={props.onClose}
    className={css.previewModal ?? ''} contentClassName={css.previewBody ?? ''}>
    <form className={pageCss.form} onKeyDown={(event) => {
      const composition: { readonly isComposing: boolean; readonly keyCode: number } = event.nativeEvent
      if (event.key === 'Enter' && (composition.isComposing || composition.keyCode === 229)) event.preventDefault()
    }} onSubmit={(event) => {
      event.preventDefault()
      if (state.busy || state.loading || changed || !name.trim()) return
      void props.changeDriveLifecycle({ id: entry.id, revision: entry.revision, action: 'restore', name }).then((ok) => {
        if (ok) props.onClose()
      })
    }}>
      <strong className={css.previewName}>{latest ? entry.name : t('not_found')}</strong>
      <label>{t('driveFileName')}<Input data-modal-autofocus required maxLength={255} value={name}
        disabled={state.busy} onChange={(event) => { setName(event.target.value) }} /></label>
      <p>{t('driveRestoreHint')}</p>
      {state.error && <p role="alert" className={pageCss.error}>{t(state.error)}</p>}
      {(changed || state.error !== null) && <><p role="alert">{t('driveChanged')}</p>
        <Button disabled={state.busy || state.loading} onClick={props.refreshDriveLifecycle}>{t('refresh')}</Button>
        {latest && changed && <Button disabled={state.busy || state.loading} onClick={() => { props.onLatest(latest) }}>
          {t('loadLatestDrive')}</Button>}
      </>}
      <div className={pageCss.row}>
        <Button disabled={state.busy} onClick={props.onClose}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={state.busy || state.loading || changed || !name.trim()}>
          {t('driveRestoreFile')}</Button>
      </div>
    </form>
  </Modal>
}
