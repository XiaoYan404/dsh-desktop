/** New collaboration model behavior covers identity races, exact retries and real desktop-port admission. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { OfficeCollaborationModel } from '../src/client/collaboration-model.ts'
import type { OfficeCollaborationRemote } from '../src/client/collaboration-model.ts'
import type { OfficeOutcome } from '../src/types.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeMember, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeGroupId, OfficeGroupMessageId, OfficeGroup, OfficeMessagePreferences } from '@deepseek-ai/dsh-enterprise-office/src/collaboration-types.ts'

const member: OfficeMember = { id: brandString<OfficeMemberId>('model-lin'), role: 'employee', name: 'Lin', active: true, department: 'Office', jobTitle: 'Employee', email: '', phone: '' }
const groupId = brandString<OfficeGroupId>('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const group: OfficeGroup = { id: groupId, revision: 1, ownerId: member.id, name: 'Current group', closed: false, members: [{ memberId: member.id, joinedAfter: 0 }] }
const preferences: OfficeMessagePreferences = { revision: 1, desktop: true, timeZone: 'Asia/Shanghai', sources: ['mention'], quiet: null }
const notice = { key: 'mention:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', source: 'mention' as const, targetId: groupId, title: 'Current group', time: 1, read: false }
function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const remote = {
    groupList: vi.fn(async () => ok([group])), createGroup: vi.fn(async () => ok(group)), updateGroup: vi.fn(async () => ok(group)), leaveGroup: vi.fn(async () => ok(undefined)),
    groupPage: vi.fn(async () => ok({ group, messages: [], next: null, readThrough: 0 })),
    sendGroupMessage: vi.fn(async () => ok({ id: brandString<OfficeGroupMessageId>('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), groupId, sequence: 1, senderId: member.id,
      text: 'Draft', mentions: [], attachments: [], createdAt: 1 })), readGroup: vi.fn(async () => ok(undefined)),
    downloadGroupAttachment: vi.fn(async () => ({ ok: true, value: { ok: false, code: 'not_found' } } as const)),
    messagePreferences: vi.fn(async () => ok(preferences)), saveMessagePreferences: vi.fn(async () => ok(preferences)),
    unifiedInbox: vi.fn(async () => ok({ entries: [notice], unread: 1, next: null })),
    claimDesktopDelivery: vi.fn(async () => ok(null)), settleDesktopDelivery: vi.fn(async () => ok(null)),
    identityGovernance: vi.fn(async () => ok({ revision: 0, policy: null, members: [] })),
    saveCentralPolicy: vi.fn(async () => ({ ok: true, value: { ok: false, code: 'forbidden' } } as const)), offboardMember: vi.fn(async () => ({ ok: true, value: { ok: false, code: 'forbidden' } } as const)),
    restoreMemberAccess: vi.fn(async () => ({ ok: true, value: { ok: false, code: 'forbidden' } } as const)), createMeetingSeries: vi.fn(async () => ({ ok: true, value: { ok: false, code: 'invalid_input' } } as const)),
    usageSummary: vi.fn(async () => ok({ coverage: 'captured_settlements' as const, settlements: 0, withUsage: 0, missingUsage: 0, attempts: 0, counters: {}, cost: null })),
    governanceAudit: vi.fn(async () => ok({ entries: [], total: 0, next: null, mediaType: 'application/x-ndjson' as const, content: '' })),
    readUnifiedNotice: vi.fn(async () => ok(undefined)),
  } satisfies OfficeCollaborationRemote
  const close = vi.fn()
  const desktop = { permission: vi.fn(() => 'granted'), requestPermission: vi.fn(async () => 'granted'), show: vi.fn(() => ({ close })) }
  const model = new OfficeCollaborationModel(remote, desktop)
  model.bind(member, [member])
  return { model, remote, desktop, close }
}

it('discards every initial-load reply after a principal switch and preserves no previous private snapshot', async () => {
  const { model, remote } = fixture()
  const pending = deferred<RemoteResult<OfficeOutcome<OfficeGroup[]>>>()
  remote.groupList.mockReturnValueOnce(pending.promise)
  const open = model.open()
  model.bind({ ...member, id: brandString<OfficeMemberId>('another-member') })
  pending.resolve(ok([group]))
  await open
  expect(model.state.getSnapshot()).toMatchObject({ visible: false, inbox: null, groups: [], group: null, preferences: null, pending: false })
})

it('keeps unconfirmed message retries on one UUID and refuses changing an outstanding draft', async () => {
  const { model, remote } = fixture()
  await model.open()
  remote.sendGroupMessage.mockRejectedValueOnce(new Error('Response lost'))
  expect(await model.send(groupId, 'Draft', [], [])).toBe(false)
  const id = remote.sendGroupMessage.mock.calls[0]?.[0].id
  expect(await model.send(groupId, 'Other draft', [], [])).toBe(false)
  expect(remote.sendGroupMessage).toHaveBeenCalledTimes(1)
  expect(model.state.getSnapshot().error).toBe('collaborationPreviousSend')
  expect(await model.send(groupId, 'Draft', [], [])).toBe(true)
  expect(remote.sendGroupMessage.mock.calls[1]?.[0].id).toBe(id)
})

it('keeps failed preference mutations unconfirmed and exposes a retryable error', async () => {
  const { model, remote } = fixture()
  await model.open()
  remote.saveMessagePreferences.mockRejectedValueOnce(new Error('Network unavailable'))
  expect(await model.savePreferences({ ...preferences, desktop: false })).toBe(false)
  expect(model.state.getSnapshot().preferences?.desktop).toBe(true)
  expect(model.state.getSnapshot()).toMatchObject({ pending: false, error: 'collaborationNetwork' })
})

it('suppresses a late desktop claim and its presentation after identity revocation', async () => {
  const { model, remote, desktop } = fixture()
  await model.open()
  const receipt = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', memberId: member.id, deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', key: notice.key,
    attempt: 1, stage: 'pending' as const, claimedAt: 1, leaseUntil: 1000000, preferenceRevision: 1 }
  const pending = deferred<RemoteResult<OfficeOutcome<typeof receipt | null>>>()
  remote.claimDesktopDelivery.mockReturnValueOnce(pending.promise)
  const displaying = model.showDesktop(notice.key, receipt.deviceId)
  model.bind(null)
  pending.resolve(ok(receipt))
  expect(await displaying).toBe(false)
  expect(desktop.show).not.toHaveBeenCalled()
  expect(remote.settleDesktopDelivery).not.toHaveBeenCalled()
})

it('prevents acknowledgement replies from jumping after the parent overlay closes', async () => {
  const { model, remote } = fixture()
  const navigate = vi.fn()
  await model.open(navigate)
  const pending = deferred<RemoteResult<OfficeOutcome<void>>>()
  remote.readUnifiedNotice.mockReturnValueOnce(pending.promise)
  const opening = model.openNotice(notice.key)
  model.close()
  pending.resolve(ok(undefined))
  expect(await opening).toBe(false)
  expect(navigate).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().group).toBeNull()
})

it('clears administrator projections immediately when the same employee role is downgraded', async () => {
  const { model } = fixture()
  model.bind({ ...member, role: 'admin' })
  await model.open()
  await model.loadGovernance()
  expect(model.state.getSnapshot().governance).not.toBeNull()
  model.bind(member)
  expect(model.state.getSnapshot()).toMatchObject({ visible: false, audit: null, usage: null, governance: null, preferences: null })
})
