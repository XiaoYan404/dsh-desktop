/** Search result bounds, exact destinations and cancellation across employee, role and query replacement. */
import { expect, it, vi } from 'vitest'
import type { OfficeDriveId, OfficeItemId, OfficeMemberId, OfficeMember, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { OfficeSearchModel } from '../src/client/search-model.ts'
import type { OfficeSearchData } from '../src/client/search-model.ts'

const me: OfficeMember = { id: 'lin' as OfficeMemberId, name: 'Needle Lin', department: 'Operations', jobTitle: 'Employee',
  email: '', phone: '', role: 'employee', active: true }
const sessionId = 'search-conversation' as SessionId
const itemId = 'e8dbb552-87a4-418f-8945-161a5bb354ad' as OfficeItemId
const fileId = '7573e8f7-3b1e-40ca-a085-aa1b008594d9' as OfficeDriveId
function data(): OfficeSearchData {
  const view: OfficeView = { revision: 1, companyName: 'Office', timeZone: 'Asia/Shanghai', me, members: [me],
    items: [{ id: itemId, kind: 'task', title: 'Needle task', description: '', date: '2026-10-15', location: '', status: 'pending',
      creatorId: me.id, ownerId: me.id, participants: [], revision: 1, createdAt: 1, updatedAt: 1 }],
    notifications: [], day: { date: '2026-10-15', items: [], work: 1, pending: 1, completed: 0, cancelled: 0,
      schedules: 0, completionRate: 0 } }
  return { view, sessionId, failures: [],
    files: [{ id: fileId, parentId: null, space: 'private', ownerId: me.id, kind: 'file', name: 'Needle file.txt',
      revision: 1, createdAt: 1, updatedAt: 1, byteLength: 5, mediaType: 'text/plain', access: 'edit',
      canRename: true, canManageAccess: false }],
    skills: [{ name: 'needle-skill', description: 'Current Conversation skill', modelInvocable: true }],
  }
}
function fixture() {
  const lookup = vi.fn<ConstructorParameters<typeof OfficeSearchModel>[0]>().mockImplementation(async () => data())
  const navigate = vi.fn<ConstructorParameters<typeof OfficeSearchModel>[1]>().mockResolvedValue(true)
  const model = new OfficeSearchModel(lookup, navigate)
  model.bind(me)
  model.open([{ section: 'tools', title: 'Needle tools' }, { section: 'home', title: 'Workbench' }])
  return { model, lookup, navigate }
}

it('finds all five categories without creating a Conversation and hands the exact selection to its owner once', async () => {
  const { model, lookup, navigate } = fixture()
  expect(model.state.getSnapshot().results.map(entry => entry.kind)).toEqual(['page', 'page'])
  expect(lookup).not.toHaveBeenCalled()
  await model.query('  NEEDLE  ')
  expect(model.state.getSnapshot().results.map(entry => entry.kind)).toEqual(['page', 'member', 'item', 'file', 'skill'])
  expect(lookup.mock.calls[0]?.[0]).toBe('NEEDLE')
  expect(await model.select(`item:${itemId}`)).toBe(true)
  expect(navigate.mock.calls[0]?.[0]).toMatchObject({ kind: 'item', item: { id: itemId } })
  expect(model.state.getSnapshot()).toMatchObject({ open: false, query: '', results: [], target: { key: `item:${itemId}` } })
  model.consume('a different result')
  expect(model.state.getSnapshot().target?.key).toBe(`item:${itemId}`)
  model.consume(`item:${itemId}`)
  expect(model.state.getSnapshot().target).toBeNull()
  model.dispose()
})

it('bounds each category and exposes partial failures, unavailable catalogs and invalid queries without stale metadata', async () => {
  const { model, lookup } = fixture()
  const value = data()
  lookup.mockResolvedValueOnce({ ...value, failures: ['searchSharedUnavailable'],
    view: { ...value.view, members: Array.from({ length: 45 }, (_, index) => ({ ...me, id: `${index}` as OfficeMemberId })),
      items: Array.from({ length: 45 }, (_, index) => ({ ...value.view.items[0]!, id: `${index}` as OfficeItemId })) },
    files: Array.from({ length: 45 }, (_, index) => ({ ...value.files[0]!, id: `${index}` as OfficeDriveId })),
    skills: Array.from({ length: 45 }, (_, index) => ({ ...value.skills[0]!, name: `needle-${index}` })),
  })
  await model.query('needle')
  expect(model.state.getSnapshot()).toMatchObject({ limited: true, failures: ['searchSharedUnavailable'], loading: false })
  expect(model.state.getSnapshot().results).toHaveLength(81)
  lookup.mockRejectedValueOnce(new Error('Gateway offline'))
  await model.query('file')
  expect(model.state.getSnapshot()).toMatchObject({ results: [], failures: ['unavailable'], loading: false })
  const calls = lookup.mock.calls.length
  await model.query('x'.repeat(201))
  expect(lookup).toHaveBeenCalledTimes(calls)
  expect(model.state.getSnapshot().failures).toEqual(['invalid_input'])
  await model.query('')
  expect(model.state.getSnapshot().results.every(entry => entry.kind === 'page')).toBe(true)
  model.dispose()
})

it('discards older queries and every late result after a close, employee change or role change', async () => {
  const { model, lookup } = fixture()
  const previous = Promise.withResolvers<OfficeSearchData>()
  lookup.mockImplementationOnce(() => previous.promise)
  const pending = model.query('old')
  const oldSignal = lookup.mock.calls[0]![1]
  await model.query('needle')
  previous.resolve({ ...data(), view: { ...data().view, members: [{ ...me, name: 'Old private member' }] } })
  await pending
  expect(oldSignal.aborted).toBe(true)
  expect(model.state.getSnapshot().query).toBe('needle')
  expect(model.state.getSnapshot().results.some(entry => entry.title === 'Old private member')).toBe(false)
  for (const change of ['close', 'employee', 'role'] as const) {
    model.bind(me)
    model.open([])
    const response = Promise.withResolvers<OfficeSearchData>()
    lookup.mockImplementationOnce(() => response.promise)
    const current = model.query('needle')
    if (change === 'close') model.close()
    else model.bind(change === 'employee' ? { ...me, id: 'chen' as OfficeMemberId } : { ...me, role: 'manager' })
    response.resolve(data())
    await current
    expect(model.state.getSnapshot()).toMatchObject({ open: false, results: [], target: null })
  }
  model.dispose()
})

it('removes a denied destination and suppresses a late navigation target after cancellation or disposal', async () => {
  const { model, navigate } = fixture()
  await model.query('needle')
  navigate.mockResolvedValueOnce(false)
  expect(await model.select(`file:${fileId}`)).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ open: true, failures: ['searchDestinationUnavailable'] })
  expect(model.state.getSnapshot().results.some(entry => entry.key === `file:${fileId}`)).toBe(false)
  const response = Promise.withResolvers<boolean>()
  navigate.mockImplementationOnce(() => response.promise)
  const pending = model.select(`member:${me.id}`)
  const signal = navigate.mock.calls[1]![1]
  model.close()
  response.resolve(true)
  expect(await pending).toBe(false)
  expect(signal.aborted).toBe(true)
  expect(model.state.getSnapshot().target).toBeNull()
  model.dispose()
  model.open([{ section: 'home', title: 'Workbench' }])
  await model.query('needle')
  expect(model.state.getSnapshot().open).toBe(false)
})
