/** Authorized group conversations retain membership intervals and reuse immutable drive references. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import { collaborationCounter as counter, collaborationRevision, checkCollaborationCapacity } from './collaboration-access.ts'
import type { OfficeCollaborationAccess } from './collaboration-access.ts'
import type { OfficeGovernanceAuditRow } from './usage-audit.ts'
import type { OfficeMember, OfficeMemberId, OfficeDriveId, OfficeDriveVersionId } from './types.ts'
import type {
  OfficeCollaborationLimits, OfficeGroupId, OfficeGroupMessageId, OfficeGroupAttachment,
  OfficeGroup, OfficeGroupMessage, OfficeGroupPage, OfficeUnifiedNotice,
} from './collaboration-types.ts'

const groupId = z.uuid().transform(value => brandString<OfficeGroupId>(value))
const messageId = z.uuid().transform(value => brandString<OfficeGroupMessageId>(value))
const fileId = z.uuid().transform(value => brandString<OfficeDriveId>(value))
const versionId = z.uuid().transform(value => brandString<OfficeDriveVersionId>(value))
const attachment = z.object({ fileId, versionId }).strict()
const group = z.object({
  id: groupId, revision: counter.min(1), name: z.string().trim().min(1).max(200),
  ownerId: officeMemberId, members: z.array(z.object({ memberId: officeMemberId, joinedAfter: counter }).strict()).min(1).max(1000),
  closed: z.boolean(),
}).strict().refine(value => new Set(value.members.map(member => member.memberId)).size === value.members.length
  && value.members.some(member => member.memberId === value.ownerId))
const message = z.object({
  id: messageId, groupId, sequence: counter.min(1), senderId: officeMemberId,
  text: z.string().max(16000), mentions: z.array(officeMemberId).max(1000), attachments: z.array(attachment).max(20),
  createdAt: counter,
}).strict().refine(value => (value.text.trim().length > 0 || value.attachments.length > 0)
  && new Set(value.mentions).size === value.mentions.length && !value.mentions.includes(value.senderId)
  && new Set(value.attachments.map(file => JSON.stringify(file))).size === value.attachments.length)
const receipt = z.object({ groupId, memberId: officeMemberId, joinedAfter: counter, through: counter.min(1) }).strict()
const audit = z.object({
  revision: counter.min(1), actorId: officeMemberId, targetId: groupId,
  action: z.enum(['group_created', 'group_updated', 'group_left', 'group_message_sent']), time: counter,
}).strict()
const state = z.object({
  revision: counter, groups: z.array(group).max(100000), messages: z.array(message).max(100000),
  receipts: z.array(receipt).max(100000), audit: z.array(audit).max(100000),
}).strict().superRefine((value, ctx) => {
  const groups = new Set(value.groups.map(entry => entry.id))
  const sequences = new Set(value.messages.map(entry => entry.sequence))
  if(groups.size !== value.groups.length || new Set(value.messages.map(entry => entry.id)).size !== value.messages.length
    || sequences.size !== value.messages.length || value.messages.some(entry => !groups.has(entry.groupId) ||
      entry.sequence > value.revision)
    || value.groups.some(entry => entry.members.some(member => member.joinedAfter > value.revision))
    || new Set(value.receipts.map(entry => JSON.stringify([entry.groupId, entry.memberId,
      entry.joinedAfter]))).size !== value.receipts.length
    || value.receipts.some(entry => !value.messages.some(item => item.groupId === entry.groupId
      && item.sequence === entry.through && item.sequence > entry.joinedAfter))
    || value.audit.some(entry => !groups.has(entry.targetId) || entry.revision > value.revision))
    ctx.addIssue({ code: 'custom', message: 'Invalid group references or message sequences' })
})

/** Independent v1 domain does not alter private-chat records or their reader. */
export const officeGroupsDomain = defineDomain({
  name: 'enterprise_office_groups', version: 1,
  global: { schema: state, initial: { revision: 0, groups: [], messages: [], receipts: [], audit: [] } }, tables: {},
})
/** Complete closed inputs; membership text and caller-selected roles grant nothing. */
export const officeGroupSchemas = {
  id: groupId,
  create: z.object({ id: groupId, name: group.shape.name, memberIds: z.array(officeMemberId).min(1).max(1000) }).strict(),
  update: z.object({
    id: groupId, revision: counter.min(1), name: group.shape.name,
    memberIds: z.array(officeMemberId).min(1).max(1000), ownerId: officeMemberId, closed: z.boolean(),
  }).strict(),
  leave: z.object({ id: groupId, revision: counter.min(1) }).strict(),
  send: z.object({
    id: messageId, groupId, text: z.string().max(16000), mentions: z.array(officeMemberId).max(1000),
    attachments: z.array(attachment).max(20),
  }).strict().refine(value => (value.text.trim().length > 0 || value.attachments.length > 0)
    && new Set(value.mentions).size === value.mentions.length &&
    new Set(value.attachments.map(file => JSON.stringify(file))).size === value.attachments.length),
  page: z.object({ id: groupId, before: counter.min(1).nullable(), limit: counter.min(1).max(100), search: z.string().max(200) },
  ).strict(),
  read: z.object({ id: groupId, through: counter.min(1) }).strict(),
  attachment: z.object({ groupId, messageId, file: attachment }).strict(),
}
/** Parsed wire request for group creation. */
export type OfficeGroupCreateInput = z.input<typeof officeGroupSchemas.create>
/** Parsed wire request for reviewed membership replacement. */
export type OfficeGroupUpdateInput = z.input<typeof officeGroupSchemas.update>
/** A message id is also its exact retry identity. */
export type OfficeGroupSendInput = z.input<typeof officeGroupSchemas.send>
/** Bounded history search input. */
export type OfficeGroupQuery = z.input<typeof officeGroupSchemas.page>

