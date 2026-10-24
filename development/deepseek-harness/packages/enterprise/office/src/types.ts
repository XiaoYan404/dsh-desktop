/** Employee-owned business data, independent of Agent sessions and schedules. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { OfficeItemTime } from './calendar-time.ts'
import type { OfficeImageMediaType } from './image-types.ts'
export type { OfficeConversationImageReadInput, OfficeConversationImageRead, OfficeConversationImageResult,
  OfficeImageMediaType, OfficeImagePolicy } from './image-types.ts'

/** Server-owned first-password invitation identity; possession of an id grants no enrollment authority. */
export type OfficeMemberInviteId = Branded<'OfficeMemberInviteId'>

/** Optional first-password invitation deployment; every resource and lifetime bound is explicit. */
export interface OfficeMemberInviteConfig {
  /** Maximum future invitation lifetime in milliseconds, measured against the server clock. */
  readonly maxTtlMs: number
  /** Maximum retained invitation records, including expired and revoked records. */
  readonly maxEntries: number
  /** Maximum complete invitation-domain compact JSON size in UTF-8 bytes. */
  readonly maxBytes: number
}

/** Safe pre-login capability; it reveals no member directory, account state or invitation code. */
export interface OfficeMemberInviteCapability {
  readonly protocol: 1
  readonly maxTtlMs: number
}

/** Administrator-visible issuance and revocation evidence; secret hashes remain server-only. */
export interface OfficeMemberInvite {
  readonly id: OfficeMemberInviteId
  readonly revision: number
  readonly memberId: OfficeMemberId
  readonly role: OfficeRole
  readonly issuedBy: OfficeMemberId
  readonly issuedAt: number
  readonly expiresAt: number
  readonly revokedAt: number | null
  readonly revokedBy: OfficeMemberId | null
}

/** Latest invitation and independent current facts; credential presence does not identify which enrollment path was used. */
export interface OfficeMemberInviteView {
  readonly protocol: 1
  readonly memberId: OfficeMemberId
  readonly invitation: OfficeMemberInvite | null
  readonly credentialPresent: boolean
  readonly expired: boolean
  readonly revoked: boolean
  readonly requiresReview: boolean
  readonly canAccept: boolean
}

/** Reviewed issuance for one existing active member; a stable request UUID retains its original metadata. */
export interface OfficeMemberInviteIssueInput {
  readonly requestId: string
  readonly memberId: OfficeMemberId
  readonly expectedRole: OfficeRole
  readonly expiresAt: number
}

/** Only the first committed issuance response carries the code; exact retries cannot recover it. */
export interface OfficeMemberInviteIssueReceipt {
  readonly invitation: OfficeMemberInvite
  readonly code?: string
}

/** A reviewed revocation does not remove a password that has already been set. */
export interface OfficeMemberInviteRevokeInput {
  readonly id: OfficeMemberInviteId
  readonly revision: number
}

/** Limited code authentication may set only its target's first password; no actor, role or address is accepted. */
export interface OfficeMemberInviteAcceptInput {
  readonly code: string
  readonly newPassword: string
}

/** First-password commitment returns the normal login identity without issuing a business session. */
export interface OfficeMemberInviteAcceptReceipt {
  readonly memberId: OfficeMemberId
}
export type { OfficeConversationDocxConfig, OfficeConversationDocxRead, OfficeConversationDocxReadInput } from './docx-types.ts'
export type { OfficeConversationXlsxConfig, OfficeConversationXlsxReadInput, OfficeConversationXlsxCell,
  OfficeConversationXlsxSheet, OfficeConversationXlsxRead } from './xlsx-types.ts'
export type { OfficeConversationPptxConfig, OfficeConversationPptxReadInput, OfficeConversationPptxRead,
  OfficePptxPolicy, OfficePptxSelection, OfficePptxSection, OfficePptxSlide, OfficePptxExtraction } from './pptx-types.ts'

/** Deployment-owned WeCom internal application; CorpSecret remains a private connection credential reference. */
export interface OfficeWeComConfig {
  /** Enterprise identity used only at the official authentication endpoint. */
  readonly corpId: string
  /** Internal application identity separating its process-only token cache. */
  readonly agentId: number
  /** Distinct Office employee ids mapped to WeCom UserIDs; matching is case insensitive. */
  readonly members: Readonly<Record<string, string>>
  /** Explicit operations for the current employee's own account. */
  readonly actions: ('profile' | 'send_message')[]
}

/** Product-owned bridge v1 configuration; customers implement its vendor mapping and durable request-key handling. */
export interface OfficeOaConfig {
  /** Office employee ids mapped to distinct bridge actors; callers cannot select another actor. */
  readonly members: Readonly<Record<string, string>>
  /** Explicit role-admitted reads and reviewed flat-text writes; no caller-defined transport or attachments. */
  readonly actions: (Omit<OfficeConnectorActionDeclaration, 'allowedRoles' | 'fields'> & {
    /** Explicit deployment role list, copied into the immutable registration. */
    readonly allowedRoles: OfficeRole[]
    /** Deployment text inputs; read actions cannot declare fields. */
    readonly fields?: OfficeConnectorActionField[]
  })[]
}

/** Deployment-owned DingTalk application and employee mappings; AppSecret remains a connection credential reference. */
export interface OfficeDingTalkConfig {
  /** Enterprise-internal application identity; the secret comes from the connection credential reference. */
  readonly appKey: string
  /** Enterprise robot identity, required only for reviewed message submission. */
  readonly robotCode?: string
  /** Office employee ids mapped to distinct DingTalk accounts; unmapped employees cannot query. */
  readonly members: Readonly<Record<string, {
    /** This employee's DingTalk union identity, selected by the deployment administrator. */
    readonly unionId: string
    /** Explicit calendar for this employee; omitted calendars cannot be queried. */
    readonly calendarId?: string
    /** Explicit staff identity for this employee's robot messages; never inferred from unionId. */
    readonly userId?: string
  }>>
  /** Explicit reads or reviewed creation/submission for this employee's own account. */
  readonly actions: ('todos' | 'calendar' | 'create_todo' | 'create_calendar' | 'send_message')[]
  /** Future calendar window, in hours; defaults to 24 and permits at most 31 days. */
  readonly calendarWindowHours?: number
}

/** Expected operation denials; adapters localize these stable identities. */
export type OfficeErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'duplicate_name'
  | 'closed'
  | 'unauthenticated'
  | 'rate_limited'
  | 'conversation_capacity'
  | 'context_too_large'
  | 'execution_unknown'
  | 'customization_capacity'

/** Server-selected audit coordinates for four parsed mutation RPCs; the authenticated request owns the actor. */
export type OfficeRequestDenialScope =
  | { readonly action: 'saveMember'; readonly targetId: OfficeMemberId }
  | { readonly action: 'setStatus' | 'reply'; readonly targetId: OfficeItemId }
  | { readonly action: 'saveDrivePermissions'; readonly targetId: OfficeDriveId }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed office revision. Consumers re-read an employee-authorized projection.
     * @mode parallel
     * @param revision - New durable revision.
     */
    'office/changed'(revision: number): void
    /**
     * Committed private messaging change; consumers re-read only their own conversations.
     * @mode parallel
     */
    'office/chat-changed'(): void
    /**
     * Private drafts changed; readers fetch only their authenticated employee's drafts.
     * @mode parallel
     */
    'office/chat-drafts-changed'(): void
    /**
     * Drive metadata changed; clients re-read an authorized directory.
     * @mode parallel
     */
    'office/drive-changed'(): void
    /**
     * Formal organization changed; clients fetch their authorized company projection.
     * @mode parallel
     */
    'office/organization-changed'(): void
    /**
     * Company integration catalog changed; no manifest or credentials enter this event.
     * @mode parallel
     */
    'office/integrations-changed'(): void
    /**
     * A private conversation choice version changed; identities and selected capabilities are not broadcast.
     * @mode parallel
     */
    'office/conversation-links-changed'(): void
    /**
     * A publication, withdrawal or acknowledgement changed; no text or recipient identities are broadcast.
     * @mode parallel
     */
    'office/announcements-changed'(): void
    /**
     * Durable central reminder delivery or acknowledgement changed; recipients re-read their authorized view.
     * @mode parallel
     */
    'office/reminders-changed'(): void
  }
}

