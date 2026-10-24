/** Private history cannot leak through account/role/system changes, slow responses or stale detail failures. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnectorExecutionId, OfficeConnectorExecutionPage, OfficeConnectorExecutionReceipt,
  OfficeIntegrationId, OfficeMemberId, OfficeConnectorExecutionCheck } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeExecutionsModel } from '../src/client/executions-model.ts'

const id = '47e66e79-2894-49eb-bb17-c512de55c7dc' as OfficeIntegrationId
const second = '47e66e79-2894-49eb-bb17-c512de55c7dd' as OfficeIntegrationId
const member = { id: 'lin' as OfficeMemberId, role: 'employee' as const }
const firstId = '47e66e79-2894-49eb-bb17-c512de55c7d1' as OfficeConnectorExecutionId
const nextId = '47e66e79-2894-49eb-bb17-c512de55c7d2' as OfficeConnectorExecutionId
const receipt: OfficeConnectorExecutionReceipt = { id: firstId, requestId: '47e66e79-2894-49eb-bb17-c512de55c7de',
  memberId: member.id, roleAtAdmission: 'employee', integrationId: id, actionId: 'submit', connectionRevision: 1,
  adapterRevision: '47e66e79-2894-49eb-bb17-c512de55c7df', stage: 'unknown', status: 'unknown', revision: 3,
  admittedAt: 1, updatedAt: 3, history: [{ stage: 'reserved', at: 1 }, { stage: 'dispatched', at: 2 }, { stage: 'unknown', at: 3 }] }
const { history: _history, result: _result, ...summary } = receipt
const page: OfficeConnectorExecutionPage = { integrationId: id, entries: [summary], next: firstId }
const ok = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
type Api = ConstructorParameters<typeof OfficeExecutionsModel>[0]
function fixture() {
  const api = { connectorExecutionPage: vi.fn<Api['connectorExecutionPage']>().mockResolvedValue(ok(page)),
    connectorExecutionDetail: vi.fn<Api['connectorExecutionDetail']>().mockResolvedValue(ok(receipt)),
    checkConnectorExecution: vi.fn<Api['checkConnectorExecution']>(),
  }
  const notify = vi.fn()
  const model = new OfficeExecutionsModel(api, notify)
  model.bind(member)
  return { model, api, notify }
}

it('opens only explicitly, requests stable older anchors once and reads only a selected listed detail', async () => {
  const { model, api } = fixture()
  expect(api.connectorExecutionPage).not.toHaveBeenCalled()
  await model.open(id)
  expect(api.connectorExecutionPage).toHaveBeenLastCalledWith({ integrationId: id })
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorExecutionPage>>>()
  api.connectorExecutionPage.mockReturnValueOnce(pending.promise)
  const more = model.more()
  await model.more()
  expect(api.connectorExecutionPage).toHaveBeenCalledTimes(2)
  pending.resolve(ok({ integrationId: id, entries: [{ ...summary, id: nextId }], next: null }))
  await more
  expect(api.connectorExecutionPage).toHaveBeenLastCalledWith({ integrationId: id, before: firstId })
  expect(model.state.getSnapshot().entries.map(entry => entry.id)).toEqual([firstId, nextId])
  await model.detail('unknown' as OfficeConnectorExecutionId)
  expect(api.connectorExecutionDetail).not.toHaveBeenCalled()
  await model.detail(firstId)
  expect(model.state.getSnapshot().detail?.receipt).toEqual(receipt)
  model.closeDetail()
  expect(model.state.getSnapshot().detail).toBeNull()
})

it.each(['account', 'role', 'system', 'close', 'dispose'] as const)('fences an outstanding private page after %s changes', async (kind) => {
  const { model, api } = fixture()
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorExecutionPage>>>()
  api.connectorExecutionPage.mockReturnValueOnce(pending.promise)
  const request = model.open(id)
  if (kind === 'account') model.bind({ ...member, id: 'other' as OfficeMemberId })
  if (kind === 'role') model.bind({ ...member, role: 'manager' })
  if (kind === 'system') { api.connectorExecutionPage.mockResolvedValue(ok({ integrationId: second, entries: [], next: null })); await model.open(second) }
  if (kind === 'close') model.close()
  if (kind === 'dispose') model.dispose()
  pending.resolve(ok(page))
  await request
  expect(model.state.getSnapshot().entries).toEqual([])
  expect(model.state.getSnapshot().detail).toBeNull()
})

it('clears old receipt data before a failed detail refresh and ignores a late older detail', async () => {
  const { model, api } = fixture()
  await model.open(id)
  await model.detail(firstId)
  expect(model.state.getSnapshot().detail?.receipt).toBeTruthy()
  const late = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorExecutionReceipt>>>()
  api.connectorExecutionDetail.mockReturnValueOnce(late.promise)
  const request = model.detail(firstId)
  expect(model.state.getSnapshot().detail?.receipt).toBeNull()
  api.connectorExecutionDetail.mockRejectedValueOnce(new Error('Offline'))
  await model.detail(firstId)
  late.resolve(ok(receipt))
  await request
  expect(model.state.getSnapshot().detail).toEqual({ id: firstId, receipt: null, loading: false, error: 'unavailable' })
})

it.each(['owner', 'system', 'duplicate', 'cursor'] as const)('rejects a mismatched %s page without publishing its entries', async (kind) => {
  const { model, api } = fixture()
  api.connectorExecutionPage.mockResolvedValue(ok({ ...page,
    ...kind === 'owner' ? { entries: [{ ...summary, memberId: 'other' as OfficeMemberId }] } : {},
    ...kind === 'system' ? { integrationId: second } : {},
    ...kind === 'duplicate' ? { entries: [summary, summary] } : {},
    ...kind === 'cursor' ? { next: nextId } : {},
  }))
  await model.open(id)
  expect(model.state.getSnapshot().entries).toEqual([])
  expect(model.state.getSnapshot().error).toBe('conflict')
})

it('releases private history and notifies the identity owner on an expired session', async () => {
  const { model, api, notify } = fixture()
  await model.open(id)
  api.connectorExecutionDetail.mockResolvedValue({ ok: true, value: { ok: false, code: 'unauthenticated' } })
  await model.detail(firstId)
  expect(model.state.getSnapshot().integrationId).toBeNull()
  expect(model.state.getSnapshot().entries).toEqual([])
  expect(notify).toHaveBeenCalledWith('unauthenticated')
  await model.open(id)
  expect(api.connectorExecutionPage).toHaveBeenCalledTimes(1)
})

it('checks only an explicitly selected unknown receipt once and updates small rows from its durable result', async () => {
  const { model, api } = fixture()
  await model.check()
  expect(api.checkConnectorExecution).not.toHaveBeenCalled()
  await model.open(id)
  await model.detail(firstId)
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorExecutionCheck>>>()
  api.checkConnectorExecution.mockReturnValueOnce(pending.promise)
  const request = model.check()
  await model.check()
  expect(api.checkConnectorExecution).toHaveBeenCalledTimes(1)
  expect(api.checkConnectorExecution).toHaveBeenCalledWith(firstId)
  pending.resolve(ok({ status: 'updated', receipt: { ...receipt, stage: 'succeeded', status: 'succeeded', revision: 4,
    result: { summary: 'Confirmed private result', entries: [] } } }))
  await request
  expect(model.state.getSnapshot().detail?.receipt?.status).toBe('succeeded')
  expect(model.state.getSnapshot().detail?.check).toEqual({ loading: false, status: 'updated', error: null })
  expect(model.state.getSnapshot().entries[0]?.status).toBe('succeeded')
  expect(JSON.stringify(model.state.getSnapshot().entries)).not.toContain('Confirmed private result')
  await model.check()
  expect(api.checkConnectorExecution).toHaveBeenCalledTimes(1)
})

it.each(['account', 'role', 'system', 'detail', 'dispose'] as const)('discards a private checker response after %s changes', async (kind) => {
  const { model, api } = fixture()
  await model.open(id)
  await model.detail(firstId)
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorExecutionCheck>>>()
  api.checkConnectorExecution.mockReturnValueOnce(pending.promise)
  const request = model.check()
  if (kind === 'account') model.bind({ ...member, id: 'other' as OfficeMemberId })
  if (kind === 'role') model.bind({ ...member, role: 'manager' })
  if (kind === 'system') { api.connectorExecutionPage.mockResolvedValue(ok({ integrationId: second, entries: [], next: null })); await model.open(second) }
  if (kind === 'detail') model.closeDetail()
  if (kind === 'dispose') model.dispose()
  pending.resolve(ok({ status: 'updated', receipt: { ...receipt, status: 'succeeded', stage: 'succeeded', revision: 4,
    result: { summary: 'Must not disclose this result', entries: [] } } }))
  await request
  expect(model.state.getSnapshot().detail).toBeNull()
  expect(JSON.stringify(model.state.getSnapshot())).not.toContain('Must not disclose this result')
})

it('retains unknown evidence after an unavailable or failed checker rather than claiming a new business outcome', async () => {
  const { model, api } = fixture()
  await model.open(id)
  await model.detail(firstId)
  api.checkConnectorExecution.mockResolvedValueOnce(ok({ status: 'unavailable', receipt }))
  await model.check()
  expect(model.state.getSnapshot().detail?.receipt).toEqual(receipt)
  api.checkConnectorExecution.mockRejectedValueOnce(new Error('Offline'))
  await model.check()
  expect(model.state.getSnapshot().detail?.receipt).toEqual(receipt)
  expect(model.state.getSnapshot().detail?.check?.error).toBe('unavailable')
})
