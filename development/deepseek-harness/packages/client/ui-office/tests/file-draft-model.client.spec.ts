/** Private file drafts restore real bytes and preserve explicit choices across failed or competing writes. */
import { createHash } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeChatAttachmentId, OfficeChatFileDraft, OfficeChatFileDraftView, OfficeChatFileInput, OfficeChatFileLimits,
  OfficeChatMessage, OfficeMemberId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeFileDraftModel } from '../src/client/file-draft-model.ts'

type Remote = ConstructorParameters<typeof OfficeFileDraftModel>[0]
const me = 'lin' as OfficeMemberId
const peer = 'chen' as OfficeMemberId
const other = 'constructor' as OfficeMemberId
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const denied = (code: 'conflict' | 'not_found' | 'invalid_input') => ({ ok: true as const, value: { ok: false as const, code } })
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const limits: OfficeChatFileLimits = { protocol: 1, maxFileBytes: 8 * 1024 * 1024, maxMessageBytes: 8 * 1024 * 1024,
  maxFilesPerMessage: 5, ownerQuotaBytes: 256 * 1024 * 1024, ownerUsedBytes: 0, maxPendingMessages: 4, expiresAfterMs: 86400000 }
const content = Buffer.from('联系人私有文件\0\n')
const file = (name = '草稿文件.bin', bytes = content) => new File([bytes], name, { type: 'application/octet-stream' })
const inputFile = (name: string, bytes: Buffer): OfficeChatFileInput => ({ name, mediaType: 'application/octet-stream',
  byteLength: bytes.length, dataBase64: bytes.toString('base64') })

function fixture() {
  const rows = new Map<OfficeMemberId, OfficeChatFileDraft>()
  const bytes = new Map<OfficeChatAttachmentId, OfficeChatFileInput>()
  const saves = new Map<string, OfficeChatFileDraft>()
  const sends = new Map<string, OfficeChatMessage>()
  const view = (): OfficeChatFileDraftView => ({ meId: me, drafts: [...rows.values()], ownerQuotaBytes: 16 * 1024 * 1024,
    ownerUsedBytes: [...rows.values()].reduce((sum, value) => sum + value.files.reduce((total, item) => total + item.byteLength, 0), 0) })
  const api = {
    chatFileDrafts: vi.fn<Remote['chatFileDrafts']>().mockImplementation(async () => success(view())),
    saveChatFileDraft: vi.fn<Remote['saveChatFileDraft']>().mockImplementation(async (input) => {
      const retried = saves.get(input.requestId)
      if (retried) return success(retried)
      if ((rows.get(input.peerId)?.revision ?? 0) !== input.revision) return denied('conflict')
      const files = input.files.map((value) => {
        const id = randomUUID() as OfficeChatAttachmentId
        bytes.set(id, value)
        return { id, name: value.name, mediaType: value.mediaType, byteLength: value.byteLength,
          sha256: digest(Buffer.from(value.dataBase64, 'base64')) }
      })
      const saved: OfficeChatFileDraft = { peerId: input.peerId, revision: input.revision + 1, files, updatedAt: 1, pendingSend: null,
        peer: { id: input.peerId, name: input.peerId, active: true } }
      rows.set(input.peerId, saved)
      saves.set(input.requestId, saved)
      return success(saved)
    }),
    downloadChatFileDraft: vi.fn<Remote['downloadChatFileDraft']>().mockImplementation(async (input) => {
      const row = rows.get(input.peerId)
      const metadata = row?.revision === input.revision ? row.files.find(value => value.id === input.attachmentId) : undefined
      const data = bytes.get(input.attachmentId)
      return metadata && data ? success({ ...metadata, peerId: input.peerId, revision: input.revision,
        dataBase64: data.dataBase64 }) : denied('not_found')
    }),
    sendChatFileDraft: vi.fn<Remote['sendChatFileDraft']>().mockImplementation(async (input) => {
      const previous = sends.get(input.id)
      if (previous) return success(previous)
      const row = rows.get(input.peerId)
      if (!row || row.revision !== input.revision || row.files.length === 0) return denied('conflict')
      const message: OfficeChatMessage = { id: input.id, senderId: me, recipientId: input.peerId, sequence: sends.size + 1,
        senderName: 'Lin', recipientName: input.peerId, createdAt: 1,
        text: input.text.trim() ? input.text : row.files.map(value => value.name).join('\n'), attachments: row.files }
      sends.set(input.id, message)
      rows.set(input.peerId, { ...row, revision: row.revision + 1, files: [], pendingSend: null })
      return success(message)
    }),
  }
  const notify = vi.fn<ConstructorParameters<typeof OfficeFileDraftModel>[2]>()
  const published = vi.fn<ConstructorParameters<typeof OfficeFileDraftModel>[3]>().mockResolvedValue(undefined)
  const create = () => {
    const model = new OfficeFileDraftModel(api, () => limits, notify, published)
    onTestFinished(() => { model.dispose() })
    return model
  }
  return { api, rows, bytes, view, create, notify, published, sends }
}
async function ready(model: OfficeFileDraftModel) {
  model.bind(me)
  await vi.waitFor(() => { expect(model.state.getSnapshot().mode).toBe('durable') })
}
async function saved(model: OfficeFileDraftModel, contact = peer) {
  await vi.waitFor(() => {
    expect(model.state.getSnapshot().contacts[contact]).toMatchObject({ saving: false, dirty: false, saveError: null })
  }, { timeout: 10000 })
}

