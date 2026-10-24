// @vitest-environment jsdom
/** Rule configuration reviews actual declared fields and a separately selected compensation operation. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OfficeConnectorActionsView, OfficeIntegrationId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeAutomationDraft } from '../src/client/automation-model.ts'
import { OfficeAutomationEditor } from '../src/client/OfficeAutomationEditor.tsx'
import { officeAutomationLabels } from '../src/client/automation-copy.ts'

const integrationId = '00000000-0000-4000-8000-000000000001' as OfficeIntegrationId
const directory: OfficeConnectorActionsView = { integrationId, connectionRevision: 2,
  adapterRevision: '00000000-0000-4000-8000-000000000002', status: 'unverified', writeSupported: true,
  actions: ['submit', 'withdraw'].map(id => ({ id, kind: 'write', label: id, description: '',
    fields: [{ name: 'reason', label: 'Reason', required: true, maxLength: 200 }] })) }
const draft: OfficeAutomationDraft = { id: null, revision: 0, title: '', enabled: false,
  trigger: { kind: 'form', source: '' }, action: { integrationId, connectionRevision: 2,
    adapterRevision: directory.adapterRevision ?? '', actionId: 'submit', values: { reason: '' } }, compensation: null }
afterEach(cleanup)

it('submits exact reviewed declaration values and compensation while preserving private connection coordinates', () => {
  const save = vi.fn()
  const labels = officeAutomationLabels.zh
  render(<OfficeAutomationEditor initial={draft} directory={directory} systems={[]} labels={labels}
    busy={false} close={vi.fn()} selectSystem={vi.fn()} save={save} />)
  fireEvent.change(screen.getByLabelText(labels.ruleTitle), { target: { value: 'Expense automation' } })
  fireEvent.change(screen.getByLabelText(labels.source), { target: { value: 'expense-form' } })
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Reviewed exact reason' } })
  fireEvent.change(screen.getByLabelText(labels.compensation), { target: { value: 'withdraw' } })
  const reasons = screen.getAllByLabelText('Reason')
  fireEvent.change(reasons[1]!, { target: { value: 'Reviewed compensation reason' } })
  fireEvent.click(screen.getByRole('button', { name: labels.save }))
  expect(save).toHaveBeenCalledWith({ ...draft, title: 'Expense automation', trigger: { kind: 'form', source: 'expense-form' },
    action: { ...draft.action, values: { reason: 'Reviewed exact reason' } },
    compensation: { ...draft.action, actionId: 'withdraw', values: { reason: 'Reviewed compensation reason' } } })
})
