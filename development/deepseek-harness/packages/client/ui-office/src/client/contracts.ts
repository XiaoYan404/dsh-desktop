import type { OfficeUnifiedNotice } from '@deepseek-ai/dsh-enterprise-office/src/collaboration-types.ts'
import type { OfficeKnowledgeModel } from './knowledge-model.ts'
import type { OfficeKnowledgeCitation } from '@deepseek-ai/dsh-enterprise-office/types'
/** Props derive their hook face from the registration's private observables. */
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
  PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { OfficeMemberInvitesModel } from './member-invites-model.ts'
import type {
  OfficeItem,
  OfficeIntegrationImportInput,
  OfficeConnectorInput,
  OfficeConnectorView,
  OfficeConnectorSyncId,
  OfficeIntegrationId,
  OfficeItemStatus,
  OfficeMember,
  OfficeMemberId,
  OfficeNotificationId,
  OfficeReminderId,
  OfficeProfile,
  OfficeScheduleInput,
  OfficeScheduleUpdateInput,
  OfficeScheduleAvailabilityInput,
  OfficeScheduleAvailability,
  OfficeTaskDecisionInput,
  OfficeWorkInput,
  OfficeWorkUpdateInput,
  OfficeWorkSubtasksInput,
  OfficeTaskDeliveryInput,
  OfficeWorkAttachmentsInput,
  OfficeWorkAttachmentsView,
  OfficeWorkLifecycleInput,
  OfficeUnitInput,
  OfficePositionInput,
  OfficeAssignmentInput,
  OfficeAnnouncementId,
  OfficeAnnouncementInput,
  OfficeChatAttachment,
  OfficeChatFileCoordinates,
  OfficeConversationId,
  OfficeConversationLinksInput,
  OfficeCustomizationFields,
  OfficeCustomizationId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeModel } from './model.ts'
import type { OfficeExperienceClient } from './experience/model.ts'
import type { OfficeSearchModel } from './search-model.ts'
import type { OfficeChatModel } from './chat-model.ts'
import type { OfficeChatFilesModel } from './chat-files-model.ts'
import type { OfficeFileDraftModel } from './file-draft-model.ts'
import type { OfficeConnectorsModel, ConnectorSaveOutcome } from './connectors-model.ts'
import type { OfficeExecutionsModel } from './executions-model.ts'
import type { OfficeAuditFilters, OfficeAuditModel } from './audit-model.ts'
import type { OfficeConnectorSyncModel } from './connector-sync-model.ts'
import type { OfficeIntegrationPluginsModel } from './integration-plugins-model.ts'
import type { OfficeCustomizationsModel } from './customizations-model.ts'
import type { OfficeSubmissionsModel } from './submissions-model.ts'
import type { OfficeConnectorExecutionId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeToolsModel, OfficeToolRequest } from './tools-model.ts'
import type { createOfficeViewStore } from './store.ts'
import type { OfficeChatDraftModel } from './draft-model.ts'
import type { OfficeDriveModel } from './drive-model.ts'
import type { OfficeDriveLifecycleModel } from './drive-lifecycle-model.ts'
import type { OfficeDriveTransfers } from './drive-transfers.ts'
import type { OfficeDrivePreviewModel } from './drive-preview-model.ts'
import type { OfficeFileAssociationsModel } from './file-associations-model.ts'
import type { OfficeConnectionModel } from './connection-model.ts'
import type { OfficeHomeInputModel } from './home-input-model.ts'
import type { OfficeAssistanceModel } from './assistance-model.ts'
import type { OfficeConversationModel } from './conversation-model.ts'
import type { OfficeNavigationModel } from './navigation-model.ts'
import type { OfficeAssociationsModel, AssociationSaveOutcome } from './associations-model.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  OfficeLoginInput,
  OfficePasswordChangeInput,
  OfficeSessionId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type {
  OfficeDriveFolderInput,
  OfficeDriveId,
  OfficeDriveDownloadInfo,
  OfficeDriveLocation,
  OfficeDrivePermissionsInput,
  OfficeDriveRenameInput,
  OfficeDriveUploadInput,
  OfficeDriveUploadId,
} from '@deepseek-ai/dsh-enterprise-office/types'

