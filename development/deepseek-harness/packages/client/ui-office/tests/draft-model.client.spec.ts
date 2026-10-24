/** Durable draft races keep unsent text private and make overwrite choices explicit. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeChatDraft, OfficeChatDraftView, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeChatDraftModel } from '../src/client/draft-model.ts'

const me = 'me' as OfficeMemberId
const a = 'a' as OfficeMemberId
const b = 'b' as OfficeMemberId
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
type DraftRemote = ConstructorParameters<typeof OfficeChatDraftModel>[0]
const remote = () => ({
  chatDrafts: vi.fn<DraftRemote['chatDrafts']>().mockResolvedValue(success({ meId: me, drafts: [] })),
  saveChatDraft: vi.fn<DraftRemote['saveChatDraft']>().mockImplementation(async input => success({
    peerId: input.peerId, text: input.text, revision: input.revision + 1,
  })),
})
const models: OfficeChatDraftModel[] = []
function create(api = remote()) { const model = new OfficeChatDraftModel(api); models.push(model); return model }
async function ready(model: OfficeChatDraftModel) {
  model.bind(me)
  await vi.waitFor(() => { expect(model.status.getSnapshot().ready).toBe(true) })
}
afterEach(() => { for (const model of models.splice(0)) model.dispose() })

describe('OfficeChatDraftModel', () => {
  it('ignores a previous account confirmation even when its captured text matches the new account draft', async () => {
    const api = remote()
    const model = create(api)
    await ready(model)
    model.set(a, '相同的未发送内容')
    api.chatDrafts.mockResolvedValue(success({ meId: b, drafts: [] }))
    model.bind(b)
    await vi.waitFor(() => { expect(model.status.getSnapshot().ready).toBe(true) })
    model.set(a, '相同的未发送内容')
    model.clearFor(me, a, '相同的未发送内容')
    expect(model.state.getSnapshot()[a]).toBe('相同的未发送内容')
    model.clearFor(b, a, '相同的未发送内容')
    expect(model.state.getSnapshot()[a]).toBe('')
  })
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])('saves and clears a real contact draft for the valid employee ID %s', async (id) => {
    const api = remote()
    const model = create(api)
    await ready(model)
    const peer = id as OfficeMemberId
    model.set(peer, 'A draft for this directory identity')
    await model.flush()
    expect(api.saveChatDraft).toHaveBeenCalledWith(expect.objectContaining({ peerId: peer, text: 'A draft for this directory identity', revision: 0 }))
    expect(model.status.getSnapshot().unsaved).toEqual([])
    model.clear(peer, 'A draft for this directory identity')
    await model.flush()
    expect(api.saveChatDraft).toHaveBeenLastCalledWith(expect.objectContaining({ peerId: peer, text: '', revision: 1 }))
    expect(Object.hasOwn(model.state.getSnapshot(), peer)).toBe(true)
  })

  it('clears private unsaved text and fences an earlier read when a save loses authentication', async () => {
    const api = remote()
    const model = create(api)
    await ready(model)
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatDraftView>>>()
    api.chatDrafts.mockReturnValueOnce(pending.promise)
    const reading = model.load()
    model.set(a, 'private unsaved text')
    api.saveChatDraft.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
    await model.flush()
    pending.resolve(success({ meId: me, drafts: [{ peerId: a, text: 'late private text', revision: 1 }] }))
    await reading
    expect(model.state.getSnapshot()).toEqual({})
    expect(model.status.getSnapshot()).toMatchObject({ ready: false, error: 'unauthenticated', unsaved: [], pending: [] })
  })

  it('restores each contact and refreshes clean drafts without overwriting local edits', async () => {
    const api = remote()
    api.chatDrafts.mockResolvedValue(success({ meId: me, drafts: [{ peerId: a, text: 'saved A', revision: 2 }, { peerId: b, text: 'saved B', revision: 4 }] }))
    const model = create(api)
    await ready(model)
    expect(model.state.getSnapshot()).toEqual({ a: 'saved A', b: 'saved B' })
    model.set(a, 'local edit')
    api.chatDrafts.mockResolvedValue(success({ meId: me, drafts: [{ peerId: a, text: 'other A', revision: 3 }, { peerId: b, text: 'other B', revision: 5 }] }))
    await model.load()
    expect(model.state.getSnapshot()).toEqual({ a: 'local edit', b: 'other B' })
    await model.flush()
    expect(api.saveChatDraft).toHaveBeenCalledWith(expect.objectContaining({ peerId: a, text: 'local edit', revision: 2 }))
    expect(model.status.getSnapshot().unsaved).toEqual([])
  })

  it('keeps typing during a save and conditionally clears only the confirmed sent text', async () => {
    const api = remote()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatDraft>>>()
    api.saveChatDraft.mockReturnValueOnce(pending.promise)
    const model = create(api)
    await ready(model)
    model.set(a, 'first')
    const saving = model.flush()
    model.set(a, 'typed while sending')
    model.clear(a, 'first')
    pending.resolve(success({ peerId: a, text: 'first', revision: 1 }))
    await saving
    expect(model.state.getSnapshot()[a]).toBe('typed while sending')
    expect(model.status.getSnapshot().unsaved).toEqual([a])
    await model.flush()
    expect(api.saveChatDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'typed while sending', revision: 1 }))
    model.clear(a, 'typed while sending')
    await model.flush()
    expect(api.saveChatDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: '', revision: 2 }))
    expect(model.status.getSnapshot().unsaved).toEqual([])
  })

  it('retries the exact uncertain write before saving text entered after a transport failure', async () => {
    const api = remote()
    api.saveChatDraft.mockRejectedValueOnce(new Error('Response lost after commit'))
    const model = create(api)
    await ready(model)
    model.set(a, 'first')
    await model.flush()
    const first = api.saveChatDraft.mock.calls[0]![0]
    expect(model.status.getSnapshot().errors[a]).toBe('unavailable')
    model.set(a, 'newer')
    await model.retry(a)
    expect(api.saveChatDraft.mock.calls[1]![0]).toBe(first)
    expect(model.state.getSnapshot()[a]).toBe('newer')
    await model.flush()
    const latest = api.saveChatDraft.mock.calls[2]![0]
    expect(latest).toMatchObject({ peerId: a, text: 'newer', revision: 1 })
    expect(latest.requestId).not.toBe(first.requestId)
  })

  it('preserves conflicting input until the user explicitly keeps it against a freshly read version', async () => {
    const api = remote()
    api.saveChatDraft.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'conflict' } })
    const model = create(api)
    await ready(model)
    model.set(a, 'my input')
    await model.flush()
    await model.retry(a)
    expect(api.saveChatDraft).toHaveBeenCalledTimes(1)
    expect(model.state.getSnapshot()[a]).toBe('my input')
    api.chatDrafts.mockResolvedValue(success({ meId: me, drafts: [{ peerId: a, text: 'other window', revision: 3 }] }))
    await model.resolve(a, true)
    expect(api.saveChatDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'my input', revision: 3 }))
    expect(model.status.getSnapshot()).toMatchObject({ unsaved: [], errors: {} })
  })

  it('loads the chosen saved version and refuses to discard text typed during its read', async () => {
    const api = remote()
    const model = create(api)
    await ready(model)
    model.set(a, 'mine')
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatDraftView>>>()
    api.chatDrafts.mockReturnValueOnce(pending.promise)
    const resolving = model.resolve(a, false)
    model.set(a, 'newer typing')
    pending.resolve(success({ meId: me, drafts: [{ peerId: a, text: 'saved other', revision: 7 }] }))
    await resolving
    expect(model.state.getSnapshot()[a]).toBe('newer typing')
    api.chatDrafts.mockResolvedValue(success({ meId: me, drafts: [{ peerId: a, text: 'saved other', revision: 7 }] }))
    await model.resolve(a, false)
    expect(model.state.getSnapshot()[a]).toBe('saved other')
    expect(model.status.getSnapshot().unsaved).toEqual([])
    expect(api.saveChatDraft).not.toHaveBeenCalled()
  })

  it('clears prior-account drafts and ignores an old employee write and read after rebinding', async () => {
    const api = remote()
    const model = create(api)
    await ready(model)
    model.set(a, 'private old employee')
    const write = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatDraft>>>()
    const read = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatDraftView>>>()
    api.saveChatDraft.mockReturnValueOnce(write.promise)
    api.chatDrafts.mockReturnValueOnce(read.promise).mockResolvedValue(success({ meId: b, drafts: [] }))
    const saving = model.flush()
    const loading = model.load()
    model.bind(b)
    write.resolve(success({ peerId: a, text: 'private old employee', revision: 1 }))
    read.resolve(success({ meId: me, drafts: [{ peerId: a, text: 'private response', revision: 8 }] }))
    await Promise.all([saving, loading])
    await vi.waitFor(() =>{  expect(model.status.getSnapshot().ready).toBe(true) })
    expect(model.state.getSnapshot()).toEqual({})
    expect(model.status.getSnapshot()).toMatchObject({ unsaved: [], pending: [], errors: {} })
  })

  it('fails closed on a wrong identity and retains current input on a transient refresh failure', async () => {
    const api = remote()
    const model = create(api)
    await ready(model)
    model.set(a, 'unsaved local')
    api.chatDrafts.mockRejectedValueOnce(new Error('Offline'))
    await model.load()
    expect(model.state.getSnapshot()[a]).toBe('unsaved local')
    expect(model.status.getSnapshot()).toMatchObject({ ready: true, error: 'unavailable' })
    api.chatDrafts.mockResolvedValueOnce(success({ meId: b, drafts: [{ peerId: a, text: 'not ours', revision: 1 }] }))
    await model.load()
    expect(model.state.getSnapshot()).toEqual({})
    expect(model.status.getSnapshot()).toMatchObject({ ready: false, error: 'forbidden' })
  })

  it('drops private local text at unload and ignores a late successful save', async () => {
    const api = remote()
    const model = create(api)
    await ready(model)
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeChatDraft>>>()
    api.saveChatDraft.mockReturnValueOnce(pending.promise)
    model.set(a, 'private')
    const saving = model.flush()
    model.dispose()
    pending.resolve(success({ peerId: a, text: 'private', revision: 1 }))
    await saving
    expect(model.state.getSnapshot()).toEqual({})
    expect(model.status.getSnapshot()).toMatchObject({ ready: false, unsaved: [], pending: [] })
  })
})
