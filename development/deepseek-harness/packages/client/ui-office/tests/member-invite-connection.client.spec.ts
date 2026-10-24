/** Optional activation discovery never blocks existing sign-in and never authenticates a new member by itself. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { OfficeMemberId, OfficeMemberInviteCapability } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnection, OfficeOutcome } from '../src/types.ts'
import { OfficeConnectionModel } from '../src/client/connection-model.ts'

type Remote = ConstructorParameters<typeof OfficeConnectionModel>[0]
function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
const disconnected: OfficeConnection = { mode: 'gateway', gateway: 'https://office.example.invalid',
  connected: false, member: null, expiresAt: null }
const capability: OfficeMemberInviteCapability = { protocol: 1, maxTtlMs: 86400000 }
const member = { id: 'new-member' as OfficeMemberId, name: 'New member', department: 'Office', jobTitle: 'Employee',
  email: '', phone: '', role: 'employee' as const, active: true }
const connected: OfficeConnection = { ...disconnected, connected: true, member, expiresAt: 2000000000000 }

function fixture(cap?: NonNullable<Remote['memberInviteCapability']>) {
  const remote = { connection: vi.fn<Remote['connection']>().mockResolvedValue(ok(disconnected)),
    signIn: vi.fn<Remote['signIn']>().mockResolvedValue(ok(connected)), signOut: vi.fn<Remote['signOut']>(),
    identitySessions: vi.fn<Remote['identitySessions']>(), revokeIdentitySession: vi.fn<Remote['revokeIdentitySession']>(),
    changeIdentityPassword: vi.fn<Remote['changeIdentityPassword']>(), identityOverview: vi.fn<Remote['identityOverview']>(),
    setIdentityPassword: vi.fn<Remote['setIdentityPassword']>(), ...cap ? { memberInviteCapability: cap } : {} }
  const changed = vi.fn()
  const notify = vi.fn()
  const model = new OfficeConnectionModel(remote, changed, notify)
  onTestFinished(() => { model.dispose() })
  return { model, remote, changed, notify }
}

it('keeps legacy gateways and local sign-in usable without invitation discovery', async () => {
  const { model, remote } = fixture()
  await model.load()
  expect(model.state.getSnapshot()).toMatchObject({ loading: false, error: null, connection: disconnected, memberInvitations: null })
  expect(await model.signIn({ memberId: member.id, password: 'Reviewed first password!' })).toBe(true)
  expect(remote.signIn).toHaveBeenCalledTimes(1)
  expect(model.state.getSnapshot().connection?.member?.id).toBe(member.id)
})

it('publishes ordinary login before a slow invitation-capability response', async () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<NonNullable<Remote['memberInviteCapability']>>>>()
  const discover = vi.fn<NonNullable<Remote['memberInviteCapability']>>().mockReturnValue(pending.promise)
  const { model } = fixture(discover)
  await model.load()
  expect(model.state.getSnapshot()).toMatchObject({ loading: false, connection: disconnected, error: null })
  expect(discover).toHaveBeenCalledTimes(1)
  pending.resolve(ok(capability))
  await Promise.resolve()
  expect(model.state.getSnapshot().memberInvitations).toEqual(capability)
})

it('hides invitation discovery failures without turning them into sign-in errors', async () => {
  const discover = vi.fn<NonNullable<Remote['memberInviteCapability']>>().mockResolvedValue({ ok: false,
    error: new RemoteError('gateway/internal', 'Optional capability unavailable', {}) })
  const { model, notify } = fixture(discover)
  await model.load()
  await Promise.resolve()
  expect(model.state.getSnapshot()).toMatchObject({ memberInvitations: null, error: null, connection: disconnected })
  expect(notify).not.toHaveBeenCalled()
})

it('discards discovery from a previous employee and after disposal', async () => {
  const old = Promise.withResolvers<Awaited<ReturnType<NonNullable<Remote['memberInviteCapability']>>>>()
  const last = Promise.withResolvers<Awaited<ReturnType<NonNullable<Remote['memberInviteCapability']>>>>()
  const discover = vi.fn<NonNullable<Remote['memberInviteCapability']>>().mockReturnValueOnce(old.promise).mockReturnValueOnce(last.promise)
  const { model, remote } = fixture(discover)
  await model.load()
  remote.connection.mockResolvedValueOnce(ok(connected))
  await model.load()
  old.resolve(ok(capability))
  await Promise.resolve()
  expect(model.state.getSnapshot().memberInvitations).toBeUndefined()
  model.dispose()
  last.resolve(ok(capability))
  await Promise.resolve()
  expect(model.state.getSnapshot()).toMatchObject({ connection: null, loading: false })
  expect(model.state.getSnapshot().memberInvitations).toBeUndefined()
})

it('prefills only the confirmed public identity and requires the original login operation', async () => {
  const { model, remote } = fixture()
  await model.load()
  model.prepareInvitedSignIn(member.id)
  expect(model.state.getSnapshot().invitedMemberId).toBe(member.id)
  expect(model.state.getSnapshot().connection?.connected).toBe(false)
  expect(remote.signIn).not.toHaveBeenCalled()
  remote.connection.mockResolvedValueOnce(ok(connected))
  await model.load()
  model.prepareInvitedSignIn('someone-else' as OfficeMemberId)
  expect(model.state.getSnapshot().invitedMemberId).toBeNull()
  expect(remote.signIn).not.toHaveBeenCalled()
})
