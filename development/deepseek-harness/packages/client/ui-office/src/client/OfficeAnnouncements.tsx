/** Company publications use authorized projections; automatic rotation pauses during reading. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Checkbox, Input, Modal, Tooltip, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { OfficeAnnouncementId, OfficeMemberId, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

type Shared = Pick<OfficeProps, 't' | 'useOffice' | 'publishAnnouncement' | 'withdrawAnnouncement'> & { view: OfficeView }

/** The homepage's right column; no timer changes a focused or hovered publication. */
export function OfficeAnnouncementCard({ view, t, onSelect, onManage }: Pick<Shared, 'view' | 't'> & {
  onSelect(this: void, id: OfficeAnnouncementId): void
  onManage(this: void): void
}) {
  const entries = (view.announcements?.entries ?? []).filter(item => item.recipient && !item.withdrawn)
    .toSorted((a, b) => b.publishedAt - a.publishedAt || b.id.localeCompare(a.id))
  const [cursor, setCursor] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(() => document.visibilityState !== 'visible')
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const rotationMs = view.announcements?.rotationMs
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const visibility = () => { setHidden(document.visibilityState !== 'visible') }
    const motion = () => { setReducedMotion(media.matches) }
    document.addEventListener('visibilitychange', visibility)
    media.addEventListener('change', motion)
    return () => { document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', motion) }
  }, [])
  useEffect(() => {
    if (entries.length < 2 || rotationMs === undefined || paused || hovered || focused || hidden || reducedMotion) return
    const timer = setInterval(() => { setCursor(value => (value + 1) % entries.length) }, rotationMs)
    return () => { clearInterval(timer) }
  }, [entries.length, rotationMs, paused, hovered, focused, hidden, reducedMotion])
  const current = entries.length ? entries[cursor % entries.length] : undefined
  return <section className={`${css.card} ${css.announcementCard}`} role="region" aria-label={t('announcements')}
    onMouseEnter={() => { setHovered(true) }} onMouseLeave={() => { setHovered(false) }}
    onFocusCapture={() => { setFocused(true) }} onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
    }}>
    <div className={css.row}><h2>{t('announcements')}</h2>
      {view.me.role === 'admin' && <Button size="sm" disabled={!view.announcements} onClick={onManage}>{t('manageAnnouncements')}</Button>}
    </div>
    {current ? <>
      <button type="button" className={css.announcementPreview} onClick={() => { onSelect(current.id) }} data-office-announcement={current.id}>
        <strong>{current.title}</strong><span>{current.body}</span>
      </button>
      <div className={css.announcementMeta}>
        {current.publisherName} · {new Date(current.publishedAt).toLocaleDateString(undefined, { timeZone: view.timeZone })}
      </div>
      <div className={css.row}>
        <Tooltip label={t('announcementPrevious')}>
          <Button size="sm" aria-label={t('announcementPrevious')} disabled={entries.length < 2}
            onClick={() => { setCursor(value => (value + entries.length - 1) % entries.length) }}>
            <IconChevronLeftOutlineRegular size={14} />
          </Button>
        </Tooltip>
        <span className={css.announcementMeta}>{t('announcementPosition', { current: cursor % entries.length + 1, total: entries.length })}</span>
        <Tooltip label={t('announcementNext')}>
          <Button size="sm" aria-label={t('announcementNext')} disabled={entries.length < 2}
            onClick={() => { setCursor(value => (value + 1) % entries.length) }}><IconChevronRightOutlineRegular size={14} /></Button>
        </Tooltip>
        <Button size="sm" aria-pressed={paused} disabled={entries.length < 2 || reducedMotion} onClick={() => { setPaused(value => !value) }}>{t(paused ? 'announcementResume' : 'announcementPause')}</Button>
      </div>
    </> : <p className={css.announcementMeta}>{t(view.announcements ? 'announcementEmpty' : 'announcementUnavailable')}</p>}
  </section>
}

/** Read the current projection rather than retaining text after withdrawal or an account change. */
export function OfficeAnnouncementDetails({ view, t, id, useOffice, withdrawAnnouncement, onClose }: Shared & {
  id: OfficeAnnouncementId
  onClose(this: void): void
}) {
  const current = view.announcements?.entries.find(item => item.id === id)
  const busy = useOffice(state => state.busy)
  const [confirm, setConfirm] = useState(false)
  return <Modal open title={t('announcementDetails')} closeLabel={t('close')} onClose={() => { if (!busy) onClose() }}>
    {current ? <div className={css.form}>
      <h2>{current.title}</h2><p className={css.announcementBody}>{current.body}</p>
      <dl><dt>{t('announcementPublisher')}</dt><dd>{current.publisherName}</dd>
        <dt>{t('announcementPublishedAt')}</dt><dd>{new Date(current.publishedAt).toLocaleString(undefined, { timeZone: view.timeZone })}</dd>
        <dt>{t('announcementAudience')}</dt><dd>{t(current.audience === 'company' ? 'announcementCompany' : 'announcementMembers')} · {t('announcementRecipientCount', { count: current.recipientCount })}</dd>
        <dt>{t('status')}</dt><dd>{t(current.withdrawn ? 'announcementWithdrawn' : current.read ? 'read' : 'unread')}</dd></dl>
      {view.me.role === 'admin' && !current.withdrawn && (confirm ? <>
        <p>{t('announcementWithdrawHint')}</p>
        <div className={css.row}><Button disabled={busy} onClick={() => { setConfirm(false) }}>{t('cancel')}</Button>
          <Button disabled={busy} onClick={() => {
            void withdrawAnnouncement(current.id, current.revision).then((success) => { if (success) onClose() })
          }}>{t('announcementConfirmWithdraw')}</Button></div>
      </> : <Button disabled={busy} onClick={() => { setConfirm(true) }}>{t('announcementWithdraw')}</Button>)}
    </div> : <p role="status">{t('announcementUnavailable')}</p>}
  </Modal>
}

