// @vitest-environment jsdom
/** Startup entry is an employee-scoped intent, never a guess from an empty catalog. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeNavigationModel } from '../src/client/navigation-model.ts'

const employee = 'employee' as OfficeMemberId
const other = 'other' as OfficeMemberId

function fixture(open = vi.fn<(id: OfficeMemberId | null, signal: AbortSignal) => Promise<boolean>>().mockResolvedValue(true)) {
  const report = vi.fn()
  const model = new OfficeNavigationModel(open, report)
  onTestFinished(() => { model.dispose() })
  return { model, open, report }
}

it('waits for the first confirmed employee and both native catalogs before opening once', async () => {
  const { model, open } = fixture()
  const opened = model.open()
  expect(model.state.getSnapshot().waiting).toBe(true)
  expect(open).not.toHaveBeenCalled()
  model.configure({ employee, sessionsReady: false, workspacesReady: false })
  model.configure({ employee, sessionsReady: true, workspacesReady: false })
  expect(open).not.toHaveBeenCalled()
  model.configure({ employee, sessionsReady: true, workspacesReady: true })
  expect(await opened).toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(employee, expect.any(AbortSignal))
  expect(model.state.getSnapshot().waiting).toBe(false)
})

it('cancels a waiting click when the employee opens another panel and admits a fresh retry', async () => {
  const { model, open } = fixture()
  const opened = model.open()
  model.cancel()
  model.configure({ employee, sessionsReady: true, workspacesReady: true })
  expect(await opened).toBe(false)
  expect(open).not.toHaveBeenCalled()
  expect(await model.open()).toBe(true)
  expect(open).toHaveBeenCalledTimes(1)
})

it.each([other, null, undefined])('cancels a known employee intent after identity changes to %s', async (next) => {
  const { model, open, report } = fixture()
  model.configure({ employee, sessionsReady: false, workspacesReady: true })
  const opened = model.open()
  model.configure({ employee: next, sessionsReady: true, workspacesReady: true })
  expect(await opened).toBe(false)
  expect(open).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
})

it('retains a first confirmed identity while its native catalogs are still loading', async () => {
  const { model, open } = fixture()
  const opened = model.open()
  model.configure({ employee, sessionsReady: false, workspacesReady: false })
  model.configure({ employee: other, sessionsReady: true, workspacesReady: true })
  expect(await opened).toBe(false)
  expect(open).not.toHaveBeenCalled()
})

it('preserves a confirmed signed-out native entry without waiting for office catalogs', async () => {
  const { model, open } = fixture()
  const opened = model.open()
  model.configure({ employee: null, sessionsReady: false, workspacesReady: false })
  expect(await opened).toBe(true)
  expect(open).toHaveBeenCalledExactlyOnceWith(null, expect.any(AbortSignal))
})

it('does not duplicate a pending restore and aborts its signal on caller cancellation', async () => {
  const deferred = Promise.withResolvers<boolean>()
  const { model, open, report } = fixture(vi.fn().mockReturnValue(deferred.promise))
  model.configure({ employee, sessionsReady: true, workspacesReady: true })
  const owner = new AbortController()
  const opened = model.open(owner.signal)
  expect(await model.open()).toBe(false)
  const signal = open.mock.calls[0]![1]
  owner.abort()
  expect(signal.aborted).toBe(true)
  expect(await opened).toBe(false)
  deferred.resolve(true)
  await deferred.promise
  expect(model.state.getSnapshot().waiting).toBe(false)
  expect(report).not.toHaveBeenCalled()
})

it('reports a current restore error and permits an explicit retry', async () => {
  const { model, open, report } = fixture()
  model.configure({ employee, sessionsReady: true, workspacesReady: true })
  open.mockRejectedValueOnce(new Error('fixture restore failure'))
  expect(await model.open()).toBe(false)
  expect(report).toHaveBeenCalledTimes(1)
  expect(await model.open()).toBe(true)
})

it('releases a waiting request at disposal and ignores later readiness', async () => {
  const { model, open } = fixture()
  const opened = model.open()
  model.dispose()
  model.configure({ employee, sessionsReady: true, workspacesReady: true })
  expect(await opened).toBe(false)
  expect(await model.open()).toBe(false)
  expect(open).not.toHaveBeenCalled()
})

it('cancels a panel change while waiting but permits the prepared entry to reveal its own panel', async () => {
  const deferred = Promise.withResolvers<boolean>()
  const { model, open } = fixture(vi.fn().mockReturnValue(deferred.promise))
  const waiting = model.open()
  model.cancelWaiting()
  expect(await waiting).toBe(false)
  expect(open).not.toHaveBeenCalled()
  model.configure({ employee, sessionsReady: true, workspacesReady: true })
  const opening = model.open()
  model.cancelWaiting()
  expect(open.mock.calls[0]![1].aborted).toBe(false)
  deferred.resolve(true)
  expect(await opening).toBe(true)
})
