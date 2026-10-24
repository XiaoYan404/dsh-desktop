/** One layout-owned popup serves integration and skill customization without an outbound delivery claim. */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeToastProps } from './contracts.ts'
import css from './OfficePage.module.css'

/** Forms receive private account-fenced snapshots and callbacks from their registration. */
export function OfficeCustomizations(props: OfficeToastProps) {
  const { t } = props
  const view = props.useCustomizations(value => value)
  if (!view.open) return null
  const locked = view.busy || view.uncertain || view.stale
  const draft = view.draft
  return <Modal open title={t(view.mode === 'list' ? 'customizationRequests' : 'customizationTitle')}
    closeLabel={t('close')} onClose={props.closeCustomization}
    className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}>
    <div className={css.form}>
      <p>{t('customizationHint')}</p>
      {view.error && <p role="alert">{t(view.error)}</p>}
      {view.stale && <p role="alert">{t('customizationStale')}</p>}
      {view.busy && <p role="status">{t('loading')}</p>}
      {view.mode === 'list' ? <>
        <div className={css.row}>
          <Button disabled={view.busy} onClick={() => { props.openCustomization() }}>{t('customizationNew')}</Button>
          <Button disabled={view.busy} onClick={() => { void props.openCustomizationRequests() }}>{t('refresh')}</Button>
        </div>
        {!view.busy && !view.entries.length && <p>{t('customizationEmpty')}</p>}
        {view.entries.map(entry => <article className={css.card} key={entry.id}>
          <h3>{entry.target}</h3>
          <p>{t('customizationVersion')} {entry.revision} · {t('customizationNotSent')}</p>
          <Button disabled={view.busy} onClick={() => { void props.editCustomization(entry.id) }}>{t('customizationEdit')}</Button>
        </article>)}
        {view.next !== null && <Button disabled={view.busy} onClick={() => { void props.moreCustomizations() }}>
          {t('customizationMore')}</Button>}
      </> : <>
        {draft && <form className={css.form} onSubmit={(event) => { event.preventDefault(); void props.saveCustomization() }}>
          <label>{t('customizationTarget')}<Input required maxLength={80} value={draft.target} disabled={locked}
            onChange={(event) => { props.fieldCustomization('target', event.target.value) }} /></label>
          <label>{t('customizationContact')}<Input required maxLength={80} value={draft.contact} disabled={locked}
            onChange={(event) => { props.fieldCustomization('contact', event.target.value) }} /></label>
          <label>{t('customizationRequirements')}<textarea required maxLength={8000} value={draft.requirements} disabled={locked}
            onChange={(event) => { props.fieldCustomization('requirements', event.target.value) }} /></label>
          {view.saved && <p role="status">{t('customizationSaved')} · {t('customizationVersion')} {view.saved.revision}</p>}
          <div className={css.row}>
            <Button type="submit" variant="primary" disabled={view.busy || view.stale
              || !draft.target.trim() || !draft.contact.trim() || !draft.requirements.trim() || view.saved !== null}>
              {t(view.uncertain ? 'customizationRetry' : 'save')}</Button>
            <Button disabled={!view.saved || locked} onClick={() => { void props.exportCustomization() }}>
              {t('customizationExport')}</Button>
            {view.stale && draft.id && <Button disabled={view.busy} onClick={() => {
              if (draft.id) void props.editCustomization(draft.id)
            }}>{t('customizationReload')}</Button>}
          </div>
        </form>}
        <Button disabled={view.busy} onClick={() => { void props.openCustomizationRequests() }}>{t('customizationRequests')}</Button>
      </>}
    </div>
  </Modal>
}