/** An employee identity issued by a trusted office identity provider. */
export type OfficeMemberId = Branded<'OfficeMemberId'>
/** Server-created identity of one employee-private product customization request. */
export type OfficeCustomizationId = Branded<'OfficeCustomizationId'>
/** Reviewed plain-text requirements, separate from system installation or external submission. */
export interface OfficeCustomizationFields {
  readonly target: string
  readonly contact: string
  readonly requirements: string
}
/** Creation uses null/zero; editing supplies the reviewed id/version and retains its retry UUID. */
export interface OfficeCustomizationInput extends OfficeCustomizationFields {
  readonly id: OfficeCustomizationId | null
  readonly revision: number
  readonly requestId: string
}
/** A saved private version; no delivery channel has accepted or received this record. */
export interface OfficeCustomizationRecord extends OfficeCustomizationFields {
  readonly id: OfficeCustomizationId
  readonly ownerId: OfficeMemberId
  readonly revision: number
  readonly companyName: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly delivery: 'not_sent'
}
/** Saved metadata uses employee-local operation positions; contact and requirement bodies require a detail read. */
export interface OfficeCustomizationPage {
  readonly meId: OfficeMemberId
  readonly entries: readonly Pick<OfficeCustomizationRecord, 'id' | 'target' | 'revision' | 'updatedAt'>[]
  readonly next: number | null
}
/** An exact original receipt can be older than the currently saved revision, which callers must review explicitly. */
export interface OfficeCustomizationSaveReceipt {
  readonly meId: OfficeMemberId
  readonly record: OfficeCustomizationRecord
  readonly currentRevision: number
}
/** Optional capability for bounded private draft persistence; saving and exporting never sends externally. */
export interface OfficeCustomizationLimits {
  readonly protocol: 1
  readonly pageSize: 20
  readonly maxOperations: number
  readonly maxBytes: number
}
/** One human task, to-do or calendar event. */
export type OfficeItemId = Branded<'OfficeItemId'>
/** Server-created identity of one checklist entry within its work item. */
export type OfficeSubtaskId = Branded<'OfficeSubtaskId'>
/** A persisted notification delivered to one employee. */
export type OfficeNotificationId = Branded<'OfficeNotificationId'>

/** Server-created UUID identifying one recipient's retained reminder occurrence. */
export type OfficeReminderId = Branded<'OfficeReminderId'>

/** Explicit opt-in central reminder polling and complete retained-ledger capacity. */
export interface OfficeReminderConfig {
  /** Delay after each settled scan, from 1 to 2,147,483,647 milliseconds. */
  readonly pollIntervalMs: number
  /** Maximum occurrence age at delivery, at least the polling delay. */
  readonly catchUpWindowMs: number
  /** Retained recipient occurrences, including read and no-longer-visible entries; 1 to 100,000. */
  readonly maxEntries: number
  /** Complete compact global-state UTF-8 JSON capacity, excluding backend encoding overhead; 1 byte to 256 MiB. */
  readonly maxBytes: number
}

/** Recipient-owned occurrence; itemTitle is derived only from the current authorized item and is never retained. */
export interface OfficeReminder {
  readonly id: OfficeReminderId
  readonly recipientId: OfficeMemberId
  readonly itemId: OfficeItemId
  readonly kind: 'work_due' | 'meeting_start'
  readonly occursAt: number
  readonly deliveredAt: number
  readonly read: boolean
  readonly itemTitle: string
}

/** Current eligible reminders for this employee; absent when central polling is not configured. */
export interface OfficeRemindersView {
  readonly protocol: 1
  readonly entries: readonly OfficeReminder[]
}

/** An immutable publication in the company's announcement ledger. */
export type OfficeAnnouncementId = Branded<'OfficeAnnouncementId'>

/** Reviewed plain-text announcement; the UUID is retained for uncertain-response retries. */
export interface OfficeAnnouncementInput {
  readonly requestId: string
  readonly title: string
  readonly body: string
  readonly audience: 'company' | 'members'
  readonly recipientIds: readonly OfficeMemberId[]
}

/** Authorized publication without other employees' read receipts or retry metadata. */
export interface OfficeAnnouncement {
  readonly id: OfficeAnnouncementId
  readonly revision: number
  readonly title: string
  readonly body: string
  readonly publisherId: OfficeMemberId
  readonly publisherName: string
  readonly publishedAt: number
  readonly audience: 'company' | 'members'
  readonly recipientCount: number
  readonly recipient: boolean
  readonly read: boolean
  readonly withdrawn: boolean
}

/** Recipient publications; administrators also receive retained withdrawn and targeted publications. */
export interface OfficeAnnouncementView {
  readonly revision: number
  readonly maxEntries: number
  readonly rotationMs: number
  readonly entries: readonly OfficeAnnouncement[]
}
/** Client-generated UUID makes retries of one human message idempotent. */
export type OfficeMessageId = Branded<'OfficeMessageId'>
/** Public session handle; possession of this id alone never authenticates its holder. */
export type OfficeSessionId = Branded<'OfficeSessionId'>
/** An opaque formal department, independent of an employee's editable contact label. */
export type OfficeUnitId = Branded<'OfficeUnitId'>
/** An opaque administrator-managed position; it grants no authorization role. */
export type OfficePositionId = Branded<'OfficePositionId'>
/** Opaque company integration registration, independent of installed plugin entries. */
export type OfficeIntegrationId = Branded<'OfficeIntegrationId'>

/** Native logical conversation identity, always scoped to the authenticated office employee. */
export type OfficeConversationId = Branded<'OfficeConversationId'>

/** A native user-invocable skill or a named office request template; neither reference grants execution authority. */
export interface OfficeToolReference {
  readonly kind: 'skill' | 'template'
  readonly name: string
}

/** Bounded private choice storage, independent of native Session or tool permissions. */
export interface OfficeConversationLinkLimits {
  readonly maxContexts: number
  readonly maxSelected: number
}

/** One employee's reviewed association draft; zero is an unsaved empty selection. */
export interface OfficeConversationLinks {
  readonly conversationId: OfficeConversationId
  readonly revision: number
  readonly requestId: string | null
  readonly updatedAt: number | null
  readonly integrations: readonly OfficeIntegrationId[]
  readonly tools: readonly OfficeToolReference[]
}

/** An explicit requirement names company registrations, distinguishing missing records from removed associations. */
export interface OfficeToolRequirement {
  readonly tool: OfficeToolReference
  readonly integrationNames: readonly string[]
  readonly integrations: readonly OfficeIntegrationId[]
  readonly missing: readonly string[]
}

/** Authenticated current choices and deployment requirements, without connection addresses or credentials. */
export interface OfficeConversationLinksView {
  readonly meId: OfficeMemberId
  readonly selection: OfficeConversationLinks
  readonly limits: OfficeConversationLinkLimits
  readonly requirements: readonly OfficeToolRequirement[]
  /** Absent on authorities predating submitted drive references. */
  readonly conversationFiles?: OfficeConversationFileLimits
}

/** A reviewed edit of one list; tool edits also associate their available declared dependencies. */
export type OfficeConversationLinksInput = {
  readonly conversationId: OfficeConversationId
  readonly revision: number
  readonly requestId: string
} & (
  | { readonly kind: 'integrations'; readonly integrations: readonly OfficeIntegrationId[] }
  | { readonly kind: 'tools'; readonly tools: readonly OfficeToolReference[] }
)

/** Private prepared context identity, scoped to its authenticated employee; it is never a bearer credential. */
export type OfficeConversationCaptureId = Branded<'OfficeConversationCaptureId'>

/** Capture reviewed choices once per employee, logical conversation and native prompt identity. */
export interface OfficeConversationCaptureInput {
  readonly conversationId: OfficeConversationId
  readonly revision: number
  readonly requestId: string
}

/** Historical descriptive metadata and configuration readiness, excluding addresses and credential aliases. */
export interface OfficeCapturedIntegration {
  readonly id: OfficeIntegrationId
  readonly name: string
  readonly system: string
  readonly version: string
  readonly capabilities: readonly string[]
  readonly connectionRevision: number
  readonly status: OfficeConnectorStatus | 'unconfigured'
}

/** Immutable prepared context; native admission and model dispatch require their own evidence. */
export interface OfficeConversationCapture {
  readonly format: 1
  readonly id: OfficeConversationCaptureId
  readonly requestId: string
  readonly memberId: OfficeMemberId
  readonly role: OfficeMember['role']
  readonly capturedAt: number
  readonly selection: OfficeConversationLinks
  readonly requirements: readonly OfficeToolRequirement[]
  readonly integrations: readonly OfficeCapturedIntegration[]
  readonly digest: string
}

