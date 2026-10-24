/** Wire failures, current ownership and exact retries around native file preparation. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConversationFiles, OfficeConversationFilesInput, OfficeConversationFilesView, OfficeConversationId,
  OfficeDriveDownloadInfo, OfficeDriveId, OfficeDriveVersionId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeFileAssociationsModel } from '../src/client/file-associations-model.ts'

type Remote = ConstructorParameters<typeof OfficeFileAssociationsModel>[0]
const id = 'conversation-files-one' as OfficeConversationId
const other = 'conversation-files-two' as OfficeConversationId
const member = { id: 'lin' as OfficeMemberId, role: 'employee' as const }
const limits = { protocol: 1 as const, maxSelectedFiles: 20, maxTextBytes: 1048576, maxCharacters: 16384 }
const info: OfficeDriveDownloadInfo = { id: 'a3e65d5c-548e-4a46-8236-4cb1c722de24' as OfficeDriveId,
  versionId: '46513c47-cc85-46ce-8655-62333f4fdc60' as OfficeDriveVersionId,
  name: 'reviewed.txt', mediaType: 'text/plain', byteLength: 24, sha256: '1'.repeat(64), chunkBytes: 8 }
const second: OfficeDriveDownloadInfo = { ...info, id: '01170fc2-e084-4863-86ed-f16c64b76248' as OfficeDriveId, name: 'second.txt' }
function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
function initial(target = id): OfficeConversationFilesView {
  return { conversationId: target, meId: member.id, role: member.role, revision: 0, requestId: null, updatedAt: null, files: [], limits }
}
function fixture() {
  const saved = new Map<OfficeConversationId, OfficeConversationFilesView>()
  const remote = {
    conversationFiles: vi.fn<Remote['conversationFiles']>().mockImplementation(async target => ok(saved.get(target) ?? initial(target))),
    saveConversationFiles: vi.fn<Remote['saveConversationFiles']>().mockImplementation(async (input) => {
      const value: OfficeConversationFilesView = { ...initial(input.conversationId), revision: input.revision + 1,
        requestId: input.requestId, updatedAt: 1,
        files: input.files.map(file => ({ ...(file.id === info.id ? info : second), id: file.id, versionId: file.versionId })) }
      saved.set(input.conversationId, value)
      const { meId: _meId, role: _role, limits: _limits, ...selection } = value
      return ok(selection)
    }),
    driveFileInfo: vi.fn<Remote['driveFileInfo']>().mockImplementation(async file => ok(file === info.id ? info : second)),
  }
  const prepare = vi.fn<ConstructorParameters<typeof OfficeFileAssociationsModel>[1]>()
  const notify = vi.fn()
  const model = new OfficeFileAssociationsModel(remote, prepare, notify)
  model.bind(member, limits)
  prepare.mockImplementation((file, signal) => model.add(id, file, signal))
  onTestFinished(() => { model.dispose() })
  return { model, remote, prepare, notify, saved }
}

it('adds authority-resolved coordinates and preserves other files, without preparing on list or selection navigation', async () => {
  const { model, remote, prepare, saved } = fixture()
  expect(await model.choose(id)).toBe(true)
  expect(model.state.getSnapshot().choosing).toBe(true)
  expect(prepare).not.toHaveBeenCalled()
  expect(await model.useFile(info.id)).toBe(true)
  expect(saved.get(id)?.files.map(file => file.id)).toEqual([info.id])
  expect(model.state.getSnapshot()).toMatchObject({ preparing: false, choosing: false, pending: false, view: { revision: 1 } })
  expect(await model.useFile(second.id)).toBe(true)
  expect(saved.get(id)?.files.map(file => file.id)).toEqual([info.id, second.id])
  expect(remote.saveConversationFiles.mock.calls[0]?.[0].files).toEqual([{ id: info.id, versionId: info.versionId }])
  expect(await model.useFile(info.id)).toBe(true)
  expect(remote.saveConversationFiles).toHaveBeenCalledTimes(2)
  expect(await model.remove(info.id)).toBe(true)
  expect(saved.get(id)?.files.map(file => file.id)).toEqual([second.id])
  expect(await model.remove(null)).toBe(true)
  expect(saved.get(id)?.files).toEqual([])
})

it('withdraws an obsolete read when another conversation becomes selected', async () => {
  const { model, remote } = fixture()
  const late = Promise.withResolvers<Awaited<ReturnType<Remote['conversationFiles']>>>()
  remote.conversationFiles.mockReturnValueOnce(late.promise)
  const reading = model.load(id)
  model.observe(other)
  late.resolve(ok({ ...initial(), files: [info] }))
  expect(await reading).toBeNull()
  await vi.waitFor(() => { expect(model.state.getSnapshot()).toMatchObject({ conversationId: other, view: { files: [] } }) })
})

it.each(['employee', 'role', 'cancel', 'unload'] as const)('does not prepare a late file after %s replacement', async (change) => {
  const { model, remote, prepare } = fixture()
  const late = Promise.withResolvers<Awaited<ReturnType<Remote['driveFileInfo']>>>()
  remote.driveFileInfo.mockReturnValueOnce(late.promise)
  const preparing = model.useFile(info.id)
  if (change === 'employee') model.bind({ id: 'chen' as OfficeMemberId, role: 'employee' }, limits)
  else if (change === 'role') model.bind({ ...member, role: 'manager' }, limits)
  else if (change === 'cancel') model.cancelPreparation()
  else model.dispose()
  late.resolve(ok(info))
  expect(await preparing).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ preparing: false, view: null })
})

it('cancels a native preparation already waiting without treating its late success as current', async () => {
  const { model, prepare } = fixture()
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<boolean>()
  prepare.mockImplementationOnce(async () => { started.resolve(undefined); return release.promise })
  const preparing = model.useFile(info.id)
  await started.promise
  model.observe(other)
  release.resolve(true)
  expect(await preparing).toBe(false)
  expect(prepare.mock.calls[0]?.[1].aborted).toBe(true)
})

it('retains a newly allocated input while navigation still reports the same initial absence', async () => {
  const { model, remote, prepare } = fixture()
  const commit = remote.saveConversationFiles.getMockImplementation()!
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  remote.saveConversationFiles.mockImplementationOnce(async (...args) => {
    started.resolve(undefined)
    await release.promise
    return commit(...args)
  })
  const preparing = model.useFile(info.id)
  await started.promise
  model.observe(null)
  release.resolve(undefined)
  expect(await preparing).toBe(true)
  expect(prepare.mock.calls[0]?.[1].aborted).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ conversationId: id, view: { files: [{ id: info.id }] }, pending: false })
  model.observe(id)
  expect(model.state.getSnapshot().view?.files).toHaveLength(1)
})

it('keeps the known native selection across a role refresh so a new-role preparation can start immediately', async () => {
  const { model, remote, prepare } = fixture()
  model.observe(id)
  await model.load(id, true)
  model.bind({ ...member, role: 'manager' }, limits)
  remote.conversationFiles.mockImplementation(async target => ok({ ...initial(target), role: 'manager' }))
  prepare.mockImplementation((file, signal) => {
    model.observe(id)
    return model.add(id, file, signal)
  })
  expect(await model.useFile(info.id)).toBe(true)
  expect(model.state.getSnapshot()).toMatchObject({ view: { role: 'manager', files: [{ id: info.id }] } })
})

it('retains the exact request after unknown acknowledgement and refuses a new preparation until it is resolved', async () => {
  const { model, remote, saved } = fixture()
  const commit = remote.saveConversationFiles.getMockImplementation()!
  remote.saveConversationFiles.mockImplementationOnce(async (...args) => { await commit(...args); throw new Error('Lost acknowledgement') })
  expect(await model.useFile(info.id)).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ pending: true, error: 'fileAssociationSaveUnknown' })
  expect(await model.useFile(second.id)).toBe(false)
  expect(remote.driveFileInfo).toHaveBeenCalledTimes(1)
  expect(await model.retry()).toBe(true)
  expect(remote.saveConversationFiles.mock.calls[1]?.[0]).toBe(remote.saveConversationFiles.mock.calls[0]?.[0])
  expect(saved.get(id)?.revision).toBe(1)
  expect(model.state.getSnapshot()).toMatchObject({ pending: false, view: { files: [{ id: info.id }] } })
})

it('recovers an exactly confirmed unknown commit from a read without issuing another write', async () => {
  const { model, remote } = fixture()
  const commit = remote.saveConversationFiles.getMockImplementation()!
  remote.saveConversationFiles.mockImplementationOnce(async (...args) => { await commit(...args); throw new Error('Response lost') })
  expect(await model.useFile(info.id)).toBe(false)
  await model.load(id, true)
  expect(model.state.getSnapshot()).toMatchObject({ pending: false, error: null, view: { revision: 1, files: [info] } })
  expect(remote.saveConversationFiles).toHaveBeenCalledTimes(1)
})

it.each(['identity', 'role', 'target'] as const)('rejects a read whose %s no longer matches its owner', async (field) => {
  const { model, remote } = fixture()
  remote.conversationFiles.mockResolvedValueOnce(ok({ ...initial(),
    ...(field === 'identity' ? { meId: 'chen' as OfficeMemberId } : field === 'role' ? { role: 'manager' as const } : { conversationId: other }) }))
  expect(await model.load(id)).toBeNull()
  expect(model.state.getSnapshot()).toMatchObject({ view: null, error: 'fileAssociationsUnavailable' })
})

it.each(['version', 'target', 'request'] as const)('keeps an unconfirmed write frozen after a mismatched %s response', async (field) => {
  const { model, remote } = fixture()
  remote.saveConversationFiles.mockImplementationOnce(async input => ok({ conversationId: input.conversationId,
    revision: input.revision + 1, requestId: input.requestId, updatedAt: 1, files: [info],
    ...(field === 'version' ? { revision: input.revision + 2 } : field === 'target' ? { conversationId: other } : { requestId: 'wrong' }) }))
  expect(await model.useFile(info.id)).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ pending: true, view: { files: [] }, error: 'fileAssociationSaveUnknown' })
})

it('requires explicit refresh after a conflict and does not silently change the reviewed revision', async () => {
  const { model, remote, saved } = fixture()
  remote.saveConversationFiles.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'conflict' } })
  expect(await model.useFile(info.id)).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ pending: false, error: 'conflict', view: { revision: 0 } })
  saved.set(id, { ...initial(), revision: 3 })
  await model.load(id, true)
  expect(await model.useFile(info.id)).toBe(true)
  expect(remote.saveConversationFiles.mock.calls.map(([input]) => input.revision)).toEqual([0, 3])
})

it('does not let an older background response overwrite a subsequently confirmed removal', async () => {
  const { model, remote } = fixture()
  await model.useFile(info.id)
  const late = Promise.withResolvers<Awaited<ReturnType<Remote['conversationFiles']>>>()
  remote.conversationFiles.mockReturnValueOnce(late.promise)
  const reading = model.load(id)
  expect(await model.remove(null)).toBe(true)
  late.resolve(ok({ ...initial(), revision: 1, files: [info] }))
  expect(await reading).toBeNull()
  expect(model.state.getSnapshot()).toMatchObject({ loading: false, view: { revision: 2, files: [] } })
})

it('does not publish a late commit or success notice after changing employees', async () => {
  const { model, remote, notify } = fixture()
  const late = Promise.withResolvers<Awaited<ReturnType<Remote['saveConversationFiles']>>>()
  const started = Promise.withResolvers<OfficeConversationFilesInput>()
  remote.saveConversationFiles.mockImplementationOnce(async (input) => { started.resolve(input); return late.promise })
  const preparing = model.useFile(info.id)
  const request = await started.promise
  model.bind({ id: 'chen' as OfficeMemberId, role: 'employee' }, limits)
  const value: OfficeConversationFiles = { conversationId: id, revision: 1, requestId: request.requestId, updatedAt: 1, files: [info] }
  late.resolve(ok(value))
  expect(await preparing).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ view: null, pending: false })
  expect(notify).not.toHaveBeenCalledWith('fileAssociationSaved', true)
})

it.each(['image', 'size'] as const)('refuses unsupported %s before native preparation', async (kind) => {
  const { model, remote, prepare } = fixture()
  remote.driveFileInfo.mockResolvedValueOnce(ok({ ...info, ...(kind === 'image' ? { mediaType: 'image/png' } : { byteLength: 1048577 }) }))
  expect(await model.useFile(info.id)).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().error).toBe('fileAssociationTextOnly')
})

it.each(['legacy', 'oversized', 'forbidden', 'supported'] as const)('uses actual advertised PDF support (%s)', async (kind) => {
  const { model, remote, prepare } = fixture()
  if (kind !== 'legacy') model.bind(member, { ...limits, pdf: { maxBytes: 2048 } })
  remote.driveFileInfo.mockResolvedValueOnce(kind === 'forbidden' ? { ok: true, value: { ok: false, code: 'forbidden' } }
    : ok({ ...info, name: 'reviewed.pdf', mediaType: 'application/pdf', byteLength: kind === 'oversized' ? 2049 : 2048 }))
  expect(await model.useFile(info.id)).toBe(kind === 'supported')
  expect(prepare).toHaveBeenCalledTimes(kind === 'supported' ? 1 : 0)
})

it.each(['legacy', 'oversized', 'forbidden', 'supported'] as const)('checks the optional DOCX capability (%s)', async (kind) => {
  const { model, remote, prepare } = fixture()
  model.bind(member, { ...limits, pdf: { maxBytes: 2048 }, ...kind === 'legacy' ? {} : { docx: { maxBytes: 2048 } } })
  remote.driveFileInfo.mockResolvedValueOnce(kind === 'forbidden' ? { ok: true, value: { ok: false, code: 'forbidden' } }
    : ok({ ...info, name: 'reviewed.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteLength: kind === 'oversized' ? 2049 : 2048 }))
  expect(await model.useFile(info.id)).toBe(kind === 'supported')
  expect(prepare).toHaveBeenCalledTimes(kind === 'supported' ? 1 : 0)
})

it.each(['legacy', 'oversized', 'forbidden', 'supported'] as const)('checks the optional XLSX capability (%s)', async (kind) => {
  const { model, remote, prepare } = fixture()
  model.bind(member, { ...limits, docx: { maxBytes: 2048 }, ...kind === 'legacy' ? {} : { xlsx: { maxBytes: 2048 } } })
  remote.driveFileInfo.mockResolvedValueOnce(kind === 'forbidden' ? { ok: true, value: { ok: false, code: 'forbidden' } }
    : ok({ ...info, name: 'reviewed.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      byteLength: kind === 'oversized' ? 2049 : 2048 }))
  expect(await model.useFile(info.id)).toBe(kind === 'supported')
  expect(prepare).toHaveBeenCalledTimes(kind === 'supported' ? 1 : 0)
})

it('honors the advertised selection bound and accepts empty UTF-8 files', async () => {
  const { model, remote, saved } = fixture()
  remote.conversationFiles.mockImplementation(async target => ok({ ...(saved.get(target) ?? initial(target)),
    limits: { ...limits, maxSelectedFiles: 1 } }))
  remote.driveFileInfo.mockResolvedValueOnce(ok({ ...info, byteLength: 0 }))
  expect(await model.useFile(info.id)).toBe(true)
  expect(await model.useFile(second.id)).toBe(false)
  expect(model.state.getSnapshot().error).toBe('fileAssociationCapacity')
  expect(remote.saveConversationFiles).toHaveBeenCalledTimes(1)
})

it('keeps legacy authorities available without probing missing file endpoints', async () => {
  const { model, remote, prepare } = fixture()
  model.bind(member)
  expect(await model.useFile(info.id)).toBe(false)
  expect(await model.load(id)).toBeNull()
  expect(remote.conversationFiles).not.toHaveBeenCalled()
  expect(remote.driveFileInfo).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
})
