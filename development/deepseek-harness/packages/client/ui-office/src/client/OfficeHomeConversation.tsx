/** Compose the shipped native input through its factory, keeping its editor, files, controls and takeovers intact. */
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OfficeProps } from './contracts.ts'
import { officeHomeInputAddress } from './home-resource.ts'
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './OfficePage.module.css'

/** Keep the native draft writer; sent history remains in the independent Conversation. */
function HomeInputLifetime(props: ConversationViewsProps) {
  return props.renderSlot('conversation.session', { inputOnly: true })
}

/** Native factory receives the same explicit Session binding as its independent page. */
export function OfficeHomeConversation(props: PropsRuntime<'office.home.conversation'> & PropsRenderFactories) {
  return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, {
    slots: { views: HomeInputLifetime },
  })
}

type HomeProps = OfficeProps & PropsRenderSlots<'office.home.conversation'>

/** Framework resources retain runtime references; the office model publishes only the ordinary input's JSON identity. */
export function OfficeHomeNativeInput({ t, useConversations, useResource, SessionProvider, renderSlot, startHome }: HomeProps) {
  const ordinary = useConversations(state => state.ordinary)
  const [attempt, setAttempt] = useState(0)
  const resource = useResource<'officeinput'>(ordinary ? officeHomeInputAddress(ordinary, attempt) : '')
  return <section className={css.card}>
    <div className={css.row}>
      <h2>{t('ai')}</h2>
      <Button onClick={() => { void startHome('', false) }}>{t('expand')}</Button>
    </div>
    {resource.status === 'failed' ? <>
      <p role="alert">{t('homePreparationFailed')}</p>
      <Button onClick={() => { setAttempt(value => value + 1) }}>{t('refresh')}</Button>
    </> : resource.value?.reference ? <div className={css.homeNativeInput}>
      <SessionProvider session={resource.value.reference}>{renderSlot('office.home.conversation', {})}</SessionProvider>
    </div> : <progress aria-label={t('homePreparing')} />}
  </section>
}
