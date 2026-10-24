/** Additive association controls above the original native input; execution remains owned by native permissions. */
import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { OfficeConversationId, OfficeConversationLinks, OfficeConversationLinksInput, OfficeIntegrationId,
  OfficeToolReference, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeAssociationsProps } from './contracts.ts'
import { officeConnectorStatusKeys } from './OfficeConnections.tsx'
import { matchesOfficeTool, officeTaskTemplates } from './tool-catalog.ts'
import css from './OfficePage.module.css'

type Selection = { readonly kind: 'integrations' | 'tools'; readonly initial: OfficeConversationLinks }
type Detail = { readonly kind: 'integration'; readonly id: OfficeIntegrationId }
  | { readonly kind: 'tool'; readonly tool: OfficeToolReference }
type ControlsProps = OfficeAssociationsProps & { readonly office: OfficeView; readonly target: OfficeConversationId }

/** Render only the native input actually observed for the current employee, including separately linked item inputs. */
export function OfficeAssociations(props: OfficeAssociationsProps) {
  const office = props.useOffice(value => value.view)
  const id = props.useSession(value => value.sessionId)
  const selected = props.useConversations(value => value.selected)
  const active = props.usePanelInfo(value => value.activePanelId === null || value.activePanelId === 'office.home')
  if (!office || !active || selected !== id) return null
  // A native identity becomes a logical office key; this conversion grants no native-session access.
  const target = String(id) as OfficeConversationId
  return <AssociationControls {...props} office={office} target={target} key={`${office.me.id}:${office.me.role}:${id}`} />
}

