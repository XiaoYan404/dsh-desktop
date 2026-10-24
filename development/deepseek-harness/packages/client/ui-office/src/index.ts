import { installOfficeNativeUsage } from './native-usage.ts'
import type CollaborationOfficeService from '@deepseek-ai/dsh-enterprise-office'
/** Office BFF for one employee's authenticated, local Harness Host. */
import { Context } from '@deepseek-ai/cordis'
import type { OfficeDeliveryCheckInput, OfficeDeliveryCheck } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeKnowledgePublication, OfficeKnowledgePublishInput, OfficeKnowledgeWithdrawInput,
  OfficeKnowledgeSearchInput, OfficeKnowledgeSearch, OfficeKnowledgeCitationInput, OfficeKnowledgeCitation } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConversationImageReadInput, OfficeConversationImageRead } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeDrivePurgeInput, OfficeDrivePurgePlan, OfficeDrivePurgeReceipt } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeConnectorSyncInput, OfficeConnectorSyncQuery, OfficeConnectorSyncPage,
  OfficeConnectorSyncDetail, OfficeConnectorSyncId } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeCustomizationId, OfficeCustomizationInput, OfficeCustomizationPage,
  OfficeCustomizationRecord, OfficeCustomizationSaveReceipt } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeAuditExport, OfficeAuditPage, OfficeAuditQuery } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConversationXlsxReadInput, OfficeConversationXlsxRead } from '@deepseek-ai/dsh-enterprise-office/types'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { OfficeError } from '@deepseek-ai/dsh-enterprise-office'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installOfficePromptContext } from './native-context.ts'
import { installOfficeExperienceHost } from './experience/host.ts'
import type { OfficeExperienceHost, ExperienceOutcome } from './experience/host.ts'
import type { OfficeAppearance, OfficeAssistant, OfficeAssistantInput, OfficeExperienceView } from './experience/types.ts'
import { OfficeImageAdmissions } from './image-admission.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Resolve whether the optional Native consumer and its current services are enabled.
     * @mode bail
     * @returns True only while a live image consumer can register on the synchronous inbox claim.
     */
    'office/image-reader-enabled'(): true | undefined
  }
}

import { installOfficeHistoryAccess } from './history-access.ts'
import { officeRunHistoryProjection } from './native-history.ts'
export { officeRunClaims } from './native-claims.ts'
export type { OfficeRunClaim } from './native-claims.ts'
export { foldOfficeRunHistory, foldOfficeRunInheritance, officeRunHistoryProjection, officeRunHistorySchema } from './native-history.ts'
export { readOfficeRunAncestry } from './native-ancestry.ts'
export type { OfficeRunHistoryState, OfficeRunInheritance } from './native-history.ts'
import type { OfficeAgentWorkInput, OfficeAgentWorkReceipt } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeScheduleAvailabilityInput, OfficeScheduleAvailability } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeWorkSubtasksInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeTaskDeliveryInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeWorkAttachmentsInput, OfficeWorkAttachmentsView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeWorkLifecycleInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeDriveHistory, OfficeDriveLifecycleInput, OfficeDriveTrash, OfficeDriveTrashEntry, OfficeDriveVersionId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnectorActionsView, OfficeConnectorReadInput, OfficeConnectorReadReceipt } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConversationConnectorInput, OfficeConversationConnectorReadInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnectorExecutionReceipt, OfficeConnectorWriteInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnectorExecutionId, OfficeConnectorExecutionQuery,
  OfficeConnectorExecutionPage } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnectorExecutionCheck } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnectorEntry, OfficeConnectorInput, OfficeConnectorProbe,
  OfficeConnectorView, OfficeIntegrationId } from '@deepseek-ai/dsh-enterprise-office/types'
import type {
  OfficeChatDraft,
  OfficeChatDraftInput,
  OfficeChatDraftView,
  OfficeChatInput,
  OfficeChatFileCoordinates,
  OfficeChatFileDownload,
  OfficeChatFileLimits,
  OfficeChatFilesInput,
  OfficeChatFileDraft,
  OfficeChatFileDraftInput,
  OfficeChatFileDraftView,
  OfficeChatFileDraftCoordinates,
  OfficeChatFileDraftDownload,
  OfficeChatFileDraftSendInput,
  OfficeChatMessage,
  OfficeChatView,
  OfficeItem,
  OfficeIntegration,
  OfficeIntegrationImportInput,
  OfficeItemId,
  OfficeItemStatus,
  OfficeMember,
  OfficeMemberId,
  OfficeNotificationId,
  OfficeReminderId,
  OfficeProfile,
  OfficeScheduleInput,
  OfficeScheduleUpdateInput,
  OfficeTaskDecisionInput,
  OfficeView,
  OfficeWorkInput,
  OfficeWorkUpdateInput,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnection, OfficeOutcome } from './types.ts'
import type { OfficeIntegrationPlugins } from './types.ts'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { integrationPluginDeclarations, integrationPluginRows } from './integration-plugins.ts'
import type { OfficeConversationId, OfficeConversationLinks, OfficeConversationLinksInput,
  OfficeConversationLinksView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConversationCapture, OfficeConversationCaptureId,
  OfficeConversationCaptureInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConversationFiles, OfficeConversationFilesView, OfficeConversationFilesInput,
  OfficeConversationFilesCapture, OfficeConversationFilesCaptureId,
  OfficeConversationFileReadInput, OfficeConversationFileRead } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConversationPdfReadInput, OfficeConversationPdfRead } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConversationDocxReadInput, OfficeConversationDocxRead } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConversationPptxReadInput, OfficeConversationPptxRead } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeMemberInviteCapability, OfficeMemberInviteView, OfficeMemberInviteIssueInput,
  OfficeMemberInviteIssueReceipt, OfficeMemberInviteRevokeInput, OfficeMemberInvite,
  OfficeMemberInviteAcceptInput, OfficeMemberInviteAcceptReceipt } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeAnnouncement, OfficeAnnouncementId, OfficeAnnouncementInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type {
  OfficeAssignmentInput,
  OfficeOrganizationAssignment,
  OfficeOrganizationUnit,
  OfficeOrganizationView,
  OfficePosition,
  OfficePositionInput,
  OfficeUnitInput,
} from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeGatewayClient } from './gateway-client.ts'
import type {
  OfficeIdentityOverview,
  OfficeLoginInput,
  OfficePasswordChangeInput,
  OfficeSessionId,
  OfficeSessionInfo,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type {
  OfficeDriveDownload,
  OfficeDriveDownloadInfo,
  OfficeDriveDownloadRange,
  OfficeDriveEntry,
  OfficeDriveFolderInput,
  OfficeDriveId,
  OfficeDrivePermissionsInput,
  OfficeDriveQuery,
  OfficeDriveRenameInput,
  OfficeDriveRangeInput,
  OfficeDriveUploadChunkInput,
  OfficeDriveUploadDeclaration,
  OfficeDriveUploadId,
  OfficeDriveUploadTicket,
  OfficeDriveUploadInput,
  OfficeDriveView,
} from '@deepseek-ai/dsh-enterprise-office/types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated employee Host office operations; request payloads never choose their actor. */
    officeController: OfficeController
  }
}

/** The Host, not the browser, assigns its employee principal. */
export interface Config {
  /** Employee id assigned by this authenticated local Host's deployment. */
  principalId?: string
  /** Central office base URL; selected instead of a fixed local principal. */
  gatewayUrl?: string
  /** Local adapter ids mapped to npm bundle roots; never installs code or changes a central office server. */
  connectorPackages?: Record<string, string>
}

/** No method accepts a caller-selected actor id. This adapter is not a shared multiuser login gateway. */
export class OfficeController extends TypertRemoteService {
  static Config: Schema<Config> = Schema.object({
    principalId: Schema.string(),
    gatewayUrl: Schema.string(),
    connectorPackages: Schema.dict(Schema.string()).default({}),
  })
  private readonly experience: OfficeExperienceHost
  private readonly principal: OfficeMemberId
  private readonly gateway: OfficeGatewayClient | undefined
  private readonly lifetime = new AbortController()
  private readonly imageAdmissions = new OfficeImageAdmissions()
  private readonly connectorPackages: Readonly<Record<string, string>>
  private readonly inputOwners = new Map<OfficeConversationId, {
    readonly memberId: OfficeMemberId
    readonly role: NonNullable<OfficeConnection['member']>['role']
  }>()

  /**
   * @param ctx - Authenticated employee Host with the office service.
   * @param config - Deployment-owned employee id.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'officeController', { namespace: 'office' })
    if (Boolean(config.principalId) === Boolean(config.gatewayUrl))
      throw new Error('Configure one office principalId or gatewayUrl')
    this.principal = (config.principalId ?? '') as OfficeMemberId
    this.connectorPackages = integrationPluginDeclarations(config.connectorPackages ?? {})
    if (config.gatewayUrl) {
      const credentials = ctx.get('credentials')
      if (!credentials)
        throw new Error(
          'The office gateway connection requires a credential provider',
        )
      this.gateway = new OfficeGatewayClient(
        credentials,
        config.gatewayUrl,
        this.lifetime.signal,
      )
    }
    this.experience = installOfficeExperienceHost(ctx, async () => {
      const result = await this.connection()
      if (!result.ok || !result.value.connected || !result.value.member?.active) throw new Error('unauthenticated')
      return String(result.value.member.id)
    })
    ctx.effect(
      () => () => {
        this.lifetime.abort()
        this.imageAdmissions.clear()
      },
      'office.connectionClose',
    )
    installOfficePromptContext(ctx, { signal: this.lifetime.signal,
      connection: () => this.connection(),
      inputOwner: id => this.inputOwners.get(id),
      links: id => this.conversationLinks(id), capture: input => this.captureConversation(input),
      files: id => this.conversationFiles(id), captureFiles: input => this.captureConversationFiles(input),
      prepareImage: async (capture, view, signal) => {
        const generation = this.imageAdmissions.generation
        const connection = await this.connection()
        this.lifetime.signal.throwIfAborted()
        signal.throwIfAborted()
        return connection.ok && this.imageAdmissions.prepare(generation, connection.value, capture, view)
      } })
    ctx.inject(['sessionProjections', 'sessionQuery'], (native) => {
      native.sessionProjections.register(officeRunHistoryProjection)
      installOfficeHistoryAccess(native, this.lifetime.signal)
      if (!this.gateway && this.ctx.office.collaborationCapability()) {
        native.effect(() => installOfficeNativeUsage(native, observation => this.ctx.office.captureUsageSettlement(observation)), 'office.usageCapture')
      }
    })
  }

  /**
   * Read this employee's authorized board and directory.
   * @param date - Optional local day; absent selects office today.
   * @returns safe view or a business denial.
   */
  @Remote
  view(date?: string): Promise<OfficeOutcome<OfficeView>> {
    return this.perform('view', [date ?? null], () =>
      this.ctx.office.view(this.principal, date),
    )
  }