/** Public descriptive manifest; executable code, endpoints and credentials are not admitted. */
export interface OfficeIntegrationManifest {
  readonly name: string
  readonly system: string
  readonly version: string
  readonly provider: string
  readonly description: string
  readonly capabilities: readonly string[]
  readonly owner?: string
}

/** A registered manifest does not attest installation, configuration or connectivity. */
export interface OfficeIntegration extends OfficeIntegrationManifest {
  readonly id: OfficeIntegrationId
  readonly owner: string
  readonly importedAt: number
  readonly importedBy: OfficeMemberId
}

/** One complete company catalog, containing no executable package or connection secrets. */
export interface OfficeIntegrationView {
  readonly revision: number
  readonly maxImportBytes: number
  readonly entries: readonly OfficeIntegration[]
}

/** Retrying an uncertain import uses the same UUID and exact JSON text. */
export interface OfficeIntegrationImportInput {
  readonly requestId: string
  readonly json: string
}

/** Authentication selects a deployment-approved alias; it never contains a secret or environment-variable name. */
export type OfficeConnectorAuthentication =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly credential: string }
  | { readonly kind: 'header'; readonly credential: string; readonly header: string }

/** Administrator-reviewed HTTP location and authentication, stored separately from descriptive manifests. */
export interface OfficeConnectorConfiguration {
  readonly adapterId: string
  readonly baseUrl: string
  readonly probePath: string
  readonly authentication: OfficeConnectorAuthentication
  readonly enabled: boolean
}

/** Zero creates a connection; subsequent saves require its reviewed version and an exact retry UUID. */
export interface OfficeConnectorInput extends OfficeConnectorConfiguration {
  readonly integrationId: OfficeIntegrationId
  readonly revision: number
  readonly requestId: string
}

/** Configuration readiness is separate from a successful network check. */
export type OfficeConnectorStatus =
  | 'disabled' | 'adapter_unavailable' | 'policy_blocked' | 'credential_missing' | 'credential_unavailable' | 'unverified'

/** Employee-safe readiness; only administrators receive editable configuration. */
export interface OfficeConnectorEntry {
  readonly integrationId: OfficeIntegrationId
  readonly revision: number
  readonly adapterId: string
  readonly status: OfficeConnectorStatus
  readonly updatedAt: number
  readonly configuration?: OfficeConnectorConfiguration
}

/** One explicitly named flat-text business input, with no authority to select a transport or another employee identity. */
export interface OfficeConnectorActionField {
  /** Unique action-local key of at most 64 lower-case ASCII letters, digits or underscores, beginning with a letter. */
  readonly name: string
  /** Trimmed public input label, normalized to NFC, at most 200 UTF-16 code units without controls. */
  readonly label: string
  /** Whether reviewed values must include nonblank text for this field. */
  readonly required: boolean
  /** Maximum submitted UTF-16 code units, from 1 through 4,000. */
  readonly maxLength: number
}

/** Public business-action declaration; seeing it does not authorize execution. */
export interface OfficeConnectorActionView {
  /** Stable adapter-local action identity. */
  readonly id: string
  /** Employee-facing action name. */
  readonly label: string
  /** Public explanation without deployment secrets. */
  readonly description: string
  /** Distinguishes remote reads from business writes. */
  readonly kind: 'read' | 'write'
  /** Optional write inputs; absence declares a parameterless write and never admits arbitrary keys. */
  readonly fields?: readonly OfficeConnectorActionField[]
}

/** Trusted deployment declaration with explicit role admission and no implicit administrator override. */
export interface OfficeConnectorActionDeclaration extends OfficeConnectorActionView {
  /** Exact current office roles permitted to discover this action. */
  readonly allowedRoles: ReadonlyArray<OfficeMember['role']>
}

/** One bounded current action directory; its coordinates are version checks rather than bearer credentials. */
export interface OfficeConnectorActionsView {
  /** Registered company system, never an arbitrary URL. */
  readonly integrationId: OfficeIntegrationId
  /** Current saved connection revision; zero when it is not configured. */
  readonly connectionRevision: number
  /** Process-local registration identity; null when the connection is unavailable. */
  readonly adapterRevision: string | null
  /** Readiness does not claim successful remote business execution. */
  readonly status: OfficeConnectorStatus | 'unconfigured'
  /** Only actions explicitly admitted for the authenticated employee's current role. */
  readonly actions: readonly OfficeConnectorActionView[]
  /** Explicit opt-in for read-only execution; absent on older servers and false for metadata-only providers. */
  readonly readSupported?: boolean
  /** Explicit opt-in for durable writes; declarations alone never install an executor. */
  readonly writeSupported?: boolean
}

/** A query names one declared action and the exact connection/provider versions reviewed by the employee. */
export interface OfficeConnectorReadInput {
  readonly integrationId: OfficeIntegrationId
  readonly actionId: string
  readonly connectionRevision: number
  readonly adapterRevision: string
}

/** Adapter-sanitized business fields, rendered as plain text rather than remote markup or executable content. */
export interface OfficeConnectorReadData {
  readonly summary: string
  readonly entries: readonly { readonly label: string; readonly value: string }[]
}

/** Agent directory discovery is limited to a system in this employee's explicitly submitted conversation capture. */
export interface OfficeConversationConnectorInput {
  readonly captureId: OfficeConversationCaptureId
  readonly integrationId: OfficeIntegrationId
}

/** Native reads retain the submitted association and the precise action/provider versions reviewed by native approval. */
export interface OfficeConversationConnectorReadInput extends OfficeConnectorReadInput {
  readonly captureId: OfficeConversationCaptureId
}

/** A completed query returns data only on success; failure diagnostics never contain remote response bodies. */
export type OfficeConnectorReadReceipt = OfficeConnectorReadInput & {
  readonly checkedAt: number
} & (
  | { readonly status: 'read'; readonly data: OfficeConnectorReadData }
  | { readonly status: Extract<OfficeConnectorProbeStatus,
    'unauthorized' | 'rate_limited' | 'timed_out' | 'unreachable' | 'invalid_response' | 'http_error'> }
)

/** Server-owned identity of one employee-private synchronized read record. */
export type OfficeConnectorSyncId = Branded<'OfficeConnectorSyncId'>
/** Explicitly persist one reviewed read; exact employee-scoped retries keep the original record. */
export interface OfficeConnectorSyncInput extends OfficeConnectorReadInput {
  readonly requestId: string
}
/** Small immutable audit metadata; result fields are fetched separately under current authorization. */
export interface OfficeConnectorSyncSummary extends OfficeConnectorReadInput {
  readonly id: OfficeConnectorSyncId
  readonly checkedAt: number
  readonly synchronizedAt: number
  readonly status: OfficeConnectorReadReceipt['status']
}
/** Current authorization controls retained data independently of its historical network outcome. */
export interface OfficeConnectorSyncDetail {
  readonly meId: OfficeMemberId
  readonly summary: OfficeConnectorSyncSummary
  readonly available: boolean
  readonly data: OfficeConnectorReadData | null
}
/** Exact older-page anchor, confined to one employee and company system. */
export interface OfficeConnectorSyncQuery {
  readonly integrationId: OfficeIntegrationId
  readonly before?: OfficeConnectorSyncId | undefined
}
/** Bounded metadata page; list reads never query the customer system or return retained business fields. */
export interface OfficeConnectorSyncPage {
  readonly meId: OfficeMemberId
  readonly integrationId: OfficeIntegrationId
  readonly entries: readonly OfficeConnectorSyncSummary[]
  readonly next: OfficeConnectorSyncId | null
}
/** Optional capability for explicit durable read synchronization; older servers omit it. */
export interface OfficeConnectorSyncLimits {
  readonly protocol: 1
  readonly pageMaxEntries: number
  readonly maxEntries: number
  readonly maxBytes: number
}

/** Private server-generated external-operation identity; caller retry UUIDs are scoped to their employee. */
export type OfficeConnectorExecutionId = Branded<'OfficeConnectorExecutionId'>

/** Reviewed external write request; execution requires a separately installed and authorized write implementation. */
export interface OfficeConnectorWriteInput extends OfficeConnectorReadInput {
  readonly requestId: string
  readonly captureId?: OfficeConversationCaptureId
  readonly values: Readonly<Record<string, string>>
}

/** Durable stages distinguish a pre-dispatch reservation from a possibly committed external request. */
export type OfficeConnectorExecutionStage = 'reserved' | 'dispatched' | 'succeeded' | 'rejected' | 'unknown' | 'cancelled'

