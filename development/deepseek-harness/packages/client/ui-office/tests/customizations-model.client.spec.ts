/** Saved versions, uncertain acknowledgements and private exports share the employee lifetime. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeCustomizationId, OfficeCustomizationRecord, OfficeCustomizationSaveReceipt,
  OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeCustomizationsModel } from '../src/client/customizations-model.ts'

const member = { id: 'lin' as OfficeMemberId, role: 'employee' as const }
const record: OfficeCustomizationRecord = { id: 'b70b1dc5-98e6-48a3-978e-5b07ae85f324' as OfficeCustomizationId,
  ownerId: member.id, revision: 1, target: 'OA', contact: 'Lin', requirements: '审批\n保留日程',
  companyName: 'Company', createdAt: 1, updatedAt: 1, delivery: 'not_sent' }
const ok = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
function fixture() {
  type Api = ConstructorParameters<typeof OfficeCustomizationsModel>[0]
  const api = { customizationRequests: vi.fn<Api['customizationRequests']>().mockResolvedValue(ok({ meId: member.id, entries: [], next: null })),
    customizationRequest: vi.fn<Api['customizationRequest']>().mockResolvedValue(ok(record)),
    saveCustomizationRequest: vi.fn<Api['saveCustomizationRequest']>().mockResolvedValue(ok({ meId: member.id, record, currentRevision: 1 })) }
  const notify = vi.fn()
  const deliver = vi.fn()
  const model = new OfficeCustomizationsModel(api, notify, deliver)
  model.bind(member)
  return { model, api, notify, deliver }
}
function create(model: OfficeCustomizationsModel) {
  model.create('OA', 'Lin')
  model.field('requirements', record.requirements)
}

it('keeps cancelled forms unwritten, freezes uncertain input, and retries the original save UUID before exporting saved bytes', async () => {
  const { model, api, deliver } = fixture()
  create(model)
  model.close()
  expect(api.saveCustomizationRequest).not.toHaveBeenCalled()
  create(model)
  const input = model.state.getSnapshot().draft!
  api.saveCustomizationRequest.mockRejectedValueOnce(new Error('Acknowledgement lost'))
  await model.save()
  expect(model.state.getSnapshot()).toMatchObject({ uncertain: true, saved: null })
  model.field('requirements', 'Unsafe change during retry')
  await model.export()
  expect(deliver).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().draft).toEqual(input)
  await model.save()
  expect(api.saveCustomizationRequest.mock.calls).toEqual([[input], [input]])
  expect(model.state.getSnapshot()).toMatchObject({ uncertain: false, saved: record })
  await model.export()
  expect(deliver).toHaveBeenCalledExactlyOnceWith(record)
  model.field('requirements', 'Unsaved changes')
  await model.export()
  expect(deliver).toHaveBeenCalledTimes(1)
})

it('requires explicit adoption of a newer version after a conflict or original receipt replay', async () => {
  const { model, api, deliver } = fixture()
  await model.edit(record.id)
  model.field('requirements', 'My change')
  api.saveCustomizationRequest.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'conflict' } })
  await model.save()
  expect(model.state.getSnapshot()).toMatchObject({ stale: true, draft: { requirements: 'My change' } })
  model.field('requirements', 'Overwrite')
  await model.save()
  expect(api.saveCustomizationRequest).toHaveBeenCalledTimes(1)
  const newer = { ...record, revision: 3, requirements: 'Other window' }
  api.customizationRequest.mockResolvedValue(ok(newer))
  await model.edit(record.id)
  expect(model.state.getSnapshot()).toMatchObject({ stale: false, saved: newer })
  api.customizationRequest.mockResolvedValueOnce(ok({ ...newer, revision: 4 }))
  await model.export()
  expect(deliver).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ stale: true, saved: newer })
  create(model)
  api.saveCustomizationRequest.mockResolvedValueOnce(ok({ meId: member.id, record, currentRevision: 3 }))
  await model.save()
  expect(model.state.getSnapshot()).toMatchObject({ stale: true, saved: record })
})

it.each(['account', 'role', 'close', 'dispose'] as const)('withdraws pending private downloads after %s changes', async (kind) => {
  const { model, api, deliver } = fixture()
  await model.edit(record.id)
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeCustomizationRecord>>>()
  api.customizationRequest.mockReturnValueOnce(pending.promise)
  const download = model.export()
  if (kind === 'account') model.bind({ ...member, id: 'other' as OfficeMemberId })
  if (kind === 'role') model.bind({ ...member, role: 'manager' })
  if (kind === 'close') model.close()
  if (kind === 'dispose') model.dispose()
  pending.resolve(ok(record))
  await download
  expect(deliver).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ open: false, draft: null, saved: null, entries: [] })
})

it('ignores a late save acknowledgement after closing and reloads only the current private metadata', async () => {
  const { model, api } = fixture()
  create(model)
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeCustomizationSaveReceipt>>>()
  api.saveCustomizationRequest.mockReturnValueOnce(pending.promise)
  const save = model.save()
  model.close()
  pending.resolve(ok({ meId: member.id, record, currentRevision: 1 }))
  await save
  expect(model.state.getSnapshot().open).toBe(false)
  api.customizationRequests.mockResolvedValueOnce(ok({ meId: member.id,
    entries: [{ id: record.id, target: record.target, updatedAt: 1, revision: 1 }], next: 20 }))
  await model.list()
  api.customizationRequests.mockResolvedValueOnce(ok({ meId: member.id, entries: [], next: null }))
  await model.more()
  expect(api.customizationRequests.mock.calls).toEqual([[null], [20]])
  expect(model.state.getSnapshot()).toMatchObject({ draft: null, saved: null, entries: [{ target: 'OA' }], next: null })
})
