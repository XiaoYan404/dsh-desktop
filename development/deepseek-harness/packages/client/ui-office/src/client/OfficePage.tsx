/** Employee workbench presentation. All business state arrives from registered hooks. */
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import clsx from 'clsx'
import {
  Button,
  Checkbox,
  Input,
  Modal,
  Toast,
  IconBrowseOutlineRegular,
  IconNewChatOutlineRegular,
  IconUsersOutlineRegular,
  IconFolderCloseRegular,
  IconChecklistOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconSkillOutlineRegular,
  IconSettingsOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  OfficeItem,
  OfficeItemId,
  OfficeItemStatus,
  OfficeMember,
  OfficeMemberId,
  OfficeView,
  OfficeAnnouncementId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type {
  OfficeNavigationProps,
  OfficeProps,
  OfficeToastProps,
  SelectedMember,
} from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import { OfficeItemDetail } from './OfficeItemDetail.tsx'
import { OfficeItemTimeBadge } from './OfficeItemTimeBadge.tsx'
import { OfficeScheduleEditForm } from './OfficeScheduleEditForm.tsx'
import { OfficeWorkEditForm } from './OfficeWorkEditForm.tsx'
import { OfficeWorkSubtasksForm } from './OfficeWorkSubtasksForm.tsx'
import { OfficeWorkAttachmentsForm } from './OfficeWorkAttachments.tsx'
import { priorityKeys } from './item-priority.ts'
import { OfficeScheduleOverlaps } from './OfficeScheduleOverlaps.tsx'
import { OfficeScheduleAvailability } from './OfficeScheduleAvailability.tsx'
import { OfficeNotifications } from './OfficeNotifications.tsx'
import { OfficeAnnouncementCard, OfficeAnnouncementDetails, OfficeAnnouncementManager } from './OfficeAnnouncements.tsx'
import { officeInbox } from './inbox.ts'
import { OfficeDirectory } from './OfficeDirectory.tsx'
import { OfficeMemberForm } from './OfficeMemberForm.tsx'
import { OfficeChat } from './OfficeChat.tsx'
import { OfficeDrive } from './OfficeDrive.tsx'
import { OfficeIntegrations } from './OfficeIntegrations.tsx'
import { OfficeTools } from './OfficeTools.tsx'
import { OfficeHomeInput } from './OfficeHomeInput.tsx'
import { OfficeHomeNativeInput } from './OfficeHomeConversation.tsx'
import { OfficeProfileForm } from './OfficeProfileForm.tsx'
import {
  OfficeAccount,
  OfficeCredentials,
  OfficeLogin,
} from './OfficeAccount.tsx'
import { avatarInitial, formText } from './values.ts'
import { affiliation } from './organization.ts'
import { officeItemStatuses as states } from './item-status.ts'
import { officeWorkList, shiftOfficeDate } from './work-list.ts'
import css from './OfficePage.module.css'

const navigation = [
  ['home', IconBrowseOutlineRegular],
  ['ai', IconNewChatOutlineRegular],
  ['contacts', IconUsersOutlineRegular],
  ['drive', IconFolderCloseRegular],
  ['work', IconChecklistOutlineRegular],
  ['integrations', IconCordisPluginOutlineRegular],
  ['tools', IconSkillOutlineRegular],
] as const

export function OfficeNavigation({
  t,
  usePanelInfo,
  useNavigation,
  navigate,
  sidebarCollapsed,
  collapseSidebar,
}: OfficeNavigationProps) {
  const panel = usePanelInfo(state => state.activePanelId)
  const waiting = useNavigation(state => state.waiting)
  useEffect(() => {
    if (panel?.startsWith('office.') && !sidebarCollapsed) collapseSidebar()
  }, [panel, sidebarCollapsed, collapseSidebar])
  return (
    <nav className={css.rail} aria-label={t('home')}>
      <div className={css.railMain}>
        {navigation.map(([id, Icon]) => (
          <button
            key={id}
            className={css.railButton}
            type="button"
            aria-busy={id === 'ai' && waiting ? true : undefined}
            aria-current={
              (id === 'ai' ? panel === null : panel === `office.${id}`)
                ? 'page'
                : undefined
            }
            onClick={() => {
              navigate(id)
            }}
          >
            <Icon size={22} />
            <span>{t(id)}</span>
          </button>
        ))}
      </div>
      <div className={css.railBottom}>
        <button
          className={css.railButton}
          type="button"
          onClick={() => {
            navigate('team')
          }}
        >
          <IconUsersOutlineRegular size={22} />
          <span>{t('team')}</span>
        </button>
        <button
          className={css.railButton}
          type="button"
          onClick={() => {
            navigate('settings')
          }}
        >
          <IconSettingsOutlineRegular size={22} />
          <span>{t('settings')}</span>
        </button>
      </div>
    </nav>
  )
}

export function OfficeToast({ useNotice, t, dismissNotice }: OfficeToastProps) {
  const notice = useNotice(value => value)
  return (
    notice && (
      <Toast
        key={notice.seq}
        text={t(notice.key)}
        {...(notice.success ? { tone: 'success' as const } : {})}
        onDone={dismissNotice}
      />
    )
  )
}

type FormKind = 'todo' | 'task' | 'schedule'
interface NewItem {
  readonly kind: FormKind
  readonly memberId?: SelectedMember
}

/** Non-home registrations do not declare or authorize the home Session subtree. */
export function OfficeNonHomePage(props: OfficeProps) { return <OfficePage {...props} /> }

export function OfficePage(props: OfficeProps & Partial<PropsRenderSlots<'office.home.conversation' | 'office.home.experience'>>) {
  const { t, useOffice, section, navigate, load, useStore, actions } = props
  const { view, error, loading } = useOffice(value => value)
  const filter = useStore(state => state.filter)
  const status = useStore(state => state.status)
  const [workBucket, setWorkBucket] = useState<'active' | 'archived' | 'deleted'>('active')
  const searchTarget = props.useSearch(state => state.target)
  const [form, setForm] = useState<NewItem | null>(null)
  const [scheduleEdit, setScheduleEdit] = useState<OfficeItem | null>(null)
  const [workEdit, setWorkEdit] = useState<{ item: OfficeItem; actorId: OfficeMemberId; kind: 'content' | 'subtasks' | 'attachments' } | null>(null)
  const selected = useStore(state => state.selected)
  const ordinary = props.useConversations(state => state.ordinary)
  const appearance = props.useExperience(state => state.view?.appearance)
  const setSelected = actions.setSelected
  const [profile, setProfile] = useState(false)
  const [notifications, setNotifications] = useState(false)
  const [announcement, setAnnouncement] = useState<OfficeAnnouncementId | null>(null)
  const [announcementManager, setAnnouncementManager] = useState(false)
  const [member, setMember] = useState<OfficeMember | null | undefined>(
    undefined,
  )
  const [chatPeer, setChatPeer] = useState<OfficeMemberId | null>(null)
  const [account, setAccount] = useState(false)
  const [credentialTarget, setCredentialTarget] =
    useState<OfficeMemberId | null>(null)
  const connection = props.useConnection(state => state.connection)
  useEffect(() => {
    setChatPeer(null)
    setForm(null)
    setScheduleEdit(null)
    setWorkEdit(null)
    setWorkBucket('active')
    setProfile(false)
    setNotifications(false)
    setAnnouncement(null)
    setAnnouncementManager(false)
    setMember(undefined)
    setAccount(false)
    setCredentialTarget(null)
  }, [view?.me.id])
  useEffect(() => {
    setWorkEdit(previous => previous && (!view || previous.actorId !== view.me.id
      || !view.items.some(entry => entry.id === previous.item.id)) ? null : previous)
  }, [view])
  const item = view && [...view.items, ...(view.inactiveWork ?? [])].find(entry => entry.id === selected)
  const itemTimes = new Map(view?.calendarTime?.items.map(entry => [entry.itemId, entry]))
  const managedTarget = view?.managedMembers?.find(
    entry => entry.id === credentialTarget && entry.active,
  )
  const name = (id: OfficeMemberId) =>
    view?.members.find(member => member.id === id)?.name ?? id
  const openForm = (kind: FormKind, memberId?: OfficeMemberId) => {
    setForm(memberId === undefined ? { kind } : { kind, memberId })
  }
  const workItems = view && (workBucket === 'active' ? view.items :
    (view.inactiveWork ?? []).filter(item => item.lifecycle === workBucket))
  const work = view && workItems ? officeWorkList(workItems, view.me.id, filter, status) : null
  useEffect(() => {
    if (section !== 'work' || searchTarget?.kind !== 'item' || !view) return
    const target = [...view.items, ...(view.inactiveWork ?? [])].find(item => item.id === searchTarget.item.id)
    if (!target) return
    setWorkBucket(target.lifecycle ?? 'active')
    actions.setFilter('all')
    actions.setStatus('all')
    actions.setSelected(target.id)
    props.consumeSearchTarget(searchTarget.key)
  }, [section, searchTarget, view, actions, props.consumeSearchTarget])
  const unreadCount = view ? officeInbox(view).filter(entry => !entry.value.read).length : 0
  const openAnnouncement = (id: OfficeAnnouncementId) => {
    const current = view?.announcements?.entries.find(entry => entry.id === id)
    if (!current) return
    if (current.read || current.withdrawn) setAnnouncement(id)
    else void props.markAnnouncementRead(id).then((success) => { if (success) setAnnouncement(id) })
  }
  const previousDate = view && shiftOfficeDate(view.day.date, -1)
  const nextDate = view && shiftOfficeDate(view.day.date, 1)

  const itemList = (items: readonly OfficeItem[]) => (
    <div className={clsx(css.itemList, section === 'work' && css.workItems)}>
      {items.length === 0 ? (
        <div className={css.empty}>
          <p>{t(section === 'work' ? 'noWork' : 'empty')}</p>
          {section !== 'home' && <>
            <Button
              onClick={() => {
                openForm('todo')
              }}
            >
              {t('newTodo')}
            </Button>
            <Button
              onClick={() => {
                openForm('schedule')
              }}
            >
              {t('newSchedule')}
            </Button>
          </>}
        </div>
      ) : (
        items.map(entry => (
          <button
            key={entry.id}
            data-office-item={entry.id}
            className={css.item}
            type="button"
            onClick={() => {
              setSelected(entry.id)
            }}
          >
            <span className={css.itemTime}>
              {entry.time ?? t('untimed')}
              {entry.endTime ? `–${entry.endTime}` : ''}
            </span>
            <span className={css.itemTitle}>
              {entry.title}
              <small>{name(entry.ownerId)}</small>
            </span>
            {entry.kind !== 'schedule' && entry.priority && entry.priority !== 'normal' && (
              <span className={css.priorityBadge} aria-label={`${t('priority')}: ${t(priorityKeys[entry.priority])}`}>
                {t(priorityKeys[entry.priority])}
              </span>
            )}
            <span className={css.state} data-state={entry.status}>
              {t(entry.status)}
            </span>
            <OfficeItemTimeBadge t={t} time={itemTimes.get(entry.id)} />
          </button>
        ))
      )}
    </div>
  )

  const agenda = view && (
    <section className={css.card}>
      <div className={css.row}>
        <h2>{t('calendar')}</h2>
        <Button
          size="sm"
          onClick={() => {
            navigate('calendar')
            load(null)
          }}
        >
          {t('calendar')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            openForm('todo')
          }}
        >
          {t('newTodo')}
        </Button>
      </div>
      <div className={css.dates}>
        {Array.from({ length: 7 }, (_, index) =>
          shiftOfficeDate(view.day.date, index - 3),
        ).filter((date): date is string => date !== null,
        ).map(date => (
          <button
            key={date}
            type="button"
            aria-label={date}
            aria-pressed={date === view.day.date}
            onClick={() => {
              load(date)
            }}
          >
            {date.slice(5)}
          </button>
        ))}
      </div>
      {itemList(view.day.items)}
    </section>
  )

  return (
    <main className={css.page} data-office-scheme={appearance?.scheme === 'inherit' ? undefined : appearance?.scheme}
      data-office-density={appearance?.density} data-office-brand={appearance?.brand}>
      <header className={css.header}>
        <div>
          <small>{appearance?.monogram ? appearance.monogram + ' · ' : ''}{appearance?.companyName || view?.companyName || ''}</small>
          <h1>{t(section)}</h1>
        </div>
        <div className={css.row}>
          <Button disabled={!view} onClick={props.openSearch}>{t('globalSearch')}</Button>
          <Button onClick={props.openNative}>{t('native')}</Button>
          {view && connection?.mode === 'gateway' && (
            <Button
              onClick={() => {
                setAccount(true)
              }}
            >
              {t('account')}
            </Button>
          )}
          <Button
            aria-label={t('notifications')}
            disabled={!view}
            onClick={() => {
              load()
              setNotifications(true)
            }}
          >
            {t('notifications')}
            {unreadCount > 0 && (
              <span className={css.badge}>
                {unreadCount}
              </span>
            )}
          </Button>
          {view && (
            <button
              type="button"
              className={css.identity}
              onClick={() => {
                setProfile(true)
              }}
              aria-label={t('profile')}
            >
              <span className={css.avatar}>{avatarInitial(view.me.name)}</span>
              <span>
                {view.me.name}
                <small>
                  {t(view.me.role)} · {affiliation(view.organization, view.me).jobTitle || t('unassigned')}
                </small>
              </span>
            </button>
          )}
        </div>
      </header>
      {error && !(connection?.mode === 'gateway' && !connection.connected) && (
        <div className={css.error} role="alert">
          {t(error)}{' '}
          <Button
            onClick={() => {
              load()
            }}
          >
            {t('retry')}
          </Button>
        </div>
      )}
      {loading && !view && (
        <div className={css.empty}>
          <progress aria-label={t('loading')} />
        </div>
      )}
      {connection?.mode === 'gateway' && !connection.connected && (
        <OfficeLogin {...props} />
      )}
      {view && (
        <>
          {section === 'home' && (
            <>
              <div className={css.overview}>
                <section className={css.card}>
                  <h2>{t('dashboard')}</h2>
                  <div className={css.metrics}>
                    {(
                      [
                        ['pendingCount', view.day.pending],
                        ['completedCount', view.day.completed],
                        ['workCount', view.day.work],
                        ['scheduleCount', view.day.schedules],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <span>{t(label)}</span>
                        <strong>{value}</strong>
                      </div>
                    ))}
                  </div>
                  <label className={css.progress}>
                    {t('completion')}
                    <span>{view.day.completionRate}%</span>
                    <progress max={100} value={view.day.completionRate} />
                  </label>
                  <div className={css.row}>
                    <Button
                      onClick={() => {
                        openForm('task')
                      }}
                    >
                      {t('newTask')}
                    </Button>
                    <Button
                      onClick={() => {
                        openForm('schedule')
                      }}
                    >
                      {t('newSchedule')}
                    </Button>
                  </div>
                </section>
                <div className={css.homeAside}>
                  {agenda}
                  <OfficeAnnouncementCard view={view} t={t} onSelect={openAnnouncement} onManage={() => { setAnnouncementManager(true) }} />
                </div>
              </div>
              {props.renderSlot?.('office.home.experience', {})}
              {ordinary && props.SessionProvider && props.renderSlot
                ? <OfficeHomeNativeInput {...props} SessionProvider={props.SessionProvider} renderSlot={props.renderSlot} />
                : <OfficeHomeInput {...props} />}
            </>
          )}
          {section === 'calendar' && (
            <>
              <div className={css.row}>
                <Button
                  disabled={!previousDate}
                  onClick={() => {
                    if (previousDate) load(previousDate)
                  }}
                >
                  {t('previous')}
                </Button>
                <Input
                  type="date"
                  max="9999-12-31"
                  aria-label={t('date')}
                  value={view.day.date}
                  onChange={(event) => {
                    if (event.target.value) load(event.target.value)
                  }}
                />
                <Button
                  disabled={!nextDate}
                  onClick={() => {
                    if (nextDate) load(nextDate)
                  }}
                >
                  {t('next')}
                </Button>
                <Button
                  onClick={() => {
                    load(null)
                  }}
                >
                  {t('today')}
                </Button>
                <Button
                  onClick={() => {
                    openForm('schedule')
                  }}
                >
                  {t('newSchedule')}
                </Button>
              </div>
              {agenda}
            </>
          )}
          {section === 'work' && (
            <>
              {view.inactiveWork !== undefined && <div className={css.row} aria-label={t('workLifecycleViews')}>
                {(['active', 'archived', 'deleted'] as const).map(bucket => <Button key={bucket}
                  aria-pressed={workBucket === bucket} onClick={() => { setWorkBucket(bucket) }}>
                  {t(bucket === 'active' ? 'activeWork' : bucket === 'archived' ? 'archivedWork' : 'deletedWork')}
                </Button>)}
              </div>}
              <div className={css.row}>
                {(['mine', 'dispatched', 'all'] as const).map(key => (
                  <Button
                    key={key}
                    aria-label={t(key)}
                    aria-pressed={filter === key}
                    variant={filter === key ? 'primary' : 'ghost'}
                    onClick={() => {
                      actions.setFilter(key)
                    }}
                  >
                    {t(key)}
                    <span className={css.workFilterCount} aria-hidden="true">{work?.counts[key] ?? 0}</span>
                  </Button>
                ))}
                <select
                  aria-label={t('status')}
                  value={status}
                  onChange={(event) => {
                    actions.setStatus(event.target.value)
                  }}
                >
                  <option value="all">{t('allStatus')}</option>
                  {states.map(value => (
                    <option key={value} value={value}>
                      {t(value)}
                    </option>
                  ))}
                </select>
                <Button
                  onClick={() => {
                    openForm('task')
                  }}
                >
                  {t('newTask')}
                </Button>
                <Button
                  onClick={() => {
                    openForm('todo')
                  }}
                >
                  {t('newTodo')}
                </Button>
              </div>
              <p className={css.workSummary} role="status">{t('workCount')} · {work?.total ?? 0}</p>
              {work?.groups.length ? work.groups.map(group => (
                <section className={css.workGroup} key={group.date} aria-label={group.date}>
                  <h2><time dateTime={group.date}>{group.date}</time><span className={css.badge}>{group.items.length}</span></h2>
                  {itemList(group.items)}
                </section>
              )) : itemList([])}
            </>
          )}
          {(section === 'contacts' || section === 'team') && (
            <OfficeDirectory
              key={view.me.id}
              {...props}
              view={view}
              onEdit={setMember}
              onCreate={openForm}
              onChat={setChatPeer}
              onCredentials={(member) => {
                setCredentialTarget(member.id)
              }}
            />
          )}
          {section === 'drive' && (
            <OfficeDrive key={view.me.id} {...props} office={view} />
          )}
          {section === 'integrations' && <OfficeIntegrations key={`${view.me.id}:${view.me.role}`} {...props} office={view} />}
          {section === 'tools' && (
            <OfficeTools key={`${view.me.id}:${view.me.role}`} {...props} office={view} />
          )}
        </>
      )}
      {view && chatPeer && (
        <OfficeChat
          {...props}
          view={view}
          initialPeer={chatPeer}
          onClose={() => {
            setChatPeer(null)
          }}
          onCreate={openForm}
        />
      )}
      {view && account && connection?.mode === 'gateway' && (
        <OfficeAccount
          {...props}
          onClose={() => {
            setAccount(false)
          }}
        />
      )}
      {view?.me.role === 'admin' &&
        managedTarget &&
        connection?.mode === 'gateway' && (
        <OfficeCredentials
          {...props}
          member={managedTarget}
          onClose={() => {
            setCredentialTarget(null)
          }}
        />
      )}
      {view && form && (
        <CreateItem
          key={`${form.kind}:${form.memberId ?? ''}`}
          {...props}
          view={view}
          kind={form.kind}
          memberId={form.memberId}
          onClose={() => {
            setForm(null)
          }}
        />
      )}
      {view && profile && (
        <OfficeProfileForm
          {...props}
          view={view}
          onClose={() => {
            setProfile(false)
          }}
        />
      )}
      {view && view.me.role === 'admin' && member !== undefined && (
        <OfficeMemberForm
          {...props}
          view={view}
          member={member}
          onClose={() => {
            setMember(undefined)
          }}
        />
      )}
      {view && notifications && (
        <OfficeNotifications
          {...props}
          onOpenCollaboration={() => {
            setNotifications(false)
            props.openCollaboration(notice => {
              if (notice.source === 'announcement') setAnnouncement(notice.targetId as OfficeAnnouncementId)
              else if (notice.source === 'chat') setChatPeer(notice.targetId as OfficeMemberId)
              else setSelected(notice.targetId as OfficeItemId)
            })
          }}
          view={view}
          onClose={() => {
            setNotifications(false)
          }}
          onOpenItem={(id) => {
            setNotifications(false)
            setSelected(id)
          }}
          onOpenAnnouncement={(id) => {
            setNotifications(false)
            setAnnouncement(id)
          }}
        />
      )}
      {view && announcementManager && view.me.role === 'admin' && (
        <OfficeAnnouncementManager {...props} view={view} onClose={() => { setAnnouncementManager(false) }}
          onSelect={(id) => { setAnnouncementManager(false); openAnnouncement(id) }} />
      )}
      {view && announcement && (
        <OfficeAnnouncementDetails key={announcement} {...props} view={view} id={announcement} onClose={() => { setAnnouncement(null) }} />
      )}
      {view && item && (
        <OfficeItemDetail
          {...props}
          view={view}
          item={item}
          time={itemTimes.get(item.id)}
          onEditSchedule={(reviewed) => { setSelected(null); setScheduleEdit(reviewed) }}
          onEditWork={(reviewed) => { setSelected(null); setWorkEdit({ item: reviewed, actorId: view.me.id, kind: 'content' }) }}
          onEditSubtasks={(reviewed) => { setSelected(null); setWorkEdit({ item: reviewed, actorId: view.me.id, kind: 'subtasks' }) }}
          onEditAttachments={(reviewed) => { setSelected(null); setWorkEdit({ item: reviewed, actorId: view.me.id, kind: 'attachments' }) }}
          onClose={() => {
            setSelected(null)
          }}
        />
      )}
      {view && scheduleEdit && (view.me.role === 'admin' || scheduleEdit.creatorId === view.me.id) && (
        <OfficeScheduleEditForm {...props} view={view} item={scheduleEdit} onClose={() => { setScheduleEdit(null) }} />
      )}
      {view && workEdit && workEdit.actorId === view.me.id && view.items.some(entry => entry.id === workEdit.item.id) && (
        workEdit.kind === 'attachments'
          ? <OfficeWorkAttachmentsForm key={`${view.me.id}:${view.me.role}:${workEdit.item.id}`}
            {...props} view={view} item={workEdit.item} onClose={() => { setWorkEdit(null) }} />
          : workEdit.kind === 'subtasks'
            ? <OfficeWorkSubtasksForm {...props} view={view} item={workEdit.item} onClose={() => { setWorkEdit(null) }} />
            : <OfficeWorkEditForm {...props} view={view} item={workEdit.item} onClose={() => { setWorkEdit(null) }} />
      )}
    </main>
  )
}

