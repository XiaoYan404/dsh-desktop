/** Private review/draft state fences late accounts, and a lost mutation acknowledgment never starts an automatic retry. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeAutomationResponse } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeAutomationModel } from '../src/client/automation-model.ts'
import type { OfficeAutomationRemote } from '../src/client/automation-model.ts'
import type { OfficeMemberId, OfficeConnectorActionsView, OfficeIntegrationId } from '@deepseek-ai/dsh-enterprise-office/types'

const member = { id: 'lin' as OfficeMemberId, role: 'employee' as const }
const integrationId = '00000000-0000-4000-8000-000000000003' as OfficeIntegrationId
const directory: OfficeConnectorActionsView = { integrationId, connectionRevision: 1,
  adapterRevision: '00000000-0000-4000-8000-000000000004', status: 'unverified', writeSupported: true,
  actions: [{ id: 'submit', label: 'Submit', description: 'Reviewed write', kind: 'write',
    fields: [{ name: 'title', label: 'Title', required: true, maxLength: 200 }] }] }
const ok = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
function fixture() {
  const api = { automation: vi.fn<OfficeAutomationRemote['automation']>().mockResolvedValue(ok({ kind: 'list', rules: [], runs: [] })),
    connectorActions: vi.fn<OfficeAutomationRemote['connectorActions']>().mockResolvedValue(ok(directory)) }
  const model = new OfficeAutomationModel(api)
  model.bind(member)
  return { api, model }
}

it('clears private drafts and ignores a late directory response after switching employee', async () => {
  const { api, model } = fixture()
  await model.open()
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorActionsView>>>()
  api.connectorActions.mockReturnValueOnce(pending.promise)
  const editing = model.edit(integrationId)
  model.bind({ ...member, id: 'wei' as OfficeMemberId })
  pending.resolve(ok(directory))
  await editing
  expect(model.state.getSnapshot()).toMatchObject({ opened: false, editor: null, directory: null, rules: [], runs: [] })
})

it('prepares a disabled strict rule and preserves its exact draft after a lost save response without repeating the write', async () => {
  const { api, model } = fixture()
  await model.open()
  await model.edit(integrationId)
  const draft = model.state.getSnapshot().editor
  expect(draft).toMatchObject({ id: null, revision: 0, enabled: false,
    action: { integrationId, connectionRevision: 1, adapterRevision: directory.adapterRevision, values: { title: '' } } })
  if (!draft) throw new Error('No exact draft')
  const saved = { ...draft, title: 'My rule', trigger: { kind: 'form' as const, source: 'expense' },
    action: { ...draft.action, values: { title: 'Exact reviewed purchase' } } }
  api.automation.mockRejectedValueOnce(new Error('Acknowledgment unavailable'))
  await model.save(saved)
  expect(api.automation.mock.calls.map(call => call[0].kind)).toEqual(['list', 'save'])
  expect(api.automation.mock.calls[1]?.[0]).toEqual({ kind: 'save', input: saved })
  expect(model.state.getSnapshot().error).toBe('unavailable')
  await model.refresh()
  expect(api.automation.mock.calls.map(call => call[0].kind)).toEqual(['list', 'save', 'list'])
})

it('fences a late private list after closing the overlay instead of reopening stale content', async () => {
  const { api, model } = fixture()
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeAutomationResponse>>>()
  api.automation.mockReturnValueOnce(pending.promise)
  const loading = model.open()
  model.close()
  pending.resolve(ok({ kind: 'list', rules: [], runs: [] }))
  await loading
  expect(model.state.getSnapshot()).toMatchObject({ opened: false, busy: false, review: null })
})
