/** Native skills and task requests share discovery, while company systems retain their own readiness and management. */
import { useEffect, useId, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeIntegration, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import { matchesOfficeTool, nativeSkillCategory, officeTaskTemplates } from './tool-catalog.ts'
import type { OfficeToolCategory } from './tool-catalog.ts'
import { OfficeConnectionSummary } from './OfficeConnections.tsx'
import css from './OfficePage.module.css'

const categories: readonly (readonly [OfficeToolCategory, OfficeKey])[] = [
  ['all', 'toolsAll'], ['documents', 'toolsDocuments'], ['meetings', 'toolsMeetings'],
  ['processes', 'toolsProcesses'], ['systems', 'toolsSystems'], ['other', 'toolsOther'],
]
type Selection =
  | { readonly kind: 'skill'; readonly skill: SkillEntry }
  | { readonly kind: 'template'; readonly template: typeof officeTaskTemplates[number] }
  | { readonly kind: 'integration'; readonly integration: OfficeIntegration }

/** The selection form holds only this account's unsent requirements; native input adoption stays outside React. */
export function OfficeTools(props: OfficeProps & { office: OfficeView }) {
  const { t, office } = props
  const tools = props.useTools(value => value)
  const [category, setCategory] = useState<OfficeToolCategory>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [requirements, setRequirements] = useState('')
  const [requesting, setRequesting] = useState(false)
  const searchTarget = props.useSearch(state => state.target)
  useEffect(() => {
    if (searchTarget?.kind !== 'skill' || tools.sessionId !== searchTarget.sessionId) return
    const skill = tools.skills.find(skill => skill.name === searchTarget.skill.name)
    if (!skill) return
    setQuery('')
    setCategory('all')
    setSelected({ kind: 'skill', skill })
    setRequesting(false)
    props.consumeSearchTarget(searchTarget.key)
  }, [searchTarget, tools.sessionId, tools.skills, props.consumeSearchTarget])
  const requirementsId = useId()
  const skills = tools.skills.filter(skill => (category === 'all' || category === nativeSkillCategory(skill)) &&
    matchesOfficeTool(query, [skill.name, skill.description, skill.whenToUse ?? '']))
  const templates = officeTaskTemplates.filter(template => (category === 'all' || category === template.category) &&
    matchesOfficeTool(query, [t(template.title), t(template.description)]))
  const integrations = (office.integrations?.entries ?? []).filter(integration => (category === 'all' || category === 'systems') &&
    matchesOfficeTool(query, [integration.name, integration.system, integration.description, ...integration.capabilities]))
  const title = selected?.kind === 'skill' ? selected.skill.name : selected?.kind === 'template' ? t(selected.template.title)
    : selected?.integration.system ?? ''
  const description = selected?.kind === 'skill' ? selected.skill.description : selected?.kind === 'template'
    ? t(selected.template.description) : selected?.integration.description ?? ''
  const choose = (selection: Selection, request: boolean) => {
    props.cancelTool()
    setSelected(selection)
    setRequesting(request)
    setRequirements('')
  }
  const close = () => {
    props.cancelTool()
    setSelected(null)
  }
  const useSelected = async () => {
    if (!selected || selected.kind === 'integration' || !requirements.trim()) return
    const prepared = await props.useTool(selected.kind === 'skill'
      ? { kind: 'skill', name: selected.skill.name, requirements }
      : { kind: 'template', name: selected.template.id,
        prompt: `${t(selected.template.prompt)}\n\n${t('toolsRequirements')}:\n${requirements.trim()}` })
    if (prepared) setSelected(null)
  }
  return <>
    <div className={`${css.row} ${css.integrationHeader}`}>
      <h2>{t('toolsCatalog')}</h2>
      {office.customizations?.protocol === 1 && <>
        <Button onClick={() => { props.openCustomization() }}>{t('customizationSkill')}</Button>
        <Button onClick={() => { void props.openCustomizationRequests() }}>{t('customizationRequests')}</Button>
      </>}
      {office.automations?.protocol === 1 && props.openAutomations && props.automationTitle &&
        <Button onClick={props.openAutomations}>{props.automationTitle}</Button>}
      <Button onClick={props.openPlugins}>{t('toolsAddSkills')}</Button>
      <Button onClick={() => { props.navigate('integrations') }}>{t('toolsAddSystems')}</Button>
      <Button disabled={tools.loading || tools.preparing} onClick={props.loadTools}>{t('refresh')}</Button>
    </div>
    <p className={css.accountHint}>{t('toolsCatalogHint')}</p>
    <p className={css.accountHint}>{t(tools.sessionId ? 'toolsCurrentTarget' : 'toolsNoTarget')}</p>
    {!tools.sessionId && <Button onClick={() => { props.navigate('ai') }}>{t('toolsChooseConversation')}</Button>}
    <div className={css.row}>
      <Input type="search" className={css.integrationSearch ?? ''} aria-label={t('toolsSearch')}
        placeholder={t('toolsSearch')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
      <div className={css.row} role="group" aria-label={t('toolsCategories')}>
        {categories.map(([value, label]) => <Button key={value} size="sm" aria-pressed={category === value}
          variant={category === value ? 'primary' : 'ghost'}
          onClick={() => { setCategory(value) }}>{t(label)}</Button>)}
      </div>
    </div>
    {!selected && tools.error && <p className={css.error} role="alert">{t(tools.error)}</p>}
    {tools.loading && skills.length === 0 && <div className={css.toolsLoading}><progress aria-label={t('loading')} /></div>}
    <div className={css.integrationGrid}>
      {skills.map(skill => <article key={`skill:${skill.name}`} className={css.card} data-office-tool-kind="skill"
        aria-label={skill.name}>
        <p className={css.state}>{t('toolsNativeSkill')}</p><h3>{skill.name}</h3><p>{skill.description}</p>
        {!skill.modelInvocable && <p className={css.state}>{t('toolsUserOnly')}</p>}
        <div className={css.row}>
          <Button onClick={() => { choose({ kind: 'skill', skill }, false) }}>{t('toolsDetails')}</Button>
          <Button disabled={tools.loading || tools.preparing} onClick={() => { choose({ kind: 'skill', skill }, true) }}>
            {t('toolsUse')}
          </Button>
        </div>
      </article>)}
      {templates.map(template => <article key={`template:${template.id}`} className={css.card} data-office-tool-kind="template"
        aria-label={t(template.title)}>
        <p className={css.state}>{t('toolsTaskTemplate')}</p><h3>{t(template.title)}</h3><p>{t(template.description)}</p>
        <div className={css.row}>
          <Button onClick={() => { choose({ kind: 'template', template }, false) }}>{t('toolsDetails')}</Button>
          <Button disabled={tools.preparing} onClick={() => { choose({ kind: 'template', template }, true) }}>{t('toolsUse')}</Button>
        </div>
      </article>)}
      {integrations.map(integration => <article key={`integration:${integration.id}`} className={css.card}
        data-office-tool-kind="integration" aria-label={integration.system}>
        <p className={css.state}>{t('toolsCompanySystem')}</p><h3>{integration.system}</h3><p>{integration.description}</p>
        <OfficeConnectionSummary {...props} id={integration.id} administrator={false} />
        <Button onClick={() => { choose({ kind: 'integration', integration }, false) }}>{t('toolsDetails')}</Button>
      </article>)}
    </div>
    {!skills.length && !templates.length && !integrations.length && !tools.loading &&
      <div className={css.empty}><p>{t('toolsNoResults')}</p></div>}
    {selected && <Modal open title={title} closeLabel={t('close')} onClose={close}>
      <div className={css.form}>
        <p>{description}</p>
        {selected.kind === 'skill' && <>
          <p className={css.state}>{t(selected.skill.modelInvocable ? 'toolsNativeSkill' : 'toolsUserOnly')}</p>
          {selected.skill.whenToUse && <p>{selected.skill.whenToUse}</p>}
          {selected.skill.path && <p className={css.toolsPath}>{selected.skill.path}</p>}
        </>}
        {selected.kind === 'template' && <p className={css.accountHint}>{t('toolsTemplateHint')}</p>}
        {selected.kind === 'template' && selected.template.category === 'documents'
          && <p className={css.accountHint}>{t('toolsDocumentTemplateSource')}</p>}
        {selected.kind === 'integration' ? <>
          <p>{selected.integration.capabilities.join(' · ')}</p>
          <OfficeConnectionSummary {...props} id={selected.integration.id} administrator={false} />
          <p className={css.accountHint}>{t('toolsSystemHint')}</p>
          <div className={css.toolsActions}><Button onClick={() => { props.navigate('integrations') }}>{t('toolsManageSystem')}</Button></div>
        </> : requesting ? <form className={css.form} onSubmit={(event) => { event.preventDefault(); void useSelected() }}>
          <label htmlFor={requirementsId}>{t('toolsRequirements')}</label>
          <textarea id={requirementsId} value={requirements} data-modal-autofocus disabled={tools.preparing}
            placeholder={t('toolsRequirementsPlaceholder')} onChange={(event) => { setRequirements(event.target.value) }} />
          <p className={css.accountHint}>{t('toolsUnsentHint')}</p>
          {tools.error && <p role="alert" className={css.error}>{t(tools.error)}</p>}
          <div className={css.toolsActions}>
            <Button type="button" onClick={close}>{t('cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!requirements.trim() || tools.preparing}>{t('toolsPrepare')}</Button>
          </div>
        </form> : <div className={css.toolsActions}>
          <Button onClick={close}>{t('close')}</Button>
          <Button variant="primary" onClick={() => { setRequesting(true) }}>{t('toolsUse')}</Button>
        </div>}
      </div>
    </Modal>}
  </>
}
