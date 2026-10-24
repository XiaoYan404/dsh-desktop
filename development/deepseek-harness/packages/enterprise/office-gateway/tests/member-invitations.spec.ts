/** New invitation routes are exercised through an actual central HTTP listener and real JSON identity commits. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { officeIdentityDomain } from '../../office/src/identity.ts'
import { inviteAdmin, invitePassword, invitePolicy, inviteTarget, issueFixtureMemberInvite } from '../../office/tests/member-invite-fixture.ts'
import { createMemberInviteGateway, postMemberInvite } from './member-invite-fixture.ts'

const password = 'A recipient selected first password 2026!'
const signedIn = z.object({ ok: z.literal(true), value: z.looseObject({ token: z.string() }) }).strict()
const issued = z.object({ ok: z.literal(true), value: z.object({
  invitation: z.looseObject({ id: z.uuid(), revision: z.number() }), code: z.string(),
}).strict() }).strict()

it('issues and accepts a real HTTP invitation without creating a session and preserves administrator-only management', async () => {
  const { ctx, root, address } = await createMemberInviteGateway()
  expect(await (await fetch(new URL('/health', address))).json()).toEqual({ protocol: 'office.v1',
    memberInvites: { protocol: 1, maxTtlMs: invitePolicy.maxTtlMs } })
  const login = await postMemberInvite(address, '/v1/login', { memberId: inviteAdmin, password: invitePassword })
  const { value: administrator } = signedIn.parse(await login.json())
  const input = { requestId: randomUUID(), memberId: inviteTarget, expectedRole: 'employee', expiresAt: Date.now() + 600000 }
  const receipt = await postMemberInvite(address, '/v1/rpc', { method: 'issueMemberInvite', args: [input] }, administrator.token)
  expect(receipt.status).toBe(200)
  const { value } = issued.parse(await receipt.json())
  const retry = await postMemberInvite(address, '/v1/rpc', { method: 'issueMemberInvite', args: [input] }, administrator.token)
  expect(await retry.json()).toEqual({ ok: true, value: { invitation: value.invitation } })
  const denied = await postMemberInvite(address, '/v1/rpc', { method: 'memberInvite', args: [inviteTarget] })
  expect(denied.status).toBe(401)
  const spoofed = await postMemberInvite(address, '/v1/invitations/accept', { code: value.code, newPassword: password,
    memberId: inviteAdmin, role: 'admin' })
  expect(spoofed.status).toBe(400)
  const accepted = await postMemberInvite(address, '/v1/invitations/accept', { code: value.code, newPassword: password })
  expect(accepted.status).toBe(200)
  expect(accepted.headers.get('cache-control')).toBe('no-store')
  expect(accepted.headers.get('set-cookie')).toBeNull()
  expect(await accepted.json()).toEqual({ ok: true, value: { memberId: inviteTarget } })
  const identityProvider = ctx.storageDomain.get('enterprise_office_identity')
  if (!identityProvider) throw new Error('Missing actual identity provider')
  const identity = officeIdentityDomain.global.schema.parse(identityProvider.global.get())
  expect(identity.sessions.filter(row => row.memberId === inviteTarget)).toHaveLength(0)
  const saved = await readFile(join(root, 'data/enterprise_office_identity.json'), 'utf8')
  expect(saved).not.toContain(password)
  expect(saved).not.toContain(value.code)
  const targetLogin = await postMemberInvite(address, '/v1/login', { memberId: inviteTarget, password })
  const target = signedIn.parse(await targetLogin.json()).value
  const forbidden = await postMemberInvite(address, '/v1/rpc', { method: 'memberInvite', args: [inviteTarget] }, target.token)
  expect(forbidden.status).toBe(403)
  const reset = await postMemberInvite(address, '/v1/invitations/accept', { code: value.code, newPassword: 'Another password must never reset it!' })
  expect(reset.status).toBe(401)
  const publicRpc = await postMemberInvite(address, '/v1/rpc', { method: 'acceptMemberInvite', args: [{ code: value.code, newPassword: password }] }, administrator.token)
  expect(publicRpc.status).toBe(400)
  expect((await ctx.office.memberInvite(inviteAdmin, inviteTarget)).credentialPresent).toBe(true)
})

it('retains origin body and separate source budgets on the pre-login invitation endpoint', async () => {
  const { address } = await createMemberInviteGateway(undefined, 1)
  const body = { code: 'A'.repeat(43), newPassword: password }
  const origin = await fetch(new URL('/v1/invitations/accept', address), { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.invalid' }, body: JSON.stringify(body) })
  expect(origin.status).toBe(403)
  expect((await postMemberInvite(address, '/v1/invitations/accept', body)).status).toBe(401)
  const limited = await postMemberInvite(address, '/v1/invitations/accept', body)
  expect(limited.status).toBe(429)
  expect(limited.headers.get('retry-after')).toBe('60')
  expect(await limited.json()).toEqual({ ok: false, code: 'rate_limited' })
  const login = await postMemberInvite(address, '/v1/login', { memberId: inviteAdmin, password: invitePassword })
  expect(login.status).toBe(200)
  const bounded = await createMemberInviteGateway()
  const oversized = await postMemberInvite(bounded.address, '/v1/invitations/accept', { ...body, padding: 'x'.repeat(8192) })
  expect(oversized.status).toBe(400)
  expect(await oversized.json()).toEqual({ ok: false, code: 'invalid_input' })
  const disabled = await createMemberInviteGateway({})
  expect(await (await fetch(new URL('/health', disabled.address))).json()).toEqual({ protocol: 'office.v1' })
  expect((await postMemberInvite(disabled.address, '/v1/invitations/accept', body)).status).toBe(403)
})

it('returns a sanitized HTTP failure and leaves an invitation usable after an actual credential provider commit fails', async () => {
  const { ctx, address } = await createMemberInviteGateway()
  const value = await issueFixtureMemberInvite(ctx)
  const identity = ctx.storageDomain.get('enterprise_office_identity')
  if (!identity) throw new Error('Missing real invitation credential provider')
  vi.spyOn(identity.global, 'set').mockRejectedValueOnce(new Error(`Private fixture failure ${value.code} ${password}`))
  const failed = await postMemberInvite(address, '/v1/invitations/accept', { code: value.code, newPassword: password })
  expect(failed.status).toBe(503)
  expect(await failed.text()).toBe('{"ok":false,"code":"unavailable"}')
  expect((await ctx.office.memberInvite(inviteAdmin, inviteTarget)).canAccept).toBe(true)
  const accepted = await postMemberInvite(address, '/v1/invitations/accept', { code: value.code, newPassword: password })
  expect(await accepted.json()).toEqual({ ok: true, value: { memberId: inviteTarget } })
})
