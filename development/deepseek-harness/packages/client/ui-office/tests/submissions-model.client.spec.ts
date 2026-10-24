/** Business submission review and exact retry identity survive ambiguous replies without leaking across accounts. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnectorActionsView, OfficeConnectorExecutionId, OfficeConnectorExecutionReceipt,
  OfficeConnectorView, OfficeConnectorWriteInput, OfficeIntegrationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeSubmissionsModel } from '../src/client/submissions-model.ts'

const id = '47e66e79-2894-49eb-bb17-c512de55c7dc' as OfficeIntegrationId
const employee = { id: 'lin' as OfficeMemberId, role: 'employee' as const }
const directory: OfficeConnectorActionsView = { integrationId: id, connectionRevision: 1,
  adapterRevision: '47e66e79-2894-49eb-bb17-c512de55c7df', status: 'unverified', writeSupported: true,
  actions: [{ id: 'submit', kind: 'write', label: 'Submit purchase', description: 'Submit employee request',
    fields: [{ name: 'title', label: 'Title', required: true, maxLength: 120 }] }] }
const view: OfficeConnectorView = { revision: 1, adapters: ['company'], entries: [
  { integrationId: id, revision: 1, adapterId: 'company', status: 'unverified', updatedAt: 1 },
] }
type Api = ConstructorParameters<typeof OfficeSubmissionsModel>[0]
function accepted(input: OfficeConnectorWriteInput, unknown = false): RemoteResult<OfficeOutcome<OfficeConnectorExecutionReceipt>> {
  return { ok: true, value: { ok: true, value: { ...input, id: '47e66e79-2894-49eb-bb17-c512de55c7d1' as OfficeConnectorExecutionId,
    memberId: employee.id, roleAtAdmission: 'employee', stage: unknown ? 'unknown' : 'succeeded', status: unknown ? 'unknown' : 'succeeded',
    revision: 3, admittedAt: 1, updatedAt: 3, history: [{ stage: 'reserved', at: 1 }, { stage: 'dispatched', at: 2 },
      { stage: unknown ? 'unknown' : 'succeeded', at: 3 }],
    ...unknown ? {} : { result: { summary: 'Authoritative receipt', entries: [] } },
  } } }
}
function fixture() {
  const api = { writeConnectorAction: vi.fn<Api['writeConnectorAction']>().mockImplementation(input => Promise.resolve(accepted(input))) }
  const notify = vi.fn()
  const model = new OfficeSubmissionsModel(api, notify)
  model.bind(employee)
  model.begin(directory, 'Company', 'submit')
  return { model, api, notify }
}

it('does not submit before explicit review, preserves the exact values and permits only one pending click', async () => {
  const { model, api } = fixture()
  model.field('actor_id', 'other')
  model.field('title', '  Purchase\nExact text  ')
  await model.submit()
  expect(api.writeConnectorAction).not.toHaveBeenCalled()
  model.review()
  const reviewed = model.state.getSnapshot().draft!.input
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorExecutionReceipt>>>()
  api.writeConnectorAction.mockReturnValueOnce(pending.promise)
  const request = model.submit()
  await model.submit()
  model.field('title', 'Changed')
  model.close()
  expect(api.writeConnectorAction).toHaveBeenCalledTimes(1)
  expect(api.writeConnectorAction).toHaveBeenCalledWith(reviewed)
  expect(reviewed.values).toEqual({ title: '  Purchase\nExact text  ' })
  expect(model.state.getSnapshot().phase).toBe('submitting')
  pending.resolve(accepted(reviewed))
  await request
  expect(model.state.getSnapshot().receipt?.status).toBe('succeeded')
})

it('recovers only the identical reviewed request after transport uncertainty and never resubmits an unknown receipt', async () => {
  const { model, api } = fixture()
  model.field('title', 'Purchase')
  model.review()
  const original = model.state.getSnapshot().draft!.input
  api.writeConnectorAction.mockRejectedValueOnce(new Error('Lost reply'))
  await model.submit()
  expect(model.state.getSnapshot().phase).toBe('uncertain')
  expect(model.state.getSnapshot().receipt).toBeNull()
  model.field('title', 'Must not replace uncertain request')
  model.synchronize({ ...view, revision: 2, entries: view.entries.map(entry => ({ ...entry, revision: 2 })) })
  api.writeConnectorAction.mockResolvedValueOnce(accepted(original, true))
  await model.submit()
  expect(api.writeConnectorAction.mock.calls.map(call => call[0])).toEqual([original, original])
  expect(model.state.getSnapshot().receipt?.status).toBe('unknown')
  await model.submit()
  expect(api.writeConnectorAction).toHaveBeenCalledTimes(2)
})

it('blocks a changed connection before submission without silently adopting its new authority or versions', async () => {
  const { model, api } = fixture()
  model.field('title', 'Purchase')
  model.review()
  const original = model.state.getSnapshot().draft!.input
  model.synchronize(view, { ...directory, adapterRevision: '47e66e79-2894-49eb-bb17-c512de55c7dd' })
  await model.submit()
  expect(model.state.getSnapshot().stale).toBe(true)
  expect(model.state.getSnapshot().draft?.input).toEqual(original)
  expect(api.writeConnectorAction).not.toHaveBeenCalled()
})

it.each(['account', 'role', 'unload'] as const)('discards an in-flight acknowledgement after %s changes', async (kind) => {
  const { model, api } = fixture()
  model.field('title', 'Private purchase')
  model.review()
  const original = model.state.getSnapshot().draft!.input
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorExecutionReceipt>>>()
  api.writeConnectorAction.mockReturnValueOnce(pending.promise)
  const request = model.submit()
  if (kind === 'account') model.bind({ ...employee, id: 'other' as OfficeMemberId })
  if (kind === 'role') model.bind({ ...employee, role: 'manager' })
  if (kind === 'unload') model.dispose()
  pending.resolve(accepted(original))
  await request
  expect(model.state.getSnapshot().draft).toBeNull()
  expect(model.state.getSnapshot().receipt).toBeNull()
})

it('validates required prototype-like field names as absent text, never as inherited object values', () => {
  const { model } = fixture()
  model.begin({ ...directory, actions: [{ ...directory.actions[0]!, fields: [
    { name: 'constructor', label: 'Reference', required: true, maxLength: 20 },
  ] }] }, 'Company', 'submit')
  model.review()
  expect(model.state.getSnapshot().phase).toBe('edit')
  expect(model.state.getSnapshot().error).toBe('invalid_input')
  model.field('constructor', 'Own reference')
  model.review()
  expect(model.state.getSnapshot().phase).toBe('review')
})

it('rejects a mismatched success acknowledgement instead of claiming that another request succeeded', async () => {
  const { model, api } = fixture()
  model.field('title', 'Purchase')
  model.review()
  const original = model.state.getSnapshot().draft!.input
  api.writeConnectorAction.mockResolvedValueOnce(accepted({ ...original, requestId: '47e66e79-2894-49eb-bb17-c512de55c7d2' }))
  await model.submit()
  expect(model.state.getSnapshot().phase).toBe('uncertain')
  expect(model.state.getSnapshot().receipt).toBeNull()
})

it('does not open an unsupported write and clears private input after authentication is lost', async () => {
  const { model, api, notify } = fixture()
  model.close()
  model.begin({ ...directory, writeSupported: false }, 'Company', 'submit')
  expect(model.state.getSnapshot().draft).toBeNull()
  model.begin(directory, 'Company', 'submit')
  model.field('title', 'Private purchase')
  model.review()
  api.writeConnectorAction.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
  await model.submit()
  expect(model.state.getSnapshot().draft).toBeNull()
  expect(notify).toHaveBeenCalledWith('unauthenticated')
})