/** Current drive checks run before publication and every attachment resolution, without copying blobs. */
export class OfficeGroupsRepository {
  constructor(private readonly domain: Domain<typeof officeGroupsDomain>, private readonly access: OfficeCollaborationAccess,
    private readonly limits: OfficeCollaborationLimits,
    private readonly checkFile: (actor: OfficeMember, file: OfficeGroupAttachment) => void,
    private readonly auditMember: OfficeCollaborationAccess['member']) { }

  /**
   * Validate retained membership and original authors without demanding they remain active.
   * @param members - Retained company directory.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    const saved = this.domain.global.get()
    if(saved.groups.some(entry => entry.members.some(member => !ids.has(member.memberId)))
      || saved.messages.some(entry => !ids.has(entry.senderId) || entry.mentions.some(id => !ids.has(id)))
      || saved.audit.some(entry => !ids.has(entry.actorId))) throw new OfficeError('conflict',
      'Groups require their original employee directory')
    this.capacity(saved)
  }
  /**
   * Project safe group operation metadata through current administrator authority.
   * @param actorId - Active authorized administrator; private message content is never returned.
   * @returns Original group actor/action/time metadata only.
   */
  audit(actorId: OfficeMemberId): readonly OfficeGovernanceAuditRow[] {
    if(this.auditMember(actorId).role !== 'admin') throw new OfficeError('forbidden', 'Only an administrator may read group audit')
    return this.domain.global.get().audit.map(entry => ({
      key: `group:${entry.revision}`, source: 'group', actorId: entry.actorId,
      targetId: entry.targetId, action: entry.action, time: entry.time, decision: 'confirmed',
    }))
  }
  /**
   * Return only groups the current employee can open.
   * @param actorId - Authenticated active employee.
   * @returns Safe membership records without messages from other groups.
   */
  list(actorId: OfficeMemberId): readonly OfficeGroup[] {
    this.access.member(actorId)
    return this.domain.global.get().groups.filter(entry => !entry.closed && entry.members.some(member => member.memberId === actorId))
      .map(entry => structuredClone(entry))
  }
  /**
   * Create one exact group retry; all intended members must currently be active.
   * @param actorId - Authenticated organizer and initial owner.
   * @param input - Retry id, title and complete initial membership.
   * @returns Committed group; changed retries conflict without disclosure.
   */
  create(actorId: OfficeMemberId, input: OfficeGroupCreateInput): Promise<OfficeGroup> {
    const value = officeGroupSchemas.create.parse(input)
    return this.access.enqueue(async () => {
      this.access.member(actorId)
      const ids = this.members([actorId, ...value.memberIds])
      const current = this.domain.global.get()
      const prior = current.groups.find(entry => entry.id === value.id)
      if(prior) {
        const created = current.audit.find(entry => entry.targetId === prior.id && entry.action === 'group_created')
        if(created?.actorId !== actorId || prior.revision !== 1 || prior.name !== value.name
          || JSON.stringify(prior.members.map(member => member.memberId).sort()) !== JSON.stringify([...ids].sort()))
          throw new OfficeError('conflict', 'Group retry changed or has already been edited')
        return structuredClone(prior)
      }
      const created = {
        id: value.id, revision: 1, name: value.name, ownerId: actorId,
        members: ids.map(memberId => ({ memberId, joinedAfter: current.revision })), closed: false,
      }
      await this.save(current, { ...current, groups: [...current.groups, created] }, actorId, value.id, 'group_created')
      return structuredClone(created)
    })
  }
  /**
   * Replace membership only under the owner's reviewed revision; removal immediately revokes history and attachments.
   * @param actorId - Current group owner; platform role supplies no bypass.
   * @param input - Complete reviewed replacement, including explicit ownership transfer or closure.
   * @returns Committed group; new and rejoining members cannot read earlier messages.
   */
  update(actorId: OfficeMemberId, input: OfficeGroupUpdateInput): Promise<OfficeGroup> {
    const value = officeGroupSchemas.update.parse(input)
    return this.access.enqueue(async () => {
      const current = this.domain.global.get()
      const prior = this.authorized(actorId, value.id)
      if(prior.ownerId !== actorId) throw new OfficeError('forbidden', 'Only the group owner may manage membership')
      if(prior.revision !== value.revision) throw new OfficeError('conflict', 'Group membership changed after review')
      const ids = this.members(value.memberIds)
      if(!ids.includes(value.ownerId)) throw new OfficeError('invalid_input', 'The owner must remain a group member')
      const updated = {
        ...prior, revision: collaborationRevision(prior.revision), name: value.name,
        ownerId: value.ownerId, closed: value.closed, members:
          ids.map(memberId => prior.members.find(entry => entry.memberId === memberId)
            ?? { memberId, joinedAfter: current.revision }),
      }
      await this.save(current, { ...current, groups: current.groups.map(entry => entry.id === prior.id ? updated : entry) }, actorId,
        prior.id, 'group_updated')
      return structuredClone(updated)
    })
  }
  /**
   * Leave under a reviewed membership revision; an owner must transfer ownership or close the group first.
   * @param actorId - Current member leaving the group.
   * @param input - Group id and observed revision.
   */
  leave(actorId: OfficeMemberId, input: z.input<typeof officeGroupSchemas.leave>): Promise<void> {
    const value = officeGroupSchemas.leave.parse(input)
    return this.access.enqueue(async () => {
      const current = this.domain.global.get()
      const prior = this.authorized(actorId, value.id)
      if(prior.revision !== value.revision) throw new OfficeError('conflict', 'Group changed after review')
      if(prior.ownerId === actorId) throw new OfficeError('conflict', 'Transfer ownership or close the group before leaving')
      const updated = {
        ...prior, revision: collaborationRevision(prior.revision), members:
          prior.members.filter(entry => entry.memberId !== actorId),
      }
      await this.save(current, { ...current, groups: current.groups.map(entry => entry.id === prior.id ? updated : entry) }, actorId,
        prior.id, 'group_left')
    })
  }
  /**
   * Send once after checking current membership, mention recipients and every referenced file version.
   * @param actorId - Authenticated sender.
   * @param input - Immutable message fields and exact retry identity.
   * @returns Committed message; failed persistence creates neither a message nor a mention.
   */
  send(actorId: OfficeMemberId, input: OfficeGroupSendInput): Promise<OfficeGroupMessage> {
    const value = officeGroupSchemas.send.parse(input)
    return this.access.enqueue(async () => {
      const actor = this.access.member(actorId)
      const group = this.authorized(actorId, value.groupId)
      const current = this.domain.global.get()
      const prior = current.messages.find(entry => entry.id === value.id)
      if(prior) {
        if(prior.senderId !== actorId || prior.groupId !== value.groupId || prior.text !== value.text
          || JSON.stringify(prior.mentions) !== JSON.stringify(value.mentions) ||
          JSON.stringify(prior.attachments) !== JSON.stringify(value.attachments))
          throw new OfficeError('conflict', 'Message retry changed')
        return structuredClone(prior)
      }
      for(const id of value.mentions) {
        if(id === actorId || !group.members.some(member => member.memberId === id)) throw new OfficeError('invalid_input',
          'Mention requires another current group member')
        this.access.member(id)
      }
      for(const file of value.attachments) this.checkFile(actor, file)
      const created = message.parse({
        ...value, senderId: actorId, sequence: collaborationRevision(current.revision), createdAt:
          Date.now(),
      })
      await this.save(current, { ...current, messages: [...current.messages, created] }, actorId, group.id, 'group_message_sent')
      return structuredClone(created)
    })
  }
  /**
   * Read bounded group history, applying the current membership interval before search and pagination.
   * @param actorId - Current active member.
   * @param input - Explicit bounded filters and older-message cursor.
   * @returns Authorized immutable page; a removed member gets the same denial as a missing group.
   */
  page(actorId: OfficeMemberId, input: OfficeGroupQuery): OfficeGroupPage {
    const query = officeGroupSchemas.page.parse(input)
    const group = this.authorized(actorId, query.id)
    const joinedAfter = this.joined(group, actorId)
    const current = this.domain.global.get()
    const eligible = current.messages.filter(entry => entry.groupId === group.id && entry.sequence > joinedAfter
      && (query.before === null || entry.sequence < query.before) &&
      entry.text.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))
      .sort((a, b) => b.sequence - a.sequence)
    const messages = eligible.slice(0, query.limit)
    return structuredClone({
      group, messages, next: eligible.length > messages.length ? messages.at(-1)?.sequence ?? null : null,
      readThrough: this.through(group, actorId),
    })
  }
  /**
   * Persist a monotonic receipt for this membership interval, shared across devices.
   * @param actorId - Current recipient.
   * @param input - Actual visible message sequence acknowledged by the employee.
   */
  read(actorId: OfficeMemberId, input: z.input<typeof officeGroupSchemas.read>): Promise<void> {
    const value = officeGroupSchemas.read.parse(input)
    return this.access.enqueue(async () => {
      const group = this.authorized(actorId, value.id)
      const joinedAfter = this.joined(group, actorId)
      const current = this.domain.global.get()
      if(!current.messages.some(entry => entry.groupId === group.id && entry.sequence === value.through &&
        entry.sequence > joinedAfter))
        throw new OfficeError('not_found', 'Group message is unavailable')
      if(this.through(group, actorId) >= value.through) return
      const next = {
        ...current, revision: collaborationRevision(current.revision), receipts: [
          ...current.receipts.filter(entry => !(entry.groupId === group.id && entry.memberId === actorId &&
            entry.joinedAfter === joinedAfter)),
          { groupId: group.id, memberId: actorId, joinedAfter, through: value.through },
        ],
      }
      this.capacity(next)
      await this.domain.global.set(next)
      await this.access.changed()
    })
  }
  /**
   * Derive current recipient inbox rows from group history and original read receipts.
   * @param actorId - Current active member.
   * @returns Group and mention entries with opaque group links; withdrawn membership leaves no delivery.
   */
  notices(actorId: OfficeMemberId): readonly OfficeUnifiedNotice[] {
    const rows: OfficeUnifiedNotice[] = []
    for(const group of this.list(actorId)) {
      const through = this.through(group, actorId)
      for(const entry of this.domain.global.get().messages) {
        if(entry.groupId !== group.id || entry.senderId === actorId || entry.sequence <= this.joined(group, actorId)) continue
        const source = entry.mentions.includes(actorId) ? 'mention' : 'group'
        rows.push({
          key: `${source}:${entry.id}`, source, targetId: group.id, title: group.name,
          time: entry.createdAt, read: entry.sequence <= through,
        })
      }
    }
    return rows
  }
  /**
   * Acknowledge an authorized original notice even when its message is older than the first history page.
   * @param actorId - Current member and original receipt owner.
   * @param key - Current group/mention key from the recipient's authorized inbox.
   * @returns After the original monotonic read receipt is durable.
   */
  readNotice(actorId: OfficeMemberId, key: string): Promise<void> {
    const notice = this.notices(actorId).find(entry => entry.key === key)
    const id = key.slice(key.indexOf(':') + 1)
    const item = notice && this.domain.global.get().messages.find(entry => entry.id === id)
    if(!item) return Promise.reject(new OfficeError('not_found', 'Group message is unavailable'))
    return this.read(actorId, { id: item.groupId, through: item.sequence })
  }
  /**
   * Resolve a reference only while both group membership and original drive permission remain current.
   * @param actorId - Authenticated reader.
   * @param input - Group, visible message and its exact immutable file reference.
   * @returns Coordinate for the existing drive range downloader; it must recheck inside the same queue.
   */
  attachment(actorId: OfficeMemberId, input: z.input<typeof officeGroupSchemas.attachment>): OfficeGroupAttachment {
    const value = officeGroupSchemas.attachment.parse(input)
    const group = this.authorized(actorId, value.groupId)
    const item = this.domain.global.get().messages.find(entry => entry.groupId === group.id && entry.id === value.messageId
      && entry.sequence > this.joined(group, actorId))
    if(!item?.attachments.some(file => file.fileId === value.file.fileId && file.versionId === value.file.versionId))
      throw new OfficeError('not_found', 'Group attachment is unavailable')
    this.checkFile(this.access.member(actorId), value.file)
    return value.file
  }
  private members(input: readonly OfficeMemberId[]): OfficeMemberId[] {
    const ids = [...new Set(input)]
    if(ids.length > this.limits.maxGroupMembers) throw new OfficeError('invalid_input',
      'Group membership exceeds its configured capacity')
    for(const id of ids) this.access.member(id)
    return ids
  }
  private authorized(actorId: OfficeMemberId, id: OfficeGroupId): OfficeGroup {
    this.access.member(actorId)
    const group = this.domain.global.get().groups.find(entry => entry.id === id && !entry.closed &&
      entry.members.some(member => member.memberId === actorId))
    if(!group) throw new OfficeError('not_found', 'Group is unavailable')
    return group
  }
  private joined(group: OfficeGroup, actorId: OfficeMemberId): number {
    const member = group.members.find(entry => entry.memberId === actorId)
    if(!member) throw new OfficeError('not_found', 'Group is unavailable')
    return member.joinedAfter
  }
  private through(group: OfficeGroup, actorId: OfficeMemberId): number {
    return this.domain.global.get().receipts.find(entry => entry.groupId === group.id && entry.memberId === actorId
      && entry.joinedAfter === this.joined(group, actorId))?.through ?? 0
  }
  private capacity(value: z.infer<typeof state>): void {
    checkCollaborationCapacity(value, value.groups.length + value.messages.length + value.receipts.length + value.audit.length,
      this.limits)
  }
  private async save(current: z.infer<typeof state>, value: z.infer<typeof state>, actorId: OfficeMemberId,
    targetId: OfficeGroupId, action: z.infer<typeof audit>['action']): Promise<void> {
    const revision = collaborationRevision(current.revision)
    const next = state.parse({
      ...value, revision, audit: [...current.audit, { revision, actorId, targetId, action, time: Date.now() },
      ],
    })
    this.capacity(next)
    await this.domain.global.set(next)
    await this.access.changed()
  }
}
