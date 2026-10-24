/** Real File slices and digests with interrupted acknowledgements, cancellation and account replacement. */
import { createHash } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeDriveId, OfficeDriveUploadChunkInput, OfficeDriveUploadId, OfficeDriveUploadTicket,
  OfficeDriveVersionId, OfficeMemberId, OfficeDriveEntry,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeDriveTransfers } from '../src/client/drive-transfers.ts'

type Remote = ConstructorParameters<typeof OfficeDriveTransfers>[0]
const me = 'employee' as OfficeMemberId
const uploadId = 'eb30dd58-bdda-4ad5-931b-550037955235' as OfficeDriveUploadId
const fileId = '5939c55b-8fe1-429d-a3ca-d2d3ac75a6dc' as OfficeDriveId
const versionId = '82ad1c03-a6dd-4bcc-b3ef-aa103580ac59' as OfficeDriveVersionId
const chunkBytes = 1024 * 1024
const location = { space: 'private', folderId: null } as const
const limits = { protocol: 1, maxFileBytes: 64 * chunkBytes, ownerQuotaBytes: 256 * chunkBytes,
  chunkBytes, maxPendingUploads: 4, expiresAfterMs: 86400000 } as const
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const content = (length = 2 * chunkBytes + 19) => Buffer.from(Uint8Array.from({ length }, (_, index) => index % 251))

function fixture(bytes = content()) {
  let ticket: OfficeDriveUploadTicket | null = null
  const chunks = new Map<number, Buffer>()
  const remote: { [K in keyof Remote]: ReturnType<typeof vi.fn<Remote[K]>> } = {
    beginDriveUpload: vi.fn<Remote['beginDriveUpload']>().mockImplementation(async (input) => {
      ticket ??= { ...input, id: uploadId, status: 'uploading', chunkBytes, received: [], receivedBytes: 0,
        createdAt: 1, expiresAt: Date.now() + 86400000, fileId: null }
      return success(ticket)
    }),
    driveUploads: vi.fn<Remote['driveUploads']>().mockImplementation(async () => success(ticket?.status === 'uploading' ? [ticket] : [])),
    getDriveUpload: vi.fn<Remote['getDriveUpload']>().mockImplementation(async () => success(ticket!)),
    appendDriveUpload: vi.fn<Remote['appendDriveUpload']>(),
    completeDriveUpload: vi.fn<Remote['completeDriveUpload']>().mockImplementation(async () => {
      ticket = { ...ticket!, status: 'completed', fileId }
      return success(ticket)
    }),
    cancelDriveUpload: vi.fn<Remote['cancelDriveUpload']>().mockImplementation(async () => {
      if (ticket!.status !== 'completed') ticket = { ...ticket!, status: 'cancelled' }
      return success(ticket!)
    }),
    driveFileInfo: vi.fn<Remote['driveFileInfo']>().mockImplementation(async () => success({
      id: fileId, versionId, name: 'report.bin', mediaType: 'application/octet-stream',
      byteLength: bytes.length, sha256: digest(bytes), chunkBytes,
    })),
    driveVersionInfo: vi.fn<Remote['driveVersionInfo']>().mockImplementation(async (id, selected) => success({
      id, versionId: selected, name: 'report.bin', mediaType: 'application/octet-stream',
      byteLength: bytes.length, sha256: digest(bytes), chunkBytes,
    })),
    downloadDriveRange: vi.fn<Remote['downloadDriveRange']>().mockImplementation(async (input) => {
      const part = bytes.subarray(input.offset, input.offset + input.byteLength)
      return success({ ...input, sha256: digest(part), dataBase64: part.toString('base64') })
    }),
  }
  const append = async (input: OfficeDriveUploadChunkInput) => {
    chunks.set(input.index, Buffer.from(input.dataBase64, 'base64'))
    ticket = { ...ticket!, received: [...chunks.keys()], receivedBytes: [...chunks.values()].reduce((sum, part) => sum + part.length, 0) }
    return success(ticket)
  }
  remote.appendDriveUpload.mockImplementation(append)
  const notify = vi.fn()
  const published = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const save = vi.fn<ConstructorParameters<typeof OfficeDriveTransfers>[3]>()
  const model = new OfficeDriveTransfers(remote, notify, published, save)
  model.bind(me)
  model.configure(limits)
  onTestFinished(() => { model.dispose() })
  const file = new File([bytes], 'report.bin', { type: 'application/octet-stream' })
  return { model, remote, file, bytes, chunks, notify, published, save, append, ticket: () => ticket }
}
async function uploadPhase(model: OfficeDriveTransfers, phase: string) {
  await vi.waitFor(() =>{  expect(model.state.getSnapshot().upload?.phase).toBe(phase) }, { timeout: 10000 })
}
async function downloadPhase(model: OfficeDriveTransfers, phase: string) {
  await vi.waitFor(() =>{  expect(model.state.getSnapshot().download?.phase).toBe(phase) }, { timeout: 10000 })
}

