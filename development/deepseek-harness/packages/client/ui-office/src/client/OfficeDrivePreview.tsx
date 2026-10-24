/** Preview content is inert text or a constrained raster image; URLs belong to the mounted image only. */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeProps } from './contracts.ts'
import css from './OfficeDrive.module.css'

function PreviewImage({ data, mediaType, name, t }: {
  data: Uint8Array<ArrayBuffer>
  mediaType: string
  name: string
  t: OfficeProps['t']
}) {
  const [source, setSource] = useState<{ data: Uint8Array; url: string } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: mediaType }))
      setSource({ data, url })
      setFailed(false)
    } catch { setFailed(true) }
    return () => { if (url !== undefined) URL.revokeObjectURL(url) }
  }, [data, mediaType])
  if (failed) return <p role="alert">{t('drivePreviewImageFailed')}</p>
  if (source?.data !== data) return <progress aria-label={t('drivePreviewLoading')} />
  return <img className={css.previewImage} src={source.url} alt={name} onError={() => { setFailed(true) }} />
}

/** Render only this employee's live preview, independent of upload and download progress. */
export function OfficeDrivePreview(props: Pick<OfficeProps,
  't' | 'useDrivePreview' | 'closeDrivePreview' | 'retryDrivePreview' | 'downloadDriveFile'>) {
  const { t } = props
  const preview = props.useDrivePreview(value => value)
  if (preview.phase === 'closed') return null
  return (
    <Modal open title={t('drivePreview')} closeLabel={t('close')} onClose={props.closeDrivePreview}
      className={clsx(css.previewModal)} contentClassName={clsx(css.previewBody)}>
      <div className={css.preview}>
        <p className={css.previewName}>{preview.name}</p>
        {preview.phase === 'loading' && <progress aria-label={t('drivePreviewLoading')}
          value={preview.info ? preview.done : undefined} max={preview.info?.byteLength || 1} />}
        {preview.error && <p role="alert">{t(preview.error)}</p>}
        {preview.content?.kind === 'text' && <pre className={css.previewText} tabIndex={0}
          aria-label={t('drivePreviewText')}>{preview.content.text}</pre>}
        {preview.content?.kind === 'image' && <PreviewImage data={preview.content.data} mediaType={preview.content.mediaType}
          name={preview.name} t={t} />}
        <p>{t('drivePreviewHint')}</p>
        <div className={css.previewActions}>
          {preview.phase !== 'loading' && <Button onClick={props.retryDrivePreview}>{t('refresh')}</Button>}
          <Button disabled={!preview.id || preview.phase === 'loading'} onClick={() => {
            if (preview.id) void props.downloadDriveFile(preview.id)
          }}>{t('downloadFile')}</Button>
          <Button onClick={props.closeDrivePreview}>{t('close')}</Button>
        </div>
      </div>
    </Modal>
  )
}