/** Employee-private receipt; dispatched operations are unknown until an authoritative result is committed. */
export interface OfficeConnectorExecutionReceipt extends OfficeConnectorReadInput {
  readonly id: OfficeConnectorExecutionId
  readonly requestId: string
  readonly memberId: OfficeMemberId
  readonly roleAtAdmission: OfficeMember['role']
  readonly captureId?: OfficeConversationCaptureId
  readonly stage: OfficeConnectorExecutionStage
  readonly status: Exclude<OfficeConnectorExecutionStage, 'dispatched'>
  readonly revision: number
  readonly admittedAt: number
  readonly updatedAt: number
  readonly history: readonly { readonly stage: OfficeConnectorExecutionStage; readonly at: number }[]
  readonly result?: OfficeConnectorReadData
  readonly rejection?: 'denied' | 'not_accepted' | 'unauthorized' | 'rate_limited' | 'invalid_input'
}

/** Small employee-private list entry; raw request values, audit history and large results belong outside list pages. */
export type OfficeConnectorExecutionSummary = Omit<OfficeConnectorExecutionReceipt, 'history' | 'result'>

/** Stable older-page anchor, scoped to the authenticated employee and the selected company registration. */
export interface OfficeConnectorExecutionQuery {
  readonly integrationId: OfficeIntegrationId
  readonly before?: OfficeConnectorExecutionId
}

/** Complete bounded page; next anchors the last returned receipt and never grants access to another employee's history. */
export interface OfficeConnectorExecutionPage {
  readonly integrationId: OfficeIntegrationId
  readonly entries: readonly OfficeConnectorExecutionSummary[]
  readonly next: OfficeConnectorExecutionId | null
}

/** Optional history advertisement; older servers omit it and retain their original connection interface. */
export interface OfficeConnectorExecutionLimits {
  readonly protocol: 1
  readonly pageMaxEntries: number
  readonly pageMaxBytes: number
  readonly detailMaxBytes: number
  /** Optional protocol for explicit external outcome reads; older servers omit it. */
  readonly checks?: 1
}

/** Checking an existing operation never sends the original business write or interprets uncertainty as nonacceptance. */
export interface OfficeConnectorExecutionCheck {
  readonly status: 'updated' | 'unknown' | 'unavailable' | 'connection_changed'
  readonly receipt: OfficeConnectorExecutionReceipt
}

/** Available adapters and connection versions; deployment policy choices are visible only to administrators. */
export interface OfficeConnectorView {
  readonly revision: number
  readonly entries: readonly OfficeConnectorEntry[]
  readonly adapters: readonly string[]
  readonly allowedOrigins?: readonly string[]
  readonly credentialAliases?: readonly string[]
  readonly executionHistory?: OfficeConnectorExecutionLimits
  readonly synchronization?: OfficeConnectorSyncLimits
  /** Optional advertisement; older servers omit it and retain their original connection UI. */
  readonly actionCatalog?: {
    /** Version of the declaration-directory protocol. */
    readonly protocol: 1
    /** Maximum declarations per adapter registration. */
    readonly maxCount: number
    /** Complete public directory byte budget including response coordinates. */
    readonly maxBytes: number
  }
}

/** A single bounded check; it grants no approval for later reads or writes. */
export type OfficeConnectorProbeStatus = OfficeConnectorStatus
  | 'connected' | 'unauthorized' | 'rate_limited' | 'timed_out' | 'unreachable' | 'invalid_response' | 'http_error'

/** Probe results contain neither remote response data nor credential values. */
export interface OfficeConnectorProbe {
  readonly integrationId: OfficeIntegrationId
  readonly revision: number
  readonly checkedAt: number
  readonly status: OfficeConnectorProbeStatus
  readonly httpStatus?: number
}
/** Office authorization roles; editing a profile cannot change this value. */
export type OfficeRole = 'employee' | 'manager' | 'admin'
/** State shared by calendar, work lists and the dashboard. */
export type OfficeItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
/** An invitation remains visible after its recipient replies. */
export type OfficeInvitationReply = 'pending' | 'accepted' | 'declined'

/** Public contact fields. Authorization role and active state are managed separately. */
export interface OfficeProfile {
  /** Public display name; changing it grants no additional authority. */
  readonly name: string
  /** Display department, separate from formal organization membership. */
  readonly department: string
  /** Public job title, separate from the authorization role. */
  readonly jobTitle: string
  /** Public contact email, or an empty string when it is not set. */
  readonly email: string
  /** Public contact phone text, or an empty string when it is not set. */
  readonly phone: string
}

/** Directory entry; inactive employees retain their historical references. */
export interface OfficeMember extends OfficeProfile {
  /** Stable company employee identity retained by historical references. */
  readonly id: OfficeMemberId
  /** Server-managed office authorization role; profile editing cannot change it. */
  readonly role: OfficeRole
  /** Whether current company operations admit this employee; disabling retains historical records. */
  readonly active: boolean
}

/** Retained department hierarchy; inactive entities keep historical references. */
export interface OfficeOrganizationUnit {
  readonly id: OfficeUnitId
  readonly parentId: OfficeUnitId | null
  readonly name: string
  readonly active: boolean
  readonly revision: number
}

/** A global or department-specific position, separate from the employee/manager/admin role. */
export interface OfficePosition {
  readonly id: OfficePositionId
  readonly unitId: OfficeUnitId | null
  readonly name: string
  readonly active: boolean
  readonly revision: number
}

/** Current formal affiliation; null values and versions retain an explicit unassignment. */
export interface OfficeOrganizationAssignment {
  readonly memberId: OfficeMemberId
  readonly unitId: OfficeUnitId | null
  readonly positionId: OfficePositionId | null
  readonly revision: number
}

/** Administrator views retain inactive records; employees receive active structure and current affiliations. */
export interface OfficeOrganizationView {
  readonly initialized: boolean
  readonly revision: number
  readonly units: readonly OfficeOrganizationUnit[]
  readonly positions: readonly OfficePosition[]
  readonly assignments: readonly OfficeOrganizationAssignment[]
}

/** A new department uses a null id and revision zero; edits carry the reviewed opaque id/version. */
export interface OfficeUnitInput {
  readonly id: OfficeUnitId | null
  readonly revision: number
  readonly parentId: OfficeUnitId | null
  readonly name: string
  readonly active: boolean
}

/** A reviewed global or department-specific position create/edit. */
export interface OfficePositionInput {
  readonly id: OfficePositionId | null
  readonly revision: number
  readonly unitId: OfficeUnitId | null
  readonly name: string
  readonly active: boolean
}

/** Assignment version zero creates an affiliation; subsequent changes require its observed version. */
export interface OfficeAssignmentInput {
  readonly memberId: OfficeMemberId
  readonly revision: number
  readonly unitId: OfficeUnitId | null
  readonly positionId: OfficePositionId | null
}

/** Password sign-in contains no caller-claimed role or authorization principal. */
export interface OfficeLoginInput {
  readonly memberId: OfficeMemberId
  readonly password: string
}

/** Backend-only authentication receipt; adapters store the token without logging or rendering it. */
export interface OfficeLoginResult {
  readonly token: string
  readonly member: OfficeMember
  readonly expiresAt: number
}

/** Sanitized own-device session data, with no password material or bearer-token hash. */
export interface OfficeSessionInfo {
  readonly id: OfficeSessionId
  readonly createdAt: number
  readonly expiresAt: number
  readonly current: boolean
}

/** Administrator overview contains identities with credentials, never hashes or salts. */
export interface OfficeIdentityOverview {
  readonly initialized: boolean
  readonly enrolledMemberIds: readonly OfficeMemberId[]
}

/** A signed-in employee reviews their current password before replacing it. */
export interface OfficePasswordChangeInput {
  readonly currentPassword: string
  readonly newPassword: string
}

/** Organizer participation is accepted automatically and cannot be declined. */
export interface OfficeParticipant {
  readonly memberId: OfficeMemberId
  readonly reply: OfficeInvitationReply
}

/** Reviewed task decision or to-do transfer; reasons are plain text, and identities never grant access. */
export type OfficeTaskDecisionInput =
  | { readonly kind: 'accept' }
  | { readonly kind: 'reject'; readonly reason: string }
  | { readonly kind: 'transfer'; readonly ownerId: OfficeMemberId; readonly reason: string }

/** Durable task decision on a specific item revision, visible only with the task. */
export interface OfficeTaskAction {
  readonly kind: OfficeTaskDecisionInput['kind']
  readonly actorId: OfficeMemberId
  readonly fromOwnerId: OfficeMemberId
  readonly toOwnerId: OfficeMemberId
  readonly reason: string
  readonly time: number
  readonly revision: number
}

