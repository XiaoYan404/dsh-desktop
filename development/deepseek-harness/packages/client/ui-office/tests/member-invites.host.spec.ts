/** Actual Host BFFs use central first-password invitations without obtaining or replacing any automatic login. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { listenHttp } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { inviteAdmin, inviteTarget, invitePeer, invitePassword, invitePolicy } from '../../../enterprise/office/tests/member-invite-fixture.ts'
import { createMemberInviteGateway } from '../../../enterprise/office-gateway/tests/member-invite-fixture.ts'
import OfficePlugin, { OfficeController } from '../src/index.ts'

const key = credentialKey('client-ui-office', 'office-session')
const password = 'Recipient first password from local Host 2026!'

async function invitationHost(address: string) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(OfficePlugin, { gatewayUrl: address })
  const controller: unknown = ctx.get('officeController')
  if (!(controller instanceof OfficeController)) throw new Error('Actual invitation Host BFF did not activate')
  return { ctx, controller }
}

it('uses real invitation BFFs before login and preserves existing Host credentials when a limited recipient sets a first password', async () => {
  const central = await createMemberInviteGateway()
  const admin = await invitationHost(central.address)
  const recipient = await invitationHost(central.address)
  expect(await recipient.controller.connection()).toMatchObject({ ok: true, value: { connected: false, member: null } })
  expect(await recipient.controller.memberInviteCapability()).toEqual({ ok: true,
    value: { protocol: 1, maxTtlMs: invitePolicy.maxTtlMs } })
  expect(await recipient.ctx.credentials.readRecord(key)).toBeUndefined()
  expect(await recipient.controller.memberInvite(inviteTarget)).toEqual({ ok: false, code: 'unauthenticated' })
  expect(await admin.controller.signIn({ memberId: inviteAdmin, password: invitePassword })).toMatchObject({ ok: true,
    value: { connected: true, member: { id: inviteAdmin } } })
  const input = { requestId: randomUUID(), memberId: inviteTarget, expectedRole: 'employee' as const, expiresAt: Date.now() + 600000 }
  const issued = await admin.controller.issueMemberInvite(input)
  if (!issued.ok || !issued.value.code) throw new Error('Actual administrator BFF did not return its first code receipt')
  expect(await admin.controller.issueMemberInvite(input)).toEqual({ ok: true, value: { invitation: issued.value.invitation } })
  expect(await admin.controller.memberInvite(inviteTarget)).toMatchObject({ ok: true,
    value: { canAccept: true, credentialPresent: false } })
  expect(await recipient.controller.acceptMemberInvite({ code: issued.value.code, newPassword: password }))
    .toEqual({ ok: true, value: { memberId: inviteTarget } })
  expect(await recipient.ctx.credentials.readRecord(key)).toBeUndefined()
  expect(await recipient.controller.connection()).toMatchObject({ ok: true, value: { connected: false, member: null } })
  expect(await recipient.controller.signIn({ memberId: inviteTarget, password })).toMatchObject({ ok: true,
    value: { connected: true, member: { id: inviteTarget } } })
  expect(await recipient.ctx.credentials.describeRecord(key)).toMatchObject({ configured: true, kind: 'grant' })
  expect(await recipient.controller.memberInvite(inviteTarget)).toEqual({ ok: false, code: 'forbidden' })
  const peerInput = { ...input, requestId: randomUUID(), memberId: invitePeer }
  const revoked = await admin.controller.issueMemberInvite(peerInput)
  if (!revoked.ok || !revoked.value.code) throw new Error('Missing peer invitation receipt')
  expect(await admin.controller.revokeMemberInvite({ id: revoked.value.invitation.id, revision: 1 }))
    .toMatchObject({ ok: true, value: { revision: 2, revokedBy: inviteAdmin } })
  expect(await recipient.controller.acceptMemberInvite({ code: revoked.value.code, newPassword: password }))
    .toEqual({ ok: false, code: 'unauthenticated' })
  const peer = await admin.controller.issueMemberInvite({ ...peerInput, requestId: randomUUID() })
  if (!peer.ok || !peer.value.code) throw new Error('Missing reissued peer invitation')
  const before = await admin.ctx.credentials.readRecord(key)
  expect(await admin.controller.acceptMemberInvite({ code: peer.value.code, newPassword: password }))
    .toEqual({ ok: true, value: { memberId: invitePeer } })
  expect(await admin.ctx.credentials.readRecord(key)).toEqual(before)
  expect(await admin.controller.connection()).toMatchObject({ ok: true, value: { member: { id: inviteAdmin }, connected: true } })
})

it('keeps old disabled gateways usable and treats bounded optional health discovery failure as no invitation capability', async () => {
  const disabled = await createMemberInviteGateway({})
  const legacy = await invitationHost(disabled.address)
  expect(await legacy.controller.memberInviteCapability()).toEqual({ ok: true, value: null })
  expect(await legacy.controller.signIn({ memberId: inviteAdmin, password: invitePassword })).toMatchObject({ ok: true,
    value: { connected: true, member: { id: inviteAdmin } } })
  let mode = 'old'
  const requests: { path: string | undefined; authorization: string | undefined }[] = []
  const listener = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization })
    response.setHeader('Content-Type', 'application/json')
    if (mode === 'unavailable') { response.writeHead(503); response.end('{"unavailable":true}'); return }
    if (mode === 'oversized') { response.write('{"padding":"'); response.end('x'.repeat(4096) + '"}'); return }
    if (mode === 'invalid') { response.end('{"protocol":"office.v1","memberInvites":{"protocol":1,"maxTtlMs":0}}'); return }
    response.end('{"protocol":"office.v1"}')
  })
  onTestFinished(async () => {
    const stopping = new Promise<void>((resolve, reject) => listener.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
    listener.closeAllConnections()
    await stopping
  })
  await listenHttp(listener, { host: '127.0.0.1', port: 0, maxAttempts: 16 })
  const bound = listener.address()
  if (!bound || typeof bound === 'string') throw new Error('Owned health fixture did not bind')
  const host = await invitationHost(`http://127.0.0.1:${bound.port}`)
  expect(await host.controller.connection()).toMatchObject({ ok: true, value: { connected: false } })
  expect(requests).toHaveLength(0)
  for (const value of ['old', 'unavailable', 'invalid', 'oversized']) {
    mode = value
    expect(await host.controller.memberInviteCapability()).toEqual({ ok: true, value: null })
  }
  expect(requests).toHaveLength(4)
  expect(requests.every(request => request.path === '/health' && request.authorization === undefined)).toBe(true)
  expect(await host.ctx.credentials.readRecord(key)).toBeUndefined()
  expect(await host.controller.connection()).toMatchObject({ ok: true, value: { connected: false } })
  expect(requests).toHaveLength(4)
})
