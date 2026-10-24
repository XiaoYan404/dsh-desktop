/** Explicit, opt-in internal meeting checks discard results when the reviewed draft or identity changes. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeScheduleAvailability as Availability, OfficeScheduleAvailabilityInput,
  OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

type AvailabilityProps = Pick<OfficeProps, 't' | 'checkScheduleAvailability'> & OfficeScheduleAvailabilityInput & { view: OfficeView }
type CheckState = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; value: Availability }

/** Render a fresh query for each authenticated employee, reviewed revision and draft interval/member selection. */
export function OfficeScheduleAvailability(props: AvailabilityProps) {
  if (!props.view.scheduleAvailabilityEnabled) return null
  const key = JSON.stringify([props.view.me.id, props.view.me.role, props.view.revision, props.date, props.startTime,
    props.endTime, [...new Set(props.memberIds)].sort(), props.excludeItemId])
  return <AvailabilityQuery key={key} {...props} />
}

function AvailabilityQuery({ t, view, checkScheduleAvailability, ...input }: AvailabilityProps) {
  const [state, setState] = useState<CheckState>({ status: 'idle' })
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => { pending.current?.abort() }, [])
  const valid = Boolean(input.date && input.startTime && input.endTime && input.startTime < input.endTime && input.memberIds.length)
  const check = async () => {
    pending.current?.abort()
    const operation = new AbortController()
    pending.current = operation
    setState({ status: 'loading' })
    try {
      const value = await checkScheduleAvailability(input)
      if (!operation.signal.aborted) setState(value ? { status: 'ready', value } : { status: 'error' })
    } catch {
      if (!operation.signal.aborted) setState({ status: 'error' })
    }
  }
  return <section className={css.scheduleOverlaps} aria-label={t('scheduleAvailabilityTitle')}>
    <p>{t('scheduleAvailabilityScope')}</p>
    <Button disabled={!valid || state.status === 'loading'} onClick={() => { void check() }}>
      {state.status === 'loading' ? t('scheduleAvailabilityLoading') : t('scheduleAvailabilityCheck')}
    </Button>
    <div role="status" aria-live="polite">
      {state.status === 'error' && <p>{t('scheduleAvailabilityError')}</p>}
      {state.status === 'ready' && <>
        <p>{t('scheduleAvailabilityChecked')} · {new Intl.DateTimeFormat(undefined,
          { timeZone: state.value.timeZone, hour: '2-digit', minute: '2-digit' }).format(state.value.checkedAt)}</p>
        <ul>{state.value.members.map(member => <li key={member.memberId}>
          {view.members.find(entry => entry.id === member.memberId)?.name ?? member.memberId}
          {' · '}{t(member.busy ? 'scheduleAvailabilityBusy' : 'scheduleAvailabilityFree')}
        </li>)}</ul>
      </>}
    </div>
  </section>
}
