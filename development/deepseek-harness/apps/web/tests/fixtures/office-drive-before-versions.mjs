import { z } from "zod";
import { brandString } from "@deepseek-ai/dsh-brand";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
//#region .artifacts/enterprise-office/drive-before/src/spec.ts
/** The versioned office data domain; one commit includes items, invitations, notifications and audit. */
/** Admission of an external employee id does not authenticate its holder. */
const officeMemberId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).transform((value) => brandString(value));
const itemId = z.uuid().transform((value) => brandString(value));
const subtaskId = z.uuid().transform((value) => brandString(value));
const notificationId = z.uuid().transform((value) => brandString(value));
/** Calendar dates are real Gregorian days, with no UTC conversion of local dates. */
const officeDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
	const date = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Expected an existing calendar date");
/** Same-day wall-clock time. Overnight events require a later multi-day feature. */
const officeTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const title = z.string().trim().min(1).max(200);
const description = z.string().max(16e3);
const status = z.enum([
	"pending",
	"in_progress",
	"completed",
	"cancelled"
]);
/** Stored member authorization and public directory fields. */
const officeMember = z.object({
	name: z.string().trim().min(1).max(100),
	department: z.string().trim().max(200),
	jobTitle: z.string().trim().max(200),
	email: z.union([z.literal(""), z.email().max(320)]),
	phone: z.string().trim().max(80)
}).strict().extend({
	id: officeMemberId,
	role: z.enum([
		"employee",
		"manager",
		"admin"
	]),
	active: z.boolean()
});
/** User-authored task/to-do data, checked before any write is admitted. */
const officeWorkInput = z.object({
	kind: z.enum(["task", "todo"]),
	title,
	description: description.optional(),
	date: officeDate,
	time: officeTime.optional(),
	ownerId: officeMemberId,
	status: status.optional()
}).strict();
const workPriority = z.enum([
	"low",
	"normal",
	"high",
	"urgent"
]);
const workLifecycleAction = z.object({
	kind: z.enum([
		"archive",
		"delete",
		"restore"
	]),
	reason: z.string().trim().min(1).max(2e3)
}).strict().extend({
	previous: z.enum([
		"active",
		"archived",
		"deleted"
	]),
	actorId: officeMemberId,
	revision: z.number().int().positive(),
	time: z.number().int().nonnegative()
});
/** Bounded reviewed file references; contents and permissions remain owned by Drive. */
const officeWorkAttachmentLimits = {
	protocol: 1,
	maxFiles: 20
};
const workAttachment = z.object({
	id: z.uuid().transform((value) => brandString(value)),
	versionId: z.uuid().transform((value) => brandString(value))
}).strict();
const workAttachments = z.array(workAttachment).max(officeWorkAttachmentLimits.maxFiles).refine((files) => new Set(files.map((file) => file.id)).size === files.length, "Duplicate work files");
z.object({ files: workAttachments }).strict();
const taskDelivery = z.object({
	kind: z.enum([
		"submit",
		"accept",
		"return"
	]),
	reason: z.string().trim().min(1).max(2e3)
}).strict().extend({
	actorId: officeMemberId,
	ownerId: officeMemberId,
	revision: z.number().int().positive(),
	time: z.number().int().nonnegative()
});
const subtaskFields = {
	title,
	completed: z.boolean()
};
const subtask = z.object({
	id: subtaskId,
	...subtaskFields
});
z.object({ subtasks: z.array(z.object({
	id: subtaskId.nullable(),
	...subtaskFields
}).strict()).max(100) }).strict().refine((value) => {
	const ids = value.subtasks.flatMap((entry) => entry.id === null ? [] : [entry.id]);
	return new Set(ids).size === ids.length;
}, "Duplicate subtask identities");
officeWorkInput.omit({
	kind: true,
	ownerId: true,
	status: true
}).extend({ priority: workPriority.optional() });
const scheduleFields = {
	title,
	description: description.optional(),
	date: officeDate,
	startTime: officeTime,
	endTime: officeTime,
	location: z.string().trim().max(500).optional()
};
z.object({
	...scheduleFields,
	inviteeIds: z.array(officeMemberId).max(500)
}).strict().refine((value) => value.endTime > value.startTime, "End time must follow start time");
z.object({
	...scheduleFields,
	inviteeIds: z.array(officeMemberId).max(500).optional()
}).strict().refine((value) => value.endTime > value.startTime, "End time must follow start time");
z.object({
	date: officeDate,
	startTime: officeTime,
	endTime: officeTime,
	memberIds: z.array(officeMemberId).min(1).max(500),
	excludeItemId: itemId.optional()
}).strict().refine((value) => value.endTime > value.startTime, "End time must follow start time");
z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("accept") }).strict(),
	z.object({
		kind: z.literal("reject"),
		reason: z.string().trim().min(1).max(2e3)
	}).strict(),
	z.object({
		kind: z.literal("transfer"),
		ownerId: officeMemberId,
		reason: z.string().trim().min(1).max(2e3)
	}).strict()
]);
const taskAction = z.object({
	kind: z.enum([
		"accept",
		"reject",
		"transfer"
	]),
	actorId: officeMemberId,
	fromOwnerId: officeMemberId,
	toOwnerId: officeMemberId,
	reason: z.string().max(2e3),
	time: z.number().int().nonnegative(),
	revision: z.number().int().positive()
}).superRefine((value, ctx) => {
	if (value.kind !== "accept" && !value.reason.trim() || (value.kind === "transfer" ? value.fromOwnerId === value.toOwnerId : value.fromOwnerId !== value.toOwnerId)) ctx.addIssue({
		code: "custom",
		message: "Invalid task decision history"
	});
});
const item = z.object({
	id: itemId,
	kind: z.enum([
		"task",
		"todo",
		"schedule"
	]),
	title,
	description,
	date: officeDate,
	time: officeTime.optional(),
	endTime: officeTime.optional(),
	location: z.string().max(500),
	status,
	creatorId: officeMemberId,
	ownerId: officeMemberId,
	participants: z.array(z.object({
		memberId: officeMemberId,
		reply: z.enum([
			"pending",
			"accepted",
			"declined"
		])
	})).readonly(),
	taskActions: z.array(taskAction).readonly().optional(),
	priority: workPriority.optional(),
	subtasks: z.array(subtask).max(100).readonly().optional(),
	deliveries: z.array(taskDelivery).readonly().optional(),
	attachments: workAttachments.readonly().optional(),
	lifecycle: z.enum(["archived", "deleted"]).optional(),
	lifecycleActions: z.array(workLifecycleAction).readonly().optional(),
	todoAssignments: z.array(taskAction.refine((action) => action.kind === "transfer", "To-dos only retain transfers").transform((action) => ({
		...action,
		kind: "transfer"
	}))).readonly().optional(),
	revision: z.number().int().positive(),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative()
}).superRefine((value, ctx) => {
	let lifecycle = "active";
	let revision = 0;
	for (const action of value.lifecycleActions ?? []) {
		if (action.previous !== lifecycle || action.revision <= revision || action.revision > value.revision || action.kind === "archive" && lifecycle !== "active" || action.kind === "delete" && lifecycle === "deleted" || action.kind === "restore" && lifecycle === "active") ctx.addIssue({
			code: "custom",
			message: "Invalid work lifecycle history"
		});
		lifecycle = action.kind === "archive" ? "archived" : action.kind === "delete" ? "deleted" : "active";
		revision = action.revision;
	}
	if ((value.lifecycle ?? "active") !== lifecycle || value.kind === "schedule" && value.lifecycleActions !== void 0) ctx.addIssue({
		code: "custom",
		message: "Only work items retain lifecycle history consistent with their current state"
	});
	if (value.kind === "schedule" && (!value.time || !value.endTime || value.endTime <= value.time)) ctx.addIssue({
		code: "custom",
		message: "Stored schedule has an invalid interval"
	});
	if (new Set(value.participants.map((participant) => participant.memberId)).size !== value.participants.length) ctx.addIssue({
		code: "custom",
		message: "Duplicate participants"
	});
	if (value.kind === "schedule" && !value.participants.some((participant) => participant.memberId === value.creatorId && participant.reply === "accepted")) ctx.addIssue({
		code: "custom",
		message: "Organizer participation must be accepted"
	});
	if (value.kind === "schedule" && value.ownerId !== value.creatorId) ctx.addIssue({
		code: "custom",
		message: "A meeting is owned by its organizer"
	});
	if (value.kind === "schedule" && value.priority !== void 0) ctx.addIssue({
		code: "custom",
		message: "Meetings do not have work priority"
	});
	if (value.kind === "schedule" && value.attachments !== void 0) ctx.addIssue({
		code: "custom",
		message: "Meetings do not retain work attachments"
	});
	if (value.kind === "schedule" && value.subtasks !== void 0 || new Set(value.subtasks?.map((entry) => entry.id)).size !== (value.subtasks?.length ?? 0)) ctx.addIssue({
		code: "custom",
		message: "Only work items retain unique checklist entries"
	});
	if (value.kind !== "schedule" && (value.endTime !== void 0 || value.participants.length > 0)) ctx.addIssue({
		code: "custom",
		message: "Task and to-do records cannot carry calendar invitations"
	});
	const actions = (value.kind === "todo" ? value.todoAssignments : value.taskActions) ?? [];
	if (value.kind !== "task" && value.deliveries !== void 0 || value.deliveries?.some((entry, index) => {
		const previous = value.deliveries?.[index - 1];
		if (entry.revision > value.revision || previous && entry.revision <= previous.revision) return true;
		return entry.kind === "submit" ? entry.actorId !== entry.ownerId || previous?.kind === "submit" && entry.revision === previous.revision + 1 : previous?.kind !== "submit" || entry.ownerId !== previous.ownerId || entry.revision !== previous.revision + 1;
	})) ctx.addIssue({
		code: "custom",
		message: "Delivery history must follow task submissions and reviewed revisions"
	});
	const lastAction = actions.at(-1);
	if (value.kind !== "task" && (value.taskActions?.length ?? 0) > 0 || value.kind !== "todo" && (value.todoAssignments?.length ?? 0) > 0 || actions.some((action, index) => {
		const previous = actions[index - 1];
		return action.revision > value.revision || previous !== void 0 && (action.revision <= previous.revision || action.fromOwnerId !== previous.toOwnerId);
	}) || lastAction !== void 0 && lastAction.toOwnerId !== value.ownerId) ctx.addIssue({
		code: "custom",
		message: "Work decisions must follow item revisions and ownership"
	});
});
const notification = z.object({
	id: notificationId,
	recipientId: officeMemberId,
	actorId: officeMemberId,
	itemId,
	kind: z.enum([
		"assigned",
		"invited",
		"invitation_reply",
		"status_changed",
		"schedule_updated",
		"schedule_removed",
		"task_accepted",
		"task_rejected",
		"task_transferred",
		"work_updated",
		"todo_reassigned",
		"work_prioritized",
		"work_subtasks_updated",
		"work_attachments_updated",
		"delivery_submitted",
		"delivery_accepted",
		"delivery_returned",
		"work_archived",
		"work_deleted",
		"work_restored"
	]),
	itemTitle: title.optional(),
	createdAt: z.number().int().nonnegative(),
	read: z.boolean()
});
const audit$1 = z.object({
	revision: z.number().int().positive(),
	actorId: officeMemberId,
	action: z.enum([
		"work_created",
		"work_updated",
		"work_subtasks_updated",
		"work_attachments_updated",
		"work_archived",
		"work_deleted",
		"work_restored",
		"delivery_submitted",
		"delivery_accepted",
		"delivery_returned",
		"todo_reassigned",
		"work_prioritized",
		"schedule_created",
		"schedule_updated",
		"schedule_members_updated",
		"task_accepted",
		"task_rejected",
		"task_transferred",
		"status_changed",
		"invitation_reply",
		"profile_updated",
		"member_saved"
	]),
	targetId: z.string(),
	time: z.number().int().nonnegative()
});
defineDomain({
	name: "enterprise_office",
	version: 1,
	global: {
		schema: z.object({
			initialized: z.boolean(),
			revision: z.number().int().nonnegative(),
			companyName: z.string(),
			timeZone: z.string(),
			members: z.array(officeMember).readonly(),
			items: z.array(item).readonly(),
			notifications: z.array(notification).readonly(),
			audit: z.array(audit$1).readonly()
		}).superRefine((value, ctx) => {
			const members = new Set(value.members.map((member) => member.id));
			const items = new Set(value.items.map((entry) => entry.id));
			if (members.size !== value.members.length || items.size !== value.items.length || new Set(value.notifications.map((entry) => entry.id)).size !== value.notifications.length) ctx.addIssue({
				code: "custom",
				message: "Duplicate office identities"
			});
			if (value.initialized && !value.members.some((member) => member.active && member.role === "admin")) ctx.addIssue({
				code: "custom",
				message: "An office needs an active administrator"
			});
			if (value.items.some((entry) => !members.has(entry.creatorId) || !members.has(entry.ownerId) || entry.participants.some((participant) => !members.has(participant.memberId)) || entry.lifecycleActions?.some((action) => !members.has(action.actorId)) || [...entry.taskActions ?? [], ...entry.todoAssignments ?? []].some((action) => !members.has(action.actorId) || !members.has(action.fromOwnerId) || !members.has(action.toOwnerId))) || value.notifications.some((entry) => !members.has(entry.recipientId) || !members.has(entry.actorId) || !items.has(entry.itemId)) || value.audit.some((entry) => !members.has(entry.actorId) || entry.revision > value.revision)) ctx.addIssue({
				code: "custom",
				message: "An office record references a missing identity or future revision"
			});
			if (value.initialized) {
				if (!value.companyName.trim()) ctx.addIssue({
					code: "custom",
					message: "A company name is required"
				});
				try {
					new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
				} catch {
					ctx.addIssue({
						code: "custom",
						message: "Invalid office timezone"
					});
				}
			}
		}),
		initial: {
			initialized: false,
			revision: 0,
			companyName: "",
			timeZone: "",
			members: [],
			items: [],
			notifications: [],
			audit: []
		}
	},
	tables: {}
});
//#endregion
//#region .artifacts/enterprise-office/drive-before/src/drive-blobs.ts
/** Whole-request uploads are bounded; streamed/chunked large-file upload remains separate work. */
const OFFICE_DRIVE_MAX_FILE_BYTES = 8 * 1024 * 1024;
//#endregion
//#region .artifacts/enterprise-office/drive-before/src/drive.ts
const id = z.uuid().transform((value) => brandString(value));
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.number().int().nonnegative();
const access = z.enum([
	"deny",
	"view",
	"edit"
]);
const defaultAccess = z.enum([
	"inherit",
	"deny",
	"view",
	"edit"
]);
const space = z.enum(["private", "shared"]);
const name = z.string().trim().normalize("NFC").min(1).max(255).refine((value) => value !== "." && value !== ".." && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) && !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value), "Invalid Windows-compatible name");
const grant = z.object({
	memberId: officeMemberId,
	access
}).strict();
const location = z.object({
	space,
	folderId: id.nullable()
});
const query = location.extend({ search: z.string().trim().max(200) }).strict();
const folderInput = location.extend({ name }).strict();
/** Shared boundary validators keep gateway admission aligned with actual drive operations. */
const officeDriveRequestSchemas = {
	id,
	query,
	folderInput,
	renameInput: z.object({
		id,
		revision,
		name
	}).strict(),
	permissionsInput: z.object({
		id,
		revision,
		defaultAccess,
		grants: z.array(grant).max(500)
	}).strict(),
	uploadInput: folderInput.extend({
		requestId: z.uuid(),
		mediaType: z.string().max(200).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
		byteLength: z.number().int().nonnegative().max(OFFICE_DRIVE_MAX_FILE_BYTES),
		dataBase64: z.string().max(Math.ceil(OFFICE_DRIVE_MAX_FILE_BYTES / 3) * 4)
	}).strict()
};
const version = z.object({
	id: z.uuid(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	byteLength: z.number().int().nonnegative(),
	mediaType: z.string().min(1).max(200),
	createdAt: timestamp,
	actorId: officeMemberId,
	requestId: z.uuid().optional(),
	requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict();
const node = z.object({
	id,
	parentId: id.nullable(),
	space,
	ownerId: officeMemberId,
	kind: z.enum(["folder", "file"]),
	name,
	revision,
	createdAt: timestamp,
	updatedAt: timestamp,
	defaultAccess,
	grants: z.array(grant).readonly(),
	versions: z.array(version).readonly(),
	deletedAt: timestamp.nullable()
}).strict().superRefine((entry, ctx) => {
	if (entry.kind === "folder" !== (entry.versions.length === 0) || new Set(entry.grants.map((item) => item.memberId)).size !== entry.grants.length || entry.grants.some((item) => item.memberId === entry.ownerId) || entry.space === "private" && (entry.defaultAccess !== "inherit" || entry.grants.length > 0)) ctx.addIssue({
		code: "custom",
		message: "Invalid drive entry content or conditions"
	});
});
const audit = z.object({
	revision,
	actorId: officeMemberId,
	targetId: id,
	time: timestamp,
	action: z.enum([
		"folder_created",
		"renamed",
		"permissions_changed",
		"file_uploaded",
		"file_updated",
		"trashed",
		"restored"
	])
}).strict();
/** Authoritative directory and ACL data; immutable file objects have opaque version ids. */
const officeDriveDomain = defineDomain({
	name: "enterprise_office_drive",
	version: 1,
	global: {
		schema: z.object({
			revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
			nodes: z.array(node).readonly(),
			audit: z.array(audit).readonly()
		}).strict().superRefine((value, ctx) => {
			const nodes = new Map(value.nodes.map((entry) => [entry.id, entry]));
			const siblings = /* @__PURE__ */ new Set();
			if (nodes.size !== value.nodes.length || value.nodes.length > 2e4) ctx.addIssue({
				code: "custom",
				message: "Duplicate or excessive drive identities"
			});
			for (const entry of value.nodes) {
				const chain = new Set([entry.id]);
				let parent = entry.parentId;
				while (parent) {
					const ancestor = nodes.get(parent);
					if (!ancestor || ancestor.kind !== "folder" || ancestor.space !== entry.space || entry.space === "private" && ancestor.ownerId !== entry.ownerId || chain.has(parent) || chain.size >= 128) {
						ctx.addIssue({
							code: "custom",
							message: "Invalid drive ancestry"
						});
						break;
					}
					chain.add(parent);
					parent = ancestor.parentId;
				}
				if (entry.deletedAt === null) {
					const key = JSON.stringify([
						entry.space,
						entry.space === "private" ? entry.ownerId : "",
						entry.parentId,
						entry.name.toLowerCase()
					]);
					if (siblings.has(key)) ctx.addIssue({
						code: "custom",
						message: "Duplicate sibling name"
					});
					siblings.add(key);
				}
			}
			if (value.audit.some((entry) => entry.revision > value.revision || !nodes.has(entry.targetId))) ctx.addIssue({
				code: "custom",
				message: "Invalid drive audit reference"
			});
		}),
		initial: {
			revision: 0,
			nodes: [],
			audit: []
		}
	},
	tables: {}
});
//#endregion
//#region .artifacts/enterprise-office/drive-before/src/drive-uploads.ts
/** Chunk-protocol envelope bounds; deployment configuration can select stricter limits. */
const DRIVE_TRANSFER_MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** Largest encoded chunk admitted by the shared office request parser. */
const DRIVE_TRANSFER_MAX_CHUNK_BYTES = 2 * 1024 * 1024;
/** Smallest negotiated chunk keeps receipt arrays bounded within the protocol envelope. */
const DRIVE_TRANSFER_MIN_CHUNK_BYTES = 64 * 1024;
const maxParts = DRIVE_TRANSFER_MAX_FILE_BYTES / DRIVE_TRANSFER_MIN_CHUNK_BYTES;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** Opaque server resource identity, checked before every ticket lookup. */
const officeDriveUploadId = z.uuid().transform((value) => brandString(value));
/** Reviewed logical destination and complete-file integrity declaration. */
const officeDriveUploadDeclaration = officeDriveRequestSchemas.folderInput.extend({
	requestId: z.uuid(),
	mediaType: officeDriveRequestSchemas.uploadInput.shape.mediaType,
	byteLength: counter.max(DRIVE_TRANSFER_MAX_FILE_BYTES),
	sha256
}).strict();
z.object({
	uploadId: officeDriveUploadId,
	index: counter.max(maxParts - 1),
	sha256,
	dataBase64: z.string().max(Math.ceil(DRIVE_TRANSFER_MAX_CHUNK_BYTES / 3) * 4)
}).strict();
z.object({
	id: officeDriveRequestSchemas.id,
	versionId: z.uuid().transform((value) => brandString(value)),
	offset: counter.max(DRIVE_TRANSFER_MAX_FILE_BYTES),
	byteLength: counter.max(DRIVE_TRANSFER_MAX_CHUNK_BYTES)
}).strict();
const part = z.object({
	index: counter.max(maxParts - 1),
	byteLength: counter.positive().max(DRIVE_TRANSFER_MAX_CHUNK_BYTES),
	sha256
}).strict();
const ticket = officeDriveUploadDeclaration.extend({
	id: officeDriveUploadId,
	ownerId: officeMemberId,
	createdAt: counter,
	expiresAt: counter,
	chunkBytes: counter.min(DRIVE_TRANSFER_MIN_CHUNK_BYTES).max(DRIVE_TRANSFER_MAX_CHUNK_BYTES),
	status: z.enum([
		"uploading",
		"completed",
		"cancelled",
		"expired"
	]),
	fileId: officeDriveRequestSchemas.id.nullable(),
	finishedAt: counter.nullable(),
	fingerprint: sha256,
	parts: z.array(part).max(maxParts).readonly()
}).strict().superRefine((value, ctx) => {
	if (value.expiresAt <= value.createdAt || value.status === "uploading" !== (value.finishedAt === null) || value.status === "completed" !== (value.fileId !== null) || value.status !== "uploading" && value.parts.length !== 0 || new Set(value.parts.map((part) => part.index)).size !== value.parts.length || value.parts.some((part) => part.index >= Math.ceil(value.byteLength / value.chunkBytes) || part.byteLength !== Math.min(value.chunkBytes, value.byteLength - part.index * value.chunkBytes))) ctx.addIssue({
		code: "custom",
		message: "Invalid upload receipt state"
	});
});
/** An additive domain retains resumable receipts without rewriting any original drive or office records. */
const officeDriveUploadDomain = defineDomain({
	name: "enterprise_office_uploads",
	version: 1,
	global: {
		schema: z.object({
			revision: counter,
			entries: z.array(ticket).max(1e5).readonly()
		}).strict().superRefine((value, ctx) => {
			if (new Set(value.entries.map((ticket) => ticket.id)).size !== value.entries.length || new Set(value.entries.map((ticket) => ticket.requestId)).size !== value.entries.length) ctx.addIssue({
				code: "custom",
				message: "Duplicate upload identities"
			});
		}),
		initial: {
			revision: 0,
			entries: []
		}
	},
	tables: {}
});
//#endregion
export { officeDriveDomain, officeDriveUploadDomain };

//# sourceMappingURL=entry.mjs.map