it('uploads reviewed replacement bytes under the logical filename and validates the exact target receipt', async () => {
  const { model, remote, file, bytes, chunks, published } = fixture(content(19))
  const entry: OfficeDriveEntry = { id: fileId, parentId: null, space: 'private', ownerId: me, name: 'Logical original.txt',
    kind: 'file', revision: 7, createdAt: 1, updatedAt: 1, byteLength: 1, mediaType: 'text/plain',
    access: 'edit', canRename: true, canManageAccess: false, canUpdate: true, canTrash: true }
  expect(model.startVersion(file, { ...entry, canUpdate: false })).toBe(false)
  expect(remote.beginDriveUpload).not.toHaveBeenCalled()
  expect(model.startVersion(file, entry)).toBe(true)
  await uploadPhase(model, 'completed')
  expect(remote.beginDriveUpload.mock.calls[0]![0]).toMatchObject({ name: entry.name,
    target: { id: entry.id, revision: 7 }, mediaType: file.type, sha256: digest(bytes) })
  expect(Buffer.concat([...chunks.values()])).toEqual(bytes)
  expect(model.state.getSnapshot().upload?.name).toBe(entry.name)
  expect(published).toHaveBeenCalledTimes(1)
})

it('retries an explicitly selected historical download without substituting the current head', async () => {
  const { model, remote, bytes, save } = fixture(content(19))
  const old = '5b887e53-b9ae-4f07-8c54-4258e362ef37' as OfficeDriveVersionId
  remote.driveVersionInfo.mockRejectedValueOnce(new Error('Historical lookup interrupted'))
  await model.downloadVersion(fileId, old)
  expect(model.state.getSnapshot().download?.phase).toBe('failed')
  model.retryDownload()
  await downloadPhase(model, 'completed')
  expect(remote.driveVersionInfo.mock.calls).toEqual([[fileId, old], [fileId, old]])
  expect(remote.driveFileInfo).not.toHaveBeenCalled()
  expect(remote.downloadDriveRange.mock.calls[0]![0].versionId).toBe(old)
  expect(Buffer.from(await save.mock.calls[0]![1].arrayBuffer())).toEqual(bytes)
})

it('withdraws retained handles and late browser saves when the same employee changes role', async () => {
  const { model, remote, bytes, save } = fixture(content(19))
  model.bind(me, 'employee')
  model.configure(limits)
  const held = Promise.withResolvers<Awaited<ReturnType<Remote['driveVersionInfo']>>>()
  remote.driveVersionInfo.mockReturnValueOnce(held.promise)
  const operation = model.downloadVersion(fileId, versionId)
  model.bind(me, 'admin')
  held.resolve(success({ id: fileId, versionId, name: 'Old role download.txt', byteLength: bytes.length,
    mediaType: 'text/plain', sha256: digest(bytes), chunkBytes }))
  await operation
  expect(model.state.getSnapshot()).toMatchObject({ upload: null, download: null, pending: [] })
  expect(remote.downloadDriveRange).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
})

it('retains a reviewed download version across retries and rejects replacement before reading bytes', async () => {
  const { model, remote, bytes, save } = fixture()
  const reviewed = '5b887e53-b9ae-4f07-8c54-4258e362ef37' as OfficeDriveVersionId
  await model.downloadFile(fileId, reviewed)
  expect(model.state.getSnapshot().download).toMatchObject({ phase: 'failed', error: 'conflict' })
  expect(remote.downloadDriveRange).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  model.retryDownload()
  await vi.waitFor(() => { expect(remote.driveFileInfo).toHaveBeenCalledTimes(2) })
  await downloadPhase(model, 'failed')
  expect(remote.downloadDriveRange).not.toHaveBeenCalled()
  remote.driveFileInfo.mockResolvedValue(success({ id: fileId, versionId: reviewed, name: 'reviewed.bin',
    mediaType: 'application/octet-stream', byteLength: bytes.length, sha256: digest(bytes), chunkBytes }))
  model.retryDownload()
  await downloadPhase(model, 'completed')
  expect(save).toHaveBeenCalledTimes(1)
  expect(Buffer.from(await save.mock.calls[0]![1].arrayBuffer())).toEqual(bytes)
})

