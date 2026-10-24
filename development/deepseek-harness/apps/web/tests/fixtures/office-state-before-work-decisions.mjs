/** The versioned office data domain; one commit includes items, invitations, notifications and audit. */
import { z } from 'zod';
import { brandString } from '@deepseek-ai/dsh-brand';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
/** Admission of an external employee id does not authenticate its holder. */
export const officeMemberId = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .transform(value => brandString(value));
const itemId = z.uuid().transform(value => brandString(value));
const notificationId = z.uuid().transform(value => brandString(value));
/** Calendar dates are real Gregorian days, with no UTC conversion of local dates. */
export const officeDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Expected an existing calendar date');
/** Same-day wall-clock time. Overnight events require a later multi-day feature. */
export const officeTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const title = z.string().trim().min(1).max(200);
const description = z.string().max(16_000);
const status = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);
/** Fields an employee may edit without receiving authorization privileges. */
export const officeProfile = z
    .object({
    name: z.string().trim().min(1).max(100),
    department: z.string().trim().max(200),
    jobTitle: z.string().trim().max(200),
    email: z.union([z.literal(''), z.email().max(320)]),
    phone: z.string().trim().max(80),
})
    .strict();
/** Stored member authorization and public directory fields. */
export const officeMember = officeProfile.extend({
    id: officeMemberId,
    role: z.enum(['employee', 'manager', 'admin']),
    active: z.boolean(),
});
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
    .strict();
const scheduleFields = {
    title,
    description: description.optional(),
    date: officeDate,
    startTime: officeTime,
    endTime: officeTime,
    location: z.string().trim().max(500).optional(),
};
/** User-authored same-day meeting data. */
export const officeScheduleInput = z
    .object({ ...scheduleFields, inviteeIds: z.array(officeMemberId).max(500) })
    .strict()
    .refine(value => value.endTime > value.startTime, 'End time must follow start time');
/** Reviewed changes retain the existing meeting participants and organizer. */
export const officeScheduleUpdateInput = z
    .object(scheduleFields)
    .strict()
    .refine(value => value.endTime > value.startTime, 'End time must follow start time');
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
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
})
    .superRefine((value, ctx) => {
    if (value.kind === 'schedule' && (!value.time || !value.endTime || value.endTime <= value.time)) {
        ctx.addIssue({ code: 'custom', message: 'Stored schedule has an invalid interval' });
    }
    if (new Set(value.participants.map(participant => participant.memberId)).size !== value.participants.length) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate participants' });
    }
    if (value.kind === 'schedule' &&
        !value.participants.some(participant => participant.memberId === value.creatorId && participant.reply === 'accepted')) {
        ctx.addIssue({ code: 'custom', message: 'Organizer participation must be accepted' });
    }
    if (value.kind === 'schedule' && value.ownerId !== value.creatorId) {
        ctx.addIssue({ code: 'custom', message: 'A meeting is owned by its organizer' });
    }
    if (value.kind !== 'schedule' && (value.endTime !== undefined || value.participants.length > 0)) {
        ctx.addIssue({ code: 'custom', message: 'Task and to-do records cannot carry calendar invitations' });
    }
});
const notification = z.object({
    id: notificationId,
    recipientId: officeMemberId,
    actorId: officeMemberId,
    itemId,
    kind: z.enum(['assigned', 'invited', 'invitation_reply', 'status_changed', 'schedule_updated']),
    createdAt: z.number().int().nonnegative(),
    read: z.boolean(),
});
const audit = z.object({
    revision: z.number().int().positive(),
    actorId: officeMemberId,
    action: z.enum([
        'work_created',
        'schedule_created',
        'schedule_updated',
        'status_changed',
        'invitation_reply',
        'profile_updated',
        'member_saved',
    ]),
    targetId: z.string(),
    time: z.number().int().nonnegative(),
});
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
    const members = new Set(value.members.map(member => member.id));
    const items = new Set(value.items.map(entry => entry.id));
    if (members.size !== value.members.length ||
        items.size !== value.items.length ||
        new Set(value.notifications.map(entry => entry.id)).size !== value.notifications.length) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate office identities' });
    }
    if (value.initialized && !value.members.some(member => member.active && member.role === 'admin')) {
        ctx.addIssue({ code: 'custom', message: 'An office needs an active administrator' });
    }
    if (value.items.some(entry => !members.has(entry.creatorId) ||
        !members.has(entry.ownerId) ||
        entry.participants.some(participant => !members.has(participant.memberId))) ||
        value.notifications.some(entry => !members.has(entry.recipientId) || !members.has(entry.actorId) || !items.has(entry.itemId)) ||
        value.audit.some(entry => !members.has(entry.actorId) || entry.revision > value.revision)) {
        ctx.addIssue({ code: 'custom', message: 'An office record references a missing identity or future revision' });
    }
    if (value.initialized) {
        if (!value.companyName.trim())
            ctx.addIssue({ code: 'custom', message: 'A company name is required' });
        try {
            new Intl.DateTimeFormat('en', { timeZone: value.timeZone });
        }
        catch {
            ctx.addIssue({ code: 'custom', message: 'Invalid office timezone' });
        }
    }
});
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
});
//# sourceMappingURL=spec.js.map