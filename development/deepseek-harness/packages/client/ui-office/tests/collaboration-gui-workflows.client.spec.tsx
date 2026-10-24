// @vitest-environment jsdom
/** GUI review scenarios cover confirmations, editing continuity and explicit recovery controls. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OfficeCollaboration } from '../src/client/OfficeCollaboration.tsx'
import type { OfficeCollaborationProps } from '../src/client/collaboration-contracts.ts'
import type { OfficeCollaborationSnapshot } from '../src/client/collaboration-model.ts'
import { collaborationEn } from '../src/client/collaboration-copy.ts'
import type { CollaborationKey } from '../src/client/collaboration-copy.ts'
import { guiGroup, guiMember, guiPeer } from './collaboration-gui-fixture.ts'

afterEach(cleanup)
const unusedHook = (): never => { throw new Error('Unexpected standard hook read by collaboration presentation') }
function fixture(initial: Partial<OfficeCollaborationSnapshot> = {}) {
  let snapshot: OfficeCollaborationSnapshot = { visible: true, epoch: 1, principal: guiMember, members: [guiMember, guiPeer],
    pending: false, error: null, preferences: { revision: 1, desktop: false, timeZone: 'Asia/Shanghai', sources: ['item'], quiet: null },
    inbox: { entries: [], unread: 0, next: null }, groups: [guiGroup], group: { group: guiGroup, messages: [], next: null, readThrough: 0 },
    governance: { revision: 0, policy: null, members: [] }, usage: null, audit: null, source: null, unreadOnly: false, ...initial }
  const props: OfficeCollaborationProps = {
    useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook,
    usePanelInfo: unusedHook, useResource: unusedHook, useWorkspaces: unusedHook,
    t: key => Object.hasOwn(collaborationEn, key) ? collaborationEn[key as CollaborationKey] : key,
    useCollaboration: select => select(snapshot),
    useGroupDrive: select => select({ view: null, loading: false, busy: false, error: null, search: '', canBack: false, canForward: false }),
    closeCollaboration: vi.fn(), refreshCollaboration: vi.fn(), filterCollaboration: vi.fn(async () => {}),
    moreCollaboration: vi.fn(async () => {}), saveCollaborationPreferences: vi.fn(async () => true),
    enableCollaborationDesktop: vi.fn(async () => true), openCollaborationNotice: vi.fn(async () => true),
    retryCollaborationDesktop: vi.fn(async () => true), createCollaborationGroup: vi.fn(async () => true),
    updateCollaborationGroup: vi.fn(async () => true), loadCollaborationGroup: vi.fn(async () => {}),
    leaveCollaborationGroup: vi.fn(async () => true), sendCollaborationMessage: vi.fn(async () => true),
    createCollaborationMeetings: vi.fn(async () => true), loadCollaborationGovernance: vi.fn(async () => {}),
    offboardCollaborationMember: vi.fn(async () => true), saveCollaborationPolicy: vi.fn(async () => true),
    restoreCollaborationMember: vi.fn(async () => true), resolveCollaborationFile: vi.fn(async () => null),
    fieldCollaborationAudit: vi.fn(), searchCollaborationAudit: vi.fn(async () => true), moreCollaborationAudit: vi.fn(async () => true),
    downloadCollaborationFile: vi.fn(async () => {}), exportCollaborationAudit: vi.fn(async () => {}),
  }
  const mounted = render(<OfficeCollaboration {...props} />)
  return { props, set(value: Partial<OfficeCollaborationSnapshot>) {
    snapshot = { ...snapshot, ...value }; mounted.rerender(<OfficeCollaboration {...props} />)
  } }
}
function tab(name: string) { fireEvent.click(screen.getByRole('button', { name })) }

it('preserves an unsent group message while switching to preferences and repeat meetings', () => {
  fixture()
  tab('Groups')
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Keep this draft' } })
  tab('Notification preferences')
  tab('Repeat meetings')
  tab('Groups')
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('Keep this draft')
})

it('requires confirmation before closing a group and submits its reviewed revision', async () => {
  const { props } = fixture()
  tab('Groups')
  const close = screen.getByRole('button', { name: 'Close group' })
  expect((close as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(close)
  expect(props.updateCollaborationGroup).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm closing this group and removing it from the group list' }))
  fireEvent.click(close)
  await waitFor(() => { expect(props.updateCollaborationGroup).toHaveBeenCalledWith(expect.objectContaining({
    id: guiGroup.id, revision: 3, closed: true,
  })) })
})

it('transfers ownership only to a selected current group member after confirmation', async () => {
  const { props } = fixture()
  tab('Groups')
  const transfer = screen.getByRole('button', { name: 'Transfer group ownership' })
  expect((transfer as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Blair' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm transferring ownership to the selected member' }))
  fireEvent.click(transfer)
  await waitFor(() => { expect(props.updateCollaborationGroup).toHaveBeenCalledWith(expect.objectContaining({
    revision: 3, ownerId: guiPeer.id, memberIds: [guiMember.id, guiPeer.id], closed: false,
  })) })
})

it('saves all reviewed role scopes while keeping administrator office access selected', async () => {
  const { props } = fixture()
  tab('Identity and audit')
  const office = screen.getByRole('group', { name: 'Office access' })
  const administrator = within(office).getByRole('checkbox', { name: 'Administrator' }) as HTMLInputElement
  expect(administrator.checked).toBe(true)
  expect(administrator.disabled).toBe(true)
  const files = screen.getByRole('group', { name: 'File access' })
  fireEvent.click(within(files).getByRole('checkbox', { name: 'Employee' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm saving these access rules' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(props.saveCollaborationPolicy).toHaveBeenCalledWith({ revision: 0, allowedRoles: {
    office: ['admin', 'manager', 'employee'], files: ['admin', 'manager'], connectors: ['admin', 'manager', 'employee'],
    chat: ['admin', 'manager', 'employee'], sessions: ['admin', 'manager', 'employee'],
  } }) })
})

it('retains an edited policy on concurrent change and requires explicitly loading the latest policy', () => {
  const { set, props } = fixture()
  tab('Identity and audit')
  const employee = within(screen.getByRole('group', { name: 'File access' }))
    .getByRole('checkbox', { name: 'Employee' }) as HTMLInputElement
  fireEvent.click(employee)
  set({ governance: { revision: 1, members: [], policy: { revision: 1, allowedRoles: {
    office: ['admin'], files: ['admin', 'employee'], chat: ['admin'], connectors: ['admin'], sessions: ['admin'],
  } } } })
  expect(employee.checked).toBe(false)
  expect(screen.getByText('The policy changed. Load the latest policy and review it again.')).toBeTruthy()
  expect(props.saveCollaborationPolicy).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Load latest policy' }))
  expect(employee.checked).toBe(true)
})

function receipt(stage: 'blocked' | 'revoked') {
  return { memberId: guiPeer.id, revision: 6, blocked: true, revokedScopes: ['office' as const],
    requestId: '2ef1f084-bef6-4cec-b452-b190edaa60ce', initiatedBy: guiMember.id, stage,
    sessionsRevoked: 2, invitationsRevoked: 1, countsScope: 'completing_cleanup_attempt' as const }
}

it('restores only the reviewed revoked member with explicitly retained scope restrictions', async () => {
  const { props } = fixture({ governance: { revision: 8, policy: null, members: [receipt('revoked')] } })
  tab('Identity and audit')
  fireEvent.click(screen.getByRole('button', { name: 'Blair' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Chat access' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm restoring access; old sessions and invitation codes remain revoked' }))
  fireEvent.click(screen.getByRole('button', { name: 'Restore member access' }))
  await waitFor(() => { expect(props.restoreCollaborationMember).toHaveBeenCalledWith({ memberId: guiPeer.id,
    revision: 6, requestId: expect.any(String), revokedScopes: ['chat'] }) })
})

it('continues blocked cleanup with the original initiating administrator request rather than enabling restoration', async () => {
  const record = receipt('blocked')
  const { props } = fixture({ governance: { revision: 8, policy: null, members: [record] } })
  tab('Identity and audit')
  fireEvent.click(screen.getByRole('button', { name: 'Blair' }))
  expect(screen.queryByRole('button', { name: 'Restore member access' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm revocation of the selected member’s sessions, invitations and office access' }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue cleanup' }))
  await waitFor(() => { expect(props.offboardCollaborationMember).toHaveBeenCalledWith({ memberId: guiPeer.id,
    revision: 6, requestId: record.requestId }) })
})

it('keeps an unconfirmed repeat meeting immutable across tabs and retries its exact request identity', async () => {
  const { props } = fixture()
  vi.mocked(props.createCollaborationMeetings).mockResolvedValueOnce(false)
  tab('Repeat meetings')
  fireEvent.change(screen.getByRole('textbox', { name: 'Meeting title' }), { target: { value: 'Weekly planning' } })
  fireEvent.change(screen.getByLabelText('First date'), { target: { value: '2026-11-02' } })
  fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } })
  fireEvent.change(screen.getByLabelText('End time'), { target: { value: '10:00' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  await waitFor(() => { expect(props.createCollaborationMeetings).toHaveBeenCalledTimes(1) })
  const original = vi.mocked(props.createCollaborationMeetings).mock.calls[0]?.[0]
  tab('Notification preferences')
  tab('Repeat meetings')
  expect(screen.getByRole('textbox', { name: 'Meeting title' }).matches(':disabled')).toBe(true)
  expect(screen.getByText('Meeting creation is unconfirmed. Retry the unchanged request to avoid duplicate invitations.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => { expect(props.createCollaborationMeetings).toHaveBeenCalledTimes(2) })
  expect(vi.mocked(props.createCollaborationMeetings).mock.calls[1]?.[0]).toEqual(original)
})

it('reports invalid timezone input locally without sending a preferences write', () => {
  const { props } = fixture()
  tab('Notification preferences')
  fireEvent.change(screen.getByRole('textbox', { name: 'Time zone' }), { target: { value: 'not/a-timezone' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(props.saveCollaborationPreferences).not.toHaveBeenCalled()
  expect(screen.getByText('Enter a valid time zone, such as Asia/Shanghai.')).toBeTruthy()
})

it('retains confirmed operation feedback after the dialog closes', () => {
  const { set } = fixture()
  set({ visible: false, feedback: { id: 1, key: 'collaborationSaved', success: true } })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('Saved')
})

it('shows the persistent query failure after a matching transient toast finishes', () => {
  vi.useFakeTimers()
  try {
    fixture({ error: 'collaborationNetwork', feedback: { id: 1, key: 'collaborationNetwork', success: false } })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(4000) })
    expect(screen.getByRole('alert').textContent).toBe(collaborationEn.collaborationNetwork)
  } finally { vi.useRealTimers() }
})
