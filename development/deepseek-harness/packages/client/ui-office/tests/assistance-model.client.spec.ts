/** Item opens recheck the real office response and fence earlier employee/navigation lifetimes. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { OfficeItem, OfficeItemId, OfficeMemberId, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeAssistanceModel } from '../src/client/assistance-model.ts'

const employee = 'employee' as OfficeMemberId
const item: OfficeItem = {
  id: 'item-a' as OfficeItemId, kind: 'task', title: 'Fresh task', description: 'Actual office description',
  date: '2026-10-16', time: '09:00', location: '', status: 'pending', creatorId: employee, ownerId: employee,
  participants: [], revision: 1, createdAt: 1, updatedAt: 1,
}
const view: OfficeView = {
  revision: 1, companyName: 'Test office', timeZone: 'Asia/Shanghai',
  me: { id: employee, name: 'Employee', role: 'employee', active: true, department: '', jobTitle: '', email: '', phone: '' },
  members: [], items: [item], notifications: [],
  day: { date: '2026-10-16', items: [item], pending: 1, completed: 0, cancelled: 0, work: 1, schedules: 0, completionRate: 0 },
}
const success = (value: OfficeView): RemoteResult<OfficeOutcome<OfficeView>> => ({ ok: true, value: { ok: true, value } })

function fixture() {
  const remote = { view: vi.fn<() => Promise<RemoteResult<OfficeOutcome<OfficeView>>>>().mockResolvedValue(success(view)) }
  const open = vi.fn<ConstructorParameters<typeof OfficeAssistanceModel>[2]>().mockResolvedValue('native-a' as SessionId)
  const report = vi.fn()
  const releases: ReturnType<typeof vi.fn>[] = []
  const retain = vi.fn(() => { const release = vi.fn(); releases.push(release); return release })
  const model = new OfficeAssistanceModel(remote, () => view, open, key => key, report, retain)
  model.bind(employee)
  onTestFinished(() => { model.dispose() })
  return { model, remote, open, report, retain, releases }
}

it('prepares fresh authorized context once per open and retains one native input owner per Session', async () => {
  const { model, remote, open, retain, releases } = fixture()
  remote.view.mockResolvedValueOnce(success({ ...view, items: [{ ...item, title: 'Updated on Host' }] }))
  expect(await model.open(item.id, 'work')).toBe(true)
  expect(open.mock.calls[0]?.[0]).toBe(JSON.stringify(['office.item.v1', employee, item.id]))
  expect(open.mock.calls[0]?.[1]).toContain('Updated on Host')
  expect(model.state.getSnapshot().contexts['native-a']).toMatchObject({ source: 'work', date: view.day.date })
  expect(await model.open(item.id, 'calendar')).toBe(true)
  expect(retain).toHaveBeenCalledTimes(1)
  model.bind('another' as OfficeMemberId)
  expect(releases[0]).toHaveBeenCalledOnce()
  expect(model.state.getSnapshot()).toEqual({ openingId: null, contexts: {} })
})

it.each(['transport', 'denied', 'hidden', 'identity'] as const)('does not open stale/unauthorized context: %s', async (kind) => {
  const { model, remote, open, report } = fixture()
  if (kind === 'transport') remote.view.mockRejectedValueOnce(new Error('Expected transport failure'))
  if (kind === 'denied') remote.view.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
  if (kind === 'hidden') remote.view.mockResolvedValueOnce(success({ ...view, items: [] }))
  if (kind === 'identity') remote.view.mockResolvedValueOnce(success({ ...view, me: { ...view.me, id: 'different' as OfficeMemberId } }))
  expect(await model.open(item.id, 'work')).toBe(false)
  expect(open).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledOnce()
  expect(model.state.getSnapshot().openingId).toBeNull()
})

it('ignores a late office read after account replacement and prevents duplicate opens', async () => {
  const { model, remote, open, report } = fixture()
  const gate = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeView>>>()
  remote.view.mockReturnValueOnce(gate.promise)
  const opening = model.open(item.id, 'work')
  expect(await model.open(item.id, 'work')).toBe(false)
  model.bind('different' as OfficeMemberId)
  gate.resolve(success(view))
  expect(await opening).toBe(false)
  expect(open).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
})

it('cancels pending native acquisition without retaining it or publishing a late context', async () => {
  const { model, open, report, retain } = fixture()
  const gate = Promise.withResolvers<SessionId | undefined>()
  open.mockReturnValueOnce(gate.promise)
  const opening = model.open(item.id, 'calendar')
  await vi.waitFor(() => { expect(open).toHaveBeenCalledOnce() })
  model.cancel()
  expect(open.mock.calls[0]?.[2].aborted).toBe(true)
  gate.resolve('late-session' as SessionId)
  expect(await opening).toBe(false)
  expect(model.state.getSnapshot()).toEqual({ openingId: null, contexts: {} })
  expect(retain).not.toHaveBeenCalled()
  expect(report).not.toHaveBeenCalled()
  expect(await model.open(item.id, 'work')).toBe(true)
})

it('releases all visited native inputs on unload and ignores subsequent calls', async () => {
  const { model, open, releases } = fixture()
  await model.open(item.id, 'work')
  open.mockResolvedValueOnce('native-b' as SessionId)
  await model.open(item.id, 'calendar')
  model.dispose()
  expect(releases).toHaveLength(2)
  for (const release of releases) expect(release).toHaveBeenCalledOnce()
  expect(await model.open(item.id, 'work')).toBe(false)
})
