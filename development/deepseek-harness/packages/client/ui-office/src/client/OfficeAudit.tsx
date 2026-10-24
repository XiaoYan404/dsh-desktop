/** Administrator filters and explicit pagination show only metadata returned by the current authenticated authority. */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeAuditRecord, OfficeAuditSource } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeAuditProps } from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import css from './OfficeAudit.module.css'

const sourceKeys: Record<OfficeAuditSource, OfficeKey> = { business: 'auditBusiness', identity: 'auditIdentity',
  organization: 'auditOrganization', drive: 'auditDrive', integration: 'auditIntegration', connection: 'auditConnection',
  request_denial: 'auditRequestDenial' }
const denialKeys: Record<NonNullable<OfficeAuditRecord['denialCode']>, OfficeKey> = {
  forbidden: 'auditDenialForbidden', not_found: 'auditDenialNotFound', conflict: 'auditDenialConflict',
  invalid_input: 'auditDenialInvalidInput', unauthenticated: 'auditDenialUnauthenticated',
}
type AuditProps = Pick<OfficeAuditProps, 't' | 'useAudit' | 'closeAudit' | 'fieldAudit' | 'searchAudit' | 'moreAudit' | 'exportAudit'>

/** One modal keeps query errors beside retained results and scopes downloads to every displayed row. */
export function OfficeAudit(props: AuditProps) {
  const { t } = props
  const snapshot = props.useAudit(value => value)
  if (!snapshot.open) return null
  const pending = snapshot.loading || snapshot.exporting
  return <Modal open title={t('auditTitle')} closeLabel={t('close')} onClose={props.closeAudit}
    className={css.dialog ?? ''} contentClassName={css.content ?? ''}>
    <div className={css.audit}>
      <p className={css.hint}>{t('auditScopeHint')}</p>
      <form className={css.filters} onSubmit={(event) => { event.preventDefault(); void props.searchAudit() }}>
        <label>{t('auditSource')}<select value={snapshot.filters.source}
          onChange={(event) => { props.fieldAudit('source', event.target.value) }}>
          <option value="">{t('auditAllSources')}</option>
          {Object.entries(sourceKeys).map(([source, key]) => <option key={source} value={source}>{t(key)}</option>)}
        </select></label>
        <label>{t('auditActor')}<Input value={snapshot.filters.actorId} maxLength={128}
          onChange={(event) => { props.fieldAudit('actorId', event.target.value) }} /></label>
        <label>{t('auditTarget')}<Input value={snapshot.filters.targetId} maxLength={128}
          onChange={(event) => { props.fieldAudit('targetId', event.target.value) }} /></label>
        <label>{t('auditAction')}<Input value={snapshot.filters.action} maxLength={100}
          onChange={(event) => { props.fieldAudit('action', event.target.value) }} /></label>
        <label>{t('auditSince')}<Input type="datetime-local" value={snapshot.filters.since}
          onChange={(event) => { props.fieldAudit('since', event.target.value) }} /></label>
        <label>{t('auditUntil')}<Input type="datetime-local" value={snapshot.filters.until}
          onChange={(event) => { props.fieldAudit('until', event.target.value) }} /></label>
        <div className={css.actions}>
          <Button type="submit" variant="primary" disabled={pending}>{t('auditApply')}</Button>
          <Button disabled={pending || snapshot.stale || !snapshot.entries.length}
            onClick={() => { void props.exportAudit() }}>{t(snapshot.exporting ? 'auditExporting' : 'auditDownload')}</Button>
        </div>
      </form>
      <div className={css.status} aria-live="polite">
        {snapshot.validation && <p role="alert">{t(snapshot.validation)}</p>}
        {snapshot.stale && <p role="alert">{t('auditChanged')}</p>}
        {snapshot.error && <div className={css.actions} role="alert"><p>{t(snapshot.error)}</p>
          <Button disabled={pending} onClick={() => {
            void (snapshot.entries.length && snapshot.next ? props.moreAudit() : props.searchAudit())
          }}>{t('retry')}</Button></div>}
        {snapshot.applied && <p>{t('auditDisplayed')}: {snapshot.entries.length} / {snapshot.total}</p>}
      </div>
      {snapshot.loading && <div role="status" aria-label={t('auditLoading')} className={css.skeleton}>
        <div /><div /><div />
      </div>}
      {!snapshot.loading && snapshot.applied && !snapshot.error && !snapshot.entries.length &&
        <p className={css.empty}>{t('auditEmpty')}</p>}
      {snapshot.entries.length > 0 && <div className={css.tableWrapper}>
        <table>
          <caption>{t('auditRecords')}</caption>
          <thead><tr><th>{t('auditTime')}</th><th>{t('auditSource')}</th><th>{t('auditActor')}</th>
            <th>{t('auditAction')}</th><th>{t('auditTarget')}</th><th>{t('auditRevision')}</th></tr></thead>
          <tbody>{snapshot.entries.map(entry => <tr key={`${entry.source}:${entry.revision}`}>
            <td><time dateTime={new Date(entry.time).toISOString()}>{new Date(entry.time).toISOString()}</time></td>
            <td>{t(sourceKeys[entry.source])}</td><td>{entry.actorId}</td><td>{entry.action}
              {entry.source === 'request_denial' && entry.denialCode && <> · {t(denialKeys[entry.denialCode])}</>}</td>
            <td>{entry.targetId}</td><td>{entry.revision}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {snapshot.next && <div className={css.actions}><Button disabled={pending || snapshot.stale}
        onClick={() => { void props.moreAudit() }}>{t('auditMore')}</Button></div>}
    </div>
  </Modal>
}
