// @vitest-environment jsdom
/** Unknown operations offer original-result recovery; compensation and explicit reviews retain exact coordinates. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeAutomationRule, OfficeAutomationRun, OfficeAutomationRuleId, OfficeAutomationRunId } from
  '@deepseek-ai/dsh-enterprise-office'
import type { OfficeIntegrationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeAutomations } from '../src/client/OfficeAutomations.tsx'
import type { OfficeAutomationsProps } from '../src/client/OfficeAutomations.tsx'
import { officeAutomationLabels } from '../src/client/automation-copy.ts'

const rule: OfficeAutomationRule = { id: brandString<OfficeAutomationRuleId>('00000000-0000-4000-8000-000000000001'),
  revision: 1, title: 'Expense review', enabled: true, ownerId: brandString<OfficeMemberId>('lin'), ownerRole: 'employee',
  createdAt: 1, trigger: { kind: 'form', source: 'expense' }, compensation: null,
  action: { integrationId: brandString<OfficeIntegrationId>('00000000-0000-4000-8000-000000000002'), actionId: 'submit',
    connectionRevision: 1, adapterRevision: '00000000-0000-4000-8000-000000000003', values: { title: 'Reviewed purchase' } } }
const run: OfficeAutomationRun = { id: brandString<OfficeAutomationRunId>('00000000-0000-4000-8000-000000000004'),
  revision: 1, rule, admittedAt: 1, occurrence: 'form-one', parentId: null, compensation: null,
  primary: { requestId: '00000000-0000-4000-8000-000000000005', executionId: null, stage: 'unknown', rejection: null } }
function props(): OfficeAutomationsProps {
  return { labels: officeAutomationLabels.zh, rules: [rule], runs: [run], busy: false, error: null, review: null,
    createRule: vi.fn(), editRule: vi.fn(), toggleRule: vi.fn(), refresh: vi.fn(), reviewRun: vi.fn(), confirmReview: vi.fn(),
    closeReview: vi.fn(), manageRun: vi.fn(), recoverRun: vi.fn(), triggerForm: vi.fn() }
}
afterEach(cleanup)

it('offers unknown-result recovery with no retry, compensation, confirmation or false completion label', () => {
  const value = props()
  render(<OfficeAutomations {...value} />)
  expect(screen.getByRole('status').textContent).toContain('外部操作可能已生效')
  fireEvent.click(screen.getByRole('button', { name: value.labels.recover }))
  expect(value.recoverRun).toHaveBeenCalledWith(run.id, 'primary')
  expect(screen.queryByRole('button', { name: value.labels.retry })).toBeNull()
  expect(screen.queryByRole('button', { name: value.labels.compensate })).toBeNull()
  expect(screen.queryByRole('button', { name: value.labels.confirm })).toBeNull()
})

it('keeps compensation pending separate review and disables stale-rule execution while cancellation remains available', () => {
  const value = props()
  const compensating: OfficeAutomationRun = { ...run, revision: 3,
    rule: { ...rule, compensation: { ...rule.action, actionId: 'withdraw' } },
    primary: { ...run.primary, stage: 'succeeded' }, compensation: { ...run.primary, stage: 'pending_approval' } }
  const view = render(<OfficeAutomations {...value} runs={[compensating]} />)
  fireEvent.click(screen.getByRole('button', { name: value.labels.review }))
  expect(value.reviewRun).toHaveBeenCalledWith(run.id, 'compensation')
  view.rerender(<OfficeAutomations {...value} runs={[compensating]} rules={[{ ...rule, enabled: false, revision: 2 }]} />)
  expect(screen.getByRole('button', { name: value.labels.review }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: value.labels.cancel }))
  expect(value.manageRun).toHaveBeenCalledWith(compensating, 'cancel')
})
