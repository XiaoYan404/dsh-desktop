/** Six additive scene entry points prepare real native conversations through injected callbacks. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeAssistantInput, OfficeExperienceView, OfficeScene } from '../../experience/types.ts'
import type { OfficeScenesProps, OfficeExperienceSettingsProps } from './contracts.ts'
import type { ExperienceKey } from './locales.ts'
import type { ExperienceSaveReview } from './model.ts'
import { SaveReviewNotice } from './SaveReviewNotice.tsx'
import css from './Experience.module.css'

const scenes = ['sales', 'documents', 'presentations', 'knowledge', 'quotes', 'projects'] as const
const hints: Record<OfficeScene, ExperienceKey> = { sales: 'salesHint', documents: 'documentsHint', presentations: 'presentationsHint',
  knowledge: 'knowledgeHint', quotes: 'quotesHint', projects: 'projectsHint' }

/** @param props - Registration-bound snapshots and native commands. @returns The home scene extension. */
export function OfficeScenes(props: OfficeScenesProps) {
  const { t } = props
  const state = props.useExperience(value => value)
  const [scene, setScene] = useState<OfficeScene | null>(null)
  const [assistant, setAssistant] = useState('')
  useEffect(() => { setScene(null); setAssistant('') }, [state.epoch])
  const view = state.view
  const pending = state.loading || state.busy || state.saveReview !== undefined
  const selectedAvailable = assistant === '' || view?.assistants.some(value => value.id === assistant && value.scene === scene && value.available)
  return <section className={css.section} data-office-density={view?.appearance.density} aria-label={t('title')} aria-busy={state.loading || state.busy}>
    <h2>{t('title')}</h2>
    <p className={css.hint}>{t('hint')}</p>
    {state.loading && !view && <progress aria-label={t('loading')} />}
    {!view && !state.loading && !state.error && <p role="status">{t('signInRequired')}</p>}
    {state.error && !state.saveReview && <p role="alert">{t(state.error)} <Button disabled={state.busy} onClick={() => { void props.loadExperience() }}>{t('retry')}</Button></p>}
    {state.saveReview && <SaveReviewNotice {...props} review={state.saveReview} busy={state.busy || state.loading} error={state.error} />}
    {state.error && !view && <p className={css.hint}>{t('configurationUnavailableHint')}</p>}
    <div className={css.grid}>
      {scenes.map(id => <button className={css.scene} key={id} type="button" disabled={!view || pending} aria-haspopup="dialog"
        onClick={() => { setAssistant(''); setScene(id) }}>
        <strong>{t(id)}</strong><span>{t(hints[id])}</span>
      </button>)}
    </div>
    {scene && view && <Modal open title={t(scene)} closeLabel={t('close')} onClose={() => { setScene(null) }}
      className={css.dialog ?? ''} contentClassName={css.dialogContent ?? ''}>
      <div className={`${css.section} ${css.form}`}>
        <p>{t('hint')}</p>
        <fieldset disabled={pending}><legend>{t('assistant')}</legend>
          <label><input type="radio" name="scene-assistant" data-modal-autofocus checked={assistant === ''}
            onChange={() => { setAssistant('') }} />{t('nativeDefault')}</label>
          {view.assistants.filter(value => value.scene === scene).map(value => <label key={value.id}>
            <input type="radio" name="scene-assistant" value={value.id} checked={assistant === value.id} disabled={!value.available}
              onChange={() => { setAssistant(value.id) }} />{value.name}{!value.available && ` · ${t('nativeUnavailable')}`}
          </label>)}
        </fieldset>
        {!view.assistants.some(value => value.scene === scene) && <p className={css.hint}>{t('noAssistants')}</p>}
        {!selectedAvailable && <p role="alert">{t('not_found')}</p>}
        {state.error && <p role="alert">{t(state.error)}</p>}
        {state.busy && <p role="status">{t('opening')}</p>}
        <Button variant="primary" disabled={pending || !selectedAvailable} onClick={() => {
          void props.startScene(scene, assistant || undefined).then((opened) => { if (opened) setScene(null) })
        }}>{t('start')}</Button>
      </div>
    </Modal>}
  </section>
}

type AssistantProps = Pick<OfficeExperienceSettingsProps, 't' | 'saveAssistant' | 'importAssistant' | 'exportAssistant' | 'startScene' | 'loadExperience'> & {
  readonly view: OfficeExperienceView
  readonly busy: boolean
  readonly error: ExperienceKey | null
  readonly saveReview?: ExperienceSaveReview | undefined
  readonly blocked?: boolean
}

