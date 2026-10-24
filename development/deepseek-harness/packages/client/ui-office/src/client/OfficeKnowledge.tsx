/** Knowledge queries and human-reviewed publication controls operate on actual current Drive versions. */
import { useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeDriveId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficeKnowledge.module.css'

type KnowledgeProps = Pick<OfficeProps, 't' | 'useKnowledge' | 'searchKnowledge' | 'openKnowledgeCitation' |
  'reviewKnowledgeFile' | 'saveKnowledge' | 'closeKnowledgeReview' | 'downloadDriveVersion'> & {
    readonly selectedFile: OfficeDriveId | null
    readonly publisher: boolean
  }

/** Bound model hooks own returned content; local state retains only the employee's unsent search text. */
export function OfficeKnowledge(props: KnowledgeProps) {
  const { t } = props
  const snapshot = props.useKnowledge(value => value)
  const [query, setQuery] = useState('')
  const composing = useRef(false)
  if (!snapshot.enabled) return null
  const unknownWrite = snapshot.pending && !snapshot.saving
  const error = snapshot.error === 'knowledgeSaveUnknown' ? null : snapshot.error
  const reviewError = snapshot.error ?? (unknownWrite ? 'knowledgeSaveUnknown' : null)
  return <section className={css.panel} aria-label={t('knowledgeTitle')} aria-busy={snapshot.busy}>
    <header>
      <h2>{t('knowledgeTitle')}</h2>
      <p>{t('knowledgeScope')}</p>
    </header>
    <form className={css.toolbar} onSubmit={(event) => {
      event.preventDefault()
      if (!composing.current && !snapshot.busy && query.trim()) void props.searchKnowledge(query.trim())
    }}>
      <Input value={query} maxLength={256} aria-label={t('knowledgeQuery')} onChange={(event) => { setQuery(event.target.value) }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(event) => {
          const composition: { readonly isComposing: boolean; readonly keyCode: number } = event.nativeEvent
          if (event.key === 'Enter' && (composing.current || composition.isComposing || composition.keyCode === 229)) event.preventDefault()
        }} />
      <Button type="submit" disabled={snapshot.busy || !query.trim()}>{t('knowledgeSearch')}</Button>
      {props.publisher && <Button disabled={snapshot.busy || !props.selectedFile || snapshot.pending}
        onClick={() => { if (props.selectedFile) void props.reviewKnowledgeFile(props.selectedFile) }}>{t('knowledgeReview')}</Button>}
    </form>
    {!snapshot.reviewOpen && error && <p role="alert" className={css.error}>{t(error)}</p>}
    {snapshot.pending && !snapshot.reviewOpen && snapshot.review && <aside className={css.pending}
      aria-label={t('knowledgeSaveUnknown')}>
      <p className={css.metadata}>{snapshot.review.file.name}</p>
      {unknownWrite && <p role="alert" className={css.error}>{t('knowledgeSaveUnknown')}</p>}
      <Button disabled={snapshot.busy} onClick={() => {
        if (snapshot.review) void props.reviewKnowledgeFile(snapshot.review.file.id)
      }}>{t('retry')}</Button>
    </aside>}
    {snapshot.busy && !snapshot.reviewOpen && <div className={css.loading}><progress aria-label={t('loading')} /></div>}
    {snapshot.query !== null && <section className={css.query} aria-label={t('searchResults')}>
      <h3>{t('searchResults')}</h3>
      <p className={css.metadata}>{t('knowledgeQuery')}: {snapshot.query}</p>
      {snapshot.queryError && <div className={css.recovery}>
        <p role="alert" className={css.error}>{t(snapshot.queryError)}</p>
        <Button disabled={snapshot.busy} onClick={() => {
          if (snapshot.query !== null) void props.searchKnowledge(snapshot.query)
        }}>{t('retry')}</Button>
      </div>}
      {!snapshot.busy && !snapshot.queryError && !error && snapshot.entries.length === 0 &&
        <p role="status">{t('searchNoResults')}</p>}
      <ul className={css.results}>{snapshot.entries.map(entry => <li key={`${entry.file.id}:${entry.revision}:${entry.chunk}`}>
        <Button disabled={snapshot.busy} onClick={() => { void props.openKnowledgeCitation(entry) }}>{entry.file.name}</Button>
        <p className={css.metadata}>
          {entry.location.kind} · {entry.location.part} · {entry.location.label} · {t('driveVersion')}: {entry.file.versionId}
        </p>
        <pre className={css.text} tabIndex={0}>{entry.text}</pre>
      </li>)}</ul>
      {snapshot.hasMore && <p>{t('knowledgeMore')}</p>}
    </section>}
    {snapshot.citation && <article className={css.citation} aria-label={t('knowledgeCitation')}>
      <h3>{snapshot.citation.file.name}</h3>
      <p className={css.metadata}>{t('driveVersion')}: {snapshot.citation.file.versionId} · {snapshot.citation.file.sha256}</p>
      <p className={css.metadata}>
        {snapshot.citation.location.kind} · {snapshot.citation.location.part} · {snapshot.citation.location.offset}
      </p>
      <pre className={css.text} tabIndex={0}>{snapshot.citation.text}</pre>
      <Button disabled={snapshot.busy} onClick={() => {
        if (snapshot.citation) void props.downloadDriveVersion(snapshot.citation.file.id, snapshot.citation.file.versionId)
      }}>{t('downloadFile')}</Button>
    </article>}
    {snapshot.reviewOpen && <Modal open title={t(snapshot.pending ? 'knowledgeTitle' : 'knowledgeReview')}
      closeLabel={t('close')} onClose={props.closeKnowledgeReview} className={css.modal} contentClassName={css.modalBody}>
      <div className={css.review} aria-busy={snapshot.busy}>
        <p>{t('knowledgePublishScope')}</p>
        {snapshot.review && <>
          <p className={css.metadata}>{snapshot.review.file.name} · {snapshot.review.file.versionId}</p>
          <p className={css.metadata}>{snapshot.review.file.sha256}</p>
        </>}
        {snapshot.busy && <div className={css.loading}><progress aria-label={t('loading')} /></div>}
        {reviewError && <p role="alert" className={css.error}>{t(reviewError)}</p>}
        {snapshot.review && <div className={css.actions}>
          <Button disabled={snapshot.busy} onClick={() => { void props.saveKnowledge('publish') }}>
            {t(snapshot.pending ? 'retry' : 'knowledgePublish')}
          </Button>
          {!!snapshot.review.publication && !snapshot.review.publication.withdrawn && <Button disabled={snapshot.busy || snapshot.pending}
            onClick={() => { void props.saveKnowledge('withdraw') }}>{t('knowledgeWithdraw')}</Button>}
        </div>}
      </div>
    </Modal>}
  </section>
}
