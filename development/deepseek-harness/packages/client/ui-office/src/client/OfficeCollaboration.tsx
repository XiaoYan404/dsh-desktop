/** Accessible recipient/group controls use original resource operations through injected callbacks. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Checkbox, Input, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { OfficeCollaborationProps } from './collaboration-contracts.ts'
import type { OfficeCollaborationSnapshot } from './collaboration-model.ts'
import type { CollaborationKey } from './collaboration-copy.ts'
import type { OfficeInboxSource, OfficeGroupAttachment, OfficeMessagePreferences }
  from '@deepseek-ai/dsh-enterprise-office/src/collaboration-types.ts'
import type { OfficeMemberId, OfficeDriveEntry } from '@deepseek-ai/dsh-enterprise-office/types'
import css from './OfficeCollaboration.module.css'
import { CollaborationAudit } from './CollaborationAudit.tsx'

const sources: ReadonlyArray<readonly [OfficeInboxSource, CollaborationKey]> = [['item', 'collaborationItem'], ['announcement',
  'collaborationAnnouncement'],
['reminder', 'collaborationReminder'], ['chat', 'collaborationChat'], ['group', 'collaborationGroup'], ['mention',
  'collaborationMention']]
type Controls = Omit<OfficeCollaborationProps, 'useCollaboration' | 'useGroupDrive'>

/** Preserve the overlay owner's identity epoch while keeping form drafts private to the mounted dialog. */
export function OfficeCollaboration(props: OfficeCollaborationProps) {
  const snapshot = props.useCollaboration(value => value)
  const drive = props.useGroupDrive(value => value.view)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const feedback = snapshot.feedback
  return <>
    {feedback && feedback.id !== dismissed && <Toast key={`feedback:${feedback.id}`} text={props.t(feedback.key)}
      {...feedback.success ? { tone: 'success' as const } : {}} onDone={() => { setDismissed(feedback.id) }} />}
    {snapshot.visible && <CollaborationDialog key={`dialog:${snapshot.epoch}`} {...props} snapshot={snapshot} files={drive?.entries ?? []}
      feedbackShowing={!!feedback && feedback.id !== dismissed} />}
  </>
}
function CollaborationDialog(props: Controls & {
  snapshot: OfficeCollaborationSnapshot
  feedbackShowing: boolean
  files: readonly Pick<OfficeDriveEntry,
    'id' | 'name' | 'kind'>[]
}) {
  const { snapshot, t } = props
  const [tab, setTab] = useState<'inbox' | 'groups' | 'preferences' | 'meetings' | 'governance'>('inbox')
  const labels = {
    inbox: 'collaborationInbox', groups: 'collaborationGroups', preferences: 'collaborationPreferences', meetings:
      'collaborationMeetings', governance: 'collaborationGovernance',
  } as const
  return <Modal open className={css.dialog} contentClassName={css.content}
    title={t('collaborationTitle')} closeLabel={t('collaborationClose')} onClose={props.closeCollaboration}>
    <div className={css.panel} aria-busy={snapshot.pending}>
      <nav className={css.row} aria-label={t('collaborationTitle')}>
        {(Object.keys(labels) as Array<keyof typeof labels>).filter(value => value !== 'governance' ||
          snapshot.principal?.role === 'admin').map(value =>
          <Button key={value} disabled={snapshot.pending} data-modal-autofocus={value === 'inbox' || undefined}
            aria-pressed={tab === value} onClick={() => {
            setTab(value)
            if(value === 'governance') void props.loadCollaborationGovernance()
          }}>{t(labels[value])}</Button>)}
      </nav>
      <div className={css.row}><Button disabled={snapshot.pending} onClick={props.refreshCollaboration}>{t('collaborationRefresh')}
      </Button>{snapshot.pending && <span role="status">{t('collaborationBusy')}</span>}</div>
      {snapshot.error && (!props.feedbackShowing || snapshot.feedback?.key !== snapshot.error) &&
        <p role="alert" className={css.notice}>{
        t(snapshot.error === 'collaborationNetwork' && !snapshot.preferences ? 'collaborationServiceUnavailable' : snapshot.error)
      }</p>}
      {tab === 'inbox' && <>
        <div className={css.row}><Button disabled={snapshot.pending} aria-pressed={snapshot.source === null} onClick={() => {
          void props.filterCollaboration(null,
            snapshot.unreadOnly)
        }}>{t('collaborationAll')}</Button>
        {sources.map(([source, label]) => <Button key={source} disabled={snapshot.pending}
          aria-pressed={snapshot.source === source} onClick={() => {
          void props.filterCollaboration(source, snapshot.unreadOnly)
        }}>{t(label)}</Button>)}
        <Checkbox disabled={snapshot.pending} label={t('collaborationUnread')} checked={snapshot.unreadOnly} onChange={(checked) => {
          void props.filterCollaboration(snapshot.source, checked)
        }} />
        </div>
        {!snapshot.pending && snapshot.inbox && !snapshot.inbox.entries.length && <p>{t('collaborationEmpty')}</p>}
        <ul className={css.list}>{snapshot.inbox?.entries.map(notice => <li key={notice.key} className={css.item}>
          <Button disabled={snapshot.pending} onClick={() => {
            void props.openCollaborationNotice(notice.key).then((opened) => {
              if(opened && (notice.source === 'group' || notice.source === 'mention')) setTab('groups')
            })
          }}><span>{notice.title}
            </span>
            <time dateTime={new Date(notice.time).toISOString()}>{new Intl.DateTimeFormat(undefined, {
              dateStyle: 'short', timeStyle:
                'short', timeZone: snapshot.preferences?.timeZone ?? 'UTC',
            }).format(notice.time)}</time></Button>
          {!notice.read && <div className={css.row}><Button disabled={snapshot.pending} onClick={() => {
            void props.openCollaborationNotice(notice.key, false)
          }}>{t('collaborationRead')}</Button>
          <Button disabled={snapshot.pending} onClick={() => { void props.retryCollaborationDesktop(notice.key) }}>{
            t('collaborationDesktopRetry')}</Button></div>}
        </li>)}</ul>
        {snapshot.inbox?.next && <Button disabled={snapshot.pending} onClick={() => { void props.moreCollaboration() }}>{
          t('collaborationMore')}</Button>}
      </>}
      <section hidden={tab !== 'preferences'}>{snapshot.preferences && <Preferences key={snapshot.preferences.revision}
        {...props} value={snapshot.preferences} />}</section>
      <section hidden={tab !== 'groups'}><Groups key={snapshot.group?.group.id ?? 'groups'} {...props} /></section>
      <section hidden={tab !== 'meetings'}><Meetings {...props} /></section>
      {snapshot.principal?.role === 'admin' && <section hidden={tab !== 'governance'}><Governance {...props} /></section>}
    </div>
  </Modal>
}
function Preferences(props: Controls & {
  snapshot: OfficeCollaborationSnapshot
  value: OfficeMessagePreferences
}) {
  const { t, value } = props
  const [draft, setDraft] = useState(value)
  const [invalid, setInvalid] = useState<CollaborationKey | null>(null)
  return <form className={css.form} onSubmit={(event) => {
    event.preventDefault()
    try { new Intl.DateTimeFormat('en', { timeZone: draft.timeZone }).format() }
    catch(_error) { setInvalid('collaborationZoneInvalid'); return }
    if(draft.quiet?.start === draft.quiet?.end && draft.quiet) { setInvalid('collaborationQuietInvalid'); return }
    setInvalid(null)
    void props.saveCollaborationPreferences(draft)
  }}>
    <fieldset disabled={props.snapshot.pending} className={css.fields}>
    <Checkbox label={t('collaborationDesktop')} checked={draft.desktop} onChange={(desktop) => { setDraft({ ...draft, desktop }) }} />
    <Button onClick={() => { void props.enableCollaborationDesktop() }}>{t('collaborationEnableDesktop')}</Button>
    <label>{t('collaborationTimeZone')}<Input required value={draft.timeZone} onChange={(event) => {
      setDraft({
        ...draft, timeZone:
          event.currentTarget.value,
      })
    }} /></label>
    <Checkbox label={t('collaborationQuiet')} checked={draft.quiet !== null} onChange={(enabled) => {
      setDraft({
        ...draft, quiet:
          enabled ? { start: '22:00', end: '07:00' } : null,
      })
    }} />
    {draft.quiet && <div className={css.row}>
      <label>{t('collaborationQuietStart')}<Input type="time" required value={draft.quiet.start} onChange={(event) => {
        setDraft({
          ...draft, quiet: draft.quiet ? { start: event.currentTarget.value, end: draft.quiet.end } : null,
        })
      }} /></label>
      <label>{t('collaborationQuietEnd')}<Input type="time" required value={draft.quiet.end} onChange={(event) => {
        setDraft({
          ...draft,
          quiet: draft.quiet ? { start: draft.quiet.start, end: event.currentTarget.value } : null,
        })
      }} /></label>
    </div>}
    <fieldset><legend>{t('collaborationPreferences')}</legend>{sources.map(([source, label]) => <Checkbox key={source} label={t(label)}
      checked={draft.sources.includes(source)}
      onChange={(checked) => {
        setDraft({
          ...draft, sources: checked ? [...draft.sources, source] :
            draft.sources.filter(value => value !== source),
        })
      }} />)}</fieldset>
    {invalid && <p role="alert">{t(invalid)}</p>}
    <Button type="submit">{t('collaborationSave')}</Button>
    </fieldset>
  </form>
}
function Groups(props: Controls & {
  snapshot: OfficeCollaborationSnapshot
  files: readonly Pick<OfficeDriveEntry,
    'id' | 'name' | 'kind'>[]
}) {
  const { snapshot, t } = props
  const [name, setName] = useState('')
  const [members, setMembers] = useState<OfficeMemberId[]>([])
  const pending = snapshot.pendingMessages?.find(value => value.groupId === snapshot.group?.group.id)
  const [text, setText] = useState(pending?.text ?? '')
  const [mentions, setMentions] = useState<OfficeMemberId[]>(pending?.mentions ?? [])
  const [attachments, setAttachments] = useState<OfficeGroupAttachment[]>(pending?.attachments ?? [])
  const [search, setSearch] = useState('')
  const [requestId, setRequestId] = useState(() => randomUUID())
  const [closeConfirmed, setCloseConfirmed] = useState(false)
  const [newOwner, setNewOwner] = useState<OfficeMemberId | null>(null)
  const [transferConfirmed, setTransferConfirmed] = useState(false)
  const current = snapshot.group?.group
  const messages = snapshot.group?.messages ?? []
  const more = snapshot.group?.next
  const send = async (event: FormEvent) => {
    event.preventDefault()
    if(current && await props.sendCollaborationMessage(current.id, text, mentions, attachments)) {
      setText(''); setMentions([])
      setAttachments([])
    }
  }
  return <div className={css.form}>
    <form onSubmit={(event) => {
      event.preventDefault(); void props.createCollaborationGroup({
        id: requestId, name, memberIds:
          members,
      },
      ).then((saved) => { if(saved) { setName(''); setMembers([]); setRequestId(randomUUID()) } })
    }}>
      <label>{t('collaborationName')}<Input required value={name} onChange={(event) => { setName(event.currentTarget.value) }}
      /></label>
      <fieldset><legend>{t('collaborationMembers')}</legend>{snapshot.members.filter(member => member.active &&
        member.id !== snapshot.principal?.id).map(member =>
        <Checkbox key={member.id} label={member.name} checked={members.includes(member.id)} onChange={(checked) => {
          setMembers(checked ? [...members, member.id] : members.filter(id => id !== member.id))
        }} />)}</fieldset>
      <Button type="submit" disabled={snapshot.pending || !snapshot.preferences || !members.length}>{t('collaborationCreate')}</Button>
    </form>
    <div className={css.row}>{snapshot.groups.map(group => <Button key={group.id} disabled={snapshot.pending} aria-pressed={
      group.id === current?.id}
    onClick={() => { setText(''); setMentions([]); setAttachments([]); void props.loadCollaborationGroup(group.id) }}>{group.name}
    </Button>)}</div>
    {current && <>
      <h3>{current.name}</h3>
      <div className={css.row}><Input aria-label={t('collaborationSearch')} value={search} onChange={(event) => {
        setSearch(event.currentTarget.value)
      }} />
      <Button disabled={snapshot.pending} onClick={() => { void props.loadCollaborationGroup(current.id, false, search) }}>{
        t('collaborationSearch')}</Button>
      {current.ownerId !== snapshot.principal?.id && <Button disabled={snapshot.pending} onClick={() => {
        void props.leaveCollaborationGroup()
      }}>{t('collaborationLeave')}</Button>}
      {current.ownerId === snapshot.principal?.id && <>
        <Checkbox disabled={snapshot.pending} label={t('collaborationConfirmCloseGroup')} checked={closeConfirmed}
          onChange={setCloseConfirmed} />
        <Button disabled={snapshot.pending || !closeConfirmed} onClick={() => {
        void props.updateCollaborationGroup({
          id: current.id, revision: current.revision, name: current.name,
          ownerId: current.ownerId, memberIds: current.members.map(member => member.memberId), closed: true,
        })
      }}>{
          t('collaborationCloseGroup')}</Button></>}
      </div>
      {current.ownerId === snapshot.principal?.id && !current.closed && <fieldset><legend>{t('collaborationMembers')}</legend>{
        snapshot.members.filter(member => member.active && member.id !== current.ownerId).map((member) => {
          const included = current.members.some(entry => entry.memberId === member.id)
          return <Checkbox key={member.id} disabled={snapshot.pending} label={member.name} checked={included} onChange={(checked) => {
            const ids = current.members.map(entry => entry.memberId)
            void props.updateCollaborationGroup({
              id: current.id, revision: current.revision, name: current.name, ownerId:
                current.ownerId, closed: false,
              memberIds: checked ? [...ids, member.id] : ids.filter(id => id !== member.id),
            })
          }} />
        })}</fieldset>}
      {current.ownerId === snapshot.principal?.id && !current.closed && <fieldset>
        <legend>{t('collaborationTransferOwner')}</legend>
        {current.members.filter(member => member.memberId !== current.ownerId && snapshot.members.some(value =>
          value.id === member.memberId && value.active)).map(member => <Button key={member.memberId}
          disabled={snapshot.pending} aria-pressed={newOwner === member.memberId} onClick={() => {
            setNewOwner(member.memberId); setTransferConfirmed(false)
          }}>{snapshot.members.find(value => value.id === member.memberId)?.name ?? member.memberId}</Button>)}
        <Checkbox disabled={snapshot.pending || !newOwner} label={t('collaborationConfirmTransfer')}
          checked={transferConfirmed} onChange={setTransferConfirmed} />
        <Button disabled={snapshot.pending || !newOwner || !transferConfirmed} onClick={() => {
          if(newOwner) void props.updateCollaborationGroup({ id: current.id, revision: current.revision, name: current.name,
            ownerId: newOwner, memberIds: current.members.map(member => member.memberId), closed: false,
          }).then(saved => { if(saved) { setNewOwner(null); setTransferConfirmed(false) } })
        }}>{t('collaborationTransferOwner')}</Button>
      </fieldset>}
      <ul className={css.list}>{[...messages].reverse().map(message => <li key={message.id} className={css.item}>
        <strong>{snapshot.members.find(member => member.id === message.senderId)?.name ?? message.senderId}</strong><p className={
          css.message}>{message.text}</p>
        {message.mentions.map(id => <span key={id}>@{snapshot.members.find(member => member.id === id)?.name ?? id} </span>)}
        {message.attachments.map(file => <Button key={`${file.fileId}:${file.versionId}`} disabled={snapshot.pending}
          onClick={() => { void props.downloadCollaborationFile(current.id, message.id, file) }}>{t('collaborationDownload')}
        </Button>)}
      </li>)}</ul>
      {more && <Button disabled={snapshot.pending} onClick={() => { void props.loadCollaborationGroup(current.id, true, search) }}>{
        t('collaborationMore')}</Button>}
      {!current.closed && <form onSubmit={(event) => { void send(event) }} className={css.form}>
        {pending && <p className={css.notice}>{t('collaborationDraftPending')}</p>}
        <fieldset className={css.fields} disabled={snapshot.pending || !!pending}>
        <label>{t('collaborationMessage')}<textarea value={text} maxLength={16000} onChange={(event) => {
          setText(event.currentTarget.value)
        }} /></label>
        <fieldset><legend>{t('collaborationMentions')}</legend>{
          current.members.filter(member => member.memberId !== snapshot.principal?.id).map(member =>
            <Checkbox key={member.memberId} label={
              snapshot.members.find(value => value.id === member.memberId)?.name ?? member.memberId}
            checked={mentions.includes(member.memberId)}
            onChange={(checked) => {
              setMentions(checked ? [...mentions, member.memberId] :
                mentions.filter(id => id !== member.memberId))
            }} />)}</fieldset>
        <fieldset><legend>{t('collaborationFiles')}</legend>{props.files.filter(file => file.kind === 'file').map(file => <Button key={
          file.id} disabled={snapshot.pending}
        onClick={() => {
          void props.resolveCollaborationFile(file.id).then((reference) => {
            if(reference) setAttachments(current => [...current.filter(value => value.fileId !== reference.fileId), reference])
          })
        }}>{file.name}</Button>)}</fieldset>
        {attachments.length > 0 && <ul className={css.list}>{attachments.map(file => <li key={file.fileId} className={css.row}>
          <span>{props.files.find(value => value.id === file.fileId)?.name ?? t('collaborationFiles')}</span>
          <Button aria-label={`${t('collaborationRemove')} ${props.files.find(value => value.id === file.fileId)?.name ??
            t('collaborationFiles')}`} onClick={() => {
            setAttachments(values => values.filter(value => value.fileId !== file.fileId))
          }}>{t('collaborationRemove')}</Button>
        </li>)}</ul>}
        </fieldset>
        <Button type="submit" disabled={snapshot.pending || !text.trim() && !attachments.length}>{
          t(pending ? 'collaborationRetry' : 'collaborationSend')}</Button>
      </form>}
    </>}
  </div>
}
function Meetings(props: Controls & { snapshot: OfficeCollaborationSnapshot }) {
  const { t, snapshot } = props
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('weekly')
  const [invitees, setInvitees] = useState<OfficeMemberId[]>([])
  const [id, setId] = useState(() => randomUUID())
  const [submitted, setSubmitted] = useState<Parameters<Controls['createCollaborationMeetings']>[0] | null>(null)
  const locked = submitted !== null && snapshot.error !== 'collaborationInvalid'
  return <form className={css.form} onSubmit={(event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const field = (name: string) => { const value = form.get(name); return typeof value === 'string' ? value : '' }
    const input = locked && submitted ? submitted : {
      id, frequency, interval: Number(field('interval')), count: Number(field('count')),
      timeZone: field('zone'),
      schedule: { title: field('title'), date: field('date'), startTime: field('start'), endTime: field('end'), inviteeIds: invitees },
    }
    setSubmitted(input)
    void props.createCollaborationMeetings(input).then((saved) => {
      if(saved) { setId(randomUUID()); setSubmitted(null) }
    })
  }}>
    {locked && <p className={css.notice}>{t('collaborationMeetingPending')}</p>}
    <fieldset className={css.fields} disabled={snapshot.pending || locked}>
    <label>{t('collaborationTitleField')}<Input name="title" required maxLength={200} /></label>
    <label>{t('collaborationDate')}<Input name="date" type="date" required /></label>
    <div className={css.row}><label>{t('collaborationStart')}<Input name="start" type="time" required /></label><label>{
      t('collaborationEnd')}<Input name="end" type="time" required /></label></div>
    <label>{t('collaborationTimeZone')}<Input name="zone" required defaultValue={snapshot.preferences?.timeZone ?? ''} /></label>
    <div className={css.row}><Button aria-pressed={frequency === 'daily'} onClick={() => { setFrequency('daily') }}>{
      t('collaborationDaily')}</Button><Button aria-pressed={frequency === 'weekly'} onClick={() => { setFrequency('weekly') }}>{
      t('collaborationWeekly')}</Button></div>
    <label>{t('collaborationInterval')}<Input name="interval" type="number" required min={1} max={52} defaultValue={1} /></label>
    <label>{t('collaborationCount')}<Input name="count" type="number" required min={1} max={366} defaultValue={2} /></label>
    <fieldset><legend>{t('collaborationMembers')}</legend>{snapshot.members.filter(member => member.active &&
      member.id !== snapshot.principal?.id).map(member =>
      <Checkbox key={member.id} label={member.name} checked={invitees.includes(member.id)} onChange={(checked) => {
        setInvitees(checked ? [...invitees, member.id] : invitees.filter(id => id !== member.id))
      }} />)}</fieldset>
    </fieldset>
    <Button type="submit" disabled={snapshot.pending || !snapshot.preferences}>{
      t(locked ? 'collaborationRetry' : 'collaborationCreate')}</Button>
  </form>
}
function Governance(props: Controls & { snapshot: OfficeCollaborationSnapshot }) {
  const { t, snapshot } = props
  const [target, setTarget] = useState<OfficeMemberId | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [requestId, setRequestId] = useState(() => randomUUID())
  const [restrictions, setRestrictions] = useState<AccessScope[]>([])
  const receipt = snapshot.governance?.members.find(member => member.memberId === target)
  const selected = snapshot.members.find(member => member.id === target)
  const restoring = receipt?.stage === 'revoked'
  const blocked = receipt?.stage === 'blocked'
  const disabled = snapshot.pending || !snapshot.governance
  return <div className={css.form}>
    {snapshot.governance && <AccessPolicy {...props} value={snapshot.governance.policy} />}
    <h3>{t('collaborationOffboard')}</h3>
    <fieldset disabled={disabled} className={css.fields}>
    <div className={css.row}>{snapshot.members.filter(member => member.id !== snapshot.principal?.id).map(member => <Button key={
      member.id} aria-pressed={target === member.id}
    onClick={() => {
      setTarget(member.id); setConfirmed(false); setRestrictions([]); setRequestId(randomUUID())
    }}>{member.name}</Button>)}</div>
    {target && <p className={css.notice}>{t(blocked ? 'collaborationCleanupBlocked' : restoring ? 'collaborationRevoked' :
      receipt?.stage === 'restored' ? 'collaborationRestored' : 'collaborationNoAccessRecord')}</p>}
    {restoring && <fieldset><legend>{t('collaborationRetainRestrictions')}</legend>
      {accessScopes.map(([scope, label]) => <Checkbox key={scope} label={t(label)} checked={restrictions.includes(scope)}
        onChange={checked => {
          setRestrictions(checked ? [...restrictions, scope] : restrictions.filter(value => value !== scope))
          setConfirmed(false)
        }} />)}
    </fieldset>}
    {restoring && !selected?.active && <p>{t('collaborationInactiveRestore')}</p>}
    <Checkbox label={t(restoring ? 'collaborationConfirmRestore' : 'collaborationConfirmOffboard')}
      checked={confirmed} onChange={setConfirmed} />
    {restoring ? <Button disabled={!target || !confirmed || !selected?.active} onClick={() => {
      if(target && receipt) void props.restoreCollaborationMember({ memberId: target, revision: receipt.revision,
        requestId, revokedScopes: restrictions }).then(saved => { if(saved) { setConfirmed(false); setRequestId(randomUUID()) } })
    }}>{t('collaborationRestore')}</Button> : <Button disabled={!target || !confirmed} onClick={() => {
      if(target) void props.offboardCollaborationMember({
        memberId: target,
        revision: receipt?.revision ?? 0,
        requestId: blocked && receipt.initiatedBy === snapshot.principal?.id ? receipt.requestId : requestId,
      }).then((saved) => {
        if(saved) { setConfirmed(false); setRequestId(randomUUID()) }
      })
    }}>{t(blocked ? 'collaborationCleanupRetry' : 'collaborationOffboard')}</Button>}
    </fieldset>
    <h3>{t('collaborationUsage')}</h3><p>{t('collaborationCoverage')}</p><p>{t('collaborationCostUnknown')}</p>
    {snapshot.governanceErrors?.usage && <p role="alert">{t(snapshot.governanceErrors.usage)}</p>}
    {snapshot.usage && <>
      <dl className={css.metrics}>
        <div><dt>{t('collaborationSettlements')}</dt><dd>{snapshot.usage.settlements}</dd></div>
        <div><dt>{t('collaborationMissingUsage')}</dt><dd>{snapshot.usage.missingUsage}</dd></div>
        {usageFields.map(([field, label]) => {
          const counter = snapshot.usage?.counters[field]
          return <div key={field}><dt>{t(label)}</dt><dd>{counter?.value ?? t('collaborationUnknown')}
            <small>{t('collaborationReported')}: {counter?.reported ?? 0}</small></dd></div>
        })}
      </dl>
    </>}
    <CollaborationAudit {...props} />
  </div>
}

