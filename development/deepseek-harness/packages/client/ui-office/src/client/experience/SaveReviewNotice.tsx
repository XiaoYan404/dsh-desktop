/** Persistent write uncertainty stays beside the retained draft and its explicit read action. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeExperienceSettingsProps } from './contracts.ts'
import type { ExperienceSaveReview } from './model.ts'
import type { ExperienceKey } from './locales.ts'
import css from './Experience.module.css'

type ReviewProps = Pick<OfficeExperienceSettingsProps, 't' | 'loadExperience'> & {
  readonly review: ExperienceSaveReview
  readonly busy: boolean
  readonly error: ExperienceKey | null
}

/** @param props - Retained outcome, localized copy and the existing read command. @returns A read-only recovery action. */
export function SaveReviewNotice({ t, loadExperience, review, busy, error }: ReviewProps) {
  return <div className={css.form} role="alert">
    <p>{t(review.confirmation === 'confirmed' ? 'saveConfirmedReview' : 'saveUncertainReview')}</p>
    <p>{t(review.kind === 'assistant' ? 'assistantReviewHint' : 'appearanceReviewHint')}</p>
    {error && <p>{t(error)}</p>}
    <Button disabled={busy} onClick={() => { void loadExperience() }}>{t('reviewSavedConfiguration')}</Button>
  </div>
}
