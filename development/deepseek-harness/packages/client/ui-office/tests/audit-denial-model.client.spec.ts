/** Denial filters and reviewed NDJSON retain only the safe metadata displayed under current administrator authority. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeAuditExport, OfficeAuditPage, OfficeAuditRecord, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeAuditModel } from '../src/client/audit-model.ts'

const admin = { id: 'admin' as OfficeMemberId, role: 'admin' as const, active: true }
const codes: NonNullable<OfficeAuditRecord['denialCode']>[] = ['forbidden', 'not_found', 'conflict', 'invalid_input', 'unauthenticated']
const records: OfficeAuditRecord[] = codes.map((denialCode, index) => ({ source: 'request_denial', revision: index + 1,
  actorId: 'lin' as OfficeMemberId, action: 'saveMember', targetId: 'admin', time: 1000 + index, denialCode }))
const ok = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
function batch(entries: readonly OfficeAuditRecord[]): OfficeAuditExport {
  return { mediaType: 'application/x-ndjson', content: entries.map(entry => JSON.stringify(entry) + '\n').join(''),
    count: entries.length, total: entries.length, next: null }
}
type Api = ConstructorParameters<typeof OfficeAuditModel>[0]
function fixture(entries: readonly OfficeAuditRecord[] = records) {
  const page: OfficeAuditPage = { entries, next: null, total: entries.length }
  const api = { auditPage: vi.fn<Api['auditPage']>().mockResolvedValue(ok(page)),
    auditExport: vi.fn<Api['auditExport']>().mockResolvedValue(ok(batch(entries))) }
  const download = vi.fn()
  const notify = vi.fn()
  const model = new OfficeAuditModel(api, notify, download)
  model.bind(admin)
  return { model, api, download, notify }
}

it('filters request-denial records and downloads their exact safe denial codes', async () => {
  const { model, api, download } = fixture()
  await model.open()
  model.field('source', 'request_denial')
  expect(model.state.getSnapshot().entries).toEqual([])
  await model.search()
  expect(api.auditPage).toHaveBeenLastCalledWith({ source: 'request_denial', limit: 20, before: null })
  expect(model.state.getSnapshot()).toMatchObject({ validation: null, entries: records })
  await model.export()
  expect(api.auditExport).toHaveBeenCalledExactlyOnceWith({ source: 'request_denial', limit: records.length, before: null })
  expect(download).toHaveBeenCalledExactlyOnceWith(batch(records).content)
  expect(model.state.getSnapshot()).toMatchObject({ exporting: false, stale: false })
})

it('refuses missing, changed and additional denial export fields without creating a file', async () => {
  const original = records[0]!
  const { denialCode: _denialCode, ...withoutCode } = original
  for (const changed of [withoutCode, { ...original, denialCode: 'not_found' },
    { ...original, request: { name: 'PRIVATE_REJECTED_BODY' } }, { ...original, secret: 'PRIVATE_CREDENTIAL_VALUE' }]) {
    const { model, api, download, notify } = fixture([original])
    api.auditExport.mockResolvedValue(ok({ ...batch([original]), content: JSON.stringify(changed) + '\n' }))
    await model.open()
    await model.export()
    expect(download).not.toHaveBeenCalled()
    expect(model.state.getSnapshot()).toMatchObject({ exporting: false, stale: true, entries: [original] })
    expect(notify).toHaveBeenCalledWith('auditChanged', false)
  }
})

it('retains six-field legacy records and refuses denial metadata on another audit source', async () => {
  const { denialCode: _denialCode, ...legacyDenial } = records[0]!
  const business: OfficeAuditRecord = { ...legacyDenial, source: 'business', action: 'work_created' }
  const { model, download } = fixture([business, legacyDenial])
  await model.open()
  await model.export()
  expect(download).toHaveBeenCalledExactlyOnceWith(batch([business, legacyDenial]).content)
  const invalid = { ...business, denialCode: 'forbidden' as const }
  const other = fixture([invalid])
  await other.model.open()
  await other.model.export()
  expect(other.download).not.toHaveBeenCalled()
  expect(other.notify).toHaveBeenCalledWith('auditChanged', false)
})

it('withdraws pending denial exports when the employee loses administrator authority', async () => {
  const { model, api, download } = fixture()
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeAuditExport>>>()
  api.auditExport.mockReturnValueOnce(pending.promise)
  await model.open()
  const exporting = model.export()
  model.bind({ ...admin, role: 'employee' })
  pending.resolve(ok(batch(records)))
  await exporting
  await model.open()
  expect(download).not.toHaveBeenCalled()
  expect(api.auditPage).toHaveBeenCalledOnce()
  expect(model.state.getSnapshot()).toMatchObject({ open: false, entries: [], exporting: false })
})
