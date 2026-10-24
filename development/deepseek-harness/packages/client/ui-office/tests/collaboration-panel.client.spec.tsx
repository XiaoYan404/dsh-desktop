// @vitest-environment jsdom
/** Collaboration presentation receives only derived hooks, copy and callbacks. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { brandString } from '@deepseek-ai/dsh-brand'
import { OfficeCollaboration } from '../src/client/OfficeCollaboration.tsx'
import { collaborationEn } from '../src/client/collaboration-copy.ts'
import type { CollaborationKey } from '../src/client/collaboration-copy.ts'
import type { OfficeCollaborationSnapshot } from '../src/client/collaboration-model.ts'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'

afterEach(cleanup)
const unusedHook = (): never => { throw new Error('Unexpected standard hook read') }
function fixture() {
  let snapshot: OfficeCollaborationSnapshot = { visible: true, epoch: 1, principal: { id: brandString<OfficeMemberId>('employee'), name: 'Employee', role: 'employee', active: true,
    department: '', jobTitle: '', email: '', phone: '' }, members: [], pending: false, error: null, preferences: { revision: 1, desktop: false, timeZone: 'Asia/Shanghai', sources: ['item'], quiet: null },
    inbox: { entries: [], unread: 0, next: null }, groups: [], group: null, governance: null, usage: null, audit: null, source: null, unreadOnly: false }
  const yes = vi.fn(async () => true)
  const done = vi.fn(async () => {})
  const props: ComponentProps<typeof OfficeCollaboration> = {
    useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook,
    usePanelInfo: unusedHook, useResource: unusedHook, useWorkspaces: unusedHook,
    t: key => Object.hasOwn(collaborationEn, key) ? collaborationEn[key as CollaborationKey] : key,
    useCollaboration: select => select(snapshot), useGroupDrive: select => select({ view: null, loading: false, busy: false, error: null, search: '', canBack: false, canForward: false }),
    closeCollaboration: vi.fn(), refreshCollaboration: vi.fn(), filterCollaboration: done, moreCollaboration: done,
    saveCollaborationPreferences: yes, enableCollaborationDesktop: yes, openCollaborationNotice: yes, retryCollaborationDesktop: yes,
    createCollaborationGroup: yes, updateCollaborationGroup: yes, loadCollaborationGroup: done, leaveCollaborationGroup: yes,
    sendCollaborationMessage: yes, createCollaborationMeetings: yes, loadCollaborationGovernance: done,
    offboardCollaborationMember: yes, saveCollaborationPolicy: yes, restoreCollaborationMember: yes,
    fieldCollaborationAudit: vi.fn(), searchCollaborationAudit: yes, moreCollaborationAudit: yes,
    resolveCollaborationFile: vi.fn(async () => null), downloadCollaborationFile: done, exportCollaborationAudit: done }
  const mounted = render(<OfficeCollaboration {...props} />)
  return { props, set: (value: Partial<OfficeCollaborationSnapshot>) => { snapshot = { ...snapshot, ...value }; mounted.rerender(<OfficeCollaboration {...props} />) } }
}

it('labels source and unread filters while keeping administrator controls absent for employees', () => {
  const { props } = fixture()
  expect(screen.getByRole('dialog', { name: 'Collaboration and notifications' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Mentions' }))
  expect(props.filterCollaboration).toHaveBeenCalledWith('mention', false)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Unread only' }))
  expect(props.filterCollaboration).toHaveBeenCalledWith(null, true)
  expect(screen.queryByRole('button', { name: 'Identity and audit' })).toBeNull()
})

it('saves a real timezone/quiet-hour preference without treating the local draft as confirmed state', () => {
  const { props } = fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Notification preferences' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Time zone' }), { target: { value: 'America/New_York' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Quiet hours' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(props.saveCollaborationPreferences).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, timeZone: 'America/New_York', quiet: { start: '22:00', end: '07:00' } }))
})
