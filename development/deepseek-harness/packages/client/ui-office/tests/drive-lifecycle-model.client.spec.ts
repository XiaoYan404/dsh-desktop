/** Read replacement, reviewed mutation and identity lifetimes for Drive metadata. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { OfficeDriveEntry, OfficeDriveHistory, OfficeDriveId, OfficeDriveTrash, OfficeMemberId,
  OfficeDriveVersionId, OfficeDrivePurgeRequestId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeDriveLifecycleModel } from '../src/client/drive-lifecycle-model.ts'

type Remote = ConstructorParameters<typeof OfficeDriveLifecycleModel>[0]
const me = 'employee' as OfficeMemberId
const other = 'other' as OfficeMemberId
const id = 'b2168599-4130-4b31-89be-392fa8d2758e' as OfficeDriveId
const entry: OfficeDriveEntry = { id, parentId: null, space: 'private', ownerId: me, kind: 'file', name: 'Owned.txt',
  revision: 1, createdAt: 1, updatedAt: 1, byteLength: 1, mediaType: 'text/plain', access: 'edit',
  canRename: true, canManageAccess: false, canUpdate: true, canTrash: true }
const history: OfficeDriveHistory = { entry, versions: [{ versionId: '6b75889c-6c01-48f9-9345-cc778a68e0d2' as OfficeDriveVersionId,
  sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'text/plain', createdAt: 1, actorId: me, current: true }] }
const trash: OfficeDriveTrash = { revision: 1, meId: me, entries: [{ ...entry, revision: 2, deletedAt: 2 }] }
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
function fixture() {
  const remote = { driveHistory: vi.fn<Remote['driveHistory']>().mockResolvedValue(success(history)),
    driveTrash: vi.fn<Remote['driveTrash']>().mockResolvedValue(success(trash)),
    drivePurgeStatus: vi.fn<Remote['drivePurgeStatus']>().mockResolvedValue(success(null)),
    drivePurgePlan: vi.fn<Remote['drivePurgePlan']>().mockResolvedValue(success({ entry: { ...trash.entries[0]!, canPurge: true },
      digest: 'c'.repeat(64), files: 1, folders: 0, versions: 1, byteLength: 1 })),
    purgeDrive: vi.fn<Remote['purgeDrive']>(), retryDrivePurge: vi.fn<Remote['retryDrivePurge']>(),
    changeDriveLifecycle: vi.fn<Remote['changeDriveLifecycle']>().mockResolvedValue(success(entry)) }
  const published = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const unauthenticated = vi.fn()
  const model = new OfficeDriveLifecycleModel(remote, published, unauthenticated)
  model.bind({ id: me, role: 'employee' })
  onTestFinished(() => { model.dispose() })
  return { model, remote, published, unauthenticated }
}

it('publishes only the current popup read and rejects a mismatched recycle-bin principal', async () => {
  const { model, remote } = fixture()
  const old = Promise.withResolvers<Awaited<ReturnType<Remote['driveHistory']>>>()
  remote.driveHistory.mockReturnValueOnce(old.promise)
  model.openHistory(id)
  model.openTrash()
  await vi.waitFor(() => { expect(model.state.getSnapshot().trash).toEqual(trash) })
  old.resolve(success(history))
  await old.promise
  expect(model.state.getSnapshot()).toMatchObject({ panel: 'trash', history: null, trash })
  remote.driveTrash.mockResolvedValueOnce(success({ ...trash, meId: other }))
  expect(await model.refresh()).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ history: null, trash: null, error: 'forbidden' })
  model.openHistory(id)
  model.bind({ id: me, role: 'admin' })
  await Promise.resolve()
  expect(model.state.getSnapshot()).toMatchObject({ panel: null, history: null, trash: null })
})

it('retains reviewed actions after conflicts, blocks double submission and refreshes confirmed metadata', async () => {
  const { model, remote, published } = fixture()
  model.openTrash()
  await vi.waitFor(() => { expect(model.state.getSnapshot().loading).toBe(false) })
  const input = { id, revision: 2, action: 'restore', name: 'Reviewed restored name.txt' } as const
  remote.changeDriveLifecycle.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'conflict' } })
  expect(await model.change(input)).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ panel: 'trash', trash, busy: false, error: 'conflict' })
  expect(published).not.toHaveBeenCalled()
  const held = Promise.withResolvers<Awaited<ReturnType<Remote['changeDriveLifecycle']>>>()
  remote.changeDriveLifecycle.mockReturnValueOnce(held.promise)
  const save = model.change(input)
  expect(await model.change({ ...input, name: 'Unreviewed replacement.txt' })).toBe(false)
  held.resolve(success(entry))
  expect(await save).toBe(true)
  expect(published).toHaveBeenCalledTimes(1)
  expect(remote.changeDriveLifecycle.mock.calls).toEqual([[input], [input]])
  expect(model.state.getSnapshot()).toMatchObject({ panel: 'trash', loading: false, busy: false, error: null })
})

it('withdraws metadata immediately when the current server request loses authentication', async () => {
  const { model, remote, unauthenticated } = fixture()
  model.openTrash()
  await vi.waitFor(() => { expect(model.state.getSnapshot().trash).toEqual(trash) })
  remote.driveTrash.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
  expect(await model.refresh()).toBe(false)
  expect(unauthenticated).toHaveBeenCalledTimes(1)
  expect(model.state.getSnapshot()).toMatchObject({ panel: null, trash: null, history: null })
  model.openTrash()
  expect(model.state.getSnapshot().panel).toBeNull()
})

it('contains closed writes and ignores late callbacks across sign-out, same-employee sign-in and disposal', async () => {
  const { model, remote, published } = fixture()
  const input = { id, revision: 1, action: 'trash' } as const
  const first = Promise.withResolvers<Awaited<ReturnType<Remote['changeDriveLifecycle']>>>()
  remote.changeDriveLifecycle.mockReturnValueOnce(first.promise)
  const closed = model.change(input)
  model.close()
  first.resolve(success(entry))
  expect(await closed).toBe(false)
  expect(published).toHaveBeenCalledTimes(1)
  expect(model.state.getSnapshot()).toMatchObject({ panel: null, busy: false, history: null, trash: null })
  const second = Promise.withResolvers<Awaited<ReturnType<Remote['changeDriveLifecycle']>>>()
  remote.changeDriveLifecycle.mockReturnValueOnce(second.promise)
  const replaced = model.change(input)
  model.bind(null)
  model.bind({ id: me, role: 'employee' })
  second.resolve(success(entry))
  expect(await replaced).toBe(false)
  expect(published).toHaveBeenCalledTimes(1)
  const late = Promise.withResolvers<Awaited<ReturnType<Remote['driveHistory']>>>()
  remote.driveHistory.mockReturnValueOnce(late.promise)
  model.openHistory(id)
  model.dispose()
  late.resolve(success(history))
  await late.promise
  expect(model.state.getSnapshot()).toMatchObject({ panel: null, history: null, trash: null })
})

it('retains the exact irreversible confirmation across unknown acknowledgements and failed status checks', async () => {
  const { model, remote, published } = fixture()
  model.openTrash()
  await vi.waitFor(() => { expect(model.state.getSnapshot().loading).toBe(false) })
  model.openPurge(id)
  await vi.waitFor(() => { expect(model.state.getSnapshot().purge?.plan?.digest).toBe('c'.repeat(64)) })
  expect(remote.purgeDrive).not.toHaveBeenCalled()
  remote.purgeDrive.mockRejectedValueOnce(new Error('Confirmation connection lost'))
  await model.confirmPurge()
  expect(model.state.getSnapshot().purge?.uncertain).toBe(true)
  const original = remote.purgeDrive.mock.calls[0]![0]
  remote.drivePurgeStatus.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Status connection unavailable', {}) })
  await model.reviewPurge()
  expect(model.state.getSnapshot().purge).toMatchObject({ uncertain: true, plan: null })
  remote.purgeDrive.mockResolvedValueOnce(success({ id, requestId: original.requestId, status: 'completed',
    requestedAt: 3, completedAt: 4, files: 1, folders: 0, versions: 1, byteLength: 1 }))
  await model.confirmPurge()
  expect(remote.purgeDrive.mock.calls).toEqual([[original], [original]])
  expect(model.state.getSnapshot().purge?.receipt?.status).toBe('completed')
  expect(published).toHaveBeenCalledTimes(1)
})

it('recovers saved pending receipts without reviewing or approving a different scope and blocks duplicate retries', async () => {
  const { model, remote, published } = fixture()
  const receipt = { id, requestId: 'bbcf57f5-b17b-4cb2-9639-a009c04f8117' as OfficeDrivePurgeRequestId,
    status: 'pending', requestedAt: 3, completedAt: null, files: 1, folders: 0, versions: 1, byteLength: 1 } as const
  remote.drivePurgeStatus.mockResolvedValueOnce(success(receipt))
  model.openPurge(id)
  await vi.waitFor(() => { expect(model.state.getSnapshot().purge?.receipt).toEqual(receipt) })
  expect(remote.drivePurgePlan).not.toHaveBeenCalled()
  expect(remote.purgeDrive).not.toHaveBeenCalled()
  const held = Promise.withResolvers<Awaited<ReturnType<Remote['retryDrivePurge']>>>()
  remote.retryDrivePurge.mockReturnValueOnce(held.promise)
  const retry = model.confirmPurge(true)
  await model.confirmPurge(true)
  expect(remote.retryDrivePurge).toHaveBeenCalledTimes(1)
  held.resolve(success({ ...receipt, status: 'completed', completedAt: 4 }))
  await retry
  expect(model.state.getSnapshot().purge?.receipt?.status).toBe('completed')
  expect(published).toHaveBeenCalledTimes(1)
})

it('withdraws an inaccessible cleanup review and fences late confirmations after role and account changes', async () => {
  const { model, remote, published } = fixture()
  model.openPurge(id)
  await vi.waitFor(() => { expect(model.state.getSnapshot().purge?.plan?.entry.id).toBe(id) })
  remote.drivePurgePlan.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'not_found' } })
  await model.reviewPurge()
  expect(model.state.getSnapshot().purge?.plan).toBeNull()
  await model.confirmPurge()
  expect(remote.purgeDrive).not.toHaveBeenCalled()
  await model.reviewPurge()
  const late = Promise.withResolvers<Awaited<ReturnType<Remote['purgeDrive']>>>()
  remote.purgeDrive.mockReturnValueOnce(late.promise)
  const saving = model.confirmPurge()
  const original = remote.purgeDrive.mock.calls[0]![0]
  model.bind({ id: me, role: 'manager' })
  model.bind(null)
  model.bind({ id: me, role: 'employee' })
  late.resolve(success({ id, requestId: original.requestId, status: 'completed', requestedAt: 3,
    completedAt: 4, files: 1, folders: 0, versions: 1, byteLength: 1 }))
  await saving
  expect(model.state.getSnapshot().purge).toBeNull()
  expect(published).not.toHaveBeenCalled()
})
