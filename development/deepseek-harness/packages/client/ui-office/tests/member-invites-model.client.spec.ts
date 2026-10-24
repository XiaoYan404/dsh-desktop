/** Current identity, exact retries and one-time secret disclosure around onboarding commands. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeMember, OfficeMemberId, OfficeMemberInvite, OfficeMemberInviteId,
  OfficeMemberInviteView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnection, OfficeOutcome } from '../src/types.ts'
import { OfficeMemberInvitesModel } from '../src/client/member-invites-model.ts'

type Remote = ConstructorParameters<typeof OfficeMemberInvitesModel>[0]
const member: OfficeMember = { id: 'new-member' as OfficeMemberId, name: 'New member', department: 'Office', jobTitle: 'Employee',
  email: '', phone: '', role: 'employee', active: true }
const admin: OfficeConnection = { mode: 'gateway', gateway: 'https://office.example.invalid', connected: true,
  member: { ...member, id: 'admin' as OfficeMemberId, name: 'Admin', role: 'admin' }, expiresAt: 2000000000000 }
const guest: OfficeConnection = { ...admin, connected: false, member: null, expiresAt: null }
const capability = { protocol: 1 as const, maxTtlMs: 86400000 }
const code = 'C'.repeat(43)
const password = 'Reviewed first password!'
const invite: OfficeMemberInvite = { id: 'e8a58ec5-30c1-4d27-966c-42dcb334a62f' as OfficeMemberInviteId,
  revision: 1, memberId: member.id, role: member.role, issuedBy: admin.member!.id, issuedAt: 100, expiresAt: 100000,
  revokedAt: null, revokedBy: null }
function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
function unavailable<T>(): RemoteResult<OfficeOutcome<T>> {
  return { ok: false, error: new RemoteError('gateway/internal', 'Acknowledgement unavailable', {}) }
}

async function fixture(activate = false) {
  let current: OfficeMemberInvite | null = null
  const view = (): OfficeMemberInviteView => ({ protocol: 1, memberId: member.id, invitation: current,
    credentialPresent: false, expired: false, revoked: current?.revokedAt !== null && current !== null,
    requiresReview: false, canAccept: current !== null && current.revokedAt === null })
  const remote = { memberInvite: vi.fn<Remote['memberInvite']>().mockImplementation(async () => ok(view())),
    issueMemberInvite: vi.fn<Remote['issueMemberInvite']>().mockImplementation(async (input) => {
      current = { ...invite, role: input.expectedRole, expiresAt: input.expiresAt }
      return ok({ invitation: current, code })
    }),
    revokeMemberInvite: vi.fn<Remote['revokeMemberInvite']>().mockImplementation(async () => {
      current = { ...current ?? invite, revision: 2, revokedAt: 200, revokedBy: admin.member!.id }
      return ok(current)
    }),
    acceptMemberInvite: vi.fn<Remote['acceptMemberInvite']>().mockResolvedValue(ok({ memberId: member.id })),
  }
  const activated = vi.fn()
  const notify = vi.fn()
  const model = new OfficeMemberInvitesModel(remote, activated, notify)
  onTestFinished(() => { model.dispose() })
  model.bind(activate ? guest : admin, capability, [member])
  model.open(activate ? null : member.id)
  await Promise.resolve()
  return { model, remote, activated, notify, view, current: () => current }
}

it('returns the first code only to the caller and stores safe administrator metadata', async () => {
  const { model, remote } = await fixture()
  const result = await model.issue(50000)
  expect(result?.code).toBe(code)
  expect(remote.issueMemberInvite.mock.calls[0]?.[0]).toMatchObject({ memberId: member.id, expectedRole: 'employee', expiresAt: 50000 })
  expect(model.state.getSnapshot()).toMatchObject({ busy: false, pending: null, view: { memberId: member.id } })
  expect(JSON.stringify(model.state.getSnapshot())).not.toContain(code)
  expect(JSON.stringify(model.state.getSnapshot())).not.toContain('tokenHash')
})

it('retries the exact issue request after a lost receipt without inventing a replacement code', async () => {
  const { model, remote } = await fixture()
  remote.issueMemberInvite.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(ok({ invitation: invite }))
  expect(await model.issue(50000)).toBeNull()
  expect(model.state.getSnapshot()).toMatchObject({ pending: 'issue', error: 'memberInviteUnknown', busy: false })
  expect(await model.issue(60000)).toBeNull()
  expect((await model.issue(0, true))?.code).toBeUndefined()
  expect(remote.issueMemberInvite).toHaveBeenCalledTimes(2)
  expect(remote.issueMemberInvite.mock.calls[1]?.[0]).toBe(remote.issueMemberInvite.mock.calls[0]?.[0])
  expect(model.state.getSnapshot().pending).toBeNull()
})

it('withholds a late code when another employee replaces its issuing administrator', async () => {
  const { model, remote } = await fixture()
  const late = Promise.withResolvers<Awaited<ReturnType<Remote['issueMemberInvite']>>>()
  remote.issueMemberInvite.mockReturnValueOnce(late.promise)
  const issuing = model.issue(50000)
  model.bind({ ...admin, member }, capability, [member])
  late.resolve(ok({ invitation: invite, code }))
  expect(await issuing).toBeNull()
  expect(model.state.getSnapshot()).toMatchObject({ mode: 'closed', member: null, view: null })
  expect(JSON.stringify(model.state.getSnapshot())).not.toContain(code)
})

it('retries only the reviewed revocation after an uncertain response', async () => {
  const { model, remote } = await fixture()
  await model.issue(50000)
  remote.revokeMemberInvite.mockResolvedValueOnce(unavailable())
  expect(await model.revoke()).toBe(false)
  expect(model.state.getSnapshot().pending).toBe('revoke')
  expect(await model.issue(60000)).toBeNull()
  expect(await model.revoke()).toBe(true)
  expect(remote.revokeMemberInvite.mock.calls[1]?.[0]).toBe(remote.revokeMemberInvite.mock.calls[0]?.[0])
  expect(remote.revokeMemberInvite.mock.calls[0]?.[0]).toEqual({ id: invite.id, revision: 1 })
  expect(model.state.getSnapshot().pending).toBeNull()
})

it('sets the first password without storing secrets or signing the recipient in', async () => {
  const { model, remote, activated, notify } = await fixture(true)
  expect(await model.accept(code, password)).toBe(true)
  expect(remote.acceptMemberInvite).toHaveBeenCalledWith({ code, newPassword: password })
  expect(activated).toHaveBeenCalledExactlyOnceWith(member.id)
  expect(notify).toHaveBeenCalledWith('memberInviteAccepted', true)
  expect(model.state.getSnapshot().mode).toBe('closed')
  expect(JSON.stringify(model.state.getSnapshot())).not.toContain(code)
  expect(JSON.stringify(model.state.getSnapshot())).not.toContain(password)
})

it.each(['transport', 'invalid'] as const)('retains the activation form with an appropriate safe error (%s)', async (kind) => {
  const { model, remote, activated } = await fixture(true)
  remote.acceptMemberInvite.mockResolvedValueOnce(kind === 'transport' ? unavailable()
    : { ok: true, value: { ok: false, code: 'invalid_input' } })
  expect(await model.accept(code, password)).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ mode: 'activate', busy: false,
    error: kind === 'transport' ? 'memberInviteAcceptUnknown' : 'memberInviteInvalid' })
  expect(activated).not.toHaveBeenCalled()
  expect(JSON.stringify(model.state.getSnapshot())).not.toContain(password)
})

it('does not prefill another identity when activation finishes after sign-in', async () => {
  const { model, remote, activated } = await fixture(true)
  const late = Promise.withResolvers<Awaited<ReturnType<Remote['acceptMemberInvite']>>>()
  remote.acceptMemberInvite.mockReturnValueOnce(late.promise)
  const accepting = model.accept(code, password)
  model.bind({ ...admin, member }, capability, [member])
  late.resolve(ok({ memberId: member.id }))
  expect(await accepting).toBe(false)
  expect(activated).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().mode).toBe('closed')
})

it('withdraws metadata when the optional feature or reviewed member role changes', async () => {
  const { model, remote } = await fixture()
  await model.issue(50000)
  const oldEpoch = model.state.getSnapshot().epoch
  model.bind(admin, capability, [{ ...member, role: 'manager' }])
  expect(model.state.getSnapshot().mode).toBe('closed')
  expect(model.state.getSnapshot().epoch).toBeGreaterThan(oldEpoch)
  model.open(member.id)
  await Promise.resolve()
  model.bind(admin, null, [member])
  expect(await model.issue(50000)).toBeNull()
  expect(remote.issueMemberInvite).toHaveBeenCalledTimes(1)
  expect(model.state.getSnapshot()).toMatchObject({ mode: 'closed', view: null })
})