/** Independently selectable office panels; native AI and Settings retain their owners. */
export type { OfficeSection } from './navigation-model.ts'
import type { OfficeSection } from './navigation-model.ts'
/** Private registration face; components consume hooks and callbacks rather than services. */
export interface OfficeInjected {
  readonly hooks: {
    readonly office: OfficeModel['state']
    readonly search: OfficeSearchModel['state']
    readonly navigation: OfficeNavigationModel['state']
    readonly conversations: OfficeConversationModel['state']
    readonly notice: OfficeModel['notice']
    readonly chat: OfficeChatModel['state']
    readonly chatFiles: OfficeChatFilesModel['state']
    readonly fileDrafts: OfficeFileDraftModel['state']
    readonly connectors: OfficeConnectorsModel['state']
    readonly executions: OfficeExecutionsModel['state']
    readonly connectorSync: OfficeConnectorSyncModel['state']
    readonly integrationPlugins: OfficeIntegrationPluginsModel['state']
    readonly customizations: OfficeCustomizationsModel['state']
    readonly submissions: OfficeSubmissionsModel['state']
    readonly tools: OfficeToolsModel['state']
    readonly chatDrafts: OfficeChatDraftModel['state']
    readonly chatDraftStatus: OfficeChatDraftModel['status']
    readonly drive: OfficeDriveModel['state']
    readonly knowledge: OfficeKnowledgeModel['state']
    readonly driveLifecycle: OfficeDriveLifecycleModel['state']
    readonly driveTransfers: OfficeDriveTransfers['state']
    readonly drivePreview: OfficeDrivePreviewModel['state']
    readonly fileAssociations: OfficeFileAssociationsModel['state']
    readonly connection: OfficeConnectionModel['state']
    readonly homeInput: OfficeHomeInputModel['state']
    readonly assistance: OfficeAssistanceModel['state']
    readonly experience: OfficeExperienceClient['state']
  }
  readonly section: OfficeSection
  searchKnowledge(this: void, query: string): Promise<void>
  openKnowledgeCitation(this: void, citation: OfficeKnowledgeCitation): Promise<void>
  reviewKnowledgeFile(this: void, id: OfficeDriveId): Promise<void>
  saveKnowledge(this: void, kind: 'publish' | 'withdraw'): Promise<void>
  closeKnowledgeReview(this: void): void
  openSearch(this: void): void
  consumeSearchTarget(this: void, key: string): void
  navigate(this: void, section: OfficeSection | 'ai' | 'settings'): void
  /** Omission refreshes the selected day; null returns to company Today. */
  load(this: void, date?: string | null): void
  createWork(this: void, input: OfficeWorkInput): Promise<boolean>
  updateWork(this: void, item: OfficeItem, input: OfficeWorkUpdateInput): Promise<boolean>
  updateWorkSubtasks(this: void, item: OfficeItem, input: OfficeWorkSubtasksInput): Promise<boolean>
  reviewTaskDelivery(this: void, item: OfficeItem, input: OfficeTaskDeliveryInput): Promise<boolean>
  updateWorkAttachments(this: void, item: OfficeItem, input: OfficeWorkAttachmentsInput): Promise<boolean>
  changeWorkLifecycle(this: void, item: OfficeItem, input: OfficeWorkLifecycleInput): Promise<boolean>
  loadWorkAttachments(this: void, id: OfficeItem['id']): Promise<OfficeWorkAttachmentsView | null>
  resolveWorkAttachmentFile(this: void, id: OfficeDriveId): Promise<OfficeDriveDownloadInfo | null>
  browseAttachmentFiles(this: void, location: OfficeDriveLocation): void
  downloadWorkAttachment(this: void, item: OfficeItem, id: OfficeDriveId): Promise<void>
  createSchedule(this: void, input: OfficeScheduleInput): Promise<boolean>
  updateSchedule(this: void, item: OfficeItem, input: OfficeScheduleUpdateInput): Promise<boolean>
  checkScheduleAvailability(this: void, input: OfficeScheduleAvailabilityInput): Promise<OfficeScheduleAvailability | null>
  decideTask(this: void, item: OfficeItem, input: OfficeTaskDecisionInput): Promise<boolean>
  startHome(this: void, prompt: string, submit: boolean): Promise<boolean>
  addHomeFiles(this: void, files: readonly File[]): void
  removeHomeFile(this: void, id: string): void
  cancelHome(this: void): void
  assistItem(this: void, item: OfficeItem): Promise<boolean>
  cancelAssistance(this: void): void
  importIntegration(this: void, input: OfficeIntegrationImportInput): Promise<boolean>
  loadConnections(this: void): Promise<OfficeConnectorView | null>
  loadConnectorActions(this: void, id: OfficeIntegrationId): Promise<void>
  readConnectorAction(this: void, actionId: string): Promise<void>
  loadIntegrationPlugins(this: void): Promise<void>
  manageIntegrationPlugin(this: void, adapterId: string): void
  openCustomization(this: void, target?: string): void
  openCustomizationRequests(this: void): Promise<void>
  editCustomization(this: void, id: OfficeCustomizationId): Promise<void>
  fieldCustomization(this: void, key: keyof OfficeCustomizationFields, value: string): void
  saveCustomization(this: void): Promise<void>
  moreCustomizations(this: void): Promise<void>
  exportCustomization(this: void): Promise<void>
  closeCustomization(this: void): void
  beginConnectorSync(this: void, actionId: string): void
  submitConnectorSync(this: void): Promise<void>
  openConnectorSyncHistory(this: void, id: OfficeIntegrationId): Promise<void>
  moreConnectorSyncHistory(this: void): Promise<void>
  openConnectorSyncDetail(this: void, id: OfficeConnectorSyncId): Promise<void>
  backConnectorSyncHistory(this: void): void
  closeConnectorSync(this: void): void
  openExecutionRecords(this: void, id: OfficeIntegrationId): Promise<void>
  loadMoreExecutions(this: void): Promise<void>
  openExecutionDetail(this: void, id: OfficeConnectorExecutionId): Promise<void>
  closeExecutionRecords(this: void): void
  closeExecutionDetail(this: void): void
  checkExecutionOutcome(this: void): Promise<void>
  beginConnectorSubmission(this: void, actionId: string): void
  updateSubmissionField(this: void, name: string, value: string): void
  reviewSubmission(this: void): void
  editSubmission(this: void): void
  submitConnectorAction(this: void): Promise<void>
  closeSubmission(this: void): void
  saveConnection(this: void, input: OfficeConnectorInput): Promise<ConnectorSaveOutcome>
  probeConnection(this: void, id: OfficeIntegrationId, revision: number): Promise<void>
  loadTools(this: void): void
  useTool(this: void, request: OfficeToolRequest): Promise<boolean>
  cancelTool(this: void): void
  setStatus(
    this: void,
    item: OfficeItem,
    status: OfficeItemStatus,
  ): Promise<boolean>
  reply(
    this: void,
    item: OfficeItem,
    reply: 'accepted' | 'declined',
  ): Promise<boolean>
  markRead(this: void, id: OfficeNotificationId): Promise<boolean>
  markReminderRead(this: void, id: OfficeReminderId): Promise<boolean>
  publishAnnouncement(this: void, input: OfficeAnnouncementInput): Promise<boolean>
  markAnnouncementRead(this: void, id: OfficeAnnouncementId): Promise<boolean>
  withdrawAnnouncement(this: void, id: OfficeAnnouncementId, revision: number): Promise<boolean>
  updateProfile(this: void, profile: OfficeProfile): Promise<boolean>
  openAudit(this: void): Promise<void>
  openCollaboration(this: void, navigate?: (notice: OfficeUnifiedNotice) => void): void
  saveMember(
    this: void,
    member: OfficeMember,
    expected: OfficeMember | null,
  ): Promise<boolean>
  initializeOrganization(this: void, revision: number): Promise<boolean>
  saveOrganizationUnit(this: void, input: OfficeUnitInput): Promise<boolean>
  savePosition(this: void, input: OfficePositionInput): Promise<boolean>
  assignOrganization(
    this: void,
    input: OfficeAssignmentInput,
  ): Promise<boolean>
  loadChat(this: void, peer?: OfficeMemberId): void
  olderChat(this: void): Promise<void>
  sendChat(this: void, peer: OfficeMemberId, text: string): Promise<boolean>
  addChatFiles(this: void, peer: OfficeMemberId, files: readonly File[]): void
  removeChatFile(this: void, peer: OfficeMemberId, id: string): void
  loadChatFileLimits(this: void): void
  loadChatFileDrafts(this: void): void
  retryChatFileDraft(this: void, peer: OfficeMemberId): Promise<boolean>
  resolveChatFileDraft(this: void, peer: OfficeMemberId, keepLocal: boolean): Promise<void>
  clearChatFileDraft(this: void, peer: OfficeMemberId): Promise<boolean>
  retryChatFileSend(this: void, peer: OfficeMemberId): Promise<void>
  downloadChatFile(this: void, coordinates: OfficeChatFileCoordinates, expected: OfficeChatAttachment): Promise<void>
  readChat(this: void, peer: OfficeMemberId, through: number): Promise<void>
  setChatDraft(this: void, peer: OfficeMemberId, text: string): void
  clearChatDraft(this: void, peer: OfficeMemberId, expected: string, principal: OfficeMemberId): void
  retryChatDraft(this: void, peer: OfficeMemberId): Promise<void>
  resolveChatDraft(
    this: void,
    peer: OfficeMemberId,
    keepLocal: boolean,
  ): Promise<void>
  loadChatDrafts(this: void): void
  loadDrive(this: void): void
  useDriveFile(this: void, id: OfficeDriveId): Promise<boolean>
  cancelFilePreparation(this: void): void
  returnToFileConversation(this: void): void
  retryFileAssociations(this: void): Promise<boolean>
  navigateDrive(this: void, location: OfficeDriveLocation): void
  stepDrive(this: void, direction: -1 | 1): void
  searchDrive(this: void, search: string): void
  createDriveFolder(
    this: void,
    input: OfficeDriveFolderInput,
  ): Promise<boolean>
  renameDriveEntry(this: void, input: OfficeDriveRenameInput): Promise<boolean>
  saveDrivePermissions(
    this: void,
    input: OfficeDrivePermissionsInput,
  ): Promise<boolean>
  uploadDriveFile(this: void, input: OfficeDriveUploadInput): Promise<boolean>
  startDriveUpload(this: void, file: File, location: OfficeDriveLocation, ticketId?: OfficeDriveUploadId): boolean
  openDriveHistory(this: void, id: OfficeDriveId): void
  openDriveTrash(this: void): void
  closeDriveLifecycle(this: void): void
  refreshDriveLifecycle(this: void): void
  reviewDriveHistory(this: void): Promise<import('@deepseek-ai/dsh-enterprise-office/types').OfficeDriveEntry | null>
  changeDriveLifecycle(this: void, input: import('@deepseek-ai/dsh-enterprise-office/types').OfficeDriveLifecycleInput): Promise<boolean>
  openDrivePurge(this: void, id: OfficeDriveId): void
  closeDrivePurge(this: void): void
  reviewDrivePurge(this: void): void
  confirmDrivePurge(this: void, retry?: boolean): void
  startDriveVersionUpload(this: void, file: File, entry: import('@deepseek-ai/dsh-enterprise-office/types').OfficeDriveEntry): boolean
  downloadDriveVersion(this: void, id: OfficeDriveId,
    versionId: import('@deepseek-ai/dsh-enterprise-office/types').OfficeDriveVersionId): Promise<void>
  retryDriveUpload(this: void): void
  reselectDriveUpload(this: void, file: File): void
  cancelDriveUpload(this: void): void
  cancelPendingDriveUpload(this: void, id: OfficeDriveUploadId): void
  dismissDriveUpload(this: void): void
  refreshDriveUploads(this: void): void
  cancelDriveDownload(this: void): void
  retryDriveDownload(this: void): void
  dismissDriveDownload(this: void): void
  downloadDriveFile(this: void, id: OfficeDriveId): Promise<void>
  previewDriveFile(this: void, id: OfficeDriveId): void
  closeDrivePreview(this: void): void
  retryDrivePreview(this: void): void
  startChat(this: void, prompt: string, send: boolean): void
  openNative(this: void): void
  openPlugins(this: void): void
  openAutomations?(this: void): void
  readonly automationTitle?: string
  dismissNotice(this: void): void
  signIn(this: void, input: OfficeLoginInput): Promise<boolean>
  signOut(this: void): Promise<boolean>
  changePassword(
    this: void,
    input: OfficePasswordChangeInput,
  ): Promise<boolean>
  loadSessions(this: void): void
  revokeSession(this: void, id: OfficeSessionId): Promise<boolean>
  loadEnrollment(this: void): void
  enrollMember(
    this: void,
    id: OfficeMemberId,
    password: string,
  ): Promise<boolean>
  /** Open the optional onboarding surface; null selects public first-password activation. */
  openMemberInvites?(this: void, memberId: OfficeMemberId | null): void
}
/** Main-panel state and behavior supplied by slot registration. */
export type OfficeProps = PropsRuntime<'main'> &
  PropsLocale<'office'> &
  InjectFace<OfficeInjected> &
  PropsStore<ReturnType<typeof createOfficeViewStore>>

