// @vitest-environment jsdom
/** Ordinary return targets and native resource owners follow the active employee's lifetime. */
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
import { OFFICE_NAVIGATION_DATABASE, OFFICE_NAVIGATION_SIGNAL_KEY, parseOfficeNavigationRecord } from '../src/client/conversation-data.ts'
import type { OfficeNavigationRecord } from '../src/client/conversation-data.ts'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { OfficeConversationModel } from '../src/client/conversation-model.ts'

const employee = 'constructor' as OfficeMemberId
const other = 'other' as OfficeMemberId
const first = 'ordinary-first' as SessionId
const second = 'ordinary-second' as SessionId
const item = 'item-session' as SessionId
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('indexedDB', new IDBFactory())
  onTestFinished(() => { vi.unstubAllGlobals() })
})

async function fixture(create = vi.fn<(signal: AbortSignal) => Promise<boolean>>().mockResolvedValue(true)) {
  const released = new Map<SessionId, ReturnType<typeof vi.fn>>()
  const retain = vi.fn((id: SessionId) => {
    const release = vi.fn()
    released.set(id, release)
    return release
  })
  const available = new Set([first, second, item])
  const open = vi.fn()
  const report = vi.fn()
  const model = new OfficeConversationModel(retain, id => available.has(id), open, create, report)
  await model.bind(employee)
  onTestFinished(() => { model.dispose() })
  return { model, retain, released, available, open, create, report }
}

async function connection(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFICE_NAVIGATION_DATABASE, 1)
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(new Error('Fixture navigation connection failed', { cause: request.error })) }
  })
}

async function recorded(): Promise<OfficeNavigationRecord> {
  return parseOfficeNavigationRecord(await storedValue())
}

async function storedValue(): Promise<unknown> {
  const database = await connection()
  return new Promise<unknown>((resolve, reject) => {
    const transaction = database.transaction('navigation', 'readonly')
    const request = transaction.objectStore('navigation').get('current')
    request.onsuccess = () => { database.close(); resolve(request.result) }
    request.onerror = () => { database.close(); reject(new Error('Fixture navigation read failed', { cause: request.error })) }
  })
}

async function replaceRecord(value: unknown): Promise<void> {
  const database = await connection()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('navigation', 'readwrite')
    transaction.objectStore('navigation').put(value, 'current')
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onabort = () => { database.close(); reject(new Error('Fixture navigation write failed', { cause: transaction.error })) }
  })
}

it('targets the last actually visited ordinary or item input only while its employee and Session remain available', async () => {
  const { model, available } = await fixture()
  expect(model.current()).toBeNull()
  await model.observe(first, employee, 'ordinary')
  expect(model.current()).toBe(first)
  await model.observe(item, employee, 'item')
  expect(model.current()).toBe(item)
  await model.observe(first, other, 'ordinary')
  expect(model.current()).toBe(item)
  available.delete(item)
  expect(model.current()).toBeNull()
  await model.bind(other)
  expect(model.current()).toBeNull()
  await model.observe(second, other, 'ordinary')
  expect(model.current()).toBe(second)
  model.dispose()
  expect(model.current()).toBeNull()
})

it('returns to the last ordinary input without replacing it with an item or creating a Session', async () => {
  const { model, open, create, retain } = await fixture()
  await model.observe(first, employee, 'ordinary')
  await model.observe(item, employee, 'item')
  await model.observe(item, employee, 'ordinary')
  expect(await model.restore()).toBe(true)
  expect(open).toHaveBeenLastCalledWith(first)
  expect(create).not.toHaveBeenCalled()
  expect(retain.mock.calls.map(([id]) => id)).toEqual([first])
  await model.observe(second, employee, 'ordinary')
  await model.observe(first, employee, 'ordinary')
  expect(await model.restore()).toBe(true)
  expect(open).toHaveBeenLastCalledWith(first)
  expect(retain).toHaveBeenCalledTimes(2)
})

it('restores navigation metadata after reload while leaving native text and bytes with their owners', async () => {
  const original = await fixture()
  await original.model.observe(first, employee, 'ordinary')
  await original.model.observe(item, employee, 'item')
  original.model.dispose()
  const next = await fixture()
  await next.model.observe(item, employee, 'ordinary')
  expect(await next.model.restore()).toBe(true)
  expect(next.open).toHaveBeenLastCalledWith(first)
  expect(localStorage.getItem('dsh.office.conversations.v1')).toBeNull()
  expect(Object.keys((await recorded()).data).sort()).toEqual(['entries', 'ordinary'])
})

