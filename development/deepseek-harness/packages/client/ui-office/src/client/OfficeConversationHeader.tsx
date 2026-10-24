/** Employee identity and native Session-history entry coexist with original Conversation utilities. */
import { useEffect, useState } from 'react'
import { Button, IconNewChatOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeConversationHeaderProps } from './contracts.ts'
import { OfficeProfileForm } from './OfficeProfileForm.tsx'
import { avatarInitial } from './values.ts'
import { affiliation } from './organization.ts'
import css from './OfficePage.module.css'

/** Open the native Session list on first wide-screen visit and preserve explicit resource-tab choices. */
export function OfficeConversationHeader(props: OfficeConversationHeaderProps) {
  const { t } = props
  const view = props.useOffice(state => state.view)
  const principal = view?.me.id
  const active = props.usePanelInfo(state => state.activePanelId === null)
  const sidebarSession = props.useSidebarSession(value => value)
  const assistance = props.useAssistance(value => value)
  const navigationReady = props.useConversations(value => value.phase === 'ready')
  const [profile, setProfile] = useState(false)
  useEffect(() => { setProfile(false) }, [view?.me.id])
  useEffect(() => {
    if (principal && active && props.sessionId && sidebarSession === props.sessionId) props.showConversationHistory(props.sessionId, true)
  }, [principal, active, sidebarSession, props.sessionId, props.showConversationHistory])
  useEffect(() => {
    if (principal && active && props.sessionId && navigationReady) props.observeConversation(props.sessionId, principal)
  }, [principal, active, props.sessionId, assistance, props.observeConversation, navigationReady])
  if (!view) return null
  return <>
    <Button size="sm" className={css.conversationHistory ?? ''} aria-label={t('sessionHistory')} disabled={!props.sessionId} onClick={() => {
      if (props.sessionId) props.showConversationHistory(props.sessionId, false)
    }}><IconNewChatOutlineRegular size={16} /><span className={css.conversationHistoryLabel}>{t('sessionHistory')}</span></Button>
    <button type="button" className={css.conversationIdentity} aria-label={t('profile')} onClick={() => { setProfile(true) }}>
      <span className={css.avatar}>{avatarInitial(view.me.name)}</span>
      <span>{view.me.name}<small>{t(view.me.role)} · {affiliation(view.organization, view.me).jobTitle || t('unassigned')}</small></span>
    </button>
    {profile && <OfficeProfileForm {...props} view={view} onClose={() => { setProfile(false) }} />}
  </>
}
