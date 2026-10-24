// @vitest-environment jsdom
/** GUI rule edits, immutable reviews and original-result recovery retain their data across failures. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeAutomationRule, OfficeAutomationRun, OfficeAutomationRunId, OfficeAutomationRuleId,
  OfficeAutomationResponse } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeConnectorActionsView, OfficeConnectorExecutionId, OfficeIntegrationId, OfficeMemberId } from
  '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeAutomationModel } from '../src/client/automation-model.ts'
import type { OfficeAutomationDraft, OfficeAutomationRemote } from '../src/client/automation-model.ts'
import { OfficeAutomationEditor } from '../src/client/OfficeAutomationEditor.tsx'
import { OfficeAutomations } from '../src/client/OfficeAutomations.tsx'
import type { OfficeAutomationsProps } from '../src/client/OfficeAutomations.tsx'
import { officeAutomationLabels } from '../src/client/automation-copy.ts'

const labels = officeAutomationLabels.zh
const integrationId = brandString<OfficeIntegrationId>('00000000-0000-4000-8000-000000000001')
const otherId = brandString<OfficeIntegrationId>('00000000-0000-4000-8000-000000000002')
const member = { id: brandString<OfficeMemberId>('lin'), role: 'employee' as const }
const directory: OfficeConnectorActionsView = { integrationId, connectionRevision: 2,
  adapterRevision: '00000000-0000-4000-8000-000000000003', status: 'unverified', writeSupported: true,
  actions: ['submit', 'withdraw'].map(id => ({ id, label: id, description: '', kind: 'write',
    fields: [{ name: 'reason', label: 'Reason', required: true, maxLength: 200 }] })) }
const draft = { id: null, revision: 0, title: 'Expense rule', enabled: false,
  trigger: { kind: 'form', source: 'expense-form' }, compensation: null,
  action: { integrationId, connectionRevision: 2, adapterRevision: directory.adapterRevision ?? '',
    actionId: 'submit', values: { reason: 'Exact primary value' } } } satisfies OfficeAutomationDraft
const rule: OfficeAutomationRule = { ...draft,
  id: brandString<OfficeAutomationRuleId>('00000000-0000-4000-8000-000000000004'),
  revision: 1, enabled: true, ownerId: member.id, ownerRole: member.role, createdAt: 1 }
const run: OfficeAutomationRun = { id: brandString<OfficeAutomationRunId>('00000000-0000-4000-8000-000000000005'),
  revision: 3, rule, admittedAt: 1, occurrence: 'expense-one', parentId: null, compensation: null,
  primary: { stage: 'pending_approval', requestId: '00000000-0000-4000-8000-000000000006', executionId: null, rejection: null } }
const review: Extract<OfficeAutomationResponse, { kind: 'review' }>['review'] = {
  runId: run.id, revision: 3, part: 'primary', action: draft.action, requestId: run.primary.requestId,
}
const ok = <T,>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
function fixture() {
  const remote = { automation: vi.fn<OfficeAutomationRemote['automation']>()
    .mockResolvedValue(ok({ kind: 'list', rules: [rule], runs: [run] })),
  connectorActions: vi.fn<OfficeAutomationRemote['connectorActions']>().mockResolvedValue(ok(directory)) }
  const model = new OfficeAutomationModel(remote)
  model.bind(member)
  return { model, remote }
}
function editorProps() {
  return { initial: draft, directory, systems: [], labels, busy: false,
    close: vi.fn(), selectSystem: vi.fn(), save: vi.fn() }
}
function listProps(): OfficeAutomationsProps {
  return { labels, rules: [rule], runs: [run], busy: false, error: null, review: null,
    createRule: vi.fn(), editRule: vi.fn(), toggleRule: vi.fn(), triggerForm: vi.fn(), refresh: vi.fn(),
    reviewRun: vi.fn(), confirmReview: vi.fn(), closeReview: vi.fn(), manageRun: vi.fn(), recoverRun: vi.fn() }
}

afterEach(cleanup)

it('locks every editor input during a save and rejects a second submitted form', () => {
  const props = editorProps()
  render(<OfficeAutomationEditor {...props} busy />)
  expect(screen.getByLabelText(labels.ruleTitle).matches(':disabled')).toBe(true)
  expect(screen.getByRole('combobox', { name: labels.trigger }).matches(':disabled')).toBe(true)
  const button = screen.getByRole('button', { name: labels.save })
  const form = button.closest('form')
  if (!form) throw new Error('Editor form unavailable')
  fireEvent.submit(form)
  expect(props.save).not.toHaveBeenCalled()
})

it('requires nonblank input and explicit removal of fields no longer declared by the operation', () => {
  const props = editorProps()
  render(<OfficeAutomationEditor {...props} initial={{ ...draft, title: ' ',
    action: { ...draft.action, values: { reason: 'Exact primary value', obsolete: 'Retained old value' } } }} />)
  const save = screen.getByRole('button', { name: labels.save })
  expect(save.hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByLabelText(labels.ruleTitle), { target: { value: 'Reviewed title' } })
  expect(save.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: labels.resetFields }))
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'New exact value' } })
  fireEvent.click(save)
  expect(props.save).toHaveBeenCalledWith({ ...draft, title: 'Reviewed title',
    action: { ...draft.action, values: { reason: 'New exact value' } } })
})

it('shows a removed action instead of silently selecting an available replacement', () => {
  const props = editorProps()
  render(<OfficeAutomationEditor {...props} directory={{ ...directory, actions: directory.actions.filter(item => item.id === 'withdraw') }} />)
  expect(screen.getByRole('combobox', { name: labels.action }).textContent).toContain('submit')
  expect(screen.getByRole('button', { name: labels.save }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(screen.getByRole('combobox', { name: labels.action }), { target: { value: 'withdraw' } })
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Explicit replacement value' } })
  fireEvent.click(screen.getByRole('button', { name: labels.save }))
  expect(props.save).toHaveBeenCalledWith({ ...draft,
    action: { ...draft.action, actionId: 'withdraw', values: { reason: 'Explicit replacement value' } } })
})

it('retains a foreign-system compensation and its exact fields while editing the primary operation', () => {
  const props = editorProps()
  const compensation = { ...draft.action, integrationId: otherId, actionId: 'foreign_withdraw',
    values: { remote_reason: 'Original independent compensation' } }
  render(<OfficeAutomationEditor {...props} initial={{ ...draft, compensation }} />)
  expect(screen.getByText(labels.externalCompensation)).toBeTruthy()
  expect(screen.getByText(compensation.values.remote_reason)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Updated primary only' } })
  fireEvent.click(screen.getByRole('button', { name: labels.save }))
  expect(props.save).toHaveBeenCalledWith({ ...draft, compensation,
    action: { ...draft.action, values: { reason: 'Updated primary only' } } })
})

it('requires explicit compensation selection after its retained connection version changes', () => {
  const props = editorProps()
  render(<OfficeAutomationEditor {...props} initial={{ ...draft,
    compensation: { ...draft.action, connectionRevision: 1, actionId: 'withdraw' } }} />)
  expect(screen.getByRole('button', { name: labels.save }).hasAttribute('disabled')).toBe(true)
  const group = within(screen.getByRole('group', { name: labels.compensation }))
  fireEvent.click(group.getByRole('button', { name: labels.resetFields }))
  fireEvent.change(group.getByLabelText('Reason'), { target: { value: 'Reviewed current compensation' } })
  fireEvent.click(screen.getByRole('button', { name: labels.save }))
  expect(props.save).toHaveBeenCalledWith({ ...draft,
    compensation: { ...draft.action, actionId: 'withdraw', values: { reason: 'Reviewed current compensation' } } })
})

it('keeps save errors inside the editor and blocks resubmission of an uncertain creation', () => {
  const props = editorProps()
  render(<OfficeAutomationEditor {...props} saveUncertain error={labels.unavailable} />)
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByRole('alert').textContent).toBe(labels.unavailable)
  expect(dialog.getByRole('status').textContent).toBe(labels.saveUncertain)
  fireEvent.click(dialog.getByRole('button', { name: labels.save }))
  expect(props.save).not.toHaveBeenCalled()
  expect(screen.getByLabelText(labels.ruleTitle).getAttribute('value')).toBe(draft.title)
})

it('shows the exact review system, original request and versions without interpreting input as HTML', () => {
  const props = listProps()
  const exact = { ...review, action: { ...draft.action, values: { reason: '<img src=x onerror=alert(1)>' } } }
  render(<OfficeAutomations {...props} review={exact} systems={[{ id: integrationId, system: 'Customer OA' }]} />)
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('Customer OA')).toBeTruthy()
  expect(dialog.getByText(review.requestId)).toBeTruthy()
  expect(dialog.getByText(review.action.adapterRevision)).toBeTruthy()
  expect(dialog.getByText(exact.action.values.reason)).toBeTruthy()
  expect(dialog.queryByRole('img')).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: labels.confirm }))
  expect(props.confirmReview).toHaveBeenCalledWith(exact)
})

it('finds compensation by its original execution and keeps the primary outcome visible', () => {
  const props = listProps()
  const executionId = '00000000-0000-4000-8000-000000000007'
  const compensating: OfficeAutomationRun = { ...run, rule: { ...rule, compensation: rule.action },
    primary: { ...run.primary, stage: 'succeeded' }, compensation: { ...run.primary, stage: 'unknown',
      executionId: brandString<OfficeConnectorExecutionId>(executionId) } }
  render(<OfficeAutomations {...props} runs={[compensating]} />)
  fireEvent.change(screen.getByLabelText(labels.runFilter), { target: { value: executionId } })
  expect(screen.getByRole('list', { name: labels.runsTitle }).textContent).toContain(labels.primary)
  expect(screen.getByRole('list', { name: labels.runsTitle }).textContent).toContain(labels.states.succeeded)
  fireEvent.click(screen.getByRole('button', { name: labels.recover }))
  expect(props.recoverRun).toHaveBeenCalledWith(run.id, 'compensation')
  expect(screen.queryByRole('button', { name: labels.retry })).toBeNull()
  fireEvent.change(screen.getByLabelText(labels.runFilter), { target: { value: 'unmatched-run-id' } })
  expect(screen.getByText(labels.noMatchingRuns)).toBeTruthy()
})

it('explains a stale rule while retaining explicit cancellation', () => {
  const props = listProps()
  render(<OfficeAutomations {...props} rules={[{ ...rule, revision: 2 }]} />)
  expect(screen.getByText(labels.ruleChanged)).toBeTruthy()
  expect(screen.getByRole('button', { name: labels.review }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: labels.cancel }))
  expect(props.manageRun).toHaveBeenCalledWith(run, 'cancel')
})

it('leaves only reads and original recovery available after an unconfirmed mutation', () => {
  const props = listProps()
  render(<OfficeAutomations {...props} needsRefresh runs={[{ ...run, primary: { ...run.primary, stage: 'unknown' } }]} />)
  expect(screen.getByRole('button', { name: labels.newRule }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: labels.startForm }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: labels.refresh }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('button', { name: labels.recover }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByText(labels.refreshRequired)).toBeTruthy()
})

it('discloses shared form-source fanout without claiming a native source connection', () => {
  const props = listProps()
  render(<OfficeAutomations {...props} />)
  expect(screen.getByText(labels.sourceSharedHint)).toBeTruthy()
  expect(screen.getAllByText(/expense-form/).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: labels.startForm }))
  expect(props.triggerForm).toHaveBeenCalledWith(rule)
  expect(props.confirmReview).not.toHaveBeenCalled()
})

it('preserves the current local draft and directory when switching systems fails', async () => {
  const { model, remote } = fixture()
  await model.open()
  await model.edit(integrationId, draft)
  const local = { ...draft, title: 'Unsaved title', trigger: { ...draft.trigger, source: 'Unsaved source' },
    action: { ...draft.action, values: { reason: 'Unsaved exact field' } } }
  remote.connectorActions.mockRejectedValueOnce(new Error('Directory unavailable'))
  await model.edit(otherId, local)
  expect(model.state.getSnapshot()).toMatchObject({ editor: local, directory, busy: false, error: 'unavailable' })
  expect(remote.automation.mock.calls.map(([command]) => command.kind)).toEqual(['list'])
})

it('does not silently replace a removed operation while refreshing a draft directory', async () => {
  const { model, remote } = fixture()
  await model.open()
  remote.connectorActions.mockResolvedValueOnce(ok({ ...directory, actions: directory.actions.filter(item => item.id === 'withdraw') }))
  await model.edit(integrationId, draft)
  expect(model.state.getSnapshot().editor?.action).toEqual(draft.action)
})

it('keeps foreign compensation coordinates when selecting a different primary system', async () => {
  const { model, remote } = fixture()
  await model.open()
  const compensation = { ...draft.action, actionId: 'withdraw' }
  remote.connectorActions.mockResolvedValueOnce(ok({ ...directory, integrationId: otherId, connectionRevision: 7 }))
  await model.edit(otherId, { ...draft, compensation })
  expect(model.state.getSnapshot().editor).toMatchObject({ compensation,
    action: { integrationId: otherId, connectionRevision: 7, values: { reason: '' } } })
})

it('retains submitted creation fields and never resends an uncertain creation, even after a list refresh', async () => {
  const { model, remote } = fixture()
  await model.open()
  await model.edit(integrationId, draft)
  const submitted = { ...draft, title: 'Submitted latest title' }
  remote.automation.mockRejectedValueOnce(new Error('Acknowledgment lost'))
  await model.save(submitted)
  expect(model.state.getSnapshot()).toMatchObject({ editor: submitted, needsRefresh: true, saveUncertain: true })
  await model.save(submitted)
  await model.refresh()
  await model.save(submitted)
  expect(remote.automation.mock.calls.map(([command]) => command.kind)).toEqual(['list', 'save', 'list'])
  expect(model.state.getSnapshot()).toMatchObject({ needsRefresh: false, saveUncertain: true, editor: submitted })
})

it('keeps a pending confirmation locked when Escape or a stale callback tries to dismiss and repeat it', async () => {
  const { model, remote } = fixture()
  await model.open()
  remote.automation.mockResolvedValueOnce(ok({ kind: 'review', review }))
  await model.review(run.id, 'primary')
  const shown = model.state.getSnapshot().review
  if (!shown) throw new Error('Exact review unavailable')
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeAutomationResponse>>>()
  remote.automation.mockReturnValueOnce(pending.promise)
  const executing = model.confirm(shown)
  model.closeReview()
  await model.confirm(shown)
  expect(model.state.getSnapshot()).toMatchObject({ busy: true, review: shown })
  expect(remote.automation.mock.calls.filter(([command]) => command.kind === 'execute')).toHaveLength(1)
  pending.reject(new Error('Outcome unavailable'))
  await executing
  await model.confirm(shown)
  expect(remote.automation.mock.calls.filter(([command]) => command.kind === 'execute')).toHaveLength(1)
  expect(model.state.getSnapshot()).toMatchObject({ needsRefresh: true, busy: false })
})

it('does not turn a failed read or a definitive denial into an uncertain write outcome', async () => {
  const { model, remote } = fixture()
  remote.automation.mockRejectedValueOnce(new Error('Read unavailable'))
  await model.open()
  expect(model.state.getSnapshot()).toMatchObject({ needsRefresh: false, error: 'unavailable' })
  await model.refresh()
  remote.automation.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
  await model.save({ ...draft, id: rule.id, revision: rule.revision })
  expect(model.state.getSnapshot()).toMatchObject({ needsRefresh: false, saveUncertain: false, error: 'denied' })
})

it('rejects a directory for a different registered system without opening a misleading editor', async () => {
  const { model, remote } = fixture()
  await model.open()
  remote.connectorActions.mockResolvedValueOnce(ok({ ...directory, integrationId: otherId }))
  await model.edit(integrationId)
  expect(model.state.getSnapshot()).toMatchObject({ editor: null, busy: false, error: 'denied' })
})

it('discards a late save result after a role change without refreshing or exposing the previous private draft', async () => {
  const { model, remote } = fixture()
  await model.open()
  await model.edit(integrationId, draft)
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeAutomationResponse>>>()
  remote.automation.mockReturnValueOnce(pending.promise)
  const saving = model.save(draft)
  model.bind({ ...member, role: 'manager' })
  pending.resolve(ok({ kind: 'rule', rule }))
  await saving
  expect(model.state.getSnapshot()).toMatchObject({ opened: false, rules: [], editor: null, review: null, needsRefresh: false })
  expect(remote.automation.mock.calls.map(([command]) => command.kind)).toEqual(['list', 'save'])
})
