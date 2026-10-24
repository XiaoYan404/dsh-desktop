import { officeGroupSchemas } from './group-chat.ts'
import { officeMessageSchemas } from './message-preferences.ts'
import { officeGovernanceSchemas } from './identity-governance.ts'
import { officeMeetingSeriesInput } from './meeting-series.ts'
import { officeUsageQuery, officeGovernanceAuditQuery } from './usage-audit.ts'
/** Explicit office-only network operations; no arbitrary service, file, tool or plugin dispatch. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type OfficeService from './index.ts'
import { officeAutomationCommand } from './automation-request.ts'
import { OfficeError } from './error.ts'
import { officeAuditQuery } from './audit.ts'
import { officeConnectorReadInput } from './connector-actions.ts'
import { officeConnectorSyncSchemas } from './connector-syncs.ts'
import { officeCustomizationSchemas as customizations } from './customizations.ts'
import { officeConversationConnectorInput, officeConversationConnectorReadInput } from './conversation-connectors.ts'
import {
  officeDate,
  officeMember,
  officeMemberId,
  officeProfile,
  officeScheduleInput,
  officeScheduleUpdateInput,
  officeScheduleAvailabilityInput,
  officeTaskDecisionInput,
  officeWorkInput,
  officeWorkUpdateInput,
  officeWorkSubtasksInput,
  officeWorkAttachmentsInput,
  officeWorkLifecycleInput,
  officeTaskDeliveryInput,
} from './spec.ts'
import { officeChatInput } from './chat.ts'
import { officeChatFileCoordinates, officeChatFilesInput } from './chat-files.ts'
import { officeChatDraftInput } from './chat-drafts.ts'
import { officeChatFileDraftInput, officeChatFileDraftCoordinates, officeChatFileDraftSendInput } from './chat-file-drafts.ts'
import { officeDriveRequestSchemas as drive } from './drive.ts'
import { officeOrganizationSchemas as organization } from './organization.ts'
import { officeIntegrationImport } from './integrations.ts'
import { officeConnectorInput, officeConnectorProbeInput } from './connectors.ts'
import { officeConversationLinkSchemas as conversationLinks } from './conversation-links.ts'
import { officeConversationCaptureSchemas as conversationCaptures } from './conversation-captures.ts'
import { officeConversationFileSchemas as conversationFiles } from './conversation-files.ts'
import { officeAgentWorkInput } from './agent-work.ts'
import { officeConnectorWriteInput, officeConnectorExecutionQuery, officeConnectorExecutionId } from './connector-executions.ts'
import { officeAnnouncementId, officeAnnouncementInput } from './announcements.ts'
import { officeReminderId } from './reminders.ts'
import { officeMemberInviteSchemas } from './member-invitations.ts'
import { officePptxReadInput } from './pptx.ts'
import { officeImageReadInput } from './image-authority.ts'
import { officeKnowledgeSchemas } from './knowledge.ts'
import { officeDeliveryCheckInput } from './delivery-check.ts'
import { officeDriveRangeInput, officeDriveUploadChunk, officeDriveUploadDeclaration, officeDriveUploadId } from './drive-uploads.ts'
import type { OfficeItemId, OfficeNotificationId } from './types.ts'

const item = z.uuid().transform(value => brandString<OfficeItemId>(value))
const notification = z
  .uuid()
  .transform(value => brandString<OfficeNotificationId>(value))
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const request = z.discriminatedUnion('method', [
  z.object({ method: z.literal('automation'), args: z.tuple([officeAutomationCommand]) }).strict(),
  z.object({ method: z.literal('memberInvite'), args: z.tuple([officeMemberInviteSchemas.memberId]) }).strict(),
  z.object({ method: z.literal('issueMemberInvite'), args: z.tuple([officeMemberInviteSchemas.issue]) }).strict(),
  z.object({ method: z.literal('revokeMemberInvite'), args: z.tuple([officeMemberInviteSchemas.revoke]) }).strict(),
  z.object({ method: z.literal('groupList'), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal('createGroup'), args: z.tuple([officeGroupSchemas.create]) }).strict(),
  z.object({ method: z.literal('updateGroup'), args: z.tuple([officeGroupSchemas.update]) }).strict(),
  z.object({ method: z.literal('leaveGroup'), args: z.tuple([officeGroupSchemas.leave]) }).strict(),
  z.object({ method: z.literal('groupPage'), args: z.tuple([officeGroupSchemas.page]) }).strict(),
  z.object({ method: z.literal('sendGroupMessage'), args: z.tuple([officeGroupSchemas.send]) }).strict(),
  z.object({ method: z.literal('readGroup'), args: z.tuple([officeGroupSchemas.read]) }).strict(),
  z.object({ method: z.literal('downloadGroupAttachment'), args: z.tuple([officeGroupSchemas.attachment.extend({ offset: officeDriveRangeInput.shape.offset, byteLength: officeDriveRangeInput.shape.byteLength })]) }).strict(),
  z.object({ method: z.literal('messagePreferences'), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal('saveMessagePreferences'), args: z.tuple([officeMessageSchemas.preferences]) }).strict(),
  z.object({ method: z.literal('unifiedInbox'), args: z.tuple([officeMessageSchemas.query]) }).strict(),
  z.object({ method: z.literal('claimDesktopDelivery'), args: z.tuple([officeMessageSchemas.claim]) }).strict(),
  z.object({ method: z.literal('settleDesktopDelivery'), args: z.tuple([officeMessageSchemas.settle]) }).strict(),
  z.object({ method: z.literal('identityGovernance'), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal('saveCentralPolicy'), args: z.tuple([officeGovernanceSchemas.policy]) }).strict(),
  z.object({ method: z.literal('offboardMember'), args: z.tuple([officeGovernanceSchemas.suspend]) }).strict(),
  z.object({ method: z.literal('restoreMemberAccess'), args: z.tuple([officeGovernanceSchemas.restore]) }).strict(),
  z.object({ method: z.literal('createMeetingSeries'), args: z.tuple([officeMeetingSeriesInput]) }).strict(),
  z.object({ method: z.literal('usageSummary'), args: z.tuple([officeUsageQuery]) }).strict(),
  z.object({ method: z.literal('governanceAudit'), args: z.tuple([officeGovernanceAuditQuery]) }).strict(),
  z.object({ method: z.literal('memberInvitePage'), args: z.tuple([z.object({ before: z.object({ issuedAt: z.number().int().nonnegative(), id: z.uuid() }).strict().nullable(), limit: z.number().int().min(1).max(100) }).strict()]) }).strict(),
  z.object({ method: z.literal('readUnifiedNotice'), args: z.tuple([z.string().min(1).max(200)]) }).strict(),
  z.object({ method: z.literal('auditPage'), args: z.tuple([officeAuditQuery]) }).strict(),
  z.object({ method: z.literal('auditExport'), args: z.tuple([officeAuditQuery]) }).strict(),
  z.object({ method: z.literal('chatFileLimits'), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal('chatFileDrafts'), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal('saveChatFileDraft'), args: z.tuple([officeChatFileDraftInput]) }).strict(),
  z.object({ method: z.literal('downloadChatFileDraft'), args: z.tuple([officeChatFileDraftCoordinates]) }).strict(),
  z.object({ method: z.literal('sendChatFileDraft'), args: z.tuple([officeChatFileDraftSendInput]) }).strict(),
  z.object({ method: z.literal('sendMessageFiles'), args: z.tuple([officeChatFilesInput]) }).strict(),
  z.object({ method: z.literal('downloadChatFile'), args: z.tuple([officeChatFileCoordinates]) }).strict(),
  z.object({ method: z.literal('beginDriveUpload'), args: z.tuple([officeDriveUploadDeclaration]) }).strict(),
  z.object({ method: z.literal('driveUploads'), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal('getDriveUpload'), args: z.tuple([officeDriveUploadId]) }).strict(),
  z.object({ method: z.literal('appendDriveUpload'), args: z.tuple([officeDriveUploadChunk]) }).strict(),
  z.object({ method: z.literal('completeDriveUpload'), args: z.tuple([officeDriveUploadId]) }).strict(),
  z.object({ method: z.literal('cancelDriveUpload'), args: z.tuple([officeDriveUploadId]) }).strict(),
  z.object({ method: z.literal('driveFileInfo'), args: z.tuple([drive.id]) }).strict(),
  z.object({ method: z.literal('driveVersionInfo'), args: z.tuple([drive.id, drive.versionId]) }).strict(),
  z.object({ method: z.literal('driveHistory'), args: z.tuple([drive.id]) }).strict(),
  z.object({ method: z.literal('driveTrash'), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal('changeDriveLifecycle'), args: z.tuple([drive.lifecycleInput]) }).strict(),
  z.object({ method: z.literal('drivePurgePlan'), args: z.tuple([drive.id]) }).strict(),
  z.object({ method: z.literal('purgeDrive'), args: z.tuple([drive.purgeInput]) }).strict(),
  z.object({ method: z.literal('drivePurgeStatus'), args: z.tuple([drive.id]) }).strict(),
  z.object({ method: z.literal('retryDrivePurge'), args: z.tuple([drive.id]) }).strict(),
  z.object({ method: z.literal('downloadDriveRange'), args: z.tuple([officeDriveRangeInput]) }).strict(),
  z.object({ method: z.literal('publishAnnouncement'), args: z.tuple([officeAnnouncementInput]) }).strict(),
  z.object({ method: z.literal('markAnnouncementRead'), args: z.tuple([officeAnnouncementId]) }).strict(),
  z.object({ method: z.literal('markReminderRead'), args: z.tuple([officeReminderId]) }).strict(),
  z.object({ method: z.literal('withdrawAnnouncement'), args: z.tuple([officeAnnouncementId, revision]) }).strict(),
  z.object({ method: z.literal('importIntegration'), args: z.tuple([officeIntegrationImport]) }).strict(),
  z.object({ method: z.literal('connections'), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal('customizationRequests'), args: z.tuple([customizations.before]) }).strict(),
  z.object({ method: z.literal('customizationRequest'), args: z.tuple([customizations.id]) }).strict(),
  z.object({ method: z.literal('saveCustomizationRequest'), args: z.tuple([customizations.input]) }).strict(),
  z.object({ method: z.literal('connectorActions'), args: z.tuple([officeConnectorInput.shape.integrationId]) }).strict(),
  z.object({ method: z.literal('connectorExecutions'), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal('connectorExecutionPage'), args: z.tuple([officeConnectorExecutionQuery]) }).strict(),
  z.object({ method: z.literal('connectorExecutionDetail'), args: z.tuple([officeConnectorExecutionId]) }).strict(),
  z.object({ method: z.literal('checkConnectorExecution'), args: z.tuple([officeConnectorExecutionId]) }).strict(),
  z.object({ method: z.literal('writeConnectorAction'), args: z.tuple([officeConnectorWriteInput]) }).strict(),
  z.object({ method: z.literal('readConnectorAction'), args: z.tuple([officeConnectorReadInput]) }).strict(),
  z.object({ method: z.literal('syncConnectorAction'), args: z.tuple([officeConnectorSyncSchemas.input]) }).strict(),
  z.object({ method: z.literal('connectorSyncPage'), args: z.tuple([officeConnectorSyncSchemas.query]) }).strict(),
  z.object({ method: z.literal('connectorSyncDetail'), args: z.tuple([officeConnectorSyncSchemas.id]) }).strict(),
  z.object({ method: z.literal('conversationConnectorActions'), args: z.tuple([officeConversationConnectorInput]) }).strict(),
  z.object({ method: z.literal('readConnectorActionFromConversation'), args: z.tuple([officeConversationConnectorReadInput]) }).strict(),
  z.object({ method: z.literal('conversationLinks'), args: z.tuple([conversationLinks.conversationId]) }).strict(),
  z.object({ method: z.literal('saveConversationLinks'), args: z.tuple([conversationLinks.input]) }).strict(),
  z.object({ method: z.literal('captureConversation'), args: z.tuple([conversationCaptures.input]) }).strict(),
  z.object({ method: z.literal('conversationCapture'), args: z.tuple([conversationCaptures.id]) }).strict(),
  z.object({ method: z.literal('conversationFiles'), args: z.tuple([conversationLinks.conversationId]) }).strict(),
  z.object({ method: z.literal('saveConversationFiles'), args: z.tuple([conversationFiles.input]) }).strict(),
  z.object({ method: z.literal('captureConversationFiles'), args: z.tuple([conversationFiles.prepare]) }).strict(),
  z.object({ method: z.literal('conversationFilesCapture'), args: z.tuple([conversationFiles.captureId]) }).strict(),
  z.object({ method: z.literal('readConversationFile'), args: z.tuple([conversationFiles.read]) }).strict(),
  z.object({ method: z.literal('readConversationPdf'), args: z.tuple([conversationFiles.readPdf]) }).strict(),
  z.object({ method: z.literal('readConversationDocx'), args: z.tuple([conversationFiles.readDocx]) }).strict(),
  z.object({ method: z.literal('readConversationXlsx'), args: z.tuple([conversationFiles.readXlsx]) }).strict(),
  z.object({ method: z.literal('readConversationPptx'), args: z.tuple([officePptxReadInput]) }).strict(),
  z.object({ method: z.literal('readConversationImage'), args: z.tuple([officeImageReadInput]) }).strict(),
  z.object({ method: z.literal('checkConversationDeliverable'), args: z.tuple([officeDeliveryCheckInput]) }).strict(),
  z.object({ method: z.literal('knowledgePublication'), args: z.tuple([officeKnowledgeSchemas.fileId]) }).strict(),
  z.object({ method: z.literal('publishKnowledge'), args: z.tuple([officeKnowledgeSchemas.publish]) }).strict(),
  z.object({ method: z.literal('withdrawKnowledge'), args: z.tuple([officeKnowledgeSchemas.withdraw]) }).strict(),
  z.object({ method: z.literal('searchKnowledge'), args: z.tuple([officeKnowledgeSchemas.search]) }).strict(),
  z.object({ method: z.literal('readKnowledgeCitation'), args: z.tuple([officeKnowledgeSchemas.citation]) }).strict(),
  z.object({ method: z.literal('createWorkFromConversation'), args: z.tuple([officeAgentWorkInput]) }).strict(),
  z.object({ method: z.literal('saveConnection'), args: z.tuple([officeConnectorInput]) }).strict(),
  z.object({ method: z.literal('probeConnection'), args: z.tuple([officeConnectorProbeInput.shape.integrationId,
    officeConnectorProbeInput.shape.revision]) }).strict(),
  z.object({ method: z.literal('organization'), args: z.tuple([]) }).strict(),
  z
    .object({
      method: z.literal('initializeOrganization'),
      args: z.tuple([
        z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      ]),
    })
    .strict(),
  z
    .object({
      method: z.literal('saveOrganizationUnit'),
      args: z.tuple([organization.unitInput]),
    })
    .strict(),
  z
    .object({
      method: z.literal('savePosition'),
      args: z.tuple([organization.positionInput]),
    })
    .strict(),
  z
    .object({
      method: z.literal('assignOrganization'),
      args: z.tuple([organization.assignmentInput]),
    })
    .strict(),
  z
    .object({
      method: z.literal('view'),
      args: z.tuple([officeDate.nullable()]),
    })
    .strict(),
  z
    .object({
      method: z.literal('createWork'),
      args: z.tuple([officeWorkInput]),
    })
    .strict(),
  z
    .object({
      method: z.literal('createSchedule'),
      args: z.tuple([officeScheduleInput]),
    })
    .strict(),
  z.object({ method: z.literal('updateSchedule'), args: z.tuple([item, revision, officeScheduleUpdateInput]) }).strict(),
  z.object({ method: z.literal('scheduleAvailability'), args: z.tuple([officeScheduleAvailabilityInput]) }).strict(),
  z.object({ method: z.literal('decideTask'), args: z.tuple([item, revision, officeTaskDecisionInput]) }).strict(),
  z.object({ method: z.literal('updateWork'), args: z.tuple([item, revision, officeWorkUpdateInput]) }).strict(),
  z.object({ method: z.literal('updateWorkSubtasks'), args: z.tuple([item, revision, officeWorkSubtasksInput]) }).strict(),
  z.object({ method: z.literal('updateWorkAttachments'), args: z.tuple([item, revision, officeWorkAttachmentsInput]) }).strict(),
  z.object({ method: z.literal('changeWorkLifecycle'), args: z.tuple([item, revision, officeWorkLifecycleInput]) }).strict(),
  z.object({ method: z.literal('workAttachments'), args: z.tuple([item]) }).strict(),
  z.object({ method: z.literal('workAttachmentInfo'), args: z.tuple([item, drive.id]) }).strict(),
  z.object({ method: z.literal('reviewTaskDelivery'), args: z.tuple([item, revision, officeTaskDeliveryInput]) }).strict(),
  z
    .object({
      method: z.literal('setStatus'),
      args: z.tuple([
        item,
        revision,
        z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
      ]),
    })
    .strict(),
  z
    .object({
      method: z.literal('reply'),
      args: z.tuple([item, revision, z.enum(['accepted', 'declined'])]),
    })
    .strict(),
  z
    .object({ method: z.literal('markRead'), args: z.tuple([notification]) })
    .strict(),
  z
    .object({
      method: z.literal('updateProfile'),
      args: z.tuple([officeProfile]),
    })
    .strict(),
  z
    .object({
      method: z.literal('saveMember'),
      args: z.tuple([officeMember.strict(), officeMember.strict().nullable()]),
    })
    .strict(),
  z
    .object({
      method: z.literal('chat'),
      args: z.tuple([officeMemberId.nullable(), cursor.nullable()]),
    })
    .strict(),
  z
    .object({
      method: z.literal('sendMessage'),
      args: z.tuple([officeChatInput]),
    })
    .strict(),
  z
    .object({
      method: z.literal('readChat'),
      args: z.tuple([officeMemberId, cursor]),
    })
    .strict(),
  z.object({ method: z.literal('chatDrafts'), args: z.tuple([]) }).strict(),
  z
    .object({
      method: z.literal('saveChatDraft'),
      args: z.tuple([officeChatDraftInput]),
    })
    .strict(),
  z
    .object({ method: z.literal('drive'), args: z.tuple([drive.query]) })
    .strict(),
  z
    .object({
      method: z.literal('createDriveFolder'),
      args: z.tuple([drive.folderInput]),
    })
    .strict(),
  z
    .object({
      method: z.literal('renameDriveEntry'),
      args: z.tuple([drive.renameInput]),
    })
    .strict(),
  z
    .object({
      method: z.literal('saveDrivePermissions'),
      args: z.tuple([drive.permissionsInput]),
    })
    .strict(),
  z
    .object({
      method: z.literal('uploadDriveFile'),
      args: z.tuple([drive.uploadInput]),
    })
    .strict(),
  z
    .object({
      method: z.literal('downloadDriveFile'),
      args: z.tuple([drive.id]),
    })
    .strict(),
  z
    .object({ method: z.literal('identityOverview'), args: z.tuple([]) })
    .strict(),
  z
    .object({
      method: z.literal('setIdentityPassword'),
      args: z.tuple([officeMemberId, z.string().min(15).max(1024)]),
    })
    .strict(),
])

/**
 * Admit only documented office requests and bind their actor to a current durable session.
 * @param office - Central office owner, without native Agent capability dispatch.
 * @param token - Actual authenticated transport token.
 * @param input - Version 1 method/argument envelope; extra fields and malformed tuples are rejected.
 * @param signal - Optional disconnected transport cancellation for isolated PDF parsing.
 * @returns The authorized operation result; write execution rechecks the session after queueing.
 */