/** Global popup is owned by the layout overlay; no page store is shared with its input draft. */
export interface OfficeSearchInjected {
  readonly hooks: { readonly search: OfficeSearchModel['state'] }
  closeSearch(this: void): void
  querySearch(this: void, query: string): void
  selectSearch(this: void, key: string): void
}
/** Framework-owned overlay receives only search snapshots and actions. */
export type OfficeSearchProps = PropsRuntime<'shell.overlay'> & PropsLocale<'office'> & InjectFace<OfficeSearchInjected>

/** One layout-owned administrator audit dialog receives only observable metadata and fenced commands. */
export interface OfficeAuditInjected {
  readonly hooks: { readonly audit: OfficeAuditModel['state'] }
  closeAudit(this: void): void
  fieldAudit(this: void, key: keyof OfficeAuditFilters, value: string): void
  searchAudit(this: void): Promise<void>
  moreAudit(this: void): Promise<void>
  exportAudit(this: void): Promise<void>
}
/** Audit presentation uses the existing overlay and locale binding without a new navigation destination. */
export type OfficeAuditProps = PropsRuntime<'shell.overlay'> & PropsLocale<'office'> & InjectFace<OfficeAuditInjected>
/** Independent onboarding overlay owns safe metadata and direct action callbacks. */
export interface OfficeMemberInvitesInjected {
  readonly hooks: { readonly memberInvites: OfficeMemberInvitesModel['state'] }
  closeMemberInvites(this: void): void
  refreshMemberInvites(this: void): void
  issueMemberInvite(this: void, expiresAt: number, retry?: boolean): ReturnType<OfficeMemberInvitesModel['issue']>
  revokeMemberInvite(this: void): Promise<boolean>
  acceptMemberInvite(this: void, code: string, password: string): Promise<boolean>
}
/** Framework-owned onboarding dialog receives no Host services or persisted secrets. */
export type OfficeMemberInvitesProps = PropsRuntime<'shell.overlay'> & PropsLocale<'office'> & InjectFace<OfficeMemberInvitesInjected>
/** Application rail props, including the layout owner's collapse callback. */
export type OfficeNavigationProps = PropsRuntime<'shell.navigation'> &
  PropsLocale<'office'> &
  InjectFace<OfficeInjected>
