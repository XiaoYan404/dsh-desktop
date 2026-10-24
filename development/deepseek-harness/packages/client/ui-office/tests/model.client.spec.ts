/** Client projection ordering and failure behavior without transport or React machinery. */
import { describe, expect, it, vi } from 'vitest'
import type { OfficeMemberId, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeModel } from '../src/client/model.ts'

const me = { id: 'local' as OfficeMemberId, name: '本机用户', role: 'employee' as const, active: true, department: '运营', jobTitle: '员工', email: '', phone: '' }
const view: OfficeView = {
  revision: 1, companyName: '我的企业', timeZone: 'Asia/Shanghai', me, members: [me], items: [], notifications: [],
  day: { date: '2026-10-16', items: [], pending: 0, completed: 0, cancelled: 0, work: 0, schedules: 0, completionRate: 0 },
}
const success = (value: OfficeView): RemoteResult<OfficeOutcome<OfficeView>> => ({ ok: true, value: { ok: true, value } })

describe('OfficeModel', () => {
  it('does not publish a late mutation success after a refresh has denied the current session', async () => {
    const remote = { view: vi.fn().mockResolvedValue(success(view)) }
    const model = new OfficeModel(remote)
    await model.load()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeView>>>()
    const writing = model.mutate(() => pending.promise)
    remote.view.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
    await model.load()
    pending.resolve(success(view))
    expect(await writing).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({ view: null, busy: false, error: 'unauthenticated' })
    expect(model.notice.getSnapshot()).toBeNull()
  })

  it('ignores a previous-account mutation after sign-in clears the office identity', async () => {
    const remote = { view: vi.fn().mockResolvedValue(success(view)) }
    const model = new OfficeModel(remote)
    await model.load()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeView>>>()
    const writing = model.mutate(() => pending.promise)
    model.clear()
    pending.resolve(success(view))
    expect(await writing).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({ view: null, busy: false })
    expect(model.notice.getSnapshot()).toBeNull()
  })

  it('clears dependent private caches and fences an earlier read when a mutation loses authentication', async () => {
    const remote = { view: vi.fn().mockResolvedValue(success(view)) }
    const bind = vi.fn<(principal: OfficeMemberId | null) => void>()
    const model = new OfficeModel(remote, bind)
    await model.load()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeView>>>()
    remote.view.mockReturnValueOnce(pending.promise)
    const reading = model.load()
    expect(await model.mutate(async () => ({ ok: true, value: { ok: false, code: 'unauthenticated' } }))).toBe(false)
    pending.resolve(success(view))
    await reading
    expect(bind).toHaveBeenLastCalledWith(null)
    expect(model.state.getSnapshot()).toMatchObject({ view: null, busy: false, error: 'unauthenticated' })
  })

  it('binds dependent private caches before publishing a different employee and clears them on denial', async () => {
    const other = { ...view, me: { ...me, id: 'other' as OfficeMemberId } }
    const remote = { view: vi.fn().mockResolvedValueOnce(success(view)).mockResolvedValueOnce(success(view)).mockResolvedValueOnce(success(other)).mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } }) }
    const bind = vi.fn<(principal: OfficeMemberId | null) => void>()
    const model = new OfficeModel(remote, bind)
    await model.load()
    await model.load()
    await model.load()
    await model.load()
    expect(bind.mock.calls.map(([id]) => id)).toEqual([me.id, other.me.id, null])
    expect(model.state.getSnapshot().view).toBeNull()
  })

  it('ignores an older date response after a later navigation has committed', async () => {
    const first = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeView>>>()
    const remote = { view: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(success({ ...view, revision: 2 })) }
    const model = new OfficeModel(remote)
    const slow = model.load('2026-10-15')
    await model.load('2026-10-16')
    first.resolve(success({ ...view, revision: 1 }))
    await slow
    expect(model.state.getSnapshot().view?.revision).toBe(2)
  })

  it('retains confirmed data on a connection error but clears it after membership is denied', async () => {
    const remote = { view: vi.fn().mockResolvedValueOnce(success(view)).mockRejectedValueOnce(new Error('Lost connection')).mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } }) }
    const model = new OfficeModel(remote)
    await model.load()
    await model.load()
    expect(model.state.getSnapshot()).toMatchObject({ view, error: 'unavailable' })
    await model.load()
    expect(model.state.getSnapshot()).toMatchObject({ view: null, error: 'forbidden' })
  })

  it('does not report success or change records when a mutation is rejected', async () => {
    const model = new OfficeModel({ view: vi.fn().mockResolvedValue(success(view)) })
    await model.load()
    const confirmed = model.state.getSnapshot().view
    expect(await model.mutate(async () => ({ ok: true, value: { ok: false, code: 'conflict' } }))).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({ view: confirmed, busy: false })
    expect(model.notice.getSnapshot()).toMatchObject({ key: 'conflict', success: false })
  })

  it('admits one save at a time and refreshes after its confirmed commit', async () => {
    const committed = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeView>>>()
    const remote = { view: vi.fn().mockResolvedValueOnce(success(view)).mockResolvedValueOnce(success({ ...view, revision: 2 })) }
    const model = new OfficeModel(remote)
    await model.load()
    const first = model.mutate(() => committed.promise)
    const duplicate = vi.fn(async () => success(view))
    expect(await model.mutate(duplicate)).toBe(false)
    expect(duplicate).not.toHaveBeenCalled()
    committed.resolve(success(view))
    expect(await first).toBe(true)
    expect(model.state.getSnapshot()).toMatchObject({ busy: false, view: { revision: 2 } })
    expect(model.notice.getSnapshot()).toMatchObject({ key: 'saved', success: true })
  })

  it('discards a late read after disposal and lets Today clear a selected date', async () => {
    const waiting = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeView>>>()
    const remote = { view: vi.fn().mockResolvedValueOnce(success(view)).mockReturnValueOnce(waiting.promise) }
    const model = new OfficeModel(remote)
    await model.load('2026-10-15')
    const pending = model.load(null)
    expect(remote.view).toHaveBeenLastCalledWith(undefined)
    model.dispose()
    const last = model.state.getSnapshot()
    waiting.resolve(success({ ...view, revision: 2 }))
    await pending
    expect(model.state.getSnapshot()).toBe(last)
  })
})