it('uploads more than 8 MiB using slices and retries a lost acknowledgement without resending its durable chunk', async () => {
  const { model, remote, file, bytes, append, chunks, published } = fixture(content(9 * chunkBytes + 19))
  const wholeRead = vi.spyOn(file, 'arrayBuffer')
  remote.appendDriveUpload.mockImplementationOnce(async (input) => { await append(input); throw new Error('Lost acknowledgement') })
  expect(model.start(file, location)).toBe(true)
  await uploadPhase(model, 'failed')
  expect(model.start(file, location)).toBe(false)
  model.retry()
  await uploadPhase(model, 'completed')
  expect(wholeRead).not.toHaveBeenCalled()
  expect(remote.beginDriveUpload).toHaveBeenCalledTimes(1)
  expect(remote.getDriveUpload).toHaveBeenCalledTimes(1)
  expect(remote.appendDriveUpload.mock.calls.map(([input]) => input.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(Buffer.compare(Buffer.concat([...chunks.values()]), bytes)).toBe(0)
  expect(remote.beginDriveUpload.mock.calls[0]![0].sha256).toBe(digest(bytes))
  expect(published).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(model.state.getSnapshot()).length).toBeLessThan(4096)
})

it('stops new chunks when cancelled during an acknowledgement and confirms cancellation before dismissing', async () => {
  const { model, remote, file, append, ticket } = fixture()
  const hold = Promise.withResolvers<undefined>()
  remote.appendDriveUpload.mockImplementationOnce(async (input) => {
    const result = await append(input); await hold.promise; return result
  })
  model.start(file, location)
  await vi.waitFor(() =>{  expect(remote.appendDriveUpload).toHaveBeenCalledTimes(1) })
  model.cancel()
  expect(model.state.getSnapshot().upload?.phase).toBe('cancelling')
  model.dismissUpload()
  expect(model.state.getSnapshot().upload).not.toBeNull()
  hold.resolve(undefined)
  await uploadPhase(model, 'cancelled')
  expect(ticket()?.status).toBe('cancelled')
  expect(remote.appendDriveUpload).toHaveBeenCalledTimes(1)
  expect(remote.completeDriveUpload).not.toHaveBeenCalled()
  model.dismissUpload()
  expect(model.state.getSnapshot().upload).toBeNull()
})

it('retries a failed cancellation without restarting the upload', async () => {
  const { model, remote, file } = fixture()
  remote.appendDriveUpload.mockRejectedValueOnce(new Error('Offline'))
  model.start(file, location)
  await uploadPhase(model, 'failed')
  remote.cancelDriveUpload.mockRejectedValueOnce(new Error('Cancellation response lost'))
  model.cancel()
  await uploadPhase(model, 'failed')
  expect(model.state.getSnapshot().upload?.cancelRequested).toBe(true)
  model.retry()
  await uploadPhase(model, 'cancelled')
  expect(remote.cancelDriveUpload).toHaveBeenCalledTimes(2)
  expect(remote.appendDriveUpload).toHaveBeenCalledTimes(1)
  expect(remote.completeDriveUpload).not.toHaveBeenCalled()
})

it('stops a refused declaration without attempting to create another reservation during cancellation', async () => {
  const { model, remote, file } = fixture()
  remote.beginDriveUpload.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'invalid_input' } })
  model.start(file, location)
  await uploadPhase(model, 'failed')
  model.cancel()
  await uploadPhase(model, 'stopped')
  expect(remote.beginDriveUpload).toHaveBeenCalledTimes(1)
  expect(remote.cancelDriveUpload).not.toHaveBeenCalled()
  expect(remote.appendDriveUpload).not.toHaveBeenCalled()
  model.dismissUpload()
  expect(model.start(file, location)).toBe(true)
  await uploadPhase(model, 'completed')
})

it('finds and cancels a durable declaration after its initial ticket response was lost', async () => {
  const { model, remote, file, ticket } = fixture()
  const begin = remote.beginDriveUpload.getMockImplementation()!
  remote.beginDriveUpload.mockImplementationOnce(async (input) => { await begin(input); throw new Error('Initial response lost') })
  model.start(file, location)
  await uploadPhase(model, 'failed')
  expect(ticket()?.status).toBe('uploading')
  model.cancel()
  await uploadPhase(model, 'cancelled')
  expect(remote.beginDriveUpload).toHaveBeenCalledTimes(1)
  expect(remote.cancelDriveUpload).toHaveBeenCalledWith(uploadId)
  expect(remote.appendDriveUpload).not.toHaveBeenCalled()
})

