/** New behavior acceptance uses real Loader, original business operations and durable JSON ledgers. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { executeOfficeRequest } from '@deepseek-ai/dsh-enterprise-office'
import { collaborationFixture, admin, lin, chen, xu, password } from './collaboration-fixture.ts'
import { officeGroupsDomain } from '../src/group-chat.ts'
import { officeIdentityGovernanceDomain } from '../src/identity-governance.ts'
import { officeUsageDomain, projectOfficeExecutionAudit } from '../src/usage-audit.ts'
import { quietNow } from '../src/message-preferences.ts'
import { planOfficeMeetingSeries } from '../src/meeting-series.ts'
import type { OfficeMemberId } from '../src/types.ts'

const page = { before: null, limit: 100, search: '' } as const
const inbox = { source: null, unreadOnly: false, before: null, limit: 100 } as const
const audit = { limit: 100, before: null, actorId: null, targetId: null, source: null, action: null, since: 0, until: Number.MAX_SAFE_INTEGER } as const

it('revokes group history immediately on removal and gives rejoining members only their new visibility interval', async () => {
  const { office, ctx, boot } = await collaborationFixture()
  const group = await office.createGroup(lin, { id: randomUUID(), name: 'Design group', memberIds: [chen] })
  const submitted = { id: randomUUID(), groupId: group.id, text: 'Discuss the current file', mentions: [chen], attachments: [] }
  const sent = await office.sendGroupMessage(lin, submitted)
  expect(await office.sendGroupMessage(lin, submitted)).toEqual(sent)
  expect(() => office.groupPage(admin, { id: group.id, ...page })).toThrowError(/unavailable/u)
  await expect(office.updateGroup(chen, { id: group.id, revision: group.revision, ownerId: lin, closed: false,
    memberIds: [lin, chen], name: group.name })).rejects.toMatchObject({ code: 'forbidden' })
  await expect(office.sendGroupMessage(lin, { ...submitted, id: randomUUID(), mentions: [xu] })).rejects.toMatchObject({ code: 'invalid_input' })
  expect(office.unifiedInbox(chen, inbox).entries.some(entry => entry.source === 'mention')).toBe(true)
  await office.readGroup(chen, { id: group.id, through: sent.sequence })
  expect(office.unifiedInbox(chen, inbox).entries.find(entry => entry.source === 'mention')?.read).toBe(true)
  const removed = await office.updateGroup(lin, { id: group.id, revision: group.revision, name: group.name, memberIds: [lin], ownerId: lin, closed: false })
  expect(() => office.groupPage(chen, { id: group.id, ...page })).toThrowError(/unavailable/u)
  expect(office.unifiedInbox(chen, inbox).entries.filter(entry => entry.source === 'mention')).toEqual([])
  const rejoined = await office.updateGroup(lin, { id: group.id, revision: removed.revision, name: group.name, memberIds: [lin, chen], ownerId: lin, closed: false })
  expect(office.groupPage(chen, { id: group.id, ...page }).messages).toEqual([])
  const latest = await office.sendGroupMessage(lin, { ...submitted, id: randomUUID(), text: 'After rejoin' })
  await office.readGroup(chen, { id: group.id, through: latest.sequence })
  await ctx.fiber.dispose()
  const restarted = await boot()
  expect(restarted.office.groupPage(chen, { id: group.id, ...page }).messages.map(entry => entry.text)).toEqual(['After rejoin'])
  expect(restarted.office.groupPage(chen, { id: group.id, ...page }).readThrough).toBe(latest.sequence)
  await restarted.office.leaveGroup(chen, { id: group.id, revision: rejoined.revision })
  expect(() => restarted.office.groupPage(chen, { id: group.id, ...page })).toThrowError(/unavailable/u)
})

it('downloads exact original attachment bytes and rechecks both membership and current drive permission', async () => {
  const { office } = await collaborationFixture()
  const bytes = Buffer.from('Immutable group attachment')
  const file = await office.uploadDriveFile(admin, { space: 'shared', folderId: null, name: 'group.txt', requestId: randomUUID(),
    mediaType: 'text/plain', byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const info = await office.driveFileInfo(admin, file.id)
  const shared = await office.saveDrivePermissions(admin, { id: file.id, revision: file.revision, defaultAccess: 'view', grants: [] })
  const group = await office.createGroup(admin, { id: randomUUID(), name: 'Files', memberIds: [chen] })
  const reference = { fileId: file.id, versionId: info.versionId }
  const sent = await office.sendGroupMessage(admin, { id: randomUUID(), groupId: group.id, text: '', mentions: [], attachments: [reference] })
  const coordinate = { groupId: group.id, messageId: sent.id, file: reference, offset: 0, byteLength: bytes.length }
  const result = await office.downloadGroupAttachment(chen, coordinate)
  expect(Buffer.from(result.dataBase64, 'base64')).toEqual(bytes)
  const updated = await office.saveDrivePermissions(admin, { id: file.id, revision: shared.revision, defaultAccess: 'deny', grants: [] })
  expect(updated.id).toBe(file.id)
  await expect(office.downloadGroupAttachment(chen, coordinate)).rejects.toMatchObject({ code: 'not_found' })
  await office.updateGroup(admin, { id: group.id, revision: group.revision, name: group.name, ownerId: admin, memberIds: [admin], closed: false })
  await expect(office.downloadGroupAttachment(chen, coordinate)).rejects.toMatchObject({ code: 'not_found' })
})

it('keeps failed group commits invisible and rejects stale membership or changed message retries', async () => {
  const { office, ctx } = await collaborationFixture()
  const group = await office.createGroup(lin, { id: randomUUID(), name: 'Atomic group', memberIds: [chen] })
  const domain = ctx.storageDomain.get('enterprise_office_groups')
  if (!domain) throw new Error('Missing group domain')
  const spy = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Isolated disk fault'))
  const input = { id: randomUUID(), groupId: group.id, text: 'Only after persistence', mentions: [chen], attachments: [] }
  await expect(office.sendGroupMessage(lin, input)).rejects.toThrow('Isolated disk fault')
  spy.mockRestore()
  expect(office.groupPage(chen, { id: group.id, ...page }).messages).toEqual([])
  expect(office.unifiedInbox(chen, inbox).entries.filter(entry => entry.source === 'mention')).toEqual([])
  await office.sendGroupMessage(lin, input)
  await expect(office.sendGroupMessage(lin, { ...input, text: 'Changed retry' })).rejects.toMatchObject({ code: 'conflict' })
  const current = await office.updateGroup(lin, { id: group.id, revision: group.revision, name: 'Changed name', memberIds: [lin, chen], ownerId: lin, closed: false })
  await expect(office.leaveGroup(chen, { id: group.id, revision: group.revision })).rejects.toMatchObject({ code: 'conflict' })
  expect(officeGroupsDomain.global.schema.parse(domain.global.get()).groups[0]?.revision).toBe(current.revision)
})

it('shares notification preferences and original read receipts across devices while bounding failed desktop retries', async () => {
  const { office, ctx, boot } = await collaborationFixture()
  const group = await office.createGroup(lin, { id: randomUUID(), name: 'Desktop group', memberIds: [chen] })
  await office.sendGroupMessage(lin, { id: randomUUID(), groupId: group.id, text: 'Notify', mentions: [chen], attachments: [] })
  const notice = office.unifiedInbox(chen, { ...inbox, source: 'mention', unreadOnly: true }).entries[0]
  if (!notice) throw new Error('Expected authorized mention')
  const initial = office.messagePreferences(chen)
  expect(initial.desktop).toBe(false)
  const prefs = await office.saveMessagePreferences(chen, { ...initial, desktop: true, timeZone: 'America/New_York' })
  await expect(office.saveMessagePreferences(chen, { ...initial, desktop: false })).rejects.toMatchObject({ code: 'conflict' })
  const deviceId = randomUUID()
  const first = await office.claimDesktopDelivery(chen, { deviceId, key: notice.key, retry: false })
  if (!first) throw new Error('Expected first desktop claim')
  expect(await office.claimDesktopDelivery(chen, { deviceId, key: notice.key, retry: false })).toBeNull()
  await office.settleDesktopDelivery(chen, { id: first.id, deviceId, attempt: first.attempt, stage: 'failed' })
  const second = await office.claimDesktopDelivery(chen, { deviceId, key: notice.key, retry: true })
  expect(second?.attempt).toBe(2)
  await expect(office.settleDesktopDelivery(lin, { id: first.id, deviceId, attempt: first.attempt, stage: 'delivered' })).rejects.toMatchObject({ code: 'not_found' })
  await office.readUnifiedNotice(chen, notice.key)
  expect(await office.claimDesktopDelivery(chen, { deviceId: randomUUID(), key: notice.key, retry: false })).toBeNull()
  await ctx.fiber.dispose()
  const restarted = await boot()
  expect(restarted.office.messagePreferences(chen)).toEqual(prefs)
  expect(restarted.office.unifiedInbox(chen, { ...inbox, unreadOnly: true }).entries).toEqual([])
  expect(quietNow({ ...prefs, quiet: { start: '22:00', end: '07:00' } }, Date.parse('2026-11-01T05:30:00Z'))).toBe(true)
  expect(quietNow({ ...prefs, quiet: { start: '22:00', end: '07:00' } }, Date.parse('2026-11-01T18:30:00Z'))).toBe(false)
})

it('blocks offboarded sessions and every original resource executor before cleanup, retaining actual initiating administrator audit', async () => {
  const { office, ctx, root, boot } = await collaborationFixture()
  await office.initializeIdentity(admin, password)
  await office.setIdentityPassword(admin, lin, password)
  const first = await office.login({ memberId: lin, password })
  await office.login({ memberId: lin, password })
  const operation = { memberId: lin, revision: 0, requestId: randomUUID() }
  const receipt = await office.offboardMember(admin, operation)
  expect(receipt.stage).toBe('revoked')
  expect(receipt.sessionsRevoked).toBe(2)
  expect(() => office.authenticate(first.token)).toThrow()
  expect(() => office.view(lin)).toThrow()
  expect(() => office.drive(lin, { space: 'private', folderId: null, search: '' })).toThrow()
  await expect(office.connections(lin)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(office.sendMessage(lin, { id: randomUUID(), recipientId: chen, text: 'Denied after offboarding' })).rejects.toMatchObject({ code: 'forbidden' })
  expect(await office.offboardMember(admin, operation)).toEqual(receipt)
  const domain = ctx.storageDomain.get('enterprise_office_identity_governance')
  if (!domain) throw new Error('Missing governance domain')
  expect(officeIdentityGovernanceDomain.global.schema.parse(domain.global.get()).audit.every(entry => entry.actorId === admin)).toBe(true)
  const raw = await readFile(join(root, 'data', 'enterprise_office_identity_governance.json'), 'utf8')
  expect(raw).not.toContain(first.token)
  await ctx.fiber.dispose()
  const restarted = await boot()
  expect(() => restarted.office.view(lin)).toThrow()
  await restarted.office.restoreMemberAccess(admin, { memberId: lin, revision: receipt.revision, requestId: randomUUID(), revokedScopes: ['files', 'connectors'] })
  expect(restarted.office.view(lin).me.id).toBe(lin)
  expect(() => restarted.office.drive(lin, { space: 'private', folderId: null, search: '' })).toThrow()
  expect(() => restarted.office.authenticate(first.token)).toThrow()
})

it('keeps a failed offboarding cleanup blocked and permanently invalidates old first-password codes across restoration', async () => {
  const { office, ctx } = await collaborationFixture()
  await office.initializeIdentity(admin, password)
  const invite = await office.issueMemberInvite(admin, { memberId: chen, expectedRole: 'employee', requestId: randomUUID(), expiresAt: Date.now() + 600000 })
  if (!invite.code) throw new Error('Expected a first issuance code')
  const domain = ctx.storageDomain.get('enterprise_office_member_invites')
  if (!domain) throw new Error('Missing invitation domain')
  const spy = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Isolated revocation storage failure'))
  const operation = { memberId: chen, revision: 0, requestId: randomUUID() }
  await expect(office.offboardMember(admin, operation)).rejects.toMatchObject({ code: 'conflict' })
  spy.mockRestore()
  expect(() => office.view(chen)).toThrow()
  const completed = await office.offboardMember(admin, operation)
  expect(completed.invitationsRevoked).toBe(1)
  await office.restoreMemberAccess(admin, { memberId: chen, revision: completed.revision, requestId: randomUUID(), revokedScopes: [] })
  await expect(office.acceptMemberInvite({ code: invite.code, newPassword: password })).rejects.toMatchObject({ code: 'unauthenticated' })
  expect((await office.memberInvitePage(admin, { before: null, limit: 1 })).entries[0]?.revokedBy).toBe(admin)
  const exported = office.governanceAudit(admin, { ...audit, source: 'invitation' })
  expect(exported.entries.map(entry => entry.action)).toEqual(expect.arrayContaining(['invitation_issued', 'invitation_revoked']))
  expect(exported.content).not.toContain(invite.code)
  expect(exported.content).not.toContain('tokenHash')
})

it('records other authenticated RPC denials without business arguments and reauthorizes usage and audit on every query', async () => {
  const { office, ctx } = await collaborationFixture()
  await office.initializeIdentity(admin, password)
  await office.setIdentityPassword(admin, lin, password)
  const login = await office.login({ memberId: lin, password })
  await expect(executeOfficeRequest(office, login.token, { method: 'identityGovernance', args: [] })).rejects.toMatchObject({ code: 'forbidden' })
  const denial = office.governanceAudit(admin, { ...audit, source: 'request_denial' })
  expect(denial.entries.some(entry => entry.action === 'identityGovernance' && entry.actorId === lin)).toBe(true)
  expect(denial.content).not.toContain(login.token)
  const usage = { sessionId: 'actual-settlement-coordinate', seq: 4, memberId: lin, time: Date.now(), kind: 'message' as const,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, totalTokens: 35 }, inherited: false }
  await office.captureUsageSettlement(usage)
  await office.captureUsageSettlement(usage)
  await office.captureUsageSettlement({ ...usage, sessionId: 'child-prefix', inherited: true })
  await office.captureUsageSettlement({ ...usage, seq: 5, kind: 'attempt', usage: null })
  const summary = office.usageSummary(admin, { memberId: lin, since: 0, until: Number.MAX_SAFE_INTEGER })
  expect(summary).toMatchObject({ settlements: 2, withUsage: 1, missingUsage: 1, attempts: 1, cost: null })
  expect(summary.counters.inputTokens).toEqual({ value: 10, reported: 1 })
  expect(summary.counters.cacheWriteTokens).toEqual({ value: null, reported: 0 })
  expect(() => office.usageSummary(lin, { memberId: null, since: 0, until: Number.MAX_SAFE_INTEGER })).toThrow()
  const first = office.governanceAudit(admin, { ...audit, limit: 1, source: 'usage' })
  const second = office.governanceAudit(admin, { ...audit, source: 'usage', before: first.next })
  expect(first.entries[0]?.key).not.toBe(second.entries[0]?.key)
  expect(first.content.endsWith('\n')).toBe(true)
  const domain = ctx.storageDomain.get('enterprise_office_usage')
  if (!domain) throw new Error('Missing usage domain')
  expect(officeUsageDomain.global.schema.parse(domain.global.get()).entries).toHaveLength(2)
  const stages = projectOfficeExecutionAudit([{ id: randomUUID(), memberId: lin, history: [
    { stage: 'reserved', at: 1 }, { stage: 'dispatched', at: 2 }, { stage: 'unknown', at: 3 } ] }])
  expect(stages.map(entry => entry.decision)).toEqual(['reserved', 'dispatched', 'unknown'])
})

it('expands finite recurrence into original invitations with stable ids and rejects DST gaps before creating any schedule', async () => {
  const { office, ctx, boot } = await collaborationFixture({ scheduleAvailabilityEnabled: true })
  const request = { id: randomUUID(), schedule: { title: 'Weekly review', date: '2026-10-19', startTime: '09:00', endTime: '10:00', inviteeIds: [chen] },
    frequency: 'weekly' as const, interval: 1, count: 3, timeZone: 'America/New_York' }
  const receipt = await office.createMeetingSeries(lin, request)
  expect(receipt.itemIds).toHaveLength(3)
  expect(office.view(chen).items.filter(entry => receipt.itemIds.includes(entry.id))).toHaveLength(3)
  const notifications = office.view(chen).notifications.length
  expect(await office.createMeetingSeries(lin, request)).toEqual(receipt)
  expect(office.view(chen).notifications).toHaveLength(notifications)
  const meeting = office.view(chen).items.find(entry => entry.id === receipt.itemIds[0])
  if (!meeting) throw new Error('Expected original meeting')
  await office.reply(chen, meeting.id, meeting.revision, 'accepted')
  expect(office.view(chen).items.find(entry => entry.id === meeting.id)?.participants.find(entry => entry.memberId === chen)?.reply).toBe('accepted')
  await ctx.fiber.dispose()
  expect((await boot()).office.view(chen).items.filter(entry => receipt.itemIds.includes(entry.id))).toHaveLength(3)
  expect(() => planOfficeMeetingSeries({ ...request, schedule: { ...request.schedule, date: '2027-03-14', startTime: '02:30', endTime: '03:30' }, count: 1 }, 'Asia/Shanghai')).toThrow()
})

it('enforces explicit role scopes inside original direct executors while keeping permitted nonchat inbox rows available', async () => {
  const { office } = await collaborationFixture()
  await office.createWork(admin, { kind: 'task', title: 'Allowed original item', date: '2026-10-19', time: '10:00', ownerId: lin })
  await office.initializeIdentity(admin, password)
  await office.setIdentityPassword(admin, lin, password)
  const token = await office.login({ memberId: lin, password })
  await office.saveCentralPolicy(admin, { revision: 0, allowedRoles: { office: ['admin', 'manager', 'employee'], files: ['admin'],
    connectors: ['admin'], chat: ['admin'], sessions: ['admin'] } })
  expect(office.view(lin).me.role).toBe('employee')
  expect(office.unifiedInbox(lin, inbox).entries.some(entry => entry.source === 'item')).toBe(true)
  expect(() => office.drive(lin, { space: 'private', folderId: null, search: '' })).toThrow()
  expect(() => office.authenticate(token.token)).toThrow()
  await expect(office.login({ memberId: lin, password })).rejects.toThrow()
  await expect(office.connections(lin)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(office.createGroup(lin, { id: randomUUID(), name: 'Denied', memberIds: [chen] })).rejects.toMatchObject({ code: 'forbidden' })
})

it('permanently invalidates first-password invitations on ordinary disable and role changes and pages only safe metadata', async () => {
  const { office } = await collaborationFixture()
  await office.initializeIdentity(admin, password)
  const receipt = await office.issueMemberInvite(admin, { memberId: lin, expectedRole: 'employee', requestId: randomUUID(), expiresAt: Date.now() + 600000 })
  if (!receipt.code) throw new Error('Expected first-password code')
  const current = office.view(admin).managedMembers?.find(entry => entry.id === lin)
  if (!current) throw new Error('Expected retained employee')
  const disabled = await office.saveMember(admin, { ...current, active: false }, current)
  await office.saveMember(admin, { ...current, active: true }, disabled)
  await expect(office.acceptMemberInvite({ code: receipt.code, newPassword: password })).rejects.toMatchObject({ code: 'unauthenticated' })
  await office.issueMemberInvite(admin, { memberId: chen, expectedRole: 'employee', requestId: randomUUID(), expiresAt: Date.now() + 600000 })
  const first = await office.memberInvitePage(admin, { before: null, limit: 1 })
  const second = await office.memberInvitePage(admin, { before: first.next, limit: 1 })
  expect(first.entries[0]?.id).not.toBe(second.entries[0]?.id)
  expect(JSON.stringify([first, second])).not.toMatch(/tokenHash|fingerprint|"code"/u)
  await expect(office.memberInvitePage(lin, { before: null, limit: 1 })).rejects.toMatchObject({ code: 'forbidden' })
})

it('keeps an expired desktop attempt unknown and refuses replay after preferences change or delivery lease expiry', async () => {
  const { office } = await collaborationFixture()
  const group = await office.createGroup(lin, { id: randomUUID(), name: 'Lease edge', memberIds: [chen] })
  await office.sendGroupMessage(lin, { id: randomUUID(), groupId: group.id, text: 'Lease check', mentions: [chen], attachments: [] })
  const notice = office.unifiedInbox(chen, inbox).entries[0]
  if (!notice) throw new Error('Expected a current mention')
  await office.saveMessagePreferences(chen, { ...office.messagePreferences(chen), desktop: true })
  const deviceId = randomUUID()
  const receipt = await office.claimDesktopDelivery(chen, { key: notice.key, deviceId, retry: false })
  if (!receipt) throw new Error('Expected a pending desktop attempt')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(receipt.leaseUntil)
  try {
    const settled = await office.settleDesktopDelivery(chen, { id: receipt.id, deviceId, attempt: receipt.attempt, stage: 'delivered' })
    expect(settled?.stage).toBe('unknown')
    expect(await office.claimDesktopDelivery(chen, { key: notice.key, deviceId, retry: true })).toBeNull()
  } finally { clock.mockRestore() }
})

it('allows administrator metadata audit under Office authority even when chat access is centrally denied', async () => {
  const { office } = await collaborationFixture()
  await office.createGroup(lin, { id: randomUUID(), name: 'Private body stays private', memberIds: [chen] })
  await office.saveCentralPolicy(admin, { revision: 0, allowedRoles: { office: ['admin', 'employee'], files: ['admin', 'employee'],
    connectors: ['admin', 'employee'], chat: [], sessions: ['admin', 'employee'] } })
  expect(() => office.groupList(admin)).toThrow()
  const result = office.governanceAudit(admin, { ...audit, source: 'group' })
  expect(result.entries.some(entry => entry.action === 'group_created')).toBe(true)
  expect(result.content).not.toContain('Private body stays private')
})