it('releases ordinary input owners once and hides recorded sessions from another employee', async () => {
  const { model, released, retain, open } = await fixture()
  await model.observe(first, employee, 'ordinary')
  await model.observe(item, employee, 'item')
  await model.bind(other)
  expect(released.get(first)).toHaveBeenCalledTimes(1)
  expect(model.state.getSnapshot().hidden).toEqual([first, item])
  await model.observe(first, other, 'ordinary')
  await model.observe(second, employee, 'ordinary')
  expect(retain).toHaveBeenCalledTimes(1)
  await model.bind(employee)
  expect(model.state.getSnapshot().hidden).toEqual([])
  expect(await model.restore()).toBe(true)
  expect(open).toHaveBeenCalledWith(first)
  model.dispose()
  model.dispose()
  expect(released.get(first)).toHaveBeenCalledTimes(1)
})

it('preserves both employees when an older window records another conversation after a newer storage write', async () => {
  const earlier = await fixture()
  const later = await fixture()
  await later.model.bind(other)
  await earlier.model.observe(first, employee, 'ordinary')
  await later.model.observe(second, other, 'ordinary')

  const restoredEmployee = await fixture()
  expect(await restoredEmployee.model.restore()).toBe(true)
  expect(restoredEmployee.open).toHaveBeenCalledWith(first)
  expect(restoredEmployee.create).not.toHaveBeenCalled()
  expect(restoredEmployee.model.state.getSnapshot().hidden).toEqual([second])

  const restoredOther = await fixture()
  await restoredOther.model.bind(other)
  expect(await restoredOther.model.restore()).toBe(true)
  expect(restoredOther.open).toHaveBeenCalledWith(second)
  expect(restoredOther.model.state.getSnapshot().hidden).toEqual([first])
})

it('imports another window account index without changing this window input or retaining its resources', async () => {
  const current = await fixture()
  await current.model.observe(first, employee, 'ordinary')
  const changed = await fixture()
  await changed.model.bind(other)
  await changed.model.observe(second, other, 'ordinary')

  await current.model.synchronize('unrelated-storage-key')
  expect(current.model.state.getSnapshot().hidden).toEqual([])
  await current.model.synchronize(OFFICE_NAVIGATION_SIGNAL_KEY)
  expect(current.model.state.getSnapshot().hidden).toEqual([second])
  expect(current.model.current()).toBe(first)
  expect(current.open).not.toHaveBeenCalled()
  expect(current.retain.mock.calls.map(([id]) => id)).toEqual([first])
})

it('refuses another window recorded owner before observing a previously unclassified native input', async () => {
  const earlier = await fixture()
  const owner = await fixture()
  await owner.model.bind(other)
  await owner.model.observe(first, other, 'ordinary')
  await earlier.model.observe(first, employee, 'ordinary')
  expect(earlier.model.current()).toBeNull()
  expect(earlier.model.state.getSnapshot().hidden).toEqual([first])
  expect(earlier.retain).not.toHaveBeenCalled()
  expect((await recorded()).data.entries).toMatchObject([{ sessionId: first, principal: other }])
})

it('retains native resources but stops dependent restoration when a recorded owner is externally replaced', async () => {
  const current = await fixture()
  await current.model.observe(first, employee, 'ordinary')
  const previous = await recorded()
  const replaced = { ...previous, revision: previous.revision + 1,
    data: { entries: [{ sessionId: first, principal: other, kind: 'ordinary' }], ordinary: { [other]: first } } }
  await replaceRecord(replaced)
  await current.model.synchronize(OFFICE_NAVIGATION_SIGNAL_KEY)
  expect(current.model.current()).toBeNull()
  expect(await current.model.restore()).toBe(false)
  expect(current.open).not.toHaveBeenCalled()
  expect(current.create).not.toHaveBeenCalled()
  expect(current.report).toHaveBeenCalled()
  expect(current.released.get(first)).not.toHaveBeenCalled()
  expect(await recorded()).toEqual(replaced)
})

it('ignores storage events after disposal and releases only its own native input reference', async () => {
  const current = await fixture()
  await current.model.observe(first, employee, 'ordinary')
  current.model.dispose()
  const read = vi.spyOn(Storage.prototype, 'getItem')
  onTestFinished(() => { read.mockRestore() })
  await current.model.synchronize(OFFICE_NAVIGATION_SIGNAL_KEY)
  expect(read).not.toHaveBeenCalled()
  expect(current.released.get(first)).toHaveBeenCalledTimes(1)
})

