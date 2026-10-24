/** Exact text-field configuration selects only current declared company operations; no arbitrary endpoint or actor input exists. */
import { useState } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeConnectorActionsView, OfficeIntegration, OfficeIntegrationId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeAutomationDraft } from './automation-model.ts'
import type { OfficeAutomationLabels } from './automation-copy.ts'
import css from './OfficeAutomations.module.css'

/**
 * Render one exact rule form; account and editor lifetime are owned by the surrounding controller.
 * @param props - Current declarations, visible systems, exact draft, localized copy and callbacks.
 * @returns A reviewable configuration form; saving creates no trigger binding or external side effect.
 */
export function OfficeAutomationEditor(props: { readonly initial: OfficeAutomationDraft
  readonly directory: OfficeConnectorActionsView
  readonly systems: readonly OfficeIntegration[]
  readonly labels: OfficeAutomationLabels
  readonly busy: boolean
  readonly error?: string | null
  readonly saveUncertain?: boolean
  readonly refresh?: () => void
  readonly close: () => void
  readonly selectSystem: (id: OfficeIntegrationId, draft: OfficeAutomationDraft) => void
  readonly save: (draft: OfficeAutomationDraft) => void }) {
  const [draft, setDraft] = useState(props.initial)
  const { labels, directory } = props
  const declarations = directory.actions.filter(value => value.kind === 'write')
  const foreignCompensation = draft.compensation !== null && draft.compensation.integrationId !== draft.action.integrationId
  const locked = props.busy || props.saveUncertain === true
  function validAction(part: 'action' | 'compensation') {
    const value = draft[part]
    if (!value) return part === 'compensation'
    if (part === 'compensation' && foreignCompensation) return true
    const declaration = declarations.find(item => item.id === value.actionId)
    const fields = declaration?.fields ?? []
    return !!declaration && value.integrationId === directory.integrationId &&
      value.connectionRevision === directory.connectionRevision && value.adapterRevision === directory.adapterRevision &&
      Object.keys(value.values).every(name => fields.some(field => field.name === name)) &&
      fields.every(field => (!field.required || !!value.values[field.name]?.trim()) &&
        (value.values[field.name]?.length ?? 0) <= field.maxLength)
  }
  const valid = !!draft.title.trim() && !!draft.trigger.source.trim() && validAction('action') && validAction('compensation')
  function selected(part: 'action' | 'compensation', id: string) {
    const declaration = declarations.find(value => value.id === id)
    if (!declaration) {
      if (part === 'compensation') setDraft(value => ({ ...value, compensation: null }))
      return
    }
    setDraft(value => ({ ...value, [part]: { integrationId: directory.integrationId,
      connectionRevision: directory.connectionRevision, adapterRevision: directory.adapterRevision ?? '', actionId: id,
      values: Object.fromEntries((declaration.fields ?? []).map(field => [field.name, ''])) } }))
  }
  function fields(part: 'action' | 'compensation') {
    const action = draft[part]
    const declaration = declarations.find(value => value.id === action?.actionId)
    if (!action || !declaration) return null
    if (!declaration.fields?.length) return <p>{labels.noFields}</p>
    return declaration.fields.map(field => <label className={css.field} key={part + field.name}>{field.label}
      <Input value={action.values[field.name] ?? ''} maxLength={field.maxLength} required={field.required}
        onChange={(event) => {
          const text = event.target.value
          setDraft((value) => {
            const current = value[part]
            return current ? { ...value, [part]: { ...current, values: { ...current.values, [field.name]: text } } } : value
          })
        }} />
    </label>)
  }
  return <Modal open title={labels.edit} closeLabel={labels.close} onClose={props.close}
    className={css.dialog ?? ''} contentClassName={css.content ?? ''}>
    <form className={css.form} aria-busy={props.busy} onSubmit={(event) => {
      event.preventDefault()
      if (!locked && valid) props.save(draft)
    }}>
      {props.error && <p role="alert" className={css.notice}>{props.error}</p>}
      {props.saveUncertain && <p role="status" className={css.notice}>{labels.saveUncertain}</p>}
      <fieldset disabled={locked} className={css.fields}>
        <label className={css.field}>{labels.ruleTitle}<Input required maxLength={200} value={draft.title}
          onChange={(event) => { setDraft({ ...draft, title: event.target.value }) }} /></label>
        <label className={css.field}>{labels.system}<select value={draft.action.integrationId}
          onChange={(event) => {
            const system = props.systems.find(value => value.id === event.target.value)
            if (system) props.selectSystem(system.id, draft)
          }}>
          {!props.systems.some(system => system.id === draft.action.integrationId) &&
          <option value={draft.action.integrationId}>{draft.action.integrationId}</option>}
          {props.systems.map(system => <option key={system.id} value={system.id}>{system.system}</option>)}</select></label>
        <label className={css.field}>{labels.trigger}<select value={draft.trigger.kind} onChange={(event) => {
          const kind = event.target.value
          if (kind === 'form' || kind === 'event' || kind === 'webhook' || kind === 'schedule')
            setDraft({ ...draft, trigger: { ...draft.trigger, kind } })
        }}>
          <option value="form">{labels.formTrigger}</option><option value="event">{labels.eventTrigger}</option>
          <option value="webhook">{labels.webhookTrigger}</option><option value="schedule">{labels.scheduleTrigger}</option>
        </select></label>
        <label className={css.field}>{labels.source}<Input required maxLength={200} value={draft.trigger.source}
          onChange={(event) => { setDraft({ ...draft, trigger: { ...draft.trigger, source: event.target.value } }) }} /></label>
        <p className={css.hint}>{draft.trigger.kind === 'form' ? labels.sourceSharedHint : labels.sourceHint}</p>
        <fieldset className={css.phase}><legend>{labels.primary}</legend>
          <label className={css.field}>{labels.action}<select value={draft.action.actionId}
            onChange={(event) => { selected('action', event.target.value) }}>
            {!declarations.some(action => action.id === draft.action.actionId) &&
          <option value={draft.action.actionId}>{labels.selectAction} · {draft.action.actionId}</option>}
            {declarations.map(action => <option key={action.id} value={action.id}>{action.label}</option>)}
          </select></label>
          {fields('action')}
          {!validAction('action') && <Button onClick={() => { selected('action', draft.action.actionId) }}>{labels.resetFields}</Button>}
        </fieldset>
        <fieldset className={css.phase}><legend>{labels.compensation}</legend>
          <label className={css.field}>{labels.compensation}<select value={draft.compensation?.actionId ?? ''} disabled={foreignCompensation}
            onChange={(event) => { selected('compensation', event.target.value) }}>
            {foreignCompensation && draft.compensation
              ? <option value={draft.compensation.actionId}>{draft.compensation.integrationId} · {draft.compensation.actionId}</option>
              : <>
                <option value="">{labels.none}</option>
                {draft.compensation && !declarations.some(action => action.id === draft.compensation?.actionId) &&
          <option value={draft.compensation.actionId}>{labels.selectAction} · {draft.compensation.actionId}</option>}
                {declarations.map(action => <option key={action.id} value={action.id}>{action.label}</option>)}
              </>}
          </select></label>
          {foreignCompensation && draft.compensation ? <>
            <p className={css.hint}>{labels.externalCompensation}</p>
            <dl className={css.details}>{Object.entries(draft.compensation.values).map(([name, value]) =>
              <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
            <Button onClick={() => { setDraft({ ...draft, compensation: null }) }}>{labels.removeCompensation}</Button>
          </> : fields('compensation')}
          {draft.compensation && !validAction('compensation') && <Button onClick={() => {
            selected('compensation', draft.compensation?.actionId ?? '')
          }}>{labels.resetFields}</Button>}
        </fieldset>
        <Checkbox label={labels.enable} checked={draft.enabled}
          onChange={(checked) => { setDraft({ ...draft, enabled: checked }) }} />
      </fieldset>
      {!valid && <p className={css.hint}>{labels.invalidFields}</p>}
      <div className={css.actions}>
        <Button variant="primary" type="submit" disabled={locked || !valid}>{labels.save}</Button>
        {(props.error || props.saveUncertain) && props.refresh &&
        <Button disabled={props.busy} onClick={props.refresh}>{labels.refresh}</Button>}
        <Button disabled={props.busy} onClick={props.close}>{labels.close}</Button>
      </div>
    </form>
  </Modal>
}
