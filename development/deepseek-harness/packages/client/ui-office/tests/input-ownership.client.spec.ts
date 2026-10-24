/** Office entry preparation preserves choices, account generations and cancellation without affecting Native inputs. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConversationId, OfficeConversationLinksInput, OfficeConversationLinksView, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeInputOwnership } from '../src/client/input-ownership.ts'

const lin = 'lin' as OfficeMemberId
const chen = 'chen' as OfficeMemberId
const id = 'office-input' as OfficeConversationId
function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
function view(revision = 0): OfficeConversationLinksView {
  return { meId: lin, selection: { conversationId: id, revision, requestId: null, updatedAt: null, tools: [], integrations: [] },
    limits: { maxSelected: 50, maxContexts: 10000 }, requirements: [] }
}
function fixture() {
  const remote = {
    prepareNativeInput: vi.fn<ConstructorParameters<typeof OfficeInputOwnership>[0]['prepareNativeInput']>().mockResolvedValue(ok(null)),
    conversationLinks: vi.fn<ConstructorParameters<typeof OfficeInputOwnership>[0]['conversationLinks']>().mockResolvedValue(ok(view())),
    saveConversationLinks: vi.fn<ConstructorParameters<typeof OfficeInputOwnership>[0]['saveConversationLinks']>().mockImplementation(async input =>
      ok({ ...view().selection, revision: 1, requestId: input.requestId, updatedAt: 1 })),
  }
  const model = new OfficeInputOwnership(remote)
  model.bind(lin)
  return { model, remote, signal: new AbortController().signal }
}

it('shares first-input preparation and revokes an accepted approval after an account change', async () => {
  const { model, remote, signal } = fixture()
  const [first, second] = await Promise.all([model.prepare(id, signal, lin), model.prepare(id, signal, lin)])
  expect(first?.()).toBe(true)
  expect(second?.()).toBe(true)
  expect(remote.saveConversationLinks).toHaveBeenCalledTimes(1)
  const saved = remote.saveConversationLinks.mock.calls[0]?.[0]
  expect(saved).toMatchObject({ conversationId: id, revision: 0, kind: 'integrations', integrations: [] })
  expect(saved?.requestId).toMatch(/^[a-f0-9-]{36}$/)
  model.bind(chen)
  expect(first?.()).toBe(false)
})

it('keeps an established choice without writing or clearing its selected tools', async () => {
  const { model, remote, signal } = fixture()
  remote.conversationLinks.mockResolvedValue(ok({ ...view(4), selection: { ...view(4).selection, tools: [{ kind: 'skill', name: 'office' }] } }))
  expect((await model.prepare(id, signal, lin))?.()).toBe(true)
  expect(remote.saveConversationLinks).not.toHaveBeenCalled()
})

it('does not approve a stale employee after a late metadata read', async () => {
  const { model, remote, signal } = fixture()
  const read = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConversationLinksView>>>()
  remote.conversationLinks.mockReturnValueOnce(read.promise)
  const pending = model.prepare(id, signal, lin)
  model.bind(chen)
  read.resolve(ok(view()))
  expect(await pending).toBeUndefined()
  expect(remote.saveConversationLinks).not.toHaveBeenCalled()
})

it('withdraws an approval on cancellation or unload', async () => {
  const { model } = fixture()
  const controller = new AbortController()
  const approve = await model.prepare(id, controller.signal, lin)
  expect(approve?.()).toBe(true)
  controller.abort()
  expect(approve?.()).toBe(false)
  const next = await model.prepare(id, new AbortController().signal, lin)
  model.dispose()
  expect(next?.()).toBe(false)
})

it('recovers a confirmed metadata write after an uncertain response without writing it again', async () => {
  const { model, remote, signal } = fixture()
  remote.saveConversationLinks.mockImplementationOnce(async (_input: OfficeConversationLinksInput) => {
    remote.conversationLinks.mockResolvedValue(ok(view(1)))
    throw new Error('Response lost after commit')
  })
  expect(await model.prepare(id, signal, lin)).toBeUndefined()
  expect((await model.prepare(id, signal, lin))?.()).toBe(true)
  expect(remote.saveConversationLinks).toHaveBeenCalledTimes(1)
})

it('adopts a current choice after a competing initialization without overwriting it', async () => {
  const { model, remote, signal } = fixture()
  remote.saveConversationLinks.mockImplementationOnce(async () => {
    remote.conversationLinks.mockResolvedValue(ok(view(2)))
    return { ok: true, value: { ok: false, code: 'conflict' } }
  })
  expect((await model.prepare(id, signal, lin))?.()).toBe(true)
  expect(remote.saveConversationLinks).toHaveBeenCalledTimes(1)
})
