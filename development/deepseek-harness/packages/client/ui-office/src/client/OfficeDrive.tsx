/** Windows-style logical folders backed by employee-authorized metadata and actual file bytes. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button,
  IconFolderCloseRegular,
  Input,
  Menu,
  MenuItemButton,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  OfficeDriveDefault,
  OfficeDriveEntry,
  OfficeDriveGrant,
  OfficeDriveId,
  OfficeDriveUploadInput,
  OfficeDriveUploadTicket,
  OfficeDriveView,
  OfficeView,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import { bytesToBase64, randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { formText, recordValue } from './values.ts'
import { OfficeDrivePreview } from './OfficeDrivePreview.tsx'
import { OfficeDriveLifecycle } from './OfficeDriveLifecycle.tsx'
import { OfficeKnowledge } from './OfficeKnowledge.tsx'
import { officeDrivePreviewKind } from './drive-preview-model.ts'
import { officeFileReferenceSupported } from './file-associations-model.ts'
import css from './OfficeDrive.module.css'
import pageCss from './OfficePage.module.css'

type DriveProps = OfficeProps & { office: OfficeView }
type EntryForm = { kind: 'rename' | 'permissions'; entry: OfficeDriveEntry }
type DriveForm = { kind: 'folder' } | EntryForm | { kind: 'upload'; file: File }
  | { kind: 'trash'; entry: OfficeDriveEntry; role: OfficeView['me']['role'] }
const conditionKeys = { inherit: 'driveInherit', deny: 'driveDeny', view: 'driveView', edit: 'driveEdit' } as const
const conditions = ['inherit', 'deny', 'view', 'edit'] as const
const size = (bytes: number): string => {
  const unit = bytes < 1024 ? 0 : bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`
}

/** Folder navigation and form drafts stay separate from confirmed drive records. */
export function OfficeDrive(props: DriveProps) {
  const { t, office } = props
  const snapshot = props.useDrive(value => value)
  const upload = props.useDriveTransfers(value => value.upload)
  const fileAssociations = props.useFileAssociations(value => value)
  const fileLimits = office.conversationFiles
  const associationBusy = fileAssociations.preparing || fileAssociations.busy || fileAssociations.pending
  const transferBusy = upload !== null && !['completed', 'cancelled', 'expired', 'stopped'].includes(upload.phase)
  const view = snapshot.view
  const [selected, setSelected] = useState<OfficeDriveId | null>(null)
  const [form, setForm] = useState<DriveForm | null>(null)
  const [search, setSearch] = useState(snapshot.search)
  const [sort, setSort] = useState<'name' | 'updatedAt' | 'kind' | 'byteLength'>('name')
  const [ascending, setAscending] = useState(true)
  const [context, setContext] = useState<{ id: OfficeDriveId; x: number; y: number } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const current = view?.entries.find(entry => entry.id === selected) ?? null
  const searchTarget = props.useSearch(state => state.target)
  useEffect(() => {
    if (searchTarget?.kind !== 'file' || !view) return
    const file = searchTarget.file
    if (file.kind === 'folder' ? view.location.folderId !== file.id : !view.entries.some(entry => entry.id === file.id)) return
    setSelected(file.kind === 'file' ? file.id : null)
    props.consumeSearchTarget(searchTarget.key)
  }, [searchTarget, view, props.consumeSearchTarget])
  const contextEntry = view?.entries.find(entry => entry.id === context?.id) ?? null
  const contextPreview = contextEntry?.kind === 'file' && view?.transfers !== undefined && officeDrivePreviewKind(contextEntry) !== null
  useEffect(() => {
    setSearch(snapshot.search)
    setContext(null)
  }, [view?.location.space, view?.location.folderId])
  useEffect(() => {
    setContext(value => (value && !view?.entries.some(entry => entry.id === value.id) ? null : value))
  }, [view])
  useEffect(() => { setForm(value => value?.kind === 'trash' ? null : value) }, [office.me.role])
  const open = (entry: OfficeDriveEntry) => {
    setContext(null)
    if (snapshot.loading || snapshot.busy) return
    if (entry.kind === 'folder') props.navigateDrive({ space: entry.space, folderId: entry.id })
    else if (view?.transfers && officeDrivePreviewKind(entry)) props.previewDriveFile(entry.id)
    else void props.downloadDriveFile(entry.id)
  }
  const edit = (kind: EntryForm['kind'] | 'trash', entry: OfficeDriveEntry) => {
    setContext(null)
    setForm(kind === 'trash' ? { kind, entry, role: office.me.role } : { kind, entry })
  }
  const entries = [...(view?.entries ?? [])].sort((a, b) => {
    const grouping = Number(b.kind === 'folder') - Number(a.kind === 'folder')
    const difference = sort === 'name' || sort === 'kind' ? a[sort].localeCompare(b[sort]) : a[sort] - b[sort]
    return grouping || (ascending ? difference : -difference) || a.name.localeCompare(b.name)
  })
  const column = (key: typeof sort, label: OfficeKey) => (
    <th aria-sort={sort === key ? (ascending ? 'ascending' : 'descending') : 'none'}>
      <Button
        onClick={() => {
          if (sort === key) setAscending(value => !value)
          else {
            setSort(key)
            setAscending(true)
          }
        }}
      >
        {t(label)}
      </Button>
    </th>
  )
  const rootKey = view?.location.space === 'shared' ? 'sharedDrive' : 'privateDrive'
  let branch: ReactNode = view?.entries
    .filter(entry => entry.kind === 'folder')
    .map(entry => (
      <Button
        key={entry.id}
        className={css.treeItem}
        onClick={() => {
          props.navigateDrive({ space: entry.space, folderId: entry.id })
        }}
      >
        <IconFolderCloseRegular size={16} />
        {entry.name}
      </Button>
    ))
  for (const entry of [...(view?.path ?? [])].reverse())
    branch = (
      <div className={css.treeBranch}>
        <Button
          className={css.treeItem}
          aria-current={view?.location.folderId === entry.id ? 'page' : undefined}
          onClick={() => {
            props.navigateDrive({ space: entry.space, folderId: entry.id })
          }}
        >
          <IconFolderCloseRegular size={16} />
          {entry.name}
        </Button>
        <div className={css.treeBranch}>{branch}</div>
      </div>
    )
  const latest = form && 'entry' in form ? view?.entries.find(entry => entry.id === form.entry.id) : undefined

  return (
    <><section className={css.explorer} aria-label={t('drive')}>
      <div className={css.toolbar}>
        <Button
          disabled={!snapshot.canBack || snapshot.loading || snapshot.busy}
          onClick={() => {
            props.stepDrive(-1)
          }}
        >
          {t('driveBack')}
        </Button>
        <Button
          disabled={!snapshot.canForward || snapshot.loading || snapshot.busy}
          onClick={() => {
            props.stepDrive(1)
          }}
        >
          {t('driveForward')}
        </Button>
        <Button
          disabled={!view?.location.folderId || snapshot.loading || snapshot.busy}
          onClick={() => {
            if (view) props.navigateDrive({ space: view.location.space, folderId: view.path.at(-2)?.id ?? null })
          }}
        >
          {t('driveUp')}
        </Button>
        <Button disabled={snapshot.loading || snapshot.busy} onClick={props.loadDrive}>
          {t('refresh')}
        </Button>
        <Button disabled={current?.kind !== 'file' || !view?.transfers || snapshot.loading || snapshot.busy} onClick={() => {
          if (current?.kind === 'file') props.previewDriveFile(current.id)
        }}>{t('drivePreview')}</Button>
        <Button disabled={current?.kind !== 'file' || snapshot.loading || snapshot.busy} onClick={() => {
          if (current?.kind === 'file') void props.downloadDriveFile(current.id)
        }}>{t('downloadFile')}</Button>
        {view?.lifecycle === 1 && <>
          <Button disabled={current?.kind !== 'file' || snapshot.loading || snapshot.busy} onClick={() => {
            if (current?.kind === 'file') props.openDriveHistory(current.id)
          }}>{t('driveVersionHistory')}</Button>
          <Button disabled={!current?.canTrash || snapshot.loading || snapshot.busy} onClick={() => {
            if (current) edit('trash', current)
          }}>{t('driveDeleteFile')}</Button>
          <Button disabled={snapshot.busy} onClick={props.openDriveTrash}>{t('driveRecycleBin')}</Button>
        </>}
        <Button
          disabled={!view?.canCreate || snapshot.busy || snapshot.loading}
          onClick={() => {
            setForm({ kind: 'folder' })
          }}
        >
          {t('newFolder')}
        </Button>
        <Button
          disabled={!view?.canCreate || snapshot.busy || snapshot.loading || transferBusy}
          onClick={() => {
            fileInput.current?.click()
          }}
        >
          {t('uploadFile')}
        </Button>
        <Button
          disabled={!current?.canRename || snapshot.busy || snapshot.loading}
          onClick={() => {
            if (current) edit('rename', current)
          }}
        >
          {t('renameFile')}
        </Button>
        <Button
          disabled={!current?.canManageAccess || snapshot.busy || snapshot.loading}
          onClick={() => {
            if (current) edit('permissions', current)
          }}
        >
          {t('drivePermissions')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          hidden
          aria-label={t('uploadFile')}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) setForm({ kind: 'upload', file })
            event.target.value = ''
          }}
        />
        {fileLimits && <Button disabled={snapshot.loading || snapshot.busy || associationBusy || current?.kind !== 'file' ||
          !officeFileReferenceSupported(current, fileLimits)}
        onClick={() => { if (current) void props.useDriveFile(current.id) }}>{t('useFileInAI')}</Button>}
      </div>
      {fileLimits && <div className={css.fileNotice}>
        <p>{t(fileAssociations.choosing ? 'fileAssociationChoosing' : 'fileAssociationHint')}</p>
        {(fileAssociations.choosing || fileAssociations.pending) && <Button size="sm"
          onClick={props.returnToFileConversation}>{t('returnToFileConversation')}</Button>}
        {fileAssociations.preparing && <>
          <span role="status">{t('fileAssociationPreparing')}</span>
          <Button size="sm" onClick={props.cancelFilePreparation}>{t('cancelFilePreparation')}</Button>
        </>}
        {fileAssociations.error && <p role="alert" className={pageCss.error}>{t(fileAssociations.error)}</p>}
        {fileAssociations.pending && <Button size="sm" disabled={fileAssociations.busy}
          onClick={() => { void props.retryFileAssociations() }}>{t('retry')}</Button>}
      </div>}
      <div className={css.address}>
        <nav aria-label={t('drivePath')}>
          <Button
            onClick={() => {
              props.navigateDrive({ space: view?.location.space ?? 'private', folderId: null })
            }}
          >
            {t(rootKey)}
          </Button>
          {view?.path.map(entry => (
            <Button
              key={entry.id}
              onClick={() => {
                props.navigateDrive({ space: entry.space, folderId: entry.id })
              }}
            >
              {entry.name}
            </Button>
          ))}
        </nav>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            props.searchDrive(search)
          }}
        >
          <Input
            value={search}
            maxLength={200}
            aria-label={t('driveSearch')}
            placeholder={t('driveSearch')}
            onChange={(event) => {
              setSearch(event.target.value)
            }}
          />
          <Button type="submit" disabled={snapshot.loading}>
            {t('searchFiles')}
          </Button>
          {snapshot.search && (
            <Button
              onClick={() => {
                setSearch('')
                props.searchDrive('')
              }}
            >
              {t('clearSearch')}
            </Button>
          )}
        </form>
      </div>
      {snapshot.error && (
        <div role="alert" className={pageCss.error}>
          {t(snapshot.error)} <Button onClick={props.loadDrive}>{t('retry')}</Button>
        </div>
      )}
      {view?.transfers && <TransferPanel {...props} />}
      <div className={css.body}>
        <nav className={css.tree} aria-label={t('driveFolders')}>
          {(['private', 'shared'] as const).map(space => (
            <div key={space}>
              <Button
                className={css.treeItem}
                aria-current={view?.location.space === space && view.location.folderId === null ? 'page' : undefined}
                onClick={() => {
                  props.navigateDrive({ space, folderId: null })
                }}
              >
                <IconFolderCloseRegular size={18} />
                {t(space === 'private' ? 'privateDrive' : 'sharedDrive')}
              </Button>
              {view?.location.space === space && <div className={css.treeBranch}>{branch}</div>}
            </div>
          ))}
        </nav>
        <div className={css.files} aria-busy={snapshot.loading}>
          {!view && snapshot.loading ? (
            <div className={css.loading}>
              <progress aria-label={t('loading')} />
            </div>
          ) : (
            view && (
              <>
                <table className={css.table} aria-label={t('driveFiles')}>
                  <thead>
                    <tr>
                      {column('name', 'name')}
                      {column('updatedAt', 'modified')}
                      {column('kind', 'fileType')}
                      {column('byteLength', 'fileSize')}
                      <th>{t('drivePermissions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(entry => (
                      <tr
                        key={entry.id}
                        tabIndex={0}
                        aria-selected={selected === entry.id}
                        data-drive-entry={entry.id}
                        onClick={() => {
                          setSelected(entry.id)
                        }}
                        onDoubleClick={() => {
                          open(entry)
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setSelected(entry.id)
                          setContext({ id: entry.id, x: event.clientX, y: event.clientY })
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            open(entry)
                          } else if (event.key === 'F2' && entry.canRename && !snapshot.busy) {
                            event.preventDefault()
                            edit('rename', entry)
                          } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                            event.preventDefault()
                            const rect = event.currentTarget.getBoundingClientRect()
                            setSelected(entry.id)
                            setContext({ id: entry.id, x: rect.left + 40, y: rect.bottom })
                          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault()
                            const next =
                              event.key === 'ArrowDown'
                                ? event.currentTarget.nextElementSibling
                                : event.currentTarget.previousElementSibling
                            if (next instanceof HTMLElement) {
                              next.focus()
                              setSelected(next.dataset.driveEntry as OfficeDriveId)
                            }
                          }
                        }}
                      >
                        <td>
                          <span className={css.entryName}>
                            {entry.kind === 'folder' && <IconFolderCloseRegular size={18} />}
                            {entry.name}
                          </span>
                        </td>
                        <td>
                          {new Intl.DateTimeFormat(undefined, {
                            timeZone: office.timeZone,
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }).format(entry.updatedAt)}
                        </td>
                        <td>{t(entry.kind === 'folder' ? 'folder' : 'file')}</td>
                        <td>{entry.kind === 'file' ? size(entry.byteLength) : '—'}</td>
                        <td>
                          {t(
                            entry.ownerId === office.me.id
                              ? 'driveOwner'
                              : entry.access === 'edit'
                                ? 'driveEdit'
                                : 'driveView',
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {entries.length === 0 && (
                  <p className={pageCss.empty}>{t(snapshot.search ? 'noFileResults' : 'emptyFolder')}</p>
                )}
              </>
            )
          )}
        </div>
      </div>
      <footer className={css.footer}>
        <span>
          {t('itemCount')}: {entries.length}
        </span>
        {view && (
          <span>
            {t('uploadLimit')}: {size(view.transfers?.maxFileBytes ?? view.maxFileBytes)}
          </span>
        )}
        {view && !view.canCreate && <span>{t('driveReadOnly')}</span>}
        {view?.quota && <span aria-label={t('driveQuota')}>
          {t('driveQuotaUsed')}: {size(view.quota.usedBytes)} / {size(view.quota.limitBytes)}
          {' · '}{t('driveQuotaReserved')}: {size(view.quota.reservedBytes)}
        </span>}
      </footer>
      <Menu
        open={context !== null && contextEntry !== null}
        anchor={<span />}
        portal
        autoFocus
        getAnchorRect={() => (context ? new DOMRect(context.x, context.y, 1, 1) : null)}
        onClose={() => {
          setContext(null)
        }}
      >
        <MenuItemButton
          disabled={snapshot.busy}
          onSelect={() => {
            if (contextEntry) open(contextEntry)
          }}
        >
          {t(contextEntry?.kind === 'folder' ? 'openFolder' : contextPreview ? 'drivePreview' : 'downloadFile')}
        </MenuItemButton>
        {contextEntry && contextPreview && <MenuItemButton disabled={snapshot.busy} onSelect={() => {
          void props.downloadDriveFile(contextEntry.id)
          setContext(null)
        }}>{t('downloadFile')}</MenuItemButton>}
        {contextEntry?.kind === 'file' && fileLimits && <MenuItemButton disabled={snapshot.busy || associationBusy ||
          !officeFileReferenceSupported(contextEntry, fileLimits)} onSelect={() => {
          setContext(null)
          void props.useDriveFile(contextEntry.id)
        }}>{t('useFileInAI')}</MenuItemButton>}
        {view?.lifecycle === 1 && contextEntry?.kind === 'file' && <MenuItemButton disabled={snapshot.busy} onSelect={() => {
          props.openDriveHistory(contextEntry.id)
          setContext(null)
        }}>{t('driveVersionHistory')}</MenuItemButton>}
        {view?.lifecycle === 1 && <MenuItemButton disabled={!contextEntry?.canTrash || snapshot.busy} onSelect={() => {
          if (contextEntry) edit('trash', contextEntry)
        }}>{t('driveDeleteFile')}</MenuItemButton>}
        <MenuItemButton
          disabled={!contextEntry?.canRename || snapshot.busy}
          onSelect={() => {
            if (contextEntry) edit('rename', contextEntry)
          }}
        >
          {t('renameFile')}
        </MenuItemButton>
        <MenuItemButton
          disabled={!contextEntry?.canManageAccess || snapshot.busy}
          onSelect={() => {
            if (contextEntry) edit('permissions', contextEntry)
          }}
        >
          {t('drivePermissions')}
        </MenuItemButton>
      </Menu>
      <OfficeDrivePreview {...props} />
      <OfficeDriveLifecycle key={`${office.me.id}:${office.me.role}`} {...props} office={office}
        deletion={form?.kind === 'trash' && form.role === office.me.role ? form.entry : null} latestDeletion={latest ?? null}
        closeDeletion={() => { setForm(null) }} reviewDeletion={(entry) => { setForm({ kind: 'trash', entry, role: office.me.role }) }} />
      {view && form && (
        <>
          {(form.kind === 'folder' || form.kind === 'rename') && (
            <NameForm
              key={form.kind === 'rename' ? `${form.entry.id}:${form.entry.revision}` : 'folder'}
              {...props}
              view={view}
              entry={form.kind === 'rename' ? form.entry : null}
              latest={latest ?? null}
              onLatest={(entry) => {
                setForm({ kind: 'rename', entry })
              }}
              onClose={() => {
                setForm(null)
              }}
            />
          )}
          {form.kind === 'permissions' && (
            <PermissionsForm
              key={`${form.entry.id}:${form.entry.revision}`}
              {...props}
              entry={form.entry}
              latest={latest ?? null}
              onLatest={(entry) => {
                setForm({ kind: 'permissions', entry })
              }}
              onClose={() => {
                setForm(null)
              }}
            />
          )}
          {form.kind === 'upload' && (
            <UploadForm
              {...props}
              view={view}
              file={form.file}
              onClose={() => {
                setForm(null)
              }}
            />
          )}
        </>
      )}
    </section>
    {office.knowledge && <OfficeKnowledge key={`${office.me.id}:${office.me.role}`} {...props}
      selectedFile={current?.kind === 'file' ? current.id : null}
      publisher={office.me.role === 'admin' || office.me.role === 'manager'} />}</>
  )
}

