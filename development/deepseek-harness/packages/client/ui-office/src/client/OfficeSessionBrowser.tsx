/** Ordinary AI Session navigation lives in an additive native right-Sidebar tab. */
import { useMemo, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OfficeSessionBrowserProps } from './contracts.ts'
import { officeSessionRows } from './session-list.ts'
import css from './OfficePage.module.css'

/** Search and open the actual native catalog; original right-Sidebar types keep their own tabs. */
export function OfficeSessionBrowser(props: OfficeSessionBrowserProps) {
  const { t } = props
  const office = props.useOffice(state => state.view)
  const sessions = props.useSessions(state => state)
  const archived = props.useWorkspaces(state => state.archivedSessionIds)
  const hidden = props.useConversations(state => state.hidden)
  const phase = props.useConversations(state => state.phase)
  const contexts = props.useAssistance(state => state.contexts)
  const query = props.useStore(state => state.query)
  const [limit, setLimit] = useState(50)
  const items = useMemo(() => new Map(office?.items.map(item => [item.id, item])), [office?.items])
  const rows = useMemo(() => officeSessionRows(sessions, [...archived, ...hidden], query,
    Object.fromEntries(Object.entries(contexts).flatMap(([id, context]) => {
      const item = items.get(context.item.id)
      return item ? [[id, item.title]] : []
    }))), [sessions, archived, hidden, query, contexts, items])
  if (!office) return <div className={css.sessionBrowser}>
    <p>{t('sessionSignIn')}</p>
    <Button onClick={props.openOfficeHome}>{t('home')}</Button>
  </div>
  if (phase !== 'ready') return <section className={css.sessionBrowser} aria-label={t('sessionHistory')}>
    {phase === 'loading' ? <p role="status">{t('conversationStorageLoading')}</p> : <>
      <p role="alert">{t('conversationStorageUnavailable')}</p>
      <Button onClick={props.refreshConversations}>{t('refreshConversations')}</Button>
    </>}
  </section>
  return <section className={css.sessionBrowser} aria-label={t('sessionHistory')}>
    <div className={css.row}>
      <h2>{t('sessionHistory')}</h2>
      <Button variant="primary" onClick={props.newConversation}>{t('newConversation')}</Button>
    </div>
    <Input aria-label={t('searchConversations')} placeholder={t('searchConversations')} value={query} onChange={(event) => {
      props.actions.setQuery(event.target.value)
      setLimit(50)
    }} />
    <div className={css.row}>
      {query && <Button onClick={() => { props.actions.setQuery('') }}>{t('clearConversationSearch')}</Button>}
      <Button onClick={props.refreshConversations}>{t('refreshConversations')}</Button>
    </div>
    {sessions.phase !== 'ready' && <p role="status">{t('sessionListLoading')}</p>}
    {sessions.phase === 'ready' && rows.length === 0 && <p>{t('noConversations')}</p>}
    <ul className={css.sessionRows} aria-label={t('sessionHistory')}>
      {rows.slice(0, limit).map(({ session, label }) => <li key={session.id}>
        <button type="button" data-office-session={session.id} aria-current={session.id === props.sessionId ? 'page' : undefined}
          onClick={() => { props.selectConversation(session.id) }}>
          <strong>{label}</strong>
          <small>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(session.updatedAt)}</small>
          {session.running && <span>{t('agentRunning')}</span>}
        </button>
      </li>)}
    </ul>
    {rows.length > limit && <Button onClick={() => { setLimit(value => value + 50) }}>{t('moreConversations')}</Button>}
  </section>
}

/** Read the current locale when a saved tab is rendered, independent of its recorded title. */
export function OfficeSessionBrowserTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'office'>) {
  return <>{t('sessionHistory')}</>
}
