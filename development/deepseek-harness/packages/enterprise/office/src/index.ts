import { OfficeEnterpriseSso, officeEnterpriseSsoConfig, officeEnterpriseSsoFinish } from './enterprise-sso.ts'
import type { OfficeEnterpriseSsoConfig } from './enterprise-sso.ts'
import { credentialRef as enterpriseCredentialRef } from '@deepseek-ai/dsh-credentials'
import { openOfficeCollaboration } from './collaboration.ts'
import type { OfficeCollaborationRuntime } from './collaboration.ts'
import type { OfficeCollaborationLimits, OfficeMessagePreferences } from './collaboration-types.ts'
import type { OfficeAuditRecord } from './types.ts'
import { officeGroupSchemas } from './group-chat.ts'
import type { OfficeGroupsRepository } from './group-chat.ts'
import type { OfficeIdentityGovernanceRepository, OfficeAccessScope } from './identity-governance.ts'
import type { OfficeMessagePreferencesRepository } from './message-preferences.ts'
import type { OfficeMeetingSeriesRepository, OfficeMeetingOccurrence } from './meeting-series.ts'
import type { OfficeUsageRepository } from './usage-audit.ts'
import { officeGovernanceAuditQuery } from './usage-audit.ts'
export { officeEnterpriseSsoFinish } from './enterprise-sso.ts'
import type { z as CollaborationZod } from 'zod'
/**
 * Authorized employee work and calendar operations over the office data domain.
 * Adapters authenticate employees before supplying actor ids; this service rechecks
 * membership and operation authority at execution time, including queued mutations.
 * @module @deepseek-ai/dsh-enterprise-office
 */
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { checkOfficeDelivery, officeDeliveryCheckInput, resolveOfficeDeliveryPolicy } from './delivery-check.ts'
import type { OfficeDeliveryPolicy, OfficeDeliveryCheckInput, OfficeDeliveryCheck } from './delivery-types.ts'
import { OfficeKnowledgeRepository, officeKnowledgeDomain, resolveOfficeKnowledgePolicy } from './knowledge.ts'
import { extractOfficeKnowledge, officeKnowledgeSourceLimit } from './knowledge-document.ts'
import { readOfficeKnowledgeSource } from './knowledge-source.ts'
import type { OfficeKnowledgePolicy, OfficeKnowledgePublication, OfficeKnowledgePublishInput,
  OfficeKnowledgeWithdrawInput, OfficeKnowledgeSearchInput, OfficeKnowledgeSearch,
  OfficeKnowledgeCitationInput, OfficeKnowledgeCitation } from './knowledge-types.ts'
import { OfficeImageReader, officeImageReadInput } from './image-authority.ts'
import type { OfficeConversationImageRead, OfficeConversationImageReadInput, OfficeImagePolicy } from './image-types.ts'
import { projectOfficeItemTime } from './calendar-time.ts'
import type { OfficeCalendarItemTime } from './types.ts'
import { officeRequestDenialsDomain, OfficeRequestDenialsRepository, resolveOfficeRequestDenialLimits } from './request-denials.ts'
import type { OfficeRequestDenialLimits } from './request-denials.ts'
import type { OfficeRequestDenialScope } from './types.ts'
import { extractOfficePdf, officePdfConfig, officePdfWindow, resolveOfficePdfPolicy } from './pdf.ts'
import type { OfficePdfPolicy } from './pdf.ts'
import { extractOfficeDocx, officeDocxConfig, officeDocxWindow, resolveOfficeDocxPolicy } from './docx.ts'
import type { OfficeDocxPolicy } from './docx.ts'
import { extractOfficeXlsx, officeXlsxConfig, officeXlsxWindow, resolveOfficeXlsxPolicy } from './xlsx.ts'
import type { OfficeXlsxPolicy } from './xlsx.ts'
import type { OfficeConversationXlsxConfig, OfficeConversationXlsxReadInput, OfficeConversationXlsxRead } from './xlsx-types.ts'
import type { OfficeConversationDocxConfig, OfficeConversationDocxReadInput, OfficeConversationDocxRead } from './docx-types.ts'
import { extractOfficePptx, officePptxConfig, officePptxReadInput, officePptxWindow, resolveOfficePptxPolicy } from './pptx.ts'
import type { OfficeConversationPptxConfig, OfficeConversationPptxReadInput,
  OfficeConversationPptxRead, OfficePptxPolicy } from './pptx-types.ts'
import type { OfficeConversationPdfConfig, OfficeConversationPdfReadInput, OfficeConversationPdfRead } from './types.ts'
import type { OfficeConversationFileLimits } from './types.ts'
import { queryOfficeAudit } from './audit.ts'
import type { OfficeAuditExport, OfficeAuditPage, OfficeAuditQuery } from './types.ts'
import { assertAgentWorkAuthority, officeAgentWorkDomain, officeAgentWorkInput,
  OfficeAgentWorkRepository, resolveAgentWorkPolicy } from './agent-work.ts'
import type { OfficeAgentWorkPolicy } from './agent-work.ts'
import type { OfficeAgentWorkInput, OfficeAgentWorkReceipt } from './types.ts'
import { officeConversationLinksDomain, OfficeConversationLinksRepository, resolveConversationLinkPolicy } from './conversation-links.ts'
import { officeConversationCapturesDomain, OfficeConversationCapturesRepository,
  resolveConversationCapturePolicy } from './conversation-captures.ts'
import type { OfficeConversationCapturePolicy } from './conversation-captures.ts'
import { officeConversationFilesDomain, officeConversationFileSchemas, officeConversationFileLimits,
  OfficeConversationFilesRepository } from './conversation-files.ts'
import type { OfficeConversationFiles, OfficeConversationFilesInput, OfficeConversationFilesCapture, OfficeConversationFilesCaptureId,
  OfficeConversationFileReference, OfficeConversationFileReadInput, OfficeConversationFileRead, OfficeConversationFilesView } from './types.ts'
import type { OfficeConversationCapture, OfficeConversationCaptureId, OfficeConversationCaptureInput } from './types.ts'
import type { OfficeConversationLinkPolicy } from './conversation-links.ts'
import type { OfficeConversationId, OfficeConversationLinks, OfficeConversationLinksInput, OfficeConversationLinksView } from './types.ts'
import {
  officeDate,
  officeDomain,
  officeMember,
  officeProfile,
  officeScheduleInput,
  officeScheduleUpdateInput,
  officeScheduleAvailabilityInput,
  officeTaskDecisionInput,
  officeState,
  officeWorkInput,
  officeWorkUpdateInput,
  officeWorkSubtasksInput,
  officeWorkAttachmentsInput,
  officeWorkAttachmentLimits,
  officeWorkLifecycleInput,
  officeTaskDeliveryInput,
} from './spec.ts'
import type { OfficeState } from './spec.ts'
import type { OfficeScheduleUpdateInput, OfficeTaskDecisionInput, OfficeWorkUpdateInput } from './types.ts'
import type { OfficeScheduleAvailabilityInput, OfficeScheduleAvailability } from './types.ts'
import type { OfficeSubtask, OfficeSubtaskId, OfficeWorkSubtasksInput } from './types.ts'
import type { OfficeTaskDeliveryInput } from './types.ts'
import type { OfficeWorkAttachmentsInput, OfficeWorkAttachmentsView } from './types.ts'
import type { OfficeWorkLifecycleInput } from './types.ts'
import {
  inConversation,
  officeChatDomain,
  officeChatInput,
  projectChat,
} from './chat.ts'
import type { OfficeChatState } from './chat.ts'
import { OFFICE_CHAT_INLINE_BYTES, OfficeChatFileRepository, officeChatFileCoordinates,
  officeChatFilesDomain, officeChatFilesInput } from './chat-files.ts'
import type { ChatFileAuthorityLimits } from './chat-files.ts'
import type { OfficeChatFileCoordinates, OfficeChatFileDownload, OfficeChatFileLimits, OfficeChatFilesInput } from './types.ts'
import { officeChatDraftDomain, officeChatDraftInput } from './chat-drafts.ts'
import { officeChatFileDraftDomain, officeChatFileDraftInput, officeChatFileDraftCoordinates,
  officeChatFileDraftSendInput, OfficeChatFileDraftRepository } from './chat-file-drafts.ts'
import type { ChatFileDraftLimits } from './chat-file-drafts.ts'
import type { OfficeChatFileDraft, OfficeChatFileDraftInput, OfficeChatFileDraftView, OfficeChatFileDraftCoordinates,
  OfficeChatFileDraftDownload, OfficeChatFileDraftSendInput } from './types.ts'
import { officeDriveDomain, OfficeDriveRepository } from './drive.ts'
import type { OfficeDriveHistory, OfficeDriveLifecycleInput, OfficeDriveTrash, OfficeDriveTrashEntry } from './types.ts'
import type { OfficeDrivePurgeInput, OfficeDrivePurgePlan, OfficeDrivePurgeReceipt } from './types.ts'
import { OfficeDriveBlobStore } from './drive-blobs.ts'
import { OfficeDriveTransferFiles } from './drive-transfer-files.ts'
import { DRIVE_TRANSFER_MAX_CHUNK_BYTES, DRIVE_TRANSFER_MAX_FILE_BYTES, DRIVE_TRANSFER_MIN_CHUNK_BYTES,
  officeDriveRangeInput, officeDriveUploadDomain, OfficeDriveUploadRepository } from './drive-uploads.ts'
import type { DriveUploadAuthorityLimits } from './drive-uploads.ts'
import type { OfficeDriveDownloadInfo, OfficeDriveDownloadRange, OfficeDriveRangeInput, OfficeDriveUploadChunkInput,
  OfficeDriveUploadDeclaration, OfficeDriveUploadId, OfficeDriveUploadTicket, OfficeDriveVersionId } from './types.ts'
import { officeIdentityDomain, OfficeIdentityRepository } from './identity.ts'
import { officeIntegrationDomain, OfficeIntegrationRepository } from './integrations.ts'
import { officeConnectorDomain, OfficeConnectorRepository, resolveOfficeConnectorPolicy } from './connectors.ts'
import type { OfficeConnectorPolicy } from './connectors.ts'
import type { OfficeConnectorAdapter } from './connector-http.ts'
import { createDingTalkAdapter } from './dingtalk.ts'
import type { OfficeDingTalkConfig } from './types.ts'
import { createWeComAdapter } from './wecom.ts'
import type { OfficeWeComConfig } from './types.ts'
import { OfficeAutomationRepository, officeAutomationDomain } from './automation.ts'
import type { OfficeAutomationLimits, OfficeAutomationRun } from './automation.ts'
import { executeOfficeAutomationCommand, officeAutomationCommand } from './automation-request.ts'
import type { OfficeAutomationCommandInput, OfficeAutomationResponse } from './automation-request.ts'
import { createOaV2Adapter, officeOaV2Config } from './oa-v2.ts'
import type { OfficeOaV2Config } from './oa-v2.ts'
import { createOfficeOaMaterialReader } from './oa-materials.ts'
export { createOaV2Adapter } from './oa-v2.ts'
export type { OfficeOaV2Config, OfficeOaMaterialReader } from './oa-v2.ts'
export type { OfficeAutomationCommandInput, OfficeAutomationResponse } from './automation-request.ts'
export type { OfficeAutomationRule, OfficeAutomationRun, OfficeAutomationRunId, OfficeAutomationRuleId,
  OfficeAutomationAction, OfficeAutomationReview, OfficeAutomationAudit, OfficeAutomationLimits, OfficeAutomationHost } from './automation.ts'
import { createOaAdapter } from './oa.ts'
import type { OfficeOaConfig } from './types.ts'
import { officeWeComMessageDomain } from './wecom-messages.ts'
import { OfficeMessageProviderRepository } from './message-provider.ts'
import type { OfficeConnectorEntry, OfficeConnectorInput, OfficeConnectorProbe, OfficeConnectorView } from './types.ts'
import type { OfficeConnectorActionsView, OfficeIntegrationId, OfficeConnectorReadInput, OfficeConnectorReadReceipt } from './types.ts'
import { assertConversationConnectorAuthority, officeConversationConnectorInput,
  officeConversationConnectorReadInput } from './conversation-connectors.ts'
import type { OfficeConversationConnectorInput, OfficeConversationConnectorReadInput } from './types.ts'
import { officeConnectorExecutionDomain, officeConnectorWriteInput, OfficeConnectorExecutionRepository,
  resolveConnectorExecutionPolicy } from './connector-executions.ts'
import type { OfficeConnectorExecutionPolicy } from './connector-executions.ts'
import type { OfficeConnectorExecutionReceipt, OfficeConnectorWriteInput, OfficeConnectorExecutionId,
  OfficeConnectorExecutionQuery, OfficeConnectorExecutionPage } from './types.ts'
import type { OfficeConnectorExecutionCheck } from './types.ts'
import { officeConnectorSyncDomain, OfficeConnectorSyncRepository } from './connector-syncs.ts'
import { officeCustomizationDomain, OfficeCustomizationRepository } from './customizations.ts'
import { officeDingTalkMessageDomain, OfficeDingTalkMessageRepository } from './dingtalk-messages.ts'
import type { OfficeCustomizationId, OfficeCustomizationInput, OfficeCustomizationPage,
  OfficeCustomizationRecord, OfficeCustomizationSaveReceipt } from './types.ts'
import type { OfficeConnectorSyncInput, OfficeConnectorSyncQuery, OfficeConnectorSyncPage,
  OfficeConnectorSyncDetail, OfficeConnectorSyncId } from './types.ts'
import { officeAnnouncementDomain, OfficeAnnouncementRepository } from './announcements.ts'
import type { OfficeAnnouncement, OfficeAnnouncementId, OfficeAnnouncementInput } from './types.ts'
import { officeReminderConfig, officeRemindersDomain, OfficeRemindersRepository, resolveOfficeReminderConfig } from './reminders.ts'
import { officeMemberInviteConfig, officeMemberInvitesDomain, OfficeMemberInvitesRepository,
  officeMemberInviteSchemas, resolveOfficeMemberInviteConfig } from './member-invitations.ts'
import type { OfficeMemberInviteConfig, OfficeMemberInviteCapability, OfficeMemberInviteView, OfficeMemberInviteIssueInput,
  OfficeMemberInviteIssueReceipt, OfficeMemberInviteRevokeInput, OfficeMemberInvite,
  OfficeMemberInviteAcceptInput, OfficeMemberInviteAcceptReceipt } from './types.ts'
import type { OfficeReminderConfig, OfficeReminderId } from './types.ts'
import {
  officeOrganizationDomain,
  OfficeOrganizationRepository,
} from './organization.ts'
import type {
  OfficeAssignmentInput,
  OfficeIntegration,
  OfficeIntegrationImportInput,
  OfficeOrganizationAssignment,
  OfficeOrganizationUnit,
  OfficeOrganizationView,
  OfficePosition,
  OfficePositionInput,
  OfficeUnitInput,
} from './types.ts'
export { executeOfficeRequest } from './request.ts'
import type {
  OfficeIdentityOverview,
  OfficeLoginInput,
  OfficeLoginResult,
  OfficePasswordChangeInput,
  OfficeSessionId,
  OfficeSessionInfo,
} from './types.ts'
import type {
  OfficeAuditEntry,
  OfficeChatDraft,
  OfficeChatDraftInput,
  OfficeChatDraftView,
  OfficeChatInput,
  OfficeChatMessage,
  OfficeChatView,
  OfficeDay,
  OfficeInvitationReply,
  OfficeItem,
  OfficeItemId,
  OfficeItemStatus,
  OfficeParticipant,
  OfficeDriveDownload,
  OfficeDriveEntry,
  OfficeDriveFolderInput,
  OfficeDriveId,
  OfficeDrivePermissionsInput,
  OfficeDriveQuery,
  OfficeDriveRenameInput,
  OfficeDriveUploadInput,
  OfficeDriveView,
  OfficeMember,
  OfficeMemberId,
  OfficeNotification,
  OfficeNotificationId,
  OfficeProfile,
  OfficeRole,
  OfficeScheduleInput,
  OfficeView,
  OfficeWorkInput,
} from './types.ts'

export type * from './types.ts'
export type { OfficeConnectorAdapter, OfficeConnectorProbeRequest, OfficeConnectorProbeResult,
  OfficeConnectorReadRequest, OfficeConnectorReadResult,
  OfficeConnectorWriteRequest, OfficeConnectorWriteResult, OfficeConnectorReconcileRequest } from './connector-http.ts'
export { OfficeError } from './error.ts'
export type { OfficeErrorCode } from './error.ts'

/** First-run directory seed; later changes go through administrator operations. */
export interface OfficeBootstrapMember {
  /** Stable employee identity used by work records and trusted adapters. */
  readonly id: string
  /** Display name shown to authorized coworkers. */
  readonly name: string
  /** Department label in the company directory. */
  readonly department: string
  /** Public job title, independent of the authorization role. */
  readonly jobTitle: string
  /** Initial employee or administrator authority. */
  readonly role: OfficeRole
  /** Optional public company email address. */
  readonly email?: string
  /** Optional public company telephone number. */
  readonly phone?: string
}

/** Deployment values have no implicit company or employee identity. */
export interface Config {
  /** Explicit HTTPS OIDC endpoints and immutable-subject mappings; omission keeps enterprise sign-in disabled. */
  readonly enterpriseSso?: OfficeEnterpriseSsoConfig
  /** Optional identity/collaboration deployment; every retention and delivery bound is explicit. */
  readonly collaboration?: OfficeCollaborationLimits
  /** Company name stored during first-run initialization. */
  readonly companyName: string
  /** IANA time zone used to determine the local business day. */
  readonly timeZone: string
  /** Explicit consent to share internal meeting busy flags among active employees; defaults to false. */
  readonly scheduleAvailabilityEnabled?: boolean
  /** Explicit opt-in polling and ledger capacity; omission opens no reminder domain and starts no reminder timer. */
  readonly reminders?: OfficeReminderConfig
  /** Explicit initial directory; ignored when a saved office already exists. */
  readonly members: OfficeBootstrapMember[]
  /** Optional Harness home override; immutable files live below office/drive/v1 and office/chat/v1. */
  readonly dshHome?: string
  /** Maximum retained central mutation denial records; defaults to 10,000. Full history rejects new audit writes. */
  readonly requestDenialMaxEntries?: number
  /** Maximum complete denial global-state UTF-8 JSON bytes; defaults to 16 MiB. */
  readonly requestDenialMaxBytes?: number
  /** Exact canonical origins permitted for company connections; defaults to none, including loopback. */
  readonly connectorAllowedOrigins?: string[]
  /** Connector-specific aliases to Host credential references; defaults to none. Values never cross office RPC. */
  readonly connectorCredentials?: Record<string, string>
  /** Complete network/body probe deadline in milliseconds; defaults to 5,000. */
  readonly connectorTimeoutMs?: number
  /** Maximum complete JSON probe response bytes; defaults to 65,536. */
  readonly connectorMaxResponseBytes?: number
  /** Maximum business-action declarations per adapter registration; defaults to 100. */
  readonly connectorActionMaxCount?: number
  /** Maximum compact public action-directory bytes including response coordinates; defaults to 256 KiB. */
  readonly connectorActionMaxBytes?: number
  /** Complete sanitized business-read receipt bytes; defaults to 64 KiB. */
  readonly connectorReadMaxBytes?: number
  /** Maximum plain-text fields in a business-read response; defaults to 100. */
  readonly connectorReadMaxEntries?: number
  /** Retained employee/conversation selection versions, including empty tombstones; defaults to 10,000. */
  readonly conversationLinksMaxContexts?: number
  /** Maximum selected tools and integrations per conversation; defaults to 50. */
  readonly conversationLinksMaxSelected?: number
  /** Tool keys (`skill:name` or `template:name`) to required company integration registration names; defaults to none. */
  readonly conversationToolDependencies?: Record<string, string[]>
  /** Retained prepared contexts, independent of native prompt delivery; defaults to 10,000. */
  readonly conversationCapturesMaxEntries?: number
  /** Retained compact UTF-8 domain JSON bytes, excluding provider encoding overhead; defaults to 16 MiB. */
  readonly conversationCapturesMaxBytes?: number
  /** Maximum bytes in one prepared context; defaults to 64 KiB. */
  readonly conversationCaptureMaxBytes?: number
  /** Retained private Agent work reservations; defaults to 10,000, with no automatic expiry. */
  readonly agentWorkMaxEntries?: number
  /** Maximum compact UTF-8 Agent work reservation JSON bytes; defaults to 16 MiB. */
  readonly agentWorkMaxBytes?: number
  /** Retained external write intents and terminal receipts; defaults to 10,000 without implicit pruning. */
  readonly connectorExecutionMaxEntries?: number
  /** Complete external execution domain JSON bytes; defaults to 16 MiB. */
  readonly connectorExecutionMaxBytes?: number
  /** Retained private synchronization records; defaults to 1,000 without automatic pruning. */
  readonly connectorSyncMaxEntries?: number
  /** Maximum retained customization save receipts; defaults to 1,000 and never deletes earlier receipts. */
  readonly customizationMaxOperations?: number
  /** Maximum complete customization JSON bytes; defaults to 16 MiB. */
  readonly customizationMaxBytes?: number
  /** Opt-in DingTalk operations with explicit employee mappings; connection bearer credentials supply AppSecret. */
  readonly dingtalk?: OfficeDingTalkConfig
  /** Opt-in WeCom internal-app operations; connection bearer credentials supply CorpSecret. */
  readonly wecom?: OfficeWeComConfig
  /** Opt-in product-owned OA bridge v1; customer implementation and commissioning are required. */
  readonly oa?: OfficeOaConfig
  /** Optional separately selected product-owned OA v2 provider; no customer connection is implied. */
  readonly oaV2?: OfficeOaV2Config
  /** Optional explicit bounds for private automation rules and execution references. */
  readonly automations?: OfficeAutomationLimits
  /** Retained WeCom message reservations; defaults to 1,000 without automatic pruning. */
  readonly wecomMessageMaxEntries?: number
  /** Maximum complete WeCom provider message domain UTF-8 bytes; defaults to 16 MiB. */
  readonly wecomMessageMaxBytes?: number
  /** Retained DingTalk provider message reservations; defaults to 1,000 without automatic pruning. */
  readonly dingtalkMessageMaxEntries?: number
  /** Maximum complete DingTalk provider message domain UTF-8 bytes; defaults to 16 MiB. */
  readonly dingtalkMessageMaxBytes?: number
  /** Complete synchronization domain JSON byte budget; defaults to 16 MiB. */
  readonly connectorSyncMaxBytes?: number
  /** Complete reviewed external write input JSON bytes; defaults to 64 KiB. */
  readonly connectorWriteMaxInputBytes?: number
  /** Complete sanitized external write result JSON bytes; defaults to 64 KiB. */
  readonly connectorWriteMaxResultBytes?: number
  /** Retained announcement capacity, including withdrawn publications; defaults to 1,000. */
  readonly maxAnnouncements?: number
  /** Visible announcement rotation interval in milliseconds; defaults to 6,000. */
  readonly announcementRotationMs?: number
  /** Maximum declared resumable file size in bytes; defaults to 64 MiB. */
  readonly driveMaxFileBytes?: number
  /** All referenced versions and pending declarations share this per-employee quota; defaults to 256 MiB. */
  readonly driveOwnerQuotaBytes?: number
  /** Negotiated chunk size for new upload tickets and current downloads; defaults to 1 MiB. */
  readonly driveChunkBytes?: number
  /** Fixed upload lifetime in milliseconds; defaults to 24 hours. */
  readonly driveUploadTtlMs?: number
  /** Terminal receipt retention in milliseconds; defaults to one hour. */
  readonly driveUploadRetentionMs?: number
  /** Maximum unfinished uploads per employee; defaults to four. */
  readonly driveUploadsPerMember?: number
  /** Maximum retained upload tickets across the office; defaults to 10,000. */
  readonly driveMaxUploadSessions?: number
  /** Periodic staging cleanup interval in milliseconds; defaults to five minutes. */
  readonly driveUploadSweepMs?: number
  /** Interval for recovering already approved permanent cleanup, in milliseconds. */
  readonly drivePurgeSweepMs?: number
  /** Maximum file bytes in one inline chat message; defaults to 8 MiB. */
  readonly chatMaxFileBytes?: number
  /** Maximum combined file bytes per chat message; defaults to the 8 MiB protocol envelope. */
  readonly chatMaxMessageBytes?: number
  /** Maximum ordered files per chat message; defaults to five. */
  readonly chatFilesPerMessage?: number
  /** Published and unfinished chat files share this employee quota; defaults to 256 MiB. */
  readonly chatFileOwnerQuotaBytes?: number
  /** Unpublished file-message recovery lifetime in milliseconds; defaults to 24 hours. */
  readonly chatFilePendingTtlMs?: number
  /** Maximum unfinished file messages per employee; defaults to four. */
  readonly chatFilePendingMessages?: number
  /** Retained file-message declaration capacity; defaults to 10,000. */
  readonly chatFileMaxEntries?: number
  /** Filesystem staging block size for new chat declarations; defaults to 1 MiB. */
  readonly chatFileChunkBytes?: number
  /** Unpublished chat-file cleanup interval in milliseconds; defaults to five minutes. */
  readonly chatFileSweepMs?: number
  /** Logical private draft file quota per employee; defaults to 16 MiB, separate from sent-file quota. */
  readonly chatFileDraftOwnerQuotaBytes?: number
  /** Office-wide logical private draft file quota; defaults to 128 MiB for bounded atomic storage commits. */
  readonly chatFileDraftTotalQuotaBytes?: number
  /** Retained private file-draft contact versions, including tombstones; defaults to 10,000. */
  readonly chatFileDraftMaxEntries?: number
  /** Resource limits for submitted PDF page text; parsing creates no native attachment copy. */
  readonly conversationPdf?: OfficeConversationPdfConfig
  /** Resource limits for submitted DOCX body paragraphs and tables; no native attachment copy is created. */
  readonly conversationDocx?: OfficeConversationDocxConfig
  /** Resource limits for exact saved XLSX cells; no formula calculation or native attachment copy. */
  readonly conversationXlsx?: OfficeConversationXlsxConfig
  /** Optional PPTX slide or explicit notes reading; omission disables it and every supplied resource bound is required. */
  readonly conversationPptx?: OfficeConversationPptxConfig
  /** Optional raster reader with all explicit integer limits required; omission disables reads and capability advertisement. */
  readonly imageRead?: OfficeImagePolicy
  /** Optional authorized knowledge index; all source, retention, chunk and response bounds are explicit. */
  readonly knowledge?: OfficeKnowledgePolicy
  /** Optional real Office output checks; omission leaves the original authoring and delivery tools unchanged. */
  readonly deliveryChecks?: OfficeDeliveryPolicy
  /** Optional first-password invitation policy; omitted keeps its domain and public capability disabled. */
  readonly memberInvites?: OfficeMemberInviteConfig
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    office: OfficeService
  }
}

