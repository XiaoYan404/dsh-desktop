/** Real Loader, JSON, scrypt and one Office queue preserve limited invitation authority across failure and restart. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { expect, it, vi } from 'vitest'
import OfficeService from '../src/index.ts'
import { officeMemberInvitesDomain } from '../src/member-invitations.ts'
import { officeIdentityDomain } from '../src/identity.ts'
import { createMemberInviteFixture, issueFixtureMemberInvite, inviteAdmin, inviteTarget, invitePeer,
  invitePassword, invitePolicy } from './member-invite-fixture.ts'

const firstPassword = 'The recipient chooses this first password!'

it('keeps member invitations absent by default and validates every explicit Loader resource bound', async () => {
  const { ctx, root } = await createMemberInviteFixture({})
  expect(ctx.office.memberInviteCapability()).toBeNull()
  expect(ctx.storageDomain.get('enterprise_office_member_invites')).toBeUndefined()
  await expect(stat(join(root, 'data/enterprise_office_member_invites.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const seed = { companyName: 'Explicit invite limits', timeZone: 'Asia/Shanghai', members: [] }
  expect(() => Schema.resolve({ ...seed, memberInvites: { maxTtlMs: 1 } }, OfficeService.Config, {})).toThrow()
  expect(() => Schema.resolve({ ...seed, memberInvites: { ...invitePolicy, maxEntries: 0 } }, OfficeService.Config, {})).toThrow()
  expect(() => Schema.resolve({ ...seed, memberInvites: { ...invitePolicy, maxTtlMs: Infinity } }, OfficeService.Config, {})).toThrow()
})

it('persists hash-only issuance and one-time code receipts while retaining exact retries and role-scoped management', async () => {
  const { ctx, root } = await createMemberInviteFixture()
  const originalIdentity = await readFile(join(root, 'data/enterprise_office_identity.json'))
  const issued = await issueFixtureMemberInvite(ctx)
  expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  expect(await ctx.office.issueMemberInvite(inviteAdmin, issued.input)).toEqual({ invitation: issued.invitation })
  await expect(ctx.office.issueMemberInvite(inviteAdmin, { ...issued.input, expiresAt: issued.input.expiresAt + 1 }))
    .rejects.toMatchObject({ code: 'conflict' })
  await expect(ctx.office.memberInvite(invitePeer, inviteTarget)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(ctx.office.issueMemberInvite(invitePeer, issued.input)).rejects.toMatchObject({ code: 'forbidden' })
  const view = await ctx.office.memberInvite(inviteAdmin, inviteTarget)
  expect(view).toMatchObject({ invitation: issued.invitation, credentialPresent: false, canAccept: true, revoked: false, expired: false })
  expect(JSON.stringify(view)).not.toMatch(/tokenHash|fingerprint|code|digest|salt/u)
  const saved = await readFile(join(root, 'data/enterprise_office_member_invites.json'), 'utf8')
  expect(saved).not.toContain(issued.code)
  expect(saved).toContain(createHash('sha256').update(issued.code).digest('hex'))
  expect(await readFile(join(root, 'data/enterprise_office_identity.json'))).toEqual(originalIdentity)
})

it('commits only the recipient first credential, denies every replay or reset and retains that fact after JSON restart', async () => {
  const { ctx, root, boot } = await createMemberInviteFixture()
  const issued = await issueFixtureMemberInvite(ctx)
  const inviteBytes = await readFile(join(root, 'data/enterprise_office_member_invites.json'))
  expect(await ctx.office.acceptMemberInvite({ code: issued.code, newPassword: firstPassword })).toEqual({ memberId: inviteTarget })
  const identity = ctx.storageDomain.get('enterprise_office_identity')
  if (!identity) throw new Error('Missing real identity domain')
  const saved = officeIdentityDomain.global.schema.parse(identity.global.get())
  expect(saved.credentials.filter(row => row.memberId === inviteTarget)).toHaveLength(1)
  expect(saved.sessions.filter(row => row.memberId === inviteTarget)).toHaveLength(0)
  expect(saved.audit.at(-1)).toMatchObject({ action: 'credential_set', actorId: inviteTarget, targetId: inviteTarget })
  expect(await readFile(join(root, 'data/enterprise_office_member_invites.json'))).toEqual(inviteBytes)
  const credentialBytes = await readFile(join(root, 'data/enterprise_office_identity.json'))
  await expect(ctx.office.acceptMemberInvite({ code: issued.code, newPassword: 'A different password cannot reset it!' }))
    .rejects.toMatchObject({ code: 'unauthenticated' })
  expect(await readFile(join(root, 'data/enterprise_office_identity.json'))).toEqual(credentialBytes)
  await ctx.fiber.dispose()
  const restarted = await boot()
  expect(await restarted.office.memberInvite(inviteAdmin, inviteTarget)).toMatchObject({ credentialPresent: true, canAccept: false })
  await expect(restarted.office.acceptMemberInvite({ code: issued.code, newPassword: firstPassword }))
    .rejects.toMatchObject({ code: 'unauthenticated' })
  expect((await restarted.office.login({ memberId: inviteTarget, password: firstPassword })).member.id).toBe(inviteTarget)
})

it('revokes prior codes on reissue and rejects expired revoked inactive and reviewed-role-changed invitations', async () => {
  const { ctx } = await createMemberInviteFixture()
  const first = await issueFixtureMemberInvite(ctx)
  const second = await issueFixtureMemberInvite(ctx)
  await expect(ctx.office.acceptMemberInvite({ code: first.code, newPassword: firstPassword })).rejects.toMatchObject({ code: 'unauthenticated' })
  const revoked = await ctx.office.revokeMemberInvite(inviteAdmin, { id: second.invitation.id, revision: 1 })
  expect(await ctx.office.revokeMemberInvite(inviteAdmin, { id: second.invitation.id, revision: 1 })).toEqual(revoked)
  await expect(ctx.office.acceptMemberInvite({ code: second.code, newPassword: firstPassword })).rejects.toMatchObject({ code: 'unauthenticated' })
  const third = await issueFixtureMemberInvite(ctx)
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(third.invitation.expiresAt)
  await expect(ctx.office.acceptMemberInvite({ code: third.code, newPassword: firstPassword })).rejects.toMatchObject({ code: 'unauthenticated' })
  expect((await ctx.office.memberInvite(inviteAdmin, inviteTarget)).expired).toBe(true)
  vi.mocked(Date.now).mockRestore()
  expect(Date.now()).toBeGreaterThanOrEqual(now)
  const member = ctx.office.view(inviteAdmin).members.find(row => row.id === inviteTarget)
  if (!member) throw new Error('Missing original target')
  await ctx.office.saveMember(inviteAdmin, { ...member, role: 'manager' }, member)
  await expect(ctx.office.acceptMemberInvite({ code: third.code, newPassword: firstPassword })).rejects.toMatchObject({ code: 'unauthenticated' })
  expect((await ctx.office.memberInvite(inviteAdmin, inviteTarget)).requiresReview).toBe(true)
  await ctx.office.saveMember(inviteAdmin, { ...member, active: false }, { ...member, role: 'manager' })
  await expect(ctx.office.issueMemberInvite(inviteAdmin, { requestId: randomUUID(), memberId: inviteTarget,
    expectedRole: 'employee', expiresAt: Date.now() + 1000 })).rejects.toMatchObject({ code: 'conflict' })
})

it('rejects over-capacity issuance and retains a usable code when its real identity commit fails', async () => {
  const limited = await createMemberInviteFixture({ memberInvites: { ...invitePolicy, maxEntries: 1 } })
  const issued = await issueFixtureMemberInvite(limited.ctx)
  await expect(issueFixtureMemberInvite(limited.ctx)).rejects.toMatchObject({ code: 'conversation_capacity' })
  expect((await limited.ctx.office.memberInvite(inviteAdmin, inviteTarget)).invitation).toEqual(issued.invitation)
  const identity = limited.ctx.storageDomain.get('enterprise_office_identity')
  if (!identity) throw new Error('Missing actual identity provider')
  vi.spyOn(identity.global, 'set').mockRejectedValueOnce(new Error('Injected fixture disk write failure'))
  await expect(limited.ctx.office.acceptMemberInvite({ code: issued.code, newPassword: firstPassword })).rejects.toThrow('fixture disk write failure')
  expect((await limited.ctx.office.memberInvite(inviteAdmin, inviteTarget)).canAccept).toBe(true)
  expect(await limited.ctx.office.acceptMemberInvite({ code: issued.code, newPassword: firstPassword })).toEqual({ memberId: inviteTarget })
  const byteLimited = await createMemberInviteFixture({ memberInvites: { ...invitePolicy, maxBytes: 1 } })
  await expect(issueFixtureMemberInvite(byteLimited.ctx)).rejects.toMatchObject({ code: 'conversation_capacity' })
  expect((await byteLimited.ctx.office.memberInvite(inviteAdmin, inviteTarget)).invitation).toBeNull()
})

it('allows only one first credential when two real scrypt acceptances compete', async () => {
  const { ctx } = await createMemberInviteFixture()
  const issued = await issueFixtureMemberInvite(ctx)
  const results = await Promise.allSettled([ctx.office.acceptMemberInvite({ code: issued.code, newPassword: firstPassword }),
    ctx.office.acceptMemberInvite({ code: issued.code, newPassword: firstPassword })])
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(row => row.status === 'rejected')).toHaveLength(1)
  const domain = ctx.storageDomain.get('enterprise_office_identity')
  if (!domain) throw new Error('Missing real identity state')
  const identity = officeIdentityDomain.global.schema.parse(domain.global.get())
  expect(identity.audit.filter(row => row.action === 'credential_set' && row.targetId === inviteTarget)).toHaveLength(1)
})

it('rechecks a code after hashing and drains canceled first-password work before closing its domains', async () => {
  const { ctx, boot } = await createMemberInviteFixture()
  const issued = await issueFixtureMemberInvite(ctx)
  const domain = ctx.storageDomain.get('enterprise_office_member_invites')
  if (!domain) throw new Error('Missing real invitation ledger')
  const set = domain.global.set.bind(domain.global)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
    entered.resolve(undefined)
    await release.promise
    return set(value)
  })
  const revoking = ctx.office.revokeMemberInvite(inviteAdmin, { id: issued.invitation.id, revision: 1 })
  await entered.promise
  const accepting = ctx.office.acceptMemberInvite({ code: issued.code, newPassword: firstPassword })
  const rejected = Promise.allSettled([accepting])
  release.resolve(undefined)
  await revoking
  expect((await rejected)[0]).toMatchObject({ status: 'rejected', reason: { code: 'unauthenticated' } })
  const next = await issueFixtureMemberInvite(ctx)
  let settled = false
  const pending = ctx.office.acceptMemberInvite({ code: next.code, newPassword: firstPassword })
    .then(() => { settled = true }, () => { settled = true })
  await ctx.fiber.dispose()
  expect(settled).toBe(true)
  await pending
  const restarted = await boot()
  const identity = restarted.storageDomain.get('enterprise_office_identity')
  if (!identity) throw new Error('Missing restored identity')
  expect(officeIdentityDomain.global.schema.parse(identity.global.get()).credentials.some(row => row.memberId === inviteTarget)).toBe(false)
  const invitations = restarted.storageDomain.get('enterprise_office_member_invites')
  if (!invitations) throw new Error('Missing restored ledger')
  expect(officeMemberInvitesDomain.global.schema.parse(invitations.global.get()).entries).toHaveLength(2)
  expect((await restarted.office.login({ memberId: inviteAdmin, password: invitePassword })).member.id).toBe(inviteAdmin)
})