it('saves eight-MiB and zero-byte files, restores metadata in a fresh model and sends without downloading draft bytes', async () => {
  const f = fixture()
  const model = f.create()
  await ready(model)
  const large = Buffer.alloc(8 * 1024 * 1024, 31)
  model.add(peer, [file('large.bin', large), file('empty.bin', Buffer.alloc(0))])
  await saved(model)
  const input = f.api.saveChatFileDraft.mock.calls[0]![0]
  expect(Buffer.compare(Buffer.from(input.files[0]!.dataBase64, 'base64'), large)).toBe(0)
  const json = JSON.stringify(model.state.getSnapshot())
  expect(json).not.toContain('dataBase64')
  expect(json.length).toBeLessThan(3000)
  model.dispose()
  const restored = f.create()
  await ready(restored)
  expect(restored.state.getSnapshot().contacts[peer]?.files.map(value => value.name)).toEqual(['large.bin', 'empty.bin'])
  expect(await restored.send(peer, '')).toBe(true)
  expect(f.api.downloadChatFileDraft).not.toHaveBeenCalled()
  expect(Object.keys(f.api.sendChatFileDraft.mock.calls[0]![0]).sort()).toEqual(['id', 'peerId', 'revision', 'text'])
  expect(f.sends.size).toBe(1)
  expect(restored.state.getSnapshot().contacts[peer]?.files).toEqual([])
})

it('restores and verifies a retained file when removing another saved file after reload', async () => {
  const f = fixture()
  const model = f.create()
  await ready(model)
  model.add(peer, [file('keep.bin'), file('remove.bin')])
  await saved(model)
  model.dispose()
  const restored = f.create()
  await ready(restored)
  const remove = restored.state.getSnapshot().contacts[peer]!.files.find(value => value.name === 'remove.bin')!
  restored.remove(peer, remove.id)
  await saved(restored)
  expect(f.api.downloadChatFileDraft).toHaveBeenCalledTimes(1)
  expect(f.rows.get(peer)?.files.map(value => value.name)).toEqual(['keep.bin'])
  expect(f.api.saveChatFileDraft.mock.calls.at(-1)![0].files[0]?.dataBase64).toBe(content.toString('base64'))
})

