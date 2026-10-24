/** Local overlap advice never requests or infers another employee's private calendar. */
import type { OfficeItemId, OfficeMemberId, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import { officeScheduleOverlaps } from './schedule-overlaps.ts'
import css from './OfficePage.module.css'

type OverlapProps = Pick<OfficeProps, 't'> & {
  view: OfficeView
  date: string
  startTime: string
  endTime: string
  memberIds: readonly OfficeMemberId[]
  excludeId?: OfficeItemId
}

/** Render only overlaps present in the authorized view; submissions keep their own checks. */
export function OfficeScheduleOverlaps({ t, view, ...window }: OverlapProps) {
  const overlaps = officeScheduleOverlaps(view.items, window)
  return <section className={css.scheduleOverlaps} aria-label={t('scheduleOverlapTitle')}>
    <p>{t('scheduleOverlapScope')}</p>
    <div role="status" aria-live="polite">
      {overlaps.length > 0 && <>
        <p>{t('scheduleOverlapHint')}</p>
        <ul>{overlaps.map(({ item, memberIds }) => <li key={item.id}>
          <span>{item.title} · {item.time}–{item.endTime}</span>
          <span> · {memberIds.map(id => view.members.find(member => member.id === id)?.name ?? id).join(', ')}</span>
        </li>)}</ul>
      </>}
    </div>
  </section>
}