/** Employee work lifecycle. Returned records are borrowed read-only; callers must not mutate them. */
export class OfficeService extends Service {
  static inject = ['storageDomain']
  static Config: Schema<Config> = Schema.object({
    conversationPdf: officePdfConfig,
    conversationDocx: officeDocxConfig,
    conversationXlsx: officeXlsxConfig,
    conversationPptx: Schema.union([officePptxConfig]),
    imageRead: Schema.union([Schema.object({
      maxSourceBytes: Schema.natural().min(1).max(20 * 1024 * 1024).required()
        .description('Positive integer encoded source bytes, 1..20 MiB; complete response expansion is bounded separately.'),
      maxSourcePixels: Schema.natural().min(1).max(64 * 1024 * 1024).required()
        .description('Positive integer intrinsic width times height, 1..67,108,864 pixels; no process RSS guarantee.'),
      maxSourceDimension: Schema.natural().min(1).max(8192).required()
        .description('Positive integer maximum intrinsic width or height, 1..8192 pixels per side.'),
      maxResponseBytes: Schema.natural().min(128).max(16 * 1024 * 1024).required()
        .description('Positive integer complete UTF-8 JSON success envelope bytes, 128..16 MiB, including metadata and base64.'),
      mediaTypes: Schema.array(Schema.union(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])).min(1).max(4).required()
        .description('One to four distinct accepted raster media types; duplicate formats are rejected at policy resolution.'),
    })]),
    knowledge: Schema.union([Schema.object({
      maxDocuments: Schema.natural().min(1).max(10000).required(),
      maxIndexBytes: Schema.natural().min(1).max(134217728).required(),
      maxSourceBytes: Schema.natural().min(1).max(67108864).required(),
      maxDocumentCharacters: Schema.natural().min(1).max(2097152).required(),
      maxSections: Schema.natural().min(1).max(2000).required(),
      chunkCharacters: Schema.natural().min(1).max(16384).required(),
      maxChunksPerDocument: Schema.natural().min(1).max(100000).required(),
      maxResults: Schema.natural().min(1).max(100).required(),
      maxResponseBytes: Schema.natural().min(1).max(16777216).required(),
      timeoutMs: Schema.natural().min(1).max(30000).required(),
    })]),
    deliveryChecks: Schema.union([Schema.object({
      maxSourceBytes: Schema.natural().min(1).max(67108864).required(),
      maxDocumentCharacters: Schema.natural().min(1).max(2097152).required(),
      maxSections: Schema.natural().min(1).max(2000).required(),
      timeoutMs: Schema.natural().min(1).max(30000).required(),
      maxResultBytes: Schema.natural().min(1).max(16777216).required(),
      maxExpectedTexts: Schema.natural().min(1).max(100).required(),
      maxExpectedTextCharacters: Schema.natural().min(1).max(4096).required(),
    })]),
    memberInvites: Schema.union([officeMemberInviteConfig]),
    companyName: Schema.string().required(),
    timeZone: Schema.string().required(),
    scheduleAvailabilityEnabled: Schema.boolean().default(false),
    reminders: officeReminderConfig,
    enterpriseSso: Schema.any(),
    collaboration: Schema.union([Schema.object({
      maxEntries: Schema.natural().min(1).max(100000).required(),
      maxBytes: Schema.natural().min(1024).max(268435456).required(),
      maxGroupMembers: Schema.natural().min(2).max(1000).required(),
      maxOccurrences: Schema.natural().min(1).max(366).required(),
      deliveryLeaseMs: Schema.natural().min(1000).max(86400000).required(),
      maxDeliveryAttempts: Schema.natural().min(1).max(10).required(),
    })]),
    dshHome: Schema.string(),
    requestDenialMaxEntries: Schema.natural().min(1).max(100000).default(10000),
    requestDenialMaxBytes: Schema.natural().min(1024).max(268435456).default(16777216),
    connectorAllowedOrigins: Schema.array(Schema.string()).default([]),
    connectorCredentials: Schema.dict(Schema.string()).default({}),
    connectorTimeoutMs: Schema.natural().min(100).max(120000).default(5000),
    connectorMaxResponseBytes: Schema.natural().min(1).max(4 * 1024 * 1024).default(65536),
    connectorActionMaxCount: Schema.natural().min(1).max(1000).default(100),
    connectorActionMaxBytes: Schema.natural().min(1024).max(4 * 1024 * 1024).default(262144),
    connectorReadMaxBytes: Schema.natural().min(1024).max(4 * 1024 * 1024).default(65536),
    connectorReadMaxEntries: Schema.natural().min(1).max(1000).default(100),
    conversationLinksMaxContexts: Schema.natural().min(1).max(10000).default(10000),
    conversationLinksMaxSelected: Schema.natural().min(1).max(100).default(50),
    conversationToolDependencies: Schema.dict(Schema.array(Schema.string())).default({}),
    conversationCapturesMaxEntries: Schema.natural().min(1).max(10000).default(10000),
    conversationCapturesMaxBytes: Schema.natural().min(1024).max(268435456).default(16777216),
    conversationCaptureMaxBytes: Schema.natural().min(1024).max(1048576).default(65536),
    agentWorkMaxEntries: Schema.natural().min(1).max(10000).default(10000),
    agentWorkMaxBytes: Schema.natural().min(1024).max(268435456).default(16777216),
    connectorExecutionMaxEntries: Schema.natural().min(1).max(10000).default(10000),
    connectorExecutionMaxBytes: Schema.natural().min(1024).max(268435456).default(16777216),
    connectorSyncMaxEntries: Schema.natural().min(1).max(10000).default(1000),
    customizationMaxOperations: Schema.natural().min(1).max(10000).default(1000),
    customizationMaxBytes: Schema.natural().min(1024).max(268435456).default(16777216),
    // The union prevents object defaults from enabling an omitted provider.
    dingtalk: Schema.union([Schema.object({ appKey: Schema.string().required(), robotCode: Schema.string(),
      members: Schema.dict(Schema.object({ unionId: Schema.string().required(),
        calendarId: Schema.string(), userId: Schema.string() })).required(),
      actions: Schema.array(Schema.union(['todos', 'calendar', 'create_todo', 'create_calendar', 'send_message'])).required(),
      calendarWindowHours: Schema.natural().min(1).max(744).default(24),
    })]),
    wecom: Schema.union([Schema.object({ corpId: Schema.string().required(),
      agentId: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
      members: Schema.dict(Schema.string()).required(), actions: Schema.array(Schema.union(['profile', 'send_message'])).required(),
    })]),
    automations: Schema.union([Schema.object({
      maxRules: Schema.natural().min(1).max(10000).required(),
      maxRuns: Schema.natural().min(1).max(10000).required(),
      maxBytes: Schema.natural().min(1024).max(268435456).required(),
    })]),
    oaV2: officeOaV2Config,
    oa: Schema.union([Schema.object({ members: Schema.dict(Schema.string()).required(),
      actions: Schema.array(Schema.object({ id: Schema.string().required(), label: Schema.string().required(),
        description: Schema.string().required(), kind: Schema.union(['read', 'write']).required(),
        allowedRoles: Schema.array(Schema.union(['employee', 'manager', 'admin'])).required(),
        fields: Schema.union([Schema.array(Schema.object({ name: Schema.string().required(), label: Schema.string().required(),
          required: Schema.boolean().required(), maxLength: Schema.natural().min(1).max(4000).required() }))]),
      })).required(),
    })]),
    wecomMessageMaxEntries: Schema.natural().min(1).max(10000).default(1000),
    wecomMessageMaxBytes: Schema.natural().min(1024).max(268435456).default(16777216),
    dingtalkMessageMaxEntries: Schema.natural().min(1).max(10000).default(1000),
    dingtalkMessageMaxBytes: Schema.natural().min(1024).max(268435456).default(16777216),
    connectorSyncMaxBytes: Schema.natural().min(1024).max(268435456).default(16777216),
    connectorWriteMaxInputBytes: Schema.natural().min(1024).max(1048576).default(65536),
    connectorWriteMaxResultBytes: Schema.natural().min(1024).max(4194304).default(65536),
    maxAnnouncements: Schema.natural().min(1).max(10000).default(1000),
    announcementRotationMs: Schema.natural().min(1000).max(60000).default(6000),
    driveMaxFileBytes: Schema.natural().min(1).max(DRIVE_TRANSFER_MAX_FILE_BYTES).default(64 * 1024 * 1024),
    driveOwnerQuotaBytes: Schema.natural().min(1).max(1024 ** 4).default(256 * 1024 * 1024),
    driveChunkBytes: Schema.natural().min(DRIVE_TRANSFER_MIN_CHUNK_BYTES).max(DRIVE_TRANSFER_MAX_CHUNK_BYTES).default(1024 * 1024),
    driveUploadTtlMs: Schema.natural().min(60000).max(7 * 24 * 60 * 60 * 1000).default(24 * 60 * 60 * 1000),
    driveUploadRetentionMs: Schema.natural().min(60000).max(7 * 24 * 60 * 60 * 1000).default(60 * 60 * 1000),
    driveUploadsPerMember: Schema.natural().min(1).max(100).default(4),
    driveMaxUploadSessions: Schema.natural().min(1).max(100000).default(10000),
    driveUploadSweepMs: Schema.natural().min(1000).max(60 * 60 * 1000).default(5 * 60 * 1000),
    drivePurgeSweepMs: Schema.natural().min(1000).max(60 * 60 * 1000).default(5 * 60 * 1000),
    chatMaxFileBytes: Schema.natural().min(1).max(OFFICE_CHAT_INLINE_BYTES).default(OFFICE_CHAT_INLINE_BYTES),
    chatMaxMessageBytes: Schema.natural().min(1).max(OFFICE_CHAT_INLINE_BYTES).default(OFFICE_CHAT_INLINE_BYTES),
    chatFilesPerMessage: Schema.natural().min(1).max(20).default(5),
    chatFileOwnerQuotaBytes: Schema.natural().min(1).max(1024 ** 4).default(256 * 1024 * 1024),
    chatFilePendingTtlMs: Schema.natural().min(60000).max(30 * 24 * 60 * 60 * 1000).default(24 * 60 * 60 * 1000),
    chatFilePendingMessages: Schema.natural().min(1).max(100).default(4),
    chatFileMaxEntries: Schema.natural().min(1).max(100000).default(10000),
    chatFileChunkBytes: Schema.natural().min(64 * 1024).max(2 * 1024 * 1024).default(1024 * 1024),
    chatFileSweepMs: Schema.natural().min(1000).max(60 * 60 * 1000).default(5 * 60 * 1000),
    chatFileDraftOwnerQuotaBytes: Schema.natural().min(1).max(1024 ** 3).default(16 * 1024 * 1024),
    chatFileDraftTotalQuotaBytes: Schema.natural().min(1).max(1024 ** 3).default(128 * 1024 * 1024),
    chatFileDraftMaxEntries: Schema.natural().min(1).max(100000).default(10000),
    members: Schema.array(
      Schema.object({
        id: Schema.string().required(),
        name: Schema.string().required(),
        department: Schema.string().required(),
        jobTitle: Schema.string().required(),
        role: Schema.union(['employee', 'manager', 'admin']).required(),
        email: Schema.string(),
        phone: Schema.string(),
      }),
    ).required(),
  })

  private domain!: Domain<typeof officeDomain>
  private chatDomain!: Domain<typeof officeChatDomain>
  private chatFileDomain!: Domain<typeof officeChatFilesDomain>
  private chatFiles!: OfficeChatFileRepository
  private readonly chatFileLimits: ChatFileAuthorityLimits
  private readonly chatFileSweepMs: number
  private chatFileDraftDomain!: Domain<typeof officeChatFileDraftDomain>
  private chatFileDraftsRepository!: OfficeChatFileDraftRepository
  private readonly chatFileDraftLimits: ChatFileDraftLimits
  private draftDomain!: Domain<typeof officeChatDraftDomain>
  private driveDomain!: Domain<typeof officeDriveDomain>
  private driveRepository!: OfficeDriveRepository
  private uploadDomain!: Domain<typeof officeDriveUploadDomain>
  private uploads!: OfficeDriveUploadRepository
  private transferFiles!: OfficeDriveTransferFiles
  private readonly driveLimits: DriveUploadAuthorityLimits
  private readonly uploadSweepMs: number
  private readonly purgeSweepMs: number
  private identityDomain!: Domain<typeof officeIdentityDomain>
  private enterpriseSignIn: OfficeEnterpriseSso | undefined
  private collaboration: OfficeCollaborationRuntime | undefined
  private identities!: OfficeIdentityRepository
  private organizationDomain!: Domain<typeof officeOrganizationDomain>
  private organizations!: OfficeOrganizationRepository
  private integrationDomain!: Domain<typeof officeIntegrationDomain>
  private integrations!: OfficeIntegrationRepository
  private connectorDomain!: Domain<typeof officeConnectorDomain>
  private connectors!: OfficeConnectorRepository
  private readonly connectorPolicy: OfficeConnectorPolicy
  private conversationLinksDomain!: Domain<typeof officeConversationLinksDomain>
  private conversationLinksRepository!: OfficeConversationLinksRepository
  private readonly conversationLinkPolicy: OfficeConversationLinkPolicy
  private conversationCapturesDomain!: Domain<typeof officeConversationCapturesDomain>
  private conversationCapturesRepository!: OfficeConversationCapturesRepository
  private conversationFilesDomain!: Domain<typeof officeConversationFilesDomain>
  private conversationFilesRepository!: OfficeConversationFilesRepository
  private readonly conversationCapturePolicy: OfficeConversationCapturePolicy
  private agentWorkDomain!: Domain<typeof officeAgentWorkDomain>
  private agentWorkRepository!: OfficeAgentWorkRepository
  private readonly agentWorkPolicy: OfficeAgentWorkPolicy
  private connectorExecutionDomain!: Domain<typeof officeConnectorExecutionDomain>
  private connectorExecutionsRepository!: OfficeConnectorExecutionRepository
  private readonly connectorExecutionPolicy: OfficeConnectorExecutionPolicy
  private connectorSyncDomain!: Domain<typeof officeConnectorSyncDomain>
  private customizationDomain!: Domain<typeof officeCustomizationDomain>
  private customizations!: OfficeCustomizationRepository
  private readonly customizationLimits: { readonly maxOperations: number; readonly maxBytes: number }
  private readonly dingtalk: OfficeConnectorAdapter | undefined
  private readonly wecom: ReturnType<typeof createWeComAdapter> | undefined
  private readonly oa: OfficeConnectorAdapter | undefined
  private readonly oaV2: OfficeConnectorAdapter | undefined
  private automations: OfficeAutomationRepository | undefined
  private wecomMessageDomain!: Domain<typeof officeWeComMessageDomain>
  private wecomMessages: OfficeMessageProviderRepository | null = null
  private dingtalkMessageDomain!: Domain<typeof officeDingTalkMessageDomain>
  private dingtalkMessages: OfficeDingTalkMessageRepository | null = null
  private connectorSyncs!: OfficeConnectorSyncRepository
  private readonly connectorSyncLimits: { readonly maxEntries: number; readonly maxBytes: number }
  private announcementDomain!: Domain<typeof officeAnnouncementDomain>
  private announcements!: OfficeAnnouncementRepository
  private readonly announcementLimits: { readonly maxEntries: number; readonly rotationMs: number }
  private reminders: OfficeRemindersRepository | undefined
  private readonly reminderConfig: OfficeReminderConfig | undefined
  private readonly memberInviteConfig: OfficeMemberInviteConfig | undefined
  private memberInvites: OfficeMemberInvitesRepository | undefined
  private readonly memberInviteAccepting = new Set<Promise<OfficeMemberInviteAcceptReceipt>>()
  private tail: Promise<void> = Promise.resolve()
  private requestDenialsDomain!: Domain<typeof officeRequestDenialsDomain>
  private requestDenials!: OfficeRequestDenialsRepository
  private readonly requestDenialLimits: OfficeRequestDenialLimits
  private readonly lifetime = new AbortController()
  private readonly pdfPolicy: OfficePdfPolicy
  private readonly docxPolicy: OfficeDocxPolicy
  private readonly xlsxPolicy: OfficeXlsxPolicy
  private readonly pptxPolicy: OfficePptxPolicy | undefined
  private readonly imageReader: OfficeImageReader
  private readonly knowledgePolicy: OfficeKnowledgePolicy | undefined
  private readonly deliveryPolicy: OfficeDeliveryPolicy | undefined
  private knowledge: OfficeKnowledgeRepository | undefined
  private readonly conversationFileLimits: OfficeConversationFileLimits
  private readonly requestSession = new AsyncLocalStorage<{
    token: string
    memberId: OfficeMemberId
    denial: OfficeRequestDenialScope | null
  }>()
  private readonly ownerFiber: Fiber

  /**
   * @param ctx - Host storage owner.
   * @param config - Explicit first-run office seed.
   */
  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'office')
    this.ownerFiber = ctx.fiber
    if (config.enterpriseSso !== undefined) {
      const configured = officeEnterpriseSsoConfig.parse(config.enterpriseSso)
      this.enterpriseSignIn = new OfficeEnterpriseSso(configured, resolve => this.identities.loginFederated(resolve),
        id => { this.activeMember(this.domain.global.get(), id); this.collaboration?.governance.assert(id, 'sessions') },
        async reference => {
          const credentials = this.ctx.get('credentials')
          const resolved = credentials && await credentials.resolve(enterpriseCredentialRef(reference))
          if (!resolved) throw new OfficeError('forbidden', 'Enterprise identity client credentials are unavailable')
          return resolved.value
        })
      this.ctx.effect(() => () => { this.enterpriseSignIn?.dispose() }, 'office.enterpriseSso')
    }
    this.reminderConfig = config.reminders === undefined ? undefined : resolveOfficeReminderConfig(config.reminders)
    this.memberInviteConfig = config.memberInvites === undefined ? undefined : resolveOfficeMemberInviteConfig(config.memberInvites)
    this.requestDenialLimits = resolveOfficeRequestDenialLimits({ maxEntries: config.requestDenialMaxEntries ?? 10000,
      maxBytes: config.requestDenialMaxBytes ?? 16777216 })
    this.connectorPolicy = resolveOfficeConnectorPolicy({ allowedOrigins: config.connectorAllowedOrigins ?? [],
      credentials: config.connectorCredentials ?? {}, timeoutMs: config.connectorTimeoutMs ?? 5000,
      maxResponseBytes: config.connectorMaxResponseBytes ?? 65536,
      actionMaxCount: config.connectorActionMaxCount ?? 100, actionMaxBytes: config.connectorActionMaxBytes ?? 262144,
      readMaxBytes: config.connectorReadMaxBytes ?? 65536, readMaxEntries: config.connectorReadMaxEntries ?? 100 })
    this.conversationLinkPolicy = resolveConversationLinkPolicy({
      maxContexts: config.conversationLinksMaxContexts ?? 10000, maxSelected: config.conversationLinksMaxSelected ?? 50,
      dependencies: config.conversationToolDependencies ?? {},
    })
    this.conversationCapturePolicy = resolveConversationCapturePolicy({
      maxEntries: config.conversationCapturesMaxEntries ?? 10000, maxBytes: config.conversationCapturesMaxBytes ?? 16777216,
      maxCaptureBytes: config.conversationCaptureMaxBytes ?? 65536,
    })
    this.agentWorkPolicy = resolveAgentWorkPolicy({ maxEntries: config.agentWorkMaxEntries ?? 10000,
      maxBytes: config.agentWorkMaxBytes ?? 16777216 })
    this.connectorExecutionPolicy = resolveConnectorExecutionPolicy({ maxEntries: config.connectorExecutionMaxEntries ?? 10000,
      maxBytes: config.connectorExecutionMaxBytes ?? 16777216, maxInputBytes: config.connectorWriteMaxInputBytes ?? 65536,
      maxResultBytes: config.connectorWriteMaxResultBytes ?? 65536 })
    this.connectorSyncLimits = { maxEntries: config.connectorSyncMaxEntries ?? 1000, maxBytes: config.connectorSyncMaxBytes ?? 16777216 }
    this.dingtalk = config.dingtalk ? createDingTalkAdapter(config.dingtalk, {
      repository: () => this.dingtalkMessages,
      storageFailure: (stage, id) => { this.ctx.logger.warn(`DingTalk message ${stage} unavailable for execution ${id}`) },
    }) : undefined
    this.wecom = config.wecom ? createWeComAdapter(config.wecom, {
      repository: () => this.wecomMessages,
      storageFailure: (stage, id) => { this.ctx.logger.warn(`WeCom message ${stage} unavailable for execution ${id}`) },
    }) : undefined
    this.oa = config.oa ? createOaAdapter(config.oa, this.connectorPolicy) : undefined
    this.oaV2 = config.oaV2 ? createOaV2Adapter(config.oaV2, this.connectorPolicy, createOfficeOaMaterialReader(
      (request, reference) => {
        this.assertConversationQueryActor(request.member.id)
        const actor = this.scopeMember('files', this.domain.global.get(), request.member.id)
        if (actor.role !== request.member.role) throw new OfficeError('forbidden', 'OA material owner permission changed')
        const id = officeDriveRangeInput.shape.id.parse(reference.id)
        const version = officeDriveRangeInput.shape.versionId.parse(reference.version)
        const { entry, blob } = this.driveRepository.fileVersion(actor, id, version)
        return { blob, name: entry.name, mediaType: blob.mediaType }
      }, () => this.transferFiles, { maxFileBytes: config.oaV2.maxMaterialBytes, chunkBytes: config.driveChunkBytes ?? 1024 * 1024 },
    )) : undefined
    this.deliveryPolicy = resolveOfficeDeliveryPolicy(config.deliveryChecks)
    this.knowledgePolicy = resolveOfficeKnowledgePolicy(config.knowledge)
    this.pdfPolicy = resolveOfficePdfPolicy(config.conversationPdf)
    this.docxPolicy = resolveOfficeDocxPolicy(config.conversationDocx)
    this.xlsxPolicy = resolveOfficeXlsxPolicy(config.conversationXlsx)
    this.pptxPolicy = config.conversationPptx === undefined ? undefined : resolveOfficePptxPolicy(config.conversationPptx)
    this.imageReader = new OfficeImageReader({
      load: async (actorId, input, maxBytes, signal) => {
        signal.throwIfAborted()
        this.assertConversationQueryActor(actorId)
        const loaded = await this.loadConversationFile(actorId, input, maxBytes)
        signal.throwIfAborted()
        return loaded
      },
      publish: (actorId, input, project) => {
        this.assertConversationQueryActor(actorId)
        const actor = this.activeMember(this.domain.global.get(), actorId)
        const capture = this.conversationFilesRepository.read(actor, input.captureId)
        const selected = capture.selection.files.find(file => file.id === input.fileId)
        if (!selected) throw new OfficeError('forbidden', 'File was not submitted in this context')
        const current = this.resolveConversationFile(actor, selected)
        if (current.sha256 !== selected.sha256 || current.byteLength !== selected.byteLength)
          throw new OfficeError('conflict', 'Submitted image source changed')
        // This synchronous projection follows the final session/capture/current-file checks in the same queue.
        return project(selected)
      },
    }, config.imageRead)
    this.conversationFileLimits = { ...officeConversationFileLimits, pdf: { maxBytes: this.pdfPolicy.maxBytes },
      docx: { maxBytes: this.docxPolicy.maxBytes }, xlsx: { maxBytes: this.xlsxPolicy.maxBytes },
      ...(this.pptxPolicy ? { pptx: { maxBytes: this.pptxPolicy.maxBytes } } : {}),
      ...(this.imageReader.policy ? { image: { protocol: 1, maxBytes: this.imageReader.policy.maxSourceBytes,
        maxPixels: this.imageReader.policy.maxSourcePixels, maxDimension: this.imageReader.policy.maxSourceDimension,
        maxResponseBytes: this.imageReader.policy.maxResponseBytes, mediaTypes: this.imageReader.policy.mediaTypes,
        firstFrame: true } } : {}) }
    this.customizationLimits = { maxOperations: config.customizationMaxOperations ?? 1000,
      maxBytes: config.customizationMaxBytes ?? 16777216 }
    this.announcementLimits = { maxEntries: config.maxAnnouncements ?? 1000, rotationMs: config.announcementRotationMs ?? 6000 }
    this.driveLimits = { maxFileBytes: config.driveMaxFileBytes ?? 64 * 1024 * 1024,
      ownerQuotaBytes: config.driveOwnerQuotaBytes ?? 256 * 1024 * 1024, chunkBytes: config.driveChunkBytes ?? 1024 * 1024,
      expiresAfterMs: config.driveUploadTtlMs ?? 24 * 60 * 60 * 1000, retentionMs: config.driveUploadRetentionMs ?? 60 * 60 * 1000,
      maxPendingUploads: config.driveUploadsPerMember ?? 4, maxEntries: config.driveMaxUploadSessions ?? 10000 }
    this.uploadSweepMs = config.driveUploadSweepMs ?? 5 * 60 * 1000
    this.purgeSweepMs = config.drivePurgeSweepMs ?? 5 * 60 * 1000
    this.chatFileLimits = { maxFileBytes: config.chatMaxFileBytes ?? OFFICE_CHAT_INLINE_BYTES,
      maxMessageBytes: config.chatMaxMessageBytes ?? OFFICE_CHAT_INLINE_BYTES, maxFilesPerMessage: config.chatFilesPerMessage ?? 5,
      ownerQuotaBytes: config.chatFileOwnerQuotaBytes ?? 256 * 1024 * 1024,
      expiresAfterMs: config.chatFilePendingTtlMs ?? 24 * 60 * 60 * 1000,
      maxPendingMessages: config.chatFilePendingMessages ?? 4, maxEntries: config.chatFileMaxEntries ?? 10000,
      chunkBytes: config.chatFileChunkBytes ?? 1024 * 1024 }
    this.chatFileSweepMs = config.chatFileSweepMs ?? 5 * 60 * 1000
    if (this.chatFileLimits.maxFileBytes > this.chatFileLimits.maxMessageBytes)
      throw new Error('chatMaxFileBytes must not exceed chatMaxMessageBytes')
    this.chatFileDraftLimits = { maxFileBytes: this.chatFileLimits.maxFileBytes, maxMessageBytes: this.chatFileLimits.maxMessageBytes,
      maxFilesPerMessage: this.chatFileLimits.maxFilesPerMessage, ownerQuotaBytes: config.chatFileDraftOwnerQuotaBytes ?? 16 * 1024 * 1024,
      totalQuotaBytes: config.chatFileDraftTotalQuotaBytes ?? 128 * 1024 * 1024, maxEntries: config.chatFileDraftMaxEntries ?? 10000 }
    if (this.chatFileDraftLimits.ownerQuotaBytes > this.chatFileDraftLimits.totalQuotaBytes)
      throw new Error('chatFileDraftOwnerQuotaBytes must not exceed chatFileDraftTotalQuotaBytes')
  }

  protected async [Service.init](): Promise<void> {
    const opened: Array<{ close(): Promise<void> }> = []
    // Sibling plugin disposers run concurrently when the entire Host closes.
    const releaseDrain = this.ctx.storageDomain.beforeClose(async () => {
      this.lifetime.abort()
      await this.automations?.close()
      await this.tail
      await Promise.allSettled(this.memberInviteAccepting)
      await this.dingtalkMessages?.close()
      await this.wecomMessages?.close()
    })
    this.ctx.effect(
      () => async () => {
        this.lifetime.abort()
        await this.automations?.close()
        await this.tail
        await Promise.allSettled(this.memberInviteAccepting)
        await this.dingtalkMessages?.close()
        await this.wecomMessages?.close()
        releaseDrain()
        const results = await Promise.allSettled(
          opened.map(domain => domain.close()),
        )
        const errors = results
          .filter(result => result.status === 'rejected')
          .map((result): unknown => result.reason)
        if (errors.length)
          throw new AggregateError(errors, 'Office domains failed to close')
      },
      'office.domainClose',
    )
    const open = async <S extends DomainSpec>(spec: S): Promise<Domain<S>> => {
      const domain = await this.ctx.storageDomain.open(spec)
      if (this.isClosed()) {
        await domain.close()
        throw new OfficeError(
          'closed',
          'Office service closed during initialization',
        )
      }
      opened.push(domain)
      return domain
    }
    this.domain = await open(officeDomain)
    this.requestDenialsDomain = await open(officeRequestDenialsDomain)
    this.requestDenials = new OfficeRequestDenialsRepository(this.requestDenialsDomain, this.requestDenialLimits)
    this.chatDomain = await open(officeChatDomain)
    this.chatFileDomain = await open(officeChatFilesDomain)
    this.chatFileDraftDomain = await open(officeChatFileDraftDomain)
    this.draftDomain = await open(officeChatDraftDomain)
    this.driveDomain = await open(officeDriveDomain)
    this.uploadDomain = await open(officeDriveUploadDomain)
    this.identityDomain = await open(officeIdentityDomain)
    this.organizationDomain = await open(officeOrganizationDomain)
    this.integrationDomain = await open(officeIntegrationDomain)
    this.connectorDomain = await open(officeConnectorDomain)
    this.conversationLinksDomain = await open(officeConversationLinksDomain)
    this.conversationCapturesDomain = await open(officeConversationCapturesDomain)
    this.conversationFilesDomain = await open(officeConversationFilesDomain)
    this.agentWorkDomain = await open(officeAgentWorkDomain)
    this.agentWorkRepository = new OfficeAgentWorkRepository(this.agentWorkDomain, this.agentWorkPolicy)
    this.connectorExecutionDomain = await open(officeConnectorExecutionDomain)
    this.connectorExecutionsRepository = new OfficeConnectorExecutionRepository(
      this.connectorExecutionDomain, this.connectorExecutionPolicy)
    this.connectorSyncDomain = await open(officeConnectorSyncDomain)
    this.connectorSyncs = new OfficeConnectorSyncRepository(this.connectorSyncDomain, this.connectorSyncLimits)
    this.customizationDomain = await open(officeCustomizationDomain)
    this.customizations = new OfficeCustomizationRepository(this.customizationDomain, this.customizationLimits)
    this.dingtalkMessageDomain = await open(officeDingTalkMessageDomain)
    this.dingtalkMessages = new OfficeDingTalkMessageRepository(this.dingtalkMessageDomain,
      { maxEntries: this.config.dingtalkMessageMaxEntries ?? 1000, maxBytes: this.config.dingtalkMessageMaxBytes ?? 16777216 },
      (actor) => {
        const member = this.activeMember(this.domain.global.get(), actor.id)
        if (member.role !== actor.role) throw new OfficeError('forbidden', 'Message employee role changed')
        this.assertConversationQueryActor(actor.id)
      })
    this.wecomMessageDomain = await open(officeWeComMessageDomain)
    this.wecomMessages = new OfficeMessageProviderRepository(this.wecomMessageDomain,
      { maxEntries: this.config.wecomMessageMaxEntries ?? 1000, maxBytes: this.config.wecomMessageMaxBytes ?? 16777216 },
      (actor) => {
        const member = this.activeMember(this.domain.global.get(), actor.id)
        if (member.role !== actor.role) throw new OfficeError('forbidden', 'Message employee role changed')
        this.assertConversationQueryActor(actor.id)
      })
    this.announcementDomain = await open(officeAnnouncementDomain)
    if (this.reminderConfig) {
      this.reminders = new OfficeRemindersRepository(await open(officeRemindersDomain), this.reminderConfig, async () => {
        if (this.isClosed()) return
        try { await this.ctx.parallel('office/reminders-changed') }
        catch (error) { this.ctx.logger.warn(`office/reminders-changed observer failed: ${String(error)}`) }
      })
      const current = this.domain.global.get()
      this.reminders.verifyDirectory(current.members, current.items)
    }
    this.chatFiles = new OfficeChatFileRepository(this.chatFileDomain,
      join(resolveDshHome(this.config.dshHome), 'office', 'chat', 'v1', 'objects'),
      this.chatFileLimits, () => this.chatDomain.global.get(),
      (error) => { this.ctx.logger.warn(`Chat-file cleanup failed: ${String(error)}`) })
    this.chatFileDraftsRepository = new OfficeChatFileDraftRepository(this.chatFileDraftDomain, this.chatFileDraftLimits,
      () => this.chatDomain.global.get(), (id) => {
        const message = this.chatDomain.global.get().messages.find(entry => entry.id === id)
        return message ? this.chatFiles.decorate(message) : undefined
      }, async () => {
        try { await this.ctx.parallel('office/chat-drafts-changed') }
        catch (error) { this.ctx.logger.warn(`office/chat-drafts-changed observer failed: ${String(error)}`) }
      })
    this.announcements = new OfficeAnnouncementRepository(this.announcementDomain, async () => {
      try { await this.ctx.parallel('office/announcements-changed') }
      catch { this.ctx.logger.warn('office/announcements-changed observer failed') }
    }, this.announcementLimits)
    this.integrations = new OfficeIntegrationRepository(this.integrationDomain, async () => {
      try { await this.ctx.parallel('office/integrations-changed') }
      catch { this.ctx.logger.warn('office/integrations-changed observer failed') }
    })
    this.connectors = new OfficeConnectorRepository(this.connectorDomain, this.connectorPolicy, () => this.ctx.get('credentials'),
      () => this.integrations.view().entries, async () => {
        try { await this.ctx.parallel('office/integrations-changed') }
        catch { this.ctx.logger.warn('office/integrations-changed observer failed') }
      }, this.lifetime.signal)
    const dingtalk = this.dingtalk
    if (dingtalk) this.ctx.effect(() => this.connectors.register(dingtalk))
    const wecom = this.wecom
    if (wecom) this.ctx.effect(() => {
      const stop = this.connectors.register(wecom.adapter)
      return () => { stop(); wecom.close() }
    })
    const oa = this.oa
    if (oa) this.ctx.effect(() => this.connectors.register(oa))
    const oaV2 = this.oaV2
    if (oaV2) this.ctx.effect(() => this.connectors.register(oaV2))
    this.conversationLinksRepository = new OfficeConversationLinksRepository(this.conversationLinksDomain, this.conversationLinkPolicy,
      () => this.integrations.view().entries, async () => {
        try { await this.ctx.parallel('office/conversation-links-changed') }
        catch { this.ctx.logger.warn('office/conversation-links-changed observer failed') }
      })
    this.conversationCapturesRepository = new OfficeConversationCapturesRepository(this.conversationCapturesDomain,
      this.conversationCapturePolicy, (actor, id) => this.conversationLinksRepository.view(actor, id),
      () => this.integrations.view().entries, actor => this.connectors.view(actor))
    this.conversationFilesRepository = new OfficeConversationFilesRepository(this.conversationFilesDomain,
      (actor, file) => this.resolveConversationFile(actor, file), async () => {
        try { await this.ctx.parallel('office/conversation-links-changed') }
        catch { this.ctx.logger.warn('office/conversation-links-changed observer failed') }
      })
    this.organizations = new OfficeOrganizationRepository(
      this.organizationDomain,
      async () => {
        try {
          await this.ctx.parallel('office/organization-changed')
        } catch {
          this.ctx.logger.warn('office/organization-changed observer failed')
        }
      },
    )
    this.identities = new OfficeIdentityRepository(this.identityDomain, {
      member: id => this.activeMember(this.domain.global.get(), id),
      members: () => this.domain.global.get().members,
      assertOpen: () => {
        this.assertOpen()
      },
      enqueue: operation => this.enqueue(operation),
      assertSessionAccess: id => { this.collaboration?.governance.assert(id, 'sessions') },
    })
    if (this.memberInviteConfig) {
      const invitations = await open(officeMemberInvitesDomain)
      this.memberInvites = new OfficeMemberInvitesRepository(invitations, this.memberInviteConfig, {
        members: () => this.domain.global.get().members,
        enrolled: id => this.identityDomain.global.get().credentials.some(entry => entry.memberId === id),
      })
      this.memberInvites.verifyDirectory()
    }
    const driveObjectRoot = join(resolveDshHome(this.config.dshHome), 'office', 'drive', 'v1', 'objects')
    this.transferFiles = new OfficeDriveTransferFiles(driveObjectRoot,
      { maxFileBytes: DRIVE_TRANSFER_MAX_FILE_BYTES, chunkBytes: this.driveLimits.chunkBytes })
    this.driveRepository = new OfficeDriveRepository(
      this.driveDomain,
      async () => {
        try {
          await this.ctx.parallel('office/drive-changed')
        } catch (error) {
          this.ctx.logger.warn(
            `office/drive-changed observer failed: ${String(error)}`,
          )
        }
      },
      new OfficeDriveBlobStore(driveObjectRoot), this.driveLimits,
      (actorId, exceptRequest) => this.uploads.reservedBytes(actorId, exceptRequest),
      (error) => { this.ctx.logger.warn(`Drive permanent cleanup remains pending: ${String(error)}`) },
    )
    this.uploads = new OfficeDriveUploadRepository(this.uploadDomain, this.driveRepository, driveObjectRoot, this.driveLimits,
      (error) =>{  this.ctx.logger.warn(`Drive staging cleanup failed: ${String(error)}`) })
    if (this.knowledgePolicy) {
      this.knowledge = new OfficeKnowledgeRepository(await open(officeKnowledgeDomain), this.knowledgePolicy, {
        authorize: (actor, file) => {
          this.assertConversationQueryActor(actor.id)
          const current = this.activeMember(this.domain.global.get(), actor.id)
          if (current.role !== actor.role) throw new OfficeError('forbidden', 'Knowledge employee role changed')
          return this.resolveConversationFile(current, file)
        },
        extract: async (actor, file, policy, signal) => {
          const parsers = { pdf: this.pdfPolicy, docx: this.docxPolicy, xlsx: this.xlsxPolicy,
            ...(this.pptxPolicy ? { pptx: this.pptxPolicy } : {}) }
          const { blob } = this.driveRepository.fileVersion(actor, file.id, file.versionId)
          const bytes = await readOfficeKnowledgeSource(this.transferFiles, blob,
            officeKnowledgeSourceLimit(file, policy, parsers), this.driveLimits.chunkBytes, signal)
          return extractOfficeKnowledge(file, bytes, policy, parsers, signal)
        },
      })
    }
    if (this.config.automations) {
      const domain = await open(officeAutomationDomain)
      this.automations = new OfficeAutomationRepository(domain, {
        member: (id) => {
          this.assertConversationQueryActor(id)
          return this.activeMember(this.domain.global.get(), id)
        },
        actions: (id, system) => this.connectorActions(id, system),
        write: (id, input) => this.writeConnectorAction(id, input),
        executions: id => this.connectorExecutions(id),
        check: (id, execution) => this.checkConnectorExecution(id, execution),
        audit: (event) => {
          void this.ctx.parallel('office/automation-audit', event).catch((error: unknown) => {
            void error
            this.ctx.logger.warn('office/automation-audit observer failed')
          })
        },
      }, this.config.automations)
      if (!this.domain.global.get().initialized && domain.global.get().rules.length)
        throw new OfficeError('conflict', 'Automations require the original Office directory before startup')
      if (this.domain.global.get().initialized) this.automations.verifyDirectory(this.domain.global.get().members)
    }
    if (this.config.collaboration) {
      const rawAccess = {
        member: (id: OfficeMemberId) => this.directoryMember(this.domain.global.get(), id),
        members: () => this.domain.global.get().members,
        enqueue: <T>(operation: () => Promise<T>) => this.enqueue(operation),
        changed: async () => {
          try { await this.ctx.parallel('office/reminders-changed') }
          catch (error) { this.ctx.logger.warn('Collaboration changed observer failed; refresh the current view.') }
        },
      }
      this.collaboration = await openOfficeCollaboration({ limits: this.config.collaboration,
        rawAccess, access: { ...rawAccess, member: id => this.activeMember(this.domain.global.get(), id) }, open,
        timeZone: () => this.domain.global.get().timeZone,
        view: id => this.view(id), chat: id => this.chat(id),
        checkFile: (actor, file) => { this.driveRepository.fileVersion(actor, file.fileId, file.versionId) },
        cleanup: {
          revokeSessions: (actor, target) => this.identities.revokeForOffboarding(actor, target),
          revokeInvitations: (actor, target) => this.memberInvites?.revokeForMember(actor, target) ?? Promise.resolve(0),
        },
        commitSchedules: (actor, occurrences) => this.commitMeetingOccurrences(actor, occurrences),
        executionAudit: () => this.connectorExecutionDomain.global.get().entries,
        invitationAudit: () => {
          if (!this.memberInvites) return []
          const entries: OfficeMemberInvite[] = []
          let before: { issuedAt: number; id: string } | null = null
          const administrator = this.domain.global.get().members.find(member => member.active && member.role === 'admin')
          if (!administrator) throw new OfficeError('forbidden', 'An active administrator is required')
          do { const page = this.memberInvites.page(administrator.id, before, 100); entries.push(...page.entries); before = page.next } while (before)
          return entries
        },
        baseAudit: actor => {
          const entries: OfficeAuditRecord[] = []
          let before: OfficeAuditQuery['before'] = null
          do { const page = this.auditPage(actor, { limit: 100, before }); entries.push(...page.entries); before = page.next } while (before)
          return entries
        },
      })
      if (this.domain.global.get().initialized) this.collaboration.verifyDirectory(this.domain.global.get().members)
      else this.collaboration.assertEmpty()
    }
    if (this.domain.global.get().initialized) {
      this.requestDenials.verifyDirectory(this.domain.global.get().members)
      this.identities.verifyDirectory()
      this.organizations.verifyDirectory(this.domain.global.get().members)
      this.integrations.verifyDirectory(this.domain.global.get().members)
      this.connectors.verifyDirectory(this.domain.global.get().members)
      this.conversationLinksRepository.verifyDirectory(this.domain.global.get().members)
      this.conversationCapturesRepository.verifyDirectory(this.domain.global.get().members)
      this.conversationFilesRepository.verifyDirectory(this.domain.global.get().members)
      this.agentWorkRepository.verifyDirectory(this.domain.global.get().members)
      this.connectorExecutionsRepository.verifyDirectory(this.domain.global.get().members,
        this.integrations.view().entries)
      this.connectorSyncs.verifyDirectory(this.domain.global.get().members, this.integrations.view().entries,
        this.connectorDomain.global.get().entries)
      this.announcements.verifyDirectory(this.domain.global.get().members)
      this.customizations.verifyDirectory(this.domain.global.get().members)
      this.dingtalkMessages.verifyDirectory(this.domain.global.get().members)
      this.wecomMessages.verifyDirectory(this.domain.global.get().members)
      this.uploads.verifyDirectory(this.domain.global.get().members)
      this.chatFiles.verifyDirectory(this.domain.global.get().members)
      await this.driveRepository.sweepPurges()
      await this.uploads.sweep()
      await this.chatFiles.sweep()
      await this.chatFileDraftsRepository.recover(this.domain.global.get().members)
      this.startUploadSweep()
      this.startPurgeSweep()
      this.startChatFileSweep()
      this.startReminderPolling()
      return
    }
    if (
      this.chatDomain.global.get().messages.length ||
      this.requestDenialsDomain.global.get().entries.length ||
      this.chatFileDomain.global.get().chatRevisionFloor ||
      this.chatFileDraftDomain.global.get().drafts.length ||
      this.draftDomain.global.get().drafts.length ||
      this.driveDomain.global.get().nodes.length ||
      this.uploadDomain.global.get().entries.length ||
      this.identityDomain.global.get().initialized ||
      this.organizationDomain.global.get().initialized ||
      this.integrationDomain.global.get().entries.length ||
      this.connectorDomain.global.get().entries.length ||
      this.conversationLinksDomain.global.get().entries.length ||
      this.conversationCapturesDomain.global.get().entries.length ||
      this.agentWorkDomain.global.get().entries.length ||
      this.connectorExecutionDomain.global.get().entries.length ||
      this.connectorSyncDomain.global.get().entries.length ||
      this.customizationDomain.global.get().receipts.length ||
      this.dingtalkMessageDomain.global.get().entries.length ||
      this.wecomMessageDomain.global.get().entries.length ||
      this.announcementDomain.global.get().entries.length
    )
      throw new OfficeError(
        'conflict',
        'Saved office data requires the original office directory; restore it before startup',
      )
    const members = this.config.members.map(member =>
      officeMember.parse({
        ...member,
        active: true,
        email: member.email ?? '',
        phone: member.phone ?? '',
      }),
    )
    const state = officeState.safeParse({
      ...this.domain.global.get(),
      initialized: true,
      companyName: this.config.companyName.trim(),
      timeZone: this.config.timeZone,
      members,
    })
    if (!state.success || !this.config.companyName.trim())
      throw new OfficeError(
        'invalid_input',
        'Office bootstrap needs a company, valid timezone, unique members and an active administrator',
      )
    await this.domain.global.set(state.data)
    this.automations?.verifyDirectory(this.domain.global.get().members)
    this.startUploadSweep()
    this.startPurgeSweep()
    this.startChatFileSweep()
    this.startReminderPolling()
  }

  /**
   * Read employee contacts, their work and inbox; administrators see all work.
   * Company today and item time decisions share one server observation. A known invalid item time
   * marks only that item unresolved; unexpected failures reject the read. No status or reminder is written.
   * @param actorId - Authenticated identity supplied by a trusted adapter.
   * @param date - Existing local day; omission selects today in the configured office timezone.
   * @returns authorized projection; throws forbidden for absent/inactive employees.
   */
  view(actorId: OfficeMemberId, date?: string): OfficeView {
    this.assertOpen()
    const state = this.domain.global.get()
    const me = this.activeMember(state, actorId)
    const now = Date.now()
    const selectedDate =
      date ??
      new Intl.DateTimeFormat('en-CA', {
        timeZone: state.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(now))
    if (!officeDate.safeParse(selectedDate).success)
      throw new OfficeError(
        'invalid_input',
        'Expected an existing calendar date',
      )
    const readable = state.items.filter(item => this.canRead(me, item))
    const items = readable.filter(item => item.lifecycle === undefined)
    const organization = this.organizations.view(me, state.members)
    return {
      revision: state.revision,
      companyName: state.companyName,
      timeZone: state.timeZone,
      me,
      members: state.members.filter(member => member.active),
      items,
      inactiveWork: readable.filter(item => item.lifecycle !== undefined),
      calendarTime: {
        checkedAt: now,
        items: readable.map((item): OfficeCalendarItemTime => {
          try {
            return { itemId: item.id, ...projectOfficeItemTime(item, state.timeZone, now) }
          } catch (error) {
            if (!(error instanceof OfficeError) || error.code !== 'invalid_input') throw error
            return { itemId: item.id, kind: 'unresolved' }
          }
        }),
      },
      ...(me.role === 'admin' ? { managedMembers: state.members } : {}),
      notifications: state.notifications.filter(
        entry => entry.recipientId === actorId,
      ),
      day: this.day(selectedDate, items),
      ...(organization.initialized ? { organization } : {}),
      integrations: this.integrations.view(),
      announcements: this.announcements.view(me),
      ...(this.reminders ? { reminders: this.reminders.view(me, readable, state.timeZone, now) } : {}),
      conversationFiles: this.conversationFileLimits,
      ...(this.knowledgePolicy ? { knowledge: { protocol: 1 as const, maxResults: this.knowledgePolicy.maxResults } } : {}),
      ...(this.config.automations ? { automations: { protocol: 1 as const } } : {}),
      customizations: this.customizations.capabilities(),
      workAttachmentLimits: officeWorkAttachmentLimits,
      ...(this.config.scheduleAvailabilityEnabled ? { scheduleAvailabilityEnabled: true } : {}),
    }
  }

  /**
   * Query active coworkers' internal meeting occupancy only after deployment consent.
   * @param actorId - Current authenticated active employee.
   * @param input - Office-local date and interval, up to 500 members and an optional readable meeting to exclude.
   * @returns Unique requested members' busy flags and observation time, without meeting ids or content.
   * Pending and accepted invitations occupy time; closed meetings and declined invitations do not. No writes or reservations occur.
   */
  scheduleAvailability(actorId: OfficeMemberId, input: OfficeScheduleAvailabilityInput): OfficeScheduleAvailability {
    this.assertOpen()
    const parsed = officeScheduleAvailabilityInput.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid availability interval or member selection')
    const state = this.domain.global.get()
    const actor = this.activeMember(state, actorId)
    if (!this.config.scheduleAvailabilityEnabled) throw new OfficeError('forbidden', 'Internal meeting busy sharing is disabled')
    const query = parsed.data
    const selected = new Set(query.memberIds)
    for (const id of selected) this.activeMember(state, id)
    if (query.excludeItemId && this.readItem(state, actor, query.excludeItemId).kind !== 'schedule')
      throw new OfficeError('invalid_input', 'Only a readable meeting can be excluded')
    const busy = new Set<OfficeMemberId>()
    for (const item of state.items) {
      if (item.kind !== 'schedule' || item.id === query.excludeItemId || item.date !== query.date
        || item.status === 'completed' || item.status === 'cancelled' || !item.time || !item.endTime
        || query.startTime >= item.endTime || query.endTime <= item.time) continue
      for (const participant of item.participants) {
        if (participant.reply !== 'declined' && selected.has(participant.memberId)) busy.add(participant.memberId)
      }
    }
    return { date: query.date, startTime: query.startTime, endTime: query.endTime,
      timeZone: state.timeZone, checkedAt: Date.now(), members: [...selected].map(memberId => ({ memberId, busy: busy.has(memberId) })) }
  }

  /**
   * Register a descriptive company manifest through current administrator authority.
   * @param actorId - Authenticated active employee, rechecked inside the shared queue.
   * @param input - Bounded JSON object and stable UUID for an uncertain-response retry.
   * @returns Durable registration without installing or activating plugin code.
   */
  importIntegration(actorId: OfficeMemberId, input: OfficeIntegrationImportInput): Promise<OfficeIntegration> {
    return this.enqueue(() => this.integrations.import(this.activeMember(this.domain.global.get(), actorId), input))
  }

  /**
   * Register a trusted Host connector implementation, independently of native MCP and plugin installation.
   * @param adapter - Unique implementation; abort must stop its outstanding probe before settlement.
   * @returns Disposer to attach to the contributing plugin's effect; removal aborts its probe.
   */
  registerConnector(adapter: OfficeConnectorAdapter): () => void {
    this.assertOpen()
    return this.connectors.register(adapter)
  }

  /**
   * Read current company connection readiness without returning credential values.
   * @param actorId - Authenticated active employee; only administrators receive editable configuration.
   * @returns Adapter availability, versions and current credential presence, without a connectivity claim.
   */
  connections(actorId: OfficeMemberId): Promise<OfficeConnectorView> {
    return this.enqueue(async () => ({ ...await this.connectors.view(this.scopeMember('connectors', this.domain.global.get(), actorId)),
      synchronization: this.connectorSyncs.capabilities() }))
  }

  /**
   * Explicitly synchronize a reviewed declared read and persist its actual sanitized outcome.
   * @param actorId - Authenticated current employee, never selected in the request body.
   * @param input - Stable retry identity and exact action/connection/provider coordinates.
   * @returns Durable original record and currently authorized data; failed storage reports no success.
   */
  syncConnectorAction(actorId: OfficeMemberId, input: OfficeConnectorSyncInput): Promise<OfficeConnectorSyncDetail> {
    return this.enqueue(async () => {
      const actor = this.scopeMember('connectors', this.domain.global.get(), actorId)
      const prepared = this.connectorSyncs.prepare(actor, input)
      if (prepared.existing) return this.syncDetail(actor, prepared.existing)
      const { requestId: _requestId, ...read } = prepared.input
      const receipt = await this.connectors.readAction(actor, read, () => { this.assertConversationQueryActor(actorId) })
      this.assertConversationQueryActor(actorId)
      const saved = await this.connectorSyncs.save(actor, prepared.input, receipt)
      return this.syncDetail(actor, saved)
    })
  }

  /**
   * List only this employee's synchronization metadata without querying the company system.
   * @param actorId - Active authenticated employee, checked inside the office queue.
   * @param query - One company registration and optional owner-scoped older anchor.
   * @returns Bounded records without retained fields, credentials or customer response bodies.
   */
  connectorSyncPage(actorId: OfficeMemberId, query: OfficeConnectorSyncQuery): Promise<OfficeConnectorSyncPage> {
    return this.enqueue(() => Promise.resolve(this.connectorSyncs.page(this.scopeMember('connectors', this.domain.global.get(), actorId), query)))
  }

  /**
   * Recheck current role, declared read and saved connection before delivering historical retained fields.
   * @param actorId - Active authenticated owner; administrators have no private-data bypass.
   * @param id - Server synchronization identity.
   * @returns Historical metadata with data withheld after authorization or connection changes; no customer GET occurs.
   */
  connectorSyncDetail(actorId: OfficeMemberId, id: OfficeConnectorSyncId): Promise<OfficeConnectorSyncDetail> {
    return this.enqueue(async () => {
      const actor = this.scopeMember('connectors', this.domain.global.get(), actorId)
      return this.syncDetail(actor, this.connectorSyncs.get(actor, id))
    })
  }

  /**
   * Read private customization metadata without sending requirements outside the office.
   * @param actorId - Active authenticated employee.
   * @param before - Exclusive employee-local save position, or null for newest records.
   * @returns A bounded own page with no contact or requirement bodies.
   */
  customizationRequests(actorId: OfficeMemberId, before: number | null): Promise<OfficeCustomizationPage> {
    return this.enqueue(() => Promise.resolve(this.customizations.page(this.activeMember(this.domain.global.get(), actorId), before)))
  }

  /**
   * Read the current own draft for editing or explicit export.
   * @param actorId - Current authenticated employee; administrators have no owner bypass.
   * @param id - Server-created customization identity.
   * @returns Latest saved private version, explicitly marked not sent.
   */
  customizationRequest(actorId: OfficeMemberId, id: OfficeCustomizationId): Promise<OfficeCustomizationRecord> {
    return this.enqueue(() => Promise.resolve(this.customizations.get(this.activeMember(this.domain.global.get(), actorId), id)))
  }

  /**
   * Persist a reviewed requirement version; this operation has no external delivery side effect.
   * @param actorId - Authenticated employee, never accepted in the input.
   * @param input - Exact retry identity, reviewed version and plain-text fields.
   * @returns Original durable receipt plus the current revision; failed persistence reports no success.
   */
  saveCustomizationRequest(actorId: OfficeMemberId, input: OfficeCustomizationInput): Promise<OfficeCustomizationSaveReceipt> {
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      const result = await this.customizations.save(actor, state.companyName, input)
      this.assertConversationQueryActor(actorId)
      return result
    })
  }

  private async syncDetail(actor: OfficeMember, record: ReturnType<OfficeConnectorSyncRepository['get']>): Promise<OfficeConnectorSyncDetail> {
    const directory = await this.connectors.actions(actor, record.input.integrationId)
    this.assertConversationQueryActor(actor.id)
    const allowed = directory.status === 'unverified' && directory.readSupported === true
      && directory.connectionRevision === record.input.connectionRevision
      && directory.actions.some(action => action.id === record.input.actionId && action.kind === 'read')
    return this.connectorSyncs.detail(actor, record, allowed)
  }

  /**
   * Discover one system's current role-admitted business-action declarations without executing them.
   * @param actorId - Authenticated employee, rechecked in the shared office queue.
   * @param integrationId - Company system identity; callers cannot choose a URL or role.
   * @returns Bounded public metadata and current connection/registration coordinates, without credentials.
   */
  connectorActions(actorId: OfficeMemberId, integrationId: OfficeIntegrationId): Promise<OfficeConnectorActionsView> {
    return this.enqueue(() => this.connectors.actions(this.scopeMember('connectors', this.domain.global.get(), actorId), integrationId))
  }

  /**
   * Admit a trusted Host event without authorizing any external effect; never expose through public RPC.
   * @param actorId - Fixed deployment principal, not read from a source payload.
   * @param input - Configured source and original occurrence id.
   * @returns Own pending-review runs under current membership, enabled rules and durable deduplication.
   */
  async admitAutomationTrigger(actorId: OfficeMemberId,
    input: Parameters<OfficeAutomationRepository['trigger']>[1]): Promise<readonly OfficeAutomationRun[]> {
    this.assertConversationQueryActor(actorId)
    if (!this.automations) throw new OfficeError('forbidden', 'Office automation is not configured')
    return this.automations.trigger(actorId, input)
  }

  /**
   * Manage own automation rules and exact human-reviewed runs; Host event triggers are not exposed by this route.
   * @param actorId - Existing server-authenticated employee, rechecked after each asynchronous stage.
   * @param input - Closed command without a claimed identity, credential, URL or arbitrary event payload.
   * @returns Committed private state or an exact review; an unknown write only permits original-result recovery.
   */
  async automation(actorId: OfficeMemberId, input: OfficeAutomationCommandInput): Promise<OfficeAutomationResponse> {
    this.assertConversationQueryActor(actorId)
    if (!this.automations) throw new OfficeError('forbidden', 'Office automation is not configured')
    const parsed = officeAutomationCommand.safeParse(input)
    if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid automation command')
    const result = await executeOfficeAutomationCommand(this.automations, actorId, parsed.data)
    this.assertConversationQueryActor(actorId)
    return result
  }

  /**
   * Read the current employee's retained external-operation receipts without request values or an administrator bypass.
   * @param actorId - Active authenticated employee, rechecked in the shared office queue.
   * @returns Own evidence only; a dispatched request remains unknown until its authoritative outcome is durable.
   */
  connectorExecutions(actorId: OfficeMemberId): Promise<readonly OfficeConnectorExecutionReceipt[]> {
    return this.enqueue(() => Promise.resolve(
      this.connectorExecutionsRepository.list(this.scopeMember('connectors', this.domain.global.get(), actorId)),
    ))
  }

  /**
   * Read a newest-first bounded page of this employee's executions in one company system.
   * @param actorId - Current authenticated employee; administrators have no private history override.
   * @param query - System registration and optional own older-page anchor.
   * @returns Small receipt metadata without raw inputs, audit arrays or large business results.
   */
  connectorExecutionPage(actorId: OfficeMemberId, query: OfficeConnectorExecutionQuery): Promise<OfficeConnectorExecutionPage> {
    return this.enqueue(() => Promise.resolve(
      this.connectorExecutionsRepository.page(this.scopeMember('connectors', this.domain.global.get(), actorId), query),
    ))
  }

  /**
   * Read one employee-private bounded execution receipt, including retained authoritative result and audit stages.
   * @param actorId - Current authenticated employee, selected by the server rather than a request payload.
   * @param executionId - Own server-generated execution identity.
   * @returns The retained receipt; unlinked adapters do not erase history and another employee's id remains unavailable.
   */
  connectorExecutionDetail(actorId: OfficeMemberId, executionId: OfficeConnectorExecutionId): Promise<OfficeConnectorExecutionReceipt> {
    return this.enqueue(() => Promise.resolve(
      this.connectorExecutionsRepository.receipt(this.scopeMember('connectors', this.domain.global.get(), actorId), executionId),
    ))
  }

  /**
   * Check an own possibly committed customer operation by its original execution identity without resending it.
   * @param actorId - Current authenticated employee; current role, original connection and session remain authoritative.
   * @param executionId - Own retained server idempotency identity, never caller-selected transport parameters.
   * @returns Retained unknown/unavailable evidence or a newly durable authoritative receipt; checking never dispatches a write.
   */
  checkConnectorExecution(actorId: OfficeMemberId, executionId: OfficeConnectorExecutionId): Promise<OfficeConnectorExecutionCheck> {
    return this.enqueue(async () => {
      const actor = this.scopeMember('connectors', this.domain.global.get(), actorId)
      const repo = this.connectorExecutionsRepository
      const saved = repo.inspect(actor, executionId)
      if (saved.stage !== 'unknown' && saved.stage !== 'dispatched')
        return { status: 'updated', receipt: repo.receipt(actor, executionId) }
      try {
        const checked = await this.connectors.reconcileAction(actor, saved.input, saved.id, saved.resultByteLimit,
          () => { this.assertConversationQueryActor(actorId) })
        this.assertConversationQueryActor(actorId)
        if (checked.status !== 'checked') return { status: checked.status, receipt: repo.receipt(actor, executionId) }
        const outcome = checked.result
        const receipt = await repo.finish(actor, executionId, outcome.status === 'succeeded'
          ? { stage: 'succeeded', result: outcome.result }
          : outcome.status === 'rejected' ? { stage: 'rejected', rejection: outcome.rejection } : { stage: 'unknown' })
        this.assertConversationQueryActor(actorId)
        return { status: receipt.status === 'unknown' ? 'unknown' : 'updated', receipt }
      } catch (error) {
        if (error instanceof OfficeError) throw error
        throw new OfficeError('execution_unknown', 'Customer outcome could not be confirmed; the original operation was not resent',
          { cause: error })
      }
    })
  }

  /**
   * Submit one reviewed declared customer-system write through durable, employee-private execution evidence.
   * @param actorId - Current server-authenticated employee; clients cannot supply another actor or role.
   * @param input - Stable retry UUID, exact action/provider versions and declared text fields; optional capture narrows authority.
   * @returns Durable receipt; exact terminal retries and equivalent unresolved writes never invoke the customer system again.
   */
  writeConnectorAction(actorId: OfficeMemberId, input: OfficeConnectorWriteInput): Promise<OfficeConnectorExecutionReceipt> {
    const parsed = officeConnectorWriteInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid company write request'))
    return this.enqueue(async () => {
      const actor = this.scopeMember('connectors', this.domain.global.get(), actorId)
      const value = parsed.data
      const repo = this.connectorExecutionsRepository
      const previous = repo.find(actor, value)
      if (previous && previous.stage !== 'reserved') return repo.receipt(actor, previous.id)
      const unresolved = repo.unresolved(actor, value)
      if (unresolved) return unresolved
      const assertAuthorized = () => {
        this.assertConversationQueryActor(actorId)
        if (value.captureId === undefined) return
        const capture = this.conversationCapturesRepository.read(actor, value.captureId)
        const choices = this.conversationLinksRepository.view(actor, capture.selection.conversationId)
        const historical = assertConversationConnectorAuthority(actor, capture, choices, value.integrationId)
        if (historical.connectionRevision !== value.connectionRevision)
          throw new OfficeError('conflict', 'Captured company write connection changed')
      }
      assertAuthorized()
      const execute = await this.connectors.prepareWrite(actor, value, assertAuthorized)
      const saved = await repo.reserve(actor, value)
      const admission = { dispatched: false }
      let receipt: OfficeConnectorExecutionReceipt
      try {
        const result = await execute(saved.id, saved.resultByteLimit, async () => {
          assertAuthorized()
          await repo.dispatch(actor, saved.id)
          admission.dispatched = true
        })
        receipt = await repo.finish(actor, saved.id, result.status === 'succeeded'
          ? { stage: 'succeeded', result: result.result }
          : result.status === 'rejected' ? { stage: 'rejected', rejection: result.rejection } : { stage: 'unknown' })
      } catch (error) {
        if (!admission.dispatched) throw error
        let cause = error
        try { await repo.finish(actor, saved.id, { stage: 'unknown' }) }
        catch (persistenceError) { cause = new AggregateError([error, persistenceError], 'Could not persist the uncertain external result') }
        throw new OfficeError('execution_unknown', 'Company write outcome is unconfirmed; inspect its execution receipt before retrying', { cause })
      }
      this.assertConversationQueryActor(actorId)
      return receipt
    })
  }

  /**
   * Query one declared read action using current employee identity and reviewed connection/provider versions.
   * @param actorId - Authenticated employee; queued requests and asynchronous network admission recheck their session.
   * @param input - Registered system, declared read action and exact reviewed versions; no arbitrary parameters.
   * @returns Sanitized bounded fields or a network failure, without performing business writes or automatic retries.
   */
  readConnectorAction(actorId: OfficeMemberId, input: OfficeConnectorReadInput): Promise<OfficeConnectorReadReceipt> {
    return this.enqueue(() => this.connectors.readAction(this.scopeMember('connectors', this.domain.global.get(), actorId), input, () => {
      const session = this.requestSession.getStore()
      if (session && this.identities.authenticate(session.token).id !== actorId)
        throw new OfficeError('unauthenticated', 'The request session is no longer available')
      this.scopeMember('connectors', this.domain.global.get(), actorId)
    }))
  }

  /**
   * Discover current actions for one system in this employee's submitted native conversation context.
   * @param actorId - Authenticated employee; private captures have no administrator bypass.
   * @param input - Private capture and selected registered integration, without URLs or claimed roles.
   * @returns Role-admitted directory only while the captured connection and current associations still match.
   */
  conversationConnectorActions(actorId: OfficeMemberId, input: OfficeConversationConnectorInput): Promise<OfficeConnectorActionsView> {
    const parsed = officeConversationConnectorInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid conversation action request'))
    return this.enqueue(async () => {
      const actor = this.scopeMember('connectors', this.domain.global.get(), actorId)
      const capture = this.conversationCapturesRepository.read(actor, parsed.data.captureId)
      const choices = this.conversationLinksRepository.view(actor, capture.selection.conversationId)
      const historical = assertConversationConnectorAuthority(actor, capture, choices, parsed.data.integrationId)
      const directory = await this.connectors.actions(actor, historical.id)
      this.assertConversationQueryActor(actorId)
      if (directory.connectionRevision !== historical.connectionRevision)
        throw new OfficeError('conflict', 'Captured company connection changed')
      if (directory.status !== 'unverified') throw new OfficeError('forbidden', 'Selected company connection is unavailable')
      return directory
    })
  }

  /**
   * Query a declared read action under the submitting employee's current private conversation associations.
   * @param actorId - Authenticated employee; execution does not accept a caller-selected actor.
   * @param input - Private capture and exact action/connection/provider coordinates reviewed by native approval.
   * @returns Bounded real query result; revoked associations, changed roles and stale connections prevent execution.
   */
  readConnectorActionFromConversation(
    actorId: OfficeMemberId, input: OfficeConversationConnectorReadInput,
  ): Promise<OfficeConnectorReadReceipt> {
    const parsed = officeConversationConnectorReadInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid conversation read request'))
    return this.enqueue(() => {
      const { captureId, ...read } = parsed.data
      const actor = this.scopeMember('connectors', this.domain.global.get(), actorId)
      const capture = this.conversationCapturesRepository.read(actor, captureId)
      const assertAuthorized = () => {
        this.assertConversationQueryActor(actorId)
        const choices = this.conversationLinksRepository.view(actor, capture.selection.conversationId)
        const historical = assertConversationConnectorAuthority(actor, capture, choices, read.integrationId)
        if (historical.connectionRevision !== read.connectionRevision)
          throw new OfficeError('conflict', 'Conversation query connection version changed')
      }
      assertAuthorized()
      return this.connectors.readAction(actor, read, assertAuthorized)
    })
  }

  private assertConversationQueryActor(actorId: OfficeMemberId): void {
    this.assertOpen()
    const session = this.requestSession.getStore()
    if (session && this.identities.authenticate(session.token).id !== actorId)
      throw new OfficeError('unauthenticated', 'The request session is no longer available')
    this.activeMember(this.domain.global.get(), actorId)
  }

  /**
   * Read private association choices and current declared integration requirements for one native conversation.
   * @param actorId - Authenticated active employee; administrators receive no bypass to another employee's choices.
   * @param conversationId - Logical native Session identity, scoped to that employee.
   * @returns Reviewed choices, capacity bounds and explicit missing dependencies, without execution authority or secrets.
   */
  conversationLinks(actorId: OfficeMemberId, conversationId: OfficeConversationId): Promise<OfficeConversationLinksView> {
    return this.enqueue(() => Promise.resolve({
      ...this.conversationLinksRepository.view(this.activeMember(this.domain.global.get(), actorId), conversationId),
      conversationFiles: this.conversationFileLimits,
    }))
  }

  /**
   * Save one association list without modifying Session history or granting a tool permission.
   * @param actorId - Authenticated current employee, rechecked inside the shared mutation queue.
   * @param input - Reviewed version, exact retry identity and selected tools or integrations.
   * @returns Confirmed private choice version; selecting tools also adds their currently registered dependencies.
   */
  saveConversationLinks(actorId: OfficeMemberId, input: OfficeConversationLinksInput): Promise<OfficeConversationLinks> {
    return this.enqueue(() => this.conversationLinksRepository.save(this.activeMember(this.domain.global.get(), actorId), input))
  }

  /**
   * Prepare immutable association evidence before a separate native prompt admission.
   * @param actorId - Authenticated employee, rechecked inside the office queue.
   * @param input - Reviewed logical conversation version and exact native prompt retry identity.
   * @returns Private prepared context; no prompt is sent and no capability is authorized.
   */
  captureConversation(actorId: OfficeMemberId, input: OfficeConversationCaptureInput): Promise<OfficeConversationCapture> {
    return this.enqueue(() => this.conversationCapturesRepository.prepare(this.activeMember(this.domain.global.get(), actorId), input))
  }

  /**
   * Recover one employee's prepared context after uncertain acknowledgement or restart.
   * @param actorId - Current active employee; administrator role does not bypass ownership.
   * @param id - Prepared context identity, scoped to its owner.
   * @returns Historical metadata, without implying native admission or model dispatch.
   */
  conversationCapture(actorId: OfficeMemberId, id: OfficeConversationCaptureId): Promise<OfficeConversationCapture> {
    return this.enqueue(() => Promise.resolve(
      this.conversationCapturesRepository.read(this.activeMember(this.domain.global.get(), actorId), id),
    ))
  }

  /**
   * Read this employee's private drive references for one native conversation.
   * @param actorId - Authenticated employee; administrator role does not bypass private ownership.
   * @param conversationId - Logical native Session identity, without execution authority.
   * @returns Reviewed immutable metadata; later content reads require fresh permission checks.
   */
  conversationFiles(actorId: OfficeMemberId, conversationId: OfficeConversationId): Promise<OfficeConversationFilesView> {
    return this.enqueue(() => {
      const actor = this.scopeMember('files', this.domain.global.get(), actorId)
      return Promise.resolve({ ...this.conversationFilesRepository.view(actor, conversationId),
        meId: actor.id, role: actor.role, limits: this.conversationFileLimits })
    })
  }

  /**
   * Replace reviewed file references with metadata resolved by the authority.
   * @param actorId - Current active employee, rechecked inside the mutation queue.
   * @param input - Optimistic version, exact retry UUID and immutable file coordinates.
   * @returns Committed private selection; no bytes are copied into native attachments.
   */
  saveConversationFiles(actorId: OfficeMemberId, input: OfficeConversationFilesInput): Promise<OfficeConversationFiles> {
    return this.enqueue(() => this.conversationFilesRepository.save(this.scopeMember('files', this.domain.global.get(), actorId), input))
  }

  /**
   * Freeze file references before a separate native prompt is admitted.
   * @param actorId - Current active employee.
   * @param input - Reviewed file-selection version and native request identity.
   * @returns Immutable descriptive evidence; every content read still rechecks authority.
   */
  captureConversationFiles(actorId: OfficeMemberId, input: OfficeConversationCaptureInput): Promise<OfficeConversationFilesCapture> {
    return this.enqueue(() => this.conversationFilesRepository.prepare(this.scopeMember('files', this.domain.global.get(), actorId), input))
  }

  /**
   * Recover retained file context for its original employee and authority role.
   * @param actorId - Current authenticated employee.
   * @param id - Private capture identity; possession grants no read access.
   * @returns Historical submitted metadata without implying native admission or dispatch.
   */
  conversationFilesCapture(actorId: OfficeMemberId, id: OfficeConversationFilesCaptureId): Promise<OfficeConversationFilesCapture> {
    return this.enqueue(() => Promise.resolve(
      this.conversationFilesRepository.read(this.scopeMember('files', this.domain.global.get(), actorId), id)))
  }

  /**
   * Read a bounded character window from an explicitly submitted immutable UTF-8 file.
   * @param actorId - Current authenticated employee, rechecked before accessing bytes.
   * @param input - Owned submitted context, selected file and bounded character window.
   * @returns Verified inert text; changed versions, denied ancestors and invalid encodings return no body.
   */
  readConversationFile(actorId: OfficeMemberId, input: OfficeConversationFileReadInput): Promise<OfficeConversationFileRead> {
    const parsed = officeConversationFileSchemas.read.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid submitted file read'))
    return this.enqueue(async () => {
      const value = parsed.data
      const { file, bytes } = await this.loadConversationFile(actorId, value, officeConversationFileLimits.maxTextBytes)
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { throw new OfficeError('invalid_input', 'Submitted file is not UTF-8 text') }
      if (text.includes('\0') || value.offset > text.length)
        throw new OfficeError('invalid_input', 'Submitted file is binary or the text offset is out of range')
      let end = Math.min(text.length, value.offset + value.maxCharacters)
      // Character windows never cut a surrogate pair, even when the requested bound ends between its code units.
      if (end < text.length && end > value.offset && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end++
      if (value.offset > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(value.offset)))
        throw new OfficeError('invalid_input', 'Text offset splits a Unicode character')
      this.resolveConversationFile(this.scopeMember('files', this.domain.global.get(), actorId), file)
      return { file, offset: value.offset, nextOffset: end < text.length ? end : null,
        totalCharacters: text.length, text: text.slice(value.offset, end) }
    })
  }

  /**
   * Parse one submitted PDF page under finite input, worker and complete output limits.
   * @param actorId - Current employee; private capture role and current file authority are rechecked.
   * @param input - Exact submitted file, one-based page and bounded character window.
   * @param signal - Optional original tool or transport cancellation; office unload also terminates parsing.
   * @returns Actual selectable PDF text; malformed, encrypted, stale or over-budget files disclose no body.
   */
  readConversationPdf(actorId: OfficeMemberId, input: OfficeConversationPdfReadInput,
    signal?: AbortSignal): Promise<OfficeConversationPdfRead> {
    const parsed = officeConversationFileSchemas.readPdf.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid submitted PDF read'))
    const cancellation = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
    return this.enqueue(async () => {
      cancellation.throwIfAborted()
      const value = parsed.data
      const { file, bytes } = await this.loadConversationFile(actorId, value, this.pdfPolicy.maxBytes)
      const page = await extractOfficePdf(bytes, value.pageNumber, this.pdfPolicy, cancellation)
      cancellation.throwIfAborted()
      const actor = this.scopeMember('files', this.domain.global.get(), actorId)
      this.conversationFilesRepository.read(actor, value.captureId)
      this.resolveConversationFile(actor, file)
      // No await separates the final authority check from producing the complete bounded result in this queue.
      return officePdfWindow(file, value, page, this.pdfPolicy.maxOutputBytes)
    })
  }

  /**
   * Read actual main-document paragraphs and tables from one explicitly submitted DOCX.
   * @param actorId - Current authenticated employee; capture role and current file authority remain mandatory.
   * @param input - Exact submitted immutable file and bounded UTF-16 body-text window.
   * @param signal - Original native tool or disconnected transport cancellation; office unload also terminates parsing.
   * @returns Verified body text with paragraph/table counts; malformed, denied and over-budget packages return no body.
   */
  readConversationDocx(actorId: OfficeMemberId, input: OfficeConversationDocxReadInput,
    signal?: AbortSignal): Promise<OfficeConversationDocxRead> {
    const parsed = officeConversationFileSchemas.readDocx.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid submitted DOCX read'))
    const cancellation = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
    return this.enqueue(async () => {
      cancellation.throwIfAborted()
      const value = parsed.data
      const { file, bytes } = await this.loadConversationFile(actorId, value, this.docxPolicy.maxBytes)
      const document = await extractOfficeDocx(bytes, this.docxPolicy, cancellation)
      cancellation.throwIfAborted()
      const actor = this.scopeMember('files', this.domain.global.get(), actorId)
      this.conversationFilesRepository.read(actor, value.captureId)
      this.resolveConversationFile(actor, file)
      return officeDocxWindow(file, value, document, this.docxPolicy.maxOutputBytes)
    })
  }

  /**
   * Read exact saved cells and formula caches from one submitted XLSX worksheet.
   * @param actorId - Current employee; capture role, ancestor access and latest version remain mandatory.
   * @param input - Exact submitted worksheet and sparse-cell continuation.
   * @param signal - Original native cancellation or disconnected transport; office unload also stops the parser.
   * @returns Whole saved cells with raw numeric/date lexemes; unauthorized and over-budget input returns no cells.
   */
  readConversationXlsx(actorId: OfficeMemberId, input: OfficeConversationXlsxReadInput,
    signal?: AbortSignal): Promise<OfficeConversationXlsxRead> {
    const parsed = officeConversationFileSchemas.readXlsx.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid submitted XLSX read'))
    const cancellation = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
    return this.enqueue(async () => {
      cancellation.throwIfAborted()
      const value = parsed.data
      const { file, bytes } = await this.loadConversationFile(actorId, value, this.xlsxPolicy.maxBytes)
      const document = await extractOfficeXlsx(bytes, value, this.xlsxPolicy, cancellation)
      cancellation.throwIfAborted()
      const actor = this.scopeMember('files', this.domain.global.get(), actorId)
      this.conversationFilesRepository.read(actor, value.captureId)
      this.resolveConversationFile(actor, file)
      return officeXlsxWindow(file, document, this.xlsxPolicy.maxOutputBytes)
    })
  }

  /**
   * Read saved shape/table text or explicitly selected speaker notes from one submitted presentation slide.
   * @param actorId - Current employee; captured role, ancestor access and exact latest version remain mandatory.
   * @param input - Submitted immutable file, relationship-ordered slide and bounded section text window.
   * @param signal - Original native or transport cancellation; office unload also stops the isolated parser.
   * @returns Verified saved text and slide directory after final queued authorization; failures disclose no text.
   */
  readConversationPptx(actorId: OfficeMemberId, input: OfficeConversationPptxReadInput,
    signal?: AbortSignal): Promise<OfficeConversationPptxRead> {
    const parsed = officePptxReadInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid submitted PPTX read'))
    const cancellation = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
    return this.enqueue(async () => {
      cancellation.throwIfAborted()
      const policy = this.pptxPolicy
      if (!policy) throw new OfficeError('forbidden', 'Submitted PPTX reading is not enabled')
      const value = parsed.data
      const { file, bytes } = await this.loadConversationFile(actorId, value, policy.maxBytes)
      const document = await extractOfficePptx(bytes, { slideNumber: value.slideNumber, section: value.section }, policy, cancellation)
      cancellation.throwIfAborted()
      const actor = this.scopeMember('files', this.domain.global.get(), actorId)
      this.conversationFilesRepository.read(actor, value.captureId)
      this.resolveConversationFile(actor, file)
      return officePptxWindow(file, value, document, policy.maxOutputBytes)
    })
  }

  /**
   * Read a submitted raster or recheck its exact source after Native image normalization.
   * @param actorId - Authenticated employee; session, captured role and current file authority remain mandatory.
   * @param input - Original submitted capture/file coordinates and exact source identity for recheck.
   * @param signal - Original transport/tool cancellation, combined with Office lifetime.
   * @returns Verified original image bytes after real decode and final authorization, or metadata-only source recheck.
   */
  readConversationImage(actorId: OfficeMemberId, input: OfficeConversationImageReadInput,
    signal?: AbortSignal): Promise<OfficeConversationImageRead> {
    const parsed = officeImageReadInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid submitted image operation'))
    const cancellation = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
    return this.enqueue(() => this.imageReader.read(actorId, parsed.data, cancellation))
  }

  /**
   * Read publication revision metadata for a current authorized file before reviewing an incremental update.
   * @param actorId - Authenticated employee.
   * @param fileId - Current Drive identity, never caller-supplied source metadata.
   * @returns Metadata without indexed text, or null before publication.
   */
  knowledgePublication(actorId: OfficeMemberId, fileId: OfficeKnowledgePublication['file']['id']): Promise<OfficeKnowledgePublication | null> {
    return this.enqueue(async () => {
      this.assertConversationQueryActor(actorId)
      const actor = this.activeMember(this.domain.global.get(), actorId)
      const { blob } = this.driveRepository.fileVersion(actor, fileId)
      const file = this.resolveConversationFile(actor, { id: fileId,
        versionId: brandString<OfficeKnowledgePublication['file']['versionId']>(blob.id) })
      return this.requireKnowledge().publication(actor, file)
    })
  }

  /**
   * Publish actual parsed file text after current publisher, ACL, head and digest checks.
   * @param actorId - Authenticated current publisher, never supplied by a tool payload.
   * @param input - Exact reviewed source and publication versions plus retry UUID.
   * @param signal - Original request cancellation combined with Office lifetime.
   * @returns Durable publication metadata only; later text reads require fresh authorization.
   */
  publishKnowledge(actorId: OfficeMemberId, input: OfficeKnowledgePublishInput, signal?: AbortSignal): Promise<OfficeKnowledgePublication> {
    const cancellation = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    return this.enqueue(() => {
      this.assertConversationQueryActor(actorId)
      return this.requireKnowledge().publish(this.activeMember(this.domain.global.get(), actorId), input, cancellation)
    })
  }

  /**
   * Remove indexed text using the reviewed publication revision without deleting Drive or Native history.
   * @param actorId - Authenticated current publisher or administrator.
   * @param input - Reviewed file, publication revision and retained retry UUID.
   * @param signal - Original operation cancellation.
   * @returns Retained withdrawal metadata after durability.
   */
  withdrawKnowledge(actorId: OfficeMemberId, input: OfficeKnowledgeWithdrawInput, signal?: AbortSignal): Promise<OfficeKnowledgePublication> {
    return this.enqueue(() => {
      this.assertConversationQueryActor(actorId)
      return this.requireKnowledge().withdraw(this.activeMember(this.domain.global.get(), actorId), input,
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]))
    })
  }

  /**
   * Search currently readable indexed source versions on the same Office queue as mutations.
   * @param actorId - Authenticated active employee.
   * @param input - Literal query and bounded maximum results.
   * @returns Authorized body citations, each with its immutable source version and exact position.
   */
  searchKnowledge(actorId: OfficeMemberId, input: OfficeKnowledgeSearchInput): Promise<OfficeKnowledgeSearch> {
    return this.enqueue(async () => {
      this.assertConversationQueryActor(actorId)
      return this.requireKnowledge().search(this.activeMember(this.domain.global.get(), actorId), input)
    })
  }

  /**
   * Reopen one exact citation after fresh current-source authorization.
   * @param actorId - Authenticated active employee.
   * @param input - Original source version/digest, publication revision and chunk.
   * @returns Body and original source position; revoked or superseded citations disclose no text.
   */
  readKnowledgeCitation(actorId: OfficeMemberId, input: OfficeKnowledgeCitationInput): Promise<OfficeKnowledgeCitation> {
    return this.enqueue(async () => {
      this.assertConversationQueryActor(actorId)
      return this.requireKnowledge().citation(this.activeMember(this.domain.global.get(), actorId), input)
    })
  }

  private requireKnowledge(): OfficeKnowledgeRepository {
    if (!this.knowledge) throw new OfficeError('forbidden', 'Knowledge indexing is not enabled')
    return this.knowledge
  }

  /**
   * Check a real submitted Office/PDF output while preserving source authorization and the original task-acceptance workflow.
   * @param actorId - Authenticated current employee; capture ownership and role remain mandatory.
   * @param input - Exact submitted source, fixed workflow recipe and required actual document text.
   * @param signal - Original Native/request cancellation combined with Office lifetime.
   * @returns Complete bounded structure/content evidence; visual appearance and business acceptance are not asserted.
   */
  checkConversationDeliverable(actorId: OfficeMemberId, input: OfficeDeliveryCheckInput, signal?: AbortSignal): Promise<OfficeDeliveryCheck> {
    const parsed = officeDeliveryCheckInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid submitted Office delivery check'))
    const cancellation = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    return this.enqueue(async () => {
      this.assertConversationQueryActor(actorId)
      const policy = this.deliveryPolicy
      if (!policy) throw new OfficeError('forbidden', 'Office delivery checking is not enabled')
      cancellation.throwIfAborted()
      const value = parsed.data
      const { file, bytes } = await this.loadConversationFile(actorId, value, policy.maxSourceBytes)
      const result = await checkOfficeDelivery(file, bytes, value, policy, { pdf: this.pdfPolicy, docx: this.docxPolicy,
        xlsx: this.xlsxPolicy, ...(this.pptxPolicy ? { pptx: this.pptxPolicy } : {}) }, cancellation)
      cancellation.throwIfAborted()
      this.assertConversationQueryActor(actorId)
      const actor = this.activeMember(this.domain.global.get(), actorId)
      this.conversationFilesRepository.read(actor, value.captureId)
      const current = this.resolveConversationFile(actor, file)
      if (current.sha256 !== file.sha256 || current.byteLength !== file.byteLength)
        throw new OfficeError('conflict', 'Submitted Office output changed during verification')
      return result
    })
  }

  private async loadConversationFile(actorId: OfficeMemberId,
    input: Pick<OfficeConversationFileReadInput, 'captureId' | 'fileId'>, maxBytes: number): Promise<{
    readonly file: OfficeConversationFileReference
    readonly bytes: Buffer
  }> {
    const actor = this.activeMember(this.domain.global.get(), actorId)
    const capture = this.conversationFilesRepository.read(actor, input.captureId)
    const selected = capture.selection.files.find(file => file.id === input.fileId)
    if (!selected) throw new OfficeError('forbidden', 'File was not submitted in this context')
    const file = this.resolveConversationFile(actor, selected)
    if (file.sha256 !== selected.sha256 || file.byteLength !== selected.byteLength)
      throw new OfficeError('conflict', 'Submitted file content changed')
    if (file.byteLength > maxBytes) throw new OfficeError('context_too_large', 'Submitted file exceeds its read byte limit')
    const { blob } = this.driveRepository.fileVersion(actor, file.id, file.versionId)
    if (file.byteLength === 0) await this.transferFiles.verify(blob)
    const bytes = Buffer.alloc(file.byteLength)
    for (let offset = 0; offset < file.byteLength;) {
      const count = Math.min(this.driveLimits.chunkBytes, file.byteLength - offset)
      const part = await this.transferFiles.readRange(blob, offset, count)
      part.copy(bytes, offset)
      offset += count
    }
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new OfficeError('conflict', 'Submitted file verification failed')
    return { file: selected, bytes }
  }

  private resolveConversationFile(actor: OfficeMember,
    file: Pick<OfficeConversationFileReference, 'id' | 'versionId'>): OfficeConversationFileReference {
    const { entry, blob } = this.driveRepository.fileVersion(actor, file.id)
    if (blob.id !== file.versionId) throw new OfficeError('conflict', 'Review the current file version')
    return { id: entry.id, versionId: file.versionId, name: entry.name, mediaType: entry.mediaType,
      byteLength: blob.byteLength, sha256: blob.sha256 }
  }

  /**
   * Save one integration's reviewed connection using deployment-approved origins and credential aliases.
   * @param actorId - Authenticated administrator, rechecked inside the office queue.
   * @param input - Configuration, reviewed revision and retained retry UUID; no inline credentials.
   * @returns Durably saved metadata; network connectivity remains unverified until a separate check.
   */
  saveConnection(actorId: OfficeMemberId, input: OfficeConnectorInput): Promise<OfficeConnectorEntry> {
    return this.enqueue(() => this.connectors.save(this.scopeMember('connectors', this.domain.global.get(), actorId), input))
  }

  /**
   * Probe a reviewed connection with fresh Host credentials and bounded response size and time.
   * @param actorId - Authenticated administrator, rechecked before any outbound request.
   * @param integrationId - Saved integration identity; arbitrary request URLs are not admitted.
   * @param revision - Reviewed connection version, preventing a check of a competing replacement.
   * @returns Point-in-time outcome without remote content or secrets; no automatic retries or business writes.
   */
  probeConnection(actorId: OfficeMemberId, integrationId: OfficeIntegration['id'], revision: number): Promise<OfficeConnectorProbe> {
    return this.enqueue(() => this.connectors.probe(this.scopeMember('connectors', this.domain.global.get(), actorId), { integrationId, revision }))
  }

  /**
   * Publish plain text to a frozen set of current company employees.
   * @param actorId - Authenticated administrator, rechecked inside the mutation queue.
   * @param input - Reviewed text, delivery scope and retained retry UUID.
   * @returns Durable publication after its recipient list is committed.
   */
  publishAnnouncement(actorId: OfficeMemberId, input: OfficeAnnouncementInput): Promise<OfficeAnnouncement> {
    return this.enqueue(() => this.announcements.publish(
      this.activeMember(this.domain.global.get(), actorId), input, this.domain.global.get().members,
    ))
  }

  /**
   * Acknowledge a publication in this employee's inbox.
   * @param actorId - Authenticated current recipient.
   * @param id - Delivered publication identity.
   */
  markAnnouncementRead(actorId: OfficeMemberId, id: OfficeAnnouncementId): Promise<void> {
    return this.enqueue(() => this.announcements.markRead(this.activeMember(this.domain.global.get(), actorId), id))
  }

  /**
   * Acknowledge this recipient's current central reminder without changing business notifications.
   * @param actorId - Authenticated active employee, rechecked after queue admission.
   * @param id - Delivered reminder UUID; another employee's or obsolete occurrence is unavailable.
   * @returns After durability; repeated acknowledgements write nothing.
   */
  markReminderRead(actorId: OfficeMemberId, id: OfficeReminderId): Promise<void> {
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      if (!this.reminders) throw new OfficeError('not_found', 'Central reminders are not configured')
      await this.reminders.markRead(actor, id, state.items.filter(item => this.canRead(actor, item)), state.timeZone, Date.now())
    })
  }

  /**
   * Withdraw a reviewed publication while retaining its history.
   * @param actorId - Current administrator.
   * @param id - Publication identity.
   * @param expectedRevision - Content revision reviewed before withdrawal.
   */
  withdrawAnnouncement(actorId: OfficeMemberId, id: OfficeAnnouncementId, expectedRevision: number): Promise<void> {
    return this.enqueue(() => this.announcements.withdraw(this.activeMember(this.domain.global.get(), actorId), id, expectedRevision))
  }

  /**
   * Read only this employee's private conversations, even for administrators.
   * @param actorId - Authenticated active employee.
   * @param peerId - Optional conversation to open, including retained inactive peers.
   * @param before - Exclusive sequence for older history.
   * @returns Authorized threads and at most 100 messages.
   */
  chat(
    actorId: OfficeMemberId,
    peerId?: OfficeMemberId,
    before?: number,
  ): OfficeChatView {
    this.assertOpen()
    const state = this.domain.global.get()
    const me = this.scopeMember('chat', state, actorId)
    const retained = peerId && this.chatFileDraftsRepository.hasContact(actorId, peerId)
      ? state.members.find(member => member.id === peerId) : undefined
    return this.chatFiles.decorateView(projectChat(
      this.chatDomain.global.get(),
      me,
      state.members,
      peerId,
      before,
      retained ? { id: retained.id, name: retained.name, active: retained.active } : undefined,
    ))
  }

  /**
   * Read a private/shared directory or authorized name search without native filesystem access.
   * @param actorId - Authenticated active employee.
   * @param input - Logical location and search string.
   * @returns Authorized metadata, breadcrumbs and current write capability.
   */
  drive(actorId: OfficeMemberId, input: OfficeDriveQuery): OfficeDriveView {
    this.assertOpen()
    return { ...this.driveRepository.view(
      this.scopeMember('files', this.domain.global.get(), actorId),
      input,
    ), transfers: this.uploads.capabilities() }
  }

  /**
   * Create a folder after checking current membership and ancestor permissions.
   * @param actorId - Trusted employee identity, not a browser-selected owner.
   * @param input - Logical parent and Windows-compatible display name.
   * @returns Committed directory entry.
   */
  createDriveFolder(
    actorId: OfficeMemberId,
    input: OfficeDriveFolderInput,
  ): Promise<OfficeDriveEntry> {
    return this.enqueue(() =>
      this.driveRepository.createFolder(
        this.scopeMember('files', this.domain.global.get(), actorId),
        input,
      ),
    )
  }

  /**
   * Rename only an editable entry inside an editable parent, using a reviewed version.
   * @param actorId - Authenticated employee.
   * @param input - Opaque entry identity, version and new name.
   * @returns Committed metadata or a denial without changing the directory.
   */
  renameDriveEntry(
    actorId: OfficeMemberId,
    input: OfficeDriveRenameInput,
  ): Promise<OfficeDriveEntry> {
    return this.enqueue(() =>
      this.driveRepository.rename(
        this.scopeMember('files', this.domain.global.get(), actorId),
        input,
      ),
    )
  }

  /**
   * Upload actual bytes under current directory permissions and a stable retry identity.
   * @param actorId - Trusted employee identity.
   * @param input - Logical destination, bounded bytes and retry key.
   * @returns Committed file metadata after both immutable bytes and metadata are durable.
   */
  uploadDriveFile(
    actorId: OfficeMemberId,
    input: OfficeDriveUploadInput,
  ): Promise<OfficeDriveEntry> {
    return this.enqueue(async () => {
      const actor = this.scopeMember('files', this.domain.global.get(), actorId)
      await this.uploads.sweep()
      this.uploads.requireWholeRequest(input.requestId)
      return this.driveRepository.upload(actor, input)
    })
  }

  /**
   * Download an authorized immutable version while permission changes share the same queue.
   * @param actorId - Authenticated active employee.
   * @param id - Opaque file identity.
   * @returns Actual bytes and their digest; denied and corrupt reads disclose no content.
   */
  downloadDriveFile(
    actorId: OfficeMemberId,
    id: OfficeDriveId,
  ): Promise<OfficeDriveDownload> {
    return this.enqueue(() =>
      this.driveRepository.download(
        this.scopeMember('files', this.domain.global.get(), actorId),
        id,
      ),
    )
  }

  /**
   * Let a shared entry's owner replace account conditions without an administrator privacy bypass.
   * @param actorId - Authenticated employee.
   * @param input - Reviewed version and complete conditions.
   * @returns Committed owner projection.
   */
  saveDrivePermissions(
    actorId: OfficeMemberId,
    input: OfficeDrivePermissionsInput,
  ): Promise<OfficeDriveEntry> {
    return this.enqueue(() => {
      const state = this.domain.global.get()
      return this.driveRepository.permissions(
        this.scopeMember('files', state, actorId),
        input,
        state.members,
      )
    })
  }

  /**
   * Read only this employee's drafts; administrators have no private-draft bypass.
   * @param actorId - Authenticated active employee.
   * @returns Contact drafts with their reviewed versions, including cleared tombstones.
   */
  chatDrafts(actorId: OfficeMemberId): OfficeChatDraftView {
    this.assertOpen()
    this.scopeMember('chat', this.domain.global.get(), actorId)
    return {
      meId: actorId,
      drafts: this.draftDomain.global
        .get()
        .drafts.filter(entry => entry.ownerId === actorId)
        .map(({ peerId, text, revision }) => ({ peerId, text, revision })),
    }
  }

  /**
   * Save a private draft without silently overwriting another window's changes.
   * @param actorId - Authenticated owner; never selected by a browser method.
   * @param input - Contact, reviewed version, exact text and retry identity.
   * @returns The durable version; exact retries return it without another write.
   */
  saveChatDraft(
    actorId: OfficeMemberId,
    input: OfficeChatDraftInput,
  ): Promise<OfficeChatDraft> {
    const parsed = officeChatDraftInput.safeParse(input)
    if (!parsed.success)
      return Promise.reject(
        new OfficeError('invalid_input', 'Invalid private draft'),
      )
    return this.enqueue(async () => {
      const office = this.domain.global.get()
      this.scopeMember('chat', office, actorId)
      const { peerId, text, revision, requestId } = parsed.data
      if (peerId === actorId)
        throw new OfficeError('invalid_input', 'A draft needs another member')
      const state = this.draftDomain.global.get()
      const previous = state.drafts.find(
        entry => entry.ownerId === actorId && entry.peerId === peerId,
      )
      if (previous?.requestId === requestId) {
        if (previous.text !== text || previous.revision !== revision + 1)
          throw new OfficeError('conflict', 'Draft retry payload changed')
        return { peerId, text, revision: previous.revision }
      }
      if (
        !office.members.some(
          entry =>
            entry.id === peerId && (entry.active || (text === '' && previous)),
        )
      )
        throw new OfficeError('not_found', 'Draft contact is unavailable')
      if (
        (previous?.revision ?? 0) !== revision ||
        revision === Number.MAX_SAFE_INTEGER
      )
        throw new OfficeError('conflict', 'Draft changed in another window')
      const next = {
        ownerId: actorId,
        peerId,
        text,
        revision: revision + 1,
        requestId,
      }
      await this.draftDomain.global.set({
        drafts: [...state.drafts.filter(entry => entry !== previous), next],
      })
      try {
        await this.ctx.parallel('office/chat-drafts-changed')
      } catch (error) {
        this.ctx.logger.warn(
          `office/chat-drafts-changed observer failed: ${String(error)}`,
        )
      }
      return { peerId, text, revision: next.revision }
    })
  }

  /**
   * Send one private message; retrying its exact identity cannot duplicate it.
   * @param actorId - Authenticated sender, rechecked in the shared mutation queue.
   * @param input - Retry identity, recipient and original text.
   * @returns Committed message; changed retry payloads reject without side effects.
   */
  sendMessage(
    actorId: OfficeMemberId,
    input: OfficeChatInput,
  ): Promise<OfficeChatMessage> {
    const parsed = officeChatInput.safeParse(input)
    if (!parsed.success)
      return Promise.reject(
        new OfficeError('invalid_input', 'Message fields are invalid'),
      )
    return this.enqueue(() => {
      this.scopeMember('chat', this.domain.global.get(), actorId)
      if (!this.chatDomain.global.get().messages.some(entry => entry.id === parsed.data.id) &&
        (this.chatFiles.hasIntent(parsed.data.id) || this.chatFileDraftsRepository.hasSend(parsed.data.id)))
        throw new OfficeError('conflict', 'A file declaration owns this message identity')
      return this.createChatMessage(actorId, parsed.data)
    })
  }

  /**
   * Read this active employee's file-message policy and retained usage.
   * @param actorId - Authenticated employee.
   * @returns Current bounded file policy without other employees' usage.
   */
  chatFileLimitsFor(actorId: OfficeMemberId): OfficeChatFileLimits {
    this.assertOpen()
    this.scopeMember('files', this.domain.global.get(), actorId)
    return this.chatFiles.capabilities(actorId)
  }

  /**
   * Verify immutable files before publishing one private message through the original chat sequence.
   * @param actorId - Current authenticated sender, checked inside the shared queue.
   * @param input - Exact retry identity, recipient, caption and ordered bounded files.
   * @returns Published header and file metadata; failure may retain a recoverable declaration but never a partial message.
   */
  sendMessageFiles(actorId: OfficeMemberId, input: OfficeChatFilesInput): Promise<OfficeChatMessage> {
    const parsed = officeChatFilesInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'File-message fields are invalid'))
    return this.enqueue(async () => {
      this.scopeMember('files', this.domain.global.get(), actorId)
      if (this.chatFileDraftsRepository.hasSend(parsed.data.id))
        throw new OfficeError('conflict', 'A private file draft owns this message identity')
      return this.createChatFilesMessage(actorId, parsed.data)
    })
  }

  /**
   * Read one immutable file through its original private message and current participant identity.
   * @param actorId - Active authenticated sender or recipient.
   * @param input - Retained message and file coordinates.
   * @returns Verified complete bytes; hidden and missing coordinates share one denial.
   */
  downloadChatFile(actorId: OfficeMemberId, input: OfficeChatFileCoordinates): Promise<OfficeChatFileDownload> {
    const parsed = officeChatFileCoordinates.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid chat-file coordinates'))
    return this.enqueue(() => {
      this.scopeMember('files', this.domain.global.get(), actorId)
      return this.chatFiles.download(actorId, parsed.data)
    })
  }

  /**
   * Read current private file draft versions without returning file bytes.
   * @param actorId - Current authenticated owner.
   * @returns Only the owner's contact drafts, tombstones and logical draft quota.
   */
  chatFileDrafts(actorId: OfficeMemberId): OfficeChatFileDraftView {
    this.assertOpen()
    const state = this.domain.global.get()
    this.scopeMember('files', state, actorId)
    const view = this.chatFileDraftsRepository.view(actorId)
    return { ...view, drafts: view.drafts.map((draft) => {
      const peer = state.members.find(member => member.id === draft.peerId)
      if (!peer) throw new OfficeError('conflict', 'Original file-draft contact is missing')
      return { ...draft, peer: { id: peer.id, name: peer.name, active: peer.active } }
    }) }
  }

  /**
   * Atomically replace one reviewed contact's private file draft.
   * @param actorId - Authenticated owner rechecked inside the shared queue.
   * @param input - Reviewed contact version, original retry UUID and complete bounded files.
   * @returns Saved metadata; stale versions and changed retries reject without clearing the draft.
   */
  saveChatFileDraft(actorId: OfficeMemberId, input: OfficeChatFileDraftInput): Promise<OfficeChatFileDraft> {
    const parsed = officeChatFileDraftInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid private file draft'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      this.scopeMember('files', state, actorId)
      const peer = state.members.find(member => member.id === parsed.data.peerId)
      if (!peer || !peer.active && (parsed.data.files.length > 0 || !this.chatFileDraftsRepository.hasContact(actorId, peer.id)))
        throw new OfficeError('not_found', 'Draft recipient is unavailable')
      const saved = await this.chatFileDraftsRepository.save(actorId, parsed.data)
      return { ...saved, peer: { id: peer.id, name: peer.name, active: peer.active } }
    })
  }

  /**
   * Restore complete file bytes from the authenticated employee's own reviewed contact draft.
   * @param actorId - Active owner; recipients and administrators receive no bypass.
   * @param input - Contact, current draft version and opaque file identity.
   * @returns Verified bounded draft content or a uniform missing-file denial.
   */
  downloadChatFileDraft(actorId: OfficeMemberId, input: OfficeChatFileDraftCoordinates): Promise<OfficeChatFileDraftDownload> {
    const parsed = officeChatFileDraftCoordinates.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid private draft file coordinates'))
    return this.enqueue(() => {
      this.scopeMember('files', this.domain.global.get(), actorId)
      return Promise.resolve(this.chatFileDraftsRepository.download(actorId, parsed.data))
    })
  }

  /**
   * Publish an exact reviewed durable file selection, then clear only that original draft.
   * @param actorId - Current authenticated sender, serialized with sign-out and membership edits.
   * @param input - Reviewed version, captured caption and stable message identity.
   * @returns One committed file message; retries reconcile publication before clearing the original selection.
   */
  sendChatFileDraft(actorId: OfficeMemberId, input: OfficeChatFileDraftSendInput): Promise<OfficeChatMessage> {
    const parsed = officeChatFileDraftSendInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid private file draft send'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      this.scopeMember('files', state, actorId)
      if (parsed.data.peerId === actorId) throw new OfficeError('invalid_input', 'A private draft requires another employee')
      if (!this.chatDomain.global.get().messages.some(entry => entry.id === parsed.data.id) &&
        !state.members.some(member => member.id === parsed.data.peerId && member.active))
        throw new OfficeError('not_found', 'Draft recipient is unavailable')
      await this.primeChat()
      const payload = await this.chatFileDraftsRepository.beginSend(actorId, parsed.data)
      const message = 'files' in payload ? await this.createChatFilesMessage(actorId, payload) : payload
      await this.chatFileDraftsRepository.completeSend(actorId, parsed.data, message)
      return message
    })
  }

  /**
   * Acknowledge only messages displayed from this employee's own conversation.
   * @param actorId - Authenticated reader.
   * @param peerId - Other participant.
   * @param through - Observed sequence in this exact conversation.
   * @returns After durable acknowledgement; older acknowledgements are idempotent.
   */
  readChat(
    actorId: OfficeMemberId,
    peerId: OfficeMemberId,
    through: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(through) || through < 1)
      return Promise.reject(
        new OfficeError('invalid_input', 'Invalid read cursor'),
      )
    return this.enqueue(async () => {
      this.scopeMember('chat', this.domain.global.get(), actorId)
      const state = this.chatDomain.global.get()
      if (
        !state.messages.some(
          entry =>
            entry.sequence === through &&
            inConversation(entry, actorId, peerId),
        )
      )
        throw new OfficeError(
          'not_found',
          'Conversation cursor is unavailable',
        )
      const previous = state.receipts.find(
        entry => entry.readerId === actorId && entry.peerId === peerId,
      )
      if (previous && previous.through >= through) return
      const receipt = {
        readerId: actorId,
        peerId,
        through,
        readAt: Date.now(),
      }
      await this.commitChat({
        ...state,
        revision: state.revision + 1,
        receipts: [
          ...state.receipts.filter(entry => entry !== previous),
          receipt,
        ],
      })
    })
  }

  /**
   * Read one active item through the employee policy used for daily lists and calendars.
   * @param actorId - Authenticated identity.
   * @param itemId - Requested work.
   * @returns Active item; hidden, inactive or missing work returns the same not_found denial.
   */
  getItem(actorId: OfficeMemberId, itemId: OfficeItemId): OfficeItem {
    this.assertOpen()
    const state = this.domain.global.get()
    return this.readItem(state, this.activeMember(state, actorId), itemId)
  }

  /**
   * Create a task or to-do and deliver the assignee's notification in one commit.
   * @param actorId - Authenticated initiator.
   * @param input - User-authored work.
   * @returns durable item; validation, membership or storage failure publishes no new revision.
   */
  createWork(
    actorId: OfficeMemberId,
    input: OfficeWorkInput,
  ): Promise<OfficeItem> {
    const parsed = officeWorkInput.safeParse(input)
    if (!parsed.success)
      return Promise.reject(
        new OfficeError('invalid_input', 'Task fields are invalid'),
      )
    return this.enqueue(() => this.createWorkItem(actorId, parsed.data, brandString<OfficeItemId>(randomUUID()), Date.now()))
  }

  /**
   * Create one internal task/to-do under a private reminder capture, rechecking authority immediately before a new write.
   * @param actorId - Authenticated active employee; the payload cannot choose a business actor.
   * @param input - Exact retry identity, private capture and ordinary work fields.
   * @returns Stable request receipt with the current authorized item; existing committed retries perform no second write.
   */
  createWorkFromConversation(actorId: OfficeMemberId, input: OfficeAgentWorkInput): Promise<OfficeAgentWorkReceipt> {
    const parsed = officeAgentWorkInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid Agent work request'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      const previous = this.agentWorkRepository.find(actor, parsed.data)
      const committed = previous && state.items.find(row => row.id === previous.itemId)
      if (previous && committed) {
        if (committed.creatorId !== actorId) throw new OfficeError('conflict', 'Agent work item identity changed')
        return { requestId: parsed.data.requestId, captureId: parsed.data.captureId,
          acceptedAt: previous.acceptedAt, item: this.readItem(state, actor, committed.id) }
      }
      this.activeMember(state, parsed.data.work.ownerId)
      const capture = this.conversationCapturesRepository.read(actor, parsed.data.captureId)
      const choices = this.conversationLinksRepository.view(actor, capture.selection.conversationId)
      const required = choices.requirements.find(row => row.tool.kind === 'template' && row.tool.name === 'reminder')
      const connections = required?.integrations.length ? await this.connectors.view(actor) : { revision: 0, entries: [], adapters: [] }
      assertAgentWorkAuthority(actor, capture, choices, connections)
      this.assertOpen()
      const reservation = await this.agentWorkRepository.reserve(actor, parsed.data)
      if (required?.integrations.length) {
        const current = await this.connectors.view(actor)
        assertAgentWorkAuthority(actor, capture, choices, current)
        for (const id of required.integrations) {
          this.connectors.assertCurrentDependency(id, current.entries.find(row => row.integrationId === id)?.revision ?? -1)
        }
      }
      const item = await this.createWorkItem(actorId, parsed.data.work, reservation.itemId, reservation.acceptedAt)
      return { requestId: parsed.data.requestId, captureId: parsed.data.captureId, acceptedAt: reservation.acceptedAt, item }
    })
  }

  private async createWorkItem(actorId: OfficeMemberId, input: OfficeWorkInput, id: OfficeItemId, now: number): Promise<OfficeItem> {
    const state = this.domain.global.get()
    this.activeMember(state, actorId)
    this.activeMember(state, input.ownerId)
    const item: OfficeItem = { ...input, id, description: input.description ?? '', status: input.status ?? 'pending',
      creatorId: actorId, location: '', participants: [], revision: 1, createdAt: now, updatedAt: now }
    const notification = item.ownerId === actorId ? [] : [this.notification(actorId, item.ownerId, id, 'assigned', now)]
    await this.commit(state, { items: [...state.items, item], notifications: [...state.notifications, ...notification] },
      actorId, 'work_created', id, now)
    return item
  }

  /**
   * Edit ordinary work content and deadline while preserving assignment and lifecycle.
   * @param actorId - Current active creator, assignee or administrator.
   * @param itemId - Existing task or to-do identity.
   * @param expectedRevision - Revision reviewed before editing, including any task decisions.
   * @param input - Content and deadline; omitted time clears it, omitted priority preserves it, and normal clears a stored priority.
   * @returns Committed work; unchanged input writes nothing, and stale, closed or unauthorized edits publish no changes.
   */
  updateWork(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number,
    input: OfficeWorkUpdateInput): Promise<OfficeItem> {
    const parsed = officeWorkUpdateInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid work content or deadline'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      const item = this.readItem(state, actor, itemId)
      if (item.kind === 'schedule') throw new OfficeError('invalid_input', 'Meetings use their own editor')
      if (item.creatorId !== actorId && item.ownerId !== actorId && actor.role !== 'admin')
        throw new OfficeError('forbidden', 'Only the creator, assignee or administrator can edit this work')
      this.checkRevision(item, expectedRevision)
      if (item.status === 'completed' || item.status === 'cancelled') throw new OfficeError('conflict', 'This work item is closed')
      const priority = parsed.data.priority === undefined ? item.priority
        : parsed.data.priority === 'normal' ? undefined : parsed.data.priority
      const priorityChanged = (priority ?? 'normal') !== (item.priority ?? 'normal')
      const fields = { title: parsed.data.title, description: parsed.data.description ?? '', date: parsed.data.date,
        time: parsed.data.time, priority }
      if (!priorityChanged && item.title === fields.title && item.description === fields.description
        && item.date === fields.date && item.time === fields.time)
        return item
      const now = Date.now()
      const updated: OfficeItem = { ...item, ...fields, revision: item.revision + 1, updatedAt: now }
      const recipients = new Set([item.creatorId, item.ownerId])
      recipients.delete(actorId)
      const operation = priorityChanged ? 'work_prioritized' : 'work_updated'
      await this.commit(state, { items: state.items.map(entry => entry.id === item.id ? updated : entry),
        notifications: [...state.notifications, ...[...recipients].map(recipient =>
          ({ ...this.notification(actorId, recipient, item.id, operation, now), itemTitle: updated.title }))] },
      actorId, operation, item.id, now)
      return updated
    })
  }

  /**
   * Submit a task delivery or review its current unchanged submission with a retained explanation.
   * @param actorId - Current assignee for submission; task creator or administrator for review.
   * @param itemId - Existing task; to-dos and meetings use their own operations.
   * @param expectedRevision - Parent revision reviewed before the action.
   * @param input - Submission, acceptance or return with a bounded nonempty reason.
   * @returns Task with atomically retained history, recipient notifications and audit. Acceptance completes the task.
   * Any intervening item revision invalidates a pending submission; denied, closed or stale actions publish nothing.
   */
  reviewTaskDelivery(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number,
    input: OfficeTaskDeliveryInput): Promise<OfficeItem> {
    const parsed = officeTaskDeliveryInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'A delivery action needs a valid explanation'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      const item = this.readItem(state, actor, itemId)
      if (item.kind !== 'task') throw new OfficeError('invalid_input', 'Only tasks have delivery review')
      const input = parsed.data
      if (input.kind === 'submit' ? item.ownerId !== actorId : item.creatorId !== actorId && actor.role !== 'admin')
        throw new OfficeError('forbidden', 'Only the assignee submits; the creator or an administrator reviews')
      this.checkRevision(item, expectedRevision)
      if (item.status !== 'in_progress') throw new OfficeError('conflict', 'Delivery requires an in-progress task')
      const last = item.deliveries?.at(-1)
      const pending = last?.kind === 'submit' && last.revision === item.revision && last.ownerId === item.ownerId
      if (input.kind === 'submit' ? pending : !pending)
        throw new OfficeError('conflict', 'A current unchanged submission is required for review')
      if (input.kind !== 'return') {
        for (const file of item.attachments ?? []) this.resolveConversationFile(actor, file)
      }
      const now = Date.now()
      const revision = item.revision + 1
      const updated: OfficeItem = { ...item, revision, updatedAt: now,
        status: input.kind === 'accept' ? 'completed' : 'in_progress',
        deliveries: [...(item.deliveries ?? []), { ...input, actorId, ownerId: item.ownerId, revision, time: now }] }
      const operation = { submit: 'delivery_submitted', accept: 'delivery_accepted', return: 'delivery_returned' } as const
      const recipients = new Set([item.creatorId, item.ownerId])
      recipients.delete(actorId)
      await this.commit(state, { items: state.items.map(entry => entry.id === item.id ? updated : entry),
        notifications: [...state.notifications, ...[...recipients].map(recipient =>
          this.notification(actorId, recipient, item.id, operation[input.kind], now))] },
      actorId, operation[input.kind], item.id, now)
      return updated
    })
  }

  /**
   * Archive, move to the recycle bin or restore reviewed work while retaining complete business history.
   * @param actorId - Current authenticated creator or administrator; assignment alone grants no deletion authority.
   * @param itemId - Existing readable task or to-do, including inactive records.
   * @param expectedRevision - Revision explicitly reviewed before confirming the action.
   * @param input - Confirmed action and nonempty explanation; deletion retains data in the recycle bin.
   * @returns Committed item with atomic history, notices and audit. Unchanged states write nothing.
   * Inactive records leave daily work and cannot be edited, executed or read as active work until restored.
   */
  changeWorkLifecycle(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number,
    input: OfficeWorkLifecycleInput): Promise<OfficeItem> {
    const parsed = officeWorkLifecycleInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'A work lifecycle action needs an explanation'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      const item = this.readItem(state, actor, itemId, true)
      if (item.kind === 'schedule') throw new OfficeError('invalid_input', 'Calendar events use cancellation')
      if (item.creatorId !== actorId && actor.role !== 'admin')
        throw new OfficeError('forbidden', 'Only the creator or an administrator can archive, delete or restore work')
      this.checkRevision(item, expectedRevision)
      const previous = item.lifecycle ?? 'active'
      const { kind, reason } = parsed.data
      const destination = kind === 'archive' ? 'archived' : kind === 'delete' ? 'deleted' : 'active'
      if (previous === destination) return item
      if (kind === 'archive' && previous !== 'active') throw new OfficeError('conflict', 'Restore deleted work before archiving')
      const now = Date.now()
      const revision = item.revision + 1
      const updated: OfficeItem = { ...item, revision, updatedAt: now,
        lifecycle: destination === 'active' ? undefined : destination,
        lifecycleActions: [...(item.lifecycleActions ?? []), { kind, reason, previous, actorId, revision, time: now }] }
      const operation = { archive: 'work_archived', delete: 'work_deleted', restore: 'work_restored' } as const
      const recipients = new Set([item.creatorId, item.ownerId])
      recipients.delete(actorId)
      await this.commit(state, { items: state.items.map(entry => entry.id === item.id ? updated : entry),
        notifications: [...state.notifications, ...[...recipients].map(recipient => ({
          ...this.notification(actorId, recipient, item.id, operation[kind], now), itemTitle: item.title,
        }))] }, actorId, operation[kind], item.id, now)
      return updated
    })
  }

  /**
   * Resolve linked file names only while the caller can read the item and its reviewed current Drive versions.
   * @param actorId - Authenticated active employee.
   * @param itemId - Existing readable task or to-do.
   * @returns Current attachment availability without private names or metadata for inaccessible references.
   */
  workAttachments(actorId: OfficeMemberId, itemId: OfficeItemId): OfficeWorkAttachmentsView {
    this.assertOpen()
    const state = this.domain.global.get()
    const actor = this.scopeMember('files', state, actorId)
    const item = this.readItem(state, actor, itemId, true)
    if (item.kind === 'schedule') throw new OfficeError('invalid_input', 'Only work items have attachments')
    return { itemId, revision: item.revision, files: (item.attachments ?? []).map((file) => {
      try {
        const value = this.resolveConversationFile(actor, file)
        return { ...file, available: true as const, name: value.name, mediaType: value.mediaType, byteLength: value.byteLength }
      } catch (error) {
        if (error instanceof OfficeError && ['not_found', 'forbidden', 'conflict'].includes(error.code))
          return { ...file, available: false as const }
        throw error
      }
    }) }
  }

  /**
   * Replace reviewed attachment references without copying bytes or granting Drive access.
   * @param actorId - Current item creator, assignee or administrator.
   * @param itemId - Existing open task/to-do.
   * @param expectedRevision - Reviewed parent revision; any change invalidates pending delivery review.
   * @param input - At most 20 distinct files; new or changed references require current Drive access and version.
   * @returns Atomically committed item, notifications and audit; unchanged references write nothing.
   */
  updateWorkAttachments(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number,
    input: OfficeWorkAttachmentsInput): Promise<OfficeItem> {
    const parsed = officeWorkAttachmentsInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid work attachment references'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.scopeMember('files', state, actorId)
      const item = this.readItem(state, actor, itemId)
      if (item.kind === 'schedule') throw new OfficeError('invalid_input', 'Only work items have attachments')
      if (item.creatorId !== actorId && item.ownerId !== actorId && actor.role !== 'admin')
        throw new OfficeError('forbidden', 'Only the creator, assignee or administrator can edit attachments')
      this.checkRevision(item, expectedRevision)
      if (item.status === 'completed' || item.status === 'cancelled') throw new OfficeError('conflict', 'This work item is closed')
      const previous = item.attachments ?? []
      const files = parsed.data.files
      for (const file of files) {
        if (!previous.some(old => old.id === file.id && old.versionId === file.versionId))
          this.resolveConversationFile(actor, file)
      }
      if (previous.length === files.length && previous.every((file, index) =>
        file.id === files[index]?.id && file.versionId === files[index].versionId)) return item
      const now = Date.now()
      const updated: OfficeItem = { ...item, attachments: files, revision: item.revision + 1, updatedAt: now }
      const recipients = new Set([item.creatorId, item.ownerId])
      recipients.delete(actorId)
      await this.commit(state, { items: state.items.map(entry => entry.id === item.id ? updated : entry),
        notifications: [...state.notifications, ...[...recipients].map(recipient =>
          this.notification(actorId, recipient, item.id, 'work_attachments_updated', now))] },
      actorId, 'work_attachments_updated', item.id, now)
      return updated
    })
  }

  /**
   * Authorize a linked reviewed file version before starting a verified Drive download.
   * @param actorId - Current active reader of both item and file.
   * @param itemId - Existing readable work item still retaining this reference.
   * @param fileId - Linked logical file identity.
   * @returns Physically verified download metadata; missing, denied or replaced versions return no content.
   */
  workAttachmentInfo(actorId: OfficeMemberId, itemId: OfficeItemId, fileId: OfficeDriveId): Promise<OfficeDriveDownloadInfo> {
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.scopeMember('files', state, actorId)
      const item = this.readItem(state, actor, itemId, true)
      const file = item.attachments?.find(entry => entry.id === fileId)
      if (!file) throw new OfficeError('not_found', 'Work attachment is unavailable')
      const resolved = this.resolveConversationFile(actor, file)
      const { blob } = this.driveRepository.fileVersion(actor, file.id, file.versionId)
      await this.transferFiles.verify(blob)
      return { ...resolved, chunkBytes: this.driveLimits.chunkBytes }
    })
  }

  /**
   * Replace a task/to-do checklist using the version reviewed by its creator, assignee or administrator.
   * @param actorId - Current authenticated employee.
   * @param itemId - Existing task/to-do; all checklist access derives from this item.
   * @param expectedRevision - Reviewed parent revision, including other work changes.
   * @param input - Up to 100 entries; existing ids must belong to this work, and null ids receive fresh server identities.
   * @returns Committed work with atomic notification/audit; unchanged lists write nothing and closed or stale changes reject.
   */
  updateWorkSubtasks(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number,
    input: OfficeWorkSubtasksInput): Promise<OfficeItem> {
    const parsed = officeWorkSubtasksInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid subtask list or duplicate identities'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      const item = this.readItem(state, actor, itemId)
      if (item.kind === 'schedule') throw new OfficeError('invalid_input', 'Meetings do not have work checklists')
      if (item.creatorId !== actorId && item.ownerId !== actorId && actor.role !== 'admin')
        throw new OfficeError('forbidden', 'Only the creator, assignee or administrator can edit this checklist')
      this.checkRevision(item, expectedRevision)
      if (item.status === 'completed' || item.status === 'cancelled') throw new OfficeError('conflict', 'This work item is closed')
      const previous = item.subtasks ?? []
      const existing = new Set(previous.map(entry => entry.id))
      for (const entry of parsed.data.subtasks) {
        if (entry.id !== null && !existing.has(entry.id)) throw new OfficeError('invalid_input', 'Subtask does not belong to this work')
      }
      if (previous.length === parsed.data.subtasks.length && parsed.data.subtasks.every((entry, index) => {
        const old = previous[index]
        return old !== undefined && old.id === entry.id && old.title === entry.title && old.completed === entry.completed
      })) return item
      const subtasks: OfficeSubtask[] = parsed.data.subtasks.map(entry => ({ ...entry,
        id: entry.id ?? brandString<OfficeSubtaskId>(randomUUID()) }))
      const now = Date.now()
      const updated: OfficeItem = { ...item, subtasks, revision: item.revision + 1, updatedAt: now }
      const recipients = new Set([item.creatorId, item.ownerId])
      recipients.delete(actorId)
      await this.commit(state, { items: state.items.map(entry => entry.id === item.id ? updated : entry),
        notifications: [...state.notifications, ...[...recipients].map(recipient =>
          this.notification(actorId, recipient, item.id, 'work_subtasks_updated', now))] },
      actorId, 'work_subtasks_updated', item.id, now)
      return updated
    })
  }

  /**
   * Create a meeting with one accepted organizer and pending, distinct invitees.
   * @param actorId - Authenticated organizer.
   * @param input - Same-day schedule.
   * @returns durable meeting; invalid times or inactive invitees leave no invitation or item.
   */
  createSchedule(
    actorId: OfficeMemberId,
    input: OfficeScheduleInput,
  ): Promise<OfficeItem> {
    const parsed = officeScheduleInput.safeParse(input)
    if (!parsed.success)
      return Promise.reject(
        new OfficeError(
          'invalid_input',
          'Schedule fields or time interval are invalid',
        ),
      )
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      this.activeMember(state, actorId)
      const invitees = [...new Set(parsed.data.inviteeIds)].filter(
        id => id !== actorId,
      )
      for (const id of invitees) this.activeMember(state, id)
      const now = Date.now()
      const item: OfficeItem = {
        id: brandString<OfficeItemId>(randomUUID()),
        kind: 'schedule',
        title: parsed.data.title,
        description: parsed.data.description ?? '',
        date: parsed.data.date,
        time: parsed.data.startTime,
        endTime: parsed.data.endTime,
        location: parsed.data.location ?? '',
        status: 'pending',
        creatorId: actorId,
        ownerId: actorId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        participants: [
          { memberId: actorId, reply: 'accepted' },
          ...invitees.map(memberId => ({
            memberId,
            reply: 'pending' as const,
          })),
        ],
      }
      await this.commit(
        state,
        {
          items: [...state.items, item],
          notifications: [
            ...state.notifications,
            ...invitees.map(id =>
              this.notification(actorId, id, item.id, 'invited', now),
            ),
          ],
        },
        actorId,
        'schedule_created',
        item.id,
        now,
      )
      return item
    })
  }

  /**
   * Update a meeting on the revision its organizer or administrator reviewed.
   * @param actorId - Authenticated organizer or administrator.
   * @param itemId - Existing meeting identity.
   * @param expectedRevision - Last reviewed item revision, including invitation responses.
   * @param input - Same-day fields and optional invitees; omission preserves membership and the organizer always remains.
   * @returns Committed meeting with atomic invitations/removal notices; time changes reset invitee responses.
   * Closed or stale edits reject without writes.
   */
  updateSchedule(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number,
    input: OfficeScheduleUpdateInput): Promise<OfficeItem> {
    const parsed = officeScheduleUpdateInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Schedule fields or time interval are invalid'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      const item = this.readItem(state, actor, itemId)
      if (item.kind !== 'schedule') throw new OfficeError('invalid_input', 'Only a meeting can be edited here')
      if (item.creatorId !== actorId && actor.role !== 'admin')
        throw new OfficeError('forbidden', 'Only the organizer or an administrator can edit this meeting')
      this.checkRevision(item, expectedRevision)
      if (item.status === 'completed' || item.status === 'cancelled') throw new OfficeError('conflict', 'This meeting is closed')
      const fields = { title: parsed.data.title, description: parsed.data.description ?? '', date: parsed.data.date,
        time: parsed.data.startTime, endTime: parsed.data.endTime, location: parsed.data.location ?? '' }
      const previousIds = new Set(item.participants.map(participant => participant.memberId))
      const memberIds = new Set(parsed.data.inviteeIds === undefined ? previousIds : [item.creatorId, ...parsed.data.inviteeIds])
      const added = [...memberIds].filter(id => !previousIds.has(id))
      const removed = [...previousIds].filter(id => !memberIds.has(id))
      for (const id of added) this.activeMember(state, id)
      const membersChanged = added.length > 0 || removed.length > 0
      const timeChanged = item.date !== fields.date || item.time !== fields.time || item.endTime !== fields.endTime
      if (!membersChanged && !timeChanged && item.title === fields.title
        && item.description === fields.description && item.location === fields.location)
        return item
      const now = Date.now()
      const participants: OfficeParticipant[] = item.participants.filter(participant => memberIds.has(participant.memberId))
        .map(participant => timeChanged && participant.memberId !== item.creatorId
          ? { ...participant, reply: 'pending' } : participant)
      participants.push(...added.map(memberId => ({ memberId, reply: 'pending' as const })))
      const updated: OfficeItem = { ...item, ...fields, revision: item.revision + 1, updatedAt: now,
        participants }
      const recipients = new Set([...previousIds, ...memberIds])
      recipients.delete(actorId)
      await this.commit(state, { items: state.items.map(entry => entry.id === item.id ? updated : entry),
        notifications: [...state.notifications, ...[...recipients].map((recipient) => {
          const kind = !memberIds.has(recipient) ? 'schedule_removed' : !previousIds.has(recipient) ? 'invited' : 'schedule_updated'
          return { ...this.notification(actorId, recipient, item.id, kind, now),
            ...(!memberIds.has(recipient) ? { itemTitle: item.title } : {}) }
        })] }, actorId, membersChanged ? 'schedule_members_updated' : 'schedule_updated', item.id, now)
      return updated
    })
  }

  /**
   * Decide a task or transfer a to-do while retaining its history and original identity.
   * @param actorId - Current authenticated assignee, or creator/administrator for a transfer.
   * @param itemId - Existing task, or to-do for transfer; meetings retain their own controls.
   * @param expectedRevision - Item revision reviewed before deciding.
   * @param input - Explicit action; rejection and transfer include a reason, and transfer identifies an active new owner.
   * @returns Committed work and decision/assignment history; denied, closed or stale decisions publish no changes.
   */
  decideTask(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number,
    input: OfficeTaskDecisionInput): Promise<OfficeItem> {
    const parsed = officeTaskDecisionInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid task decision or reason'))
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      const item = this.readItem(state, actor, itemId)
      const decision = parsed.data
      if (item.kind === 'schedule' || (item.kind === 'todo' && decision.kind !== 'transfer'))
        throw new OfficeError('invalid_input', 'Tasks accept decisions; to-dos only accept transfer')
      if (item.ownerId !== actorId && (decision.kind !== 'transfer' || (item.creatorId !== actorId && actor.role !== 'admin')))
        throw new OfficeError('forbidden', 'Only the assignee can decide; creators and administrators may transfer')
      this.checkRevision(item, expectedRevision)
      if (item.status === 'completed' || item.status === 'cancelled') throw new OfficeError('conflict', 'This work item is closed')
      if (decision.kind !== 'transfer' && item.status !== 'pending') throw new OfficeError('conflict', 'Only pending tasks can be accepted or rejected')
      const ownerId = decision.kind === 'transfer' ? decision.ownerId : item.ownerId
      if (decision.kind === 'transfer') {
        this.activeMember(state, ownerId)
        if (ownerId === item.ownerId) throw new OfficeError('invalid_input', 'Choose a different assignee')
      }
      const now = Date.now()
      const action = { kind: decision.kind, actorId, fromOwnerId: item.ownerId, toOwnerId: ownerId,
        reason: decision.kind === 'accept' ? '' : decision.reason, time: now, revision: item.revision + 1 }
      const updated: OfficeItem = { ...item, ownerId, revision: action.revision, updatedAt: now,
        status: decision.kind === 'accept' ? 'in_progress' : decision.kind === 'reject' ? 'cancelled' : 'pending',
        ...(item.kind === 'todo' ? { todoAssignments: [...(item.todoAssignments ?? []), { ...action, kind: 'transfer' as const }] }
          : { taskActions: [...(item.taskActions ?? []), action] }) }
      const kind = { accept: 'task_accepted', reject: 'task_rejected', transfer: 'task_transferred' } as const
      const operation = item.kind === 'todo' ? 'todo_reassigned' : kind[decision.kind]
      const recipients = new Set([item.creatorId, item.ownerId, ownerId])
      recipients.delete(actorId)
      await this.commit(state, { items: state.items.map(entry => entry.id === item.id ? updated : entry),
        notifications: [...state.notifications, ...[...recipients].map(recipient =>
          ({ ...this.notification(actorId, recipient, item.id, operation, now), itemTitle: item.title }))] },
      actorId, operation, item.id, now)
      return updated
    })
  }

  /**
   * Change a work item's status with optimistic concurrency and execution-time authorization.
   * @param actorId - Authenticated owner/initiator or administrator.
   * @param itemId - Work to update.
   * @param expectedRevision - Last observed item revision.
   * @param status - New lifecycle state.
   * @returns committed item; stale writes reject with conflict. Only the organizer/admin changes meeting status.
   * Tasks with delivery history complete only through explicit delivery confirmation.
   */
  setStatus(
    actorId: OfficeMemberId,
    itemId: OfficeItemId,
    expectedRevision: number,
    status: OfficeItemStatus,
  ): Promise<OfficeItem> {
    if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status))
      return Promise.reject(
        new OfficeError('invalid_input', 'Unknown work status'),
      )
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      const item = this.readItem(state, actor, itemId)
      if (
        actor.role !== 'admin' &&
        item.creatorId !== actorId &&
        (item.kind === 'schedule' || item.ownerId !== actorId)
      ) {
        throw new OfficeError(
          'forbidden',
          'This employee cannot change this item',
        )
      }
      this.checkRevision(item, expectedRevision)
      if (item.status === status) return item
      if (status === 'completed' && item.kind === 'task' && (item.deliveries?.length ?? 0) > 0)
        throw new OfficeError('conflict', 'Confirm the task delivery before completing this task')
      const now = Date.now()
      const updated = {
        ...item,
        status,
        revision: item.revision + 1,
        updatedAt: now,
      }
      const recipients = new Set([
        item.creatorId,
        item.ownerId,
        ...item.participants.map(entry => entry.memberId),
      ])
      recipients.delete(actorId)
      await this.commit(
        state,
        {
          items: state.items.map(entry =>
            entry.id === item.id ? updated : entry,
          ),
          notifications: [
            ...state.notifications,
            ...[...recipients].map(id =>
              this.notification(actorId, id, item.id, 'status_changed', now),
            ),
          ],
        },
        actorId,
        'status_changed',
        item.id,
        now,
      )
      return updated
    })
  }

  /**
   * Reply only to the caller's own live invitation and notify the organizer.
   * @param actorId - Authenticated invitee.
   * @param itemId - Meeting being answered.
   * @param expectedRevision - Last observed item revision.
   * @param reply - Accepted or declined.
   * @returns committed meeting; closed meetings, organizer changes and stale writes reject without side effects.
   */
  reply(
    actorId: OfficeMemberId,
    itemId: OfficeItemId,
    expectedRevision: number,
    reply: Exclude<OfficeInvitationReply, 'pending'>,
  ): Promise<OfficeItem> {
    if (!new Set<string>(['accepted', 'declined']).has(reply))
      return Promise.reject(
        new OfficeError('invalid_input', 'Unknown invitation reply'),
      )
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const item = this.readItem(
        state,
        this.activeMember(state, actorId),
        itemId,
      )
      if (
        item.kind !== 'schedule' ||
        item.creatorId === actorId ||
        !item.participants.some(entry => entry.memberId === actorId)
      ) {
        throw new OfficeError(
          'forbidden',
          'Only an invited employee can answer their invitation',
        )
      }
      this.checkRevision(item, expectedRevision)
      if (item.status === 'cancelled' || item.status === 'completed')
        throw new OfficeError('conflict', 'This meeting is closed')
      if (
        item.participants.find(entry => entry.memberId === actorId)?.reply ===
        reply
      )
        return item
      const now = Date.now()
      const updated = {
        ...item,
        participants: item.participants.map(entry =>
          entry.memberId === actorId ? { ...entry, reply } : entry,
        ),
        revision: item.revision + 1,
        updatedAt: now,
      }
      await this.commit(
        state,
        {
          items: state.items.map(entry =>
            entry.id === itemId ? updated : entry,
          ),
          notifications: [
            ...state.notifications,
            this.notification(
              actorId,
              item.creatorId,
              itemId,
              'invitation_reply',
              now,
            ),
          ],
        },
        actorId,
        'invitation_reply',
        itemId,
        now,
      )
      return updated
    })
  }

  /**
   * Edit contact fields, never role or active state.
   * @param actorId - Authenticated employee.
   * @param input - Complete profile fields.
   * @returns committed directory entry; unknown privilege fields reject at admission.
   */
  updateProfile(
    actorId: OfficeMemberId,
    input: OfficeProfile,
  ): Promise<OfficeMember> {
    const parsed = officeProfile.safeParse(input)
    if (!parsed.success)
      return Promise.reject(
        new OfficeError('invalid_input', 'Profile fields are invalid'),
      )
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const member = this.activeMember(state, actorId)
      const updated = { ...member, ...parsed.data }
      await this.commit(
        state,
        {
          members: state.members.map(entry =>
            entry.id === actorId ? updated : entry,
          ),
        },
        actorId,
        'profile_updated',
        actorId,
        Date.now(),
      )
      return updated
    })
  }

  /**
   * Administrator-only directory creation, role change or offboarding. Historical identities remain.
   * @param actorId - Authenticated administrator.
   * @param member - Complete employee record.
   * @param expected - Null creates an identity; a reviewed record protects edits. Omission preserves trusted upserts.
   * @returns committed member; removing the last active administrator is rejected.
   */
  saveMember(
    actorId: OfficeMemberId,
    member: OfficeMember,
    expected?: OfficeMember | null,
  ): Promise<OfficeMember> {
    const parsed = officeMember.safeParse(member)
    if (!parsed.success)
      return Promise.reject(
        new OfficeError('invalid_input', 'Member fields are invalid'),
      )
    const previous = officeMember.nullable().optional().safeParse(expected)
    if (
      !previous.success ||
      (previous.data && previous.data.id !== parsed.data.id)
    )
      return Promise.reject(
        new OfficeError('invalid_input', 'Expected member identity is invalid'),
      )
    const expectedMember = previous.data
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      if (this.activeMember(state, actorId).role !== 'admin')
        throw new OfficeError(
          'forbidden',
          'Only an administrator may manage employees',
        )
      const current = state.members.find(
        entry => entry.id === parsed.data.id,
      )
      const fields = [
        'id',
        'name',
        'department',
        'jobTitle',
        'email',
        'phone',
        'role',
        'active',
      ] as const
      if (
        expectedMember === null
          ? current !== undefined
          : expectedMember !== undefined &&
            (!current ||
              fields.some(key => current[key] !== expectedMember[key]))
      ) {
        throw new OfficeError(
          'conflict',
          'Member changed after the reviewed record',
        )
      }
      const members = current
        ? state.members.map(entry =>
          entry.id === parsed.data.id ? parsed.data : entry,
        )
        : [...state.members, parsed.data]
      if (!members.some(entry => entry.active && entry.role === 'admin'))
        throw new OfficeError(
          'invalid_input',
          'The last active administrator cannot be removed',
        )
      this.identities.checkAdministrators(members)
      if (current && (current.active && !parsed.data.active || current.role !== parsed.data.role)) {
        await this.identities.revokeForOffboarding(actorId, current.id)
        await this.memberInvites?.revokeForMember(actorId, current.id)
      }
      if (current && !current.active && parsed.data.active)
        await this.identities.beforeReactivation(actorId, current.id)
      await this.commit(
        state,
        { members },
        actorId,
        'member_saved',
        parsed.data.id,
        Date.now(),
      )
      return parsed.data
    })
  }

  /**
   * Mark one delivered notification as read without acknowledging another employee's inbox.
   * @param actorId - Authenticated recipient.
   * @param notificationId - Notification to acknowledge.
   * @returns after durability; missing and hidden notifications return the same not_found denial.
   */
  markRead(
    actorId: OfficeMemberId,
    notificationId: OfficeNotificationId,
  ): Promise<void> {
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      this.activeMember(state, actorId)
      const notification = state.notifications.find(
        entry => entry.id === notificationId && entry.recipientId === actorId,
      )
      if (!notification)
        throw new OfficeError('not_found', 'Notification is unavailable')
      if (notification.read) return
      const next = {
        ...state,
        revision: state.revision + 1,
        notifications: state.notifications.map(entry =>
          entry.id === notificationId ? { ...entry, read: true } : entry,
        ),
      }
      await this.domain.global.set(next)
      await this.publish(next.revision)
    })
  }

  /**
   * Read committed operation history, restricted to active administrators.
   * @param actorId - Authenticated administrator.
   * @returns borrowed read-only audit entries.
   */
  audit(actorId: OfficeMemberId): readonly OfficeAuditEntry[] {
    this.assertOpen()
    const state = this.domain.global.get()
    if (this.activeMember(state, actorId).role !== 'admin')
      throw new OfficeError(
        'forbidden',
        'Only an administrator may read office audit',
      )
    return state.audit
  }

  /**
   * Search retained operation metadata and authenticated request denials across the office histories.
   * @param actorId - Active administrator, rechecked on every page.
   * @param query - Bounded exact filters and exclusive older-page position.
   * @returns Allowlisted metadata only; source retention applies and pages are current reads, not a snapshot.
   */
  auditPage(actorId: OfficeMemberId, query: OfficeAuditQuery): OfficeAuditPage {
    const business = this.audit(actorId)
    return queryOfficeAudit({ business, identity: this.identityDomain.global.get().audit,
      organization: this.organizationDomain.global.get().audit, drive: this.driveDomain.global.get().audit,
      integration: this.integrationDomain.global.get().audit, connection: this.connectorDomain.global.get().audit,
      requestDenials: this.requestDenialsDomain.global.get().entries }, query)
  }

  /**
   * Export one bounded metadata batch without including business fields, credential data or provider diagnostics.
   * @param actorId - Active administrator, rechecked for every batch.
   * @param query - Same filters and continuation used by auditPage.
   * @returns Newline-delimited JSON plus the next position; an empty batch has empty content.
   */
  auditExport(actorId: OfficeMemberId, query: OfficeAuditQuery): OfficeAuditExport {
    const page = this.auditPage(actorId, query)
    return { mediaType: 'application/x-ndjson', content: page.entries.map(entry => JSON.stringify(entry) + '\n').join(''),
      count: page.entries.length, total: page.total, next: page.next }
  }

  /**
   * Initialize backend sign-in for an existing administrator once; later values never reset credentials.
   * @param administrator - Deployment-owned active administrator.
   * @param password - First password from the trusted server startup channel.
   * @returns Whether initialization committed; this is not a public signup endpoint.
   */
  initializeIdentity(
    administrator: OfficeMemberId,
    password: string,
  ): Promise<boolean> {
    return this.identities.initialize(administrator, password)
  }

  /**
   * Read the optional pre-login invitation capability without directory or credential information.
   * @returns Safe explicit lifetime capability, or null when invitations are disabled.
   */
  memberInviteCapability(): OfficeMemberInviteCapability | null {
    this.assertOpen()
    return this.memberInviteConfig ? { protocol: 1, maxTtlMs: this.memberInviteConfig.maxTtlMs } : null
  }

  /**
   * Read one managed member's latest invitation and independent current enrollment facts.
   * @param actorId - Current authenticated administrator.
   * @param memberId - Existing retained company member.
   * @returns Credential-free invitation metadata without a code or secret hash.
   */
  memberInvite(actorId: OfficeMemberId, memberId: OfficeMemberId): Promise<OfficeMemberInviteView> {
    const parsed = officeMemberInviteSchemas.memberId.safeParse(memberId)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid invitation member identity'))
    return this.enqueue(() => Promise.resolve(this.invitationRepository().view(actorId, parsed.data)))
  }

  /**
   * Issue a finite first-password invitation for a reviewed active member with no credentials.
   * @param actorId - Current authenticated administrator; no role comes from the recipient.
   * @param input - Exact member/role, expiry and original issuance retry UUID.
   * @returns Committed metadata and a code only on the first response; retries cannot recover that code.
   */
  issueMemberInvite(actorId: OfficeMemberId, input: OfficeMemberInviteIssueInput): Promise<OfficeMemberInviteIssueReceipt> {
    return this.enqueue(async () => {
      if (!this.identities.overview(actorId).initialized)
        throw new OfficeError('conflict', 'Initialize company sign-in before issuing invitations')
      return this.invitationRepository().issue(actorId, input)
    })
  }

  /**
   * Revoke a reviewed invitation; an already-set credential remains governed by the existing account controls.
   * @param actorId - Current authenticated administrator.
   * @param input - Invitation identity and observed revision.
   * @returns Retained revocation evidence; it does not remove or reset a password.
   */
  revokeMemberInvite(actorId: OfficeMemberId, input: OfficeMemberInviteRevokeInput): Promise<OfficeMemberInvite> {
    return this.enqueue(async () => this.invitationRepository().revoke(actorId, input))
  }

  /**
   * Authenticate a limited code and set only its target's first password in one original identity commit.
   * @param input - Code and recipient-selected password, with no caller-selected identity or role.
   * @param signal - Original request cancellation; unload prevents new commitment and drains admitted hashing.
   * @returns Only the login member id after commitment; no business token or automatic sign-in.
   */
  acceptMemberInvite(input: OfficeMemberInviteAcceptInput, signal?: AbortSignal): Promise<OfficeMemberInviteAcceptReceipt> {
    this.assertOpen()
    const parsed = officeMemberInviteSchemas.accept.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid first-password invitation acceptance'))
    const repository = this.invitationRepository()
    const cancellation = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
    const pending = this.identities.enrollFirstPassword(parsed.data.newPassword,
      () => repository.authorize(parsed.data.code), cancellation).then(memberId => ({ memberId }))
    this.memberInviteAccepting.add(pending)
    void pending.then(() => { this.memberInviteAccepting.delete(pending) }, () => { this.memberInviteAccepting.delete(pending) })
    return pending
  }

  private invitationRepository(): OfficeMemberInvitesRepository {
    if (!this.memberInvites) throw new OfficeError('forbidden', 'Member invitations are not enabled')
    return this.memberInvites
  }

  /**
   * Enroll or reset employee credentials through a trusted, authenticated administrator adapter.
   * @param actorId - Verified administrator supplied by the gateway.
   * @param memberId - Active target employee.
   * @param password - Replacement password; never logged or returned.
   */
  setIdentityPassword(
    actorId: OfficeMemberId,
    memberId: OfficeMemberId,
    password: string,
  ): Promise<void> {
    return this.identities.setPassword(actorId, memberId, password)
  }

  /**
   * Sign in without caller-claimed authority; adapters keep the returned secret out of UI and logs.
   * @param input - Employee id and password.
   * @returns A durable session's one-time bearer receipt for the trusted authentication adapter.
   */
  login(input: OfficeLoginInput): Promise<OfficeLoginResult> {
    return this.identities.login(input)
  }

  /**
   * Bind a gateway business request to its actual active employee and current role.
   * @param token - Opaque token from the authentication header, never a caller-selected actor id.
   * @returns Current employee authority; this does not expose password material.
   */
  authenticate(token: string): OfficeMember {
    return this.identities.authenticate(token)
  }

  /**
   * Bind a trusted gateway operation to its session, including execution-time queue checks.
   * @param token - Actual request bearer token; never an employee id or claimed role.
   * @param operation - Trusted callback receiving the authenticated employee and a server-only denial-scope registrar.
   * @returns The operation result, with revoked or expired queued work rejected before execution.
   */
  withSession<T>(
    token: string,
    operation: (memberId: OfficeMemberId, auditDenial: (scope: OfficeRequestDenialScope) => void) => Promise<T>,
  ): Promise<T> {
    const member = this.authenticate(token)
    const request: { token: string; memberId: OfficeMemberId; denial: OfficeRequestDenialScope | null } = {
      token, memberId: member.id, denial: null,
    }
    return this.requestSession.run(request, () =>
      operation(member.id, (scope) => { request.denial = scope }),
    )
  }

  /**
   * Read only a signed-in employee's device sessions.
   * @param token - Current opaque token.
   * @returns Sanitized own-session handles without bearer material.
   */
  identitySessions(token: string): readonly OfficeSessionInfo[] {
    return this.identities.sessions(token)
  }

  /**
   * Durably revoke this bearer session; repeating a successful logout is harmless.
   * @param token - Session to revoke.
   */
  logout(token: string): Promise<void> {
    return this.identities.logout(token)
  }

  /**
   * Revoke only a device session belonging to the authenticated employee.
   * @param token - Current bearer token.
   * @param id - Own device-session handle.
   */
  revokeIdentitySession(token: string, id: OfficeSessionId): Promise<void> {
    return this.identities.revoke(token, id)
  }

  /**
   * Verify the current password before replacing it and revoking every old session.
   * @param token - Current bearer token.
   * @param input - Reviewed current password and replacement.
   */
  changeIdentityPassword(
    token: string,
    input: OfficePasswordChangeInput,
  ): Promise<void> {
    return this.identities.changePassword(token, input)
  }

  /**
   * Read administrator-only enrollment metadata with no credential values.
   * @param actorId - Verified administrator.
   * @returns Enrollment presence, never salts, password hashes or tokens.
   */
  identityOverview(actorId: OfficeMemberId): OfficeIdentityOverview {
    return this.identities.overview(actorId)
  }

  /**
   * Read administrator-managed departments, positions and formal employee affiliations.
   * @param actorId - Authenticated active employee.
   * @returns Authorized structure, including an explicit first-configuration state.
   */
  organization(actorId: OfficeMemberId): OfficeOrganizationView {
    this.assertOpen()
    const state = this.domain.global.get()
    return this.organizations.view(
      this.activeMember(state, actorId),
      state.members,
    )
  }

  /**
   * Initialize formal organization once from the directory the administrator reviewed.
   * @param actorId - Authenticated administrator.
   * @param officeRevision - Reviewed office revision; a concurrent directory edit rejects first initialization.
   * @returns Committed structure; later calls never overwrite existing organization with profile labels.
   */
  initializeOrganization(
    actorId: OfficeMemberId,
    officeRevision: number,
  ): Promise<OfficeOrganizationView> {
    if (!Number.isSafeInteger(officeRevision) || officeRevision < 0)
      return Promise.reject(
        new OfficeError('invalid_input', 'Expected a reviewed office revision'),
      )
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      const actor = this.activeMember(state, actorId)
      if (actor.role !== 'admin')
        throw new OfficeError(
          'forbidden',
          'Only an administrator may initialize formal organization',
        )
      if (
        !this.organizationDomain.global.get().initialized &&
        state.revision !== officeRevision
      )
        throw new OfficeError('conflict', 'The directory changed after review')
      return this.organizations.initialize(actor, state.members)
    })
  }

  /**
   * Create/edit/deactivate a department through current administrator authority and its reviewed version.
   * @param actorId - Authenticated administrator.
   * @param input - Department identity, parent, name and version.
   * @returns The committed department without changing contact labels or authorization roles.
   */
  saveOrganizationUnit(
    actorId: OfficeMemberId,
    input: OfficeUnitInput,
  ): Promise<OfficeOrganizationUnit> {
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      return this.organizations.saveUnit(
        this.activeMember(state, actorId),
        input,
        state.members,
      )
    })
  }

  /**
   * Create/edit/deactivate a formal position; positions do not grant office authorization roles.
   * @param actorId - Authenticated administrator.
   * @param input - Position, optional department and reviewed version.
   * @returns Committed position, or a denial preserving in-use employee affiliations.
   */
  savePosition(
    actorId: OfficeMemberId,
    input: OfficePositionInput,
  ): Promise<OfficePosition> {
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      return this.organizations.savePosition(
        this.activeMember(state, actorId),
        input,
        state.members,
      )
    })
  }

  /**
   * Assign formal department and position independently of self-service contact profile edits.
   * @param actorId - Authenticated administrator.
   * @param input - Existing employee, target entities and reviewed assignment version.
   * @returns A committed affiliation, including versioned explicit unassignment.
   */
  assignOrganization(
    actorId: OfficeMemberId,
    input: OfficeAssignmentInput,
  ): Promise<OfficeOrganizationAssignment> {
    return this.enqueue(async () => {
      const state = this.domain.global.get()
      return this.organizations.assign(
        this.activeMember(state, actorId),
        input,
        state.members,
      )
    })
  }

  private day(date: string, all: readonly OfficeItem[]): OfficeDay {
    const items = all
      .filter(item => item.date === date)
      .sort(
        (a, b) =>
          (a.time ?? '99:99').localeCompare(b.time ?? '99:99') ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      )
    const completed = items.filter(
      item => item.status === 'completed',
    ).length
    const cancelled = items.filter(
      item => item.status === 'cancelled',
    ).length
    const active = items.length - cancelled
    return {
      date,
      items,
      pending: active - completed,
      completed,
      cancelled,
      work: items.filter(item => item.kind !== 'schedule').length,
      schedules: items.filter(item => item.kind === 'schedule').length,
      completionRate: active === 0 ? 0 : Math.round((completed * 100) / active),
    }
  }

  private activeMember(state: OfficeState, id: OfficeMemberId): OfficeMember {
    const member = this.directoryMember(state, id)
    this.collaboration?.governance.assert(id, 'office')
    return member
  }

  private scopeMember(scope: OfficeAccessScope, state: OfficeState, id: OfficeMemberId): OfficeMember {
    const member = this.activeMember(state, id)
    this.collaboration?.governance.assert(id, scope)
    return member
  }

  private directoryMember(state: OfficeState, id: OfficeMemberId): OfficeMember {
    const member = state.members.find(
      entry => entry.id === id && entry.active,
    )
    if (!member)
      throw new OfficeError(
        'forbidden',
        'Employee identity is unavailable or inactive',
      )
    return member
  }

  private canRead(actor: OfficeMember, item: OfficeItem): boolean {
    return (
      actor.role === 'admin' ||
      item.creatorId === actor.id ||
      item.ownerId === actor.id ||
      item.participants.some(entry => entry.memberId === actor.id)
    )
  }

  private readItem(
    state: OfficeState,
    actor: OfficeMember,
    id: OfficeItemId,
    allowInactive = false,
  ): OfficeItem {
    const item = state.items.find(
      entry => entry.id === id && this.canRead(actor, entry) && (allowInactive || entry.lifecycle === undefined),
    )
    if (!item) throw new OfficeError('not_found', 'Work item is unavailable')
    return item
  }

  private checkRevision(item: OfficeItem, expected: number): void {
    if (item.revision !== expected)
      throw new OfficeError(
        'conflict',
        'The item changed; read it again before editing',
      )
  }

  private notification(
    actorId: OfficeMemberId,
    recipientId: OfficeMemberId,
    itemId: OfficeItemId,
    kind: OfficeNotification['kind'],
    now: number,
  ): OfficeNotification {
    return {
      id: brandString<OfficeNotificationId>(randomUUID()),
      actorId,
      recipientId,
      itemId,
      kind,
      createdAt: now,
      read: false,
    }
  }

  private async commit(
    state: OfficeState,
    changes: {
      members?: readonly OfficeMember[]
      items?: readonly OfficeItem[]
      notifications?: readonly OfficeNotification[]
    },
    actorId: OfficeMemberId,
    action: OfficeAuditEntry['action'],
    targetId: string,
    now: number,
  ): Promise<void> {
    const revision = state.revision + 1
    const next = {
      ...state,
      ...changes,
      revision,
      audit: [
        ...state.audit,
        { revision, actorId, action, targetId, time: now },
      ],
    }
    // StorageDomain publishes only after backend durability. Do not mutate borrowed records before this write.
    await this.domain.global.set(next)
    await this.publish(revision)
  }

  private async publish(revision: number): Promise<void> {
    try {
      await this.ctx.parallel('office/changed', revision)
    } catch (error) {
      // An observer cannot retroactively reject an already committed business operation.
      this.ctx.logger.warn(
        `office/changed observer failed after revision ${revision}: ${String(error)}`,
      )
    }
  }

  private async primeChat(): Promise<void> {
    const chat = this.chatDomain.global.get()
    // A positive watermark distinguishes an initialized empty chat from a lost original chat unit.
    if (chat.revision === 0) await this.chatDomain.global.set({ ...chat, revision: 1 })
  }

  private async createChatFilesMessage(actorId: OfficeMemberId, input: OfficeChatFilesInput): Promise<OfficeChatMessage> {
    const office = this.domain.global.get()
    this.activeMember(office, actorId)
    if (input.recipientId === actorId) throw new OfficeError('invalid_input', 'A private message needs another member')
    if (!this.chatDomain.global.get().messages.some(entry => entry.id === input.id) &&
      !office.members.some(entry => entry.id === input.recipientId && entry.active))
      throw new OfficeError('not_found', 'Recipient is unavailable')
    this.chatFiles.verifyDirectory(office.members)
    await this.primeChat()
    const text = await this.chatFiles.prepare(actorId, input)
    const message = await this.createChatMessage(actorId, { id: input.id, recipientId: input.recipientId, text })
    await this.chatFiles.confirm(message)
    return message
  }

  private async createChatMessage(actorId: OfficeMemberId, input: OfficeChatInput): Promise<OfficeChatMessage> {
    const office = this.domain.global.get()
    const sender = this.activeMember(office, actorId)
    const state = this.chatDomain.global.get()
    const previous = state.messages.find(entry => entry.id === input.id)
    if (previous) {
      if (previous.senderId !== actorId || previous.recipientId !== input.recipientId || previous.text !== input.text)
        throw new OfficeError('conflict', 'Message retry does not match the committed payload')
      return this.chatFiles.decorate(previous)
    }
    if (input.recipientId === actorId) throw new OfficeError('invalid_input', 'A private message needs another member')
    const recipient = office.members.find(entry => entry.id === input.recipientId && entry.active)
    if (!recipient) throw new OfficeError('not_found', 'Recipient is unavailable')
    const revision = state.revision + 1
    const message: OfficeChatMessage = { id: input.id, sequence: revision, senderId: sender.id, recipientId: recipient.id,
      senderName: sender.name, recipientName: recipient.name, text: input.text, createdAt: Date.now() }
    await this.commitChat({ ...state, revision, messages: [...state.messages, message] })
    return this.chatFiles.decorate(message)
  }

  private async commitChat(state: OfficeChatState): Promise<void> {
    await this.chatDomain.global.set(state)
    try {
      await this.ctx.parallel('office/chat-changed')
    } catch (error) {
      this.ctx.logger.warn(
        `office/chat-changed observer failed after revision ${state.revision}: ${String(error)}`,
      )
    }
  }

  private assertOpen(): void {
    if (this.isClosed())
      throw new OfficeError('closed', 'Office service is closed')
  }

  private isClosed(): boolean {
    if (this.lifetime.signal.aborted) return true
    // A parent can begin unloading before teardown reaches this service's own fiber.
    let current = this.ownerFiber
    for (;;) {
      if (current.state === FiberState.UNLOADING || current.state === FiberState.DISPOSED) return true
      const parent = current.parent.fiber
      if (parent === current) return false
      current = parent
    }
  }

  /**
   * Reserve a resumable file under the employee's current membership, destination permissions and quota.
   * @param actorId - Authenticated employee supplied by the Host or gateway.
   * @param input - Reviewed immutable file declaration and retry identity.
   * @returns A durable owner-only upload ticket.
   */
  beginDriveUpload(actorId: OfficeMemberId, input: OfficeDriveUploadDeclaration): Promise<OfficeDriveUploadTicket> {
    return this.enqueue(() => this.uploads.begin(this.scopeMember('files', this.domain.global.get(), actorId), input))
  }

  /**
   * List unfinished uploads for the current employee without exposing another account's receipt positions.
   * @param actorId - Authenticated active employee.
   * @returns Owner-only resumable tickets.
   */
  driveUploads(actorId: OfficeMemberId): Promise<readonly OfficeDriveUploadTicket[]> {
    return this.enqueue(() => this.uploads.list(this.scopeMember('files', this.domain.global.get(), actorId)))
  }

  /**
   * Recover an owned upload after a lost response or application restart.
   * @param actorId - Current authenticated employee.
   * @param id - Server-minted upload coordinate.
   * @returns The confirmed private receipt state.
   */
  getDriveUpload(actorId: OfficeMemberId, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket> {
    return this.enqueue(() => this.uploads.get(this.scopeMember('files', this.domain.global.get(), actorId), id))
  }

  /**
   * Stage one chunk after rechecking this employee's session, current directory access and shared quota.
   * @param actorId - Authenticated active employee.
   * @param input - Reviewed upload identity, position, digest and bounded encoded bytes.
   * @returns Acknowledged receipt positions after durability.
   */
  appendDriveUpload(actorId: OfficeMemberId, input: OfficeDriveUploadChunkInput): Promise<OfficeDriveUploadTicket> {
    return this.enqueue(() => this.uploads.append(this.scopeMember('files', this.domain.global.get(), actorId), input))
  }

  /**
   * Verify and publish a complete upload once, retaining the original request identity through uncertain responses.
   * @param actorId - Authenticated active employee.
   * @param id - Owned resumable upload coordinate.
   * @returns The confirmed completed ticket and logical file identity.
   */
  completeDriveUpload(actorId: OfficeMemberId, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket> {
    return this.enqueue(() => this.uploads.complete(this.scopeMember('files', this.domain.global.get(), actorId), id))
  }

  /**
   * Cancel owned staging; a file already durably published is reported as completed and retained.
   * @param actorId - Current active owner, including after destination access was revoked.
   * @param id - Server-owned upload identity.
   * @returns The confirmed terminal outcome; temporary-byte cleanup retries in the background.
   */
  cancelDriveUpload(actorId: OfficeMemberId, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket> {
    return this.enqueue(() => this.uploads.cancel(this.scopeMember('files', this.domain.global.get(), actorId), id))
  }

  /**
   * Authorize and verify a file before giving the client its immutable download version.
   * @param actorId - Authenticated active reader.
   * @param id - Logical file identity.
   * @returns Verified metadata and the current bounded download chunk size.
   */
  driveFileInfo(actorId: OfficeMemberId, id: OfficeDriveId): Promise<OfficeDriveDownloadInfo> {
    return this.enqueue(async () => {
      const { entry, blob } = this.driveRepository.fileVersion(this.scopeMember('files', this.domain.global.get(), actorId), id)
      await this.transferFiles.verify(blob)
      return { id: entry.id, versionId: brandString<OfficeDriveVersionId>(blob.id), name: entry.name,
        mediaType: entry.mediaType, byteLength: blob.byteLength, sha256: blob.sha256, chunkBytes: this.driveLimits.chunkBytes }
    })
  }

  /**
   * Read current authorized version history without opening content or changing the file head.
   * @param actorId - Authenticated active reader.
   * @param id - Logical file identity.
   * @returns Immutable version metadata ordered newest first.
   */
  driveHistory(actorId: OfficeMemberId, id: OfficeDriveId): OfficeDriveHistory {
    this.assertOpen()
    return this.driveRepository.history(this.scopeMember('files', this.domain.global.get(), actorId), id)
  }

  /**
   * Read only the current employee's visible recycle-bin roots.
   * @param actorId - Authenticated active owner.
   * @returns Retained deleted metadata with current restore permissions.
   */
  driveTrash(actorId: OfficeMemberId): OfficeDriveTrash {
    this.assertOpen()
    return this.driveRepository.trash(this.scopeMember('files', this.domain.global.get(), actorId))
  }

  /**
   * Review the exact owned deleted subtree before permanent cleanup.
   * @param actorId - Authenticated active owner.
   * @param id - Deleted root identity.
   * @returns Read-only scope totals and the digest required by confirmation.
   */
  drivePurgePlan(actorId: OfficeMemberId, id: OfficeDriveId): OfficeDrivePurgePlan {
    this.assertOpen()
    return this.driveRepository.purgePlan(this.scopeMember('files', this.domain.global.get(), actorId), id)
  }

  /**
   * Permanently clear only an exactly reviewed owned subtree after durable authorization.
   * @param actorId - Authenticated active owner.
   * @param input - Exact reviewed revision, digest and stable request identity.
   * @returns Pending or completed receipt; only completion releases the charged quota.
   */
  purgeDrive(actorId: OfficeMemberId, input: OfficeDrivePurgeInput): Promise<OfficeDrivePurgeReceipt> {
    return this.enqueue(() => this.driveRepository.purge(this.scopeMember('files', this.domain.global.get(), actorId), input))
  }

  /**
   * Inspect an existing owner cleanup receipt without changing its scope or reading bytes.
   * @param actorId - Authenticated active owner.
   * @param id - Original deleted root identity.
   * @returns Durable status or null when no permanent cleanup has been approved.
   */
  drivePurgeStatus(actorId: OfficeMemberId, id: OfficeDriveId): OfficeDrivePurgeReceipt | null {
    this.assertOpen()
    return this.driveRepository.purgeStatus(this.scopeMember('files', this.domain.global.get(), actorId), id)
  }

  /**
   * Continue an already approved owner cleanup, including after an uncertain acknowledgement.
   * @param actorId - Authenticated active owner.
   * @param id - Previously approved root; no new scope is authorized by this operation.
   * @returns Latest durable receipt; completed retries perform no further writes.
   */
  retryDrivePurge(actorId: OfficeMemberId, id: OfficeDriveId): Promise<OfficeDrivePurgeReceipt> {
    return this.enqueue(() => this.driveRepository.retryPurge(this.scopeMember('files', this.domain.global.get(), actorId), id))
  }

  /**
   * Confirm one reviewed deletion or restoration without discarding versions or Native files.
   * @param actorId - Authenticated active owner.
   * @param input - Reviewed revision, action and optional new restore name.
   * @returns Committed active or deleted metadata; denied writes do not publish.
   */
  changeDriveLifecycle(actorId: OfficeMemberId, input: OfficeDriveLifecycleInput): Promise<OfficeDriveEntry | OfficeDriveTrashEntry> {
    return this.enqueue(() => this.driveRepository.lifecycle(this.scopeMember('files', this.domain.global.get(), actorId), input))
  }

  /**
   * Authorize and verify a selected historical object before exposing download metadata.
   * @param actorId - Authenticated active reader.
   * @param id - Logical file identity.
   * @param versionId - Immutable version selected from authorized history.
   * @returns Verified version metadata with its original media type and current chunk bound.
   */
  driveVersionInfo(actorId: OfficeMemberId, id: OfficeDriveId, versionId: OfficeDriveVersionId): Promise<OfficeDriveDownloadInfo> {
    if (!officeDriveRangeInput.shape.versionId.safeParse(versionId).success)
      return Promise.reject(new OfficeError('invalid_input', 'Invalid file version'))
    return this.enqueue(async () => {
      const { entry, blob } = this.driveRepository.fileVersion(this.scopeMember('files', this.domain.global.get(), actorId), id, versionId)
      await this.transferFiles.verify(blob)
      return { id: entry.id, versionId, name: entry.name, mediaType: blob.mediaType,
        byteLength: blob.byteLength, sha256: blob.sha256, chunkBytes: this.driveLimits.chunkBytes }
    })
  }

  /**
   * Read one reviewed immutable range with fresh membership and ancestor-permission checks.
   * @param actorId - Current authenticated active reader.
   * @param input - Logical file, immutable version and bounded byte span.
   * @returns Actual range bytes and their digest; denied or corrupt reads return no content.
   */
  downloadDriveRange(actorId: OfficeMemberId, input: OfficeDriveRangeInput): Promise<OfficeDriveDownloadRange> {
    const parsed = officeDriveRangeInput.safeParse(input)
    if (!parsed.success) return Promise.reject(new OfficeError('invalid_input', 'Invalid download range'))
    return this.enqueue(async () => {
      const value = parsed.data
      const { blob } = this.driveRepository.fileVersion(this.scopeMember('files', this.domain.global.get(), actorId), value.id, value.versionId)
      const bytes = await this.transferFiles.readRange(blob, value.offset, value.byteLength)
      return { ...value, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }
    })
  }

  private startReminderPolling(): void {
    const reminders = this.reminders
    const configuration = this.reminderConfig
    if (!reminders || !configuration) return
    this.ctx.effect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stop = () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      }
      const schedule = () => {
        if (this.isClosed()) return
        timer = setTimeout(() => {
          timer = undefined
          if (this.isClosed()) return
          const pending = this.requestSession.exit(() => this.enqueue(async () => {
            if (this.isClosed()) return
            const state = this.domain.global.get()
            await reminders.deliver(state.items, state.members, state.timeZone, Date.now())
          }))
          void pending.catch((error: unknown) => {
            if (!this.isClosed()) this.ctx.logger.warn(error instanceof OfficeError && error.code === 'conflict'
              ? 'Central reminders were not delivered because retained capacity is full. Increase reminder capacity before the next poll.'
              : 'Central reminder delivery could not be saved. Check storage before the next poll; no delivery was published.')
          }).finally(schedule)
        }, configuration.pollIntervalMs)
        timer.unref()
      }
      this.lifetime.signal.addEventListener('abort', stop, { once: true })
      schedule()
      return () => {
        stop()
        this.lifetime.signal.removeEventListener('abort', stop)
      }
    }, 'office.reminderPoll')
  }

  private startChatFileSweep(): void {
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        if (this.isClosed()) return
        void this.enqueue(() => this.chatFiles.sweep()).catch((error: unknown) => {
          if (!this.isClosed()) this.ctx.logger.warn(`Chat-file sweep failed: ${String(error)}`)
        })
      }, this.chatFileSweepMs)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'office.chatFileSweep')
  }

  private startUploadSweep(): void {
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        if (this.isClosed()) return
        void this.enqueue(() => this.uploads.sweep()).catch((error: unknown) => {
          if (!this.isClosed()) this.ctx.logger.warn(`Drive upload sweep failed: ${String(error)}`)
        })
      }, this.uploadSweepMs)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'office.uploadSweep')
  }

  private startPurgeSweep(): void {
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        if (this.isClosed()) return
        void this.enqueue(() => this.driveRepository.sweepPurges()).catch((error: unknown) => {
          if (!this.isClosed()) this.ctx.logger.warn(`Drive permanent cleanup sweep failed: ${String(error)}`)
        })
      }, this.purgeSweepMs)
      timer.unref()
      return () => { clearInterval(timer) }
    }, 'office.purgeSweep')
  }


  /** Return the explicitly enabled collaboration capability without revealing a directory. */
  collaborationCapability(): { readonly protocol: 1 } | null { this.assertOpen(); return this.collaboration ? { protocol: 1 } : null }

  /** @param actorId - Current employee. @returns Current authorized groups. */
  groupList(actorId: OfficeMemberId) : readonly import("./collaboration-types.ts").OfficeGroup[] { this.activeMember(this.domain.global.get(), actorId); return this.requireCollaboration().groups.list(actorId) }
  /** @param actorId - Current owner. @param input - Exact retry request. @returns Committed group. */
  createGroup(actorId: OfficeMemberId, input: Parameters<OfficeGroupsRepository['create']>[1]) : Promise<import("./collaboration-types.ts").OfficeGroup> { return this.requireCollaboration().groups.create(actorId, input) }
  /** @param actorId - Current owner. @param input - Reviewed membership. @returns Updated group. */
  updateGroup(actorId: OfficeMemberId, input: Parameters<OfficeGroupsRepository['update']>[1]) : Promise<import("./collaboration-types.ts").OfficeGroup> { return this.requireCollaboration().groups.update(actorId, input) }
  /** @param actorId - Current member. @param input - Reviewed membership. @returns After committed departure. */
  leaveGroup(actorId: OfficeMemberId, input: Parameters<OfficeGroupsRepository['leave']>[1]) : Promise<void> { return this.requireCollaboration().groups.leave(actorId, input) }
  /** @param actorId - Current member. @param input - Bounded history filters. @returns Authorized page. */
  groupPage(actorId: OfficeMemberId, input: Parameters<OfficeGroupsRepository['page']>[1]) : import("./collaboration-types.ts").OfficeGroupPage { return this.requireCollaboration().groups.page(actorId, input) }
  /** @param actorId - Current sender. @param input - Exact immutable retry. @returns Committed message. */
  sendGroupMessage(actorId: OfficeMemberId, input: Parameters<OfficeGroupsRepository['send']>[1]) : Promise<import("./collaboration-types.ts").OfficeGroupMessage> { return this.requireCollaboration().groups.send(actorId, input) }
  /** @param actorId - Current reader. @param input - Visible sequence. @returns After original receipt durability. */
  readGroup(actorId: OfficeMemberId, input: Parameters<OfficeGroupsRepository['read']>[1]) : Promise<void> { return this.requireCollaboration().groups.read(actorId, input) }
  /** @param actorId - Current reader. @param input - Exact group/message/file reference and byte range. @returns Existing verified immutable bytes. */
  downloadGroupAttachment(actorId: OfficeMemberId, input: CollaborationZod.input<typeof officeGroupSchemas.attachment> & { readonly offset: number; readonly byteLength: number }) : Promise<{
        sha256: string;
        dataBase64: string;
        id: OfficeDriveId;
        versionId: OfficeDriveVersionId;
        offset: number;
        byteLength: number;
    }> {
    const { offset, byteLength, ...coordinate } = input
    const range = officeDriveRangeInput.parse({ id: coordinate.file.fileId, versionId: coordinate.file.versionId, offset, byteLength })
    return this.enqueue(async () => {
      const file = this.requireCollaboration().groups.attachment(actorId, coordinate)
      const { blob } = this.driveRepository.fileVersion(this.scopeMember('files', this.domain.global.get(), actorId), file.fileId, file.versionId)
      const bytes = await this.transferFiles.readRange(blob, range.offset, range.byteLength)
      return { ...range, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }
    })
  }
  /** @param actorId - Current recipient. @returns Device-independent explicit preferences. */
  messagePreferences(actorId: OfficeMemberId) : OfficeMessagePreferences { return this.requireCollaboration().messages.get(actorId) }
  /** @param actorId - Current recipient. @param input - Reviewed preference revision. @returns Committed preferences. */
  saveMessagePreferences(actorId: OfficeMemberId, input: OfficeMessagePreferences) : Promise<OfficeMessagePreferences> { return this.requireCollaboration().messages.save(actorId, input) }
  /** @param actorId - Current recipient. @param input - Bounded filters. @returns Original read-owner projections. */
  unifiedInbox(actorId: OfficeMemberId, input: Parameters<OfficeMessagePreferencesRepository['page']>[1]) : {
        readonly entries: readonly import("./collaboration-types.ts").OfficeUnifiedNotice[];
        readonly unread: number;
        readonly next: {
            readonly time: number;
            readonly key: string;
        } | null;
    } { return this.requireCollaboration().messages.page(actorId, input) }
  /** @param actorId - Current recipient. @param input - Device-bound unread key. @returns Claimed pending receipt or suppression. */
  claimDesktopDelivery(actorId: OfficeMemberId, input: Parameters<OfficeMessagePreferencesRepository['claim']>[1]) : Promise<{
        id: string;
        memberId: OfficeMemberId;
        deviceId: string;
        key: string;
        attempt: number;
        stage: "unknown" | "pending" | "delivered" | "failed";
        claimedAt: number;
        leaseUntil: number;
        preferenceRevision: number;
    } | null> { return this.requireCollaboration().messages.claim(actorId, input) }
  /** @param actorId - Current recipient. @param input - Actual device attempt outcome. @returns Durable attempt or withdrawn access. */
  settleDesktopDelivery(actorId: OfficeMemberId, input: Parameters<OfficeMessagePreferencesRepository['settle']>[1]) : Promise<{
        id: string;
        memberId: OfficeMemberId;
        deviceId: string;
        key: string;
        attempt: number;
        stage: "unknown" | "pending" | "delivered" | "failed";
        claimedAt: number;
        leaseUntil: number;
        preferenceRevision: number;
    } | null> { return this.requireCollaboration().messages.settle(actorId, input) }
  /** @param actorId - Current administrator. @returns Safe current policy and offboarding receipts. */
  identityGovernance(actorId: OfficeMemberId) : {
        revision: number;
        policy: {
            revision: number;
            allowedRoles: {
                office: ("admin" | "manager" | "employee")[];
                files: ("admin" | "manager" | "employee")[];
                connectors: ("admin" | "manager" | "employee")[];
                chat: ("admin" | "manager" | "employee")[];
                sessions: ("admin" | "manager" | "employee")[];
            };
        } | null;
        members: {
            memberId: OfficeMemberId;
            revision: number;
            blocked: boolean;
            revokedScopes: ("chat" | "office" | "files" | "connectors" | "sessions")[];
            requestId: string;
            initiatedBy: OfficeMemberId;
            stage: "blocked" | "revoked" | "restored";
            sessionsRevoked: number;
            invitationsRevoked: number;
            countsScope: "completing_cleanup_attempt";
        }[];
    } { return this.requireCollaboration().governance.view(actorId) }
  /** @param actorId - Current administrator. @param input - Reviewed complete policy. @returns Committed policy. */
  saveCentralPolicy(actorId: OfficeMemberId, input: Parameters<OfficeIdentityGovernanceRepository['savePolicy']>[1]) : Promise<{
        revision: number;
        allowedRoles: {
            office: ("admin" | "manager" | "employee")[];
            files: ("admin" | "manager" | "employee")[];
            connectors: ("admin" | "manager" | "employee")[];
            chat: ("admin" | "manager" | "employee")[];
            sessions: ("admin" | "manager" | "employee")[];
        };
    }> { return this.requireCollaboration().governance.savePolicy(actorId, input) }
  /** @param actorId - Initiating administrator. @param input - Exact offboarding retry. @returns Durable fail-closed receipt. */
  offboardMember(actorId: OfficeMemberId, input: Parameters<OfficeIdentityGovernanceRepository['suspend']>[1]) : Promise<{
        memberId: OfficeMemberId;
        revision: number;
        blocked: boolean;
        revokedScopes: ("chat" | "office" | "files" | "connectors" | "sessions")[];
        requestId: string;
        initiatedBy: OfficeMemberId;
        stage: "blocked" | "revoked" | "restored";
        sessionsRevoked: number;
        invitationsRevoked: number;
        countsScope: "completing_cleanup_attempt";
    }> { return this.requireCollaboration().governance.suspend(actorId, input) }
  /** @param actorId - Current administrator. @param input - Explicit reviewed access restoration. @returns Restored receipt. */
  restoreMemberAccess(actorId: OfficeMemberId, input: Parameters<OfficeIdentityGovernanceRepository['restore']>[1]) : Promise<{
        memberId: OfficeMemberId;
        revision: number;
        blocked: boolean;
        revokedScopes: ("chat" | "office" | "files" | "connectors" | "sessions")[];
        requestId: string;
        initiatedBy: OfficeMemberId;
        stage: "blocked" | "revoked" | "restored";
        sessionsRevoked: number;
        invitationsRevoked: number;
        countsScope: "completing_cleanup_attempt";
    }> { return this.requireCollaboration().governance.restore(actorId, input) }
  /** @param actorId - Current organizer. @param input - Finite recurrence and timezone. @returns Original schedule ids. */
  createMeetingSeries(actorId: OfficeMemberId, input: Parameters<OfficeMeetingSeriesRepository['create']>[1]) : Promise<import("./collaboration-types.ts").OfficeMeetingSeriesReceipt> { return this.requireCollaboration().meetings.create(actorId, input) }
  /** @param input - Trusted durable Session settlement; never a network operation. @returns After idempotent capture. */
  captureUsageSettlement(input: Parameters<OfficeUsageRepository['capture']>[0]) : Promise<void> { return this.requireCollaboration().usage.capture(input) }
  /** @param actorId - Current administrator. @param input - Exact retained-time/member filters. @returns Actual provider counters and missing coverage. */
  usageSummary(actorId: OfficeMemberId, input: Parameters<OfficeUsageRepository['summary']>[1]) : {
        coverage: "captured_settlements";
        settlements: number;
        withUsage: number;
        missingUsage: number;
        attempts: number;
        counters: {
            [k: string]: {
                value: number | null;
                reported: number;
            };
        };
        cost: null;
    } { return this.requireCollaboration().usage.summary(actorId, input) }
  /** @param actorId - Current administrator. @param input - Exact bounded metadata filters. @returns Safe stages and NDJSON. */
  governanceAudit(actorId: OfficeMemberId, input: CollaborationZod.input<typeof officeGovernanceAuditQuery>) : {
        entries: {
            key: string;
            source: string;
            actorId: OfficeMemberId;
            targetId: string;
            action: string;
            time: number;
            decision: "unknown" | "allowed" | "denied" | "reserved" | "dispatched" | "confirmed" | "cancelled";
        }[];
        total: number;
        next: {
            time: number;
            key: string;
        } | null;
        mediaType: "application/x-ndjson";
        content: string;
    } { return this.requireCollaboration().audit(actorId, input) }
  /** @param actorId - Current administrator. @param input - Bounded safe invitation continuation. @returns Metadata-only page. */
  memberInvitePage(actorId: OfficeMemberId, input: { readonly before: { readonly issuedAt: number; readonly id: string } | null; readonly limit: number }) : Promise<{
        entries: OfficeMemberInvite[];
        next: {
            issuedAt: number;
            id: import("./types.ts").OfficeMemberInviteId;
        } | null;
    }> {
    return this.enqueue(async () => this.invitationRepository().page(actorId, input.before, input.limit))
  }
  /** @param actorId - Current recipient. @param key - Current authorized entry key. @returns After the original owner acknowledges it. */
  async readUnifiedNotice(actorId: OfficeMemberId, key: string): Promise<void> {
    const notice = this.requireCollaboration().notices(actorId).find(entry => entry.key === key)
    if (!notice) throw new OfficeError('not_found', 'Notification is unavailable')
    const id = key.slice(key.indexOf(':') + 1)
    switch (notice.source) {
      case 'item': return this.markRead(actorId, brandString<OfficeNotificationId>(id))
      case 'announcement': return this.markAnnouncementRead(actorId, brandString<OfficeAnnouncementId>(id))
      case 'reminder': return this.markReminderRead(actorId, brandString<OfficeReminderId>(id))
      case 'chat': {
        const message = this.chatDomain.global.get().messages.find(entry => entry.id === id)
        if (!message) throw new OfficeError('not_found', 'Message is unavailable')
        return this.readChat(actorId, brandString<OfficeMemberId>(notice.targetId), message.sequence)
      }
      case 'group': case 'mention': {
        const groups = this.requireCollaboration().groups
        return groups.readNotice(actorId, key)
      }
    }
  }
  /** @param method - Already-parsed server operation. @param operation - Original authenticated operation. @returns Original outcome or a safely audited denial. */
  async auditedRpc<T>(method: string, operation: () => Promise<T>): Promise<T> {
    const request = this.requestSession.getStore()
    try { return await operation() }
    catch (error) {
      if (request && request.denial === null && this.collaboration) {
        const audit = this.collaboration.rpcDenials
        await this.requestSession.exit(() => this.enqueue(() => audit.record(request.memberId, method, error)))
      }
      throw error
    }
  }

  /** @returns Configured public provider choices, without subject mappings or credential references. */
  enterpriseSsoProviders() : readonly {
        readonly id: string;
        readonly issuer: string;
    }[] { this.assertOpen(); return this.enterpriseSignIn?.providers() ?? [] }
  /** @param providerId - Configured provider. @returns Private Host flow material; bindingKey never belongs in Client state. */
  beginEnterpriseSso(providerId: string) : {
        providerId: string;
        authorizationUrl: string;
        bindingKey: string;
        expiresAt: number;
    } {
    this.assertOpen()
    if (!this.enterpriseSignIn) throw new OfficeError('forbidden', 'Enterprise sign-in is not enabled')
    return this.enterpriseSignIn.begin(providerId)
  }
  /** @param input - Original bound callback, sent only by the initiating trusted Host. @returns Original identity session receipt. */
  completeEnterpriseSso(input: CollaborationZod.input<typeof officeEnterpriseSsoFinish>) : Promise<OfficeLoginResult> {
    this.assertOpen()
    if (!this.enterpriseSignIn) throw new OfficeError('forbidden', 'Enterprise sign-in is not enabled')
    return this.enterpriseSignIn.complete(input)
  }
  private requireCollaboration(): OfficeCollaborationRuntime {
    this.assertOpen()
    if (!this.collaboration) throw new OfficeError('forbidden', 'Identity and collaboration extensions are not enabled')
    return this.collaboration
  }
  private async commitMeetingOccurrences(actorId: OfficeMemberId, occurrences: readonly OfficeMeetingOccurrence[]): Promise<void> {
    const state = this.domain.global.get()
    this.activeMember(state, actorId)
    const now = Date.now()
    const missing = occurrences.filter(entry => !state.items.some(item => item.id === entry.id))
    if (!missing.length) return
    const items: OfficeItem[] = missing.map(entry => {
      const value = entry.schedule
      const invitees = [...new Set(value.inviteeIds)].filter(id => id !== actorId)
      for (const id of invitees) this.activeMember(state, id)
      return { id: entry.id, kind: 'schedule', title: value.title, description: value.description ?? '', date: value.date,
        time: value.startTime, endTime: value.endTime, location: value.location ?? '', status: 'pending',
        creatorId: actorId, ownerId: actorId, revision: 1, createdAt: now, updatedAt: now,
        participants: [{ memberId: actorId, reply: 'accepted' }, ...invitees.map(memberId => ({ memberId, reply: 'pending' as const }))] }
    })
    const first = items[0]
    if (!first) return
    await this.commit(state, { items: [...state.items, ...items], notifications: [...state.notifications,
      ...items.flatMap(item => item.participants.filter(entry => entry.memberId !== actorId)
        .map(entry => this.notification(actorId, entry.memberId, item.id, 'invited', now)))] }, actorId, 'schedule_created', first.id, now)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isClosed())
      return Promise.reject(
        new OfficeError('closed', 'Office service is closed'),
      )
    const session = this.requestSession.getStore()
    const denial = session?.denial
    const result = this.tail.then(async () => {
      try {
        if (
          session &&
          this.identities.authenticate(session.token).id !== session.memberId
        )
          throw new OfficeError(
            'unauthenticated',
            'The request session is no longer available',
          )
        return await operation()
      } catch (error) {
        if (session && denial) {
          try { await this.requestDenials.record(session.memberId, denial, error) }
          catch (auditError) {
            this.ctx.logger.warn('Office operation remained denied; its denial audit was not confirmed. Check audit storage and capacity before retrying.')
            throw auditError
          }
        }
        throw error
      }
    })
    this.tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
}

export default OfficeService