it('keeps a failed save frozen and retries its exact original identity and bytes without another local read', async () => {
  const f = fixture()
  const model = f.create()
  await ready(model)
  const store = f.api.saveChatFileDraft.getMockImplementation()!
  f.api.saveChatFileDraft.mockImplementationOnce(async (input) => { await store(input); throw new Error('Reply lost') })
  const selected = file()
  const read = vi.spyOn(selected, 'arrayBuffer')
  model.add(peer, [selected])
  await vi.waitFor(() => { expect(model.state.getSnapshot().contacts[peer]?.saveError).toBe('unavailable') })
  model.add(peer, [file('not-admitted.bin')])
  expect(model.state.getSnapshot().contacts[peer]?.files).toHaveLength(1)
  expect(await model.retry(peer)).toBe(true)
  expect(f.api.saveChatFileDraft.mock.calls[0]![0]).toBe(f.api.saveChatFileDraft.mock.calls[1]![0])
  expect(read).toHaveBeenCalledTimes(1)
  await saved(model)
})

it('preserves local files on a competing write until the user chooses to keep or load the saved selection', async () => {
  const f = fixture()
  const model = f.create()
  await ready(model)
  model.add(peer, [file('original.bin')])
  await saved(model)
  await f.api.saveChatFileDraft({ peerId: peer, revision: 1, requestId: randomUUID(), files: [inputFile('other-window.bin', content)] })
  model.add(peer, [file('local-addition.bin')])
  await vi.waitFor(() => { expect(model.state.getSnapshot().contacts[peer]?.saveError).toBe('conflict') })
  const calls = f.api.saveChatFileDraft.mock.calls.length
  model.add(peer, [file('later-local.bin')])
  expect(f.api.saveChatFileDraft).toHaveBeenCalledTimes(calls)
  await model.resolve(peer, true)
  await saved(model)
  expect(f.rows.get(peer)?.files.map(value => value.name)).toEqual(['original.bin', 'local-addition.bin', 'later-local.bin'])
  await f.api.saveChatFileDraft({ peerId: peer, revision: 3, requestId: randomUUID(), files: [inputFile('chosen-remote.bin', content)] })
  model.add(peer, [file('not-to-overwrite.bin')])
  await vi.waitFor(() => { expect(model.state.getSnapshot().contacts[peer]?.saveError).toBe('conflict') })
  await model.resolve(peer, false)
  expect(model.state.getSnapshot().contacts[peer]?.files.map(value => value.name)).toEqual(['chosen-remote.bin'])
})

it('restores the original pending send and rejects a changed caption without replacing its retry identity', async () => {
  const f = fixture()
  const model = f.create()
  await ready(model)
  model.add(peer, [file()])
  await saved(model)
  f.api.sendChatFileDraft.mockResolvedValueOnce(denied('not_found'))
  expect(await model.send(peer, 'original caption')).toBe(false)
  const input = f.api.sendChatFileDraft.mock.calls[0]![0]
  f.rows.set(peer, { ...f.rows.get(peer)!, pendingSend: input })
  model.dispose()
  const restored = f.create()
  await ready(restored)
  expect(await restored.send(peer, 'new unsent text')).toBe(false)
  expect(restored.state.getSnapshot().contacts[peer]?.error).toBe('chatFilePendingCaption')
  expect(await restored.send(peer, 'original caption')).toBe(true)
  expect(f.api.sendChatFileDraft.mock.calls[1]![0]).toEqual(input)
  expect(f.sends.size).toBe(1)
})

it('retries a lost clear acknowledgement without restoring files or reusing a new request identity', async () => {
  const f = fixture()
  const model = f.create()
  await ready(model)
  model.add(peer, [file()])
  await saved(model)
  f.api.sendChatFileDraft.mockResolvedValueOnce(denied('not_found'))
  expect(await model.send(peer, 'pending')).toBe(false)
  const store = f.api.saveChatFileDraft.getMockImplementation()!
  f.api.saveChatFileDraft.mockImplementationOnce(async (input) => { await store(input); throw new Error('Clear reply lost') })
  expect(await model.clear(peer)).toBe(false)
  const original = f.api.saveChatFileDraft.mock.calls.at(-1)![0]
  expect(await model.retry(peer)).toBe(true)
  expect(f.api.saveChatFileDraft.mock.calls.at(-1)![0]).toBe(original)
  expect(model.state.getSnapshot().contacts[peer]).toMatchObject({ files: [], pendingSend: null, dirty: false })
})

