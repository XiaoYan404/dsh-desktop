/** Home selections hand off to the existing native attachment and Session owners. */
import { useRef } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

/** Keep only draft text in the declared store and file metadata in the owner-provided hook. */
export function OfficeHomeInput(props: OfficeProps) {
  const { t, actions } = props
  const draft = props.useStore(state => state.draft)
  const home = props.useHomeInput(value => value)
  const picker = useRef<HTMLInputElement>(null)
  const start = async (submit: boolean) => {
    const sent = draft
    if (await props.startHome(sent, submit)) actions.clearDraft(sent)
  }
  return (
    <section className={clsx(css.card, css.composer)}>
      <div className={css.row}>
        <h2>{t('ai')}</h2>
        <Button disabled={home.preparing} onClick={() => { void start(false) }}>{t('expand')}</Button>
      </div>
      <textarea
        value={draft}
        placeholder={t('aiPrompt')}
        aria-label={t('aiPrompt')}
        disabled={home.preparing}
        onChange={(event) => { actions.setDraft(event.target.value) }}
        onKeyDown={(event) => {
          if (event.ctrlKey && event.key === 'Enter' && !event.nativeEvent.isComposing &&
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- Legacy IME Enter events report 229 without isComposing.
            event.nativeEvent.keyCode !== 229 && (draft.trim() || home.files.length > 0)) {
            event.preventDefault()
            void start(true)
          }
        }}
      />
      <input ref={picker} className={css.hiddenPicker} type="file" multiple aria-label={t('homeChooseFiles')} onChange={(event) => {
        props.addHomeFiles(Array.from(event.target.files ?? []))
        event.target.value = ''
      }} />
      {home.files.length > 0 && <ul className={css.homeFiles} aria-label={t('homeAttachments')}>
        {home.files.map(file => <li key={file.id}>
          <span>{file.name}<small>{new Intl.NumberFormat(undefined).format(file.byteLength)} B</small></span>
          <Button disabled={home.preparing} aria-label={`${t('homeRemoveAttachment')} · ${file.name}`} onClick={() => { props.removeHomeFile(file.id) }}>{t('homeRemoveAttachment')}</Button>
        </li>)}
      </ul>}
      {home.preparing && <progress aria-label={t('homePreparing')} />}
      {home.failed && <p className={css.error} role="alert">{t('homePreparationFailed')}</p>}
      <div className={css.row}>
        <Button disabled={home.preparing} onClick={() => { picker.current?.click() }}>{t('homeAttach')}</Button>
        {home.preparing && <Button onClick={props.cancelHome}>{t('cancel')}</Button>}
        <Button variant="primary" disabled={home.preparing || (!draft.trim() && home.files.length === 0)} onClick={() => { void start(true) }}>{t('send')}</Button>
      </div>
    </section>
  )
}
