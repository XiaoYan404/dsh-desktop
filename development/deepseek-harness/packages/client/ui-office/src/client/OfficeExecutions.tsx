/** Explicit employee-private execution browsing; viewing a receipt never dispatches or retries a customer operation. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeConnectorExecutionStage, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import css from './OfficePage.module.css'

const stageKeys: Record<OfficeConnectorExecutionStage, OfficeKey> = {
  reserved: 'executionReserved', dispatched: 'executionDispatched', succeeded: 'executionSucceeded',
  rejected: 'executionRejected', unknown: 'executionUnknown', cancelled: 'executionCancelled',
}

/** Own paginated records and explicit receipt details share the bounded system-detail modal layout. */
export function OfficeExecutionHistory(props: OfficeProps & { office: OfficeView }) {
  const { t, office } = props
  const snapshot = props.useExecutions(state => state)
  const checksEnabled = props.useConnectors(state => state.view?.executionHistory?.checks === 1)
  const integrationId = snapshot.integrationId
  if (!integrationId) return null
  const system = office.integrations?.entries.find(entry => entry.id === snapshot.integrationId)
  const detail = snapshot.detail
  const receipt = detail?.receipt
  const time = (at: number) => new Date(at).toLocaleString(undefined, { timeZone: office.timeZone })
  return <Modal open title={t(detail ? 'executionDetails' : 'executionRecords')} closeLabel={t('close')}
    className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}
    onClose={() => { props.closeExecutionRecords() }} footer={<>
      {detail && <Button onClick={() => { props.closeExecutionDetail() }}>{t('executionBack')}</Button>}
      {receipt?.status === 'unknown' && checksEnabled && <Button disabled={detail?.check?.loading}
        onClick={() => { void props.checkExecutionOutcome() }}>{t(detail?.check?.loading ? 'executionChecking' : 'executionCheck')}</Button>}
      <Button aria-label={t('executionClose')} onClick={() => { props.closeExecutionRecords() }}>{t('close')}</Button>
    </>}>
    <div className={css.executionHistory}>
      <h2>{system?.system ?? snapshot.integrationId}</h2>
      <p className={css.accountHint}>{t('executionPrivateHint')}</p>
      {detail ? <>
        {detail.loading && <p role="status">{t('loading')}</p>}
        {detail.error && <p role="alert">{t(detail.error)}</p>}
        {detail.check?.error && <p role="alert">{t(detail.check.error)}</p>}
        {detail.check?.status && <p role="status">{t(detail.check.status === 'updated' ? 'executionCheckUpdated'
          : detail.check.status === 'unknown' ? 'executionCheckUnknown'
            : detail.check.status === 'connection_changed' ? 'executionCheckConnectionChanged' : 'executionCheckUnavailable')}</p>}
        {detail.error && <Button onClick={() => { void props.openExecutionDetail(detail.id) }}>{t('executionRefreshReceipt')}</Button>}
        {receipt && <>
          <h3>{t(stageKeys[receipt.status])}</h3>
          {receipt.status === 'unknown' && <p className={css.accountHint}>{t('executionUnknownHint')}</p>}
          <dl className={css.executionCoordinates}>
            <dt>{t('executionId')}</dt><dd>{receipt.id}</dd>
            <dt>{t('executionAction')}</dt><dd>{receipt.actionId}</dd>
            <dt>{t('executionRequestedAt')}</dt><dd>{time(receipt.admittedAt)}</dd>
            <dt>{t('executionUpdatedAt')}</dt><dd>{time(receipt.updatedAt)}</dd>
            <dt>{t('executionRequestId')}</dt><dd>{receipt.requestId}</dd>
            <dt>{t('executionConnectionVersion')}</dt><dd>{receipt.connectionRevision}</dd>
            <dt>{t('executionProviderVersion')}</dt><dd>{receipt.adapterRevision}</dd>
            {receipt.rejection && <><dt>{t('executionRejection')}</dt><dd>{t(receipt.rejection === 'denied' ? 'forbidden'
              : receipt.rejection === 'unauthorized' ? 'connectorUnauthorized'
                : receipt.rejection === 'not_accepted' ? 'executionNotAccepted' : receipt.rejection)}</dd></>}
          </dl>
          <section aria-label={t('executionStages')}>
            <h3>{t('executionStages')}</h3>
            <ol>{receipt.history.map((entry, index) => <li key={index}>
              {t(stageKeys[entry.stage])} · <time dateTime={new Date(entry.at).toISOString()}>{time(entry.at)}</time>
            </li>)}</ol>
          </section>
          {receipt.result && <section className={css.connectionRead} aria-label={t('executionResult')}>
            <h3>{t('executionResult')}</h3><p>{receipt.result.summary}</p>
            <dl>{receipt.result.entries.map((field, index) => <div key={index}>
              <dt>{field.label}</dt><dd>{field.value}</dd>
            </div>)}</dl>
          </section>}
        </>}
      </> : <>
        <Button disabled={snapshot.loading} onClick={() => { void props.openExecutionRecords(integrationId) }}>
          {t('executionRefresh')}
        </Button>
        {snapshot.error && <p role="alert">{t(snapshot.error)}</p>}
        {snapshot.loading && <p role="status">{t('loading')}</p>}
        {!snapshot.loading && !snapshot.error && !snapshot.entries.length && <p role="status">{t('executionEmpty')}</p>}
        {snapshot.entries.some(entry => entry.status === 'unknown') && <p className={css.accountHint}>{t('executionUnknownHint')}</p>}
        <ul className={css.executionList}>{snapshot.entries.map(entry => <li key={entry.id}>
          <strong>{entry.actionId}</strong> · {t(stageKeys[entry.status])}
          <p><time dateTime={new Date(entry.admittedAt).toISOString()}>{time(entry.admittedAt)}</time></p>
          <p className={css.accountHint}>{t('executionId')} · {entry.id}</p>
          <Button aria-label={t('executionViewId').replace('{id}', entry.id)}
            onClick={() => { void props.openExecutionDetail(entry.id) }}>{t('executionView')}</Button>
        </li>)}</ul>
        {snapshot.next && <Button disabled={snapshot.loading} onClick={() => { void props.loadMoreExecutions() }}>
          {t('executionOlder')}
        </Button>}
      </>}
    </div>
  </Modal>
}