it('reports an already published file as completed when cancellation follows a lost completion response', async () => {
  const { model, remote, file, published, ticket } = fixture()
  const complete = remote.completeDriveUpload.getMockImplementation()!
  remote.completeDriveUpload.mockImplementationOnce(async (id) => { await complete(id); throw new Error('Published response lost') })
  model.start(file, location)
  await uploadPhase(model, 'failed')
  expect(ticket()?.status).toBe('completed')
  model.cancel()
  await uploadPhase(model, 'completed')
  expect(remote.completeDriveUpload).toHaveBeenCalledTimes(1)
  expect(published).toHaveBeenCalledTimes(1)
})

it('resumes a durable declaration after handle loss and rejects a same-sized different file before sending bytes', async () => {
  const { model, remote, file, bytes, append } = fixture()
  remote.appendDriveUpload.mockImplementationOnce(async (input) => { await append(input); throw new Error('Reload') })
  model.start(file, location)
  await uploadPhase(model, 'failed')
  model.bind(null)
  model.bind(me)
  model.configure(limits)
  await vi.waitFor(() =>{  expect(model.state.getSnapshot().pending).toHaveLength(1) })
  expect(model.start(new File([Buffer.alloc(bytes.length)], 'wrong.bin'), location, uploadId)).toBe(true)
  await uploadPhase(model, 'failed')
  expect(model.state.getSnapshot().upload?.error).toBe('resumeFileMismatch')
  expect(remote.appendDriveUpload).toHaveBeenCalledTimes(1)
  model.reselect(file)
  await uploadPhase(model, 'completed')
  expect(remote.appendDriveUpload.mock.calls.map(([input]) => input.index)).toEqual([0, 1, 2])
})

it('cancels a retained declaration without asking the employee to reselect its original file', async () => {
  const { model, remote, file } = fixture()
  remote.appendDriveUpload.mockRejectedValueOnce(new Error('Reload'))
  model.start(file, location)
  await uploadPhase(model, 'failed')
  model.bind(null)
  model.bind(me)
  model.configure(limits)
  await vi.waitFor(() =>{  expect(model.state.getSnapshot().pending).toHaveLength(1) })
  model.cancelPending(uploadId)
  await uploadPhase(model, 'cancelled')
  expect(remote.beginDriveUpload).toHaveBeenCalledTimes(1)
  expect(model.state.getSnapshot().pending).toEqual([])
})

it('fences old receipt responses and file handles before another account is published', async () => {
  const { model, remote, file, append, notify } = fixture()
  const hold = Promise.withResolvers<undefined>()
  remote.appendDriveUpload.mockImplementationOnce(async (input) => {
    const result = await append(input); await hold.promise; return result
  })
  model.start(file, location)
  await vi.waitFor(() =>{  expect(remote.appendDriveUpload).toHaveBeenCalledTimes(1) })
  remote.driveUploads.mockResolvedValue(success([]))
  model.bind('another employee' as OfficeMemberId)
  model.configure(limits)
  hold.resolve(undefined)
  await vi.waitFor(() =>{  expect(model.state.getSnapshot().pendingLoading).toBe(false) })
  expect(model.state.getSnapshot().upload).toBeNull()
  expect(remote.appendDriveUpload).toHaveBeenCalledTimes(1)
  expect(remote.completeDriveUpload).not.toHaveBeenCalled()
  expect(remote.cancelDriveUpload).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
})

it('downloads more than 8 MiB as immutable ranges and saves the exact fully verified bytes', async () => {
  const { model, remote, bytes, save } = fixture(content(9 * chunkBytes + 19))
  await model.downloadFile(fileId)
  expect(model.state.getSnapshot().download?.phase).toBe('completed')
  expect(remote.downloadDriveRange).toHaveBeenCalledTimes(10)
  expect(remote.downloadDriveRange.mock.calls.every(([range]) =>
    range.byteLength <= chunkBytes && range.versionId === versionId)).toBe(true)
  expect(save).toHaveBeenCalledTimes(1)
  expect(Buffer.compare(Buffer.from(await save.mock.calls[0]![1].arrayBuffer()), bytes)).toBe(0)
})