it('creates an unsent ordinary input when the recorded target is missing or archived', async () => {
  const { model, available, create, open } = await fixture()
  await model.observe(first, employee, 'ordinary')
  available.delete(first)
  expect(await model.restore()).toBe(true)
  expect(create).toHaveBeenCalledTimes(1)
  expect(open).not.toHaveBeenCalled()
})

it('fences duplicate and late creation after account changes', async () => {
  const pending = Promise.withResolvers<boolean>()
  const { model, create, report } = await fixture(vi.fn().mockReturnValue(pending.promise))
  const opening = model.restore()
  expect(model.state.getSnapshot().restoring).toBe(true)
  expect(await model.restore()).toBe(false)
  await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
  const signal = create.mock.calls[0]![0]
  await model.bind(other)
  expect(signal.aborted).toBe(true)
  pending.resolve(true)
  expect(await opening).toBe(false)
  expect(model.state.getSnapshot().restoring).toBe(false)
  expect(report).not.toHaveBeenCalled()
})

it('cancels a caller-owned restore without opening or replacing the committed input', async () => {
  const { model, open, create, report, released } = await fixture()
  await model.observe(first, employee, 'ordinary')
  const caller = new AbortController()
  const opened = model.restore(caller.signal)
  caller.abort()
  expect(await opened).toBe(false)
  expect(open).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
  expect(released.get(first)).not.toHaveBeenCalled()
  expect((await recorded()).data.ordinary[employee]).toBe(first)
})

it('propagates caller cancellation through native creation and fences its late completion', async () => {
  const deferred = Promise.withResolvers<boolean>()
  const current = await fixture(vi.fn().mockReturnValue(deferred.promise))
  const caller = new AbortController()
  const opened = current.model.restore(caller.signal)
  await vi.waitFor(() => { expect(current.create).toHaveBeenCalledTimes(1) })
  const signal = current.create.mock.calls[0]![0]
  caller.abort()
  expect(signal.aborted).toBe(true)
  deferred.resolve(true)
  expect(await opened).toBe(false)
  expect(current.model.state.getSnapshot().restoring).toBe(false)
  expect(current.report).not.toHaveBeenCalled()
})

it('reports creation failure and permits a later retry without changing the saved target', async () => {
  const { model, create, report } = await fixture(vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(true))
  expect(await model.restore()).toBe(false)
  expect(report).toHaveBeenCalledTimes(1)
  expect(await model.restore()).toBe(true)
  expect(create).toHaveBeenCalledTimes(2)
  await model.bind(null)
  expect(await model.restore()).toBe(false)
})

it('prepares a cold ordinary input for home without opening or creating a conversation', async () => {
  const original = await fixture()
  await original.model.observe(first, employee, 'ordinary')
  original.model.dispose()
  const restored = await fixture()
  expect(await restored.model.restore(undefined, false)).toBe(true)
  expect(restored.model.state.getSnapshot().ordinary).toMatchObject({ sessionId: first, principal: employee })
  expect(restored.model.ordinaryScope()?.signal.aborted).toBe(false)
  expect(restored.retain).toHaveBeenCalledExactlyOnceWith(first)
  expect(restored.open).not.toHaveBeenCalled()
  expect(restored.create).not.toHaveBeenCalled()
})

it('does not create a home input when no committed ordinary conversation is available', async () => {
  const current = await fixture()
  expect(await current.model.restore(undefined, false)).toBe(false)
  expect(current.model.state.getSnapshot().ordinary).toBeNull()
  expect(current.open).not.toHaveBeenCalled()
  expect(current.create).not.toHaveBeenCalled()
})

it('keeps this window ordinary home input while another window commits a different ordinary return', async () => {
  const firstWindow = await fixture()
  const secondWindow = await fixture()
  await firstWindow.model.observe(first, employee, 'ordinary')
  await secondWindow.model.observe(second, employee, 'ordinary')
  await firstWindow.model.synchronize(OFFICE_NAVIGATION_SIGNAL_KEY)
  expect(firstWindow.model.state.getSnapshot().ordinary?.sessionId).toBe(first)
  expect(await firstWindow.model.restore(undefined, false)).toBe(true)
  expect(firstWindow.model.current()).toBe(first)
  expect(secondWindow.model.state.getSnapshot().ordinary?.sessionId).toBe(second)
})