/** Administrators publish reviewed text or inspect retained publications, including withdrawals. */
export function OfficeAnnouncementManager(
  props: Shared & { onClose(this: void): void; onSelect(this: void, id: OfficeAnnouncementId): void },
) {
  const { view, t, onClose, onSelect } = props
  const busy = props.useOffice(state => state.busy)
  const [composing, setComposing] = useState(false)
  const entries = view.announcements?.entries ?? []
  const full = entries.length >= (view.announcements?.maxEntries ?? 0)
  return <Modal open title={t(composing ? 'publishAnnouncement' : 'manageAnnouncements')} closeLabel={t('close')} onClose={() => { if (!busy) onClose() }}>
    {composing ? <AnnouncementForm {...props} onCancel={() => { setComposing(false) }} /> : <div className={css.form}>
      <Button variant="primary" disabled={busy || full} onClick={() => { setComposing(true) }}>{t('publishAnnouncement')}</Button>
      {full && <p role="status">{t('announcementCapacity')}</p>}
      <p className={css.announcementMeta}>{t('announcementCount', { count: entries.length, limit: view.announcements?.maxEntries ?? 0 })}</p>
      {entries.length === 0 && <p>{t('announcementEmpty')}</p>}
      <div className={css.notifications}>{entries.toSorted((a, b) => b.publishedAt - a.publishedAt || b.id.localeCompare(a.id)).map(item =>
        <Button key={item.id} className={css.notification} variant="ghost" disabled={busy} onClick={() => { onSelect(item.id) }}>
          <span>{item.title}</span><span className={css.notificationMeta}>{item.publisherName} · {t(item.withdrawn ? 'announcementWithdrawn' : item.audience === 'company' ? 'announcementCompany' : 'announcementMembers')}</span>
        </Button>)}</div>
    </div>}
  </Modal>
}

function AnnouncementForm({ view, t, publishAnnouncement, useOffice, onCancel }: Shared & { onCancel(this: void): void }) {
  const busy = useOffice(state => state.busy)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [audience, setAudience] = useState<'company' | 'members'>('company')
  const [recipients, setRecipients] = useState<readonly OfficeMemberId[]>([])
  const receipt = useRef<{ text: string; id: string } | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !title.trim() || !body.trim() || audience === 'members' && recipients.length === 0) return
    const input = { title: title.trim(), body: body.trim(), audience, recipientIds: audience === 'company' ? [] : recipients }
    const text = JSON.stringify(input)
    if (receipt.current?.text !== text) receipt.current = { text, id: randomUUID() }
    void publishAnnouncement({ ...input, requestId: receipt.current.id }).then((success) => { if (success) onCancel() })
  }
  return <form className={css.form} onSubmit={submit}>
    <label>{t('title')}<Input aria-label={t('title')} value={title} required maxLength={120} disabled={busy}
      onChange={(event) => { setTitle(event.target.value) }} /></label>
    <label>{t('announcementBody')}<textarea aria-label={t('announcementBody')} value={body} required maxLength={20000} disabled={busy}
      onChange={(event) => { setBody(event.target.value) }} /></label>
    <label>{t('announcementAudience')}<select aria-label={t('announcementAudience')} value={audience} disabled={busy}
      onChange={(event) => { setAudience(event.target.value === 'members' ? 'members' : 'company') }}>
      <option value="company">{t('announcementCompany')}</option><option value="members">{t('announcementMembers')}</option>
    </select></label>
    <p className={css.announcementMeta}>{t('announcementScopeHint')}</p>
    {audience === 'members' && <fieldset><legend>{t('announcementMembers')}</legend>{view.members.map(member =>
      <Checkbox key={member.id} label={member.name} className={css.check}
        checked={recipients.includes(member.id)} disabled={busy} onChange={(checked) => {
          setRecipients(value => checked ? [...value, member.id] : value.filter(id => id !== member.id))
        }} />)}</fieldset>}
    <div className={css.row}><Button disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={busy || !title.trim() || !body.trim() || audience === 'members' && recipients.length === 0}>{t('publishAnnouncement')}</Button></div>
  </form>
}