/** Additive notification surface, independent of the main panel store. */
export type OfficeToastProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<'office'> &
  InjectFace<OfficeInjected>
/** UI input accepts only a directory-issued identity; Host still rechecks membership. */
export type SelectedMember = OfficeMemberId | undefined

/** Additive Session-scoped card uses the existing composer's extension slot. */
export type OfficeItemContextProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'office'> & InjectFace<{
  readonly hooks: { readonly assistance: OfficeAssistanceModel['state']; readonly office: OfficeModel['state'] }
  returnToItem(this: void, source: OfficeSection, date: string): void
}>

/** Private native-Conversation registration face; no service or file handles enter presentation. */
export interface OfficeConversationInjected {
  readonly hooks: {
    readonly office: OfficeModel['state']
    readonly assistance: OfficeAssistanceModel['state']
    readonly sidebarSession: ISidebarRight['mounted']
    readonly conversations: OfficeConversationModel['state']
  }
  observeConversation(this: void, sessionId: SessionId, principal: OfficeMemberId): void
  showConversationHistory(this: void, sessionId: SessionId, automatic: boolean): void
  newConversation(this: void): void
  selectConversation(this: void, sessionId: SessionId): void
  refreshConversations(this: void): void
  openOfficeHome(this: void): void
  readonly updateProfile: OfficeInjected['updateProfile']
  readonly openAudit: OfficeInjected['openAudit']
  readonly openCollaboration: OfficeInjected['openCollaboration']
}
/** Native right-Sidebar tab with a registration-owned search store. */
export type OfficeSessionBrowserProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'office'> &
  InjectFace<OfficeConversationInjected> & PropsStore<ReturnType<typeof createOfficeViewStore>>
