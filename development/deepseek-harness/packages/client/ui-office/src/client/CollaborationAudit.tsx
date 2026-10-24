/** Combined metadata filters, continuation and reviewed exports use the original audit service and recipient authority. */
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeCollaborationProps } from './collaboration-contracts.ts'
import type { OfficeCollaborationSnapshot } from './collaboration-model.ts'
import { collaborationAuditSources, emptyAuditFields } from './collaboration-audit.ts'
import type { CollaborationKey } from './collaboration-copy.ts'
import css from './OfficeCollaboration.module.css'

type AuditControls = Pick<OfficeCollaborationProps, 't' | 'fieldCollaborationAudit' | 'searchCollaborationAudit' |
  'moreCollaborationAudit' | 'exportCollaborationAudit'>
const sourceLabels: Record<typeof collaborationAuditSources[number], CollaborationKey> = {
  business: 'collaborationAuditBusiness', identity: 'collaborationAuditIdentity', organization: 'collaborationAuditOrganization',
  drive: 'collaborationAuditDrive', integration: 'collaborationAuditIntegration', connection: 'collaborationAuditConnection',
  request_denial: 'collaborationAuditDenial', execution: 'collaborationAuditExecution', invitation: 'collaborationAuditInvitation',
  policy: 'collaborationAuditPolicy', group: 'collaborationAuditGroup', usage: 'collaborationAuditUsage',
}
const decisions = { allowed: 'collaborationDecisionAllowed', denied: 'collaborationDecisionDenied',
  reserved: 'collaborationDecisionReserved', dispatched: 'collaborationDecisionDispatched', confirmed: 'collaborationDecisionConfirmed',
  unknown: 'collaborationDecisionUnknown', cancelled: 'collaborationDecisionCancelled' } as const

/** @param props - Current authorized metadata and callbacks from the owning model. @returns Filterable, bounded audit controls. */
export function CollaborationAudit(props: AuditControls & { snapshot: OfficeCollaborationSnapshot }) {
  const { snapshot, t } = props
  const fields = snapshot.auditFilters ?? emptyAuditFields()
  const page = snapshot.audit
  const applied = snapshot.auditApplied
  const pending = snapshot.pending
  const available = snapshot.governance !== null
  return <section className={css.form} aria-label={t('collaborationAudit')}>
    <h3>{t('collaborationAudit')}</h3>
    <form className={css.form} aria-label={t('collaborationAuditFilters')} onSubmit={(event) => {
      event.preventDefault(); void props.searchCollaborationAudit()
    }}>
      <fieldset className={css.fields} disabled={pending || !available}>
        <fieldset><legend>{t('collaborationAuditSource')}</legend>
          <Button aria-pressed={fields.source === ''} onClick={() => { props.fieldCollaborationAudit('source', '') }}>{
            t('collaborationAuditAllSources')}</Button>
          {collaborationAuditSources.map(source => <Button key={source} aria-pressed={fields.source === source}
            onClick={() => { props.fieldCollaborationAudit('source', source) }}>{t(sourceLabels[source])}</Button>)}
        </fieldset>
        <div className={css.auditFields}>
          <label>{t('collaborationActor')}<Input value={fields.actorId} maxLength={128}
            onChange={(event) => { props.fieldCollaborationAudit('actorId', event.currentTarget.value) }} /></label>
          <label>{t('collaborationAuditTarget')}<Input value={fields.targetId} maxLength={128}
            onChange={(event) => { props.fieldCollaborationAudit('targetId', event.currentTarget.value) }} /></label>
          <label>{t('collaborationAuditAction')}<Input value={fields.action} maxLength={100}
            onChange={(event) => { props.fieldCollaborationAudit('action', event.currentTarget.value) }} /></label>
          <label>{t('collaborationAuditSince')}<Input type="datetime-local" value={fields.since}
            onChange={(event) => { props.fieldCollaborationAudit('since', event.currentTarget.value) }} /></label>
          <label>{t('collaborationAuditUntil')}<Input type="datetime-local" value={fields.until}
            onChange={(event) => { props.fieldCollaborationAudit('until', event.currentTarget.value) }} /></label>
        </div>
        <p>{t('collaborationAuditLocalTime')}</p>
        <Button type="submit" variant="primary">{t('collaborationAuditApply')}</Button>
      </fieldset>
    </form>
    <div aria-live="polite">
      {snapshot.auditValidation && <p role="alert">{t(snapshot.auditValidation)}</p>}
      {snapshot.auditStale && <p role="alert">{t('collaborationAuditChanged')}</p>}
      {snapshot.governanceErrors?.audit && <p role="alert">{t(snapshot.governanceErrors.audit)}</p>}
      {applied && page && <p>{t('collaborationAuditDisplayed')}: {page.entries.length} / {page.total}</p>}
    </div>
    <Button disabled={pending || !applied || !page?.entries.length || snapshot.auditStale === true}
      onClick={() => { void props.exportCollaborationAudit() }}>{t('collaborationAuditExportDisplayed')}</Button>
    {applied && page && <p>{t('collaborationAuditTime')}: {snapshot.preferences?.timeZone ?? 'UTC'}</p>}
    {applied && page && !page.entries.length && !pending && <p>{t('collaborationEmpty')}</p>}
    <ul className={css.list}>{page?.entries.map(entry => <li key={entry.key} className={css.item}>
      <time dateTime={new Date(entry.time).toISOString()}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'short',
        timeStyle: 'medium', timeZone: snapshot.preferences?.timeZone ?? 'UTC' }).format(entry.time)}</time>
      <p><code>{entry.action}</code> · {t('collaborationActor')}: {
        snapshot.members.find(member => member.id === entry.actorId)?.name ?? entry.actorId
      } · {t(decisions[entry.decision])}</p>
      <p>{t('collaborationAuditTarget')}: <code>{entry.targetId}</code></p>
    </li>)}</ul>
    {page?.next && <Button disabled={pending || !applied || snapshot.auditStale === true}
      onClick={() => { void props.moreCollaborationAudit() }}>{t('collaborationAuditMore')}</Button>}
  </section>
}
