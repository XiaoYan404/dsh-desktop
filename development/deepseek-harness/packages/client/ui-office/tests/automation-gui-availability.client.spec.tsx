// @vitest-environment jsdom
/** Missing or disconnected automation services retain visible records and disable writes until a current read succeeds. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeIntegrationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeAutomationModel } from '../src/client/automation-model.ts'
import type { OfficeAutomationRemote } from '../src/client/automation-model.ts'
import { OfficeAutomations } from '../src/client/OfficeAutomations.tsx'
import { OfficeAutomationEditor } from '../src/client/OfficeAutomationEditor.tsx'
import { officeAutomationLabels } from '../src/client/automation-copy.ts'

const integrationId = brandString<OfficeIntegrationId>('00000000-0000-4000-8000-000000000001')
function fixture() {
  const remote = { automation: vi.fn<OfficeAutomationRemote['automation']>()
    .mockResolvedValue({ ok: true, value: { ok: true, value: { kind: 'list', rules: [], runs: [] } } }),
  connectorActions: vi.fn<OfficeAutomationRemote['connectorActions']>() }
  const model = new OfficeAutomationModel(remote)
  model.bind({ id: brandString<OfficeMemberId>('lin'), role: 'employee' })
  return { model, remote }
}

afterEach(cleanup)

it('prevents opening an editable form until the current automation service has answered a list read', async () => {
  const { model, remote } = fixture()
  remote.automation.mockRejectedValueOnce(new Error('Existing Host has no automation method'))
  await model.open()
  await model.edit(integrationId)
  expect(remote.connectorActions).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ opened: true, loaded: false, error: 'unavailable', editor: null })
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({ loaded: true, error: null })
})

it('marks a previously loaded service unavailable after a failed refresh while retaining its cached state', async () => {
  const { model, remote } = fixture()
  await model.open()
  const original = model.state.getSnapshot()
  remote.automation.mockRejectedValueOnce(new Error('Connection unavailable'))
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({ loaded: false, rules: original.rules, runs: original.runs })
  await model.edit(integrationId)
  expect(remote.connectorActions).not.toHaveBeenCalled()
  expect(remote.automation.mock.calls.map(([command]) => command.kind)).toEqual(['list', 'list'])
})

it('shows unavailable-service feedback with a refresh action instead of a misleading empty-success state', () => {
  const labels = officeAutomationLabels.zh
  render(<OfficeAutomations labels={labels} rules={[]} runs={[]} busy={false} available={false}
    error={labels.serviceUnavailable} review={null} createRule={vi.fn()} editRule={vi.fn()} toggleRule={vi.fn()}
    triggerForm={vi.fn()} refresh={vi.fn()} reviewRun={vi.fn()} confirmReview={vi.fn()} closeReview={vi.fn()}
    manageRun={vi.fn()} recoverRun={vi.fn()} />)
  expect(screen.getByRole('alert').textContent).toBe(labels.serviceUnavailable)
  expect(screen.getByRole('button', { name: labels.newRule }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: labels.refresh }).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByText(labels.empty)).toBeNull()
  expect(screen.queryByText(labels.noRules)).toBeNull()
})

it('offers a read-only refresh inside an uncertain editor without submitting or dismissing its retained draft', () => {
  const labels = officeAutomationLabels.zh
  const refresh = vi.fn()
  const save = vi.fn()
  const close = vi.fn()
  render(<OfficeAutomationEditor labels={labels} busy={false} saveUncertain refresh={refresh} close={close} save={save}
    selectSystem={vi.fn()} systems={[]} directory={{ integrationId, connectionRevision: 1, adapterRevision: 'fixed',
      status: 'unverified', writeSupported: true, actions: [{ id: 'submit', label: 'Submit', description: '', kind: 'write' }] }}
    initial={{ id: null, revision: 0, title: 'Retained draft', enabled: false, trigger: { kind: 'form', source: 'form' },
      action: { integrationId, connectionRevision: 1, adapterRevision: 'fixed', actionId: 'submit', values: {} }, compensation: null }} />)
  fireEvent.click(screen.getByRole('button', { name: labels.refresh }))
  expect(refresh).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByLabelText(labels.ruleTitle).getAttribute('value')).toBe('Retained draft')
})
