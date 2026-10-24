/** Reviewed sync retries retain their identity; saved snapshots never cross employee, role or dialog boundaries. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnectorActionsView, OfficeConnectorSyncDetail, OfficeConnectorSyncId, OfficeConnectorSyncPage,
  OfficeConnectorView, OfficeIntegrationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeConnectorSyncModel } from '../src/client/connector-sync-model.ts'

const integrationId = '47e66e79-2894-49eb-bb17-c512de55c7dc' as OfficeIntegrationId
const id = '47e66e79-2894-49eb-bb17-c512de55c7d1' as OfficeConnectorSyncId
const secondId = '47e66e79-2894-49eb-bb17-c512de55c7d2' as OfficeConnectorSyncId
const member = { id: 'lin' as OfficeMemberId, role: 'employee' as const }
const directory: OfficeConnectorActionsView = { integrationId, connectionRevision: 1,
  adapterRevision: '47e66e79-2894-49eb-bb17-c512de55c7df', status: 'unverified', readSupported: true,
  actions: [{ id: 'read-self', label: 'Read my work', description: '', kind: 'read' }] }
const view: OfficeConnectorView = {
  revision: 1, adapters: ['test'],
  entries: [{ integrationId, revision: 1, adapterId: 'test', status: 'unverified', updatedAt: 1 }],
  synchronization: { protocol: 1, pageMaxEntries: 20, maxEntries: 1000, maxBytes: 16777216 },
}
const receipt: OfficeConnectorSyncDetail = { meId: member.id, available: true,
  summary: { id, integrationId, actionId: 'read-self', connectionRevision: 1,
    adapterRevision: directory.adapterRevision!, checkedAt: 10, synchronizedAt: 11, status: 'read' },
  data: { summary: 'Historical work', entries: [{ label: 'Open', value: '3' }] } }
const page: OfficeConnectorSyncPage = { meId: member.id, integrationId, entries: [receipt.summary], next: id }
const ok = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
type Api = ConstructorParameters<typeof OfficeConnectorSyncModel>[0]

function fixture() {
  const api = { syncConnectorAction: vi.fn<Api['syncConnectorAction']>().mockResolvedValue(ok(receipt)),
    connectorSyncPage: vi.fn<Api['connectorSyncPage']>().mockResolvedValue(ok(page)),
    connectorSyncDetail: vi.fn<Api['connectorSyncDetail']>().mockResolvedValue(ok(receipt)) }
  const notify = vi.fn()
  const model = new OfficeConnectorSyncModel(api, notify)
  model.bind(member)
  model.synchronize(view, directory)
  return { model, api, notify }
}

it('reviews without reading, retries an uncertain request exactly and gives a confirmed failed sync a fresh identity', async () => {
  const { model, api } = fixture()
  model.begin(directory, 'read-self')
  expect(api.syncConnectorAction).not.toHaveBeenCalled()
  const input = model.state.getSnapshot().request!.input
  api.syncConnectorAction.mockRejectedValueOnce(new Error('Acknowledgement lost'))
  await model.submit()
  expect(model.state.getSnapshot().request).toMatchObject({ phase: 'uncertain', receipt: null })
  await model.submit()
  expect(api.syncConnectorAction.mock.calls.map(([value]) => value)).toEqual([input, input])
  expect(model.state.getSnapshot().request).toMatchObject({ phase: 'complete', receipt })
  model.begin(directory, 'read-self')
  const next = model.state.getSnapshot().request!.input
  expect(next.requestId).not.toBe(input.requestId)
  expect(model.state.getSnapshot().request!.receipt).toBeNull()
  api.syncConnectorAction.mockResolvedValueOnce(ok({ ...receipt,
    summary: { ...receipt.summary, id: secondId, status: 'unauthorized' }, data: null }))
  await model.submit()
  expect(model.state.getSnapshot().request).toMatchObject({ phase: 'complete', receipt: { data: null,
    summary: { status: 'unauthorized' } } })
  await model.submit()
  expect(api.syncConnectorAction).toHaveBeenCalledTimes(3)
})

it.each(['account', 'role', 'close', 'history', 'dispose'] as const)('discards a late synchronized body after %s changes', async (kind) => {
  const { model, api } = fixture()
  model.begin(directory, 'read-self')
  const late = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorSyncDetail>>>()
  api.syncConnectorAction.mockReturnValueOnce(late.promise)
  const pending = model.submit()
  if (kind === 'account') model.bind({ ...member, id: 'other' as OfficeMemberId })
  if (kind === 'role') model.bind({ ...member, role: 'manager' })
  if (kind === 'close') model.close()
  if (kind === 'history') await model.open(integrationId)
  if (kind === 'dispose') model.dispose()
  late.resolve(ok(receipt))
  await pending
  expect(model.state.getSnapshot().request).toBeNull()
  expect(model.state.getSnapshot().detail).toBeNull()
  expect(JSON.stringify(model.state.getSnapshot())).not.toContain('Historical work')
})

it('reads stable older metadata once and fetches only selected own details without another customer synchronization', async () => {
  const { model, api } = fixture()
  await model.open(integrationId)
  const late = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorSyncPage>>>()
  api.connectorSyncPage.mockReturnValueOnce(late.promise)
  const older = model.more()
  await model.more()
  expect(api.connectorSyncPage).toHaveBeenCalledTimes(2)
  late.resolve(ok({ ...page, entries: [{ ...receipt.summary, id: secondId }], next: null }))
  await older
  expect(api.connectorSyncPage).toHaveBeenLastCalledWith({ integrationId, before: id })
  expect(model.state.getSnapshot().entries.map(entry => entry.id)).toEqual([id, secondId])
  await model.detail('not-listed' as OfficeConnectorSyncId)
  expect(api.connectorSyncDetail).not.toHaveBeenCalled()
  await model.detail(id)
  expect(model.state.getSnapshot().detail?.receipt).toEqual(receipt)
  api.connectorSyncDetail.mockRejectedValueOnce(new Error('Offline'))
  await model.detail(id)
  expect(model.state.getSnapshot().detail).toEqual({ id, loading: false, receipt: null, error: 'unavailable' })
  expect(api.syncConnectorAction).not.toHaveBeenCalled()
})

it('blocks a stale review before reading and hides saved fields immediately when the connection or read declaration changes', async () => {
  const { model, api } = fixture()
  model.begin(directory, 'read-self')
  model.synchronize({ ...view, entries: [{ integrationId, revision: 2, adapterId: 'test', status: 'unverified', updatedAt: 1 }] }, directory)
  await model.submit()
  expect(api.syncConnectorAction).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().request?.phase).toBe('blocked')
  model.synchronize(view, directory)
  await model.open(integrationId)
  await model.detail(id)
  model.synchronize(view, { ...directory, readSupported: false })
  expect(model.state.getSnapshot().detail?.receipt).toMatchObject({ available: false, data: null })
  model.synchronize(view, directory)
  expect(model.state.getSnapshot().detail?.receipt?.data).toBeNull()
  await model.detail(id)
  expect(model.state.getSnapshot().detail?.receipt?.data).toEqual(receipt.data)
  model.synchronize(null, null)
  expect(model.state.getSnapshot().detail?.receipt?.data).toBeNull()
})

it('rejects another employee response and closes private data when authentication expires', async () => {
  const { model, api, notify } = fixture()
  api.connectorSyncPage.mockResolvedValueOnce(ok({ ...page, meId: 'other' as OfficeMemberId }))
  await model.open(integrationId)
  expect(model.state.getSnapshot().entries).toEqual([])
  expect(model.state.getSnapshot().error).toBe('conflict')
  await model.open(integrationId)
  api.connectorSyncDetail.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
  await model.detail(id)
  expect(model.state.getSnapshot().integrationId).toBeNull()
  expect(notify).toHaveBeenCalledWith('unauthenticated')
  await model.open(integrationId)
  expect(api.connectorSyncPage).toHaveBeenCalledTimes(2)
})
