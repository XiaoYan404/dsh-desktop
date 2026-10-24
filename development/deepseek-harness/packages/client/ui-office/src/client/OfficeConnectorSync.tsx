/** Explicit read review and private saved snapshots use the existing bounded system-detail modal. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeConnectorSyncDetail, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import { officeConnectorStatusKeys } from './OfficeConnections.tsx'
import css from './OfficePage.module.css'

/** Historical fields are plain text and always displayed beside their actual read and save timestamps. */
export function OfficeConnectorSync(props: OfficeProps & { office: OfficeView }) {
  const { t, office } = props
  const snapshot = props.useConnectorSync(state => state)
  if (!snapshot.integrationId) return null
  const request = snapshot.request
  const detail = snapshot.detail
  const system = office.integrations?.entries.find(entry => entry.id === snapshot.integrationId)
  const receipt = request?.receipt ?? detail?.receipt
  const time = (at: number) => new Date(at).toLocaleString(undefined, { timeZone: office.timeZone })
  const timestamp = (at: number) => <time dateTime={new Date(at).toISOString()}>{time(at)}</time>
  const titleKey = request ? 'syncReview' : detail ? 'syncDetail' : 'syncHistory'
  return <Modal open title={t(titleKey)} closeLabel={t('close')}
    className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}
    onClose={props.closeConnectorSync} footer={<>
      {request && (request.phase === 'review' || request.phase === 'uncertain') && <Button variant="primary"
        onClick={() => { void props.submitConnectorSync() }}>{t(request.phase === 'review' ? 'syncConfirm' : 'syncRetry')}</Button>}
      {request && request.phase !== 'sending' && <Button
        onClick={() => { if (snapshot.integrationId) void props.openConnectorSyncHistory(snapshot.integrationId) }}>{t('syncHistory')}</Button>}
      {detail && <Button onClick={props.backConnectorSyncHistory}>{t('syncBack')}</Button>}
      <Button aria-label={t('syncClose')} onClick={props.closeConnectorSync}>{t('close')}</Button>
    </>}>
    <div className={css.executionHistory}>
      <h2>{system?.system ?? snapshot.integrationId}</h2>
      <p className={css.accountHint}>{t('syncPrivateHint')}</p>
      {request ? <>
        <h3>{request.label}</h3>
        <p>{t('syncReviewHint')}</p>
        <dl className={css.executionCoordinates}>
          <dt>{t('executionAction')}</dt><dd>{request.input.actionId}</dd>
          <dt>{t('executionConnectionVersion')}</dt><dd>{request.input.connectionRevision}</dd>
        </dl>
        {request.phase === 'sending' && <progress aria-label={t('loading')} />}
        {request.error && <p role="alert">{t(request.error)}</p>}
        {request.phase === 'uncertain' && <p role="status">{t('syncUnknown')}</p>}
      </> : detail ? <>
        {detail.loading && <progress aria-label={t('loading')} />}
        {detail.error && <><p role="alert">{t(detail.error)}</p><Button
          onClick={() => { void props.openConnectorSyncDetail(detail.id) }}>{t('executionRefreshReceipt')}</Button></>}
      </> : <>
        <Button disabled={snapshot.loading} onClick={() => {
          if (snapshot.integrationId) void props.openConnectorSyncHistory(snapshot.integrationId)
        }}>{t('executionRefresh')}</Button>
        {snapshot.error && <p role="alert">{t(snapshot.error)}</p>}
        {snapshot.loading && <progress aria-label={t('loading')} />}
        {!snapshot.loading && !snapshot.error && !snapshot.entries.length && <p role="status">{t('syncEmpty')}</p>}
        <ul className={css.executionList}>{snapshot.entries.map(entry => <li key={entry.id}>
          <strong>{entry.actionId}</strong> · {t(entry.status === 'read' ? 'syncSucceeded' : officeConnectorStatusKeys[entry.status])}
          <p>{timestamp(entry.synchronizedAt)}</p>
          <Button aria-label={t('syncViewId').replace('{id}', entry.id)}
            onClick={() => { void props.openConnectorSyncDetail(entry.id) }}>{t('executionView')}</Button>
        </li>)}</ul>
        {snapshot.next && <Button disabled={snapshot.loading} onClick={() => { void props.moreConnectorSyncHistory() }}>
          {t('executionOlder')}
        </Button>}
      </>}
      {receipt && <SyncReceipt {...props} receipt={receipt} timeZone={office.timeZone} />}
    </div>
  </Modal>
}

function SyncReceipt(props: OfficeProps & { receipt: OfficeConnectorSyncDetail; timeZone: string }) {
  const { t, receipt, timeZone } = props
  const { summary } = receipt
  const time = (at: number) => <time dateTime={new Date(at).toISOString()}>
    {new Date(at).toLocaleString(undefined, { timeZone })}
  </time>
  return <section aria-label={t('syncDetail')}>
    <p role="status">{t(summary.status === 'read' ? 'syncSucceeded' : officeConnectorStatusKeys[summary.status])}</p>
    {summary.status !== 'read' && <p>{t('syncFailed')}</p>}
    <dl className={css.executionCoordinates}>
      <dt>{t('syncRecordId')}</dt><dd>{summary.id}</dd>
      <dt>{t('syncReadAt')}</dt><dd>{time(summary.checkedAt)}</dd>
      <dt>{t('syncSavedAt')}</dt><dd>{time(summary.synchronizedAt)}</dd>
      <dt>{t('executionAction')}</dt><dd>{summary.actionId}</dd>
    </dl>
    {!receipt.available && <p role="status">{t('syncUnavailable')}</p>}
    {receipt.available && summary.status === 'read' && receipt.data && <>
      <p className={css.accountHint}>{t('syncHistoricalHint')}</p>
      <div className={css.connectionRead}><p>{receipt.data.summary}</p>
        <dl>{receipt.data.entries.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
      </div>
    </>}
  </section>
}
