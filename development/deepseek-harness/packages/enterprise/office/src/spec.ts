/** The versioned office data domain; one commit includes items, invitations, notifications and audit. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { OfficeItemId, OfficeMemberId, OfficeNotificationId, OfficeSubtaskId } from './types.ts'
import type { OfficeDriveId, OfficeDriveVersionId } from './types.ts'

/** Admission of an external employee id does not authenticate its holder. */
export const officeMemberId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .transform(value => brandString<OfficeMemberId>(value))
const itemId = z.uuid().transform(value => brandString<OfficeItemId>(value))
const subtaskId = z.uuid().transform(value => brandString<OfficeSubtaskId>(value))
const notificationId = z.uuid().transform(value => brandString<OfficeNotificationId>(value))

/** Calendar dates are real Gregorian days, with no UTC conversion of local dates. */
export const officeDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`)
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  }, 'Expected an existing calendar date')
/** Same-day wall-clock time. Overnight events require a later multi-day feature. */
export const officeTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
const title = z.string().trim().min(1).max(200)
const description = z.string().max(16_000)
const status = z.enum(['pending', 'in_progress', 'completed', 'cancelled'])

/** Fields an employee may edit without receiving authorization privileges. */
export const officeProfile = z
  .object({
    name: z.string().trim().min(1).max(100),
    department: z.string().trim().max(200),
    jobTitle: z.string().trim().max(200),
    email: z.union([z.literal(''), z.email().max(320)]),
    phone: z.string().trim().max(80),
  })
  .strict()

/** Stored member authorization and public directory fields. */
export const officeMember = officeProfile.extend({
  id: officeMemberId,
  role: z.enum(['employee', 'manager', 'admin']),
  active: z.boolean(),
})

/** User-authored task/to-do data, checked before any write is admitted. */
export const officeWorkInput = z
  .object({
    kind: z.enum(['task', 'todo']),
    title,
    description: description.optional(),
    date: officeDate,
    time: officeTime.optional(),
    ownerId: officeMemberId,
    status: status.optional(),
  })
  .strict()

const workPriority = z.enum(['low', 'normal', 'high', 'urgent'])
/** Confirmed lifecycle changes preserve audit data and reject unbounded explanations. */
export const officeWorkLifecycleInput = z.object({
  kind: z.enum(['archive', 'delete', 'restore']),
  reason: z.string().trim().min(1).max(2000),
}).strict()
const workLifecycleAction = officeWorkLifecycleInput.extend({
  previous: z.enum(['active', 'archived', 'deleted']),
  actorId: officeMemberId,
  revision: z.number().int().positive(),
  time: z.number().int().nonnegative(),
})
/** Bounded reviewed file references; contents and permissions remain owned by Drive. */
export const officeWorkAttachmentLimits = { protocol: 1, maxFiles: 20 } as const
const workAttachment = z.object({
  id: z.uuid().transform(value => brandString<OfficeDriveId>(value)),
  versionId: z.uuid().transform(value => brandString<OfficeDriveVersionId>(value)),
}).strict()
const workAttachments = z.array(workAttachment).max(officeWorkAttachmentLimits.maxFiles)
  .refine(files => new Set(files.map(file => file.id)).size === files.length, 'Duplicate work files')
/** At most 20 distinct logical files with explicitly reviewed immutable versions. */
export const officeWorkAttachmentsInput = z.object({ files: workAttachments }).strict()
/** Reasoned task delivery and reviewer actions; authorization is checked by the executor. */
export const officeTaskDeliveryInput = z.object({
  kind: z.enum(['submit', 'accept', 'return']),
  reason: z.string().trim().min(1).max(2000),
}).strict()
const taskDelivery = officeTaskDeliveryInput.extend({
  actorId: officeMemberId,
  ownerId: officeMemberId,
  revision: z.number().int().positive(),
  time: z.number().int().nonnegative(),
})
const subtaskFields = { title, completed: z.boolean() }
const subtask = z.object({ id: subtaskId, ...subtaskFields })
/** Up to 100 reviewed checklist entries; new entries carry null rather than caller-supplied identities. */
export const officeWorkSubtasksInput = z.object({
  subtasks: z.array(z.object({ id: subtaskId.nullable(), ...subtaskFields }).strict()).max(100),
}).strict().refine((value) => {
  const ids = value.subtasks.flatMap(entry => entry.id === null ? [] : [entry.id])
  return new Set(ids).size === ids.length
}, 'Duplicate subtask identities')
/** Content edits preserve omitted priority and cannot change assignment, kind or lifecycle. */
export const officeWorkUpdateInput = officeWorkInput.omit({ kind: true, ownerId: true, status: true })
  .extend({ priority: workPriority.optional() })

const scheduleFields = {
  title,
  description: description.optional(),
  date: officeDate,
  startTime: officeTime,
  endTime: officeTime,
  location: z.string().trim().max(500).optional(),
}

/** User-authored same-day meeting data. */
export const officeScheduleInput = z
  .object({ ...scheduleFields, inviteeIds: z.array(officeMemberId).max(500) })
  .strict()
  .refine(value => value.endTime > value.startTime, 'End time must follow start time')

/** Reviewed changes always retain the organizer; omitted invitees preserve existing membership. */
export const officeScheduleUpdateInput = z
  .object({ ...scheduleFields, inviteeIds: z.array(officeMemberId).max(500).optional() })
  .strict()
  .refine(value => value.endTime > value.startTime, 'End time must follow start time')

/** Bounded same-day availability query; identities grant no exclusion or employee authority. */
export const officeScheduleAvailabilityInput = z.object({
  date: officeDate,
  startTime: officeTime,
  endTime: officeTime,
  memberIds: z.array(officeMemberId).min(1).max(500),
  excludeItemId: itemId.optional(),
}).strict().refine(value => value.endTime > value.startTime, 'End time must follow start time')

/** Explicit assignee decisions; rejecting or transferring requires a bounded plain-text reason. */
export const officeTaskDecisionInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accept') }).strict(),
  z.object({ kind: z.literal('reject'), reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('transfer'), ownerId: officeMemberId, reason: z.string().trim().min(1).max(2000) }).strict(),
])

const taskAction = z.object({
  kind: z.enum(['accept', 'reject', 'transfer']), actorId: officeMemberId,
  fromOwnerId: officeMemberId, toOwnerId: officeMemberId,
  reason: z.string().max(2000), time: z.number().int().nonnegative(), revision: z.number().int().positive(),
}).superRefine((value, ctx) => {
  if ((value.kind !== 'accept' && !value.reason.trim())
    || (value.kind === 'transfer' ? value.fromOwnerId === value.toOwnerId : value.fromOwnerId !== value.toOwnerId))
    ctx.addIssue({ code: 'custom', message: 'Invalid task decision history' })
})

const item = z
  .object({
    id: itemId,
    kind: z.enum(['task', 'todo', 'schedule']),
    title,
    description,
    date: officeDate,
    time: officeTime.optional(),
    endTime: officeTime.optional(),
    location: z.string().max(500),
    status,
    creatorId: officeMemberId,
    ownerId: officeMemberId,
    participants: z
      .array(z.object({ memberId: officeMemberId, reply: z.enum(['pending', 'accepted', 'declined']) }))
      .readonly(),
    taskActions: z.array(taskAction).readonly().optional(),
    priority: workPriority.optional(),
    subtasks: z.array(subtask).max(100).readonly().optional(),
    deliveries: z.array(taskDelivery).readonly().optional(),
    attachments: workAttachments.readonly().optional(),
    lifecycle: z.enum(['archived', 'deleted']).optional(),
    lifecycleActions: z.array(workLifecycleAction).readonly().optional(),
    todoAssignments: z.array(taskAction.refine(action => action.kind === 'transfer', 'To-dos only retain transfers')
      .transform(action => ({ ...action, kind: 'transfer' as const }))).readonly().optional(),
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine((value, ctx) => {
    let lifecycle: 'active' | 'archived' | 'deleted' = 'active'
    let revision = 0
    for (const action of value.lifecycleActions ?? []) {
      if (action.previous !== lifecycle || action.revision <= revision || action.revision > value.revision
        || (action.kind === 'archive' && lifecycle !== 'active')
        || (action.kind === 'delete' && lifecycle === 'deleted')
        || (action.kind === 'restore' && lifecycle === 'active'))
        ctx.addIssue({ code: 'custom', message: 'Invalid work lifecycle history' })
      lifecycle = action.kind === 'archive' ? 'archived' : action.kind === 'delete' ? 'deleted' : 'active'
      revision = action.revision
    }
    if ((value.lifecycle ?? 'active') !== lifecycle
      || (value.kind === 'schedule' && value.lifecycleActions !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Only work items retain lifecycle history consistent with their current state' })
    if (value.kind === 'schedule' && (!value.time || !value.endTime || value.endTime <= value.time)) {
      ctx.addIssue({ code: 'custom', message: 'Stored schedule has an invalid interval' })
    }
    if (new Set(value.participants.map(participant => participant.memberId)).size !== value.participants.length) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate participants' })
    }
    if (
      value.kind === 'schedule' &&
      !value.participants.some(
        participant => participant.memberId === value.creatorId && participant.reply === 'accepted',
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Organizer participation must be accepted' })
    }
    if (value.kind === 'schedule' && value.ownerId !== value.creatorId) {
      ctx.addIssue({ code: 'custom', message: 'A meeting is owned by its organizer' })
    }
    if (value.kind === 'schedule' && value.priority !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Meetings do not have work priority' })
    if (value.kind === 'schedule' && value.attachments !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Meetings do not retain work attachments' })
    if ((value.kind === 'schedule' && value.subtasks !== undefined)
      || new Set(value.subtasks?.map(entry => entry.id)).size !== (value.subtasks?.length ?? 0))
      ctx.addIssue({ code: 'custom', message: 'Only work items retain unique checklist entries' })
    if (value.kind !== 'schedule' && (value.endTime !== undefined || value.participants.length > 0)) {
      ctx.addIssue({ code: 'custom', message: 'Task and to-do records cannot carry calendar invitations' })
    }
    const actions = (value.kind === 'todo' ? value.todoAssignments : value.taskActions) ?? []
    if ((value.kind !== 'task' && value.deliveries !== undefined)
      || value.deliveries?.some((entry, index) => {
        const previous = value.deliveries?.[index - 1]
        if (entry.revision > value.revision || (previous && entry.revision <= previous.revision)) return true
        return entry.kind === 'submit' ? entry.actorId !== entry.ownerId
          || (previous?.kind === 'submit' && entry.revision === previous.revision + 1)
          : previous?.kind !== 'submit' || entry.ownerId !== previous.ownerId || entry.revision !== previous.revision + 1
      })) ctx.addIssue({ code: 'custom', message: 'Delivery history must follow task submissions and reviewed revisions' })
    const lastAction = actions.at(-1)
    if ((value.kind !== 'task' && (value.taskActions?.length ?? 0) > 0)
      || (value.kind !== 'todo' && (value.todoAssignments?.length ?? 0) > 0)
      || actions.some((action, index) => {
        const previous = actions[index - 1]
        return action.revision > value.revision || (previous !== undefined
          && (action.revision <= previous.revision || action.fromOwnerId !== previous.toOwnerId))
      })
      || (lastAction !== undefined && lastAction.toOwnerId !== value.ownerId))
      ctx.addIssue({ code: 'custom', message: 'Work decisions must follow item revisions and ownership' })
  })

const notification = z.object({
  id: notificationId,
  recipientId: officeMemberId,
  actorId: officeMemberId,
  itemId,
  kind: z.enum(['assigned', 'invited', 'invitation_reply', 'status_changed', 'schedule_updated', 'schedule_removed',
    'task_accepted', 'task_rejected', 'task_transferred', 'work_updated', 'todo_reassigned', 'work_prioritized', 'work_subtasks_updated', 'work_attachments_updated',
    'delivery_submitted', 'delivery_accepted', 'delivery_returned', 'work_archived', 'work_deleted', 'work_restored']),
  itemTitle: title.optional(),
  createdAt: z.number().int().nonnegative(),
  read: z.boolean(),
})
const audit = z.object({
  revision: z.number().int().positive(),
  actorId: officeMemberId,
  action: z.enum([
    'work_created',
    'work_updated',
    'work_subtasks_updated',
    'work_attachments_updated',
    'work_archived',
    'work_deleted',
    'work_restored',
    'delivery_submitted',
    'delivery_accepted',
    'delivery_returned',
    'todo_reassigned',
    'work_prioritized',
    'schedule_created',
    'schedule_updated',
    'schedule_members_updated',
    'task_accepted',
    'task_rejected',
    'task_transferred',
    'status_changed',
    'invitation_reply',
    'profile_updated',
    'member_saved',
  ]),
  targetId: z.string(),
  time: z.number().int().nonnegative(),
})

/** Validated durable data, never exported directly to an untrusted employee. */
export const officeState = z
  .object({
    initialized: z.boolean(),
    revision: z.number().int().nonnegative(),
    companyName: z.string(),
    timeZone: z.string(),
    members: z.array(officeMember).readonly(),
    items: z.array(item).readonly(),
    notifications: z.array(notification).readonly(),
    audit: z.array(audit).readonly(),
  })
  .superRefine((value, ctx) => {
    const members = new Set(value.members.map(member => member.id))
    const items = new Set(value.items.map(entry => entry.id))
    if (
      members.size !== value.members.length ||
      items.size !== value.items.length ||
      new Set(value.notifications.map(entry => entry.id)).size !== value.notifications.length
    ) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate office identities' })
    }
    if (value.initialized && !value.members.some(member => member.active && member.role === 'admin')) {
      ctx.addIssue({ code: 'custom', message: 'An office needs an active administrator' })
    }
    if (
      value.items.some(
        entry =>
          !members.has(entry.creatorId) ||
          !members.has(entry.ownerId) ||
          entry.participants.some(participant => !members.has(participant.memberId)) ||
          entry.lifecycleActions?.some(action => !members.has(action.actorId)) ||
          [...(entry.taskActions ?? []), ...(entry.todoAssignments ?? [])].some(action => !members.has(action.actorId)
            || !members.has(action.fromOwnerId) || !members.has(action.toOwnerId)),
      ) ||
      value.notifications.some(
        entry => !members.has(entry.recipientId) || !members.has(entry.actorId) || !items.has(entry.itemId),
      ) ||
      value.audit.some(entry => !members.has(entry.actorId) || entry.revision > value.revision)
    ) {
      ctx.addIssue({ code: 'custom', message: 'An office record references a missing identity or future revision' })
    }
    if (value.initialized) {
      if (!value.companyName.trim()) ctx.addIssue({ code: 'custom', message: 'A company name is required' })
      try {
        new Intl.DateTimeFormat('en', { timeZone: value.timeZone })
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid office timezone' })
      }
    }
  })

/** Current complete commit of office business state. */
export type OfficeState = z.infer<typeof officeState>

/** Separate from Session persistence, workspace records and the Agent schedule domain. */
export const officeDomain = defineDomain({
  name: 'enterprise_office',
  version: 1,
  global: {
    schema: officeState,
    initial: {
      initialized: false,
      revision: 0,
      companyName: '',
      timeZone: '',
      members: [],
      items: [],
      notifications: [],
      audit: [],
    },
  },
  tables: {},
})
