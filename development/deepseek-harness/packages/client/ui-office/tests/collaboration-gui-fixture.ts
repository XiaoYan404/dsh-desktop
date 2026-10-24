/** Current generated Remote responses for the additional GUI workflows, without a live customer service. */
import { vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { OfficeCollaborationModel } from '../src/client/collaboration-model.ts'
import type { OfficeCollaborationRemote } from '../src/client/collaboration-model.ts'
import type { OfficeOutcome } from '../src/types.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeMember, OfficeMemberId, OfficeDriveId, OfficeDriveVersionId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeGroupId, OfficeGroup, OfficeGroupMessageId } from '@deepseek-ai/dsh-enterprise-office/src/collaboration-types.ts'

export const guiMember: OfficeMember = { id: brandString<OfficeMemberId>('gui-admin'), role: 'admin', name: 'Alex',
  active: true, department: '', jobTitle: '', email: '', phone: '' }
export const guiPeer: OfficeMember = { ...guiMember, id: brandString<OfficeMemberId>('gui-peer'), role: 'employee', name: 'Blair' }
export const guiGroup: OfficeGroup = { id: brandString<OfficeGroupId>('64e6aff9-5ac0-4598-9403-12ce724b567f'),
  revision: 3, ownerId: guiMember.id, name: 'Planning', closed: false,
  members: [guiMember, guiPeer].map(member => ({ memberId: member.id, joinedAfter: 0 })) }
export function guiOk<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
export function guiDenied<T>(): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: false, code: 'forbidden' } } }
export function guiDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
export function collaborationGuiFixture() {
  const remote = {
    groupList: vi.fn<OfficeCollaborationRemote['groupList']>(async () => guiOk([guiGroup])),
    createGroup: vi.fn<OfficeCollaborationRemote['createGroup']>(async () => guiOk(guiGroup)),
    updateGroup: vi.fn<OfficeCollaborationRemote['updateGroup']>(async () => guiOk(guiGroup)),
    leaveGroup: vi.fn<OfficeCollaborationRemote['leaveGroup']>(async () => guiOk(undefined)),
    groupPage: vi.fn<OfficeCollaborationRemote['groupPage']>(async () => guiOk({ group: guiGroup, messages: [], next: null, readThrough: 0 })),
    sendGroupMessage: vi.fn<OfficeCollaborationRemote['sendGroupMessage']>(async input => guiOk({ ...input,
      id: brandString<OfficeGroupMessageId>(input.id), groupId: brandString<OfficeGroupId>(input.groupId),
      mentions: input.mentions.map(id => brandString<OfficeMemberId>(id)), attachments: input.attachments.map(file => ({
        fileId: brandString<OfficeDriveId>(file.fileId), versionId: brandString<OfficeDriveVersionId>(file.versionId) })),
      sequence: 1, senderId: guiMember.id, createdAt: 1 })),
    readGroup: vi.fn<OfficeCollaborationRemote['readGroup']>(async () => guiOk(undefined)),
    downloadGroupAttachment: vi.fn<OfficeCollaborationRemote['downloadGroupAttachment']>(async () => guiDenied()),
    messagePreferences: vi.fn<OfficeCollaborationRemote['messagePreferences']>(async () => guiOk({ revision: 1,
      desktop: false, timeZone: 'Asia/Shanghai', sources: ['item', 'group'], quiet: null })),
    saveMessagePreferences: vi.fn<OfficeCollaborationRemote['saveMessagePreferences']>(async input => guiOk({ ...input, revision: input.revision + 1 })),
    unifiedInbox: vi.fn<OfficeCollaborationRemote['unifiedInbox']>(async () => guiOk({ entries: [{ key: 'item:existing',
      source: 'item', targetId: 'existing', title: 'Existing authorized notice', time: 1, read: false }], unread: 1, next: null })),
    claimDesktopDelivery: vi.fn<OfficeCollaborationRemote['claimDesktopDelivery']>(async () => guiOk(null)),
    settleDesktopDelivery: vi.fn<OfficeCollaborationRemote['settleDesktopDelivery']>(async () => guiOk(null)),
    identityGovernance: vi.fn<OfficeCollaborationRemote['identityGovernance']>(async () => guiOk({ revision: 0, policy: null, members: [] })),
    saveCentralPolicy: vi.fn<OfficeCollaborationRemote['saveCentralPolicy']>(async () => guiDenied()),
    offboardMember: vi.fn<OfficeCollaborationRemote['offboardMember']>(async () => guiDenied()),
    restoreMemberAccess: vi.fn<OfficeCollaborationRemote['restoreMemberAccess']>(async () => guiDenied()),
    createMeetingSeries: vi.fn<OfficeCollaborationRemote['createMeetingSeries']>(async () => guiDenied()),
    usageSummary: vi.fn<OfficeCollaborationRemote['usageSummary']>(async () => guiOk({ coverage: 'captured_settlements',
      settlements: 0, withUsage: 0, missingUsage: 0, attempts: 0, counters: {}, cost: null })),
    governanceAudit: vi.fn<OfficeCollaborationRemote['governanceAudit']>(async () => guiOk({ entries: [], total: 0,
      next: null, mediaType: 'application/x-ndjson', content: '' })),
    readUnifiedNotice: vi.fn<OfficeCollaborationRemote['readUnifiedNotice']>(async () => guiOk(undefined)),
  } satisfies OfficeCollaborationRemote
  const desktop = { permission: vi.fn(() => 'default'), requestPermission: vi.fn(async () => 'denied'),
    show: vi.fn(() => ({ close: vi.fn() })) }
  const model = new OfficeCollaborationModel(remote, desktop)
  model.bind(guiMember, [guiMember, guiPeer])
  return { model, remote, desktop }
}
