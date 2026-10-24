/** Accessible global search keeps keyboard selection in the popup and returns focus through the layout Modal owner. */
import { useEffect, useId, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeSearchProps } from './contracts.ts'
import css from './OfficePage.module.css'

const groupKeys = { page: 'searchPages', member: 'searchMembers', item: 'searchItems', file: 'searchFiles', skill: 'searchSkills' } as const

/** Current results form one keyboard-addressable list; selection never automatically sends a message or opens file bytes. */
export function OfficeSearch(props: OfficeSearchProps) {
  const { t } = props
  const search = props.useSearch(value => value)
  const [selected, setSelected] = useState(0)
  const listId = useId()
  useEffect(() => {
    if (search.open) document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' })
  }, [search.open, selected, listId])
  useEffect(() => { setSelected(0) }, [search.results])
  if (!search.open) return null
  const active = search.results[selected]
  return <Modal open title={t('globalSearch')} closeLabel={t('close')} onClose={props.closeSearch}
    className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}>
    <div className={css.form}>
      <Input data-modal-autofocus role="combobox" type="search" aria-label={t('globalSearchQuery')} maxLength={200}
        aria-controls={listId} aria-expanded aria-autocomplete="list"
        aria-activedescendant={active ? `${listId}-${selected}` : undefined}
        value={search.query} placeholder={t('globalSearchQuery')} disabled={search.opening}
        onChange={(event) => { props.querySearch(event.target.value) }}
        onKeyDown={(event) => {
          const composition: { readonly isComposing: boolean; readonly keyCode: number } = event.nativeEvent
          if (composition.isComposing || composition.keyCode === 229) return
          if (event.key === 'Escape') { event.preventDefault(); props.closeSearch() }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const count = search.results.length
            if (count) setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (active && !search.loading && !search.opening) props.selectSearch(active.key)
          }
        }} />
      <p>{t('searchKeyboardHint')}</p>
      {search.loading && <p role="status">{t('loading')}</p>}
      {search.opening && <p role="status">{t('searchOpening')}</p>}
      {search.failures.map(key => <p key={key} role="alert">{t(key)}</p>)}
      {search.limited && <p>{t('searchLimited')}</p>}
      {!search.loading && search.results.length === 0 && <p>{t('searchNoResults')}</p>}
      <div role="listbox" id={listId} aria-label={t('searchResults')}>
        {search.results.map((result, index) => <Button key={result.key} id={`${listId}-${index}`} role="option"
          variant={selected === index ? 'primary' : 'ghost'}
          aria-selected={selected === index} className={css.searchResult ?? ''}
          disabled={search.loading || search.opening} onClick={() => { props.selectSearch(result.key) }}>
          <span>{t(groupKeys[result.kind])} · {result.title}</span>
          <small>{result.kind === 'file' ? t(result.file.space === 'private' ? 'privateDrive' : 'sharedDrive')
            : result.description}{result.kind === 'item' && result.item.lifecycle
            ? ` · ${t(result.item.lifecycle === 'archived' ? 'archivedWork' : 'deletedWork')}` : ''}</small>
        </Button>)}
      </div>
    </div>
  </Modal>
}
