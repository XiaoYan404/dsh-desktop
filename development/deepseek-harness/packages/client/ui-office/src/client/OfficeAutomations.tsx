/** Private automation rule/run presentation; all behavior and authenticated calls remain in the owning controller. */
import { useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeAutomationRule, OfficeAutomationRun, OfficeAutomationRunId } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeAutomationResponse } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeIntegration } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeAutomationLabels } from './automation-copy.ts'
import css from './OfficeAutomations.module.css'

type Review = Extract<OfficeAutomationResponse, { readonly kind: 'review' }>['review']
/** Existing Office owner supplies current data, localized errors and lifecycle-bound callbacks. */
export interface OfficeAutomationsProps {
  readonly labels: OfficeAutomationLabels
  readonly rules: readonly OfficeAutomationRule[]
  readonly runs: readonly OfficeAutomationRun[]
  readonly busy: boolean
  readonly available?: boolean
  readonly needsRefresh?: boolean
  readonly systems?: readonly Pick<OfficeIntegration, 'id' | 'system'>[]
  readonly error: string | null
  readonly review: Review | null
  readonly createRule: () => void
  readonly editRule: (rule: OfficeAutomationRule) => void
  readonly toggleRule: (rule: OfficeAutomationRule) => void
  readonly triggerForm: (rule: OfficeAutomationRule) => void
  readonly refresh: () => void
  readonly reviewRun: (id: OfficeAutomationRunId, part: 'primary' | 'compensation') => void
  readonly confirmReview: (review: Review) => void
  readonly closeReview: () => void
  readonly manageRun: (run: OfficeAutomationRun, command: 'cancel' | 'compensate' | 'retry') => void
  readonly recoverRun: (id: OfficeAutomationRunId, part: 'primary' | 'compensation') => void
}

/**
 * Render private rules, failure/recovery controls and an exact separate review for primary or compensation writes.
 * @param props - Authenticated controller data and already localized labels; no transport or scheduler is created here.
 * @returns Presentation suitable for the existing Office automation slot after its shared entry is integrated.
 */
