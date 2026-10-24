/** Contact file ownership, uncertain sends and verified saving without browser timing. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeChatAttachment, OfficeChatAttachmentId, OfficeChatFileDownload, OfficeChatFileLimits,
  OfficeChatFilesInput, OfficeChatMessage, OfficeMemberId, OfficeMessageId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeChatFilesModel } from '../src/client/chat-files-model.ts'

type Remote = ConstructorParameters<typeof OfficeChatFilesModel>[0]
const me = 'lin' as OfficeMemberId
const peer = 'chen' as OfficeMemberId
const other = 'constructor' as OfficeMemberId
const attachmentId = '06353675-f648-4d3b-afeb-b93aa7acc5d8' as OfficeChatAttachmentId
const messageId = '2a1b6e8a-dbe5-4697-9d55-a23706b78903' as OfficeMessageId
const limits: OfficeChatFileLimits = { protocol: 1, maxFileBytes: 8 * 1024 * 1024, maxMessageBytes: 8 * 1024 * 1024,
  maxFilesPerMessage: 5, ownerQuotaBytes: 256 * 1024 * 1024, ownerUsedBytes: 0, maxPendingMessages: 4, expiresAfterMs: 86400000 }
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const bytes = Buffer.from('真实私聊文件\0\r\n')
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const metadata = (): OfficeChatAttachment => ({ id: attachmentId, name: '私聊材料.bin', mediaType: 'application/octet-stream',
  byteLength: bytes.length, sha256: digest(bytes) })
const file = (name = '私聊材料.bin', content = bytes) => new File([content], name, { type: 'application/octet-stream' })
function confirmed(input: OfficeChatFilesInput): OfficeChatMessage {
  return { id: input.id, senderId: me, recipientId: input.recipientId, senderName: 'Lin', recipientName: 'Chen', sequence: 1,
    text: input.text.trim() ? input.text : input.files.map(value => value.name).join('\n'), createdAt: 1,
    attachments: input.files.map(value => ({ id: attachmentId, name: value.name, mediaType: value.mediaType,
      byteLength: value.byteLength, sha256: digest(Buffer.from(value.dataBase64, 'base64')) })) }
}
async function fixture() {
  const remote = {
    chatFileLimits: vi.fn<Remote['chatFileLimits']>().mockResolvedValue(success(limits)),
    sendMessageFiles: vi.fn<Remote['sendMessageFiles']>().mockImplementation(async input => success(confirmed(input))),
    downloadChatFile: vi.fn<Remote['downloadChatFile']>().mockResolvedValue(success({ ...metadata(), messageId, dataBase64: bytes.toString('base64') })),
  }
  const notify = vi.fn<ConstructorParameters<typeof OfficeChatFilesModel>[1]>()
  const published = vi.fn<ConstructorParameters<typeof OfficeChatFilesModel>[2]>().mockResolvedValue(undefined)
  const save = vi.fn<ConstructorParameters<typeof OfficeChatFilesModel>[3]>()
  const model = new OfficeChatFilesModel(remote, notify, published, save)
  model.bind(me)
  await vi.waitFor(() => { expect(model.state.getSnapshot().limits).toEqual(limits) })
  return { remote, model, notify, published, save }
}

it('sends actual eight-MiB bytes and an empty file without leaking handles or payloads to viewing state', async () => {
  const { model, remote, published } = await fixture()
  const large = Buffer.alloc(8 * 1024 * 1024, 73)
  model.add(peer, [file('大文件.bin', large), file('空文件.bin', Buffer.alloc(0))])
  const json = JSON.stringify(model.state.getSnapshot())
  expect(json).toContain('大文件.bin')
  expect(json).not.toContain('dataBase64')
  expect(json.length).toBeLessThan(2000)
  expect(await model.send(peer, '')).toBe(true)
  const input = remote.sendMessageFiles.mock.calls[0]![0]
  expect(Buffer.compare(Buffer.from(input.files[0]!.dataBase64, 'base64'), large)).toBe(0)
  expect(input.files[1]!.dataBase64).toBe('')
  expect(model.state.getSnapshot().contacts[peer]?.files).toEqual([])
  expect(published).toHaveBeenCalledTimes(1)
})

it('retains each contact selection across independent sends and handles prototype-named member ids', async () => {
  const { model, remote } = await fixture()
  model.add(peer, [file()])
  model.add(other, [file('另一联系人.bin')])
  expect(await model.send(peer, '给陈安')).toBe(true)
  expect(model.state.getSnapshot().contacts[other]?.files[0]?.name).toBe('另一联系人.bin')
  expect(await model.send(other, '给另一位')).toBe(true)
  expect(remote.sendMessageFiles.mock.calls.map(([input]) => input.recipientId)).toEqual([peer, other])
})

it('rejects excess count and size before reading bytes and allows removal and a valid new selection', async () => {
  const { model, remote } = await fixture()
  remote.chatFileLimits.mockResolvedValue(success({ ...limits, maxFileBytes: 3, maxMessageBytes: 5, maxFilesPerMessage: 2 }))
  await model.load()
  const large = file('too-large', Buffer.alloc(4))
  const read = vi.spyOn(large, 'arrayBuffer')
  model.add(peer, [large])
  expect(model.state.getSnapshot().contacts[peer]?.error).toBe('chatFileSelectionTooLarge')
  expect(read).not.toHaveBeenCalled()
  model.add(peer, [file('first', Buffer.alloc(3))])
  model.add(peer, [file('second', Buffer.alloc(3))])
  expect(model.state.getSnapshot().contacts[peer]?.files).toHaveLength(1)
  const id = model.state.getSnapshot().contacts[peer]!.files[0]!.id
  model.remove(peer, id)
  model.add(peer, [file('one', Buffer.alloc(0)), file('two', Buffer.alloc(0)), file('three', Buffer.alloc(0))])
  expect(model.state.getSnapshot().contacts[peer]?.files).toEqual([])
  model.add(peer, [file('valid', Buffer.alloc(3))])
  expect(await model.send(peer, 'small')).toBe(true)
  expect(remote.sendMessageFiles).toHaveBeenCalledTimes(1)
})

it('retries a lost receipt with the exact original bytes and identity without re-reading selected files', async () => {
  const { model, remote } = await fixture()
  const selected = file()
  const read = vi.spyOn(selected, 'arrayBuffer')
  model.add(peer, [selected])
  remote.sendMessageFiles.mockRejectedValueOnce(new Error('Receipt lost'))
  expect(await model.send(peer, '说明')).toBe(false)
  expect(model.state.getSnapshot().contacts[peer]).toMatchObject({ sending: false, error: 'unavailable' })
  expect(await model.send(peer, '说明')).toBe(true)
  expect(read).toHaveBeenCalledTimes(1)
  expect(remote.sendMessageFiles.mock.calls[0]![0]).toBe(remote.sendMessageFiles.mock.calls[1]![0])
})

it('allows recovery from a failed local file read without sending a partial message', async () => {
  const { model, remote } = await fixture()
  const selected = file()
  vi.spyOn(selected, 'arrayBuffer').mockRejectedValueOnce(new Error('File removed'))
  model.add(peer, [selected])
  expect(await model.send(peer, '说明')).toBe(false)
  expect(remote.sendMessageFiles).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().contacts[peer]).toMatchObject({ error: 'fileReadFailed', sending: false })
  expect(await model.send(peer, '说明')).toBe(true)
})

it('freezes the in-flight contact selection and prevents duplicate send gestures', async () => {
  const { model, remote } = await fixture()
  const hold = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatMessage>>>()
  remote.sendMessageFiles.mockReturnValueOnce(hold.promise)
  model.add(peer, [file()])
  const sending = model.send(peer, '原说明')
  await vi.waitFor(() => { expect(remote.sendMessageFiles).toHaveBeenCalledTimes(1) })
  const id = model.state.getSnapshot().contacts[peer]!.files[0]!.id
  model.remove(peer, id)
  model.add(peer, [file('late.bin')])
  expect(await model.send(peer, '重复')).toBe(false)
  expect(model.state.getSnapshot().contacts[peer]!.files).toHaveLength(1)
  hold.resolve(success(confirmed(remote.sendMessageFiles.mock.calls[0]![0])))
  expect(await sending).toBe(true)
})

it('fences an unfinished local read before another account can upload it', async () => {
  const { model, remote } = await fixture()
  const hold = Promise.withResolvers<ArrayBuffer>()
  const selected = file()
  vi.spyOn(selected, 'arrayBuffer').mockReturnValueOnce(hold.promise)
  model.add(peer, [selected])
  const sending = model.send(peer, 'private')
  model.bind(other)
  hold.resolve(new Uint8Array(bytes).buffer)
  expect(await sending).toBe(false)
  expect(remote.sendMessageFiles).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().contacts).toEqual({})
})

it('ignores an old account send receipt without clearing the new account selection or refreshing old history', async () => {
  const { model, remote, published } = await fixture()
  const hold = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatMessage>>>()
  remote.sendMessageFiles.mockReturnValueOnce(hold.promise)
  model.add(peer, [file()])
  const sending = model.send(peer, 'old')
  await vi.waitFor(() => { expect(remote.sendMessageFiles).toHaveBeenCalledTimes(1) })
  model.bind(other)
  await vi.waitFor(() => { expect(model.state.getSnapshot().limits).not.toBeNull() })
  model.add(peer, [file('new-account.bin')])
  hold.resolve(success(confirmed(remote.sendMessageFiles.mock.calls[0]![0])))
  expect(await sending).toBe(false)
  expect(model.state.getSnapshot().contacts[peer]?.files[0]?.name).toBe('new-account.bin')
  expect(published).not.toHaveBeenCalled()
})

it('saves verified matching bytes and rejects length, digest and message mismatches without a file save', async () => {
  const { model, remote, save } = await fixture()
  const coordinates = { messageId, attachmentId }
  await model.download(coordinates, metadata())
  expect(save).toHaveBeenCalledTimes(1)
  expect(Buffer.compare(Buffer.from(await save.mock.calls[0]![1].arrayBuffer()), bytes)).toBe(0)
  for (const changed of [{ byteLength: 1 }, { sha256: '0'.repeat(64) }, { messageId: 'wrong' as OfficeMessageId },
    { dataBase64: Buffer.alloc(bytes.length, 13).toString('base64') }, { dataBase64: '*'.repeat(bytes.length) }]) {
    remote.downloadChatFile.mockResolvedValueOnce(success({ ...metadata(), messageId, dataBase64: bytes.toString('base64'), ...changed }))
    await model.download(coordinates, metadata())
    expect(model.state.getSnapshot().downloadErrors[attachmentId]).toBe('downloadCorrupt')
  }
  expect(save).toHaveBeenCalledTimes(1)
})

it.each(['account', 'unload'] as const)('prevents a late download from saving after %s replacement', async (operation) => {
  const { model, remote, save } = await fixture()
  const hold = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatFileDownload>>>()
  remote.downloadChatFile.mockReturnValueOnce(hold.promise)
  const downloading = model.download({ messageId, attachmentId }, metadata())
  if (operation === 'account') model.bind(other)
  else model.dispose()
  hold.resolve(success({ ...metadata(), messageId, dataBase64: bytes.toString('base64') }))
  await downloading
  expect(save).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().downloads).toEqual([])
})

it('clears policy on denial, ignores earlier policy reads and keeps failures visible for retry', async () => {
  const { model, remote, notify } = await fixture()
  const late = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatFileLimits>>>()
  remote.chatFileLimits.mockReturnValueOnce(late.promise)
  const loading = model.load()
  remote.chatFileLimits.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
  await model.load()
  late.resolve(success(limits))
  await loading
  expect(model.state.getSnapshot()).toMatchObject({ limits: null, policyError: 'unauthenticated', loading: false })
  expect(notify).toHaveBeenCalledWith('unauthenticated', false)
  await model.load()
  expect(model.state.getSnapshot().limits).toEqual(limits)
})