function AssociationControls(props: ControlsProps) {
  const { t, target } = props
  const snapshot = props.useAssociations(value => value)
  const tools = props.useTools(value => value)
  const connectors = props.useConnectors(value => value)
  const [editing, setEditing] = useState<Selection | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  useEffect(() => {
    props.loadAssociations(target)
    props.loadAssociationCatalog(props.sessionId)
  }, [target, props.sessionId, props.loadAssociations, props.loadAssociationCatalog])
  const view = snapshot.conversationId === target ? snapshot.view : null
  const selection = view?.selection
  const catalog = props.office.integrations?.entries ?? []
  const name = (tool: OfficeToolReference) => tool.kind === 'template'
    ? officeTaskTemplates.find(value => value.id === tool.name) : null
  const toolName = (tool: OfficeToolReference) => {
    const template = name(tool)
    return template ? t(template.title) : tool.name
  }
  const toolAvailable = (tool: OfficeToolReference) => tool.kind === 'template'
    ? name(tool) !== undefined && name(tool) !== null
    : tools.sessionId === props.sessionId && tools.skills.some(value => value.name === tool.name)
  const integrationName = (id: OfficeIntegrationId) => catalog.find(value => value.id === id)?.system ?? id
  const readiness = (id: OfficeIntegrationId) => {
    const entry = connectors.view?.entries.find(value => value.integrationId === id)
    return t(!connectors.view ? 'connectorUnavailable' : entry ? officeConnectorStatusKeys[entry.status] : 'connectorUnconfigured')
  }
  const dependencies = (tool: OfficeToolReference) => {
    const requirement = view?.requirements.find(value => value.tool.kind === tool.kind && value.tool.name === tool.name)
    const unlinked = requirement?.integrations.filter(id => !selection?.integrations.includes(id)) ?? []
    return <>
      {Boolean(requirement?.missing.length) && <p className={css.error}>{t('associationMissingIntegration', {
        names: requirement?.missing.join(' · ') ?? '',
      })}</p>}
      {unlinked.length > 0 && <p className={css.error}>{t('associationNotLinked', {
        names: unlinked.map(integrationName).join(' · '),
      })}</p>}
      {requirement?.integrations.map(id => <p key={id}>{integrationName(id)} · {readiness(id)}</p>)}
    </>
  }
  const edit = (kind: Selection['kind'], initial = selection) => {
    if (!initial) return
    setDetail(null)
    setEditing({ kind, initial })
    props.loadAssociationCatalog(props.sessionId)
  }
  const detailedIntegration = detail?.kind === 'integration' ? catalog.find(value => value.id === detail.id) : null
  const detailedSkill = detail?.kind === 'tool' && detail.tool.kind === 'skill'
    ? tools.skills.find(value => value.name === detail.tool.name) : null
  const detailedTemplate = detail?.kind === 'tool' ? name(detail.tool) : null
  return <section className={css.associations} aria-label={t('associationDetails')}>
    <div className={css.row}>
      <Button size="sm" disabled={!view || snapshot.busy} onClick={() => { edit('integrations') }}>{t('linkIntegrations')}</Button>
      <Button size="sm" disabled={!view || snapshot.busy} onClick={() => { edit('tools') }}>{t('linkTools')}</Button>
      <Button size="sm" variant="ghost" disabled={snapshot.loading || snapshot.busy}
        onClick={() => { props.loadAssociations(target); props.loadAssociationCatalog(props.sessionId) }}>{t('refresh')}</Button>
      {snapshot.loading && <span role="status">{t('loading')}</span>}
    </div>
    {!editing && snapshot.error && <p className={css.error} role="alert">{t(snapshot.error)}</p>}
    {selection && <div className={css.associationTags}>
      {selection.integrations.map(id => <div className={css.associationTag} key={id}>
        <Button size="sm" variant="ghost" onClick={() => { setDetail({ kind: 'integration', id }) }}>
          {integrationName(id)} · {readiness(id)}
        </Button>
        <Button size="sm" variant="ghost" aria-label={t('associationRemove', { name: integrationName(id) })}
          disabled={snapshot.busy} onClick={() => { edit('integrations', {
            ...selection, integrations: selection.integrations.filter(value => value !== id),
          }) }}>×</Button>
      </div>)}
      {selection.tools.map(tool => <div className={css.associationTag} key={`${tool.kind}:${tool.name}`}>
        <Button size="sm" variant="ghost" onClick={() => { setDetail({ kind: 'tool', tool }) }}>
          {toolAvailable(tool) ? toolName(tool) : t('associationUnknownTool', { name: toolName(tool) })}
        </Button>
        <Button size="sm" variant="ghost" aria-label={t('associationRemove', { name: toolName(tool) })}
          disabled={snapshot.busy} onClick={() => { edit('tools', {
            ...selection, tools: selection.tools.filter(value => value.kind !== tool.kind || value.name !== tool.name),
          }) }}>×</Button>
      </div>)}
      {!selection.integrations.length && !selection.tools.length && <span className={css.accountHint}>{t('associationNone')}</span>}
    </div>}
    {selection?.tools.map(tool => <div key={`${tool.kind}:${tool.name}`}>{dependencies(tool)}</div>)}
    {editing && view && <AssociationEditor {...props} selection={editing} current={view.selection} onClose={() => { setEditing(null) }} />}
    {detail && <Modal open title={t('associationDetails')} closeLabel={t('close')} className={css.detailDialog ?? ''}
      contentClassName={css.detailContent ?? ''} onClose={() => { setDetail(null) }}>
      <div className={css.form}>
        {detailedIntegration && <>
          <h3>{detailedIntegration.system}</h3><p>{detailedIntegration.description}</p>
          <p>{detailedIntegration.capabilities.join(' · ')}</p><p>{readiness(detailedIntegration.id)}</p>
        </>}
        {detail.kind === 'tool' && <>
          <h3>{toolName(detail.tool)}</h3>
          <p>{detailedTemplate ? t(detailedTemplate.description) : detailedSkill?.description ?? t('associationToolUnavailable')}</p>
          <h4>{t('associationDependencies')}</h4>
          {view?.requirements.some(value => value.tool.kind === detail.tool.kind && value.tool.name === detail.tool.name)
            ? dependencies(detail.tool) : <p>{t('associationNoDependencies')}</p>}
        </>}
        <p className={css.accountHint}>{t('associationReadOnlyHint')}</p>
        <Button onClick={() => { setDetail(null) }}>{t('close')}</Button>
      </div>
    </Modal>}
  </section>
}