export function OfficeAutomations(props: OfficeAutomationsProps) {
  const { labels, review } = props
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const runs = props.runs.filter(run => !needle || [run.rule.title, run.id, run.rule.trigger.source, run.occurrence,
    run.primary.requestId, run.primary.executionId ?? '', run.compensation?.requestId ?? '', run.compensation?.executionId ?? '']
    .some(value => value.toLowerCase().includes(needle))).toSorted((left, right) => right.admittedAt - left.admittedAt)
  const locked = props.busy || props.needsRefresh === true || props.available === false
  const triggers = { form: labels.formTrigger, event: labels.eventTrigger,
    webhook: labels.webhookTrigger, schedule: labels.scheduleTrigger }
  const rejections = { denied: labels.rejectionDenied, not_accepted: labels.rejectionNotAccepted,
    unauthorized: labels.rejectionUnauthorized, rate_limited: labels.rejectionRateLimited, invalid_input: labels.rejectionInvalidInput }
  function systemName(id: string) { return props.systems?.find(system => system.id === id)?.system ?? id }
  function phaseDetails(phase: OfficeAutomationRun['primary'], part: 'primary' | 'compensation') {
    return <>
      <div><dt>{labels[part]}</dt><dd>{labels.states[phase.stage]}</dd></div>
      <div><dt>{labels[part]} · {labels.requestId}</dt><dd>{phase.requestId}</dd></div>
      <div><dt>{labels[part]} · {labels.executionId}</dt><dd>{phase.executionId ?? labels.noExecutionId}</dd></div>
    </>
  }
  return <section aria-label={labels.title} aria-busy={props.busy} className={css.panel}>
    <div className={css.toolbar}><h2>{labels.title}</h2><div className={css.actions}>
      <Button disabled={locked} onClick={props.createRule}>{labels.newRule}</Button>
      <Button disabled={props.busy} onClick={props.refresh}>{labels.refresh}</Button>
    </div></div>
    {props.error && <p role="alert" className={css.notice}>{props.error}</p>}
    {props.needsRefresh && <p role="status" className={css.notice}>{labels.refreshRequired}</p>}
    <h3>{labels.rulesTitle}</h3>
    {props.available !== false && !props.rules.length && <p>{labels.noRules}</p>}
    <ul aria-label={labels.rulesTitle} className={css.list}>{props.rules.map(rule => <li className={css.card} key={rule.id}>
      <strong>{rule.title} · {rule.enabled ? labels.enabled : labels.disabled}</strong>
      <p className={css.meta}>{triggers[rule.trigger.kind]} · {rule.trigger.source} · {systemName(rule.action.integrationId)}</p>
      {rule.trigger.kind === 'form' && <p className={css.hint}>{labels.sourceSharedHint}</p>}
      {rule.trigger.kind !== 'form' && <p className={css.hint}>{labels.sourceHint}</p>}
      <div className={css.actions}>
        <Button disabled={locked} onClick={() => { props.editRule(rule) }}>{labels.edit}</Button>
        <Button disabled={locked} onClick={() => { props.toggleRule(rule) }}>{rule.enabled ? labels.disable : labels.enable}</Button>
        {rule.trigger.kind === 'form' && <Button disabled={locked || !rule.enabled}
          onClick={() => { props.triggerForm(rule) }}>{labels.startForm}</Button>}
      </div>
    </li>)}</ul>
    <h3>{labels.runsTitle}</h3>
    <label className={css.field}>{labels.runFilter}<Input value={query}
      onChange={(event) => { setQuery(event.target.value) }} /></label>
    {props.available !== false && !props.runs.length && <p role="status">{labels.empty}</p>}
    {!!props.runs.length && !runs.length && <p role="status">{labels.noMatchingRuns}</p>}
    <ul aria-label={labels.runsTitle} className={css.list}>{runs.map((run) => {
      const part = run.compensation ? 'compensation' : 'primary'
      const phase = run.compensation ?? run.primary
      const unknown = phase.stage === 'unknown' || phase.stage === 'running'
      const current = props.rules.find(rule => rule.id === run.rule.id)
      const eligible = current?.enabled && current.revision === run.rule.revision
      return <li className={css.card} key={run.id}>
        <strong>{run.rule.title}</strong> · {labels[part]} · {labels.states[phase.stage]}
        {run.compensation && <p>{labels.primary} · {labels.states[run.primary.stage]}</p>}
        <p className={css.meta}>{triggers[run.rule.trigger.kind]} · {run.rule.trigger.source}</p>
        {!eligible && <p className={css.hint}>{labels.ruleChanged}</p>}
        {phase.rejection && <p>{labels.rejection} · {rejections[phase.rejection]}</p>}
        {unknown && <p role="status" className={css.notice}>{labels.unknownHint}</p>}
        <details><summary>{labels.details}</summary><dl className={css.details}>
          <div><dt>{labels.runId}</dt><dd>{run.id}</dd></div>
          <div><dt>{labels.revision}</dt><dd>{run.revision}</dd></div>
          <div><dt>{labels.occurrence}</dt><dd>{run.occurrence}</dd></div>
          {run.parentId && <div><dt>{labels.parentRun}</dt><dd>{run.parentId}</dd></div>}
          {phaseDetails(run.primary, 'primary')}
          {run.compensation && phaseDetails(run.compensation, 'compensation')}
        </dl></details>
        <div className={css.actions}>
          {unknown && <Button disabled={props.busy} onClick={() => { props.recoverRun(run.id, part) }}>{labels.recover}</Button>}
          {phase.stage === 'pending_approval' && <>
            <Button disabled={locked || !eligible} onClick={() => { props.reviewRun(run.id, part) }}>{labels.review}</Button>
            <Button disabled={locked} onClick={() => { props.manageRun(run, 'cancel') }}>{labels.cancel}</Button>
          </>}
          {(phase.stage === 'rejected' || phase.stage === 'cancelled') &&
          <Button disabled={locked || !eligible} onClick={() => { props.manageRun(run, 'retry') }}>{labels.retry}</Button>}
          {!run.compensation && phase.stage === 'succeeded' && run.rule.compensation &&
          <Button disabled={locked || !eligible} onClick={() => { props.manageRun(run, 'compensate') }}>{labels.compensate}</Button>}
        </div>
      </li>
    })}</ul>
    {review && <Modal open title={labels.review} closeLabel={labels.close} onClose={props.closeReview}
      className={css.dialog ?? ''} contentClassName={css.content ?? ''} footer={<>
        <Button disabled={locked} onClick={() => { props.confirmReview(review) }}>{labels.confirm}</Button>
        <Button disabled={props.busy} onClick={props.closeReview}>{labels.close}</Button>
      </>}>
      <p>{labels.reviewHint}</p>
      <p>{labels[review.part]} · {review.action.actionId}</p>
      <dl className={css.details}>
        <div><dt>{labels.system}</dt><dd>{systemName(review.action.integrationId)}</dd></div>
        <div><dt>{labels.runId}</dt><dd>{review.runId}</dd></div>
        <div><dt>{labels.requestId}</dt><dd>{review.requestId}</dd></div>
        <div><dt>{labels.revision}</dt><dd>{review.revision}</dd></div>
        <div><dt>{labels.connectionRevision}</dt><dd>{review.action.connectionRevision}</dd></div>
        <div><dt>{labels.adapterRevision}</dt><dd>{review.action.adapterRevision}</dd></div>
      </dl>
      {!Object.keys(review.action.values).length && <p>{labels.noFields}</p>}
      <dl className={css.details}>{Object.entries(review.action.values).map(([name, value]) =>
        <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
    </Modal>}
  </section>
}