/** Retained to-do transfer; ordinary status changes are not assignment decisions. */
export type OfficeTodoAssignment = Omit<OfficeTaskAction, 'kind'> & { readonly kind: 'transfer' }

/** Work priority; an omitted stored value retains normal priority for existing items. */
export type OfficeWorkPriority = 'low' | 'normal' | 'high' | 'urgent'

/** Explicit task delivery or reviewer decision; each action requires a plain-text explanation. */
export interface OfficeTaskDeliveryInput {
  readonly kind: 'submit' | 'accept' | 'return'
  readonly reason: string
}

/** Immutable delivery action on one parent revision and its then-current assignee. */
export interface OfficeTaskDelivery extends OfficeTaskDeliveryInput {
  readonly actorId: OfficeMemberId
  readonly ownerId: OfficeMemberId
  readonly revision: number
  readonly time: number
}

/** A checklist entry inherits all access from its parent task/to-do; it is not an independently assigned item. */
export interface OfficeSubtask {
  readonly id: OfficeSubtaskId
  readonly title: string
  readonly completed: boolean
}

/** Reviewed replacement of a work checklist; null ids request new server-created entries. */
export interface OfficeWorkSubtasksInput {
  readonly subtasks: readonly (Omit<OfficeSubtask, 'id'> & { readonly id: OfficeSubtaskId | null })[]
}

/** A reviewed Drive version; linking never grants access to the underlying file. */
export interface OfficeWorkAttachment {
  readonly id: OfficeDriveId
  readonly versionId: OfficeDriveVersionId
}

/** Explicit replacement of at most 20 distinct logical file references. */
export interface OfficeWorkAttachmentsInput {
  readonly files: readonly OfficeWorkAttachment[]
}

/** Work remains retained for audit while archived or in the recycle bin. */
export type OfficeWorkLifecycleState = 'active' | 'archived' | 'deleted'

/** Explicitly confirmed work action with a retained explanation. */
export interface OfficeWorkLifecycleInput {
  readonly kind: 'archive' | 'delete' | 'restore'
  readonly reason: string
}

/** Immutable lifecycle history preserves the actor and reviewed previous state. */
export interface OfficeWorkLifecycleAction extends OfficeWorkLifecycleInput {
  readonly previous: OfficeWorkLifecycleState
  readonly actorId: OfficeMemberId
  readonly revision: number
  readonly time: number
}

/** Current file availability under both item and Drive permissions; denied references disclose no file metadata. */
export interface OfficeWorkAttachmentsView {
  readonly itemId: OfficeItemId
  readonly revision: number
  readonly files: readonly (OfficeWorkAttachment & ({ readonly available: false } | {
    readonly available: true
    readonly name: string
    readonly mediaType: string
    readonly byteLength: number
  }))[]
}

