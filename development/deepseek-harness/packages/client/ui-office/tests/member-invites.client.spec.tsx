// @vitest-environment jsdom
/** Employee-visible invitation forms keep one-time codes transient and preserve failed activation input. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { OfficeMember, OfficeMemberId, OfficeMemberInvite, OfficeMemberInviteId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeMemberInvites } from '../src/client/OfficeMemberInvites.tsx'
import type { OfficeMemberInvitesModel } from '../src/client/member-invites-model.ts'
import { en, zh } from '../src/client/locales.ts'
import type { OfficeKey } from '../src/client/locales.ts'

type Props = Parameters<typeof OfficeMemberInvites>[0]
type Snapshot = ReturnType<OfficeMemberInvitesModel['state']['getSnapshot']>
const member: OfficeMember = { id: 'new-member' as OfficeMemberId, name: 'New member', department: 'Office', jobTitle: 'Employee',
  email: '', phone: '', role: 'employee', active: true }
const invitation: OfficeMemberInvite = { id: '9f84d36c-3747-45cd-898c-c33871679102' as OfficeMemberInviteId, revision: 1,
  memberId: member.id, role: member.role, issuedBy: 'admin' as OfficeMemberId, issuedAt: 100,
  expiresAt: 2000000000000, revokedAt: null, revokedBy: null }
const code = 'D'.repeat(43)

function input(label: string): HTMLInputElement {
  const element = screen.getByLabelText(label)
  if (!(element instanceof HTMLInputElement)) throw new Error(`Expected an input labelled ${label}`)
  return element
}

function fixture(mode: 'member' | 'activate' = 'member', chinese = false) {
  const initial: Snapshot = { epoch: 1, mode, member: mode === 'member' ? member : null,
    view: mode === 'member' ? { protocol: 1, memberId: member.id, invitation: null, credentialPresent: false,
      expired: false, revoked: false, requiresReview: false, canAccept: false } : null,
    maxTtlMs: 86400000, loading: false, busy: false, pending: null, error: null }
  const state = createSnapshotStore(initial)
  const copy = chinese ? zh : en
  const props: Props = {
    t: (key: OfficeKey) => copy[key],
    useMemberInvites: selector => selector(useSyncExternalStore(listener => state.subscribe(listener), () => state.getSnapshot())),
    closeMemberInvites: vi.fn(() => { state.set({ ...initial, epoch: 2, mode: 'closed' }) }),
    refreshMemberInvites: vi.fn(),
    issueMemberInvite: vi.fn<Props['issueMemberInvite']>().mockImplementation(async () => {
      state.set({ ...state.getSnapshot(), pending: null, view: initial.view ? { ...initial.view, invitation, canAccept: true } : null })
      return { invitation, code }
    }),
    revokeMemberInvite: vi.fn<Props['revokeMemberInvite']>().mockResolvedValue(true),
    acceptMemberInvite: vi.fn<Props['acceptMemberInvite']>().mockResolvedValue(false),
  }
  onTestFinished(cleanup)
  render(<OfficeMemberInvites {...props} />)
  return { props, state, initial, copy }
}

it('shows an issued code once and copies only after the administrator explicitly clicks', async () => {
  const { props } = fixture()
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  onTestFinished(() => {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  fireEvent.change(screen.getByLabelText(en.memberInviteExpiry), { target: { value: '2033-05-18T12:30:00' } })
  fireEvent.click(screen.getByRole('button', { name: en.memberInviteIssue }))
  await waitFor(() => { expect(input(en.memberInviteCode).value).toBe(code) })
  expect(props.issueMemberInvite).toHaveBeenCalledWith(new Date('2033-05-18T12:30:00').getTime(), false)
  expect(writeText).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.memberInviteCopy }))
  await waitFor(() => { expect(screen.getByText(en.memberInviteCopied).textContent).toBe(en.memberInviteCopied) })
  expect(writeText).toHaveBeenCalledExactlyOnceWith(code)
})

it('retries uncertain issuance without replacing reviewed values or inventing a recoverable code', async () => {
  const { props, state, initial } = fixture()
  act(() => { state.set({ ...initial, pending: 'issue', error: 'memberInviteUnknown' }) })
  expect(input(en.memberInviteExpiry).disabled).toBe(true)
  vi.mocked(props.issueMemberInvite).mockImplementationOnce(async () => {
    state.set({ ...initial, view: initial.view ? { ...initial.view, invitation, canAccept: true } : null })
    return { invitation }
  })
  fireEvent.click(screen.getByRole('button', { name: en.memberInviteRetry }))
  await waitFor(() => { expect(screen.getByText(en.memberInviteNoCode).textContent).toBe(en.memberInviteNoCode) })
  expect(props.issueMemberInvite).toHaveBeenCalledExactlyOnceWith(0, true)
  expect(screen.queryByLabelText(en.memberInviteCode)).toBeNull()
})

it('keeps failed Chinese activation input, checks matching passwords and clears it after success', async () => {
  const { props, state, initial } = fixture('activate', true)
  const password = 'Recipient first password!'
  fireEvent.change(screen.getByLabelText(zh.memberInviteCode), { target: { value: code } })
  fireEvent.change(screen.getByLabelText(zh.newPassword), { target: { value: password } })
  fireEvent.change(screen.getByLabelText(zh.confirmPassword), { target: { value: 'Different first password!' } })
  fireEvent.click(screen.getByRole('button', { name: zh.memberInviteConfirm }))
  expect(props.acceptMemberInvite).not.toHaveBeenCalled()
  fireEvent.input(screen.getByLabelText(zh.confirmPassword), { target: { value: password } })
  vi.mocked(props.acceptMemberInvite).mockImplementationOnce(async () => {
    state.set({ ...initial, error: 'memberInviteAcceptUnknown' })
    return false
  })
  fireEvent.click(screen.getByRole('button', { name: zh.memberInviteConfirm }))
  await waitFor(() => { expect(screen.getByText(zh.memberInviteAcceptUnknown).textContent).toBe(zh.memberInviteAcceptUnknown) })
  expect(input(zh.memberInviteCode).value).toBe(code)
  expect(input(zh.newPassword).value).toBe(password)
  vi.mocked(props.acceptMemberInvite).mockImplementationOnce(async () => {
    state.set({ ...initial, epoch: 2, mode: 'closed' })
    return true
  })
  fireEvent.click(screen.getByRole('button', { name: zh.memberInviteConfirm }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(document.body.textContent).not.toContain(code)
})

it('removes a previously displayed code when the overlay closes and reopens for a new epoch', async () => {
  const { state, initial } = fixture()
  fireEvent.click(screen.getByRole('button', { name: en.memberInviteIssue }))
  await waitFor(() => { expect(input(en.memberInviteCode).value).toBe(code) })
  act(() => { state.set({ ...initial, epoch: 3, view: initial.view ? { ...initial.view, invitation } : null }) })
  expect(screen.queryByLabelText(en.memberInviteCode)).toBeNull()
  expect(screen.queryByRole('button', { name: en.memberInviteCopy })).toBeNull()
})
