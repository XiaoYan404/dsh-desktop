/** Current-input references remain separate from native attachments and are reauthorized when actually read. */
import { useEffect } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeConversationId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeFileAssociationsProps } from './contracts.ts'
import css from './OfficePage.module.css'

/** Render only the employee's observed native input, including the shared home occurrence. */
export function OfficeFileAssociations(props: OfficeFileAssociationsProps) {
  const { t } = props
  const office = props.useOffice(value => value.view)
  const id = props.useSession(value => value.sessionId)
  const selected = props.useConversations(value => value.selected)
  const active = props.usePanelInfo(value => value.activePanelId === null || value.activePanelId === 'office.home')
  const snapshot = props.useFileAssociations(value => value)
  const target = String(id) as OfficeConversationId
  const enabled = office?.conversationFiles?.protocol === 1 && active && selected === id
  useEffect(() => {
    if (enabled) props.loadFileAssociations(target)
  }, [enabled, target, office?.me.id, office?.me.role, props.loadFileAssociations])
  if (!enabled) return null
  const view = snapshot.conversationId === target ? snapshot.view : null
  const locked = snapshot.busy || snapshot.preparing || snapshot.pending
  return <section className={css.associations} aria-label={t('fileAssociations')}>
    <div className={css.row}>
      <Button size="sm" disabled={!view || locked} onClick={() => { void props.chooseFileAssociations(target) }}>{t('linkFiles')}</Button>
      <Button size="sm" variant="ghost" disabled={snapshot.busy || snapshot.preparing}
        onClick={() => { props.loadFileAssociations(target, true) }}>{t('refreshFileAssociations')}</Button>
      {Boolean(view?.files.length) && <Button size="sm" variant="ghost" disabled={locked}
        onClick={() => { void props.removeFileAssociation(null) }}>{t('clearFileAssociations')}</Button>}
      {snapshot.pending && <Button size="sm" disabled={snapshot.busy}
        onClick={() => { void props.retryFileAssociations() }}>{t('retry')}</Button>}
      {snapshot.loading && !view && <span role="status">{t('loading')}</span>}
    </div>
    {snapshot.error && <p role="alert" className={css.error}>{t(snapshot.error)}</p>}
    {Boolean(view?.files.length) && <>
      <ul className={css.conversationFileList}>
        {view?.files.map(file => <li key={file.id}>
          <span>{file.name}</span>
          <Button size="sm" variant="ghost" disabled={locked} aria-label={t('fileAssociationRemove', { name: file.name })}
            onClick={() => { void props.removeFileAssociation(file.id) }}>{t('fileAssociationRemoveAction')}</Button>
        </li>)}
      </ul>
      <p>{t('fileAssociationHint')}</p>
    </>}
  </section>
}