  /**
   * Search retained audit metadata using the Host's current administrator identity.
   * @param query - Explicit bounded filters and an exclusive older-page position.
   * @returns Authorized allowlisted metadata, or a denial rechecked by the office authority for this page.
   */
  @Remote
  auditPage(query: OfficeAuditQuery): Promise<OfficeOutcome<OfficeAuditPage>> {
    return this.perform('auditPage', [query], () => this.ctx.office.auditPage(this.principal, query))
  }

  /**
   * Read one bounded NDJSON batch after fresh administrator authorization.
   * @param query - Same reviewed filters and continuation used for audit search.
   * @returns Credential-free metadata content; each later batch requires another authorized request.
   */
  @Remote
  auditExport(query: OfficeAuditQuery): Promise<OfficeOutcome<OfficeAuditExport>> {
    return this.perform('auditExport', [query], () => this.ctx.office.auditExport(this.principal, query))
  }

  /**
   * Read only this employee's association draft for one native logical conversation.
   * @param conversationId - Native conversation identity; it is not an authorization credential.
   * @returns Reviewed private choices and explicit resolved/missing dependency metadata, without execution permission.
   */
  @Remote
  conversationLinks(conversationId: OfficeConversationId): Promise<OfficeOutcome<OfficeConversationLinksView>> {
    return this.perform('conversationLinks', [conversationId], () => this.ctx.office.conversationLinks(this.principal, conversationId))
  }

  /**
   * Save a reviewed private association list while keeping the actor assigned by the authenticated Host.
   * @param input - Conversation identity, reviewed version, exact retry id and selected tools or integrations.
   * @returns Confirmed association choices; this operation never prompts an Agent or runs a selected capability.
   */
  @Remote
  saveConversationLinks(input: OfficeConversationLinksInput): Promise<OfficeOutcome<OfficeConversationLinks>> {
    return this.perform('saveConversationLinks', [input], () => this.ctx.office.saveConversationLinks(this.principal, input))
  }

  /**
   * Bind an explicit office gesture before its separate Native prompt reaches this Host.
   * @param id - Exact Native input; this restriction never grants Session visibility or execution authority.
   * @returns A Host-lifetime restriction to the current employee; empty inputs carry no private history across restarts.
   */
  @Remote
  prepareNativeInput(id: OfficeConversationId): Promise<OfficeOutcome<null>> {
    return this.outcome(async () => {
      const signal = this.lifetime.signal
      signal.throwIfAborted()
      const sessionId = String(id) as SessionId
      const visible = await this.ctx.waterfall('api-session/visible', { candidates: [{ sessionId }], signal },
        () => Promise.resolve([sessionId]))
      if (!visible.includes(sessionId)) throw new OfficeError('not_found', 'Native input not found')
      const connection = await this.connection()
      signal.throwIfAborted()
      const member = connection.ok && connection.value.connected ? connection.value.member : undefined
      if (!member?.active) throw new OfficeError('unauthenticated', 'Sign in before preparing an office input')
      const currentVisible = await this.ctx.waterfall('api-session/visible', { candidates: [{ sessionId }], signal },
        () => Promise.resolve([sessionId]))
      signal.throwIfAborted()
      if (!currentVisible.includes(sessionId)) throw new OfficeError('not_found', 'Native input not found')
      const current = this.inputOwners.get(id)
      if (current && current.memberId !== member.id) throw new OfficeError('not_found', 'Native input not found')
      this.inputOwners.set(id, { memberId: member.id, role: member.role })
      return null
    })
  }

  /**
   * Capture the employee's reviewed association version independently of native message delivery.
   * @param input - Logical conversation, reviewed version and exact native prompt retry id.
   * @returns Immutable private prepared context without execution authority, addresses or credentials.
   */
  @Remote
  captureConversation(input: OfficeConversationCaptureInput): Promise<OfficeOutcome<OfficeConversationCapture>> {
    return this.perform('captureConversation', [input], () => this.ctx.office.captureConversation(this.principal, input))
  }

  /**
   * Read the current employee's immutable prepared context after an uncertain response or restart.
   * @param id - Opaque context identity; ownership is checked independently of this value.
   * @returns Historical metadata that does not imply a native prompt was admitted or dispatched.
   */
  @Remote
  conversationCapture(id: OfficeConversationCaptureId): Promise<OfficeOutcome<OfficeConversationCapture>> {
    return this.perform('conversationCapture', [id], () => this.ctx.office.conversationCapture(this.principal, id))
  }

  /**
   * Read this employee's reviewed drive references for one logical native conversation.
   * @param id - Native Session identity, without file access authority.
   * @returns Private immutable-version metadata; content reads remain separately authorized.
   */
  @Remote
  conversationFiles(id: OfficeConversationId): Promise<OfficeOutcome<OfficeConversationFilesView>> {
    return this.perform('conversationFiles', [id], () => this.ctx.office.conversationFiles(this.principal, id))
  }

  /**
   * Save reviewed immutable file coordinates as the authenticated employee.
   * @param input - Current selection revision, exact retry UUID and selected file versions.
   * @returns Committed metadata; client-supplied names, bytes and employee identities are not admitted.
   */
  @Remote
  saveConversationFiles(input: OfficeConversationFilesInput): Promise<OfficeOutcome<OfficeConversationFiles>> {
    return this.perform('saveConversationFiles', [input], () => this.ctx.office.saveConversationFiles(this.principal, input))
  }

  /**
   * Prepare file context before a separate native prompt admission.
   * @param input - Reviewed file selection and exact native prompt request identity.
   * @returns Private immutable metadata; later reads still require current permissions.
   */
  @Remote
  captureConversationFiles(input: OfficeConversationCaptureInput): Promise<OfficeOutcome<OfficeConversationFilesCapture>> {
    return this.perform('captureConversationFiles', [input], () => this.ctx.office.captureConversationFiles(this.principal, input))
  }

  /**
   * Recover submitted file evidence after an uncertain response or restart.
   * @param id - Server-issued private capture identity.
   * @returns Historical metadata for this employee and authority role, without execution authority.
   */
  @Remote
  conversationFilesCapture(id: OfficeConversationFilesCaptureId): Promise<OfficeOutcome<OfficeConversationFilesCapture>> {
    return this.perform('conversationFilesCapture', [id], () => this.ctx.office.conversationFilesCapture(this.principal, id))
  }

  /**
   * Read a bounded verified UTF-8 window from a file selected in submitted context.
   * @param input - Owned capture, selected file id and character coordinates.
   * @returns Inert text only after fresh membership, ancestor ACL and version checks.
   */
  @Remote
  readConversationFile(input: OfficeConversationFileReadInput): Promise<OfficeOutcome<OfficeConversationFileRead>> {
    return this.perform('readConversationFile', [input], () => this.ctx.office.readConversationFile(this.principal, input))
  }