function CreateItem(
  props: OfficeProps & {
    view: OfficeView
    kind: FormKind
    memberId: SelectedMember
    onClose(this: void): void
  },
) {
  const { t, view, kind, memberId, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const [invitees, setInvitees] = useState<readonly OfficeMemberId[]>(
    memberId ? [memberId] : [],
  )
  const [scheduleWindow, setScheduleWindow] = useState({ date: view.day.date, startTime: '09:00', endTime: '10:00' })
  const titleKey: OfficeKey =
    kind === 'schedule'
      ? 'newSchedule'
      : kind === 'task'
        ? 'newTask'
        : 'newTodo'
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const text = (key: string) => formText(data, key)
    const shared = {
      title: text('title'),
      description: text('description'),
      date: text('date'),
    }
    const success =
      kind === 'schedule'
        ? await props.createSchedule({
          ...shared,
          startTime: text('startTime'),
          endTime: text('endTime'),
          location: text('location'),
          inviteeIds: invitees,
        })
        : await props.createWork({
          ...shared,
          kind,
          ownerId: text('owner') as OfficeMemberId,
          ...(text('time') ? { time: text('time') } : {}),
          status: text('status') as OfficeItemStatus,
        })
    if (success) onClose()
  }
  return (
    <Modal
      open
      title={t(titleKey)}
      closeLabel={t('close')}
      className={css.detailDialog ?? ''}
      contentClassName={css.detailContent ?? ''}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className={css.form}
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <label>
          {t('title')}
          <Input name="title" maxLength={200} required data-modal-autofocus />
        </label>
        <label>
          {t('date')}
          <Input
            name="date"
            type="date"
            value={scheduleWindow.date}
            onChange={(event) => { setScheduleWindow({ ...scheduleWindow, date: event.target.value }) }}
            required
          />
        </label>
        {kind === 'schedule' ? (
          <>
            <div className={css.row}>
              <label>
                {t('startTime')}
                <Input
                  type="time"
                  name="startTime"
                  value={scheduleWindow.startTime}
                  onChange={(event) => { setScheduleWindow({ ...scheduleWindow, startTime: event.target.value }) }}
                  required
                />
              </label>
              <label>
                {t('endTime')}
                <Input
                  type="time"
                  name="endTime"
                  value={scheduleWindow.endTime}
                  onChange={(event) => { setScheduleWindow({ ...scheduleWindow, endTime: event.target.value }) }}
                  required
                />
              </label>
            </div>
            <label>
              {t('location')}
              <Input name="location" maxLength={500} />
            </label>
            <fieldset>
              <legend>{t('participants')}</legend>
              {view.members
                .filter(member => member.id !== view.me.id)
                .map(member => (
                  <Checkbox
                    key={member.id}
                    label={`${member.name} · ${affiliation(view.organization, member).department || t('unassigned')}`}
                    checked={invitees.includes(member.id)}
                    onChange={(checked) => {
                      setInvitees(
                        checked
                          ? [...invitees, member.id]
                          : invitees.filter(id => id !== member.id),
                      )
                    }}
                  />
                ))}
            </fieldset>
            <OfficeScheduleOverlaps t={t} view={view} {...scheduleWindow} memberIds={[view.me.id, ...invitees]} />
            <OfficeScheduleAvailability t={t} view={view} checkScheduleAvailability={props.checkScheduleAvailability}
              {...scheduleWindow} memberIds={[view.me.id, ...invitees]} />
          </>
        ) : (
          <>
            <label>
              {t('owner')}
              <select
                aria-label={t('owner')}
                name="owner"
                defaultValue={memberId ?? view.me.id}
              >
                {view.members.map(member => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('time')}
              <Input name="time" type="time" />
            </label>
            <label>
              {t('status')}
              <select
                aria-label={t('status')}
                name="status"
                defaultValue="pending"
              >
                {states.map(value => (
                  <option key={value} value={value}>
                    {t(value)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          {t('description')}
          <textarea name="description" maxLength={16000} />
        </label>
        <div className={css.row}>
          <Button disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
