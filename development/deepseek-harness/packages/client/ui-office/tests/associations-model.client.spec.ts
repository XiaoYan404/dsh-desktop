/** Private conversation choices retain exact retries and reject stale account, role and target results. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { OfficeConversationId, OfficeConversationLinks, OfficeConversationLinksInput, OfficeConversationLinksView,
  OfficeMemberId, OfficeToolReference } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeAssociationsModel } from '../src/client/associations-model.ts'

const member = { id: 'lin' as OfficeMemberId, role: 'employee' as const }
const id = 'conversation-one' as OfficeConversationId
const other = 'conversation-two' as OfficeConversationId
const tool: OfficeToolReference = { kind: 'template', name: 'minutes' }
const input: OfficeConversationLinksInput = { conversationId: id, kind: 'tools', tools: [tool], revision: 0,
  requestId: '89c1fa8f-7b2a-4b81-b023-e5103ef4dad2' }

function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
function selection(request: OfficeConversationLinksInput): OfficeConversationLinks {
  return { conversationId: request.conversationId, revision: request.revision + 1, requestId: request.requestId, updatedAt: 1,
    integrations: request.kind === 'integrations' ? request.integrations : [], tools: request.kind === 'tools' ? request.tools : [] }
}
function view(target = id): OfficeConversationLinksView {
  return { meId: member.id, selection: { conversationId: target, revision: 0, requestId: null, updatedAt: null,
    integrations: [], tools: [] }, limits: { maxSelected: 50, maxContexts: 10000 }, requirements: [] }
}
function fixture() {
  const remote = {
    conversationLinks: vi.fn<ConstructorParameters<typeof OfficeAssociationsModel>[0]['conversationLinks']>()
      .mockImplementation(async target => ok(view(target))),
    saveConversationLinks: vi.fn<ConstructorParameters<typeof OfficeAssociationsModel>[0]['saveConversationLinks']>()
      .mockImplementation(async request => ok(selection(request))),
  }
  const notify = vi.fn()
  const model = new OfficeAssociationsModel(remote, notify)
  model.bind(member)
  return { model, remote, notify }
}

it('keeps a confirmed commit when its subsequent refresh fails and sends the original review version', async () => {
  const { model, remote, notify } = fixture()
  await model.load(id)
  remote.conversationLinks.mockRejectedValueOnce(new Error('Offline'))
  expect(await model.save(input)).toEqual({ ok: true })
  expect(remote.saveConversationLinks).toHaveBeenCalledWith(input)
  expect(model.state.getSnapshot()).toMatchObject({ view: { selection: selection(input) }, busy: false,
    error: 'associationUnavailable' })
  expect(notify).toHaveBeenCalledWith('associationSaved', true)
})

it('rejects a stale edit instead of silently adopting a refreshed version for its write', async () => {
  const { model, remote } = fixture()
  await model.load(id)
  remote.saveConversationLinks.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'conflict' } })
  remote.conversationLinks.mockResolvedValueOnce(ok({ ...view(), selection: { ...selection(input), revision: 7 } }))
  expect(await model.save(input)).toEqual({ ok: false, error: 'conflict', uncertain: false })
  expect(remote.saveConversationLinks).toHaveBeenCalledExactlyOnceWith(input)
  expect(model.state.getSnapshot()).toMatchObject({ view: { selection: { revision: 7 } }, error: 'conflict', busy: false })
})

it('retries an automatic choice with its original UUID after an uncertain acknowledgement, without another version', async () => {
  const { model, remote } = fixture()
  let committed: OfficeConversationLinks | null = null
  remote.conversationLinks.mockImplementation(async target => ok({ ...view(target), ...(committed ? { selection: committed } : {}) }))
  remote.saveConversationLinks.mockImplementationOnce(async (request) => {
    committed = selection(request)
    throw new Error('Acknowledgement lost')
  }).mockImplementation(async () => {
    if (!committed) throw new Error('Expected original commit')
    return ok(committed)
  })
  const signal = new AbortController().signal
  expect(await model.addTool(id, tool, signal)).toBe(false)
  expect(model.state.getSnapshot().error).toBe('associationSaveUnknown')
  expect(await model.addTool(id, tool, signal)).toBe(true)
  expect(remote.saveConversationLinks).toHaveBeenCalledTimes(2)
  expect(remote.saveConversationLinks.mock.calls[1]?.[0]).toEqual(remote.saveConversationLinks.mock.calls[0]?.[0])
  expect(model.state.getSnapshot().view?.selection.revision).toBe(1)
  expect(await model.addTool(id, tool, signal)).toBe(true)
  expect(remote.saveConversationLinks).toHaveBeenCalledTimes(2)
})

it('withdraws a pending target read before displaying a different conversation', async () => {
  const { model, remote } = fixture()
  const held = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConversationLinksView>>>()
  remote.conversationLinks.mockReturnValueOnce(held.promise)
  const first = model.load(id)
  await model.load(other)
  held.resolve(ok(view()))
  await first
  expect(model.state.getSnapshot()).toMatchObject({ conversationId: other, view: view(other), loading: false })
})

it('clears private choices and ignores late saves after role changes, account changes and unload', async () => {
  const { model, remote, notify } = fixture()
  for (const next of [{ ...member, role: 'admin' as const }, { ...member, id: 'other' as OfficeMemberId }, null]) {
    model.bind(member)
    await model.load(id)
    const held = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConversationLinks>>>()
    remote.saveConversationLinks.mockReturnValueOnce(held.promise)
    const saving = model.save(input)
    model.bind(next)
    held.resolve(ok(selection(input)))
    expect(await saving).toEqual({ ok: false, error: null, uncertain: false })
    expect(model.state.getSnapshot()).toMatchObject({ conversationId: null, view: null, busy: false })
  }
  model.bind(member)
  await model.load(id)
  model.dispose()
  expect(await model.load(id)).toBeNull()
  expect(await model.save(input)).toEqual({ ok: false, error: null, uncertain: false })
  expect(notify).not.toHaveBeenCalled()
})

it('removes metadata after authorization loss and reports the denial to the identity owner', async () => {
  const { model, remote, notify } = fixture()
  await model.load(id)
  remote.conversationLinks.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
  expect(await model.load(id)).toBeNull()
  expect(model.state.getSnapshot()).toMatchObject({ conversationId: null, view: null, loading: false })
  expect(notify).toHaveBeenCalledWith('forbidden', false)
})

it('refuses mismatched wire identities and acknowledgements without claiming a confirmed choice', async () => {
  const { model, remote } = fixture()
  remote.conversationLinks.mockResolvedValueOnce(ok({ ...view(), meId: 'other' as OfficeMemberId }))
  expect(await model.load(id)).toBeNull()
  expect(model.state.getSnapshot().view).toBeNull()
  await model.load(id)
  remote.saveConversationLinks.mockResolvedValueOnce(ok({ ...selection(input), tools: [] }))
  expect(await model.save(input)).toEqual({ ok: false, error: 'associationSaveUnknown', uncertain: true })
  expect(model.state.getSnapshot().view?.selection.revision).toBe(0)
})

it('treats a failed gateway response as uncertain because the central write may already have committed', async () => {
  const { model, remote } = fixture()
  await model.load(id)
  remote.saveConversationLinks.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Connection unavailable', {}) })
  expect(await model.save(input)).toEqual({ ok: false, error: 'associationSaveUnknown', uncertain: true })
})

it('admits one write and fences an older read that finishes during it', async () => {
  const { model, remote } = fixture()
  await model.load(id)
  const reading = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConversationLinksView>>>()
  const saving = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConversationLinks>>>()
  remote.conversationLinks.mockReturnValueOnce(reading.promise)
  const read = model.load(id)
  remote.saveConversationLinks.mockReturnValueOnce(saving.promise)
  const write = model.save(input)
  expect(await model.save(input)).toMatchObject({ ok: false })
  reading.resolve(ok(view()))
  await read
  expect(model.state.getSnapshot().busy).toBe(true)
  remote.conversationLinks.mockRejectedValueOnce(new Error('Offline'))
  saving.resolve(ok(selection(input)))
  expect(await write).toEqual({ ok: true })
  expect(model.state.getSnapshot()).toMatchObject({ view: { selection: { revision: 1 } }, busy: false, loading: false })
})