type VersionProps = {
  entry: OfficeDriveEntry
  latest: OfficeDriveEntry | null
  onLatest(this: void, entry: OfficeDriveEntry): void
}
function Changed(props: Pick<DriveProps, 't'> & VersionProps) {
  return (
    <div role="alert" className={pageCss.error}>
      {props.t('driveChanged')}
      {props.latest && (
        <Button
          onClick={() => {
            if (props.latest) props.onLatest(props.latest)
          }}
        >
          {props.t('loadLatestMember')}
        </Button>
      )}
    </div>
  )
}

function NameForm(
  props: DriveProps & {
    view: OfficeDriveView
    entry: OfficeDriveEntry | null
    latest: OfficeDriveEntry | null
    onLatest(this: void, entry: OfficeDriveEntry): void
    onClose(this: void): void
  },
) {
  const { t, entry, view, onClose } = props
  const busy = props.useDrive(value => value.busy)
  const stale = entry !== null && props.latest?.revision !== entry.revision
  const writable = entry ? props.latest?.canRename === true : view.canCreate
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || stale || !writable) return
    const name = formText(new FormData(event.currentTarget), 'name')
    const saved = entry
      ? await props.renameDriveEntry({ id: entry.id, revision: entry.revision, name })
      : await props.createDriveFolder({ ...view.location, name })
    if (saved) onClose()
  }
  return (
    <Modal
      open
      title={t(entry ? 'renameFile' : 'newFolder')}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className={pageCss.form}
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <label>
          {t('name')}
          <Input name="name" defaultValue={entry?.name ?? ''} required maxLength={255} data-modal-autofocus />
        </label>
        {stale && <Changed t={t} entry={entry} latest={props.latest} onLatest={props.onLatest} />}
        {!writable && !stale && <p role="status">{t('driveReadOnly')}</p>}
        <div className={pageCss.row}>
          <Button disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || stale || !writable}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function PermissionsForm(props: DriveProps & VersionProps & { onClose(this: void): void }) {
  const { t, entry, office, onClose } = props
  const busy = props.useDrive(value => value.busy)
  const [fallback, setFallback] = useState<OfficeDriveDefault>(entry.defaultAccess ?? 'inherit')
  const [values, setValues] = useState<Readonly<Record<string, OfficeDriveDefault>>>(
    Object.fromEntries(entry.grants?.map(grant => [grant.memberId, grant.access]) ?? []),
  )
  const stale = props.latest?.revision !== entry.revision
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const grants: OfficeDriveGrant[] = office.members.flatMap((member) => {
      const access = recordValue(values, member.id) ?? 'inherit'
      return member.id !== entry.ownerId && access !== 'inherit' ? [{ memberId: member.id, access }] : []
    })
    if (await props.saveDrivePermissions({ id: entry.id, revision: entry.revision, defaultAccess: fallback, grants }))
      onClose()
  }
  return (
    <Modal
      open
      title={t('drivePermissions')}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className={pageCss.form}
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <p>{entry.name}</p>
        <p>{t('permissionHint')}</p>
        <label>
          {t('defaultPermission')}
          <select
            aria-label={t('defaultPermission')}
            value={fallback}
            onChange={(event) => {
              setFallback(event.target.value as OfficeDriveDefault)
            }}
          >
            {conditions.map(value => (
              <option key={value} value={value}>
                {t(conditionKeys[value])}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>{t('accountPermissions')}</legend>
          {office.members
            .filter(member => member.id !== entry.ownerId)
            .map(member => (
              <label key={member.id}>
                {member.name}
                <select
                  aria-label={`${t('permissionFor')} ${member.name}`}
                  value={recordValue(values, member.id) ?? 'inherit'}
                  onChange={(event) => {
                    setValues({ ...values, [member.id]: event.target.value as OfficeDriveDefault })
                  }}
                >
                  {conditions.map(value => (
                    <option key={value} value={value}>
                      {t(conditionKeys[value])}
                    </option>
                  ))}
                </select>
              </label>
            ))}
        </fieldset>
        {stale && <Changed t={t} entry={entry} latest={props.latest} onLatest={props.onLatest} />}
        <div className={pageCss.row}>
          <Button disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || stale}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function UploadForm(props: DriveProps & { view: OfficeDriveView; file: File; onClose(this: void): void }) {
  const { t, view, file, onClose } = props
  const busy = props.useDrive(value => value.busy)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<OfficeKey | null>(null)
  const payload = useRef<OfficeDriveUploadInput | null>(null)
  const location = useRef(view.location).current
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const maxFileBytes = view.transfers?.maxFileBytes ?? view.maxFileBytes
  const tooLarge = file.size > maxFileBytes
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (tooLarge || busy || reading) return
    if (view.transfers) {
      if (props.startDriveUpload(file, location)) onClose()
      return
    }
    setReading(true)
    setError(null)
    try {
      if (!payload.current) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (!mounted.current) return
        payload.current = {
          ...location,
          name: file.name,
          requestId: randomUUID(),
          mediaType: file.type || 'application/octet-stream',
          byteLength: bytes.byteLength,
          dataBase64: bytesToBase64(bytes),
        }
      }
      if ((await props.uploadDriveFile(payload.current)) && mounted.current) onClose()
    } catch {
      if (mounted.current) setError('fileReadFailed')
    } finally {
      if (mounted.current) setReading(false)
    }
  }
  return (
    <Modal
      open
      title={t('uploadFile')}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy && !reading) onClose()
      }}
    >
      <form
        className={pageCss.form}
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <p>
          {file.name} · {size(file.size)}
        </p>
        <p>
          {t('uploadLimit')}: {size(maxFileBytes)}
        </p>
        {(error || tooLarge) && (
          <p role="alert" className={pageCss.error}>
            {t(tooLarge ? 'uploadTooLarge' : (error ?? 'fileReadFailed'))}
          </p>
        )}
        <div className={pageCss.row}>
          <Button disabled={busy || reading} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || reading || tooLarge}>
            {t(busy || reading ? 'uploadingFile' : 'uploadFile')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

const uploadLabels = {
  hashing: 'driveHashing', uploading: 'uploadingFile', finishing: 'driveFinishing', cancelling: 'driveCancelling',
  failed: 'driveTransferFailed', completed: 'driveUploadCompleted', cancelled: 'driveTransferCancelled', expired: 'driveTransferExpired',
  stopped: 'driveTransferStopped',
} as const
const downloadLabels = {
  preparing: 'driveDownloading', downloading: 'driveDownloading', verifying: 'driveVerifying',
  failed: 'driveTransferFailed', completed: 'driveDownloadCompleted', cancelled: 'driveTransferCancelled',
} as const

function TransferPanel(props: DriveProps) {
  const { t } = props
  const { upload, download, pending, pendingError, pendingLoading } = props.useDriveTransfers(value => value)
  const picker = useRef<HTMLInputElement>(null)
  const selection = useRef<OfficeDriveUploadTicket | 'replace' | null>(null)
  const settled = upload !== null && ['completed', 'cancelled', 'expired', 'stopped'].includes(upload.phase)
  const locked = upload !== null && !settled
  const tickets = pending.filter(value => value.id !== upload?.ticketId)
  if (!upload && !download && !pendingError && tickets.length === 0) return null
  return (
    <section className={css.transfers} aria-label={t('driveTransfers')}>
      <input
        ref={picker}
        type="file"
        hidden
        aria-label={t('driveResumeFile')}
        onChange={(event) => {
          const file = event.target.files?.[0]
          const ticket = selection.current
          if (file) {
            if (ticket === 'replace') props.reselectDriveUpload(file)
            else if (ticket) props.startDriveUpload(file, ticket, ticket.id)
          }
          event.target.value = ''
          selection.current = null
        }}
      />
      {upload && (
        <div className={css.transferRow}>
          <div className={css.transferDetails}>
            <span>{upload.name}</span>
            <span><span>{t(uploadLabels[upload.phase])}</span> · {size(upload.done)} / {size(upload.byteLength)}</span>
            <progress
              aria-label={t(upload.phase === 'hashing' ? 'driveHashProgress' : 'driveUploadProgress')}
              max={Math.max(1, upload.byteLength)}
              value={upload.phase === 'hashing' ? upload.hashed : upload.done}
            />
            {upload.error && <span role="alert">{t(upload.error)}</span>}
          </div>
          {upload.phase === 'failed' && (
            <>
              <Button onClick={props.retryDriveUpload}>{t(upload.cancelRequested ? 'driveRetryCancel' : 'retry')}</Button>
              {!upload.cancelRequested && (
                <Button onClick={() => { selection.current = 'replace'; picker.current?.click() }}>
                  {t('driveReselectFile')}
                </Button>
              )}
            </>
          )}
          {settled ? <Button onClick={props.dismissDriveUpload}>{t('close')}</Button> : (
            <Button disabled={upload.phase === 'cancelling'} onClick={props.cancelDriveUpload}>{t('cancel')}</Button>
          )}
        </div>
      )}
      {download && (
        <div className={css.transferRow}>
          <div className={css.transferDetails}>
            <span>{download.name || t('downloadFile')}</span>
            <span><span>{t(downloadLabels[download.phase])}</span> · {size(download.done)} / {size(download.byteLength)}</span>
            <progress aria-label={t('driveDownloadProgress')} max={Math.max(1, download.byteLength)} value={download.done} />
            {download.error && <span role="alert">{t(download.error)}</span>}
          </div>
          {download.phase === 'failed' && <Button onClick={props.retryDriveDownload}>{t('retry')}</Button>}
          {['failed', 'completed', 'cancelled'].includes(download.phase) ? (
            <Button onClick={props.dismissDriveDownload}>{t('close')}</Button>
          ) : <Button onClick={props.cancelDriveDownload}>{t('cancel')}</Button>}
        </div>
      )}
      {tickets.length > 0 && (
        <>
          <span>{t('drivePendingUploads')}</span>
          <p className={css.resumeHint}>{t('driveResumeHint')}</p>
          {tickets.map(ticket => (
            <div className={css.transferRow} key={ticket.id}>
              <div className={css.transferDetails}>
                <span>{ticket.name}</span>
                <span>{size(ticket.receivedBytes)} / {size(ticket.byteLength)}</span>
              </div>
              <Button disabled={locked} onClick={() => { selection.current = ticket; picker.current?.click() }}>
                {t('driveResumeFile')}
              </Button>
              <Button disabled={locked} onClick={() => { props.cancelPendingDriveUpload(ticket.id) }}>{t('cancel')}</Button>
            </div>
          ))}
        </>
      )}
      {pendingError && <p role="alert">{t(pendingError)}</p>}
      {(tickets.length > 0 || pendingError) && (
        <Button disabled={pendingLoading} onClick={props.refreshDriveUploads}>{t('refresh')}</Button>
      )}
    </section>
  )
}
