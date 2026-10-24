/** Additive item context above the original native composer, scoped to its actual Session. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeItemContextProps } from './contracts.ts'
import { recordValue } from './values.ts'
import css from './OfficePage.module.css'

/** Render only an authorized snapshot recorded for this Session and employee. */
export function OfficeItemContext(props: OfficeItemContextProps) {
  const { t } = props
  const sessionId = props.useSession(session => session.sessionId)
  const context = props.useAssistance(state => recordValue(state.contexts, sessionId))
  const view = props.useOffice(state => state.view)
  const item = context && view?.items.find(entry => entry.id === context.item.id)
  if (!context || !item) return null
  return <aside className={css.itemContext} aria-label={t('itemContext')}>
    <div className={css.row}>
      <strong>{item.title}</strong>
      <Button onClick={() => { props.returnToItem(context.source, context.date) }}>{t('returnToItem')}</Button>
    </div>
    <p>{context.creator} → {context.owner} · {item.date} {item.time} · {t(item.status)}</p>
    <p>{t('itemContextReview')}</p>
    {item.revision !== context.item.revision && <p role="status">{t('itemContextChanged')}</p>}
  </aside>
}