/** A dated employee work item. Dates and times are wall-clock values in the office timezone. */
export interface OfficeItem {
  readonly id: OfficeItemId
  readonly kind: 'task' | 'todo' | 'schedule'
  readonly title: string
  readonly description: string
  readonly date: string
  readonly time?: string | undefined
  readonly endTime?: string | undefined
  readonly location: string
  readonly status: OfficeItemStatus
  readonly creatorId: OfficeMemberId
  readonly ownerId: OfficeMemberId
  readonly participants: readonly OfficeParticipant[]
  readonly taskActions?: readonly OfficeTaskAction[] | undefined
  readonly todoAssignments?: readonly OfficeTodoAssignment[] | undefined
  readonly priority?: OfficeWorkPriority | undefined
  readonly subtasks?: readonly OfficeSubtask[] | undefined
  readonly deliveries?: readonly OfficeTaskDelivery[] | undefined
  readonly attachments?: readonly OfficeWorkAttachment[] | undefined
  readonly lifecycle?: Exclude<OfficeWorkLifecycleState, 'active'> | undefined
  readonly lifecycleActions?: readonly OfficeWorkLifecycleAction[] | undefined
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Task/to-do input; omitted time means unscheduled within the selected day. */
export interface OfficeWorkInput {
  readonly kind: 'task' | 'todo'
  readonly title: string
  readonly description?: string | undefined
  readonly date: string
  readonly time?: string | undefined
  readonly ownerId: OfficeMemberId
  readonly status?: OfficeItemStatus | undefined
}

/** Reviewed content/deadline edits preserve work kind, lifecycle and assignment. */
export type OfficeWorkUpdateInput = Omit<OfficeWorkInput, 'kind' | 'ownerId' | 'status'> & {
  readonly priority?: OfficeWorkPriority | undefined
}

/** One explicitly identified Agent creation of an internal task/to-do under a captured reminder selection. */
export interface OfficeAgentWorkInput {
  readonly requestId: string
  readonly captureId: OfficeConversationCaptureId
  readonly work: OfficeWorkInput
}

/** Durable execution identity and current authorized item; retrying never creates a second item. */
export interface OfficeAgentWorkReceipt {
  readonly requestId: string
  readonly captureId: OfficeConversationCaptureId
  readonly acceptedAt: number
  readonly item: OfficeItem
}

/** Calendar input; an organizer is inserted once even if selected as an invitee. */
export interface OfficeScheduleInput {
  readonly title: string
  readonly description?: string | undefined
  readonly date: string
  readonly startTime: string
  readonly endTime: string
  readonly location?: string | undefined
  readonly inviteeIds: readonly OfficeMemberId[]
}

/** Reviewed meeting changes; omitted invitees preserve membership, and the organizer always participates. */
export type OfficeScheduleUpdateInput = Omit<OfficeScheduleInput, 'inviteeIds'> & {
  readonly inviteeIds?: readonly OfficeMemberId[] | undefined
}

/** Same-day busy query; an excluded meeting must be readable by the authenticated caller. */
export interface OfficeScheduleAvailabilityInput {
  readonly date: string
  readonly startTime: string
  readonly endTime: string
  readonly memberIds: readonly OfficeMemberId[]
  readonly excludeItemId?: OfficeItemId | undefined
}

/** Opt-in internal meeting occupancy at a point in time, without private meeting identities or content. */
export interface OfficeScheduleAvailability {
  readonly date: string
  readonly startTime: string
  readonly endTime: string
  readonly timeZone: string
  readonly checkedAt: number
  readonly members: readonly { readonly memberId: OfficeMemberId; readonly busy: boolean }[]
}

/** Recipient notice; a previous title remains readable after task transfer or meeting removal revokes access. */
export interface OfficeNotification {
  readonly id: OfficeNotificationId
  readonly recipientId: OfficeMemberId
  readonly actorId: OfficeMemberId
  readonly itemId: OfficeItemId
  readonly kind: 'assigned' | 'invited' | 'invitation_reply' | 'status_changed' | 'schedule_updated' | 'schedule_removed'
    | 'task_accepted' | 'task_rejected' | 'task_transferred' | 'work_updated' | 'todo_reassigned' | 'work_prioritized'
    | 'work_subtasks_updated' | 'work_attachments_updated'
    | 'work_archived' | 'work_deleted' | 'work_restored'
    | 'delivery_submitted' | 'delivery_accepted' | 'delivery_returned'
  readonly itemTitle?: string | undefined
  readonly createdAt: number
  readonly read: boolean
}

/** Committed business operation; visible only to administrators. */
export interface OfficeAuditEntry {
  readonly revision: number
  readonly actorId: OfficeMemberId
  readonly action:
    | 'work_created'
    | 'work_updated'
    | 'work_subtasks_updated'
    | 'work_attachments_updated'
    | 'work_archived'
    | 'work_deleted'
    | 'work_restored'
    | 'delivery_submitted'
    | 'delivery_accepted'
    | 'delivery_returned'
    | 'todo_reassigned'
    | 'work_prioritized'
    | 'schedule_created'
    | 'schedule_updated'
    | 'schedule_members_updated'
    | 'task_accepted'
    | 'task_rejected'
    | 'task_transferred'
    | 'status_changed'
    | 'invitation_reply'
    | 'profile_updated'
    | 'member_saved'
  readonly targetId: string
  readonly time: number
}

/** Durable operation and authenticated request-denial histories included in administrator audit searches. */
export type OfficeAuditSource = 'business' | 'identity' | 'organization' | 'drive' | 'integration' | 'connection' | 'request_denial'

/** Allowlisted committed-operation metadata; source and revision identify one retained entry. */
export interface OfficeAuditRecord {
  readonly source: OfficeAuditSource
  readonly revision: number
  readonly actorId: OfficeMemberId
  readonly action: string
  readonly targetId: string
  readonly time: number
  /** Present only for an authenticated request denial; excludes raw diagnostics and rejected input. */
  readonly denialCode?: Extract<OfficeErrorCode, 'forbidden' | 'not_found' | 'conflict' | 'invalid_input' | 'unauthenticated'>
}

/** Exclusive older-page position, with deterministic ordering for equal timestamps. */
export interface OfficeAuditCursor {
  readonly time: number
  readonly source: OfficeAuditSource
  readonly revision: number
}

/** Exact metadata filters over retained histories; timestamps are inclusive Unix milliseconds. */
export interface OfficeAuditQuery {
  readonly limit: number
  readonly before: OfficeAuditCursor | null
  readonly source?: OfficeAuditSource | undefined
  readonly actorId?: OfficeMemberId | undefined
  readonly targetId?: string | undefined
  readonly action?: string | undefined
  readonly since?: number | undefined
  readonly until?: number | undefined
}

/** At most 100 newest-first entries; total counts retained filter matches before pagination. */
export interface OfficeAuditPage {
  readonly entries: readonly OfficeAuditRecord[]
  readonly next: OfficeAuditCursor | null
  readonly total: number
}

/** One bounded NDJSON batch; continuation requires a fresh administrator-authorized request. */
export interface OfficeAuditExport {
  readonly mediaType: 'application/x-ndjson'
  readonly content: string
  readonly count: number
  readonly total: number
  readonly next: OfficeAuditCursor | null
}

/** Board calculations use exactly the authorized day's items, including closed records. */
export interface OfficeDay {
  readonly date: string
  readonly items: readonly OfficeItem[]
  readonly pending: number
  readonly completed: number
  readonly cancelled: number
  readonly work: number
  readonly schedules: number
  readonly completionRate: number
}

/** One authorized item's derived company time, or a safe marker requiring its stored time to be reviewed. */
export type OfficeCalendarItemTime = { readonly itemId: OfficeItemId } & (OfficeItemTime | { readonly kind: 'unresolved' })

/** One server observation of authorized active and inactive items; no persisted status changes. */
export interface OfficeCalendarTimeView {
  readonly checkedAt: number
  readonly items: readonly OfficeCalendarItemTime[]
}

/** Safe employee projection. This is not a raw persistence snapshot. */
export interface OfficeView {
  /** Optional own-automation configuration and review route; omission means unavailable. */
  readonly automations?: { readonly protocol: 1 }
  /** Present only when central reminder polling is explicitly configured on this authority. */
  readonly reminders?: OfficeRemindersView
  /** Absent on older servers; clients display these decisions without consulting their own clock or timezone. */
  readonly calendarTime?: OfficeCalendarTimeView | undefined
  /** Present when the authority can retain employee-private customization drafts. */
  readonly customizations?: OfficeCustomizationLimits
  /** Authorized archived work and recycle-bin records; absence identifies a server without lifecycle operations. */
  readonly inactiveWork?: readonly OfficeItem[] | undefined
  /** Present when reviewed work attachments are supported by the authoritative server. */
  readonly workAttachmentLimits?: { readonly protocol: 1; readonly maxFiles: number } | undefined
  /** Present only when the company explicitly enables internal meeting busy sharing. */
  readonly scheduleAvailabilityEnabled?: boolean | undefined
  readonly revision: number
  readonly companyName: string
  readonly timeZone: string
  readonly me: OfficeMember
  readonly members: readonly OfficeMember[]
  /** Full directory, including inactive identities, returned only to active administrators. */
  readonly managedMembers?: readonly OfficeMember[]
  readonly items: readonly OfficeItem[]
  readonly notifications: readonly OfficeNotification[]
  readonly day: OfficeDay
  /** Present after an administrator explicitly initializes formal organization. */
  readonly organization?: OfficeOrganizationView
  /** Descriptive company registrations; absent when an older office server has no catalog. */
  readonly integrations?: OfficeIntegrationView
  /** Optional for compatibility with office servers predating company announcements. */
  readonly announcements?: OfficeAnnouncementView
  /** Absent when the authority cannot prepare or read submitted drive references. */
  readonly conversationFiles?: OfficeConversationFileLimits
  /** Present only while authorized knowledge indexing is enabled. */
  readonly knowledge?: { readonly protocol: 1; readonly maxResults: number }
}

/** Private message participants and display names are retained with the historical record. */
export interface OfficeChatMessage {
  readonly id: OfficeMessageId
  readonly sequence: number
  readonly senderId: OfficeMemberId
  readonly recipientId: OfficeMemberId
  readonly senderName: string
  readonly recipientName: string
  readonly text: string
  readonly createdAt: number
  /** Present only for file messages whose immutable bytes were confirmed before publication. */
  readonly attachments?: readonly OfficeChatAttachment[]
}

/** Retrying this exact identity and payload returns the original committed message. */
export interface OfficeChatInput {
  readonly id: OfficeMessageId
  readonly recipientId: OfficeMemberId
  readonly text: string
}

/** Opaque immutable file identity scoped by its published private message. */
export type OfficeChatAttachmentId = Branded<'OfficeChatAttachmentId'>
/** Only authorized message participants receive file metadata; no server path is exposed. */
export interface OfficeChatAttachment {
  readonly id: OfficeChatAttachmentId
  readonly name: string
  readonly mediaType: string
  readonly byteLength: number
  readonly sha256: string
}
/** One bounded selected file; the owning admission verifies canonical encoding and decoded size. */
export interface OfficeChatFileInput {
  readonly name: string
  readonly mediaType: string
  readonly byteLength: number
  readonly dataBase64: string
}
/** Exact retry identity, caption and ordered files; an empty caption displays the file names. */
export interface OfficeChatFilesInput extends OfficeChatInput {
  readonly files: readonly OfficeChatFileInput[]
}
/** Current employee's bounded message policy and logical file usage, independent of the drive quota. */
export interface OfficeChatFileLimits {
  readonly protocol: 1
  readonly maxFileBytes: number
  readonly maxMessageBytes: number
  readonly maxFilesPerMessage: number
  readonly ownerQuotaBytes: number
  readonly ownerUsedBytes: number
  readonly maxPendingMessages: number
  readonly expiresAfterMs: number
}
/** File access is bound to a retained message, never to a caller-supplied filesystem path. */
export interface OfficeChatFileCoordinates {
  readonly messageId: OfficeMessageId
  readonly attachmentId: OfficeChatAttachmentId
}
/** Verified complete bytes of one immutable attachment, returned only to an active participant. */
export interface OfficeChatFileDownload extends OfficeChatAttachment {
  readonly messageId: OfficeMessageId
  readonly dataBase64: string
}

/** Versioned private file selection; pending sends retain their exact caption and retry identity. */
export interface OfficeChatFileDraft {
  readonly peerId: OfficeMemberId
  /** Current contact identity in authorized metadata views, including inactive contacts with retained drafts. */
  readonly peer?: OfficeChatPeer
  readonly revision: number
  readonly files: readonly OfficeChatAttachment[]
  readonly updatedAt: number
  readonly pendingSend: OfficeChatFileDraftSendInput | null
}
/** Replace one reviewed contact selection atomically; empty files leave a version tombstone. */
export interface OfficeChatFileDraftInput {
  readonly peerId: OfficeMemberId
  readonly revision: number
  readonly requestId: string
  readonly files: readonly OfficeChatFileInput[]
}
/** Only the authenticated owner's metadata and logical draft usage are projected. */
export interface OfficeChatFileDraftView {
  readonly meId: OfficeMemberId
  readonly drafts: readonly OfficeChatFileDraft[]
  readonly ownerUsedBytes: number
  readonly ownerQuotaBytes: number
}
/** A private draft download requires its owner's current contact version and opaque file identity. */
export interface OfficeChatFileDraftCoordinates {
  readonly peerId: OfficeMemberId
  readonly revision: number
  readonly attachmentId: OfficeChatAttachmentId
}
/** Complete verified draft bytes, accessible only to the draft owner rather than the recipient. */
export interface OfficeChatFileDraftDownload extends OfficeChatAttachment {
  readonly peerId: OfficeMemberId
  readonly revision: number
  readonly dataBase64: string
}
/** Publish the reviewed durable selection; retries retain this exact identity, version and text. */
export interface OfficeChatFileDraftSendInput {
  readonly id: OfficeMessageId
  readonly peerId: OfficeMemberId
  readonly revision: number
  readonly text: string
}

/** Inactive contacts retain their last historical name without exposing new directory details. */
export interface OfficeChatPeer {
  readonly id: OfficeMemberId
  readonly name: string
  readonly active: boolean
}

/** One conversation in the current employee's private list. */
export interface OfficeChatThread {
  readonly peer: OfficeChatPeer
  readonly latest: OfficeChatMessage
  readonly unread: number
}

/** Authorized thread list and at most 100 messages before an exclusive sequence cursor. */
export interface OfficeChatView {
  readonly revision: number
  readonly meId: OfficeMemberId
  readonly threads: readonly OfficeChatThread[]
  readonly peer: OfficeChatPeer | null
  readonly messages: readonly OfficeChatMessage[]
  readonly hasMore: boolean
  readonly readThrough: number
  readonly peerReadThrough: number
}

/** One employee's unsent text for a contact; empty text retains its version tombstone. */
export interface OfficeChatDraft {
  readonly peerId: OfficeMemberId
  readonly text: string
  readonly revision: number
}

/** Private drafts never appear in the contact's history or an administrator projection. */
export interface OfficeChatDraftView {
  readonly meId: OfficeMemberId
  readonly drafts: readonly OfficeChatDraft[]
}

/** A reviewed version and retry identity protect simultaneous windows and uncertain writes. */
export interface OfficeChatDraftInput {
  readonly peerId: OfficeMemberId
  readonly text: string
  readonly revision: number
  readonly requestId: string
}

/** Opaque enterprise drive identity, unrelated to an operating-system path. */
export type OfficeDriveId = Branded<'OfficeDriveId'>
/** Private roots are account-specific; shared roots belong to the company. */
export type OfficeDriveSpace = 'private' | 'shared'
/** Permissions are evaluated at every ancestor before reaching a child. */
export type OfficeDriveAccess = 'deny' | 'view' | 'edit'
/** A node may inherit its parent's default or establish its own. */
export type OfficeDriveDefault = OfficeDriveAccess | 'inherit'
/** Only an owner may manage explicit account conditions on a shared entry. */
export interface OfficeDriveGrant {
  readonly memberId: OfficeMemberId
  readonly access: OfficeDriveAccess
}
/** Root is virtual; no client supplies a filesystem path. */
export interface OfficeDriveLocation {
  readonly space: OfficeDriveSpace
  readonly folderId: OfficeDriveId | null
}
/** Name search is scoped to visible descendants of the selected folder. */
export interface OfficeDriveQuery extends OfficeDriveLocation {
  readonly search: string
}
/** Safe metadata; permission conditions are included only for the entry owner. */
export interface OfficeDriveEntry {
  readonly id: OfficeDriveId
  readonly parentId: OfficeDriveId | null
  readonly space: OfficeDriveSpace
  readonly ownerId: OfficeMemberId
  readonly kind: 'folder' | 'file'
  readonly name: string
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly byteLength: number
  readonly mediaType: string
  readonly access: 'view' | 'edit'
  readonly canRename: boolean
  readonly canManageAccess: boolean
  /** Present when version updates and lifecycle operations are supported by this server. */
  readonly canUpdate?: boolean
  /** Deletion and recovery require ownership and an editable parent. */
  readonly canTrash?: boolean
  readonly defaultAccess?: OfficeDriveDefault
  readonly grants?: readonly OfficeDriveGrant[]
}
/** An authorized folder listing or search result with visible breadcrumbs. */
export interface OfficeDriveView {
  readonly revision: number
  readonly meId: OfficeMemberId
  readonly location: OfficeDriveLocation
  readonly path: readonly OfficeDriveEntry[]
  readonly entries: readonly OfficeDriveEntry[]
  readonly canCreate: boolean
  readonly maxFileBytes: number
  /** Present when this server supports resumable uploads and version-bound ranged downloads. */
  readonly transfers?: OfficeDriveTransferLimits
  /** Version history, reviewed replacements and recycle-bin operations are available. */
  readonly lifecycle?: 1
  /** Permanent cleanup is available with a reviewed, durable owner decision. */
  readonly cleanup?: 1
  /** Current employee-owned bytes, including retained versions and pending cleanup. */
  readonly quota?: OfficeDriveQuota
}
/** Published and reserved bytes are charged to the file owner rather than a shared-file editor. */
export interface OfficeDriveQuota {
  readonly usedBytes: number
  readonly reservedBytes: number
  readonly limitBytes: number
}
/** One historical immutable object; current read access is required for every download. */
export interface OfficeDriveVersion {
  readonly versionId: OfficeDriveVersionId
  readonly sha256: string
  readonly byteLength: number
  readonly mediaType: string
  readonly createdAt: number
  readonly actorId: OfficeMemberId
  readonly current: boolean
}
/** History is ordered newest first and contains no upload retry credentials. */
export interface OfficeDriveHistory {
  readonly entry: OfficeDriveEntry
  readonly versions: readonly OfficeDriveVersion[]
}
/** Retained deleted metadata is visible only to its owner through a visible parent. */
export interface OfficeDriveTrashEntry extends OfficeDriveEntry {
  readonly deletedAt: number
  /** Current ownership, parent edit authority and descendant ownership permit a new decision. */
  readonly canPurge?: boolean
  /** A pending approved decision prevents restoration; completed records leave the recycle bin. */
  readonly purge?: OfficeDrivePurgeReceipt
}
/** Opaque identity of one explicitly confirmed permanent-cleanup request. */
export type OfficeDrivePurgeRequestId = Branded<'OfficeDrivePurgeRequestId'>
/** An exact review of the owned deleted subtree; the digest binds all retained version metadata. */
export interface OfficeDrivePurgePlan {
  readonly entry: OfficeDriveTrashEntry
  readonly digest: string
  readonly files: number
  readonly folders: number
  readonly versions: number
  readonly byteLength: number
}
/** Retry this exact body after an uncertain acknowledgement; changed scope requires a fresh review. */
export interface OfficeDrivePurgeInput {
  readonly id: OfficeDriveId
  readonly revision: number
  readonly digest: string
  readonly requestId: OfficeDrivePurgeRequestId
}
/** Owner-only evidence of an irreversible decision; pending cleanup still consumes byte quota. */
export interface OfficeDrivePurgeReceipt {
  readonly id: OfficeDriveId
  readonly requestId: OfficeDrivePurgeRequestId
  readonly status: 'pending' | 'completed'
  readonly requestedAt: number
  readonly completedAt: number | null
  readonly files: number
  readonly folders: number
  readonly versions: number
  readonly byteLength: number
}
/** Recycle-bin roots omit descendants hidden by another deleted directory. */
export interface OfficeDriveTrash {
  readonly revision: number
  readonly meId: OfficeMemberId
  readonly entries: readonly OfficeDriveTrashEntry[]
}
/** A reviewed deletion or restoration; an optional restore name resolves sibling conflicts. */
export interface OfficeDriveLifecycleInput {
  readonly id: OfficeDriveId
  readonly revision: number
  readonly action: 'trash' | 'restore'
  readonly name?: string | undefined
}
/** Create a folder in a reviewed location; the Host assigns its owner. */
export interface OfficeDriveFolderInput extends OfficeDriveLocation {
  readonly name: string
}
/** Renaming uses an opaque identity and the version the employee reviewed. */
export interface OfficeDriveRenameInput {
  readonly id: OfficeDriveId
  readonly revision: number
  readonly name: string
}
/** Complete owner-authored shared conditions; duplicates and inactive grants are rejected. */
export interface OfficeDrivePermissionsInput {
  readonly id: OfficeDriveId
  readonly revision: number
  readonly defaultAccess: OfficeDriveDefault
  readonly grants: readonly OfficeDriveGrant[]
}

/** One bounded upload; retry the exact payload and request id after an uncertain response. */
export interface OfficeDriveUploadInput extends OfficeDriveFolderInput {
  readonly requestId: string
  readonly mediaType: string
  readonly byteLength: number
  readonly dataBase64: string
}
/** Only a current authorized reader receives immutable bytes and their integrity digest. */
export interface OfficeDriveDownload {
  readonly id: OfficeDriveId
  readonly name: string
  readonly mediaType: string
  readonly byteLength: number
  readonly sha256: string
  readonly dataBase64: string
}

/** Opaque server-owned coordinate of one durable upload session. */
export type OfficeDriveUploadId = Branded<'OfficeDriveUploadId'>
/** Immutable version coordinate selected by the drive authority. */
export type OfficeDriveVersionId = Branded<'OfficeDriveVersionId'>

/** Advertised bounds for the additive chunk protocol; legacy whole-file bounds retain their own field. */
export interface OfficeDriveTransferLimits {
  readonly protocol: 1
  readonly maxFileBytes: number
  readonly ownerQuotaBytes: number
  readonly chunkBytes: number
  readonly maxPendingUploads: number
  readonly expiresAfterMs: number
}

/** Immutable reviewed destination and content declaration; the Host assigns the upload identity and owner. */
export interface OfficeDriveUploadDeclaration extends OfficeDriveFolderInput {
  readonly requestId: string
  readonly mediaType: string
  readonly byteLength: number
  readonly sha256: string
  /** Replace this exact logical file revision; absence creates a new file. */
  readonly target?: { readonly id: OfficeDriveId; readonly revision: number } | undefined
}

/** One canonical bounded chunk, retried with the same position and digest after an uncertain acknowledgement. */
export interface OfficeDriveUploadChunkInput {
  readonly uploadId: OfficeDriveUploadId
  readonly index: number
  readonly sha256: string
  readonly dataBase64: string
}

/** Only the authenticated owner receives receipt positions or the upload's original declaration. */
export interface OfficeDriveUploadTicket extends OfficeDriveUploadDeclaration {
  readonly id: OfficeDriveUploadId
  readonly status: 'uploading' | 'completed' | 'cancelled' | 'expired'
  readonly chunkBytes: number
  readonly received: readonly number[]
  readonly receivedBytes: number
  readonly createdAt: number
  readonly expiresAt: number
  readonly fileId: OfficeDriveId | null
}

/** Metadata is returned only after authorizing and checking the complete immutable object. */
export interface OfficeDriveDownloadInfo {
  readonly id: OfficeDriveId
  readonly versionId: OfficeDriveVersionId
  readonly name: string
  readonly mediaType: string
  readonly byteLength: number
  readonly sha256: string
  readonly chunkBytes: number
}

/** Reviewed immutable drive coordinates; file names and digests are always resolved by the office authority. */
export interface OfficeConversationFileReference {
  readonly id: OfficeDriveId
  readonly versionId: OfficeDriveVersionId
  readonly name: string
  readonly mediaType: string
  readonly byteLength: number
  readonly sha256: string
}

/** One employee's private file selection for a logical native conversation. */
export interface OfficeConversationFiles {
  readonly conversationId: OfficeConversationId
  readonly revision: number
  readonly requestId: string | null
  readonly updatedAt: number | null
  readonly files: readonly OfficeConversationFileReference[]
}

/** Fixed protocol bounds, distinct from native attachment upload limits. */
export interface OfficeConversationFileLimits {
  readonly protocol: 1
  readonly maxSelectedFiles: number
  readonly maxTextBytes: number
  readonly maxCharacters: number
  /** Optional PDF-text capability; older authorities continue to support only UTF-8 text. */
  readonly pdf?: { readonly maxBytes: number }
  /** Optional DOCX body-text capability; omission leaves Word references unavailable. */
  readonly docx?: { readonly maxBytes: number }
  /** Optional exact saved XLSX cell capability; omission leaves spreadsheet references unavailable. */
  readonly xlsx?: { readonly maxBytes: number }
  /** Optional saved-slide and explicit notes capability; omission leaves presentations unavailable. */
  readonly pptx?: { readonly maxBytes: number }
  /** Optional raster reader; absent while disabled. Animated sources are normalized to one frame by Native. */
  readonly image?: { readonly protocol: 1; readonly maxBytes: number; readonly maxPixels: number;
    readonly maxDimension: number; readonly maxResponseBytes: number; readonly mediaTypes: readonly OfficeImageMediaType[];
    readonly firstFrame: true }
}

/** Current authority identity accompanies private selection reads; it is not persisted with the selection. */
export interface OfficeConversationFilesView extends OfficeConversationFiles {
  readonly meId: OfficeMemberId
  readonly role: OfficeMember['role']
  readonly limits: OfficeConversationFileLimits
}

/** Optimistic reviewed replacement; clients supply no trusted file metadata or employee identity. */
export interface OfficeConversationFilesInput {
  readonly conversationId: OfficeConversationId
  readonly revision: number
  readonly requestId: string
  readonly files: readonly Pick<OfficeConversationFileReference, 'id' | 'versionId'>[]
}

/** Private prepared file context identity; possession grants no read authority. */
export type OfficeConversationFilesCaptureId = Branded<'OfficeConversationFilesCaptureId'>

/** Immutable descriptive evidence belonging to one employee and one submitted native input. */
export interface OfficeConversationFilesCapture {
  readonly format: 1
  readonly id: OfficeConversationFilesCaptureId
  readonly requestId: string
  readonly memberId: OfficeMemberId
  readonly role: OfficeMember['role']
  readonly capturedAt: number
  readonly selection: OfficeConversationFiles
  readonly digest: string
}

/** Bounded UTF-8 character window from a submitted file context; authorization is checked on every call. */
export interface OfficeConversationFileReadInput {
  readonly captureId: OfficeConversationFilesCaptureId
  readonly fileId: OfficeDriveId
  /** UTF-16 code-unit offset beginning at a complete character boundary. */
  readonly offset: number
  /** One to 16,384 code units; a final surrogate pair is completed before returning the continuation. */
  readonly maxCharacters: number
}

/** Exact verified version and inert text, independent of any copied native attachment. */
export interface OfficeConversationFileRead {
  readonly file: OfficeConversationFileReference
  readonly offset: number
  readonly nextOffset: number | null
  readonly totalCharacters: number
  readonly text: string
}

/** One explicitly selected PDF page; all offsets address its extracted UTF-16 text. */
export interface OfficeConversationPdfReadInput extends OfficeConversationFileReadInput {
  /** One-based page number, checked against the actual document. */
  readonly pageNumber: number
}

/** Verified PDF text from one page; scanned pages may have no extractable text. */
export interface OfficeConversationPdfRead {
  readonly file: OfficeConversationFileReference
  readonly pageNumber: number
  readonly pageCount: number
  readonly offset: number
  readonly nextOffset: number
  readonly totalCharacters: number
  readonly eof: boolean
  readonly text: string
}

/** Deployment limits for isolated PDF text extraction, independent of attachment storage. */
export interface OfficeConversationPdfConfig {
  /** Input bytes; checked before reading or creating a worker. Defaults to 8 MiB. */
  readonly maxBytes?: number
  /** Maximum total pages in an admitted document. Defaults to 200. */
  readonly maxPages?: number
  /** Extracted UTF-16 code units per page. Defaults to 262,144. */
  readonly maxPageCharacters?: number
  /** Complete native tool-content JSON UTF-8 bytes, including escaped text. Defaults to 64 KiB. */
  readonly maxOutputBytes?: number
  /** Worker wall-clock deadline in milliseconds. Defaults to 5,000. */
  readonly timeoutMs?: number
  /** Worker V8 old-generation heap limit in MiB. Defaults to 128. */
  readonly workerMemoryMb?: number
}

/** A range remains bound to the reviewed immutable version while current file permissions are rechecked. */
export interface OfficeDriveRangeInput {
  readonly id: OfficeDriveId
  readonly versionId: OfficeDriveVersionId
  readonly offset: number
  readonly byteLength: number
}

/** Bounded bytes and a range digest; the client also verifies the complete download before saving. */
export interface OfficeDriveDownloadRange extends OfficeDriveRangeInput {
  readonly sha256: string
  readonly dataBase64: string
}

export type { OfficeKnowledgePolicy, OfficeKnowledgeLocation, OfficeKnowledgeUnit, OfficeKnowledgeCitation,
  OfficeKnowledgePublication, OfficeKnowledgePublishInput, OfficeKnowledgeWithdrawInput, OfficeKnowledgeCitationInput,
  OfficeKnowledgeSearchInput, OfficeKnowledgeSearch } from './knowledge-types.ts'
export type * from './collaboration-types.ts'
export type { OfficeGroupCreateInput, OfficeGroupUpdateInput, OfficeGroupSendInput, OfficeGroupQuery } from './group-chat.ts'
export type { OfficeAccessScope, OfficeCentralPolicy, OfficeOffboardingInput, OfficeOffboardingReceipt } from './identity-governance.ts'
export type { OfficeUnifiedInboxQuery, OfficeDesktopDelivery } from './message-preferences.ts'
export type { OfficeMeetingSeriesInput } from './meeting-series.ts'
export type { OfficeUsageObservation, OfficeGovernanceAuditRow } from './usage-audit.ts'

export type { OfficeDeliveryTemplate, OfficeDeliveryPolicy, OfficeDeliveryCheckInput, OfficeDeliveryCheck } from './delivery-types.ts'

export type { OfficeAutomationCommandInput, OfficeAutomationResponse } from './automation-request.ts'
