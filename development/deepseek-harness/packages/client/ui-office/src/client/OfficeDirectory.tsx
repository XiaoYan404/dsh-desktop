/** Active employee contacts and the administrator's full, persistent team directory. */
import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  OfficeMember,
  OfficeMemberId,
  OfficeView,
  OfficeUnitId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import { affiliation, organizationMembers } from './organization.ts'
import { avatarInitial } from './values.ts'
import {
  OfficeAffiliationForm,
  OfficeOrganization,
  OfficeOrganizationTree,
} from './OfficeOrganization.tsx'
import css from './OfficePage.module.css'

type DirectoryProps = OfficeProps & {
  view: OfficeView
  onEdit(this: void, member: OfficeMember | null): void
  onCreate(
    this: void,
    kind: 'task' | 'todo' | 'schedule',
    memberId: OfficeMemberId,
  ): void
  onChat(this: void, memberId: OfficeMemberId): void
  onCredentials(this: void, member: OfficeMember): void
}

/** Management controls require an administrator view; mutations are checked again by the Host. */
export function OfficeDirectory(props: DirectoryProps) {
  const { view, t, actions, onEdit, onCreate, onChat } = props
  const query = props.useStore(state => state.query)
  const chats = props.useChat(state => state.view)
  const fileDrafts = props.useFileDrafts(state => state.contacts)
  const recentPeer = chats?.threads[0]?.peer.id ?? Object.values(fileDrafts).find(contact => contact.files.length > 0)?.peer?.id
  const central = props.useConnection(
    state => state.connection?.mode === 'gateway',
  )
  const canManage = props.section === 'team' && view.me.role === 'admin'
  const [selected, setSelected] = useState<OfficeUnitId | 'all' | 'unassigned'>(
    'all',
  )
  const [assignedMember, setAssignedMember] = useState<OfficeMember | null>(
    null,
  )
  const organization = view.organization
  const selection =
    selected === 'all' ||
    selected === 'unassigned' ||
    organization?.units.some(unit => unit.id === selected)
      ? selected
      : 'all'
  const branch =
    organization && selection !== 'all' && selection !== 'unassigned'
      ? organizationMembers(organization, selection)
      : null
  const source = canManage ? (view.managedMembers ?? []) : view.members
  const [detailId, setDetailId] = useState<OfficeMemberId | null>(null)
  const searchTarget = props.useSearch(state => state.target)
  useEffect(() => {
    if (searchTarget?.kind !== 'member' || !source.some(member => member.id === searchTarget.member.id)) return
    actions.setQuery('')
    setSelected('all')
    setDetailId(searchTarget.member.id)
    props.consumeSearchTarget(searchTarget.key)
  }, [searchTarget, source, actions, props.consumeSearchTarget])
  const detail = source.find(member => member.id === detailId)
  const detailLabels = detail && affiliation(organization, detail)
  useEffect(() => {
    if (detailId && !detail) setDetailId(null)
  }, [detailId, detail])
  useEffect(() => {
    if (!canManage) setAssignedMember(null)
  }, [canManage])
  const members = source.filter((member) => {
    const labels = affiliation(organization, member)
    const assignment = organization?.assignments.find(
      entry => entry.memberId === member.id,
    )
    return (
      (!branch || branch.has(member.id)) &&
      (selection !== 'unassigned' || !assignment?.unitId) &&
      `${member.id} ${member.name} ${labels.department} ${labels.jobTitle}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase())
    )
  })
  const group = (member: OfficeMember) =>
    organization
      ? (organization.assignments.find(entry => entry.memberId === member.id)
        ?.unitId ?? '')
      : member.department
  return (
    <>
      {canManage && <OfficeOrganization {...props} view={view} />}
      <div className={css.row}>
        <Input
          value={query}
          placeholder={t('search')}
          aria-label={t('search')}
          onChange={(event) => {
            actions.setQuery(event.target.value)
          }}
        />
        {recentPeer && <Button onClick={() => { onChat(recentPeer) }}>{t('chatHistory')}</Button>}
        {canManage && (
          <Button
            onClick={() => {
              onEdit(null)
            }}
          >
            {t('newMember')}
          </Button>
        )}
      </div>
      <div className={organization ? css.directoryLayout : undefined}>
        {organization && (
          <OfficeOrganizationTree
            organization={organization}
            selected={selection}
            onSelect={setSelected}
            t={t}
          />
        )}
        <div className={css.directory}>
          {members.length === 0 && (
            <p className={css.empty}>{t('noMembers')}</p>
          )}
          {[...new Set(members.map(group))].map(department => (
            <section key={department} className={css.card}>
              <h2>
                {organization
                  ? (organization.units.find(unit => unit.id === department)
                    ?.name ?? t('unassigned'))
                  : department || t('unassigned')}
              </h2>
              {members
                .filter(member => group(member) === department)
                .map(member => (
                  <div
                    key={member.id}
                    className={css.person}
                    data-office-member={member.id}
                  >
                    <span className={css.avatar}>
                      {avatarInitial(member.name)}
                    </span>
                    <div>
                      <Button
                        className={css.memberName ?? ''}
                        variant="ghost"
                        aria-label={`${t('memberDetails')} · ${member.name}`}
                        onClick={() => { setDetailId(member.id) }}
                      >{member.name}</Button>
                      <small>
                        {affiliation(organization, member).jobTitle ||
                          t('unassigned')}{' '}
                        · {t(member.role)}
                        {!member.active && ` · ${t('inactiveMember')}`}
                      </small>
                      <small>{member.email}</small>
                      {canManage && <small>{member.id}</small>}
                    </div>
                    <div className={css.row}>
                      {canManage && organization && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setAssignedMember(member)
                          }}
                        >
                          {t('affiliation')}
                        </Button>
                      )}
                      {canManage && central && member.active && (
                        <Button
                          size="sm"
                          onClick={() => {
                            props.onCredentials(member)
                          }}
                        >
                          {t('managePassword')}
                        </Button>
                      )}
                      {canManage && (
                        <Button
                          size="sm"
                          onClick={() => {
                            onEdit(member)
                          }}
                        >
                          {t('editMember')}
                        </Button>
                      )}
                      {member.active && member.id !== view.me.id && (
                        <Button
                          size="sm"
                          onClick={() => {
                            onChat(member.id)
                          }}
                        >
                          {t('newMessage')}
                        </Button>
                      )}
                      {member.active && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => {
                              onCreate('task', member.id)
                            }}
                          >
                            {t('newTask')}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              onCreate('schedule', member.id)
                            }}
                          >
                            {t('newSchedule')}
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => {
                              onCreate('todo', member.id)
                            }}
                          >
                            {t('newTodo')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
            </section>
          ))}
        </div>
      </div>
      {detail && detailLabels && (
        <Modal open title={t('memberDetails')} closeLabel={t('close')} onClose={() => { setDetailId(null) }}>
          <div className={css.form}>
            <div className={css.row}>
              <span className={css.avatar}>{avatarInitial(detail.name)}</span>
              <h2>{detail.name}</h2>
            </div>
            <dl>
              <dt>{t('department')}</dt><dd>{detailLabels.department || t('unassigned')}</dd>
              <dt>{t('jobTitle')}</dt><dd>{detailLabels.jobTitle || t('unassigned')}</dd>
              <dt>{t('role')}</dt><dd>{t(detail.role)}</dd>
              <dt>{t('email')}</dt><dd>{detail.email || t('contactNotProvided')}</dd>
              <dt>{t('phone')}</dt><dd>{detail.phone || t('contactNotProvided')}</dd>
              <dt>{t('status')}</dt><dd>{t(detail.active ? 'organizationActive' : 'inactiveMember')}</dd>
            </dl>
            {detail.active && (
              <div className={css.row}>
                {detail.id !== view.me.id && <Button onClick={() => { setDetailId(null); onChat(detail.id) }}>{t('newMessage')}</Button>}
                {(['task', 'schedule', 'todo'] as const).map(kind => (
                  <Button key={kind} onClick={() => { setDetailId(null); onCreate(kind, detail.id) }}>
                    {t(kind === 'task' ? 'newTask' : kind === 'schedule' ? 'newSchedule' : 'newTodo')}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
      {canManage && organization && assignedMember && (
        <OfficeAffiliationForm
          {...props}
          view={view}
          organization={organization}
          member={assignedMember}
          onClose={() => {
            setAssignedMember(null)
          }}
        />
      )}
    </>
  )
}
