/** Office appearance, real assistant authoring and platform limits inside the existing Settings shell. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeAppearance } from '../../experience/types.ts'
import { mobileAddress } from '../../experience/validation.ts'
import type { OfficeExperienceSettingsProps } from './contracts.ts'
import { OfficeAssistantSettings } from './Scenes.tsx'
import type { ExperienceKey } from './locales.ts'
import type { ExperienceSaveReview } from './model.ts'
import { SaveReviewNotice } from './SaveReviewNotice.tsx'
import css from './Experience.module.css'

type AppearanceProps = Pick<OfficeExperienceSettingsProps, 't' | 'saveAppearance' | 'loadExperience'> & {
  readonly initial: OfficeAppearance
  readonly revision: number
  readonly busy: boolean
  readonly blocked: boolean
  readonly saveReview?: ExperienceSaveReview | undefined
  readonly error: ExperienceKey | null
}

interface AppearanceDraft {
  readonly values: OfficeAppearance
  readonly reviewed: OfficeAppearance
}

function sameAppearance(left: OfficeAppearance, right: OfficeAppearance): boolean {
  return left.companyName === right.companyName && left.monogram === right.monogram
    && left.brand === right.brand && left.scheme === right.scheme && left.density === right.density
    && left.mobileUrl === right.mobileUrl
}

function AppearanceForm({ t, initial, revision, busy, saveAppearance, loadExperience, blocked, saveReview, error }: AppearanceProps) {
  const [draft, setDraft] = useState<AppearanceDraft | null>(null)
  const [mobileTouched, setMobileTouched] = useState(false)
  const companyInput = useRef<HTMLInputElement>(null)
  const reviewPending = useRef(false)
  useEffect(() => {
    if (saveReview) reviewPending.current = true
    else if (reviewPending.current && !busy && !error) {
      reviewPending.current = false
      setDraft(null); setMobileTouched(false); companyInput.current?.focus()
    }
  }, [saveReview, busy, error])
  const saveBlocked = blocked || reviewPending.current
  const appearance = draft?.values ?? initial
  const dirty = !sameAppearance(appearance, initial)
  const changedElsewhere = draft !== null && !sameAppearance(draft.reviewed, initial)
  const edit = (values: OfficeAppearance) => { setDraft(current => ({ values, reviewed: current?.reviewed ?? initial })) }
  let invalidMobile = false
  try { mobileAddress(appearance.mobileUrl) }
  catch (_error) { invalidMobile = true }
  const choices = <K extends 'brand' | 'scheme' | 'density'>(key: K, values: readonly (readonly [OfficeAppearance[K], ExperienceKey])[]) =>
    <fieldset disabled={busy}><legend>{t(key)}</legend>{values.map(([value, label]) => <label key={value}>
      <input type="radio" name={`office-${key}`} checked={appearance[key] === value} onChange={() => { edit({ ...appearance, [key]: value }) }} />{t(label)}
    </label>)}</fieldset>
  return <form className={css.form} aria-label={t('appearance')} aria-busy={busy}
    aria-describedby={changedElsewhere ? 'office-appearance-conflict' : undefined} onSubmit={(event) => {
    event.preventDefault()
    if (busy || saveBlocked || !dirty || invalidMobile || changedElsewhere) return
    void saveAppearance(appearance, revision).then((saved) => { if (saved) { setDraft(null); setMobileTouched(false) } })
  }}>
    <h2>{t('appearance')}</h2><p className={css.hint}>{t('appearanceHint')}</p>
    <label>{t('companyName')}<Input ref={companyInput} maxLength={100} value={appearance.companyName} disabled={busy}
      onChange={(event) => { edit({ ...appearance, companyName: event.target.value }) }} /></label>
    <label>{t('monogram')}<Input maxLength={8} value={appearance.monogram} disabled={busy}
      onChange={(event) => { edit({ ...appearance, monogram: event.target.value }) }} /></label>
    {choices('brand', [['default', 'defaultBrand'], ['blue', 'blue'], ['green', 'green'], ['violet', 'violet']])}
    {choices('scheme', [['inherit', 'inherit'], ['light', 'light'], ['dark', 'dark']])}
    {choices('density', [['comfortable', 'comfortable'], ['compact', 'compact']])}
    <p className={css.hint}>{t('offline')}</p>
    <label>{t('mobileUrl')}<Input type="url" maxLength={2048} value={appearance.mobileUrl} disabled={busy}
      aria-invalid={invalidMobile || undefined} onBlur={() => { setMobileTouched(true) }}
      aria-describedby={invalidMobile && mobileTouched ? 'office-mobile-address-hint office-mobile-address-error' : 'office-mobile-address-hint'}
      onChange={(event) => { edit({ ...appearance, mobileUrl: event.target.value }) }} /></label>
    <p id="office-mobile-address-hint" className={css.hint}>{t('mobileHint')}</p>
    {invalidMobile && mobileTouched && <p id="office-mobile-address-error" role="alert">{t('mobileInvalid')}</p>}
    <section className={css.preview} aria-label={t('appearancePreview')}
      data-office-scheme={appearance.scheme === 'inherit' ? undefined : appearance.scheme}
      data-office-density={appearance.density} data-office-brand={appearance.brand}>
      <h3>{t('appearancePreview')}</h3>
      <div className={css.previewIdentity}>
        {appearance.monogram && <span className={css.monogram}>{appearance.monogram}</span>}
        <strong>{appearance.companyName || t('appearance')}</strong>
      </div>
      <div className={css.previewScene}><strong>{t('sales')}</strong><p>{t('salesHint')}</p></div>
      <p className={css.hint}>{t('previewHint')}</p>
    </section>
    {saveReview && <SaveReviewNotice t={t} loadExperience={loadExperience} review={saveReview} busy={busy} error={error} />}
    {changedElsewhere && !saveReview && <p id="office-appearance-conflict" role="alert">{t('appearanceChanged')}</p>}
    {dirty && <p role="status">{t('unsavedChanges')}</p>}
    <div className={css.row}>
      <Button type="submit" variant="primary" disabled={busy || saveBlocked || !dirty || invalidMobile || changedElsewhere}>{t('save')}</Button>
      <Button disabled={busy || saveBlocked || (!dirty && !changedElsewhere)} onClick={() => {
        setDraft(null); setMobileTouched(false); companyInput.current?.focus()
      }}>{t(changedElsewhere ? 'loadLatestAppearance' : 'restoreSaved')}</Button>
    </div>
  </form>
}

/** @param props - Renderer-bound sources and commands. @returns The office Settings section. */
export function OfficeExperienceSettings(props: OfficeExperienceSettingsProps) {
  const { t } = props
  const state = props.useExperience(value => value)
  const maintenance = props.useMaintenance(value => value)
  const view = state.view
  return <div className={css.section} data-office-scheme={view?.appearance.scheme === 'inherit' ? undefined : view?.appearance.scheme}
    data-office-density={view?.appearance.density} data-office-brand={view?.appearance.brand} aria-busy={state.busy || state.loading}>
    {state.loading && !view && <progress aria-label={t('loading')} />}
    {!view && !state.loading && !state.error && <p role="status">{t('signInRequired')}</p>}
    {state.error && !state.saveReview && <p role="alert">{t(state.error)} <Button disabled={state.busy} onClick={() => { void props.loadExperience() }}>{t('retry')}</Button></p>}
    {state.error && !view && <p className={css.hint}>{t('configurationUnavailableHint')}</p>}
    {state.saved && <p role="status">{t('saved')}</p>}
    {view && <>
      <AppearanceForm key={state.epoch} t={t} initial={view.appearance} revision={view.revision}
        busy={state.busy || state.loading} blocked={state.saveReview !== undefined}
        saveReview={state.saveReview?.kind === 'appearance' ? state.saveReview : undefined} error={state.error}
        saveAppearance={props.saveAppearance} loadExperience={props.loadExperience} />
      <OfficeAssistantSettings {...props} startScene={async (scene, id) => {
        const opened = await props.startScene(scene, id)
        if (opened) props.close()
        return opened
      }} view={view} busy={state.busy || state.loading} error={state.error} blocked={state.saveReview !== undefined}
      saveReview={state.saveReview?.kind === 'assistant' ? state.saveReview : undefined} />
    </>}
    <section className={css.form} aria-label={t('terminal')}>
      <h2>{t('terminal')}</h2>
      <p>{t('mobileLimit')}</p>
      {view?.appearance.mobileUrl ? <a href={view.appearance.mobileUrl} target="_blank" rel="noopener noreferrer">{t('openMobile')}: {view.appearance.mobileUrl}</a>
        : <p>{t('mobileUnset')}</p>}
      <p className={css.hint}>{t('mobileHint')}</p>
      <p role="status">{t(maintenance.connected ? 'connected' : 'disconnected')}</p>
      <div className={css.row}>
        <Button onClick={props.openDesktopUpdate} disabled={!maintenance.desktop || maintenance.busy}>{t('desktopUpdate')}</Button>
        <Button onClick={props.reconnect}>{t('reconnect')}</Button>
        <Button onClick={props.downloadDiagnostics}>{t('diagnostics')}</Button>
      </div>
      {maintenance.failed && <p role="alert">{t('desktopFailure')}</p>}
      {!maintenance.desktop && <p className={css.hint}>{t('desktopUnavailable')}</p>}
      <p className={css.hint}>{t('reconnectHint')}</p><p className={css.hint}>{t('diagnosticHint')}</p>
      {maintenance.desktop && <p className={css.hint}>{t('recoveryHint')}</p>}
    </section>
  </div>
}