  /**
   * Read one submitted PDF page for a native tool without creating an attachment copy or a browser RPC.
   * @param input - Owned capture, selected immutable file and page text window.
   * @param signal - Original native tool cancellation; unload also stops the operation.
   * @returns Actual bounded PDF text after fresh authority checks, or a stable office denial.
   */
  readConversationPdf(input: OfficeConversationPdfReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationPdfRead>> {
    const cancellation = AbortSignal.any([this.lifetime.signal, signal])
    return this.outcome(async () => {
      cancellation.throwIfAborted()
      const result = this.gateway
        ? await this.gateway.operation<OfficeConversationPdfRead>('readConversationPdf', [input], cancellation)
        : await this.ctx.office.readConversationPdf(this.principal, input, cancellation)
      cancellation.throwIfAborted()
      return result
    })
  }

  /**
   * Read submitted DOCX body paragraphs and tables for the exact original native tool call.
   * @param input - Owned submitted file and bounded body-text window.
   * @param signal - Original native cancellation, combined with the controller lifetime.
   * @returns Actual verified text after current authority checks, or a stable office denial; no browser RPC is added.
   */
  readConversationDocx(input: OfficeConversationDocxReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationDocxRead>> {
    const cancellation = AbortSignal.any([this.lifetime.signal, signal])
    return this.outcome(async () => {
      cancellation.throwIfAborted()
      const result = this.gateway
        ? await this.gateway.operation<OfficeConversationDocxRead>('readConversationDocx', [input], cancellation)
        : await this.ctx.office.readConversationDocx(this.principal, input, cancellation)
      cancellation.throwIfAborted()
      return result
    })
  }

  /**
   * Read exact saved spreadsheet cells for the original native tool without adding a browser RPC.
   * @param input - Owned submitted file, workbook sheet number and sparse-cell window.
   * @param signal - Original native cancellation, combined with controller lifetime.
   * @returns Verified raw values and saved formula caches after current authority checks, or a stable office denial.
   */
  readConversationXlsx(input: OfficeConversationXlsxReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationXlsxRead>> {
    const cancellation = AbortSignal.any([this.lifetime.signal, signal])
    return this.outcome(async () => {
      cancellation.throwIfAborted()
      const result = this.gateway
        ? await this.gateway.operation<OfficeConversationXlsxRead>('readConversationXlsx', [input], cancellation)
        : await this.ctx.office.readConversationXlsx(this.principal, input, cancellation)
      cancellation.throwIfAborted()
      return result
    })
  }

  /**
   * Resolve the prepared capability synchronously before Native schema collection; this grants no read permission.
   * @param capture - Actual submitted attribution owned by the calling Agent.
   * @returns Current identity-bound hint, or undefined while unavailable or withdrawn.
   */
  preparedImageCapability(capture: OfficeConversationFilesCapture):
    NonNullable<import('@deepseek-ai/dsh-enterprise-office/types').OfficeConversationFileLimits['image']> | undefined {
    return this.lifetime.signal.aborted ? undefined : this.imageAdmissions.forCapture(capture)
  }

  /**
   * Read submitted raster bytes or recheck the source for the original Native tool; no browser RPC is added.
   * @param input - Original captured immutable source coordinates.
   * @param signal - Original Native cancellation combined with controller lifetime.
   * @returns Verified original source or exact-source metadata, or a structured Office denial.
   */
  readConversationImage(input: OfficeConversationImageReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationImageRead>> {
    const cancellation = AbortSignal.any([this.lifetime.signal, signal])
    return this.outcome(async () => {
      cancellation.throwIfAborted()
      const result = this.gateway
        ? await this.gateway.operation<OfficeConversationImageRead>('readConversationImage', [input], cancellation)
        : await this.ctx.office.readConversationImage(this.principal, input, cancellation)
      cancellation.throwIfAborted()
      return result
    })
  }

  /**
   * Read saved presentation text or explicit speaker notes for the original native tool without a browser RPC.
   * @param input - Submitted immutable file, actual slide number, explicit section and bounded UTF-16 window.
   * @param signal - Original native cancellation, combined with the controller lifetime.
   * @returns Verified saved text after current authority checks, or a stable office denial.
   */
  readConversationPptx(input: OfficeConversationPptxReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationPptxRead>> {
    const cancellation = AbortSignal.any([this.lifetime.signal, signal])
    return this.outcome(async () => {
      cancellation.throwIfAborted()
      const result = this.gateway
        ? await this.gateway.operation<OfficeConversationPptxRead>('readConversationPptx', [input], cancellation)
        : await this.ctx.office.readConversationPptx(this.principal, input, cancellation)
      cancellation.throwIfAborted()
      return result
    })
  }

  /**
   * Register a bounded descriptive integration manifest as the authenticated administrator.
   * @param input - Exact JSON object and retained retry UUID; contains no executable code or credentials.
   * @returns Committed company registration or a business denial.
   */
  @Remote
  importIntegration(input: OfficeIntegrationImportInput): Promise<OfficeOutcome<OfficeIntegration>> {
    return this.perform('importIntegration', [input], () => this.ctx.office.importIntegration(this.principal, input))
  }

  /**
   * Read company connection readiness without resolving credential values in the employee Host.
   * @returns Current versions and administrator-only configuration choices.
   */
  @Remote
  connections(): Promise<OfficeOutcome<OfficeConnectorView>> {
    return this.perform('connections', [], () => this.ctx.office.connections(this.principal))
  }

  /**
   * Read one company system's role-filtered declarations without performing a business operation.
   * @param integrationId - Registered system identity, never a caller-selected address or actor.
   * @returns Bounded current directory without private connection configuration or role-admission rules.
   */
  @Remote
  connectorActions(integrationId: OfficeIntegrationId): Promise<OfficeOutcome<OfficeConnectorActionsView>> {
    return this.perform('connectorActions', [integrationId], () => this.ctx.office.connectorActions(this.principal, integrationId))
  }

  /**
   * Read this authenticated employee's retained external-operation receipts without another employee's request data.
   * @returns Own execution stages and authoritative results; unknown outcomes never imply success or an automatic retry.
   */
  @Remote
  connectorExecutions(): Promise<OfficeOutcome<readonly OfficeConnectorExecutionReceipt[]>> {
    return this.perform('connectorExecutions', [], () => this.ctx.office.connectorExecutions(this.principal))
  }

  /**
   * Read this employee's bounded execution metadata for one system without large results or raw input values.
   * @param query - Registered system and optional own last-entry cursor.
   * @returns Newest-first own receipt page with an explicit older-page anchor.
   */
  @Remote
  connectorExecutionPage(query: OfficeConnectorExecutionQuery): Promise<OfficeOutcome<OfficeConnectorExecutionPage>> {
    return this.perform('connectorExecutionPage', [query], () => this.ctx.office.connectorExecutionPage(this.principal, query))
  }

  /**
   * Read one retained own receipt after an explicit detail selection.
   * @param executionId - Server-generated own operation identity, never another employee's claimed actor.
   * @returns Bounded result and audit history; adapter removal does not erase retained evidence.
   */
  @Remote
  connectorExecutionDetail(executionId: OfficeConnectorExecutionId): Promise<OfficeOutcome<OfficeConnectorExecutionReceipt>> {
    return this.perform('connectorExecutionDetail', [executionId], () => this.ctx.office.connectorExecutionDetail(this.principal, executionId))
  }

  /**
   * Query the original customer's outcome for an own unknown operation without replaying its business request.
   * @param executionId - Own server-generated execution identity.
   * @returns Current private receipt and explicit availability/uncertainty, after current authority and durable result checks.
   */
  @Remote
  checkConnectorExecution(executionId: OfficeConnectorExecutionId): Promise<OfficeOutcome<OfficeConnectorExecutionCheck>> {
    return this.perform('checkConnectorExecution', [executionId], () => this.ctx.office.checkConnectorExecution(this.principal, executionId))
  }

  /**
   * Manage private automation configuration, exact reviews and recovery through the authenticated Office owner.
   * @param input - Closed command; Host event admission and arbitrary network arguments are excluded.
   * @returns Durable own metadata or a stable sanitized denial; uncertain effects never trigger an automatic retry.
   */
  @Remote
  automation(input: import('@deepseek-ai/dsh-enterprise-office/types').OfficeAutomationCommandInput):
    Promise<OfficeOutcome<import('@deepseek-ai/dsh-enterprise-office/types').OfficeAutomationResponse>> {
    return this.perform('automation', [input], () => this.ctx.office.automation(this.principal, input))
  }

  /**
   * Submit a reviewed declared write; unknown outcomes never trigger automatic re-dispatch.
   * @param input - Exact declared business fields, reviewed connection/provider coordinates and stable retry UUID.
   * @returns Own durable receipt or a stable denial/unknown handling identity, without private diagnostics.
   */
  @Remote
  writeConnectorAction(input: OfficeConnectorWriteInput): Promise<OfficeOutcome<OfficeConnectorExecutionReceipt>> {
    return this.perform('writeConnectorAction', [input], () => this.ctx.office.writeConnectorAction(this.principal, input))
  }

  /**
   * Query a declared read action under the authenticated employee's current permissions.
   * @param input - Reviewed system, read action, saved connection and provider versions.
   * @returns Bounded plain-text fields or a network outcome; caller-supplied identities and URLs are rejected.
   */
  @Remote
  readConnectorAction(input: OfficeConnectorReadInput): Promise<OfficeOutcome<OfficeConnectorReadReceipt>> {
    return this.perform('readConnectorAction', [input], () => this.ctx.office.readConnectorAction(this.principal, input))
  }

  /**
   * Persist a reviewed declared read under an exact employee-scoped retry identity.
   * @param input - Original action/source coordinates and stable request UUID.
   * @returns Durable network outcome and currently authorized retained data.
   */
  @Remote
  syncConnectorAction(input: OfficeConnectorSyncInput): Promise<OfficeOutcome<OfficeConnectorSyncDetail>> {
    return this.perform('syncConnectorAction', [input], () => this.ctx.office.syncConnectorAction(this.principal, input))
  }

  /**
   * Read this employee's small synchronization metadata without a customer request.
   * @param query - Selected system and owner-scoped older anchor.
   * @returns Bounded private metadata page.
   */
  @Remote
  connectorSyncPage(query: OfficeConnectorSyncQuery): Promise<OfficeOutcome<OfficeConnectorSyncPage>> {
    return this.perform('connectorSyncPage', [query], () => this.ctx.office.connectorSyncPage(this.principal, query))
  }

  /**
   * Recheck current access before returning the owner's retained synchronization fields.
   * @param id - Server synchronization identity.
   * @returns Actual historical metadata with unavailable content withheld.
   */
  @Remote
  connectorSyncDetail(id: OfficeConnectorSyncId): Promise<OfficeOutcome<OfficeConnectorSyncDetail>> {
    return this.perform('connectorSyncDetail', [id], () => this.ctx.office.connectorSyncDetail(this.principal, id))
  }

  /**
   * Discover actions only for a system in this employee's submitted native conversation context.
   * @param input - Private capture and selected registered system identity.
   * @returns Role-admitted directory after current association and connection checks.
   */
  @Remote
  conversationConnectorActions(input: OfficeConversationConnectorInput): Promise<OfficeOutcome<OfficeConnectorActionsView>> {
    return this.perform('conversationConnectorActions', [input], () => this.ctx.office.conversationConnectorActions(this.principal, input))
  }

  /**
   * Query a declared read action under the authenticated employee's current native conversation associations.
   * @param input - Private capture and exact reviewed action/connection/provider coordinates.
   * @returns Real bounded result or a current business denial; arbitrary actors and URLs are rejected.
   */
  @Remote
  readConnectorActionFromConversation(input: OfficeConversationConnectorReadInput): Promise<OfficeOutcome<OfficeConnectorReadReceipt>> {
    return this.perform('readConnectorActionFromConversation', [input], () =>
      this.ctx.office.readConnectorActionFromConversation(this.principal, input))
  }

  /**
   * Save a reviewed connection as the authenticated administrator.
   * @param input - Deployment-approved location and credential alias, version and exact retry UUID.
   * @returns Durable metadata; importing a manifest remains an independent operation.
   */
  @Remote
  saveConnection(input: OfficeConnectorInput): Promise<OfficeOutcome<OfficeConnectorEntry>> {
    return this.perform('saveConnection', [input], () => this.ctx.office.saveConnection(this.principal, input))
  }

  /**
   * Check a reviewed connection with credentials resolved only by its owning office server.
   * @param integrationId - Saved integration identity, never an arbitrary URL.
   * @param revision - Reviewed connection version.
   * @returns Sanitized bounded probe outcome; no business writes or remote response content.
   */
  @Remote
  probeConnection(integrationId: OfficeIntegrationId, revision: number): Promise<OfficeOutcome<OfficeConnectorProbe>> {
    return this.perform('probeConnection', [integrationId, revision], () => this.ctx.office.probeConnection(
      this.principal, integrationId, revision))
  }

  /**
   * Publish an administrator-reviewed announcement and recipient list atomically.
   * @param input - Plain text, delivery scope and stable retry UUID.
   * @returns Durable publication or a business denial.
   */
  @Remote
  publishAnnouncement(input: OfficeAnnouncementInput): Promise<OfficeOutcome<OfficeAnnouncement>> {
    return this.perform('publishAnnouncement', [input], () => this.ctx.office.publishAnnouncement(this.principal, input))
  }

  /**
   * Acknowledge only this employee's delivered announcement.
   * @param id - Publication identity.
   * @returns Null after durability, or a business denial.
   */
  @Remote
  markAnnouncementRead(id: OfficeAnnouncementId): Promise<OfficeOutcome<null>> {
    return this.perform('markAnnouncementRead', [id], async () => { await this.ctx.office.markAnnouncementRead(this.principal, id); return null })
  }

  /**
   * Withdraw a reviewed company announcement as the current administrator.
   * @param id - Publication identity.
   * @param expectedRevision - Reviewed content revision.
   * @returns Null after withdrawal, or a business denial.
   */
  @Remote
  withdrawAnnouncement(id: OfficeAnnouncementId, expectedRevision: number): Promise<OfficeOutcome<null>> {
    return this.perform('withdrawAnnouncement', [id, expectedRevision], async () => { await this.ctx.office.withdrawAnnouncement(this.principal, id, expectedRevision); return null })
  }

  /**
   * List or search an employee-authorized virtual drive location.
   * @param input - Space, opaque folder and name query.
   * @returns Only visible metadata and breadcrumbs.
   */
  @Remote
  drive(input: OfficeDriveQuery): Promise<OfficeOutcome<OfficeDriveView>> {
    return this.perform('drive', [input], () =>
      this.ctx.office.drive(this.principal, input),
    )
  }

  /**
   * Create a directory whose owner comes from the Host identity.
   * @param input - Logical destination and name.
   * @returns Committed directory metadata.
   */
  @Remote
  createDriveFolder(
    input: OfficeDriveFolderInput,
  ): Promise<OfficeOutcome<OfficeDriveEntry>> {
    return this.perform('createDriveFolder', [input], () =>
      this.ctx.office.createDriveFolder(this.principal, input),
    )
  }

  /**
   * Commit actual bounded bytes and their authorized file metadata.
   * @param input - Logical destination, file content, length and stable retry id.
   * @returns File metadata after durability, or a business denial.
   */
  @Remote
  uploadDriveFile(
    input: OfficeDriveUploadInput,
  ): Promise<OfficeOutcome<OfficeDriveEntry>> {
    return this.perform('uploadDriveFile', [input], () =>
      this.ctx.office.uploadDriveFile(this.principal, input),
    )
  }

  /**
   * Read immutable file bytes through current employee and ancestor authorization.
   * @param id - Opaque enterprise file identity, never a native path.
   * @returns Verified bytes with their SHA-256 digest.
   */
  @Remote
  downloadDriveFile(
    id: OfficeDriveId,
  ): Promise<OfficeOutcome<OfficeDriveDownload>> {
    return this.perform('downloadDriveFile', [id], () =>
      this.ctx.office.downloadDriveFile(this.principal, id),
    )
  }

  /**
   * Rename a reviewed, editable directory entry.
   * @param input - Opaque identity, version and name.
   * @returns Committed metadata or a business denial.
   */
  @Remote
  renameDriveEntry(
    input: OfficeDriveRenameInput,
  ): Promise<OfficeOutcome<OfficeDriveEntry>> {
    return this.perform('renameDriveEntry', [input], () =>
      this.ctx.office.renameDriveEntry(this.principal, input),
    )
  }

  /**
   * Replace shared account conditions through ownership and a reviewed version.
   * @param input - Entry, version, default and account overrides.
   * @returns Owner-authorized committed metadata.
   */
  @Remote
  saveDrivePermissions(
    input: OfficeDrivePermissionsInput,
  ): Promise<OfficeOutcome<OfficeDriveEntry>> {
    return this.perform('saveDrivePermissions', [input], () =>
      this.ctx.office.saveDrivePermissions(this.principal, input),
    )
  }

  /**
   * Create and durably dispatch employee work.
   * @param input - Task or to-do fields.
   * @returns committed item or a business denial.
   */
  @Remote
  createWork(input: OfficeWorkInput): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('createWork', [input], () =>
      this.ctx.office.createWork(this.principal, input),
    )
  }

  /**
   * Execute one internal task/to-do under this employee's reviewed reminder context.
   * @param input - Private capture, stable execution retry identity and work fields.
   * @returns Durable receipt or a current business denial; retries do not create another item.
   */
  @Remote
  createWorkFromConversation(input: OfficeAgentWorkInput): Promise<OfficeOutcome<OfficeAgentWorkReceipt>> {
    return this.perform('createWorkFromConversation', [input], () => this.ctx.office.createWorkFromConversation(this.principal, input))
  }

  /**
   * Create a meeting and its recipient invitations atomically.
   * @param input - Schedule and invitees.
   * @returns committed meeting or a business denial.
   */
  @Remote
  createSchedule(
    input: OfficeScheduleInput,
  ): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('createSchedule', [input], () =>
      this.ctx.office.createSchedule(this.principal, input),
    )
  }

  /**
   * Submit a task delivery or review its current submission through the authenticated employee.
   * @param id - Existing task identity.
   * @param revision - Parent revision reviewed before submitting or deciding.
   * @param input - Submission, confirmation or return with an explanation.
   * @returns Committed task with retained delivery history, or a business denial without partial changes.
   */
  @Remote
  reviewTaskDelivery(id: OfficeItemId, revision: number, input: OfficeTaskDeliveryInput): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('reviewTaskDelivery', [id, revision, input], () =>
      this.ctx.office.reviewTaskDelivery(this.principal, id, revision, input))
  }

  /**
   * Replace a task/to-do checklist under its current parent permissions and reviewed version.
   * @param id - Existing work item identity.
   * @param revision - Parent revision reviewed before editing.
   * @param input - Existing entries or null ids for server-created entries.
   * @returns Committed work or a business denial without partial checklist changes.
   */
  @Remote
  updateWorkSubtasks(id: OfficeItemId, revision: number, input: OfficeWorkSubtasksInput): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('updateWorkSubtasks', [id, revision, input], () =>
      this.ctx.office.updateWorkSubtasks(this.principal, id, revision, input))
  }

  /**
   * Read attachment metadata under current work and Drive access.
   * @param id - Existing task/to-do identity.
   * @returns Available names or metadata-free unavailable references.
   */
  @Remote
  workAttachments(id: OfficeItemId): Promise<OfficeOutcome<OfficeWorkAttachmentsView>> {
    return this.perform('workAttachments', [id], () => this.ctx.office.workAttachments(this.principal, id))
  }

  /**
   * Apply a confirmed archive, recycle-bin deletion or restoration under creator/admin authority.
   * @param id - Existing readable work, including inactive records.
   * @param revision - Item revision reviewed before confirmation.
   * @param input - Action and retained explanation.
   * @returns Committed record or denial without partial lifecycle changes.
   */
  @Remote
  changeWorkLifecycle(id: OfficeItemId, revision: number, input: OfficeWorkLifecycleInput): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('changeWorkLifecycle', [id, revision, input], () =>
      this.ctx.office.changeWorkLifecycle(this.principal, id, revision, input))
  }

