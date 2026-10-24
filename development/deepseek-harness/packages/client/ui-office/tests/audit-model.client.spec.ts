/** Administrator pages and downloads reject late publication after account, role, form and lifetime changes. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeAuditCursor, OfficeAuditExport, OfficeAuditPage, OfficeAuditRecord,
  OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeAuditModel } from '../src/client/audit-model.ts'

const admin = { id: 'admin' as OfficeMemberId, role: 'admin' as const, active: true }
const ok = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const record = (revision: number): OfficeAuditRecord => ({ source: 'business', revision,
  actorId: admin.id, action: 'work_created', targetId: `work-${revision}`, time: 1000 + revision })
const cursor = (entry: OfficeAuditRecord): OfficeAuditCursor => ({ source: entry.source, revision: entry.revision, time: entry.time })
const rows = Array.from({ length: 25 }, (_, index) => record(25 - index))
const page: OfficeAuditPage = { entries: rows.slice(0, 20), next: cursor(rows[19]!), total: rows.length }
function batch(entries: readonly OfficeAuditRecord[], next: OfficeAuditCursor | null = null): OfficeAuditExport {
  return { mediaType: 'application/x-ndjson', content: entries.map(entry => JSON.stringify(entry) + '\n').join(''),
    count: entries.length, total: entries.length, next }
}
type Api = ConstructorParameters<typeof OfficeAuditModel>[0]
function fixture() {
  const api = { auditPage: vi.fn<Api['auditPage']>().mockResolvedValue(ok(page)),
    auditExport: vi.fn<Api['auditExport']>().mockResolvedValue(ok(batch(page.entries))) }
  const notify = vi.fn()
  const download = vi.fn()
  const model = new OfficeAuditModel(api, notify, download)
  model.bind(admin)
  return { model, api, notify, download }
}

it('requires an explicit administrator entry and only loads another page after a load-more gesture', async () => {
  const { model, api } = fixture()
  expect(api.auditPage).not.toHaveBeenCalled()
  model.bind({ ...admin, role: 'employee' })
  await model.open()
  expect(api.auditPage).not.toHaveBeenCalled()
  model.bind(admin)
  await model.open()
  expect(api.auditPage).toHaveBeenLastCalledWith({ limit: 20, before: null })
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeAuditPage>>>()
  api.auditPage.mockReturnValueOnce(pending.promise)
  const more = model.more()
  await model.more()
  expect(api.auditPage).toHaveBeenCalledTimes(2)
  expect(model.state.getSnapshot().entries).toEqual(page.entries)
  pending.resolve(ok({ entries: rows.slice(20), next: null, total: rows.length }))
  await more
  expect(api.auditPage).toHaveBeenLastCalledWith({ limit: 20, before: page.next })
  expect(model.state.getSnapshot().entries).toEqual(rows)
  await model.more()
  expect(api.auditPage).toHaveBeenCalledTimes(2)
})

it('applies exact filters and local inclusive time values, clearing previous results as soon as the form changes', async () => {
  const { model, api } = fixture()
  await model.open()
  model.field('source', 'identity')
  expect(model.state.getSnapshot()).toMatchObject({ entries: [], applied: null, total: 0 })
  model.field('actorId', ' admin ')
  model.field('targetId', ' target ')
  model.field('action', ' signed_in ')
  model.field('since', '2026-10-18T09:00')
  model.field('until', '2026-10-18T10:00')
  api.auditPage.mockResolvedValueOnce(ok({ entries: [], next: null, total: 0 }))
  await model.search()
  expect(api.auditPage).toHaveBeenLastCalledWith({ limit: 20, before: null, source: 'identity', actorId: admin.id,
    targetId: 'target', action: 'signed_in', since: new Date('2026-10-18T09:00').getTime(),
    until: new Date('2026-10-18T10:00').getTime() })
  expect(model.state.getSnapshot()).toMatchObject({ entries: [], loading: false, error: null })
  model.field('until', '2026-10-18T08:00')
  await model.search()
  expect(api.auditPage).toHaveBeenCalledTimes(2)
  expect(model.state.getSnapshot().validation).toBe('auditInvalidFilters')
})

it('keeps shown rows after a failed older-page query and retries the same position explicitly', async () => {
  const { model, api } = fixture()
  await model.open()
  api.auditPage.mockRejectedValueOnce(new Error('Query offline'))
  await model.more()
  expect(model.state.getSnapshot()).toMatchObject({ entries: page.entries, next: page.next, loading: false, error: 'unavailable' })
  api.auditPage.mockResolvedValueOnce(ok({ entries: rows.slice(20), next: null, total: rows.length }))
  await model.more()
  expect(model.state.getSnapshot()).toMatchObject({ entries: rows, error: null })
})

it.each(['account', 'role', 'inactive', 'sign-out', 'close', 'filter', 'dispose'] as const)(
  'discards a pending query after %s changes', async (change) => {
    const { model, api } = fixture()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeAuditPage>>>()
    api.auditPage.mockReturnValueOnce(pending.promise)
    const loading = model.open()
    changeScope(model, change)
    pending.resolve(ok(page))
    await loading
    expect(model.state.getSnapshot().entries).toEqual([])
    expect(model.state.getSnapshot().loading).toBe(false)
  },
)

it.each(['account', 'role', 'inactive', 'sign-out', 'close', 'filter', 'dispose'] as const)(
  'discards a pending export after %s changes without creating a file or toast', async (change) => {
    const { model, api, download, notify } = fixture()
    await model.open()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeAuditExport>>>()
    api.auditExport.mockReturnValueOnce(pending.promise)
    const exporting = model.export()
    changeScope(model, change)
    pending.resolve(ok(batch(page.entries)))
    await exporting
    expect(download).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(model.state.getSnapshot().entries).toEqual([])
  },
)

it('reauthorizes multiple export batches and downloads every displayed row exactly once after all batches succeed', async () => {
  const { model, api, download, notify } = fixture()
  const all = Array.from({ length: 120 }, (_, index) => record(120 - index))
  api.auditPage.mockImplementation(async (query) => {
    const start = query.before ? all.findIndex(entry => entry.revision === query.before?.revision) + 1 : 0
    const entries = all.slice(start, start + 20)
    return ok({ entries, total: all.length, next: start + 20 < all.length ? cursor(entries.at(-1)!) : null })
  })
  api.auditExport.mockResolvedValueOnce(ok(batch(all.slice(0, 100), cursor(all[99]!))))
    .mockResolvedValueOnce(ok(batch(all.slice(100))))
  await model.open()
  while (model.state.getSnapshot().next) await model.more()
  await model.export()
  expect(api.auditExport).toHaveBeenNthCalledWith(1, { limit: 100, before: null })
  expect(api.auditExport).toHaveBeenNthCalledWith(2, { limit: 20, before: cursor(all[99]!) })
  expect(download).toHaveBeenCalledExactlyOnceWith(batch(all).content)
  expect(notify).toHaveBeenCalledExactlyOnceWith('auditDownloadStarted', true)
  expect(model.state.getSnapshot().exporting).toBe(false)
})

it.each(['changed', 'extra-field', 'malformed', 'partial'] as const)(
  'withholds the entire download when the export is %s and requires a fresh search', async (kind) => {
    const { model, api, download } = fixture()
    await model.open()
    const exported = { ...batch(page.entries) }
    if (kind === 'changed') exported.content = batch([record(99), ...page.entries.slice(1)]).content
    if (kind === 'extra-field') exported.content = JSON.stringify({ ...page.entries[0], token: 'private-test-value' }) + '\n' +
      batch(page.entries.slice(1)).content
    if (kind === 'malformed') exported.content = 'not-json\n'
    if (kind === 'partial') exported.count--
    api.auditExport.mockResolvedValueOnce(ok(exported))
    await model.export()
    expect(download).not.toHaveBeenCalled()
    expect(model.state.getSnapshot()).toMatchObject({ entries: page.entries, exporting: false, stale: true })
    await model.export()
    expect(api.auditExport).toHaveBeenCalledTimes(1)
    await model.search()
    expect(model.state.getSnapshot().stale).toBe(false)
  },
)

it.each(['auditPage', 'auditExport'] as const)('clears private rows after a fresh %s authorization denial', async (method) => {
  const { model, api, download, notify } = fixture()
  await model.open()
  if (method === 'auditPage') {
    api.auditPage.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
    await model.more()
  } else {
    api.auditExport.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
    await model.export()
  }
  expect(model.state.getSnapshot()).toMatchObject({ open: false, entries: [], filters: { actorId: '' } })
  expect(download).not.toHaveBeenCalled()
  expect(notify).toHaveBeenCalledWith(method === 'auditPage' ? 'forbidden' : 'unauthenticated', false)
})

it('retains displayed rows after an export request failure and permits an explicit unchanged retry', async () => {
  const { model, api, download, notify } = fixture()
  await model.open()
  api.auditExport.mockRejectedValueOnce(new Error('Export request offline'))
  await model.export()
  expect(download).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ entries: page.entries, exporting: false, stale: false })
  expect(notify).toHaveBeenCalledWith('unavailable', false)
  await model.export()
  expect(download).toHaveBeenCalledExactlyOnceWith(batch(page.entries).content)
})

function changeScope(model: OfficeAuditModel, change: 'account' | 'role' | 'inactive' | 'sign-out' | 'close' | 'filter' | 'dispose') {
  if (change === 'account') model.bind({ ...admin, id: 'other' as OfficeMemberId })
  if (change === 'role') model.bind({ ...admin, role: 'employee' })
  if (change === 'inactive') model.bind({ ...admin, active: false })
  if (change === 'sign-out') model.bind(null)
  if (change === 'close') model.close()
  if (change === 'filter') model.field('action', 'signed_in')
  if (change === 'dispose') model.dispose()
}
