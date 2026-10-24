// @vitest-environment jsdom
/** Native references remain resource-owned through cancellation, identity replacement and failed initial loading. */
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { ISessions, SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { OfficeConversationModel } from '../src/client/conversation-model.ts'
import { officeHomeInputAddress, officeHomeInputProvider } from '../src/client/home-resource.ts'

const employee = 'employee' as OfficeMemberId
const other = 'other' as OfficeMemberId
const ordinary = 'ordinary' as SessionId
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
  onTestFinished(() => { vi.unstubAllGlobals() })
})

async function fixture(pending = false) {
  const model = new OfficeConversationModel(() => () => {}, () => true, () => {}, async () => true, () => {})
  onTestFinished(() => { model.dispose() })
  await model.bind(employee)
  await model.observe(ordinary, employee, 'ordinary')
  const ready = Promise.withResolvers<SessionBinding>()
  // The provider treats the native binding as opaque; the standard SessionProvider alone consumes these members.
  const binding: SessionBinding = {
    sessionId: ordinary,
    get session(): SessionBinding['session'] { throw new Error('The resource must not inspect the native Session face') },
    get eventSource(): SessionBinding['eventSource'] { throw new Error('The resource must not inspect native history') },
    get ctx(): SessionBinding['ctx'] { throw new Error('The resource must not inspect the native context') },
  }
  const release = vi.fn()
  const reference: SessionReference = { sessionId: ordinary, binding, ready: ready.promise,
    release, [Symbol.dispose]: release }
  if (!pending) ready.resolve(binding)
  const retain = vi.fn<ISessions['retain']>().mockReturnValue(reference)
  const resource = new AbortController()
  onTestFinished(() => { resource.abort() })
  const address = officeHomeInputAddress(model.state.getSnapshot().ordinary!)
  const provider = officeHomeInputProvider({ retain }, model)
  return { model, ready, binding, release, reference, retain, resource, address, provider }
}

it('shares the exact native binding and releases only its own resource reference', async () => {
  const current = await fixture()
  const stream = current.provider.open(current.address, { signal: current.resource.signal })[Symbol.asyncIterator]()
  const opened = await stream.next()
  expect(opened.value).toEqual({ ok: true, value: { reference: current.reference } })
  expect(current.retain).toHaveBeenCalledTimes(1)
  expect(current.retain.mock.calls[0]![0]).toBe(ordinary)
  expect(current.retain.mock.calls[0]![1].source).toBe('officeHome')
  expect(current.retain.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal)
  const ended = stream.next()
  current.resource.abort()
  expect((await ended).done).toBe(true)
  expect(current.release).toHaveBeenCalledTimes(1)
  expect(current.model.current()).toBe(ordinary)
})

it('cancels a pending native load when the home resource closes', async () => {
  const current = await fixture(true)
  const stream = current.provider.open(current.address, { signal: current.resource.signal })[Symbol.asyncIterator]()
  const opened = stream.next()
  current.resource.abort()
  expect((await opened).done).toBe(true)
  expect(current.release).toHaveBeenCalledTimes(1)
})

it('withdraws a pending old employee reference before a late native load can publish it', async () => {
  const current = await fixture(true)
  const stream = current.provider.open(current.address, { signal: current.resource.signal })[Symbol.asyncIterator]()
  const opened = stream.next()
  await current.model.bind(other)
  expect((await opened).value).toEqual({ ok: true, value: { reference: undefined } })
  current.ready.resolve(current.binding)
  expect((await stream.next()).done).toBe(true)
  expect(current.release).toHaveBeenCalledTimes(1)
})

it('withdraws a published reference when the employee identity ends', async () => {
  const current = await fixture()
  const stream = current.provider.open(current.address, { signal: current.resource.signal })[Symbol.asyncIterator]()
  await stream.next()
  const withdrawn = stream.next()
  await current.model.bind(null)
  expect((await withdrawn).value).toEqual({ ok: true, value: { reference: undefined } })
  expect((await stream.next()).done).toBe(true)
  expect(current.release).toHaveBeenCalledTimes(1)
})

it('refuses a different input address without acquiring native resources', async () => {
  const current = await fixture()
  const address = officeHomeInputAddress({ ...current.model.state.getSnapshot().ordinary!, sessionId: 'different' as SessionId })
  const stream = current.provider.open(address, { signal: current.resource.signal })[Symbol.asyncIterator]()
  expect((await stream.next()).value).toMatchObject({ ok: false, error: { code: 'office/input-unavailable' } })
  expect(current.retain).not.toHaveBeenCalled()
})

it('reports a native load failure without exposing its private diagnostic and releases the reference', async () => {
  const current = await fixture(true)
  const stream = current.provider.open(current.address, { signal: current.resource.signal })[Symbol.asyncIterator]()
  const opened = stream.next()
  current.ready.reject(new Error('fixture sensitive diagnostic'))
  const failed = await opened
  expect(failed.value).toMatchObject({ ok: false, error: { code: 'office/input-unavailable', message: 'Office input is unavailable' } })
  expect(JSON.stringify(failed.value)).not.toContain('sensitive')
  expect((await stream.next()).done).toBe(true)
  expect(current.release).toHaveBeenCalledTimes(1)
})