/** Additive Conversation header entry receives native Session identity from the framework. */
export type OfficeConversationHeaderProps = PropsRuntime<'conversation.header.trailing'> & PropsLocale<'office'> &
  InjectFace<OfficeConversationInjected>

/** Native input receives only current private choices, catalog metadata and account-fenced operations. */
export type OfficeAssociationsProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'office'> & InjectFace<{
  readonly hooks: {
    readonly office: OfficeModel['state']
    readonly conversations: OfficeConversationModel['state']
    readonly associations: OfficeAssociationsModel['state']
    readonly tools: OfficeToolsModel['state']
    readonly connectors: OfficeConnectorsModel['state']
  }
  loadAssociations(this: void, id: OfficeConversationId): void
  loadAssociationCatalog(this: void, id: SessionId): void
  saveAssociations(this: void, input: OfficeConversationLinksInput): Promise<AssociationSaveOutcome>
}>

/** File-reference callbacks and private observables supplied by their registration. */
export interface OfficeFileAssociationsInjected {
  readonly hooks: {
    readonly office: OfficeModel['state']
    readonly conversations: OfficeConversationModel['state']
    readonly fileAssociations: OfficeFileAssociationsModel['state']
  }
  loadFileAssociations(this: void, id: OfficeConversationId, refresh?: boolean): void
  chooseFileAssociations(this: void, id: OfficeConversationId): Promise<void>
  removeFileAssociation(this: void, id: OfficeDriveId | null): Promise<boolean>
  retryFileAssociations(this: void): Promise<boolean>
}

/** File references share the native input's identity and publish only private JSON metadata. */
export type OfficeFileAssociationsProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'office'> &
  InjectFace<OfficeFileAssociationsInjected>