const accessScopes = [
  ['office', 'collaborationScopeOffice'], ['files', 'collaborationScopeFiles'], ['connectors', 'collaborationScopeConnectors'],
  ['chat', 'collaborationScopeChat'], ['sessions', 'collaborationScopeSessions'],
] as const
type AccessScope = typeof accessScopes[number][0]
type CentralPolicy = Parameters<Controls['saveCollaborationPolicy']>[0]
const policyRoles = [['admin', 'collaborationRoleAdmin'], ['manager', 'collaborationRoleManager'],
  ['employee', 'collaborationRoleEmployee']] as const
const usageFields = [['inputTokens', 'collaborationInputTokens'], ['outputTokens', 'collaborationOutputTokens'],
  ['totalTokens', 'collaborationTotalTokens'], ['cacheReadTokens', 'collaborationCacheReadTokens'],
  ['cacheWriteTokens', 'collaborationCacheWriteTokens'], ['reasoningTokens', 'collaborationReasoningTokens']] as const
function AccessPolicy(props: Controls & { snapshot: OfficeCollaborationSnapshot; value: CentralPolicy | null }) {
  const { t, value, snapshot } = props
  const initial = (): CentralPolicy => value ?? { revision: 0, allowedRoles: {
    office: ['admin', 'manager', 'employee'], files: ['admin', 'manager', 'employee'],
    connectors: ['admin', 'manager', 'employee'], chat: ['admin', 'manager', 'employee'], sessions: ['admin', 'manager', 'employee'],
  } }
  const [draft, setDraft] = useState(initial)
  const [confirmed, setConfirmed] = useState(false)
  const stale = draft.revision !== (value?.revision ?? 0)
  return <form className={css.form} onSubmit={event => {
    event.preventDefault()
    if(!confirmed || stale || snapshot.pending) return
    void props.saveCollaborationPolicy(draft).then(saved => {
      if(saved) { setConfirmed(false); setDraft({ ...draft, revision: draft.revision + 1 }) }
    })
  }}>
    <h3>{t('collaborationAccess')}</h3>
    {!value && <p>{t('collaborationPolicyDefault')}</p>}
    {stale && <div className={css.notice} role="alert"><p>{t('collaborationPolicyChanged')}</p>
      <Button disabled={snapshot.pending} onClick={() => { setDraft(initial()); setConfirmed(false) }}>{
        t('collaborationLoadLatest')}</Button></div>}
    <fieldset disabled={snapshot.pending || stale} className={css.fields}>
      {accessScopes.map(([scope, label]) => <fieldset key={scope}><legend>{t(label)}</legend>
        {policyRoles.map(([role, roleLabel]) => <Checkbox key={role} label={t(roleLabel)}
          checked={draft.allowedRoles[scope].includes(role)} disabled={scope === 'office' && role === 'admin'}
          onChange={checked => {
            setDraft({ ...draft, allowedRoles: { ...draft.allowedRoles,
              [scope]: checked ? [...draft.allowedRoles[scope], role] : draft.allowedRoles[scope].filter(value => value !== role) } })
            setConfirmed(false)
          }} />)}
      </fieldset>)}
      <Checkbox label={t('collaborationConfirmPolicy')} checked={confirmed} onChange={setConfirmed} />
      <Button type="submit" disabled={!confirmed}>{t('collaborationSave')}</Button>
    </fieldset>
  </form>
}
