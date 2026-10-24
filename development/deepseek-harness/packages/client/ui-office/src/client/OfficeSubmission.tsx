/** Declared business text is reviewed unchanged before an explicit customer-system submission. */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeProps } from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import type { OfficeConnectorExecutionReceipt } from '@deepseek-ai/dsh-enterprise-office/types'
import css from './OfficePage.module.css'

const resultKeys: Record<OfficeConnectorExecutionReceipt['status'], OfficeKey> = {
  reserved: 'executionReserved', succeeded: 'executionSucceeded', rejected: 'executionRejected',
  unknown: 'executionUnknown', cancelled: 'executionCancelled',
}
const rejectionKeys: Record<NonNullable<OfficeConnectorExecutionReceipt['rejection']>, OfficeKey> = {
  denied: 'forbidden', not_accepted: 'executionNotAccepted', unauthorized: 'connectorUnauthorized',
  rate_limited: 'connectorRateLimited', invalid_input: 'invalid_input',
}

/** One bounded modal displays declared inputs, exact review and the actual retained outcome without automatic retries. */
export function OfficeSubmission(props: OfficeProps) {
  const { t } = props
  const snapshot = props.useSubmissions(state => state)
  const draft = snapshot.draft
  if (!draft) return null
  const fields = draft.action.fields ?? []
  const value = (name: string) => Object.hasOwn(draft.input.values, name) ? draft.input.values[name] ?? '' : ''
  const submitting = snapshot.phase === 'submitting'
  const editing = snapshot.phase === 'edit'
  const receipt = snapshot.receipt
  return <Modal open title={t('submissionTitle')} closeLabel={t('close')}
    className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}
    onClose={() => { props.closeSubmission() }} footer={<>
      {!editing && !snapshot.attempted && <Button onClick={() => { props.editSubmission() }}>{t('submissionEdit')}</Button>}
      <Button aria-label={t('submissionClose')} disabled={submitting} onClick={() => { props.closeSubmission() }}>{t('close')}</Button>
      {editing && <Button variant="primary" disabled={snapshot.stale} onClick={() => { props.reviewSubmission() }}>
        {t('submissionReview')}
      </Button>}
      {snapshot.phase === 'review' && <Button variant="primary" disabled={snapshot.stale}
        onClick={() => { void props.submitConnectorAction() }}>{t('submissionConfirm')}</Button>}
      {snapshot.phase === 'uncertain' && <Button onClick={() => { void props.submitConnectorAction() }}>
        {t('submissionRetryOriginal')}
      </Button>}
      {receipt && <Button onClick={() => {
        props.closeSubmission()
        void props.openExecutionRecords(draft.input.integrationId)
      }}>{t('executionRecords')}</Button>}
    </>}>
    <div className={css.executionHistory} aria-busy={submitting}>
      <h2>{draft.system}</h2><h3>{draft.action.label}</h3>
      {draft.action.description && <p>{draft.action.description}</p>}
      {snapshot.error && <p role="alert">{t(snapshot.error)}</p>}
      {snapshot.stale && !receipt && <p role="alert">{t('submissionStale')}</p>}
      {editing ? <div className={css.form}>
        {fields.length ? fields.map(field => <label key={field.name}>
          {field.label}{field.required ? ` · ${t('submissionRequired')}` : ''}
          {field.maxLength <= 200 ? <Input aria-label={field.label} value={value(field.name)} maxLength={field.maxLength}
            required={field.required} disabled={snapshot.stale}
            onChange={(event) => { props.updateSubmissionField(field.name, event.target.value) }} />
            : <textarea aria-label={field.label} value={value(field.name)} maxLength={field.maxLength} required={field.required}
              disabled={snapshot.stale} rows={5} onChange={(event) => { props.updateSubmissionField(field.name, event.target.value) }} />}
        </label>) : <p>{t('submissionNoFields')}</p>}
      </div> : <>
        {!receipt && <p className={css.accountHint}>{t('submissionReviewHint')}</p>}
        <dl className={css.executionCoordinates}>{fields.map(field => <div key={field.name}>
          <dt>{field.label}</dt><dd>{value(field.name) || t('submissionEmptyValue')}</dd>
        </div>)}</dl>
      </>}
      {submitting && <p role="status">{t('submissionSending')}</p>}
      {snapshot.phase === 'uncertain' && <p className={css.accountHint}>{t('submissionUncertain')}</p>}
      {receipt && <section aria-label={t('submissionReceipt')}>
        <h3>{t(resultKeys[receipt.status])}</h3>
        {receipt.rejection && <p>{t(rejectionKeys[receipt.rejection])}</p>}
        <p>{t('executionId')} · {receipt.id}</p>
        {receipt.status === 'unknown' && <p className={css.accountHint}>{t('executionUnknownHint')}</p>}
        {receipt.result && <section className={css.connectionRead} aria-label={t('executionResult')}>
          <p>{receipt.result.summary}</p>
          <dl>{receipt.result.entries.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
        </section>}
      </section>}
    </div>
  </Modal>
}