it('rejects corrupt saved draft bytes before submitting a replacement selection', async () => {
  const f = fixture()
  const model = f.create()
  await ready(model)
  model.add(peer, [file('keep.bin'), file('remove.bin')])
  await saved(model)
  model.dispose()
  const restored = f.create()
  await ready(restored)
  const read = f.api.downloadChatFileDraft.getMockImplementation()!
  f.api.downloadChatFileDraft.mockImplementationOnce(async (input) => {
    const value = await read(input)
    return value.ok && value.value.ok ? success({ ...value.value.value, dataBase64: Buffer.alloc(content.length, 19).toString('base64') }) : value
  })
  restored.remove(peer, restored.state.getSnapshot().contacts[peer]!.files[1]!.id)
  await vi.waitFor(() => { expect(restored.state.getSnapshot().contacts[peer]?.saveError).toBe('downloadCorrupt') })
  expect(f.api.saveChatFileDraft).toHaveBeenCalledTimes(1)
  expect(f.rows.get(peer)?.files).toHaveLength(2)
})

it('does not upload a previous account file after its local read finishes late', async () => {
  const f = fixture()
  const model = f.create()
  await ready(model)
  const hold = Promise.withResolvers<ArrayBuffer>()
  const selected = file()
  vi.spyOn(selected, 'arrayBuffer').mockReturnValueOnce(hold.promise)
  model.add(peer, [selected])
  f.api.chatFileDrafts.mockResolvedValue(success({ meId: other, drafts: [], ownerQuotaBytes: 16, ownerUsedBytes: 0 }))
  model.bind(other)
  hold.resolve(new Uint8Array(content).buffer)
  await vi.waitFor(() => { expect(model.state.getSnapshot().mode).toBe('durable') })
  expect(f.api.saveChatFileDraft).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().contacts).toEqual({})
})

it('fences a previous account save response before it can replace another account contact state', async () => {
  const f = fixture()
  const model = f.create()
  await ready(model)
  const hold = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatFileDraft>>>()
  f.api.saveChatFileDraft.mockReturnValueOnce(hold.promise)
  model.add(peer, [file()])
  await vi.waitFor(() => { expect(f.api.saveChatFileDraft).toHaveBeenCalledTimes(1) })
  const input = f.api.saveChatFileDraft.mock.calls[0]![0]
  f.api.chatFileDrafts.mockResolvedValue(success({ meId: other, drafts: [], ownerQuotaBytes: 16, ownerUsedBytes: 0 }))
  model.bind(other)
  const result = await f.api.saveChatFileDraft(input)
  hold.resolve(result)
  await vi.waitFor(() => { expect(model.state.getSnapshot().mode).toBe('durable') })
  expect(model.state.getSnapshot().contacts).toEqual({})
})

it('retains local mode for an older gateway and leaves file selection disabled after an unavailable initial read', async () => {
  const f = fixture()
  f.api.chatFileDrafts.mockResolvedValueOnce(denied('invalid_input'))
  const legacy = f.create()
  legacy.bind(me)
  await vi.waitFor(() => { expect(legacy.state.getSnapshot().mode).toBe('local') })
  const unavailable = f.create()
  f.api.chatFileDrafts.mockRejectedValueOnce(new Error('Offline'))
  unavailable.bind(me)
  await vi.waitFor(() => { expect(unavailable.state.getSnapshot().mode).toBe('failed') })
  unavailable.add(peer, [file()])
  expect(f.api.saveChatFileDraft).not.toHaveBeenCalled()
  await unavailable.load()
  expect(unavailable.state.getSnapshot().mode).toBe('durable')
})
