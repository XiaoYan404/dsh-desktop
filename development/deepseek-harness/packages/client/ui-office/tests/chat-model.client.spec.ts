/** Private conversation races, retry identities and draft isolation without browser timing. */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeChatMessage, OfficeChatView, OfficeMemberId, OfficeMessageId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeChatModel } from '../src/client/chat-model.ts'
import { OfficeChatDraftStore } from '../src/client/store.ts'
import type { OfficeOutcome } from '../src/types.ts'

const me = 'me' as OfficeMemberId
const a = 'a' as OfficeMemberId
const b = 'b' as OfficeMemberId
const uuid = 'a0c7e711-b246-4c53-a2d4-1624d8f38c03' as OfficeMessageId
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const view = (peer: OfficeMemberId): OfficeChatView => ({
  revision: 0, meId: me, peer: { id: peer, name: peer, active: true }, threads: [], messages: [],
  hasMore: false, readThrough: 0, peerReadThrough: 0,
})
const message = (peer: OfficeMemberId, sequence: number): OfficeChatMessage => ({ id: `${uuid.slice(0, -4)}${String(sequence).padStart(4, '0')}` as OfficeMessageId, sequence, senderId: me, recipientId: peer, senderName: 'Me', recipientName: peer, text: String(sequence), createdAt: 1 })
type ChatRemote = ConstructorParameters<typeof OfficeChatModel>[0]
const remote = () => ({
  chat: vi.fn<ChatRemote['chat']>().mockResolvedValue(success(view(a))),
  sendMessage: vi.fn<ChatRemote['sendMessage']>().mockResolvedValue(success(message(a, 1))),
  readChat: vi.fn<ChatRemote['readChat']>().mockResolvedValue(success(null)),
})

describe('OfficeChatModel', () => {
  it('clears private history and fences an earlier refresh when sending loses authentication', async () => {
    const api = remote()
    const model = new OfficeChatModel(api, () => uuid)
    model.bind(me)
    await model.load(a)
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatView>>>()
    api.chat.mockReturnValueOnce(pending.promise)
    const reading = model.load(a)
    api.sendMessage.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
    expect(await model.send(a, 'private text')).toBe(false)
    pending.resolve(success(view(a)))
    await reading
    expect(model.state.getSnapshot()).toMatchObject({ view: null, pending: [], sendErrors: {}, error: 'unauthenticated' })
  })

  it('clears account drafts and ignores a previous employee pending send after identity replacement', async () => {
    const api = remote()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatMessage>>>()
    api.sendMessage.mockReturnValueOnce(pending.promise)
    const model = new OfficeChatModel(api, () => uuid)
    const drafts = new OfficeChatDraftStore()
    model.bind(me)
    drafts.bind(me)
    drafts.set(a, 'private draft')
    const sending = model.send(a, 'private draft')
    model.bind(b)
    drafts.bind(b)
    pending.resolve(success(message(a, 1)))
    expect(await sending).toBe(false)
    expect(drafts.state.getSnapshot()).toEqual({})
    expect(model.state.getSnapshot()).toMatchObject({ view: null, pending: [], sendErrors: {} })
    expect(api.chat).not.toHaveBeenCalled()
    api.chat.mockResolvedValueOnce(success(view(a)))
    await model.load(a)
    expect(model.state.getSnapshot()).toMatchObject({ view: null, error: 'forbidden' })
  })

  it('ignores an older contact response after the employee switches conversations', async () => {
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatView>>>()
    const api = remote()
    api.chat.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(success(view(b)))
    const model = new OfficeChatModel(api)
    const old = model.load(a)
    await model.load(b)
    pending.resolve(success(view(a)))
    await old
    expect(model.state.getSnapshot().view?.peer?.id).toBe(b)
  })

  it('reuses the exact message identity after an uncertain transport outcome', async () => {
    const api = remote()
    api.sendMessage.mockRejectedValueOnce(new Error('Lost acknowledgement'))
    const newId = vi.fn(() => uuid)
    const model = new OfficeChatModel(api, newId)
    expect(await model.send(a, 'same draft')).toBe(false)
    expect(model.state.getSnapshot().sendErrors[a]).toBe('unavailable')
    expect(await model.send(a, 'same draft')).toBe(true)
    expect(newId).toHaveBeenCalledTimes(1)
    expect(api.sendMessage.mock.calls.map(([input]) => input.id)).toEqual([uuid, uuid])
    expect(model.state.getSnapshot().sendErrors[a]).toBeUndefined()
  })

  it('keeps newer text and another contact draft when a pending send succeeds', async () => {
    const api = remote()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatMessage>>>()
    api.sendMessage.mockReturnValueOnce(pending.promise)
    const model = new OfficeChatModel(api, () => uuid)
    const drafts = new OfficeChatDraftStore()
    drafts.set(a, 'sent text')
    drafts.set(b, 'other contact')
    const sending = model.send(a, 'sent text').then((ok) => { if (ok) drafts.clear(a, 'sent text') })
    drafts.set(a, 'newly typed text')
    expect(await model.send(a, 'duplicate while pending')).toBe(false)
    pending.resolve(success(message(a, 1)))
    await sending
    expect(drafts.state.getSnapshot()).toEqual({ [a]: 'newly typed text', [b]: 'other contact' })
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    drafts.dispose()
    expect(drafts.state.getSnapshot()).toEqual({})
  })

  it('fences an earlier authorized response after a later membership denial', async () => {
    const api = remote()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatView>>>()
    api.chat.mockReturnValueOnce(pending.promise)
    api.sendMessage.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
    const model = new OfficeChatModel(api, () => uuid)
    const reading = model.load(a)
    expect(await model.send(a, 'denied')).toBe(false)
    pending.resolve(success(view(a)))
    await reading
    expect(model.state.getSnapshot()).toMatchObject({ view: null, error: 'forbidden' })
  })

  it('ignores a late older page after switching contacts and a late read after unload', async () => {
    const api = remote()
    const older = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatView>>>()
    api.chat.mockResolvedValueOnce(success({ ...view(a), messages: [message(a, 10)], hasMore: true }))
      .mockReturnValueOnce(older.promise).mockResolvedValueOnce(success(view(b)))
    const model = new OfficeChatModel(api)
    await model.load(a)
    const paging = model.older()
    await model.load(b)
    older.resolve(success({ ...view(a), messages: [message(a, 1)] }))
    await paging
    expect(model.state.getSnapshot().view).toEqual(view(b))
    const late = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatView>>>()
    api.chat.mockReturnValueOnce(late.promise)
    const reading = model.load(a)
    const snapshot = model.state.getSnapshot()
    model.dispose()
    late.resolve(success(view(a)))
    await reading
    expect(model.state.getSnapshot()).toBe(snapshot)
  })

  it('keeps loaded older history and merges a newer refresh without duplicates', async () => {
    const api = remote()
    api.chat.mockResolvedValueOnce(success({ ...view(a), messages: [message(a, 10)], hasMore: true }))
      .mockResolvedValueOnce(success({ ...view(a), messages: [message(a, 1)] }))
      .mockResolvedValueOnce(success({ ...view(a), messages: [message(a, 10), message(a, 11)], hasMore: true }))
    const model = new OfficeChatModel(api)
    await model.load(a)
    await model.older()
    await model.load()
    expect(model.state.getSnapshot().view?.messages.map(entry => entry.sequence)).toEqual([1, 10, 11])
    expect(model.state.getSnapshot().view?.hasMore).toBe(false)
  })
})