export async function executeOfficeRequest(
  office: OfficeService,
  token: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  // Authenticate before exposing input-validation details to an unauthenticated caller.
  return office.withSession(token, async (actor, auditDenial) => {
    const parsed = request.safeParse(input)
    if (!parsed.success)
      throw new OfficeError(
        'invalid_input',
        'Unsupported office operation or invalid arguments',
      )
    const call = parsed.data
    switch (call.method) {
      case 'saveMember': auditDenial({ action: call.method, targetId: call.args[0].id }); break
      case 'setStatus': case 'reply': auditDenial({ action: call.method, targetId: call.args[0] }); break
      case 'saveDrivePermissions': auditDenial({ action: call.method, targetId: call.args[0].id }); break
      default: break
    }
    return office.auditedRpc(call.method, async () => {
    switch (call.method) {
      case 'groupList': return office.groupList(actor)
      case 'createGroup': return office.createGroup(actor, call.args[0])
      case 'updateGroup': return office.updateGroup(actor, call.args[0])
      case 'leaveGroup': return office.leaveGroup(actor, call.args[0])
      case 'groupPage': return office.groupPage(actor, call.args[0])
      case 'sendGroupMessage': return office.sendGroupMessage(actor, call.args[0])
      case 'readGroup': return office.readGroup(actor, call.args[0])
      case 'downloadGroupAttachment': return office.downloadGroupAttachment(actor, call.args[0])
      case 'messagePreferences': return office.messagePreferences(actor)
      case 'saveMessagePreferences': return office.saveMessagePreferences(actor, call.args[0])
      case 'unifiedInbox': return office.unifiedInbox(actor, call.args[0])
      case 'claimDesktopDelivery': return office.claimDesktopDelivery(actor, call.args[0])
      case 'settleDesktopDelivery': return office.settleDesktopDelivery(actor, call.args[0])
      case 'identityGovernance': return office.identityGovernance(actor)
      case 'saveCentralPolicy': return office.saveCentralPolicy(actor, call.args[0])
      case 'offboardMember': return office.offboardMember(actor, call.args[0])
      case 'restoreMemberAccess': return office.restoreMemberAccess(actor, call.args[0])
      case 'createMeetingSeries': return office.createMeetingSeries(actor, call.args[0])
      case 'usageSummary': return office.usageSummary(actor, call.args[0])
      case 'governanceAudit': return office.governanceAudit(actor, call.args[0])
      case 'memberInvitePage': return office.memberInvitePage(actor, call.args[0])
      case 'readUnifiedNotice': return office.readUnifiedNotice(actor, call.args[0])
      case 'auditPage': return office.auditPage(actor, call.args[0])
      case 'memberInvite': return office.memberInvite(actor, call.args[0])
      case 'issueMemberInvite': return office.issueMemberInvite(actor, call.args[0])
      case 'revokeMemberInvite': return office.revokeMemberInvite(actor, call.args[0])
      case 'auditExport': return office.auditExport(actor, call.args[0])
      case 'publishAnnouncement': return office.publishAnnouncement(actor, call.args[0])
      case 'markAnnouncementRead': await office.markAnnouncementRead(actor, call.args[0]); return null
      case 'markReminderRead': await office.markReminderRead(actor, call.args[0]); return null
      case 'withdrawAnnouncement': await office.withdrawAnnouncement(actor, ...call.args); return null
      case 'importIntegration':
        return office.importIntegration(actor, call.args[0])
      case 'automation': return office.automation(actor, call.args[0])
      case 'connections': return office.connections(actor)
      case 'customizationRequests': return office.customizationRequests(actor, call.args[0])
      case 'customizationRequest': return office.customizationRequest(actor, call.args[0])
      case 'saveCustomizationRequest': return office.saveCustomizationRequest(actor, call.args[0])
      case 'connectorActions': return office.connectorActions(actor, call.args[0])
      case 'connectorExecutions': return office.connectorExecutions(actor)
      case 'connectorExecutionPage': return office.connectorExecutionPage(actor, call.args[0])
      case 'connectorExecutionDetail': return office.connectorExecutionDetail(actor, call.args[0])
      case 'checkConnectorExecution': return office.checkConnectorExecution(actor, call.args[0])
      case 'writeConnectorAction': return office.writeConnectorAction(actor, call.args[0])
      case 'readConnectorAction': return office.readConnectorAction(actor, call.args[0])
      case 'syncConnectorAction': return office.syncConnectorAction(actor, call.args[0])
      case 'connectorSyncPage': return office.connectorSyncPage(actor, call.args[0])
      case 'connectorSyncDetail': return office.connectorSyncDetail(actor, call.args[0])
      case 'conversationConnectorActions': return office.conversationConnectorActions(actor, call.args[0])
      case 'readConnectorActionFromConversation': return office.readConnectorActionFromConversation(actor, call.args[0])
      case 'conversationLinks': return office.conversationLinks(actor, call.args[0])
      case 'saveConversationLinks': return office.saveConversationLinks(actor, call.args[0])
      case 'captureConversation': return office.captureConversation(actor, call.args[0])
      case 'conversationCapture': return office.conversationCapture(actor, call.args[0])
      case 'conversationFiles': return office.conversationFiles(actor, call.args[0])
      case 'saveConversationFiles': return office.saveConversationFiles(actor, call.args[0])
      case 'captureConversationFiles': return office.captureConversationFiles(actor, call.args[0])
      case 'conversationFilesCapture': return office.conversationFilesCapture(actor, call.args[0])
      case 'readConversationFile': return office.readConversationFile(actor, call.args[0])
      case 'readConversationPdf': return office.readConversationPdf(actor, call.args[0], signal)
      case 'readConversationDocx': return office.readConversationDocx(actor, call.args[0], signal)
      case 'readConversationXlsx': return office.readConversationXlsx(actor, call.args[0], signal)
      case 'readConversationPptx': return office.readConversationPptx(actor, call.args[0], signal)
      case 'readConversationImage': return office.readConversationImage(actor, call.args[0], signal)
      case 'checkConversationDeliverable': return office.checkConversationDeliverable(actor, call.args[0], signal)
      case 'knowledgePublication': return office.knowledgePublication(actor, call.args[0])
      case 'publishKnowledge': return office.publishKnowledge(actor, call.args[0], signal)
      case 'withdrawKnowledge': return office.withdrawKnowledge(actor, call.args[0], signal)
      case 'searchKnowledge': return office.searchKnowledge(actor, call.args[0])
      case 'readKnowledgeCitation': return office.readKnowledgeCitation(actor, call.args[0])
      case 'saveConnection': return office.saveConnection(actor, call.args[0])
      case 'probeConnection': return office.probeConnection(actor, ...call.args)
      case 'organization':
        return office.organization(actor)
      case 'initializeOrganization':
        return office.initializeOrganization(actor, call.args[0])
      case 'saveOrganizationUnit':
        return office.saveOrganizationUnit(actor, call.args[0])
      case 'savePosition':
        return office.savePosition(actor, call.args[0])
      case 'assignOrganization':
        return office.assignOrganization(actor, call.args[0])
      case 'view':
        return office.view(actor, call.args[0] ?? undefined)
      case 'createWork':
        return office.createWork(actor, call.args[0])
      case 'createWorkFromConversation': return office.createWorkFromConversation(actor, call.args[0])
      case 'createSchedule':
        return office.createSchedule(actor, call.args[0])
      case 'updateSchedule':
        return office.updateSchedule(actor, ...call.args)
      case 'scheduleAvailability': return office.scheduleAvailability(actor, call.args[0])
      case 'decideTask':
        return office.decideTask(actor, ...call.args)
      case 'updateWork':
        return office.updateWork(actor, ...call.args)
      case 'updateWorkSubtasks': return office.updateWorkSubtasks(actor, ...call.args)
      case 'updateWorkAttachments': return office.updateWorkAttachments(actor, ...call.args)
      case 'changeWorkLifecycle': return office.changeWorkLifecycle(actor, ...call.args)
      case 'workAttachments': return office.workAttachments(actor, ...call.args)
      case 'workAttachmentInfo': return office.workAttachmentInfo(actor, ...call.args)
      case 'reviewTaskDelivery': return office.reviewTaskDelivery(actor, ...call.args)
      case 'setStatus':
        return office.setStatus(actor, ...call.args)
      case 'reply':
        return office.reply(actor, ...call.args)
      case 'markRead':
        await office.markRead(actor, call.args[0])
        return null
      case 'updateProfile':
        return office.updateProfile(actor, call.args[0])
      case 'saveMember':
        return office.saveMember(actor, ...call.args)
      case 'chat':
        return office.chat(
          actor,
          call.args[0] ?? undefined,
          call.args[1] ?? undefined,
        )
      case 'sendMessage':
        return office.sendMessage(actor, call.args[0])
      case 'readChat':
        await office.readChat(actor, ...call.args)
        return null
      case 'chatDrafts':
        return office.chatDrafts(actor)
      case 'chatFileLimits':
        return office.chatFileLimitsFor(actor)
      case 'chatFileDrafts':
        return office.chatFileDrafts(actor)
      case 'saveChatFileDraft':
        return office.saveChatFileDraft(actor, call.args[0])
      case 'downloadChatFileDraft':
        return office.downloadChatFileDraft(actor, call.args[0])
      case 'sendChatFileDraft':
        return office.sendChatFileDraft(actor, call.args[0])
      case 'sendMessageFiles':
        return office.sendMessageFiles(actor, call.args[0])
      case 'downloadChatFile':
        return office.downloadChatFile(actor, call.args[0])
      case 'saveChatDraft':
        return office.saveChatDraft(actor, call.args[0])
      case 'drive':
        return office.drive(actor, call.args[0])
      case 'createDriveFolder':
        return office.createDriveFolder(actor, call.args[0])
      case 'renameDriveEntry':
        return office.renameDriveEntry(actor, call.args[0])
      case 'saveDrivePermissions':
        return office.saveDrivePermissions(actor, call.args[0])
      case 'uploadDriveFile':
        return office.uploadDriveFile(actor, call.args[0])
      case 'downloadDriveFile':
        return office.downloadDriveFile(actor, call.args[0])
      case 'beginDriveUpload':
        return office.beginDriveUpload(actor, call.args[0])
      case 'driveUploads':
        return office.driveUploads(actor)
      case 'getDriveUpload':
        return office.getDriveUpload(actor, call.args[0])
      case 'appendDriveUpload':
        return office.appendDriveUpload(actor, call.args[0])
      case 'completeDriveUpload':
        return office.completeDriveUpload(actor, call.args[0])
      case 'cancelDriveUpload':
        return office.cancelDriveUpload(actor, call.args[0])
      case 'driveFileInfo':
        return office.driveFileInfo(actor, call.args[0])
      case 'driveVersionInfo': return office.driveVersionInfo(actor, ...call.args)
      case 'driveHistory': return office.driveHistory(actor, call.args[0])
      case 'driveTrash': return office.driveTrash(actor)
      case 'changeDriveLifecycle': return office.changeDriveLifecycle(actor, call.args[0])
      case 'drivePurgePlan': return office.drivePurgePlan(actor, call.args[0])
      case 'purgeDrive': return office.purgeDrive(actor, call.args[0])
      case 'drivePurgeStatus': return office.drivePurgeStatus(actor, call.args[0])
      case 'retryDrivePurge': return office.retryDrivePurge(actor, call.args[0])
      case 'downloadDriveRange':
        return office.downloadDriveRange(actor, call.args[0])
      case 'identityOverview':
        return office.identityOverview(actor)
      case 'setIdentityPassword':
        await office.setIdentityPassword(actor, ...call.args)
        return null
    }
    })
  })
}