it('withdraws a home resource on archive or identity loss without erasing its retained native draft', async () => {
  const current = await fixture()
  await current.model.observe(first, employee, 'ordinary')
  const lifetime = current.model.ordinaryScope()!.signal
  current.available.delete(first)
  current.model.catalogChanged()
  expect(current.model.state.getSnapshot().ordinary).toBeNull()
  expect(current.released.get(first)).not.toHaveBeenCalled()
  current.available.add(first)
  current.model.catalogChanged()
  expect(current.model.state.getSnapshot().ordinary?.sessionId).toBe(first)
  await current.model.bind(other)
  expect(lifetime.aborted).toBe(true)
  expect(current.model.ordinaryScope()).toBeUndefined()
  expect(current.released.get(first)).toHaveBeenCalledTimes(1)
})

it.each(['{', '{"entries":[],"ordinary":{"constructor":"missing"}}', '{"entries":[{"principal":"x","sessionId":"s","kind":"invalid"}],"ordinary":{}}'])(
  'keeps malformed saved metadata untouched and visibly refuses dependent restoration: %s', async (saved) => {
    localStorage.setItem('dsh.office.conversations.v1', saved)
    const { model, report, open, create } = await fixture()
    await model.observe(first, employee, 'ordinary')
    expect(await model.restore()).toBe(false)
    expect(report).toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(localStorage.getItem('dsh.office.conversations.v1')).toBe(saved)
  },
)

it('keeps the committed target when notifying other windows fails', async () => {
  const { model, report, open } = await fixture()
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage denied') })
  onTestFinished(() => { write.mockRestore() })
  await model.observe(first, employee, 'ordinary')
  expect(report).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledWith('notification')
  expect(await model.restore()).toBe(true)
  expect(open).toHaveBeenCalledWith(first)
  expect((await recorded()).data.ordinary[employee]).toBe(first)
})

it('serializes simultaneous windows and restores every committed owner after both windows close', async () => {
  const left = await fixture()
  const right = await fixture()
  await right.model.bind(other)
  const leftIds = Array.from({ length: 16 }, (_, index) => `left-${index}` as SessionId)
  const rightIds = Array.from({ length: 16 }, (_, index) => `right-${index}` as SessionId)
  leftIds.forEach(id => left.available.add(id))
  rightIds.forEach(id => right.available.add(id))
  await Promise.all(leftIds.flatMap((id, index) => [
    left.model.observe(id, employee, 'ordinary'), right.model.observe(rightIds[index]!, other, 'ordinary'),
  ]))
  const saved = await recorded()
  expect(saved.revision).toBe(32)
  expect(saved.data.entries).toHaveLength(32)
  expect(saved.data.entries.filter(entry => entry.principal === employee).map(entry => entry.sessionId)).toEqual(leftIds)
  expect(saved.data.entries.filter(entry => entry.principal === other).map(entry => entry.sessionId)).toEqual(rightIds)
  left.model.dispose()
  right.model.dispose()

  const restored = await fixture()
  restored.available.add(leftIds[15]!)
  restored.available.add(rightIds[15]!)
  expect(await restored.model.restore()).toBe(true)
  expect(restored.open).toHaveBeenLastCalledWith(leftIds[15])
  await restored.model.bind(other)
  expect(await restored.model.restore()).toBe(true)
  expect(restored.open).toHaveBeenLastCalledWith(rightIds[15])
})

it('admits exactly one owner when two windows claim the same native input concurrently', async () => {
  const left = await fixture()
  const right = await fixture()
  await right.model.bind(other)
  await Promise.all([left.model.observe(first, employee, 'ordinary'), right.model.observe(first, other, 'ordinary')])
  const saved = await recorded()
  expect(saved.data.entries).toHaveLength(1)
  expect(saved.revision).toBe(1)
  expect(left.retain.mock.calls.length + right.retain.mock.calls.length).toBe(1)
  const winner = saved.data.entries[0]?.principal === employee ? left : right
  const refused = winner === left ? right : left
  expect(winner.model.current()).toBe(first)
  expect(refused.model.current()).toBeNull()
  expect(refused.model.state.getSnapshot().hidden).toEqual([first])
})