function AssociationEditor(props: ControlsProps & {
  readonly selection: Selection
  readonly current: OfficeConversationLinks
  onClose(this: void): void
}) {
  const { t } = props
  const snapshot = props.useAssociations(value => value)
  const tools = props.useTools(value => value)
  const [reviewed, setReviewed] = useState(props.selection.initial)
  const [query, setQuery] = useState('')
  const [original, setOriginal] = useState<OfficeConversationLinksInput | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<typeof snapshot.error>(null)
  const kind = props.selection.kind
  const view = snapshot.view
  const changed = props.current.revision !== reviewed.revision
  const frozen = snapshot.busy || uncertain
  const integrations = (props.office.integrations?.entries ?? []).filter(value =>
    matchesOfficeTool(query, [value.name, value.system, value.description, ...value.capabilities]))
  const choices: readonly (OfficeToolReference & { readonly label: string; readonly description: string })[] = [
    ...tools.skills.map(value => ({ kind: 'skill' as const, name: value.name, label: value.name, description: value.description })),
    ...officeTaskTemplates.map(value => ({ kind: 'template' as const, name: value.id, label: t(value.title), description: t(value.description) })),
    ...reviewed.tools.filter(value => value.kind === 'skill' ? !tools.skills.some(skill => skill.name === value.name)
      : !officeTaskTemplates.some(template => template.id === value.name)).map(value => ({
      ...value, label: t('associationUnknownTool', { name: value.name }), description: t('associationToolUnavailable'),
    })),
  ]
  const filteredTools = choices.filter(value => matchesOfficeTool(query, [value.name, value.label, value.description]))
  const dependencies = kind === 'tools' ? view?.requirements.filter(requirement => reviewed.tools.some(tool =>
    tool.kind === requirement.tool.kind && tool.name === requirement.tool.name)) ?? [] : []
  const count = reviewed.tools.length + new Set([...reviewed.integrations,
    ...dependencies.flatMap(value => value.integrations)]).size
  const save = async () => {
    const input = original ?? { conversationId: props.target, revision: reviewed.revision, requestId: randomUUID(),
      ...(kind === 'tools' ? { kind, tools: reviewed.tools } : { kind, integrations: reviewed.integrations }) }
    setOriginal(input)
    setError(null)
    const result = await props.saveAssociations(input)
    if (result.ok) { props.onClose(); return }
    setUncertain(result.uncertain)
    setError(result.error)
    if (!result.uncertain) setOriginal(null)
  }
  const actions = <>
    <Button disabled={snapshot.busy} onClick={props.onClose}>{t('cancel')}</Button>
    {changed && !uncertain && <Button disabled={snapshot.busy} onClick={() => {
      setReviewed(props.current); setOriginal(null); setError(null)
    }}>{t('associationLoadLatest')}</Button>}
    <Button variant="primary" disabled={snapshot.busy || (changed && !uncertain)} onClick={() => { void save() }}>
      {t(uncertain ? 'associationRetryOriginal' : 'associationSave')}
    </Button>
  </>
  return <Modal open title={t(kind === 'tools' ? 'linkTools' : 'linkIntegrations')} closeLabel={t('close')}
    className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''} onClose={props.onClose} footer={actions}>
    <div className={css.form}>
      <p className={css.accountHint}>{t('associationReadOnlyHint')}</p>
      <Input type="search" aria-label={t('associationSearch')} placeholder={t('associationSearch')} value={query}
        onChange={(event) => { setQuery(event.target.value) }} />
      {kind === 'integrations' && !props.office.integrations && <p role="alert">{t('associationNoCatalog')}</p>}
      {kind === 'tools' && tools.loading && <p role="status">{t('loading')}</p>}
      {kind === 'tools' && tools.error && <p role="alert" className={css.error}>{t(tools.error)}</p>}
      <div className={css.associationChoices}>
        {kind === 'integrations' ? integrations.map(value => <div className={css.associationChoice} key={value.id}>
          <Checkbox className={css.check ?? ''} label={value.system} checked={reviewed.integrations.includes(value.id)} disabled={frozen}
            onChange={(checked) => { setOriginal(null); setReviewed({ ...reviewed, integrations: checked
              ? [...reviewed.integrations, value.id] : reviewed.integrations.filter(id => id !== value.id) }) }} />
          <small>{value.description}</small>
        </div>) : filteredTools.map(value => <div className={css.associationChoice} key={`${value.kind}:${value.name}`}>
          <Checkbox className={css.check ?? ''} label={value.label}
            checked={reviewed.tools.some(tool => tool.kind === value.kind && tool.name === value.name)}
            disabled={frozen} onChange={(checked) => { setOriginal(null); setReviewed({ ...reviewed, tools: checked
              ? [...reviewed.tools, { kind: value.kind, name: value.name }]
              : reviewed.tools.filter(tool => tool.kind !== value.kind || tool.name !== value.name) }) }} />
          <small>{t(value.kind === 'skill' ? 'associationSkill' : 'associationTemplate')} · {value.description}</small>
        </div>)}
        {(kind === 'integrations' ? integrations.length === 0 : filteredTools.length === 0) && <p>{t('associationNoResults')}</p>}
      </div>
      {dependencies.flatMap(value => value.missing).length > 0 && <p className={css.error}>{t('associationMissingIntegration', {
        names: [...new Set(dependencies.flatMap(value => value.missing))].join(' · '),
      })}</p>}
      <p>{t('associationSelectLimit', { count, max: view?.limits.maxSelected ?? 0 })}</p>
      {changed && !uncertain && <p role="alert">{t('associationChanged')}</p>}
      {error && <p role="alert" className={css.error}>{t(error)}</p>}
    </div>
  </Modal>
}