it('rejects a complete digest mismatch and retries through a fresh version lookup before saving', async () => {
  const { model, remote, save } = fixture()
  const info = remote.driveFileInfo.getMockImplementation()!
  remote.driveFileInfo.mockImplementationOnce(async (id) => {
    const result = await info(id)
    if (!result.ok || !result.value.ok) throw new Error('Fixture metadata missing')
    return success({ ...result.value.value, sha256: '0'.repeat(64) })
  })
  await model.downloadFile(fileId)
  expect(model.state.getSnapshot().download).toMatchObject({ phase: 'failed', error: 'downloadCorrupt' })
  expect(save).not.toHaveBeenCalled()
  model.retryDownload()
  await downloadPhase(model, 'completed')
  expect(remote.driveFileInfo).toHaveBeenCalledTimes(2)
  expect(save).toHaveBeenCalledTimes(1)
})

it('never saves a partial file after permissions are revoked between ranges', async () => {
  const { model, remote, save } = fixture()
  const range = remote.downloadDriveRange.getMockImplementation()!
  remote.downloadDriveRange.mockImplementationOnce(range)
    .mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'not_found' } })
  await model.downloadFile(fileId)
  expect(model.state.getSnapshot().download).toMatchObject({ phase: 'failed', error: 'not_found', done: chunkBytes })
  expect(save).not.toHaveBeenCalled()
  expect(remote.downloadDriveRange).toHaveBeenCalledTimes(2)
})

it.each(['digest', 'version', 'length'] as const)('rejects a range with a mismatching %s before any file is saved', async (field) => {
  const { model, remote, save } = fixture()
  const read = remote.downloadDriveRange.getMockImplementation()!
  remote.downloadDriveRange.mockImplementationOnce(async (input) => {
    const result = await read(input)
    if (!result.ok || !result.value.ok) throw new Error('Fixture range missing')
    const range = result.value.value
    return success({ ...range,
      ...(field === 'digest' ? { sha256: '0'.repeat(64) } : {}),
      ...(field === 'version' ? { versionId: 'another version' as OfficeDriveVersionId } : {}),
      ...(field === 'length' ? { dataBase64: Buffer.from('short range').toString('base64') } : {}),
    })
  })
  await model.downloadFile(fileId)
  expect(model.state.getSnapshot().download).toMatchObject({ phase: 'failed', error: 'downloadCorrupt', done: 0 })
  expect(save).not.toHaveBeenCalled()
  expect(remote.downloadDriveRange).toHaveBeenCalledTimes(1)
})

it('uploads and downloads an empty file without manufacturing a chunk', async () => {
  const { model, remote, file, save } = fixture(Buffer.alloc(0))
  model.start(file, location)
  await uploadPhase(model, 'completed')
  expect(remote.appendDriveUpload).not.toHaveBeenCalled()
  await model.downloadFile(fileId)
  expect(remote.downloadDriveRange).not.toHaveBeenCalled()
  expect(save.mock.calls[0]![1].size).toBe(0)
})

it('cancels during a pending file check without creating a server upload', async () => {
  const { model, remote, file } = fixture()
  const chunk = file.slice(0, chunkBytes)
  const held = Promise.withResolvers<ArrayBuffer>()
  const read = vi.spyOn(chunk, 'arrayBuffer').mockReturnValueOnce(held.promise)
  vi.spyOn(file, 'slice').mockReturnValueOnce(chunk)
  model.start(file, location)
  model.cancel()
  held.resolve(new ArrayBuffer(chunkBytes))
  await uploadPhase(model, 'cancelled')
  expect(read).toHaveBeenCalledTimes(1)
  expect(remote.beginDriveUpload).not.toHaveBeenCalled()
  expect(remote.appendDriveUpload).not.toHaveBeenCalled()
  expect(remote.cancelDriveUpload).not.toHaveBeenCalled()
})

it.each(['cancel', 'replace', 'dispose'] as const)('never saves a late download response after %s', async (action) => {
  const { model, remote, save } = fixture()
  const hold = Promise.withResolvers<Awaited<ReturnType<Remote['downloadDriveRange']>>>()
  remote.downloadDriveRange.mockReturnValueOnce(hold.promise)
  const downloading = model.downloadFile(fileId)
  await vi.waitFor(() =>{  expect(remote.downloadDriveRange).toHaveBeenCalledTimes(1) })
  if (action === 'cancel') model.cancelDownload()
  else if (action === 'replace') model.bind('replacement' as OfficeMemberId)
  else model.dispose()
  hold.resolve(success({ id: fileId, versionId, offset: 0, byteLength: chunkBytes,
    sha256: '', dataBase64: '' }))
  await downloading
  expect(save).not.toHaveBeenCalled()
  expect(remote.downloadDriveRange).toHaveBeenCalledTimes(1)
})