it('keeps an aborted write uncommitted and permits an explicit retry without losing the native input', async () => {
  const current = await fixture()
  const put = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementationOnce(() => {
    throw new DOMException('Navigation fixture quota', 'QuotaExceededError')
  })
  onTestFinished(() => { put.mockRestore() })
  await current.model.observe(first, employee, 'ordinary')
  expect((await recorded()).revision).toBe(0)
  expect((await recorded()).data.entries).toEqual([])
  expect(current.retain).not.toHaveBeenCalled()
  expect(current.model.current()).toBeNull()
  expect(current.model.state.getSnapshot().phase).toBe('unavailable')
  expect(current.report).toHaveBeenCalledWith('storage')
  await current.model.synchronize(null)
  await current.model.observe(first, employee, 'ordinary')
  expect(current.model.current()).toBe(first)
  expect((await recorded()).revision).toBe(1)
  expect(current.retain).toHaveBeenCalledTimes(1)
})

it('aborts a dispatched transaction before publishing a different employee identity', async () => {
  const current = await fixture()
  // oxlint-disable-next-line typescript/unbound-method -- the interception below supplies the actual object-store receiver
  const original = FakeObjectStore.prototype.put
  let rebound: Promise<void> | undefined
  const put = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementationOnce(function (this: InstanceType<typeof FakeObjectStore>, value, key) {
    const request = original.call(this, value, key)
    rebound = current.model.bind(other)
    return request
  })
  onTestFinished(() => { put.mockRestore() })
  await current.model.observe(first, employee, 'ordinary')
  expect(rebound).toBeDefined()
  await rebound
  expect((await recorded()).data.entries).toEqual([])
  expect(current.retain).not.toHaveBeenCalled()
  expect(current.report).not.toHaveBeenCalled()
  expect(current.model.current()).toBeNull()
  await current.model.observe(second, other, 'ordinary')
  expect(current.model.current()).toBe(second)
  expect((await recorded()).data.entries).toMatchObject([{ principal: other, sessionId: second }])
})

it('imports the legacy index once and preserves its bytes through subsequent transactional writes', async () => {
  const legacy = JSON.stringify({ entries: [{ sessionId: first, principal: employee, kind: 'ordinary' }],
    ordinary: { [employee]: first } })
  localStorage.setItem('dsh.office.conversations.v1', legacy)
  const current = await fixture()
  expect(await current.model.restore()).toBe(true)
  expect(current.open).toHaveBeenLastCalledWith(first)
  expect((await recorded()).revision).toBe(0)
  await current.model.observe(second, employee, 'ordinary')
  expect(localStorage.getItem('dsh.office.conversations.v1')).toBe(legacy)
  const resumed = await fixture()
  expect(await resumed.model.restore()).toBe(true)
  expect(resumed.open).toHaveBeenLastCalledWith(second)
  expect((await recorded()).data.entries).toHaveLength(2)
})

it('closes the owned connection on a database upgrade and refuses an unsupported version without resetting it', async () => {
  const current = await fixture()
  await current.model.observe(first, employee, 'ordinary')
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(OFFICE_NAVIGATION_DATABASE, 2)
    request.onsuccess = () => { request.result.close(); resolve() }
    request.onerror = () => { reject(new Error('Fixture database upgrade failed', { cause: request.error })) }
  })
  await vi.waitFor(() => { expect(current.model.state.getSnapshot().phase).toBe('unavailable') })
  expect(await current.model.restore()).toBe(false)
  expect(current.released.get(first)).not.toHaveBeenCalled()
  expect(current.report).toHaveBeenCalledWith('storage')
})

it.each([
  { label: 'missing record', value: undefined },
  { label: 'unsupported record version', value: { formatVersion: 2, revision: 2, data: { entries: [], ordinary: {} } } },
  { label: 'invalid generation', value: { formatVersion: 1, revision: -1, data: { entries: [], ordinary: {} } } },
  { label: 'unknown fields', value: { formatVersion: 1, revision: 2, data: { entries: [], ordinary: {} }, extra: true } },
  { label: 'removed recorded owner', value: { formatVersion: 1, revision: 2, data: { entries: [], ordinary: {} } } },
])('keeps $label untouched and retains native resources while refusing restoration', async ({ value }) => {
  const current = await fixture()
  await current.model.observe(first, employee, 'ordinary')
  await replaceRecord(value)
  expect(await current.model.synchronize(null)).toBe(false)
  expect(await current.model.restore()).toBe(false)
  expect(current.model.current()).toBeNull()
  expect(current.open).not.toHaveBeenCalled()
  expect(current.released.get(first)).not.toHaveBeenCalled()
  expect(await storedValue()).toEqual(value)
})