/** @param props - Current saved assistants and account-fenced commands. @returns Persistent assistant authoring controls. */
export function OfficeAssistantSettings(props: AssistantProps) {
  const { t, view } = props
  const [draft, setDraft] = useState<OfficeAssistantInput | null>(null)
  const [reviewPhase, setReviewPhase] = useState<'idle' | 'review' | 'focus'>('idle')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (props.saveReview) setReviewPhase('review')
    else if (reviewPhase === 'review' && !props.busy && !props.error) {
      setReviewPhase('focus')
      setDraft(null)
    }
  }, [props.saveReview, props.busy, props.error, reviewPhase])
  useEffect(() => {
    if (reviewPhase === 'focus' && !draft) { heading.current?.focus(); setReviewPhase('idle') }
  }, [reviewPhase, draft])
  const blocked = Boolean(props.blocked || props.saveReview || reviewPhase !== 'idle')
  return <section className={css.section} aria-label={t('title')}>
    <h2 ref={heading} tabIndex={-1}>{t('title')}</h2><p className={css.hint}>{t('assistantHint')}</p>
    {!draft && props.saveReview && <SaveReviewNotice {...props} review={props.saveReview} />}
    <Button disabled={props.busy || blocked || !view.presets.some(value => value.available)} onClick={() => {
      setDraft({ id: null, name: '', scene: 'sales', basePreset: view.presets.find(value => value.available)?.id ?? '', instructions: '' })
    }}>{t('newAssistant')}</Button>
    {!view.presets.some(value => value.available) && <p role="status">{t('nativeUnavailable')}</p>}
    <label>{t('importAssistant')}<input className={css.file} type="file" accept="application/json,.json" disabled={props.busy || blocked}
      aria-describedby="office-assistant-import-hint" onChange={(event) => {
        const file = event.currentTarget.files?.[0] ?? null
        event.currentTarget.value = ''
        void props.importAssistant(file)
      }} /></label>
    <p id="office-assistant-import-hint" className={css.hint}>{t('importHint')}</p>
    {view.assistants.length === 0 && <p>{t('noAssistants')}</p>}
    {view.assistants.map(value => <article key={value.id} className={css.assistant}>
      <span>{value.name} · {t(value.scene)}{!value.available && <span role="status"> · {t('nativeUnavailable')}</span>}</span>
      <Button disabled={props.busy || blocked || !value.available} onClick={() => { void props.startScene(value.scene, value.id) }}>{t('start')}</Button>
      <Button disabled={props.busy || blocked} onClick={() => {
        const { presetId: _presetId, available: _available, ...assistant } = value
        setDraft(assistant)
      }}
      aria-label={`${t('edit')} ${value.name}`}>{t('edit')}</Button>
      <Button disabled={props.busy || blocked} onClick={() => { props.exportAssistant(value.id) }}
        aria-label={`${t('exportAssistant')} ${value.name}`}>{t('exportAssistant')}</Button>
    </article>)}
    {draft && <Modal open title={t(draft.id ? 'editAssistant' : 'newAssistant')} closeLabel={t('close')}
      onClose={() => { setDraft(null) }} className={css.dialog ?? ''} contentClassName={css.dialogContent ?? ''}>
      <form className={`${css.section} ${css.form}`} onSubmit={(event) => {
        event.preventDefault()
        if (props.busy || blocked) return
        void props.saveAssistant(draft).then((saved) => { if (saved) setDraft(null) })
      }}>
        <p className={css.hint}>{t('assistantHint')}</p>
        <label>{t('name')}<Input required maxLength={100} data-modal-autofocus value={draft.name} disabled={props.busy}
          onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }} /></label>
        <fieldset disabled={props.busy}><legend>{t('scene')}</legend>{scenes.map(value => <label key={value}>
          <input name="assistant-scene" type="radio" checked={draft.scene === value} onChange={() => { setDraft({ ...draft, scene: value }) }} />{t(value)}
        </label>)}</fieldset>
        <fieldset disabled={props.busy}><legend>{t('basePreset')}</legend>{view.presets.map(value => <label key={value.id}>
          <input type="radio" name="assistant-preset" required checked={draft.basePreset === value.id} disabled={!value.available}
            onChange={() => { setDraft({ ...draft, basePreset: value.id }) }} />{value.name}{!value.available && ` · ${t('nativeUnavailable')}`}
        </label>)}</fieldset>
        <label>{t('instructions')}<textarea maxLength={8000} value={draft.instructions} disabled={props.busy}
          onChange={(event) => { setDraft({ ...draft, instructions: event.target.value }) }} /></label>
        {props.error && !props.saveReview && <p role="alert">{t(props.error)}</p>}
        {props.saveReview && <SaveReviewNotice {...props} review={props.saveReview} />}
        {props.busy && <p role="status">{t('saving')}</p>}
        <div className={css.row}>
          <Button type="submit" variant="primary" disabled={props.busy || blocked || !draft.name.trim()
            || !view.presets.some(value => value.id === draft.basePreset && value.available)}>{t('save')}</Button>
          <Button onClick={() => { setDraft(null) }}>{t('cancel')}</Button>
        </div>
      </form>
    </Modal>}
  </section>
}
