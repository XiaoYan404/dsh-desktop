/** Presentation of the server's company-clock decision; absent decisions retain the older-server interface. */
import type { OfficeCalendarItemTime } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import css from './OfficePage.module.css'

type TimeBadgeProps = Pick<OfficeProps, 't'> & { readonly time: OfficeCalendarItemTime | undefined }

/**
 * Show a server-derived work warning or meeting phase without recalculating time.
 * @param props - Localized copy and the authorized item's optional server projection.
 * @returns A labelled time badge, or no addition for unexpired work and older servers.
 */
export function OfficeItemTimeBadge({ t, time }: TimeBadgeProps) {
  if (!time || (time.kind === 'work' && !time.overdue)) return null
  const key: OfficeKey = time.kind === 'unresolved' ? 'timeNeedsReview'
    : time.kind === 'work' ? 'workOverdue'
      : time.phase === 'upcoming' ? 'meetingUpcoming' : time.phase === 'ongoing' ? 'meetingOngoing' : 'meetingEnded'
  return <span className={css.timeBadge} data-office-time={time.kind === 'schedule' ? time.phase : time.kind === 'work' ? 'overdue' : 'unresolved'}
    aria-label={`${t('companyTimeStatus')}: ${t(key)}`}>{t(key)}</span>
}