  /**
   * Save reviewed Drive references without granting file access.
   * @param id - Existing open task/to-do.
   * @param revision - Reviewed parent revision.
   * @param input - At most 20 distinct reviewed file versions.
   * @returns Committed work or denial without partial changes.
   */
  @Remote
  updateWorkAttachments(id: OfficeItemId, revision: number, input: OfficeWorkAttachmentsInput): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('updateWorkAttachments', [id, revision, input], () =>
      this.ctx.office.updateWorkAttachments(this.principal, id, revision, input))
  }

  /**
   * Authorize one linked reviewed version before verified Drive download.
   * @param id - Readable task/to-do retaining the reference.
   * @param fileId - Logical Drive file identity.
   * @returns Physically verified metadata or current-access denial.
   */
  @Remote
  workAttachmentInfo(id: OfficeItemId, fileId: OfficeDriveId): Promise<OfficeOutcome<OfficeDriveDownloadInfo>> {
    return this.perform('workAttachmentInfo', [id, fileId], () => this.ctx.office.workAttachmentInfo(this.principal, id, fileId))
  }

  /**
   * Query coworkers' busy flags through the company's explicitly enabled internal meeting policy.
   * @param input - Office-local interval, selected members and an optional readable meeting to exclude.
   * @returns Current busy flags or an authenticated business denial, without private meeting content.
   */
  @Remote
  scheduleAvailability(input: OfficeScheduleAvailabilityInput): Promise<OfficeOutcome<OfficeScheduleAvailability>> {
    return this.perform('scheduleAvailability', [input], () => this.ctx.office.scheduleAvailability(this.principal, input))
  }

  /**
   * Update an existing meeting using its reviewed revision.
   * @param id - Existing meeting identity.
   * @param revision - Revision reviewed before editing.
   * @param input - Content, time and optional invitees; the organizer and lifecycle remain unchanged.
   * @returns Committed meeting or a business denial.
   */
  @Remote
  updateSchedule(id: OfficeItemId, revision: number, input: OfficeScheduleUpdateInput): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('updateSchedule', [id, revision, input], () => this.ctx.office.updateSchedule(this.principal, id, revision, input))
  }

  /**
   * Decide a task or transfer a to-do under the current authenticated employee.
   * @param id - Task or to-do being reviewed.
   * @param revision - Last reviewed task revision.
   * @param input - Accept, reject with reason, or transfer to an active new assignee with reason.
   * @returns Committed work with history or a business denial; stale and closed items are not changed.
   */
  @Remote
  decideTask(id: OfficeItemId, revision: number, input: OfficeTaskDecisionInput): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('decideTask', [id, revision, input], () => this.ctx.office.decideTask(this.principal, id, revision, input))
  }

  /**
   * Edit task/to-do content on the revision reviewed by this employee.
   * @param id - Existing task or to-do identity.
   * @param revision - Reviewed version, including task decisions.
   * @param input - Content and deadline; assignment, kind and status remain unchanged.
   * @returns Committed work or a business denial; stale and closed edits are not written.
   */
  @Remote
  updateWork(id: OfficeItemId, revision: number, input: OfficeWorkUpdateInput): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('updateWork', [id, revision, input], () => this.ctx.office.updateWork(this.principal, id, revision, input))
  }

  /**
   * Update one authorized item without overwriting a concurrent edit.
   * @param id - Target item.
   * @param revision - Last observed item revision.
   * @param status - Desired state.
   * @returns committed item or a business denial.
   */
  @Remote
  setStatus(
    id: OfficeItemId,
    revision: number,
    status: OfficeItemStatus,
  ): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('setStatus', [id, revision, status], () =>
      this.ctx.office.setStatus(this.principal, id, revision, status),
    )
  }

  /**
   * Answer only this employee's invitation on the version they reviewed.
   * @param id - Invited meeting identity.
   * @param revision - Last observed item revision.
   * @param reply - Accept or decline the invitation.
   * @returns The committed meeting or an expected business denial.
   */
  @Remote
  reply(
    id: OfficeItemId,
    revision: number,
    reply: 'accepted' | 'declined',
  ): Promise<OfficeOutcome<OfficeItem>> {
    return this.perform('reply', [id, revision, reply], () =>
      this.ctx.office.reply(this.principal, id, revision, reply),
    )
  }

  /**
   * Mark one notification in this employee's own inbox as read.
   * @param id - Recipient-owned notification identity.
   * @returns Confirmation or an expected business denial.
   */
  @Remote
  markRead(id: OfficeNotificationId): Promise<OfficeOutcome<null>> {
    return this.perform('markRead', [id], async () => {
      await this.ctx.office.markRead(this.principal, id)
      return null
    })
  }

  /**
   * Acknowledge a currently eligible reminder owned by this authenticated employee.
   * @param id - Server-created reminder occurrence identity.
   * @returns A durable read acknowledgement or an expected authorization denial.
   */
  @Remote
  markReminderRead(id: OfficeReminderId): Promise<OfficeOutcome<null>> {
    return this.perform('markReminderRead', [id], async () => {
      await this.ctx.office.markReminderRead(this.principal, id)
      return null
    })
  }

  /**
   * Edit contact details without changing this principal or authorization role.
   * @param profile - Complete public contact fields.
   * @returns committed employee or a business denial.
   */
  @Remote
  updateProfile(profile: OfficeProfile): Promise<OfficeOutcome<OfficeMember>> {
    return this.perform('updateProfile', [profile], () =>
      this.ctx.office.updateProfile(this.principal, profile),
    )
  }

  /**
   * Create or edit an employee through administrator authority and a reviewed record.
   * @param member - Complete employee fields.
   * @param expected - Null creates a new identity; a prior record protects an edit.
   * @returns Committed member or a business denial without overwriting another edit.
   */
  @Remote
  saveMember(
    member: OfficeMember,
    expected: OfficeMember | null,
  ): Promise<OfficeOutcome<OfficeMember>> {
    return this.perform('saveMember', [member, expected], () =>
      this.ctx.office.saveMember(this.principal, member, expected),
    )
  }

  /**
   * Read only this employee's private conversations and one bounded history page.
   * @param peer - Optional other participant.
   * @param before - Exclusive sequence for older history.
   * @returns Participant-authorized private projection.
   */
  @Remote
  chat(
    peer?: OfficeMemberId,
    before?: number,
  ): Promise<OfficeOutcome<OfficeChatView>> {
    return this.perform('chat', [peer ?? null, before ?? null], () =>
      this.ctx.office.chat(this.principal, peer, before),
    )
  }

  /**
   * Read only this Host employee's private unsent drafts.
   * @returns Authorized drafts and versions, or an expected denial.
   */
  @Remote
  chatDrafts(): Promise<OfficeOutcome<OfficeChatDraftView>> {
    return this.perform('chatDrafts', [], () =>
      this.ctx.office.chatDrafts(this.principal),
    )
  }

  /**
   * Read only the current employee's file-message limits and usage.
   * @returns Advertised inline-file policy, or an expected denial.
   */
  @Remote
  chatFileLimits(): Promise<OfficeOutcome<OfficeChatFileLimits>> {
    return this.perform('chatFileLimits', [], () => this.ctx.office.chatFileLimitsFor(this.principal))
  }

  /**
   * Publish a private message after its ordered files are durable and verified.
   * @param input - Stable original message identity, caption and bounded files.
   * @returns Published header with immutable file metadata.
   */
  @Remote
  sendMessageFiles(input: OfficeChatFilesInput): Promise<OfficeOutcome<OfficeChatMessage>> {
    return this.perform('sendMessageFiles', [input], () => this.ctx.office.sendMessageFiles(this.principal, input))
  }

  /**
   * Download one private message file as its active sender or recipient.
   * @param input - Message and opaque immutable attachment coordinates.
   * @returns Verified complete content without any server path.
   */
  @Remote
  downloadChatFile(input: OfficeChatFileCoordinates): Promise<OfficeOutcome<OfficeChatFileDownload>> {
    return this.perform('downloadChatFile', [input], () => this.ctx.office.downloadChatFile(this.principal, input))
  }

  /**
   * Read only the authenticated employee's file draft metadata and versions.
   * @returns Private contact selections and owner quota without inline file bytes.
   */
  @Remote
  chatFileDrafts(): Promise<OfficeOutcome<OfficeChatFileDraftView>> {
    return this.perform('chatFileDrafts', [], () => this.ctx.office.chatFileDrafts(this.principal))
  }

  /**
   * Save one reviewed private contact selection with bounded real bytes.
   * @param input - Exact retry UUID, contact version and ordered complete files.
   * @returns Durable metadata or a stable denial retaining the existing draft.
   */
  @Remote
  saveChatFileDraft(input: OfficeChatFileDraftInput): Promise<OfficeOutcome<OfficeChatFileDraft>> {
    return this.perform('saveChatFileDraft', [input], () => this.ctx.office.saveChatFileDraft(this.principal, input))
  }

  /**
   * Restore one file from the authenticated employee's own reviewed contact selection.
   * @param input - Contact, version and opaque file identity.
   * @returns Verified bounded bytes without granting the intended recipient draft access.
   */
  @Remote
  downloadChatFileDraft(input: OfficeChatFileDraftCoordinates): Promise<OfficeOutcome<OfficeChatFileDraftDownload>> {
    return this.perform('downloadChatFileDraft', [input], () => this.ctx.office.downloadChatFileDraft(this.principal, input))
  }

  /**
   * Publish the exact reviewed durable selection and reconcile its original clear-on-send decision.
   * @param input - Draft version, captured caption and stable message retry identity.
   * @returns One committed private file message; a retry never clears a newer selection.
   */
  @Remote
  sendChatFileDraft(input: OfficeChatFileDraftSendInput): Promise<OfficeOutcome<OfficeChatMessage>> {
    return this.perform('sendChatFileDraft', [input], () => this.ctx.office.sendChatFileDraft(this.principal, input))
  }

  /**
   * Save an unsent contact draft using a reviewed version and retry identity.
   * @param input - Contact, text, version and idempotency key.
   * @returns Committed draft or a conflict that preserves the user's local input.
   */
  @Remote
  saveChatDraft(
    input: OfficeChatDraftInput,
  ): Promise<OfficeOutcome<OfficeChatDraft>> {
    return this.perform('saveChatDraft', [input], () =>
      this.ctx.office.saveChatDraft(this.principal, input),
    )
  }

  /**
   * Send a private human message with an idempotent retry identity.
   * @param input - Message identity, recipient and text.
   * @returns Confirmed message or an expected denial.
   */
  @Remote
  sendMessage(
    input: OfficeChatInput,
  ): Promise<OfficeOutcome<OfficeChatMessage>> {
    return this.perform('sendMessage', [input], () =>
      this.ctx.office.sendMessage(this.principal, input),
    )
  }

  /**
   * Acknowledge an observed cursor in this employee's own conversation.
   * @param peer - Other participant.
   * @param through - Message sequence actually displayed to this employee.
   * @returns Durable acknowledgement or an expected denial.
   */
  @Remote
  readChat(
    peer: OfficeMemberId,
    through: number,
  ): Promise<OfficeOutcome<null>> {
    return this.perform('readChat', [peer, through], async () => {
      await this.ctx.office.readChat(this.principal, peer, through)
      return null
    })
  }

  /**
   * Read the configured office connection without exposing its secret session.
   * @returns Sanitized connection state or a business denial.
   */
  @Remote
  connection(): Promise<OfficeOutcome<OfficeConnection>> {
    return this.outcome<OfficeConnection>(async () =>
      this.gateway
        ? this.gateway.connection()
        : {
          mode: 'local',
          gateway: null,
          connected: true,
          member: this.ctx.office.view(this.principal).me,
          expiresAt: null,
        },
    ).then(result => { this.imageAdmissions.observe(result.ok ? result.value : null); return result })
  }

  /**
   * Inspect declared local integration packages through the existing profile manager without executing package operations.
   * @returns Actual package selection and Loader phases; gateway mode never represents the employee Host as its server.
   */
  @Remote
  integrationPlugins(): Promise<OfficeOutcome<OfficeIntegrationPlugins>> {
    return this.outcome(async () => {
      this.lifetime.signal.throwIfAborted()
      if (this.gateway) {
        const connection = await this.gateway.connection()
        this.lifetime.signal.throwIfAborted()
        if (!connection.connected || !connection.member) throw new OfficeError('unauthenticated', 'Office sign-in is required')
        return { meId: connection.member.id, mode: 'gateway', managementAvailable: false, packages: [] }
      }
      const member = this.ctx.office.view(this.principal).me
      const manager = this.ctx.get('pluginManager')
      const [bundles, plugins] = manager ? await Promise.all([manager.listBundles(), manager.listPlugins()]) : [null, []]
      this.lifetime.signal.throwIfAborted()
      const current = this.ctx.office.view(this.principal).me
      if (current.id !== member.id || current.role !== member.role) throw new OfficeError('forbidden', 'Office authority changed')
      return { meId: member.id, mode: 'local', managementAvailable: manager !== undefined,
        packages: integrationPluginRows(this.connectorPackages, bundles, plugins) }
    })
  }

  /**
   * Sign in to the configured central office and retain its token in the Host credential provider.
   * @param input - Employee id and password, with no claimed role.
   * @returns Sanitized connection state after the credential write completes.
   */
  @Remote
  signIn(input: OfficeLoginInput): Promise<OfficeOutcome<OfficeConnection>> {
    return this.outcome(() => this.changeImageConnection(() => this.requireGateway().signIn(input)))
  }

  /**
   * Revoke the central office session before clearing the exact local credential.
   * @returns Confirmation after durable server revocation and local credential cleanup.
   */
  @Remote
  signOut(): Promise<OfficeOutcome<null>> {
    return this.outcome(async () => {
      await this.changeImageConnection(() => this.requireGateway().signOut())
      return null
    })
  }

  /**
   * Read only the signed-in employee's device-session handles.
   * @returns Sanitized own-session metadata or a business denial.
   */
  @Remote
  identitySessions(): Promise<OfficeOutcome<readonly OfficeSessionInfo[]>> {
    return this.outcome(() => this.requireGateway().sessions())
  }

  /**
   * Revoke a session belonging to the current employee.
   * @param id - Public own-session handle.
   * @returns Confirmation after the server commit.
   */
  @Remote
  revokeIdentitySession(id: OfficeSessionId): Promise<OfficeOutcome<null>> {
    return this.outcome(async () => {
      await this.changeImageConnection(() => this.requireGateway().revoke(id))
      return null
    })
  }

  /**
   * Verify the old password, replace it and revoke every previous session.
   * @param input - Current and replacement passwords.
   * @returns Confirmation; the employee must then sign in again.
   */
  @Remote
  changeIdentityPassword(
    input: OfficePasswordChangeInput,
  ): Promise<OfficeOutcome<null>> {
    return this.outcome(async () => {
      await this.changeImageConnection(() => this.requireGateway().changePassword(input))
      return null
    })
  }

  /**
   * Discover a safe optional invitation capability without making it a login precondition.
   * @returns Capability from the configured gateway, or null for local, older or unavailable authorities.
   */
  @Remote
  memberInviteCapability(): Promise<OfficeOutcome<OfficeMemberInviteCapability | null>> {
    return this.outcome(() => this.gateway ? this.gateway.memberInviteCapability() : null)
  }

  /**
   * Read one managed member's latest invitation through current central administrator authority.
   * @param memberId - Existing company employee from the administrator's directory.
   * @returns Safe metadata and current independent facts without a code or hash.
   */
  @Remote
  memberInvite(memberId: OfficeMemberId): Promise<OfficeOutcome<OfficeMemberInviteView>> {
    return this.outcome(() => this.requireGateway().operation('memberInvite', [memberId]))
  }

  /**
   * Sign a reviewed first-password invitation through the selected central authority.
   * @param input - Current member/role, finite expiry and retained issuance request UUID.
   * @returns Original metadata; only the first committed response contains its nonrecoverable code.
   */
  @Remote
  issueMemberInvite(input: OfficeMemberInviteIssueInput): Promise<OfficeOutcome<OfficeMemberInviteIssueReceipt>> {
    return this.outcome(() => this.requireGateway().operation('issueMemberInvite', [input]))
  }

  /**
   * Revoke a reviewed invitation without removing an already-set credential.
   * @param input - Exact invitation id and observed revision.
   * @returns Retained revocation metadata after current administrator authorization.
   */
  @Remote
  revokeMemberInvite(input: OfficeMemberInviteRevokeInput): Promise<OfficeOutcome<OfficeMemberInvite>> {
    return this.outcome(() => this.requireGateway().operation('revokeMemberInvite', [input]))
  }

  /**
   * Accept a limited first-password code without signing in or replacing the current Host account.
   * @param input - Recipient-selected code and new password; no member or role override is accepted.
   * @returns Committed member id for the existing login form, or a safe denial.
   */
  @Remote
  acceptMemberInvite(input: OfficeMemberInviteAcceptInput): Promise<OfficeOutcome<OfficeMemberInviteAcceptReceipt>> {
    return this.outcome(() => this.requireGateway().acceptMemberInvite(input))
  }

  /**
   * Read credential-enrollment presence through central administrator authority.
   * @returns Enrollment presence without credential values, or a business denial.
   */
  @Remote
  identityOverview(): Promise<OfficeOutcome<OfficeIdentityOverview>> {
    return this.outcome(() =>
      this.requireGateway().operation('identityOverview', []),
    )
  }

  /**
   * Enroll or reset an active employee through central administrator authority.
   * @param memberId - Target employee from the managed directory.
   * @param password - Replacement password; no token or hash is returned.
   * @returns Confirmation after all target sessions have been revoked.
   */
  @Remote
  setIdentityPassword(
    memberId: OfficeMemberId,
    password: string,
  ): Promise<OfficeOutcome<null>> {
    return this.outcome(() =>
      this.requireGateway().operation('setIdentityPassword', [
        memberId,
        password,
      ]),
    )
  }

  /**
   * Read authorized formal organization or its explicit first-configuration state.
   * @returns Departments, positions and current affiliations without secret account data.
   */
  @Remote
  organization(): Promise<OfficeOutcome<OfficeOrganizationView>> {
    return this.perform('organization', [], () =>
      this.ctx.office.organization(this.principal),
    )
  }

  /**
   * Adopt the directory's reviewed department/position labels once through administrator authority.
   * @param officeRevision - Office revision displayed at the configuration review.
   * @returns Committed organization; repeated calls preserve existing formal assignments.
   */
  @Remote
  initializeOrganization(
    officeRevision: number,
  ): Promise<OfficeOutcome<OfficeOrganizationView>> {
    return this.perform('initializeOrganization', [officeRevision], () =>
      this.ctx.office.initializeOrganization(this.principal, officeRevision),
    )
  }

  /**
   * Create, edit or deactivate one reviewed department.
   * @param input - Opaque department, reviewed version, name and parent.
   * @returns Committed department after server authority and hierarchy validation.
   */
  @Remote
  saveOrganizationUnit(
    input: OfficeUnitInput,
  ): Promise<OfficeOutcome<OfficeOrganizationUnit>> {
    return this.perform('saveOrganizationUnit', [input], () =>
      this.ctx.office.saveOrganizationUnit(this.principal, input),
    )
  }

  /**
   * Create, edit or deactivate an administrator-managed position.
   * @param input - Position, department and reviewed version.
   * @returns Committed position; this does not grant an authorization role.
   */
  @Remote
  savePosition(
    input: OfficePositionInput,
  ): Promise<OfficeOutcome<OfficePosition>> {
    return this.perform('savePosition', [input], () =>
      this.ctx.office.savePosition(this.principal, input),
    )
  }

  /**
   * Change a formal employee affiliation through administrator authority.
   * @param input - Employee, department, position and observed assignment version.
   * @returns Committed formal affiliation, independent of editable profile labels.
   */
  @Remote
  assignOrganization(
    input: OfficeAssignmentInput,
  ): Promise<OfficeOutcome<OfficeOrganizationAssignment>> {
    return this.perform('assignOrganization', [input], () =>
      this.ctx.office.assignOrganization(this.principal, input),
    )
  }

  /**
   * Reserve a resumable file using the Host's current authenticated employee.
   * @param input - Reviewed immutable destination, length, digest and retry identity.
   * @returns An owner-only durable ticket or business denial.
   */
  @Remote
  beginDriveUpload(input: OfficeDriveUploadDeclaration): Promise<OfficeOutcome<OfficeDriveUploadTicket>> {
    return this.perform('beginDriveUpload', [input], () => this.ctx.office.beginDriveUpload(this.principal, input))
  }

  /**
   * Recover only the current employee's unfinished uploads.
   * @returns Private resumable tickets, excluding other employees and terminal history.
   */
  @Remote
  driveUploads(): Promise<OfficeOutcome<readonly OfficeDriveUploadTicket[]>> {
    return this.perform('driveUploads', [], () => this.ctx.office.driveUploads(this.principal))
  }

  /**
   * Resolve an owned upload after an uncertain response.
   * @param id - Server-minted upload coordinate.
   * @returns Confirmed receipt state or an indistinguishable missing/foreign denial.
   */
  @Remote
  getDriveUpload(id: OfficeDriveUploadId): Promise<OfficeOutcome<OfficeDriveUploadTicket>> {
    return this.perform('getDriveUpload', [id], () => this.ctx.office.getDriveUpload(this.principal, id))
  }

  /**
   * Stage one bounded chunk under current membership, session and directory permissions.
   * @param input - Owned upload, position, digest and canonical encoded bytes.
   * @returns Receipt positions only after durable acknowledgement.
   */
  @Remote
  appendDriveUpload(input: OfficeDriveUploadChunkInput): Promise<OfficeOutcome<OfficeDriveUploadTicket>> {
    return this.perform('appendDriveUpload', [input], () => this.ctx.office.appendDriveUpload(this.principal, input))
  }

  /**
   * Publish the reviewed complete file once after verifying all bytes.
   * @param id - Owned upload identity.
   * @returns A confirmed completed ticket or a retryable denial.
   */
  @Remote
  completeDriveUpload(id: OfficeDriveUploadId): Promise<OfficeOutcome<OfficeDriveUploadTicket>> {
    return this.perform('completeDriveUpload', [id], () => this.ctx.office.completeDriveUpload(this.principal, id))
  }

  /**
   * Cancel owned staging while retaining an already committed file after an uncertain completion response.
   * @param id - Server-owned upload coordinate.
   * @returns The confirmed terminal outcome.
   */
  @Remote
  cancelDriveUpload(id: OfficeDriveUploadId): Promise<OfficeOutcome<OfficeDriveUploadTicket>> {
    return this.perform('cancelDriveUpload', [id], () => this.ctx.office.cancelDriveUpload(this.principal, id))
  }

  /**
   * Authorize and verify a file before starting bounded downloads.
   * @param id - Logical enterprise file identity.
   * @returns Safe metadata, immutable version and negotiated range size.
   */
  @Remote
  driveFileInfo(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDriveDownloadInfo>> {
    return this.perform('driveFileInfo', [id], () => this.ctx.office.driveFileInfo(this.principal, id))
  }

  /**
   * Read version metadata using the employee's current file permissions.
   * @param id - Logical file identity.
   * @returns Authorized version history without content or retry credentials.
   */
  @Remote
  driveHistory(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDriveHistory>> {
    return this.perform('driveHistory', [id], () => this.ctx.office.driveHistory(this.principal, id))
  }

  /**
   * Read the employee's recoverable deleted roots.
   * @returns Authorized owner metadata and current restore capabilities.
   */
  @Remote
  driveTrash(): Promise<OfficeOutcome<OfficeDriveTrash>> {
    return this.perform('driveTrash', [], () => this.ctx.office.driveTrash(this.principal))
  }

  /**
   * Review the exact owned deleted subtree before irreversible cleanup.
   * @param id - Deleted root identity.
   * @returns Current scope totals and confirmation digest.
   */
  @Remote
  drivePurgePlan(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDrivePurgePlan>> {
    return this.perform('drivePurgePlan', [id], () => this.ctx.office.drivePurgePlan(this.principal, id))
  }

  /**
   * Submit the original reviewed permanent-cleanup confirmation.
   * @param input - Exact revision, digest and stable request identity.
   * @returns Durable pending or completed cleanup receipt.
   */
  @Remote
  purgeDrive(input: OfficeDrivePurgeInput): Promise<OfficeOutcome<OfficeDrivePurgeReceipt>> {
    return this.perform('purgeDrive', [input], () => this.ctx.office.purgeDrive(this.principal, input))
  }

  /**
   * Read an owner's existing cleanup status without touching bytes.
   * @param id - Original deleted root identity.
   * @returns Durable receipt, or null before approval.
   */
  @Remote
  drivePurgeStatus(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDrivePurgeReceipt | null>> {
    return this.perform('drivePurgeStatus', [id], () => this.ctx.office.drivePurgeStatus(this.principal, id))
  }

  /**
   * Continue only an already approved permanent cleanup.
   * @param id - Original approved root identity.
   * @returns Current durable status; a completed retry does not repeat metadata writes.
   */
  @Remote
  retryDrivePurge(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDrivePurgeReceipt>> {
    return this.perform('retryDrivePurge', [id], () => this.ctx.office.retryDrivePurge(this.principal, id))
  }

  /**
   * Confirm one reviewed owner deletion or restoration.
   * @param input - Exact revision, action and optional restore name.
   * @returns Confirmed metadata or a typed denial; versions and Native files remain retained.
   */
  @Remote
  changeDriveLifecycle(input: OfficeDriveLifecycleInput): Promise<OfficeOutcome<OfficeDriveEntry | OfficeDriveTrashEntry>> {
    return this.perform('changeDriveLifecycle', [input], () => this.ctx.office.changeDriveLifecycle(this.principal, input))
  }

  /**
   * Verify one historical file version before downloading its bytes.
   * @param id - Logical file identity.
   * @param versionId - Immutable authorized history selection.
   * @returns Verified version metadata and bounded download coordinates.
   */
  @Remote
  driveVersionInfo(id: OfficeDriveId, versionId: OfficeDriveVersionId): Promise<OfficeOutcome<OfficeDriveDownloadInfo>> {
    return this.perform('driveVersionInfo', [id, versionId], () => this.ctx.office.driveVersionInfo(this.principal, id, versionId))
  }

  /**
   * Read one immutable version range after fresh employee and ancestor authorization.
   * @param input - Reviewed file, version and bounded byte coordinates.
   * @returns Verified bytes and a range digest.
   */
  @Remote
  downloadDriveRange(input: OfficeDriveRangeInput): Promise<OfficeOutcome<OfficeDriveDownloadRange>> {
    return this.perform('downloadDriveRange', [input], () => this.ctx.office.downloadDriveRange(this.principal, input))
  }

  private async changeImageConnection<T>(operation: () => Promise<T>): Promise<T> {
    this.imageAdmissions.clear()
    try { return await operation() }
    finally { this.imageAdmissions.clear() }
  }

  private requireGateway(): OfficeGatewayClient {
    if (!this.gateway)
      throw new OfficeError(
        'invalid_input',
        'This Host uses a fixed local office identity',
      )
    return this.gateway
  }

  /**
   * Read this employee's private customization metadata through the selected office authority.
   * @param before - Exclusive own save position, or null for the newest page.
   * @returns Bounded own metadata without requirement bodies.
   */
  @Remote
  customizationRequests(before: number | null): Promise<OfficeOutcome<OfficeCustomizationPage>> {
    return this.perform('customizationRequests', [before], () => this.ctx.office.customizationRequests(this.principal, before))
  }

  /**
   * Read a currently authorized saved draft for explicit editing or export.
   * @param id - Server-issued request identity.
   * @returns Latest own record; this never sends externally.
   */
  @Remote
  customizationRequest(id: OfficeCustomizationId): Promise<OfficeOutcome<OfficeCustomizationRecord>> {
    return this.perform('customizationRequest', [id], () => this.ctx.office.customizationRequest(this.principal, id))
  }

  /**
   * Save reviewed private requirements without choosing a recipient or transport.
   * @param input - Strict fields, reviewed version and original retry UUID.
   * @returns Durable original receipt or an expected denial.
   */
  @Remote
  saveCustomizationRequest(input: OfficeCustomizationInput): Promise<OfficeOutcome<OfficeCustomizationSaveReceipt>> {
    return this.perform('saveCustomizationRequest', [input], () => this.ctx.office.saveCustomizationRequest(this.principal, input))
  }

  /**
   * Forward one strict knowledge operation through current employee authentication.
   * @param fileId - Reviewed source/query coordinates, without caller-selected authority.
   * @returns Current-authority result or structured Office denial.
   */
  @Remote
  knowledgePublication(fileId: OfficeDriveId): Promise<OfficeOutcome<OfficeKnowledgePublication | null>> {
    return this.perform('knowledgePublication', [fileId], () => this.ctx.office.knowledgePublication(this.principal, fileId))
  }

  /**
   * Forward one strict knowledge operation through current employee authentication.
   * @param input - Reviewed source/query coordinates, without caller-selected authority.
   * @returns Current-authority result or structured Office denial.
   */
  @Remote
  publishKnowledge(input: OfficeKnowledgePublishInput): Promise<OfficeOutcome<OfficeKnowledgePublication>> {
    return this.perform('publishKnowledge', [input], () => this.ctx.office.publishKnowledge(this.principal, input))
  }

  /**
   * Forward one strict knowledge operation through current employee authentication.
   * @param input - Reviewed source/query coordinates, without caller-selected authority.
   * @returns Current-authority result or structured Office denial.
   */
  @Remote
  withdrawKnowledge(input: OfficeKnowledgeWithdrawInput): Promise<OfficeOutcome<OfficeKnowledgePublication>> {
    return this.perform('withdrawKnowledge', [input], () => this.ctx.office.withdrawKnowledge(this.principal, input))
  }

  /**
   * Forward one strict knowledge operation through current employee authentication.
   * @param input - Reviewed source/query coordinates, without caller-selected authority.
   * @returns Current-authority result or structured Office denial.
   */
  @Remote
  searchKnowledge(input: OfficeKnowledgeSearchInput): Promise<OfficeOutcome<OfficeKnowledgeSearch>> {
    return this.perform('searchKnowledge', [input], () => this.ctx.office.searchKnowledge(this.principal, input))
  }

  /**
   * Forward one strict knowledge operation through current employee authentication.
   * @param input - Reviewed source/query coordinates, without caller-selected authority.
   * @returns Current-authority result or structured Office denial.
   */
  @Remote
  readKnowledgeCitation(input: OfficeKnowledgeCitationInput): Promise<OfficeOutcome<OfficeKnowledgeCitation>> {
    return this.perform('readKnowledgeCitation', [input], () => this.ctx.office.readKnowledgeCitation(this.principal, input))
  }

  /** @returns Current authorized groupList outcome. */
  @Remote
  groupList(): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['groupList']>>>> {
    return this.perform('groupList', [], () => this.ctx.office.groupList(this.principal))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized createGroup outcome. */
  @Remote
  createGroup(input: Parameters<CollaborationOfficeService['createGroup']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['createGroup']>>>> {
    return this.perform('createGroup', [input], () => this.ctx.office.createGroup(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized updateGroup outcome. */
  @Remote
  updateGroup(input: Parameters<CollaborationOfficeService['updateGroup']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['updateGroup']>>>> {
    return this.perform('updateGroup', [input], () => this.ctx.office.updateGroup(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized leaveGroup outcome. */
  @Remote
  leaveGroup(input: Parameters<CollaborationOfficeService['leaveGroup']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['leaveGroup']>>>> {
    return this.perform('leaveGroup', [input], () => this.ctx.office.leaveGroup(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized groupPage outcome. */
  @Remote
  groupPage(input: Parameters<CollaborationOfficeService['groupPage']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['groupPage']>>>> {
    return this.perform('groupPage', [input], () => this.ctx.office.groupPage(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized sendGroupMessage outcome. */
  @Remote
  sendGroupMessage(input: Parameters<CollaborationOfficeService['sendGroupMessage']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['sendGroupMessage']>>>> {
    return this.perform('sendGroupMessage', [input], () => this.ctx.office.sendGroupMessage(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized readGroup outcome. */
  @Remote
  readGroup(input: Parameters<CollaborationOfficeService['readGroup']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['readGroup']>>>> {
    return this.perform('readGroup', [input], () => this.ctx.office.readGroup(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized downloadGroupAttachment outcome. */
  @Remote
  downloadGroupAttachment(input: Parameters<CollaborationOfficeService['downloadGroupAttachment']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['downloadGroupAttachment']>>>> {
    return this.perform('downloadGroupAttachment', [input], () => this.ctx.office.downloadGroupAttachment(this.principal, input))
  }

  /** @returns Current authorized messagePreferences outcome. */
  @Remote
  messagePreferences(): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['messagePreferences']>>>> {
    return this.perform('messagePreferences', [], () => this.ctx.office.messagePreferences(this.principal))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized saveMessagePreferences outcome. */
  @Remote
  saveMessagePreferences(input: Parameters<CollaborationOfficeService['saveMessagePreferences']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['saveMessagePreferences']>>>> {
    return this.perform('saveMessagePreferences', [input], () => this.ctx.office.saveMessagePreferences(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized unifiedInbox outcome. */
  @Remote
  unifiedInbox(input: Parameters<CollaborationOfficeService['unifiedInbox']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['unifiedInbox']>>>> {
    return this.perform('unifiedInbox', [input], () => this.ctx.office.unifiedInbox(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized claimDesktopDelivery outcome. */
  @Remote
  claimDesktopDelivery(input: Parameters<CollaborationOfficeService['claimDesktopDelivery']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['claimDesktopDelivery']>>>> {
    return this.perform('claimDesktopDelivery', [input], () => this.ctx.office.claimDesktopDelivery(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized settleDesktopDelivery outcome. */
  @Remote
  settleDesktopDelivery(input: Parameters<CollaborationOfficeService['settleDesktopDelivery']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['settleDesktopDelivery']>>>> {
    return this.perform('settleDesktopDelivery', [input], () => this.ctx.office.settleDesktopDelivery(this.principal, input))
  }

  /** @returns Current authorized identityGovernance outcome. */
  @Remote
  identityGovernance(): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['identityGovernance']>>>> {
    return this.perform('identityGovernance', [], () => this.ctx.office.identityGovernance(this.principal))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized saveCentralPolicy outcome. */
  @Remote
  saveCentralPolicy(input: Parameters<CollaborationOfficeService['saveCentralPolicy']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['saveCentralPolicy']>>>> {
    return this.perform('saveCentralPolicy', [input], () => this.ctx.office.saveCentralPolicy(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized offboardMember outcome. */
  @Remote
  offboardMember(input: Parameters<CollaborationOfficeService['offboardMember']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['offboardMember']>>>> {
    return this.perform('offboardMember', [input], () => this.ctx.office.offboardMember(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized restoreMemberAccess outcome. */
  @Remote
  restoreMemberAccess(input: Parameters<CollaborationOfficeService['restoreMemberAccess']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['restoreMemberAccess']>>>> {
    return this.perform('restoreMemberAccess', [input], () => this.ctx.office.restoreMemberAccess(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized createMeetingSeries outcome. */
  @Remote
  createMeetingSeries(input: Parameters<CollaborationOfficeService['createMeetingSeries']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['createMeetingSeries']>>>> {
    return this.perform('createMeetingSeries', [input], () => this.ctx.office.createMeetingSeries(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized usageSummary outcome. */
  @Remote
  usageSummary(input: Parameters<CollaborationOfficeService['usageSummary']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['usageSummary']>>>> {
    return this.perform('usageSummary', [input], () => this.ctx.office.usageSummary(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized governanceAudit outcome. */
  @Remote
  governanceAudit(input: Parameters<CollaborationOfficeService['governanceAudit']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['governanceAudit']>>>> {
    return this.perform('governanceAudit', [input], () => this.ctx.office.governanceAudit(this.principal, input))
  }

  /** @param input - Explicit reviewed request. @returns Current authorized memberInvitePage outcome. */
  @Remote
  memberInvitePage(input: Parameters<CollaborationOfficeService['memberInvitePage']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['memberInvitePage']>>>> {
    return this.perform('memberInvitePage', [input], () => this.ctx.office.memberInvitePage(this.principal, input))
  }

  /** @param key - Explicit reviewed request. @returns Current authorized readUnifiedNotice outcome. */
  @Remote
  readUnifiedNotice(key: Parameters<CollaborationOfficeService['readUnifiedNotice']>[1]): Promise<OfficeOutcome<Awaited<ReturnType<CollaborationOfficeService['readUnifiedNotice']>>>> {
    return this.perform('readUnifiedNotice', [key], () => this.ctx.office.readUnifiedNotice(this.principal, key))
  }

  /** Read account-private office appearance and native assistants. @returns Current committed configuration. */
  @Remote
  experienceView(): Promise<ExperienceOutcome<OfficeExperienceView>> { return this.experience.view() }

  /** Save native assistant fields. @param revision - Reviewed revision. @param input - New or existing assistant. @returns Durable result. */
  @Remote
  saveExperienceAssistant(revision: number, input: OfficeAssistantInput): Promise<ExperienceOutcome<OfficeAssistant>> {
    return this.experience.saveAssistant(revision, input)
  }

  /** Save office-only appearance. @param revision - Reviewed revision. @param input - Reviewed fields. @returns Durable result. */
  @Remote
  saveExperienceAppearance(revision: number, input: OfficeAppearance): Promise<ExperienceOutcome<null>> {
    return this.experience.saveAppearance(revision, input)
  }

  /**
   * Verify actual submitted Office/PDF output through the Native-only authenticated employee BFF.
   * @param input - Original submitted coordinates, fixed recipe and independently requested text.
   * @param signal - Original Native cancellation.
   * @returns Real bounded structural/content evidence or an explicit business denial.
   */
  checkConversationDeliverable(input: OfficeDeliveryCheckInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeDeliveryCheck>> {
    const cancellation = AbortSignal.any([this.lifetime.signal, signal])
    return this.outcome(async () => {
      cancellation.throwIfAborted()
      const result = this.gateway
        ? await this.gateway.operation<OfficeDeliveryCheck>('checkConversationDeliverable', [input], cancellation)
        : await this.ctx.office.checkConversationDeliverable(this.principal, input, cancellation)
      cancellation.throwIfAborted()
      return result
    })
  }

  private perform<T>(
    method: string,
    args: readonly unknown[],
    action: () => T | Promise<T>,
  ): Promise<OfficeOutcome<T>> {
    return this.outcome(() =>
      this.gateway ? this.gateway.operation<T>(method, args) : action(),
    )
  }

  private async outcome<T>(
    action: () => T | Promise<T>,
  ): Promise<OfficeOutcome<T>> {
    try {
      return { ok: true, value: await action() }
    } catch (error) {
      if (error instanceof OfficeError) return { ok: false, code: error.code }
      throw error
    }
  }
}

/**
 * Mount the same Remote controller after its selected local or central dependency becomes available.
 * @param ctx - Employee Host plugin context.
 * @param config - Fixed local identity or central gateway URL.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.inject(
    config.gatewayUrl ? ['credentials'] : ['office'],
    async (child) => {
      await child.plugin(OfficeController, config)
    },
  )
}

/** Employee-host plugin selects its local office or central credential dependency before mounting Remotes. */
export default { Config: OfficeController.Config, apply }
