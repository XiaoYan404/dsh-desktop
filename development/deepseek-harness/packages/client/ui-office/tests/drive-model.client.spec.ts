/** Directory navigation, metadata privacy and pending file operations across employee replacement. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeDriveDownload, OfficeDriveEntry, OfficeDriveId, OfficeDriveQuery,
  OfficeDriveView, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeDriveModel } from '../src/client/drive-model.ts'

const me = 'me' as OfficeMemberId
const other = 'other' as OfficeMemberId
const folderId = '499ad5c1-b073-4d3c-89aa-fb04f22def30' as OfficeDriveId
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const entry: OfficeDriveEntry = { id: folderId, parentId: null, space: 'private', ownerId: me, kind: 'folder', name: 'Private folder', revision: 1, createdAt: 1, updatedAt: 1, byteLength: 0, mediaType: '', access: 'edit', canRename: true, canManageAccess: false }
const view = (query: OfficeDriveQuery = { space: 'private', folderId: null, search: '' }, employee = me): OfficeDriveView => ({ revision: 1, meId: employee, location: { space: query.space, folderId: query.folderId }, path: query.folderId ? [entry] : [], entries: query.folderId ? [] : [entry], canCreate: true, maxFileBytes: 8 * 1024 * 1024 })
const file: OfficeDriveDownload = { id: folderId, name: 'private.txt', mediaType: 'text/plain', byteLength: 3, sha256: 'x'.repeat(64), dataBase64: 'YWJj' }
type DriveRemote = ConstructorParameters<typeof OfficeDriveModel>[0]
const remote = () => ({
  drive: vi.fn<DriveRemote['drive']>().mockImplementation(async query => success(view(query))),
  createDriveFolder: vi.fn<DriveRemote['createDriveFolder']>().mockResolvedValue(success(entry)),
  renameDriveEntry: vi.fn<DriveRemote['renameDriveEntry']>().mockResolvedValue(success(entry)),
  saveDrivePermissions: vi.fn<DriveRemote['saveDrivePermissions']>().mockResolvedValue(success(entry)),
  uploadDriveFile: vi.fn<DriveRemote['uploadDriveFile']>().mockResolvedValue(success(entry)),
  downloadDriveFile: vi.fn<DriveRemote['downloadDriveFile']>().mockResolvedValue(success(file)),
})
const models: OfficeDriveModel[] = []
function create(api = remote()) {
  const notify = vi.fn()
  const model = new OfficeDriveModel(api, notify)
  models.push(model)
  return { model, notify }
}
async function ready(model: OfficeDriveModel) {
  model.bind(me)
  await vi.waitFor(() => { expect(model.state.getSnapshot().view?.meId).toBe(me) })
}
afterEach(() => { for (const model of models.splice(0)) model.dispose() })

describe('OfficeDriveModel', () => {
  it('clears directory data and fences an earlier refresh when a download loses authentication', async () => {
    const api = remote()
    const { model } = create(api)
    await ready(model)
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeDriveView>>>()
    api.drive.mockReturnValueOnce(pending.promise)
    const reading = model.load()
    api.downloadDriveFile.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
    expect(await model.download(folderId)).toBeNull()
    pending.resolve(success(view()))
    await reading
    expect(model.state.getSnapshot()).toMatchObject({ view: null, busy: false, error: 'unauthenticated', canBack: false })
  })

  it('keeps confirmed back/forward history while search and refresh retain the current location', async () => {
    const api = remote()
    const { model } = create(api)
    await ready(model)
    await model.navigate({ space: 'private', folderId })
    expect(model.state.getSnapshot()).toMatchObject({ canBack: true, canForward: false })
    await model.navigate({ space: 'shared', folderId: null })
    await model.step(-1)
    expect(model.state.getSnapshot().view?.location).toEqual({ space: 'private', folderId })
    await model.search('report')
    await model.load()
    expect(api.drive).toHaveBeenLastCalledWith({ space: 'private', folderId, search: 'report' })
    expect(model.state.getSnapshot()).toMatchObject({ canBack: true, canForward: true, search: 'report' })
    await model.step(1)
    expect(model.state.getSnapshot()).toMatchObject({ canForward: false, search: '' })
    expect(model.state.getSnapshot().view?.location.space).toBe('shared')
  })

  it('ignores a slow directory response after a newer root navigation has confirmed', async () => {
    const api = remote()
    const { model } = create(api)
    await ready(model)
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeDriveView>>>()
    api.drive.mockReturnValueOnce(pending.promise)
    const old = model.navigate({ space: 'private', folderId })
    await model.navigate({ space: 'shared', folderId: null })
    pending.resolve(success(view({ space: 'private', folderId, search: '' })))
    await old
    expect(model.state.getSnapshot().view?.location).toEqual({ space: 'shared', folderId: null })
    await model.step(-1)
    expect(model.state.getSnapshot().view?.location).toEqual({ space: 'private', folderId: null })
  })

  it('keeps confirmed files on a transient failure and clears them after access is revoked', async () => {
    const api = remote()
    const { model } = create(api)
    await ready(model)
    const before = model.state.getSnapshot().view
    api.drive.mockRejectedValueOnce(new Error('Offline'))
    await model.load()
    expect(model.state.getSnapshot()).toMatchObject({ view: before, error: 'unavailable' })
    api.drive.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'not_found' } })
    await model.load()
    expect(model.state.getSnapshot()).toMatchObject({ view: null, canBack: false, canForward: false, error: 'not_found' })
  })

  it('admits one mutation, preserves confirmed rows on conflict and reports outcomes through the shell', async () => {
    const api = remote()
    const { model, notify } = create(api)
    await ready(model)
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeDriveEntry>>>()
    api.createDriveFolder.mockReturnValueOnce(pending.promise)
    const saving = model.createFolder({ space: 'private', folderId: null, name: 'new' })
    expect(await model.rename({ id: folderId, revision: 1, name: 'blocked' })).toBe(false)
    expect(api.renameDriveEntry).not.toHaveBeenCalled()
    pending.resolve({ ok: true, value: { ok: false, code: 'conflict' } })
    expect(await saving).toBe(false)
    expect(model.state.getSnapshot().view?.entries).toEqual([entry])
    expect(model.state.getSnapshot().busy).toBe(false)
    expect(notify).toHaveBeenCalledWith('conflict', false)
    expect(await model.createFolder({ space: 'private', folderId: null, name: 'confirmed' })).toBe(true)
    expect(notify).toHaveBeenLastCalledWith('saved', true)
  })

  it('fences an old employee upload and clears private navigation before publishing the replacement', async () => {
    const api = remote()
    const { model, notify } = create(api)
    await ready(model)
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeDriveEntry>>>()
    api.uploadDriveFile.mockReturnValueOnce(pending.promise)
    const input = { space: 'private' as const, folderId: null, name: 'private.txt', requestId: randomUUID(), mediaType: 'text/plain', byteLength: 3, dataBase64: 'YWJj' }
    const uploading = model.upload(input)
    api.drive.mockImplementation(async query => success(view(query, other)))
    model.bind(other)
    expect(model.state.getSnapshot().view).toBeNull()
    pending.resolve(success(entry))
    expect(await uploading).toBe(false)
    await vi.waitFor(() =>{  expect(model.state.getSnapshot().view?.meId).toBe(other) })
    expect(notify).not.toHaveBeenCalled()
    expect(model.state.getSnapshot()).toMatchObject({ busy: false, canBack: false })
    expect(api.uploadDriveFile).toHaveBeenCalledWith(input)
  })

  it('does not return an old identity download or a late response after plugin unload', async () => {
    const api = remote()
    const { model } = create(api)
    await ready(model)
    const first = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeDriveDownload>>>()
    api.downloadDriveFile.mockReturnValueOnce(first.promise)
    const downloading = model.download(folderId)
    model.bind(null)
    first.resolve(success(file))
    expect(await downloading).toBeNull()
    await ready(model)
    const second = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeDriveDownload>>>()
    api.downloadDriveFile.mockReturnValueOnce(second.promise)
    const unloading = model.download(folderId)
    model.dispose()
    second.resolve(success(file))
    expect(await unloading).toBeNull()
    expect(model.state.getSnapshot().view).toBeNull()
  })

  it('returns confirmed downloads without a false saved notification and rejects a wrong-account view', async () => {
    const api = remote()
    const { model, notify } = create(api)
    await ready(model)
    expect(await model.download(folderId)).toEqual(file)
    expect(notify).not.toHaveBeenCalled()
    api.drive.mockResolvedValueOnce(success(view(undefined, other)))
    await model.load()
    expect(model.state.getSnapshot()).toMatchObject({ view: null, error: 'forbidden' })
  })

  it('retries the same supplied upload identity after transport failure without changing confirmed rows', async () => {
    const api = remote()
    const { model, notify } = create(api)
    await ready(model)
    api.uploadDriveFile.mockRejectedValueOnce(new Error('Response lost'))
    const input = { space: 'private' as const, folderId: null, name: 'retry.txt', requestId: randomUUID(), mediaType: 'text/plain', byteLength: 3, dataBase64: 'YWJj' }
    expect(await model.upload(input)).toBe(false)
    expect(notify).toHaveBeenCalledWith('unavailable', false)
    expect(model.state.getSnapshot().view?.entries).toEqual([entry])
    expect(await model.upload(input)).toBe(true)
    expect(api.uploadDriveFile.mock.calls.map(([value]) => value.requestId)).toEqual([input.requestId, input.requestId])
  })
})
