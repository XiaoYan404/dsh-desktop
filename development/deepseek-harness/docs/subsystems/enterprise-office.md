# Employee office domain

English | [中文](enterprise-office.zh.md)

The optional [office service](../../packages/enterprise/office/README.md) owns employee work records. The [office UI](../../packages/client/ui-office/README.md) adapts one authenticated local Host to this service. Agent Sessions and Agent schedules retain their own storage and execution owners.

The employee Host exposes `ctx.officeController` to trusted consumers. `OfficeOutcome<T>` returns either `{ ok: true, value: T }` or an expected `{ ok: false, code: OfficeErrorCode }`; unexpected infrastructure failures reject. `OfficeConnection` reports local or gateway mode, connection state and the authenticated employee without a session token. Requests never select their actor. The opt-in [native work tool](../../packages/enterprise/tool-office/README.md) uses this BFF; the office service remains the authorization owner.

The optional `OfficeView.calendarTime` contains `OfficeCalendarTimeView`: one server `checkedAt` and time decisions for the already authorized active and retained items. `OfficeCalendarItemTime` associates an `OfficeItemId` with a work deadline and overdue flag, meeting start/end instants and phase, or a safe `unresolved` marker. These derived fields leave persistence and status unchanged. The [service reference](../../packages/enterprise/office/README.md#use-this-package) owns company-time and failure rules; clients render decisions without using their own clock and retain the existing interface when the field is absent.

## Identity and authorization

Optional `OfficeMemberInviteConfig` enables bounded first-password invitations. `OfficeMemberInviteId` identifies a server-issued code; `OfficeMemberInviteView` carries safe reviewed state, while only the first `OfficeMemberInviteIssueReceipt` returns its raw code. The independent `enterprise_office_member_invites` version 1 domain retains revision and hash-only issuance/revocation entries. Acceptance commits only the original identity domain's first credential; existing credentials make every invitation unusable. Restore the directory, identity and invitation ledger from a consistent snapshot, because restoring an older identity can restore code eligibility. This domain leaves Native Session formats unchanged. The [service reference](../../packages/enterprise/office/README.md) owns issuance, rechecks and recovery.

`OfficeReminderConfig` explicitly enables central reminder polling with a bounded delay, catch-up window and retained-ledger entry/byte limits. `OfficeReminderId` is a server-created UUID for one recipient occurrence. `OfficeReminder` carries its recipient, item, `work_due` or `meeting_start` kind, occurrence and delivery times, personal read state and a currently authorized `itemTitle`; the title is not retained in the reminder ledger. Optional `OfficeView.reminders` returns `OfficeRemindersView` protocol 1 only when this feature is configured. `markReminderRead` rechecks the current recipient and item eligibility inside the shared office queue. The independent `enterprise_office_reminders` version 1 domain retains occurrence identities and read state; existing business notifications and Native Session formats keep their original schemas. The [service reference](../../packages/enterprise/office/README.md) owns delivery, capacity and shutdown rules.

Office input gestures prepare private choice metadata before the Native sender runs; an empty version-one selection records explicit office intent without adding capabilities. `OfficeController.prepareNativeInput` checks Native visibility and binds a Host-lifetime employee restriction before the separate prompt. Native preparation checks this restriction and rechecks the employee before a first office snapshot is admitted. Its existing-format snapshot supplies the durable affiliation used by subsequent reads and operations. Native workspace gestures retain their original path; merely enabling the overlay does not claim Native histories. Neither preparation nor the snapshot grants execution authority.

`OfficeDriveId` identifies enterprise metadata rather than a native path. `OfficeDriveQuery` selects a private or shared location and a name search; `OfficeDriveView` returns visible entries, breadcrumbs and creation authority. A private root belongs only to its employee, including when the other caller is an administrator. Shared root creation requires an administrator. Shared entry owners set inherited/default/account conditions through `OfficeDrivePermissionsInput`; editing personal department or job labels grants no authority. Every ancestor must remain visible before a child's explicit grant or ownership applies. Renaming requires edit permission on both the entry and its parent. `enterprise_office_drive` version 1 commits directory metadata and audit together; stale versions, invalid names and failed writes publish no change.

`OfficeDriveUploadInput` carries bounded encoded bytes, their declared size and a retry UUID. Immutable file objects are fsynced below `DSH_HOME/office/drive/v1/objects` before directory metadata publishes. `OfficeDriveDownload` contains only a currently authorized file's verified size, SHA-256 and bytes. Logical paths never become OS paths. The explorer selects the transfer API from advertised server capabilities. Backups include metadata and immutable objects; legacy whole-request failures can retain unreachable objects outside the resumable upload ledger.

`OfficeMemberId`, `OfficeItemId` and `OfficeNotificationId` are distinct branded identities. `OfficeProfile` contains public contact fields; `OfficeMember` adds identity, `OfficeRole` and active state. Roles are employee, manager or admin. Profile editing cannot change authority. Trusted adapters supply the actor; service operations recheck active membership when a queued write runs. The current UI uses a deployment-assigned local principal and does not provide enterprise SSO.

`OfficeLoginInput` accepts an employee id and password without a caller-claimed role. Trusted backend adapters receive `OfficeLoginResult` once, retain its secret token and expose only the authenticated member to the UI. `OfficeSessionId` and `OfficeSessionInfo` identify an employee's own sessions without granting authority. `OfficePasswordChangeInput` requires the current password; replacement revokes every old token. Administrator-only `OfficeIdentityOverview` reports enrollment presence without credential values. The separate version 1 identity domain stores salted password digests, session hashes and sanitized audit records, using the same write queue as membership changes. Startup refuses corrupt identities or missing directory data. The optional [central gateway](../../packages/enterprise/office-gateway/README.md) exposes an explicit office operation list, authenticates actual session tokens and rechecks queued requests. The employee Host stores its token through the native credential provider and returns sanitized connection state to the login/account UI; native Agent capabilities remain local. SSO remains pending.

`OfficeAuditQuery` selects bounded exact filters over seven `OfficeAuditSource` histories and an exclusive `OfficeAuditCursor`. `OfficeAuditPage` returns fresh `OfficeAuditRecord` metadata, current retained-match totals and an older continuation; `OfficeAuditExport` encodes one batch as NDJSON. Each request rechecks active administrator authority and copies only source, revision, actor, action, target and time. The `request_denial` source can additionally carry an allowlisted `denialCode`; the original six sources retain their exact fields. The [service reference](../../packages/enterprise/office/README.md#use-this-package) owns filtering, ordering and retention limits.

`OfficeRunHistoryState` is a Host-only fold with a nullable employee/role owner, `mixed` and `invalid` restrictions, and optional `inherited: true` and `pendingRole: true` markers. The child's own required inheritance record sets `inherited`; later input preserves it. `pendingRole` marks a first queued role until a claimed input or proven inheritance determines the role. Ownership cache state version 3 rebuilds older checkpoints. `OfficeRunInheritance` retains parent identity, owner and restrictions without a model-visible surface. The [employee Host reference](../../packages/client/ui-office/README.md#understand-the-implementation) owns legacy catalog recovery and missing-evidence limitations.

`OfficeRequestDenialScope` binds one of four server-selected mutation actions to a validated member, item or Drive target. `withSession` captures the authenticated employee before request admission; `executeOfficeRequest` registers the parsed action without accepting an actor field. The shared queue retains selected typed rejections in independent `enterprise_office_request_denials` version 1, directly awaiting its bounded write before returning the rejection. The existing queue drain also owns denial writes. No business success is published, and failed audit durability produces a safe unavailable response. The [service reference](../../packages/enterprise/office/README.md#use-this-package) owns included errors, capacity, backup and the separate administrator-search limitation. Existing business and Native Session formats are unchanged.

## Resumable drive protocol

The optional `OfficeDriveView.transfers` field advertises `OfficeDriveTransferLimits`: protocol 1, file size, shared employee quota, new-ticket chunk size, pending count and lifetime. Legacy whole-request bounds retain their own field. `OfficeDriveUploadId` is an opaque server ticket identity. `OfficeDriveUploadDeclaration` fixes the logical destination, name, byte length, media type, SHA-256 and retry UUID; `OfficeDriveUploadChunkInput` carries one bounded canonical chunk with its position and digest. `OfficeDriveUploadTicket` exposes only the owner's declaration, receipt positions, confirmed byte count, negotiated chunk size, timestamps, status and resulting file identity.

The separate `enterprise_office_uploads` version 1 domain shares membership and session serialization with the drive directory. Each staging or publication attempt rechecks destination access and quota. Identical chunk retries reuse immutable bytes; complete-file verification precedes directory publication. Receipt failure after directory commit is reconciled without a second file. Cancellation first saves a terminal decision; already published objects remain referenced. Expiry and terminal retention collect owned staging at startup, during upload operations and on the configured timer. Cleanup failures remain retained for retry; unpublished expired staging holds its reservation until cleanup succeeds. Original office and drive schemas remain unchanged.

`OfficeDriveDownloadInfo` returns checked metadata and `OfficeDriveVersionId` after complete-object verification. `OfficeDriveRangeInput` binds a bounded byte span to that immutable version. Every range rechecks current membership and all ancestors; `OfficeDriveDownloadRange` returns the bytes with a range digest. Clients verify the complete digest before saving. Existing whole-upload objects use the same immutable object directory and are readable through this protocol.

## Drive versions and recovery

`OfficeDriveView.cleanup: 1` advertises permanent cleanup. Its optional `OfficeDriveQuota` reports the current employee's `usedBytes`, `reservedBytes` and `limitBytes`. `OfficeDrivePurgePlan` contains the reviewed deleted entry, scope digest and file/folder/version/byte totals. `OfficeDrivePurgeInput` binds the entry id, revision, digest and branded `OfficeDrivePurgeRequestId`. `OfficeDrivePurgeReceipt` retains the root id, request id, pending/completed status, request/completion timestamps and the same totals. Trash entries expose `canPurge` and an optional receipt. Pending approval prevents restoration and retains its quota charge; completion hides that root from the recycle bin. See the [service contract](../../packages/enterprise/office/README.md#drive-version-history-and-recovery) for authorization and recovery.

`OfficeDriveView.lifecycle: 1` advertises version and recycle-bin methods. `OfficeDriveUploadDeclaration.target` optionally binds a replacement to a file id and reviewed revision. `OfficeDriveVersion` contains an immutable version id, SHA-256, byte length, media type, creation time, author and current-version flag. `OfficeDriveHistory` pairs the authorized entry with newest-first versions. `OfficeDriveTrashEntry` extends entry metadata with `deletedAt`; `OfficeDriveTrash` includes the current revision, employee id and visible deleted roots. `OfficeDriveLifecycleInput` selects an id, revision, `trash` or `restore` action and optional restore name. The [service reference](../../packages/enterprise/office/README.md#drive-version-history-and-recovery) owns authorization, quota accounting and recovery behavior.

## Private chat files

`OfficeChatFilesInput` extends `OfficeChatInput` with ordered `OfficeChatFileInput` values containing bounded inline bytes. `OfficeChatFileLimits` reports protocol 1, the current employee's usage, independent quota, file/count/message limits and recovery lifetime. The protocol caps decoded bytes per message at 8 MiB; drive resumability is separate. `OfficeChatMessage.attachments` optionally contains authorized `OfficeChatAttachment` metadata with opaque `OfficeChatAttachmentId`, filename, media type, byte length and SHA-256. `OfficeChatFileCoordinates` binds a download to its retained message; `OfficeChatFileDownload` contains verified complete bytes for an active participant, without an administrator bypass.

The independent `enterprise_office_chat_files` version 1 ledger declares immutable file identities before fsynced object writes under `DSH_HOME/office/chat/v1/objects`. Ready files precede the original text-chat header commit, which determines publication. A failed receipt is reconciled against that header on retry or startup, preserving one message and unchanged original chat schemas. Expired unpublished files are collected only from owned ledger records; cleanup failure retains quota. The retained chat watermark detects a lost original chat before startup or collection. Backups include the original chat, file ledger and objects together. Unsent selections use their own draft domain.

## Durable private file drafts

`OfficeChatFileDraftInput` replaces one reviewed contact selection using a stable retry UUID and bounded complete files. `OfficeChatFileDraft` exposes its version, immutable metadata and optional exact pending send. `OfficeChatFileDraftView` contains only the authenticated owner's records and draft quota. `OfficeChatFileDraftCoordinates` and `OfficeChatFileDraftDownload` restore a current owner's file; neither the intended recipient nor an administrator has a draft-read bypass. Empty selections retain version tombstones, and stale changes conflict without overwriting another window.

`enterprise_office_chat_file_drafts` version 1 atomically stores canonical bytes, checksums, versions and send recovery data. Its independent logical employee/office quotas bound the encoded storage unit; original text-draft and sent-file schemas remain unchanged. `OfficeChatFileDraftSendInput` fixes the message UUID, contact version and exact caption before publication through the immutable-file path. Only that original selection is cleared after confirmation. Startup and retries reconcile a failed clear against the retained original message; old retries cannot clear a newer selection. Draft events contain no content, and root unload drains accepted writes. The UI owns save indicators and conflict choices.

Optional `OfficeChatFileDraft.peer` reports the authorized current contact, including an inactive employee referenced by an own draft. That retained relationship permits a readonly empty chat projection without opening unrelated inactive contacts. Explicit empty saves clear only the reviewed version and preserve an already committed message; old queued draft sends cannot restore it. Clearing is permitted after quota reductions. File handles and encoded retries remain private to the UI owner; restored metadata can be sent through `sendChatFileDraft` without downloading all draft bytes first.

## Formal organization

Formal organization uses the separate `enterprise_office_organization` version 1 domain. `OfficeUnitId` and `OfficePositionId` identify persistent entities independently of editable labels. `OfficeOrganizationUnit` forms a bounded department hierarchy; `OfficePosition` may be company-wide or department-scoped. `OfficeOrganizationAssignment` retains a versioned affiliation, including explicit null unassignment. `OfficeOrganizationView` exposes the authorized active hierarchy to employees and retained inactive records to administrators. Its optional presence in `OfficeView` preserves existing projections until explicit setup.

Administrators first review the company, timezone and directory labels in Team. Initialization checks the reviewed directory revision; later `OfficeUnitInput`, `OfficePositionInput` and `OfficeAssignmentInput` require entity versions. The shared queue rechecks administrator authority. Cycles, incompatible positions, in-use deactivation and stale writes fail without publishing a change. Self-service contact edits cannot change formal affiliation or authorization. Empty `office/organization-changed` events invalidate authorized projections. A facility-level consumer drain barrier preserves admitted writes during whole-Host shutdown as well as individual office-plugin unload.

## Company integrations

Company integration manifests have their own `enterprise_office_integrations` version 1 domain. `OfficeIntegrationManifest` describes a system without connection secrets or code; `OfficeIntegrationId` identifies its durable `OfficeIntegration`. `OfficeIntegrationImportInput` contains the reviewed JSON and retry UUID. The shared queue checks current administrator authority, validates UTF-8 size and normalized name uniqueness, and commits the catalog with its import audit. `OfficeIntegrationView` supplies the shared catalog in `OfficeView`; an empty `office/integrations-changed` event triggers a fresh authorized read. Employees can inspect registrations; importing never installs plugins or establishes connectivity.

`OfficeConnectorAuthentication` selects a deployment-approved credential alias. `OfficeConnectorConfiguration` contains the adapter, base URL, relative probe path and enabled state; `OfficeConnectorInput` adds the registered integration, reviewed revision and retry UUID. Independent `enterprise_office_connectors` version 1 commits the saved configuration and audit without changing manifest or Session schemas. `OfficeConnectorEntry` projects `OfficeConnectorStatus`; only administrator entries include editable configuration. `OfficeConnectorView` contains current adapters and administrator-only origin/alias choices. Configuration readiness is always separate from a network result.

`OfficeConnectorProbeStatus` and `OfficeConnectorProbe` describe a single authorized, versioned network check without response content or secrets. `OfficeConnectorAdapter`, `OfficeConnectorProbeRequest` and `OfficeConnectorProbeResult` are Host-only extension types. Adapters receive freshly resolved private headers, an abort signal and a complete-response bound; their owned disposer aborts active work and removes availability. The built-in GET JSON adapter never follows redirects, and the office service owns administrator enforcement and the network/body deadline. The [package reference](../../packages/enterprise/office/README.md#company-connections) owns configuration and failure semantics. Office operations do not install native plugins or change MCP execution.

`OfficeConnectorActionDeclaration` adds explicit allowed roles to the public `OfficeConnectorActionView` id, label, description and read/write kind. `OfficeConnectorActionsView` returns one system's current readiness, saved connection revision, process-local adapter revision and role-admitted metadata. Registration freezes declarations and bounds the complete public response. Unavailable connections expose no actions; an adapter replacement during readiness resolution conflicts. `OfficeConnectorView.actionCatalog` advertises directory protocol and limits. The directory grants no execution authority, resolves no secret values and performs no network operation.

`OfficeConnectorReadInput` selects a declared read action and exact saved connection/provider versions. `OfficeConnectorActionsView.readSupported` advertises an installed read implementation. `OfficeConnectorReadRequest` supplies only server-authenticated employee identity and approved private connection inputs. `OfficeConnectorReadResult` and `OfficeConnectorReadReceipt` contain sanitized `OfficeConnectorReadData` only for `status: read`; other network statuses contain no data. The shared queue checks current roles, rejects write actions and stale providers, resolves credentials afresh, and rechecks the originating session before network admission and result disclosure. Count and complete UTF-8 receipt bounds reject invalid or oversized results. Adapter abort is cooperative and must settle after its work stops. Queries create no business writes, automatic retry, durable office execution history or model input.

`OfficeConnectorWriteInput` retains exact reviewed action/connection/provider coordinates, an employee retry UUID, optional native capture and bounded flat text values. `OfficeConnectorExecutionId` is a separate server-generated identity. Independent `enterprise_office_connector_executions` version 1 commits strictly ordered `OfficeConnectorExecutionStage` evidence. `OfficeConnectorExecutionReceipt` omits input values and maps `dispatched` to unknown status. Private receipt reads check the current authenticated employee; administrators do not bypass ownership. Internal queue-owned mutations reserve future audit/result space, freeze the result bound at admission and cannot re-dispatch a possibly sent operation. The [package contract](../../packages/enterprise/office/README.md#external-write-evidence) defines retry, quota and recovery semantics.

`OfficeConnectorActionField` declares a unique text input with its label, required flag and finite length. Optional `OfficeConnectorActionsView.writeSupported` advertises an installed trusted writer. `OfficeConnectorWriteRequest` extends the private read inputs with exact validated values, negotiated result bytes and the server execution id as external idempotency key. `OfficeConnectorWriteResult` admits only sanitized success, authoritative rejection or unknown. The queue-owned `writeConnectorAction` coordinator checks current role, reviewed versions and optional capture, persists dispatch before invoking the writer, and commits the result before returning success. Equivalent unresolved business inputs cannot replay under a new UUID. `execution_unknown` reports uncertainty without exposing its private diagnostic cause. The optional native consumer adds independent manual write approval and appends actual receipts to native model history; employee forms use the same coordinator; explicit outcome checks use the original execution identity without replay.

`OfficeConnectorExecutionQuery` selects a company registration and optional own last-entry cursor. `OfficeConnectorExecutionPage` returns bounded newest-first `OfficeConnectorExecutionSummary` metadata without raw inputs, result fields or audit arrays. `OfficeConnectorExecutionLimits`, advertised through `OfficeConnectorView.executionHistory`, fixes 20 rows and 32 KiB complete JSON per page and a detail bound of 4 MiB plus 4 KiB. Foreign and cross-system cursors reject; new admissions preserve stable older-page anchors. An explicit private detail read returns the retained receipt without executing any adapter. The employee UI fences page/detail callbacks across account, role, system and connection changes and distinguishes unknown outcomes from terminal success.

`OfficeConnectorReconcileRequest` reads an existing customer operation by its original execution id without business values or write dispatch. `OfficeConnectorExecutionCheck` returns the retained receipt and an explicit updated/unknown/unavailable/connection-changed state. `OfficeConnectorExecutionLimits.checks` optionally advertises this read protocol. Current roles, the original saved connection and the live checker registration govern admission; provider reload does not grant permission to query a changed location. The original result bound applies, authority is rechecked before private disclosure, and only durable authoritative evidence settles an unknown operation. The employee details view checks explicitly and fences stale responses without editing native model history.

`OfficeConnectorSyncId` identifies an immutable employee-private read outcome. `OfficeConnectorSyncInput` adds a retry UUID to reviewed read coordinates. `OfficeConnectorSyncSummary` contains the id, source coordinates, observation/synchronization times and actual network status. `OfficeConnectorSyncDetail` adds the employee id, current availability and nullable authorized data. `OfficeConnectorSyncQuery` selects a system and optional older id; `OfficeConnectorSyncPage` returns own metadata and the next anchor. Optional `OfficeConnectorSyncLimits` advertises protocol 1, page count and retained entry/byte bounds through `OfficeConnectorView.synchronization`. The [service reference](../../packages/enterprise/office/README.md#synchronized-read-records) owns durability, current access and retry behavior.

Local package observations use `OfficeIntegrationPlugin` to pair a deployment-declared adapter and package root with nullable installation, selection and actual Loader row counts. `OfficeIntegrationPlugins` identifies the authenticated employee, deployment mode, management availability and associated packages. `integrationPlugins` is read-only; gateway mode reports central ownership without substituting employee-local inventory. The [employee Host reference](../../packages/client/ui-office/README.md#local-integration-plugins) owns configuration and the Native handoff.

The opt-in `OfficeDingTalkConfig` supplies an enterprise-internal app key, private employee-to-union-id/calendar mappings, explicitly allowed operations and a bounded future calendar window. The registered `dingtalk` adapter consumes connection credential references, uses current app credentials for authentication and projects only mapped-employee task/event fields through the existing read/synchronization protocols. Optional `create_todo` uses the existing reviewed execution receipt, binds DingTalk `sourceId` to its server id and reconciles only through a matching-source/creator GET. `create_calendar` fixes the private calendar, sends `x-client-token` and contributes no attendees or unknown-event lookup. Optional adapter `reconcileActions` restricts lookup to supported write ids without changing legacy provider results or persisted receipts. The [office reference](../../packages/enterprise/office/README.md#company-connections) owns deployment, first-page limits, uncertain outcomes and customer-validation requirements.

The private `enterprise_office_dingtalk_messages` version 1 provider unit reserves original server execution ids before dispatch and retains sanitized acknowledgements. Employee/role and app/endpoint/content fingerprints fence replay; pending markers remain unknown across restart. Optional `send_message` requires an explicit robot and staff-id mapping, submits reviewed Markdown only to that employee and reports asynchronous platform acceptance. Original provider receipts recover a failed outer office receipt without another robot request; missing vendor acknowledgement remains unknown. Finite capacity, directory recovery and storage-close behavior are owned by the [office reference](../../packages/enterprise/office/README.md#message-provider-outbox). Declared write admission authorizes customer operations separately from provider reservation.

The opt-in `OfficeWeComConfig` identifies an internal app through `corpId`/`agentId`, explicit case-insensitive employee `members` and approved `profile` reads or reviewed `send_message` operations. The `wecom` adapter uses current credential references and a bounded, process-only token cache; profile reads expose only the employee's mapped name and position. Message submission fixes the recipient and application, bounds literal text at 2,048 UTF-8 bytes and reserves the original execution id in private `enterprise_office_wecom_messages` version 1 before dispatch. Original provider outcomes distinguish platform acceptance from delivery and recover an outer receipt failure without another message request. Each provider owns separate capacity; shared reservation mechanics retain the DingTalk unit's identity/schema. The [office reference](../../packages/enterprise/office/README.md#company-connections) owns official sources, deployment, token expiry/disposal and customer commissioning.

## Private customization requests

`OfficeCustomizationId` identifies an employee-owned request. `OfficeCustomizationFields` contains the system or skill name, contact person and literal multiline requirements; `OfficeCustomizationInput` adds the reviewed revision and retry UUID, with null identity and revision zero for creation. `OfficeCustomizationRecord` adds server-owned company, employee, revision, timestamps and `delivery: 'not_sent'`. `OfficeCustomizationSaveReceipt` returns the original committed record and current revision, including after later edits. Neither employee nor administrator can read another employee's request.

The optional `OfficeView.customizations` advertises `OfficeCustomizationLimits`: protocol 1, twenty metadata entries per page and configured operation/UTF-8 byte bounds. `OfficeCustomizationPage` excludes contact and requirement bodies. `customizationRequests` uses an exclusive employee-local save position; `customizationRequest` reads the latest own version; `saveCustomizationRequest` commits through the shared office queue. The separate `enterprise_office_customizations` version 1 domain retains immutable save receipts and requires the original employee directory during recovery. No operation sends externally; the employee UI exports a reviewed saved version for delivery through an approved channel.

## Private conversation associations

`OfficeConversationConnectorInput` limits directory discovery to a system in the employee's private submitted capture. `OfficeConversationConnectorReadInput` adds that capture to exact read coordinates. The current role, private choice version and captured connection version must match. Native approval does not bypass these checks. The optional office-tool consumer records discovery and real business results through the original native tool-result log; office domain schemas remain unchanged.

`OfficeConversationId` identifies a logical native conversation within one authenticated employee's private choices. It grants no access to native history or execution. `OfficeToolReference` names a user-facing native skill or office request template. `OfficeConversationLinks` retains a reviewed selection version; `OfficeConversationLinksInput` edits one list with a retry UUID. Independent `enterprise_office_conversation_links` version 1 stores these drafts without changing Session, manifest or connection schemas. Empty selections retain their versions. Administrators receive no private-choice bypass.

`OfficeToolRequirement` resolves deployment-declared integration registration names to current ids and explicit missing names. Selecting tools adds their registered dependencies; an explicit integration edit may remove one without removing the tool. `OfficeConversationLinksView` includes the employee id, current draft, requirements and `OfficeConversationLinkLimits`. Registration resolution does not attest connectivity or grant execution permission. The shared queue rechecks current employee/session authority, and failed persistence publishes no change. Empty `office/conversation-links-changed` notifications invalidate authorized reads. The [package reference](../../packages/enterprise/office/README.md#conversation-associations) owns bounds and configuration.

`OfficeConversationCaptureInput` identifies a reviewed version and prompt retry id. `OfficeConversationCaptureId` is private to the authenticated employee, never a bearer credential. `OfficeConversationCapture` freezes that version with historical employee role, declared requirements, digest and `OfficeCapturedIntegration` records containing descriptive metadata and configuration readiness. Independent `enterprise_office_conversation_captures` version 1 retains prepared evidence without changing editable choices or native Session history. Exact retries recover the original context after later changes; another employee or administrator cannot read it. Entry, total-byte and individual-context bounds fail without partial publication. Preparation records neither native admission nor execution. The [package reference](../../packages/enterprise/office/README.md#prepared-contexts) owns retention, byte accounting and failure semantics.

`OfficeConversationFileReference` identifies authority-resolved immutable drive metadata. `OfficeConversationFiles` is one employee's versioned selection for a logical native conversation; `OfficeConversationFilesInput` supplies only reviewed coordinates and a retry UUID. The independent `enterprise_office_conversation_files` version 1 domain stores these selections and submitted file evidence without changing the existing integration/tool association domains. A selection holds at most 20 distinct files; retention admits 10,000 selections, 10,000 captures and at most 64 MiB of compact domain JSON.

`OfficeConversationFileLimits` advertises the submitted-file protocol and its fixed text bounds. Its optional `pdf.maxBytes`, `docx.maxBytes` and `xlsx.maxBytes` capabilities independently permit their formats within the current authority's input-byte limits; omission leaves that format unavailable, and older authorities without these capabilities retain text-only selection. `OfficeConversationFilesView` adds the current employee id, role and limits to the private selection without changing its persisted value. Optional `conversationFiles` metadata on `OfficeView` and `OfficeConversationLinksView` lets consumers retain ordinary operation against older authorities. The employee Host prepares an `OfficeFilesPromptContextSource` with kind `office-files` before native admission, withholding mixed identities, changed roles and cancelled preparations. Its attributed snapshot enters the original context log; the optional `office_read_file`, `office_read_pdf`, `office_read_docx` and `office_read_xlsx` tools supply separately authorized content through ordinary tool results.

`OfficeConversationFilesCaptureId` identifies private submitted evidence, never an access credential. `OfficeConversationFilesCapture` freezes the reviewed selection, employee, role, request identity and integrity digest. Preparation and exact retry recheck current file authority and version. `OfficeConversationFileReadInput` requests a selected file and a bounded text window; `OfficeConversationFileRead` returns verified UTF-8 text and its immutable metadata through `readConversationFile`. Each read checks capture ownership, current role, active membership, ancestor permissions, latest version and SHA-256. This text reader limits files to 1 MiB and character budgets to 16,384 UTF-16 code units; offsets cannot split a surrogate pair, and a terminal surrogate pair is completed before returning the next offset. Binary, invalid encoding and denied text reads return no body. These service APIs do not themselves attach context to a native submission.

`OfficeConversationPdfReadInput` extends the submitted-file window with a one-based `pageNumber` for the separate `readConversationPdf` path. `OfficeConversationPdfRead` returns verified immutable file metadata, the actual page number and page count, extracted text, and page-relative `offset`, `nextOffset`, `totalCharacters` and `eof`. Continuation stays within that one page. Every call rechecks current submitted-file authority and version before reading and again before returning the parsed result. Scanned pages can contain no selectable text; this reader performs no OCR. Encrypted, damaged, unauthorized and over-budget PDFs disclose no body.

`OfficeConversationPdfConfig` supplies deployment overrides through `conversationPdf` for input bytes, total document pages, extracted page characters, complete escaped native tool-content JSON bytes, worker deadline and V8 old-generation heap. The [office package reference](../../packages/enterprise/office/README.md#prepared-contexts) owns their defaults, isolated parser lifecycle, final queued authorization check and cancellation behavior. The parser retains no complete-document cache or native attachment copy; actual bounded text enters the original native result log through its tool consumer.

`OfficeConversationDocxReadInput` uses the submitted-file capture, selected file and bounded UTF-16 window for the separate `readConversationDocx` path. `OfficeConversationDocxRead` returns verified immutable metadata, body paragraph/table counts, actual text and body-relative `offset`, `nextOffset`, `totalCharacters` and `eof`. Tabs separate source-order table cells; line breaks separate paragraphs and table rows. Each call rechecks current submitted-file authority and version before reading and before publishing its parsed result. Headers, footnotes, comments, drawings, pagination and OCR are outside this reader; malformed, macro-document, unauthorized and over-budget input returns no body.

`OfficeConversationDocxConfig` supplies deployment overrides through `conversationDocx` for compressed bytes, ZIP entry count, total declared expansion, parsed XML bytes, visited nodes, extracted text, complete escaped native tool-content JSON bytes, worker deadline and V8 old-generation heap. The [office package reference](../../packages/enterprise/office/README.md#prepared-contexts) owns defaults, exact extraction scope, isolated worker termination and cancellation, and the final queued authority check. DOCX uses no complete-document cache or native attachment copy; its tool consumer records the actual bounded result in the original native log.

`OfficeConversationXlsxReadInput` identifies the submitted capture/file, one-based workbook-order `sheetNumber`, stored-cell `offset` and `maxCells` (1–256). `OfficeConversationXlsxRead` returns immutable file metadata, the bounded `OfficeConversationXlsxSheet` directory, workbook `dateSystem`, selected sheet number, exact cell continuation and `eof`. Stored cells follow row/column order, including explicit blanks; sparse gaps and merged ranges do not expand. Directory entries retain names, order, hidden state and stored-cell counts. Each read verifies actual bytes and SHA-256 before parsing; the final office queue rechecks current identity, capture role, ancestor access and latest version.

`OfficeConversationXlsxCell` retains address, row/column, hidden flags, typed `value`, exact XML `rawValue`, number format and original formula text/type/shared-index/range. Numeric values and date serials stay strings; `dateSystem` supplies the 1900/1904 epoch. Shared strings retain their raw table index, while boolean raw values retain `0`/`1`. Formula `cacheState` is `not_formula`, `missing` or `present_may_be_stale`; zero, false and empty-string caches remain distinct from absence. No formula is evaluated, shared reference expanded or external target fetched. Cell values and formulas are inert untrusted data.

`OfficeConversationXlsxConfig` supplies `conversationXlsx` bounds for compressed/expanded archive bytes, entries, XML bytes/nodes, worksheets, stored cells, text, complete escaped native-content JSON bytes, deadline and heap. The [office package reference](../../packages/enterprise/office/README.md#prepared-contexts) owns defaults, macro/external-dependency rejection, parser scope, worker termination/cancellation and exact raw-value interpretation. Only whole cells fit the complete result budget; a directory or first cell that cannot fit fails without a partial value. No complete-document cache, native attachment copy or persistence-format change is introduced.

## Captured Agent work

`OfficeAgentWorkInput` identifies one internal task/to-do creation by private capture and execution UUID. `OfficeAgentWorkReceipt` returns the stable request coordinates and current authorized item. New writes recheck the employee, capture ownership, role, reviewed reminder selection and declared dependencies. Independent `enterprise_office_agent_work` version 1 reserves the server-issued item identity before the work-domain commit; recovery reconciles that item instead of creating another. Exact committed retries are reads, while unfinished retries revalidate current execution authority. The [package reference](../../packages/enterprise/office/README.md#agent-work-execution) owns retention, readiness and failure semantics.

## Company announcements

`OfficeAnnouncementId` identifies an immutable publication; `OfficeAnnouncementInput` carries plain text, delivery scope and a stable retry UUID. The separate `enterprise_office_announcements` version 1 domain commits publication and current active recipients atomically. Only administrators publish or withdraw; recipients acknowledge only their own active deliveries. `OfficeAnnouncement` excludes other employees' read receipts, and optional `OfficeAnnouncementView` in `OfficeView` supports older servers. Company-wide delivery is frozen at publication and does not include later hires. Withdrawal retains text and receipts for administrator management. Empty `office/announcements-changed` events trigger authorized reads. The UI combines deliveries with the item inbox and pauses homepage rotation while users read or request reduced motion.

## Work and invitations

`OfficeTaskDeliveryInput` selects submit, accept or return with a nonempty reason. Optional task-only `OfficeItem.deliveries` retains `OfficeTaskDelivery` actor, then-current assignee, time and parent revision. Only the assignee submits in-progress tasks; the creator or an administrator reviews. A current submission is the latest submit entry matching both item revision and assignee. Intervening changes require resubmission. Acceptance completes the task; return preserves in-progress status. Tasks with delivery history complete only through explicit acceptance; other tasks retain ordinary status operations. `delivery_submitted`, `delivery_accepted` and `delivery_returned` notices and audit commit with history; the [delivery upgrade guide](../upgrade-guide/v0.2.1-alpha.2/office-task-delivery/guide.md) defines compatibility.

Optional `OfficeItem.subtasks` retains up to 100 `OfficeSubtask` entries with an `OfficeSubtaskId`, title and completion flag. `OfficeWorkSubtasksInput` replaces the reviewed list; null ids create server identities, and existing ids must belong to that work item. The creator, current assignee or administrator can edit open tasks/to-dos. Entries inherit parent access. A change commits `work_subtasks_updated` audit and recipient notices with the item. The [subtask upgrade guide](../upgrade-guide/v0.2.1-alpha.2/office-work-subtasks/guide.md) describes older-reader refusal.

`OfficeScheduleAvailabilityInput` carries an office-local date, start/end interval, up to 500 member ids and an optional readable meeting to exclude. `OfficeScheduleAvailability` returns unique members' boolean busy flags, timezone and observation time, without meeting ids or content. Only active employees and active queried members are admitted. The deployment's `scheduleAvailabilityEnabled` opt-in controls this separate read operation; omitted `OfficeView.scheduleAvailabilityEnabled` means sharing is unavailable. See the [office package](../../packages/enterprise/office/README.md#use-this-package) for occupancy and privacy rules.

`OfficeWorkInput` creates a task or to-do. `OfficeScheduleInput` creates a same-day meeting with a valid start/end interval and invitees. A committed `OfficeItem` retains its creator, owner, date, description and revision. `OfficeItemStatus` is pending, in_progress, completed or cancelled. `OfficeParticipant` records a member's `OfficeInvitationReply`: pending, accepted or declined. The organizer starts accepted and cannot decline their own meeting.

Only the creator, owner or administrator can change ordinary work status. Only the organizer or administrator changes meeting status. Invitees reply only for themselves. Per-item revision checks reject stale changes without overwriting a newer record. Missing and invisible records share the same denial.

`OfficeScheduleUpdateInput` edits an open meeting's title, date, start/end interval, location, description and optional `inviteeIds`. Omitting invitees preserves membership; an empty array leaves only the organizer. Identity, organizer and lifecycle remain unchanged. Only its creator or an administrator may submit the reviewed revision. New invitees must be active and receive `invited` notices. Removed ordinary members lose access and retain `schedule_removed` notices with the previous title. Date or time changes reset non-organizer replies to pending; other edits preserve retained replies. Member changes commit `schedule_members_updated` audit entries; other edits retain `schedule_updated`. Items, recipient notifications and audit commit together; unchanged content and membership commit nothing. The [membership compatibility guide](../upgrade-guide/v0.2.1-alpha.2/office-schedule-members/guide.md) defines coordinated deployment and older-reader refusal.

`OfficeTaskDecisionInput` is an explicit accept, reject-with-reason or transfer-with-reason operation. Only the current assignee accepts or rejects a pending task; its assignee, creator or an administrator may transfer an open task to a different active owner, resetting it to pending. `OfficeItem.taskActions` optionally retains ordered `OfficeTaskAction` records with the action, item revision, actor, previous/new owner, reason and time. Existing status updates preserve that history. Decisions commit their item, `task_accepted`/`task_rejected`/`task_transferred` notifications and matching audit together. An optional notification `itemTitle` preserves the title for a former owner without granting continued task access. The [task compatibility guide](../upgrade-guide/v0.2.1-alpha.2/office-task-decisions/guide.md) defines older-reader refusal.

`OfficeWorkUpdateInput` contains a task/to-do's editable title, description, local date and optional due time, without kind, status or assignee. A current creator, assignee or administrator may edit an open item on its reviewed revision; omitting time clears it. Item identity and task action history are preserved. Changed content commits `work_updated` notifications and audit with the item; unchanged content commits nothing. The [work-edit compatibility guide](../upgrade-guide/v0.2.1-alpha.2/office-work-edits/guide.md) defines coordinated deployment and older-reader refusal.

Optional `OfficeItem.priority` uses `OfficeWorkPriority`: low, normal, high or urgent. Creation defaults to normal and retains its existing tool schema. `OfficeWorkUpdateInput.priority` may be omitted to preserve the current value; explicit normal removes a non-default value. A semantic change commits `work_prioritized` notifications and audit atomically with the item, including when returning to normal. Work lists retain their date/time ordering. The [priority compatibility guide](../upgrade-guide/v0.2.1-alpha.2/office-work-priority/guide.md) defines coordinated upgrades and older-reader refusal.

`OfficeTodoAssignment` narrows the assignee-history fields to transfer operations. Optional `OfficeItem.todoAssignments` retains ordered assignment records, separately from task decisions. The transfer branch of `OfficeTaskDecisionInput` reassigns an open to-do to another active member and resets it to pending; accept/reject remain invalid for to-dos. Authorization, revision checks and reason requirements match task transfers. The item, `todo_reassigned` notifications and audit commit atomically; content and status edits preserve the assignment history. The [to-do compatibility guide](../upgrade-guide/v0.2.1-alpha.2/office-todo-assignment/guide.md) defines older-reader refusal.

## Projections and durable commits

`OfficeView` contains the authorized directory, records and notifications plus an `OfficeDay` projection. Today follows the configured IANA time zone. Timed work sorts before untimed work; closed records remain visible. Cancelled work is excluded from completion's denominator.

Only administrators receive the full `managedMembers` directory, including inactive identities. New-member writes require an unused ID; editing with a reviewed member record rejects concurrent changes inside the commit queue. The final active administrator must remain active with the administrator role. Ordinary contacts and assignment pickers receive only active members.

`OfficeNotification` belongs to one recipient. `OfficeAuditEntry` records an operation, actor, target and time; only administrators can read audit history. A whole-domain commit persists items, participation, notifications and audit together through `enterprise_office` version 1. A failed storage commit publishes none of them. Post-commit observer errors cannot turn a successful write into a business failure. Multi-Host transactional storage, pagination and retention remain pending.

`OfficeErrorCode` distinguishes invalid_input, forbidden, not_found, conflict, duplicate_name, closed, unauthenticated, rate_limited, conversation_capacity, context_too_large and execution_unknown. Adapters localize expected denials and unconfirmed external outcomes; unexpected storage failures remain exceptional, with post-dispatch diagnostics retained only in a private cause. Office reads and writes register no model tools and inject no model context.

## Cordis surface

Private contact drafts use `enterprise_office_chat_drafts` version 1. `OfficeChatDraftView` is scoped to the active employee, including for administrators; `OfficeChatDraftInput` carries a reviewed contact version and retry UUID. Saving returns `OfficeChatDraft`. Empty-text tombstones prevent stale-window resurrection. The UI keeps local edits during pending writes, retries uncertain writes with the same identity and requires an explicit conflict choice. No draft text is broadcast or stored in browser storage. Save confirmation is required before relying on reload recovery; the latest debounced edits are not durable until then.

Private text chat uses the separate `enterprise_office_chat` domain. `OfficeChatInput` carries a client-generated `OfficeMessageId` and recipient; idempotent retries retain one `OfficeChatMessage`. `OfficeChatView` exposes only the caller's `OfficeChatThread` list and one bounded conversation page. An `OfficeChatPeer` contains only identity, display name and active state. Administrators receive no private-history bypass. Read cursors must belong to the exact employee pair. The shared mutation queue rechecks membership before sending or acknowledging, and disposal drains all office domains. `office/chat-changed` invalidates private projections without broadcasting message text.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxoffice--officeservice"></a>

### `ctx.office` — `OfficeService`

Employee work lifecycle. Returned records are borrowed read-only; callers must not mutate them.

```ts cordis-catalog
/**
 * Read employee contacts, their work and inbox; administrators see all work.
 * Company today and item time decisions share one server observation. A known invalid item time
 * marks only that item unresolved; unexpected failures reject the read. No status or reminder is written.
 * @param actorId - Authenticated identity supplied by a trusted adapter.
 * @param date - Existing local day; omission selects today in the configured office timezone.
 * @returns authorized projection; throws forbidden for absent/inactive employees.
 */
view(actorId: OfficeMemberId, date?: string): OfficeView

/**
 * Query active coworkers' internal meeting occupancy only after deployment consent.
 * @param actorId - Current authenticated active employee.
 * @param input - Office-local date and interval, up to 500 members and an optional readable meeting to exclude.
 * @returns Unique requested members' busy flags and observation time, without meeting ids or content.
 * Pending and accepted invitations occupy time; closed meetings and declined invitations do not. No writes or reservations occur.
 */
scheduleAvailability(actorId: OfficeMemberId, input: OfficeScheduleAvailabilityInput): OfficeScheduleAvailability

/**
 * Register a descriptive company manifest through current administrator authority.
 * @param actorId - Authenticated active employee, rechecked inside the shared queue.
 * @param input - Bounded JSON object and stable UUID for an uncertain-response retry.
 * @returns Durable registration without installing or activating plugin code.
 */
importIntegration(actorId: OfficeMemberId, input: OfficeIntegrationImportInput): Promise<OfficeIntegration>

/**
 * Register a trusted Host connector implementation, independently of native MCP and plugin installation.
 * @param adapter - Unique implementation; abort must stop its outstanding probe before settlement.
 * @returns Disposer to attach to the contributing plugin's effect; removal aborts its probe.
 */
registerConnector(adapter: OfficeConnectorAdapter): () => void

/**
 * Read current company connection readiness without returning credential values.
 * @param actorId - Authenticated active employee; only administrators receive editable configuration.
 * @returns Adapter availability, versions and current credential presence, without a connectivity claim.
 */
connections(actorId: OfficeMemberId): Promise<OfficeConnectorView>

/**
 * Explicitly synchronize a reviewed declared read and persist its actual sanitized outcome.
 * @param actorId - Authenticated current employee, never selected in the request body.
 * @param input - Stable retry identity and exact action/connection/provider coordinates.
 * @returns Durable original record and currently authorized data; failed storage reports no success.
 */
syncConnectorAction(actorId: OfficeMemberId, input: OfficeConnectorSyncInput): Promise<OfficeConnectorSyncDetail>

/**
 * List only this employee's synchronization metadata without querying the company system.
 * @param actorId - Active authenticated employee, checked inside the office queue.
 * @param query - One company registration and optional owner-scoped older anchor.
 * @returns Bounded records without retained fields, credentials or customer response bodies.
 */
connectorSyncPage(actorId: OfficeMemberId, query: OfficeConnectorSyncQuery): Promise<OfficeConnectorSyncPage>

/**
 * Recheck current role, declared read and saved connection before delivering historical retained fields.
 * @param actorId - Active authenticated owner; administrators have no private-data bypass.
 * @param id - Server synchronization identity.
 * @returns Historical metadata with data withheld after authorization or connection changes; no customer GET occurs.
 */
connectorSyncDetail(actorId: OfficeMemberId, id: OfficeConnectorSyncId): Promise<OfficeConnectorSyncDetail>

/**
 * Read private customization metadata without sending requirements outside the office.
 * @param actorId - Active authenticated employee.
 * @param before - Exclusive employee-local save position, or null for newest records.
 * @returns A bounded own page with no contact or requirement bodies.
 */
customizationRequests(actorId: OfficeMemberId, before: number | null): Promise<OfficeCustomizationPage>

/**
 * Read the current own draft for editing or explicit export.
 * @param actorId - Current authenticated employee; administrators have no owner bypass.
 * @param id - Server-created customization identity.
 * @returns Latest saved private version, explicitly marked not sent.
 */
customizationRequest(actorId: OfficeMemberId, id: OfficeCustomizationId): Promise<OfficeCustomizationRecord>

/**
 * Persist a reviewed requirement version; this operation has no external delivery side effect.
 * @param actorId - Authenticated employee, never accepted in the input.
 * @param input - Exact retry identity, reviewed version and plain-text fields.
 * @returns Original durable receipt plus the current revision; failed persistence reports no success.
 */
saveCustomizationRequest(actorId: OfficeMemberId, input: OfficeCustomizationInput): Promise<OfficeCustomizationSaveReceipt>

/**
 * Discover one system's current role-admitted business-action declarations without executing them.
 * @param actorId - Authenticated employee, rechecked in the shared office queue.
 * @param integrationId - Company system identity; callers cannot choose a URL or role.
 * @returns Bounded public metadata and current connection/registration coordinates, without credentials.
 */
connectorActions(actorId: OfficeMemberId, integrationId: OfficeIntegrationId): Promise<OfficeConnectorActionsView>

/**
 * Read the current employee's retained external-operation receipts without request values or an administrator bypass.
 * @param actorId - Active authenticated employee, rechecked in the shared office queue.
 * @returns Own evidence only; a dispatched request remains unknown until its authoritative outcome is durable.
 */
connectorExecutions(actorId: OfficeMemberId): Promise<readonly OfficeConnectorExecutionReceipt[]>

/**
 * Read a newest-first bounded page of this employee's executions in one company system.
 * @param actorId - Current authenticated employee; administrators have no private history override.
 * @param query - System registration and optional own older-page anchor.
 * @returns Small receipt metadata without raw inputs, audit arrays or large business results.
 */
connectorExecutionPage(actorId: OfficeMemberId, query: OfficeConnectorExecutionQuery): Promise<OfficeConnectorExecutionPage>

/**
 * Read one employee-private bounded execution receipt, including retained authoritative result and audit stages.
 * @param actorId - Current authenticated employee, selected by the server rather than a request payload.
 * @param executionId - Own server-generated execution identity.
 * @returns The retained receipt; unlinked adapters do not erase history and another employee's id remains unavailable.
 */
connectorExecutionDetail(actorId: OfficeMemberId, executionId: OfficeConnectorExecutionId): Promise<OfficeConnectorExecutionReceipt>

/**
 * Check an own possibly committed customer operation by its original execution identity without resending it.
 * @param actorId - Current authenticated employee; current role, original connection and session remain authoritative.
 * @param executionId - Own retained server idempotency identity, never caller-selected transport parameters.
 * @returns Retained unknown/unavailable evidence or a newly durable authoritative receipt; checking never dispatches a write.
 */
checkConnectorExecution(actorId: OfficeMemberId, executionId: OfficeConnectorExecutionId): Promise<OfficeConnectorExecutionCheck>

/**
 * Submit one reviewed declared customer-system write through durable, employee-private execution evidence.
 * @param actorId - Current server-authenticated employee; clients cannot supply another actor or role.
 * @param input - Stable retry UUID, exact action/provider versions and declared text fields; optional capture narrows authority.
 * @returns Durable receipt; exact terminal retries and equivalent unresolved writes never invoke the customer system again.
 */
writeConnectorAction(actorId: OfficeMemberId, input: OfficeConnectorWriteInput): Promise<OfficeConnectorExecutionReceipt>

/**
 * Query one declared read action using current employee identity and reviewed connection/provider versions.
 * @param actorId - Authenticated employee; queued requests and asynchronous network admission recheck their session.
 * @param input - Registered system, declared read action and exact reviewed versions; no arbitrary parameters.
 * @returns Sanitized bounded fields or a network failure, without performing business writes or automatic retries.
 */
readConnectorAction(actorId: OfficeMemberId, input: OfficeConnectorReadInput): Promise<OfficeConnectorReadReceipt>

/**
 * Discover current actions for one system in this employee's submitted native conversation context.
 * @param actorId - Authenticated employee; private captures have no administrator bypass.
 * @param input - Private capture and selected registered integration, without URLs or claimed roles.
 * @returns Role-admitted directory only while the captured connection and current associations still match.
 */
conversationConnectorActions(actorId: OfficeMemberId, input: OfficeConversationConnectorInput): Promise<OfficeConnectorActionsView>

/**
 * Query a declared read action under the submitting employee's current private conversation associations.
 * @param actorId - Authenticated employee; execution does not accept a caller-selected actor.
 * @param input - Private capture and exact action/connection/provider coordinates reviewed by native approval.
 * @returns Bounded real query result; revoked associations, changed roles and stale connections prevent execution.
 */
readConnectorActionFromConversation( actorId: OfficeMemberId, input: OfficeConversationConnectorReadInput, ): Promise<OfficeConnectorReadReceipt>

/**
 * Read private association choices and current declared integration requirements for one native conversation.
 * @param actorId - Authenticated active employee; administrators receive no bypass to another employee's choices.
 * @param conversationId - Logical native Session identity, scoped to that employee.
 * @returns Reviewed choices, capacity bounds and explicit missing dependencies, without execution authority or secrets.
 */
conversationLinks(actorId: OfficeMemberId, conversationId: OfficeConversationId): Promise<OfficeConversationLinksView>

/**
 * Save one association list without modifying Session history or granting a tool permission.
 * @param actorId - Authenticated current employee, rechecked inside the shared mutation queue.
 * @param input - Reviewed version, exact retry identity and selected tools or integrations.
 * @returns Confirmed private choice version; selecting tools also adds their currently registered dependencies.
 */
saveConversationLinks(actorId: OfficeMemberId, input: OfficeConversationLinksInput): Promise<OfficeConversationLinks>

/**
 * Prepare immutable association evidence before a separate native prompt admission.
 * @param actorId - Authenticated employee, rechecked inside the office queue.
 * @param input - Reviewed logical conversation version and exact native prompt retry identity.
 * @returns Private prepared context; no prompt is sent and no capability is authorized.
 */
captureConversation(actorId: OfficeMemberId, input: OfficeConversationCaptureInput): Promise<OfficeConversationCapture>

/**
 * Recover one employee's prepared context after uncertain acknowledgement or restart.
 * @param actorId - Current active employee; administrator role does not bypass ownership.
 * @param id - Prepared context identity, scoped to its owner.
 * @returns Historical metadata, without implying native admission or model dispatch.
 */
conversationCapture(actorId: OfficeMemberId, id: OfficeConversationCaptureId): Promise<OfficeConversationCapture>

/**
 * Read this employee's private drive references for one native conversation.
 * @param actorId - Authenticated employee; administrator role does not bypass private ownership.
 * @param conversationId - Logical native Session identity, without execution authority.
 * @returns Reviewed immutable metadata; later content reads require fresh permission checks.
 */
conversationFiles(actorId: OfficeMemberId, conversationId: OfficeConversationId): Promise<OfficeConversationFilesView>

/**
 * Replace reviewed file references with metadata resolved by the authority.
 * @param actorId - Current active employee, rechecked inside the mutation queue.
 * @param input - Optimistic version, exact retry UUID and immutable file coordinates.
 * @returns Committed private selection; no bytes are copied into native attachments.
 */
saveConversationFiles(actorId: OfficeMemberId, input: OfficeConversationFilesInput): Promise<OfficeConversationFiles>

/**
 * Freeze file references before a separate native prompt is admitted.
 * @param actorId - Current active employee.
 * @param input - Reviewed file-selection version and native request identity.
 * @returns Immutable descriptive evidence; every content read still rechecks authority.
 */
captureConversationFiles(actorId: OfficeMemberId, input: OfficeConversationCaptureInput): Promise<OfficeConversationFilesCapture>

/**
 * Recover retained file context for its original employee and authority role.
 * @param actorId - Current authenticated employee.
 * @param id - Private capture identity; possession grants no read access.
 * @returns Historical submitted metadata without implying native admission or dispatch.
 */
conversationFilesCapture(actorId: OfficeMemberId, id: OfficeConversationFilesCaptureId): Promise<OfficeConversationFilesCapture>

/**
 * Read a bounded character window from an explicitly submitted immutable UTF-8 file.
 * @param actorId - Current authenticated employee, rechecked before accessing bytes.
 * @param input - Owned submitted context, selected file and bounded character window.
 * @returns Verified inert text; changed versions, denied ancestors and invalid encodings return no body.
 */
readConversationFile(actorId: OfficeMemberId, input: OfficeConversationFileReadInput): Promise<OfficeConversationFileRead>

/**
 * Parse one submitted PDF page under finite input, worker and complete output limits.
 * @param actorId - Current employee; private capture role and current file authority are rechecked.
 * @param input - Exact submitted file, one-based page and bounded character window.
 * @param signal - Optional original tool or transport cancellation; office unload also terminates parsing.
 * @returns Actual selectable PDF text; malformed, encrypted, stale or over-budget files disclose no body.
 */
readConversationPdf(actorId: OfficeMemberId, input: OfficeConversationPdfReadInput, signal?: AbortSignal): Promise<OfficeConversationPdfRead>

/**
 * Read actual main-document paragraphs and tables from one explicitly submitted DOCX.
 * @param actorId - Current authenticated employee; capture role and current file authority remain mandatory.
 * @param input - Exact submitted immutable file and bounded UTF-16 body-text window.
 * @param signal - Original native tool or disconnected transport cancellation; office unload also terminates parsing.
 * @returns Verified body text with paragraph/table counts; malformed, denied and over-budget packages return no body.
 */
readConversationDocx(actorId: OfficeMemberId, input: OfficeConversationDocxReadInput, signal?: AbortSignal): Promise<OfficeConversationDocxRead>

/**
 * Read exact saved cells and formula caches from one submitted XLSX worksheet.
 * @param actorId - Current employee; capture role, ancestor access and latest version remain mandatory.
 * @param input - Exact submitted worksheet and sparse-cell continuation.
 * @param signal - Original native cancellation or disconnected transport; office unload also stops the parser.
 * @returns Whole saved cells with raw numeric/date lexemes; unauthorized and over-budget input returns no cells.
 */
readConversationXlsx(actorId: OfficeMemberId, input: OfficeConversationXlsxReadInput, signal?: AbortSignal): Promise<OfficeConversationXlsxRead>

/**
 * Read saved shape/table text or explicitly selected speaker notes from one submitted presentation slide.
 * @param actorId - Current employee; captured role, ancestor access and exact latest version remain mandatory.
 * @param input - Submitted immutable file, relationship-ordered slide and bounded section text window.
 * @param signal - Original native or transport cancellation; office unload also stops the isolated parser.
 * @returns Verified saved text and slide directory after final queued authorization; failures disclose no text.
 */
readConversationPptx(actorId: OfficeMemberId, input: OfficeConversationPptxReadInput, signal?: AbortSignal): Promise<OfficeConversationPptxRead>

/**
 * Save one integration's reviewed connection using deployment-approved origins and credential aliases.
 * @param actorId - Authenticated administrator, rechecked inside the office queue.
 * @param input - Configuration, reviewed revision and retained retry UUID; no inline credentials.
 * @returns Durably saved metadata; network connectivity remains unverified until a separate check.
 */
saveConnection(actorId: OfficeMemberId, input: OfficeConnectorInput): Promise<OfficeConnectorEntry>

/**
 * Probe a reviewed connection with fresh Host credentials and bounded response size and time.
 * @param actorId - Authenticated administrator, rechecked before any outbound request.
 * @param integrationId - Saved integration identity; arbitrary request URLs are not admitted.
 * @param revision - Reviewed connection version, preventing a check of a competing replacement.
 * @returns Point-in-time outcome without remote content or secrets; no automatic retries or business writes.
 */
probeConnection(actorId: OfficeMemberId, integrationId: OfficeIntegration['id'], revision: number): Promise<OfficeConnectorProbe>

/**
 * Publish plain text to a frozen set of current company employees.
 * @param actorId - Authenticated administrator, rechecked inside the mutation queue.
 * @param input - Reviewed text, delivery scope and retained retry UUID.
 * @returns Durable publication after its recipient list is committed.
 */
publishAnnouncement(actorId: OfficeMemberId, input: OfficeAnnouncementInput): Promise<OfficeAnnouncement>

/**
 * Acknowledge a publication in this employee's inbox.
 * @param actorId - Authenticated current recipient.
 * @param id - Delivered publication identity.
 */
markAnnouncementRead(actorId: OfficeMemberId, id: OfficeAnnouncementId): Promise<void>

/**
 * Acknowledge this recipient's current central reminder without changing business notifications.
 * @param actorId - Authenticated active employee, rechecked after queue admission.
 * @param id - Delivered reminder UUID; another employee's or obsolete occurrence is unavailable.
 * @returns After durability; repeated acknowledgements write nothing.
 */
markReminderRead(actorId: OfficeMemberId, id: OfficeReminderId): Promise<void>

/**
 * Withdraw a reviewed publication while retaining its history.
 * @param actorId - Current administrator.
 * @param id - Publication identity.
 * @param expectedRevision - Content revision reviewed before withdrawal.
 */
withdrawAnnouncement(actorId: OfficeMemberId, id: OfficeAnnouncementId, expectedRevision: number): Promise<void>

/**
 * Read only this employee's private conversations, even for administrators.
 * @param actorId - Authenticated active employee.
 * @param peerId - Optional conversation to open, including retained inactive peers.
 * @param before - Exclusive sequence for older history.
 * @returns Authorized threads and at most 100 messages.
 */
chat( actorId: OfficeMemberId, peerId?: OfficeMemberId, before?: number, ): OfficeChatView

/**
 * Read a private/shared directory or authorized name search without native filesystem access.
 * @param actorId - Authenticated active employee.
 * @param input - Logical location and search string.
 * @returns Authorized metadata, breadcrumbs and current write capability.
 */
drive(actorId: OfficeMemberId, input: OfficeDriveQuery): OfficeDriveView

/**
 * Create a folder after checking current membership and ancestor permissions.
 * @param actorId - Trusted employee identity, not a browser-selected owner.
 * @param input - Logical parent and Windows-compatible display name.
 * @returns Committed directory entry.
 */
createDriveFolder( actorId: OfficeMemberId, input: OfficeDriveFolderInput, ): Promise<OfficeDriveEntry>

/**
 * Rename only an editable entry inside an editable parent, using a reviewed version.
 * @param actorId - Authenticated employee.
 * @param input - Opaque entry identity, version and new name.
 * @returns Committed metadata or a denial without changing the directory.
 */
renameDriveEntry( actorId: OfficeMemberId, input: OfficeDriveRenameInput, ): Promise<OfficeDriveEntry>

/**
 * Upload actual bytes under current directory permissions and a stable retry identity.
 * @param actorId - Trusted employee identity.
 * @param input - Logical destination, bounded bytes and retry key.
 * @returns Committed file metadata after both immutable bytes and metadata are durable.
 */
uploadDriveFile( actorId: OfficeMemberId, input: OfficeDriveUploadInput, ): Promise<OfficeDriveEntry>

/**
 * Download an authorized immutable version while permission changes share the same queue.
 * @param actorId - Authenticated active employee.
 * @param id - Opaque file identity.
 * @returns Actual bytes and their digest; denied and corrupt reads disclose no content.
 */
downloadDriveFile( actorId: OfficeMemberId, id: OfficeDriveId, ): Promise<OfficeDriveDownload>

/**
 * Let a shared entry's owner replace account conditions without an administrator privacy bypass.
 * @param actorId - Authenticated employee.
 * @param input - Reviewed version and complete conditions.
 * @returns Committed owner projection.
 */
saveDrivePermissions( actorId: OfficeMemberId, input: OfficeDrivePermissionsInput, ): Promise<OfficeDriveEntry>

/**
 * Read only this employee's drafts; administrators have no private-draft bypass.
 * @param actorId - Authenticated active employee.
 * @returns Contact drafts with their reviewed versions, including cleared tombstones.
 */
chatDrafts(actorId: OfficeMemberId): OfficeChatDraftView

/**
 * Save a private draft without silently overwriting another window's changes.
 * @param actorId - Authenticated owner; never selected by a browser method.
 * @param input - Contact, reviewed version, exact text and retry identity.
 * @returns The durable version; exact retries return it without another write.
 */
saveChatDraft( actorId: OfficeMemberId, input: OfficeChatDraftInput, ): Promise<OfficeChatDraft>

/**
 * Send one private message; retrying its exact identity cannot duplicate it.
 * @param actorId - Authenticated sender, rechecked in the shared mutation queue.
 * @param input - Retry identity, recipient and original text.
 * @returns Committed message; changed retry payloads reject without side effects.
 */
sendMessage( actorId: OfficeMemberId, input: OfficeChatInput, ): Promise<OfficeChatMessage>

/**
 * Read this active employee's file-message policy and retained usage.
 * @param actorId - Authenticated employee.
 * @returns Current bounded file policy without other employees' usage.
 */
chatFileLimitsFor(actorId: OfficeMemberId): OfficeChatFileLimits

/**
 * Verify immutable files before publishing one private message through the original chat sequence.
 * @param actorId - Current authenticated sender, checked inside the shared queue.
 * @param input - Exact retry identity, recipient, caption and ordered bounded files.
 * @returns Published header and file metadata; failure may retain a recoverable declaration but never a partial message.
 */
sendMessageFiles(actorId: OfficeMemberId, input: OfficeChatFilesInput): Promise<OfficeChatMessage>

/**
 * Read one immutable file through its original private message and current participant identity.
 * @param actorId - Active authenticated sender or recipient.
 * @param input - Retained message and file coordinates.
 * @returns Verified complete bytes; hidden and missing coordinates share one denial.
 */
downloadChatFile(actorId: OfficeMemberId, input: OfficeChatFileCoordinates): Promise<OfficeChatFileDownload>

/**
 * Read current private file draft versions without returning file bytes.
 * @param actorId - Current authenticated owner.
 * @returns Only the owner's contact drafts, tombstones and logical draft quota.
 */
chatFileDrafts(actorId: OfficeMemberId): OfficeChatFileDraftView

/**
 * Atomically replace one reviewed contact's private file draft.
 * @param actorId - Authenticated owner rechecked inside the shared queue.
 * @param input - Reviewed contact version, original retry UUID and complete bounded files.
 * @returns Saved metadata; stale versions and changed retries reject without clearing the draft.
 */
saveChatFileDraft(actorId: OfficeMemberId, input: OfficeChatFileDraftInput): Promise<OfficeChatFileDraft>

/**
 * Restore complete file bytes from the authenticated employee's own reviewed contact draft.
 * @param actorId - Active owner; recipients and administrators receive no bypass.
 * @param input - Contact, current draft version and opaque file identity.
 * @returns Verified bounded draft content or a uniform missing-file denial.
 */
downloadChatFileDraft(actorId: OfficeMemberId, input: OfficeChatFileDraftCoordinates): Promise<OfficeChatFileDraftDownload>

/**
 * Publish an exact reviewed durable file selection, then clear only that original draft.
 * @param actorId - Current authenticated sender, serialized with sign-out and membership edits.
 * @param input - Reviewed version, captured caption and stable message identity.
 * @returns One committed file message; retries reconcile publication before clearing the original selection.
 */
sendChatFileDraft(actorId: OfficeMemberId, input: OfficeChatFileDraftSendInput): Promise<OfficeChatMessage>

/**
 * Acknowledge only messages displayed from this employee's own conversation.
 * @param actorId - Authenticated reader.
 * @param peerId - Other participant.
 * @param through - Observed sequence in this exact conversation.
 * @returns After durable acknowledgement; older acknowledgements are idempotent.
 */
readChat( actorId: OfficeMemberId, peerId: OfficeMemberId, through: number, ): Promise<void>

/**
 * Read one active item through the employee policy used for daily lists and calendars.
 * @param actorId - Authenticated identity.
 * @param itemId - Requested work.
 * @returns Active item; hidden, inactive or missing work returns the same not_found denial.
 */
getItem(actorId: OfficeMemberId, itemId: OfficeItemId): OfficeItem

/**
 * Create a task or to-do and deliver the assignee's notification in one commit.
 * @param actorId - Authenticated initiator.
 * @param input - User-authored work.
 * @returns durable item; validation, membership or storage failure publishes no new revision.
 */
createWork( actorId: OfficeMemberId, input: OfficeWorkInput, ): Promise<OfficeItem>

/**
 * Create one internal task/to-do under a private reminder capture, rechecking authority immediately before a new write.
 * @param actorId - Authenticated active employee; the payload cannot choose a business actor.
 * @param input - Exact retry identity, private capture and ordinary work fields.
 * @returns Stable request receipt with the current authorized item; existing committed retries perform no second write.
 */
createWorkFromConversation(actorId: OfficeMemberId, input: OfficeAgentWorkInput): Promise<OfficeAgentWorkReceipt>

/**
 * Edit ordinary work content and deadline while preserving assignment and lifecycle.
 * @param actorId - Current active creator, assignee or administrator.
 * @param itemId - Existing task or to-do identity.
 * @param expectedRevision - Revision reviewed before editing, including any task decisions.
 * @param input - Content and deadline; omitted time clears it, omitted priority preserves it, and normal clears a stored priority.
 * @returns Committed work; unchanged input writes nothing, and stale, closed or unauthorized edits publish no changes.
 */
updateWork(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeWorkUpdateInput): Promise<OfficeItem>

/**
 * Submit a task delivery or review its current unchanged submission with a retained explanation.
 * @param actorId - Current assignee for submission; task creator or administrator for review.
 * @param itemId - Existing task; to-dos and meetings use their own operations.
 * @param expectedRevision - Parent revision reviewed before the action.
 * @param input - Submission, acceptance or return with a bounded nonempty reason.
 * @returns Task with atomically retained history, recipient notifications and audit. Acceptance completes the task.
 * Any intervening item revision invalidates a pending submission; denied, closed or stale actions publish nothing.
 */
reviewTaskDelivery(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeTaskDeliveryInput): Promise<OfficeItem>

/**
 * Archive, move to the recycle bin or restore reviewed work while retaining complete business history.
 * @param actorId - Current authenticated creator or administrator; assignment alone grants no deletion authority.
 * @param itemId - Existing readable task or to-do, including inactive records.
 * @param expectedRevision - Revision explicitly reviewed before confirming the action.
 * @param input - Confirmed action and nonempty explanation; deletion retains data in the recycle bin.
 * @returns Committed item with atomic history, notices and audit. Unchanged states write nothing.
 * Inactive records leave daily work and cannot be edited, executed or read as active work until restored.
 */
changeWorkLifecycle(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeWorkLifecycleInput): Promise<OfficeItem>

/**
 * Resolve linked file names only while the caller can read the item and its reviewed current Drive versions.
 * @param actorId - Authenticated active employee.
 * @param itemId - Existing readable task or to-do.
 * @returns Current attachment availability without private names or metadata for inaccessible references.
 */
workAttachments(actorId: OfficeMemberId, itemId: OfficeItemId): OfficeWorkAttachmentsView

/**
 * Replace reviewed attachment references without copying bytes or granting Drive access.
 * @param actorId - Current item creator, assignee or administrator.
 * @param itemId - Existing open task/to-do.
 * @param expectedRevision - Reviewed parent revision; any change invalidates pending delivery review.
 * @param input - At most 20 distinct files; new or changed references require current Drive access and version.
 * @returns Atomically committed item, notifications and audit; unchanged references write nothing.
 */
updateWorkAttachments(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeWorkAttachmentsInput): Promise<OfficeItem>

/**
 * Authorize a linked reviewed file version before starting a verified Drive download.
 * @param actorId - Current active reader of both item and file.
 * @param itemId - Existing readable work item still retaining this reference.
 * @param fileId - Linked logical file identity.
 * @returns Physically verified download metadata; missing, denied or replaced versions return no content.
 */
workAttachmentInfo(actorId: OfficeMemberId, itemId: OfficeItemId, fileId: OfficeDriveId): Promise<OfficeDriveDownloadInfo>

/**
 * Replace a task/to-do checklist using the version reviewed by its creator, assignee or administrator.
 * @param actorId - Current authenticated employee.
 * @param itemId - Existing task/to-do; all checklist access derives from this item.
 * @param expectedRevision - Reviewed parent revision, including other work changes.
 * @param input - Up to 100 entries; existing ids must belong to this work, and null ids receive fresh server identities.
 * @returns Committed work with atomic notification/audit; unchanged lists write nothing and closed or stale changes reject.
 */
updateWorkSubtasks(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeWorkSubtasksInput): Promise<OfficeItem>

/**
 * Create a meeting with one accepted organizer and pending, distinct invitees.
 * @param actorId - Authenticated organizer.
 * @param input - Same-day schedule.
 * @returns durable meeting; invalid times or inactive invitees leave no invitation or item.
 */
createSchedule( actorId: OfficeMemberId, input: OfficeScheduleInput, ): Promise<OfficeItem>

/**
 * Update a meeting on the revision its organizer or administrator reviewed.
 * @param actorId - Authenticated organizer or administrator.
 * @param itemId - Existing meeting identity.
 * @param expectedRevision - Last reviewed item revision, including invitation responses.
 * @param input - Same-day fields and optional invitees; omission preserves membership and the organizer always remains.
 * @returns Committed meeting with atomic invitations/removal notices; time changes reset invitee responses.
 * Closed or stale edits reject without writes.
 */
updateSchedule(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeScheduleUpdateInput): Promise<OfficeItem>

/**
 * Decide a task or transfer a to-do while retaining its history and original identity.
 * @param actorId - Current authenticated assignee, or creator/administrator for a transfer.
 * @param itemId - Existing task, or to-do for transfer; meetings retain their own controls.
 * @param expectedRevision - Item revision reviewed before deciding.
 * @param input - Explicit action; rejection and transfer include a reason, and transfer identifies an active new owner.
 * @returns Committed work and decision/assignment history; denied, closed or stale decisions publish no changes.
 */
decideTask(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeTaskDecisionInput): Promise<OfficeItem>

/**
 * Change a work item's status with optimistic concurrency and execution-time authorization.
 * @param actorId - Authenticated owner/initiator or administrator.
 * @param itemId - Work to update.
 * @param expectedRevision - Last observed item revision.
 * @param status - New lifecycle state.
 * @returns committed item; stale writes reject with conflict. Only the organizer/admin changes meeting status.
 * Tasks with delivery history complete only through explicit delivery confirmation.
 */
setStatus( actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, status: OfficeItemStatus, ): Promise<OfficeItem>

/**
 * Reply only to the caller's own live invitation and notify the organizer.
 * @param actorId - Authenticated invitee.
 * @param itemId - Meeting being answered.
 * @param expectedRevision - Last observed item revision.
 * @param reply - Accepted or declined.
 * @returns committed meeting; closed meetings, organizer changes and stale writes reject without side effects.
 */
reply( actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, reply: Exclude<OfficeInvitationReply, 'pending'>, ): Promise<OfficeItem>

/**
 * Edit contact fields, never role or active state.
 * @param actorId - Authenticated employee.
 * @param input - Complete profile fields.
 * @returns committed directory entry; unknown privilege fields reject at admission.
 */
updateProfile( actorId: OfficeMemberId, input: OfficeProfile, ): Promise<OfficeMember>

/**
 * Administrator-only directory creation, role change or offboarding. Historical identities remain.
 * @param actorId - Authenticated administrator.
 * @param member - Complete employee record.
 * @param expected - Null creates an identity; a reviewed record protects edits. Omission preserves trusted upserts.
 * @returns committed member; removing the last active administrator is rejected.
 */
saveMember( actorId: OfficeMemberId, member: OfficeMember, expected?: OfficeMember | null, ): Promise<OfficeMember>

/**
 * Mark one delivered notification as read without acknowledging another employee's inbox.
 * @param actorId - Authenticated recipient.
 * @param notificationId - Notification to acknowledge.
 * @returns after durability; missing and hidden notifications return the same not_found denial.
 */
markRead( actorId: OfficeMemberId, notificationId: OfficeNotificationId, ): Promise<void>

/**
 * Read committed operation history, restricted to active administrators.
 * @param actorId - Authenticated administrator.
 * @returns borrowed read-only audit entries.
 */
audit(actorId: OfficeMemberId): readonly OfficeAuditEntry[]

/**
 * Search retained operation metadata and authenticated request denials across the office histories.
 * @param actorId - Active administrator, rechecked on every page.
 * @param query - Bounded exact filters and exclusive older-page position.
 * @returns Allowlisted metadata only; source retention applies and pages are current reads, not a snapshot.
 */
auditPage(actorId: OfficeMemberId, query: OfficeAuditQuery): OfficeAuditPage

/**
 * Export one bounded metadata batch without including business fields, credential data or provider diagnostics.
 * @param actorId - Active administrator, rechecked for every batch.
 * @param query - Same filters and continuation used by auditPage.
 * @returns Newline-delimited JSON plus the next position; an empty batch has empty content.
 */
auditExport(actorId: OfficeMemberId, query: OfficeAuditQuery): OfficeAuditExport

/**
 * Initialize backend sign-in for an existing administrator once; later values never reset credentials.
 * @param administrator - Deployment-owned active administrator.
 * @param password - First password from the trusted server startup channel.
 * @returns Whether initialization committed; this is not a public signup endpoint.
 */
initializeIdentity( administrator: OfficeMemberId, password: string, ): Promise<boolean>

/**
 * Read the optional pre-login invitation capability without directory or credential information.
 * @returns Safe explicit lifetime capability, or null when invitations are disabled.
 */
memberInviteCapability(): OfficeMemberInviteCapability | null

/**
 * Read one managed member's latest invitation and independent current enrollment facts.
 * @param actorId - Current authenticated administrator.
 * @param memberId - Existing retained company member.
 * @returns Credential-free invitation metadata without a code or secret hash.
 */
memberInvite(actorId: OfficeMemberId, memberId: OfficeMemberId): Promise<OfficeMemberInviteView>

/**
 * Issue a finite first-password invitation for a reviewed active member with no credentials.
 * @param actorId - Current authenticated administrator; no role comes from the recipient.
 * @param input - Exact member/role, expiry and original issuance retry UUID.
 * @returns Committed metadata and a code only on the first response; retries cannot recover that code.
 */
issueMemberInvite(actorId: OfficeMemberId, input: OfficeMemberInviteIssueInput): Promise<OfficeMemberInviteIssueReceipt>

/**
 * Revoke a reviewed invitation; an already-set credential remains governed by the existing account controls.
 * @param actorId - Current authenticated administrator.
 * @param input - Invitation identity and observed revision.
 * @returns Retained revocation evidence; it does not remove or reset a password.
 */
revokeMemberInvite(actorId: OfficeMemberId, input: OfficeMemberInviteRevokeInput): Promise<OfficeMemberInvite>

/**
 * Authenticate a limited code and set only its target's first password in one original identity commit.
 * @param input - Code and recipient-selected password, with no caller-selected identity or role.
 * @param signal - Original request cancellation; unload prevents new commitment and drains admitted hashing.
 * @returns Only the login member id after commitment; no business token or automatic sign-in.
 */
acceptMemberInvite(input: OfficeMemberInviteAcceptInput, signal?: AbortSignal): Promise<OfficeMemberInviteAcceptReceipt>

/**
 * Enroll or reset employee credentials through a trusted, authenticated administrator adapter.
 * @param actorId - Verified administrator supplied by the gateway.
 * @param memberId - Active target employee.
 * @param password - Replacement password; never logged or returned.
 */
setIdentityPassword( actorId: OfficeMemberId, memberId: OfficeMemberId, password: string, ): Promise<void>

/**
 * Sign in without caller-claimed authority; adapters keep the returned secret out of UI and logs.
 * @param input - Employee id and password.
 * @returns A durable session's one-time bearer receipt for the trusted authentication adapter.
 */
login(input: OfficeLoginInput): Promise<OfficeLoginResult>

/**
 * Bind a gateway business request to its actual active employee and current role.
 * @param token - Opaque token from the authentication header, never a caller-selected actor id.
 * @returns Current employee authority; this does not expose password material.
 */
authenticate(token: string): OfficeMember

/**
 * Bind a trusted gateway operation to its session, including execution-time queue checks.
 * @param token - Actual request bearer token; never an employee id or claimed role.
 * @param operation - Trusted callback receiving the authenticated employee and a server-only denial-scope registrar.
 * @returns The operation result, with revoked or expired queued work rejected before execution.
 */
withSession<T>( token: string, operation: (memberId: OfficeMemberId, auditDenial: (scope: OfficeRequestDenialScope) => void) => Promise<T>, ): Promise<T>

/**
 * Read only a signed-in employee's device sessions.
 * @param token - Current opaque token.
 * @returns Sanitized own-session handles without bearer material.
 */
identitySessions(token: string): readonly OfficeSessionInfo[]

/**
 * Durably revoke this bearer session; repeating a successful logout is harmless.
 * @param token - Session to revoke.
 */
logout(token: string): Promise<void>

/**
 * Revoke only a device session belonging to the authenticated employee.
 * @param token - Current bearer token.
 * @param id - Own device-session handle.
 */
revokeIdentitySession(token: string, id: OfficeSessionId): Promise<void>

/**
 * Verify the current password before replacing it and revoking every old session.
 * @param token - Current bearer token.
 * @param input - Reviewed current password and replacement.
 */
changeIdentityPassword( token: string, input: OfficePasswordChangeInput, ): Promise<void>

/**
 * Read administrator-only enrollment metadata with no credential values.
 * @param actorId - Verified administrator.
 * @returns Enrollment presence, never salts, password hashes or tokens.
 */
identityOverview(actorId: OfficeMemberId): OfficeIdentityOverview

/**
 * Read administrator-managed departments, positions and formal employee affiliations.
 * @param actorId - Authenticated active employee.
 * @returns Authorized structure, including an explicit first-configuration state.
 */
organization(actorId: OfficeMemberId): OfficeOrganizationView

/**
 * Initialize formal organization once from the directory the administrator reviewed.
 * @param actorId - Authenticated administrator.
 * @param officeRevision - Reviewed office revision; a concurrent directory edit rejects first initialization.
 * @returns Committed structure; later calls never overwrite existing organization with profile labels.
 */
initializeOrganization( actorId: OfficeMemberId, officeRevision: number, ): Promise<OfficeOrganizationView>

/**
 * Create/edit/deactivate a department through current administrator authority and its reviewed version.
 * @param actorId - Authenticated administrator.
 * @param input - Department identity, parent, name and version.
 * @returns The committed department without changing contact labels or authorization roles.
 */
saveOrganizationUnit( actorId: OfficeMemberId, input: OfficeUnitInput, ): Promise<OfficeOrganizationUnit>

/**
 * Create/edit/deactivate a formal position; positions do not grant office authorization roles.
 * @param actorId - Authenticated administrator.
 * @param input - Position, optional department and reviewed version.
 * @returns Committed position, or a denial preserving in-use employee affiliations.
 */
savePosition( actorId: OfficeMemberId, input: OfficePositionInput, ): Promise<OfficePosition>

/**
 * Assign formal department and position independently of self-service contact profile edits.
 * @param actorId - Authenticated administrator.
 * @param input - Existing employee, target entities and reviewed assignment version.
 * @returns A committed affiliation, including versioned explicit unassignment.
 */
assignOrganization( actorId: OfficeMemberId, input: OfficeAssignmentInput, ): Promise<OfficeOrganizationAssignment>

/**
 * Reserve a resumable file under the employee's current membership, destination permissions and quota.
 * @param actorId - Authenticated employee supplied by the Host or gateway.
 * @param input - Reviewed immutable file declaration and retry identity.
 * @returns A durable owner-only upload ticket.
 */
beginDriveUpload(actorId: OfficeMemberId, input: OfficeDriveUploadDeclaration): Promise<OfficeDriveUploadTicket>

/**
 * List unfinished uploads for the current employee without exposing another account's receipt positions.
 * @param actorId - Authenticated active employee.
 * @returns Owner-only resumable tickets.
 */
driveUploads(actorId: OfficeMemberId): Promise<readonly OfficeDriveUploadTicket[]>

/**
 * Recover an owned upload after a lost response or application restart.
 * @param actorId - Current authenticated employee.
 * @param id - Server-minted upload coordinate.
 * @returns The confirmed private receipt state.
 */
getDriveUpload(actorId: OfficeMemberId, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket>

/**
 * Stage one chunk after rechecking this employee's session, current directory access and shared quota.
 * @param actorId - Authenticated active employee.
 * @param input - Reviewed upload identity, position, digest and bounded encoded bytes.
 * @returns Acknowledged receipt positions after durability.
 */
appendDriveUpload(actorId: OfficeMemberId, input: OfficeDriveUploadChunkInput): Promise<OfficeDriveUploadTicket>

/**
 * Verify and publish a complete upload once, retaining the original request identity through uncertain responses.
 * @param actorId - Authenticated active employee.
 * @param id - Owned resumable upload coordinate.
 * @returns The confirmed completed ticket and logical file identity.
 */
completeDriveUpload(actorId: OfficeMemberId, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket>

/**
 * Cancel owned staging; a file already durably published is reported as completed and retained.
 * @param actorId - Current active owner, including after destination access was revoked.
 * @param id - Server-owned upload identity.
 * @returns The confirmed terminal outcome; temporary-byte cleanup retries in the background.
 */
cancelDriveUpload(actorId: OfficeMemberId, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket>

/**
 * Authorize and verify a file before giving the client its immutable download version.
 * @param actorId - Authenticated active reader.
 * @param id - Logical file identity.
 * @returns Verified metadata and the current bounded download chunk size.
 */
driveFileInfo(actorId: OfficeMemberId, id: OfficeDriveId): Promise<OfficeDriveDownloadInfo>

/**
 * Read current authorized version history without opening content or changing the file head.
 * @param actorId - Authenticated active reader.
 * @param id - Logical file identity.
 * @returns Immutable version metadata ordered newest first.
 */
driveHistory(actorId: OfficeMemberId, id: OfficeDriveId): OfficeDriveHistory

/**
 * Read only the current employee's visible recycle-bin roots.
 * @param actorId - Authenticated active owner.
 * @returns Retained deleted metadata with current restore permissions.
 */
driveTrash(actorId: OfficeMemberId): OfficeDriveTrash

/**
 * Review the exact owned deleted subtree before permanent cleanup.
 * @param actorId - Authenticated active owner.
 * @param id - Deleted root identity.
 * @returns Read-only scope totals and the digest required by confirmation.
 */
drivePurgePlan(actorId: OfficeMemberId, id: OfficeDriveId): OfficeDrivePurgePlan

/**
 * Permanently clear only an exactly reviewed owned subtree after durable authorization.
 * @param actorId - Authenticated active owner.
 * @param input - Exact reviewed revision, digest and stable request identity.
 * @returns Pending or completed receipt; only completion releases the charged quota.
 */
purgeDrive(actorId: OfficeMemberId, input: OfficeDrivePurgeInput): Promise<OfficeDrivePurgeReceipt>

/**
 * Inspect an existing owner cleanup receipt without changing its scope or reading bytes.
 * @param actorId - Authenticated active owner.
 * @param id - Original deleted root identity.
 * @returns Durable status or null when no permanent cleanup has been approved.
 */
drivePurgeStatus(actorId: OfficeMemberId, id: OfficeDriveId): OfficeDrivePurgeReceipt | null

/**
 * Continue an already approved owner cleanup, including after an uncertain acknowledgement.
 * @param actorId - Authenticated active owner.
 * @param id - Previously approved root; no new scope is authorized by this operation.
 * @returns Latest durable receipt; completed retries perform no further writes.
 */
retryDrivePurge(actorId: OfficeMemberId, id: OfficeDriveId): Promise<OfficeDrivePurgeReceipt>

/**
 * Confirm one reviewed deletion or restoration without discarding versions or Native files.
 * @param actorId - Authenticated active owner.
 * @param input - Reviewed revision, action and optional new restore name.
 * @returns Committed active or deleted metadata; denied writes do not publish.
 */
changeDriveLifecycle(actorId: OfficeMemberId, input: OfficeDriveLifecycleInput): Promise<OfficeDriveEntry | OfficeDriveTrashEntry>

/**
 * Authorize and verify a selected historical object before exposing download metadata.
 * @param actorId - Authenticated active reader.
 * @param id - Logical file identity.
 * @param versionId - Immutable version selected from authorized history.
 * @returns Verified version metadata with its original media type and current chunk bound.
 */
driveVersionInfo(actorId: OfficeMemberId, id: OfficeDriveId, versionId: OfficeDriveVersionId): Promise<OfficeDriveDownloadInfo>

/**
 * Read one reviewed immutable range with fresh membership and ancestor-permission checks.
 * @param actorId - Current authenticated active reader.
 * @param input - Logical file, immutable version and bounded byte span.
 * @returns Actual range bytes and their digest; denied or corrupt reads return no content.
 */
downloadDriveRange(actorId: OfficeMemberId, input: OfficeDriveRangeInput): Promise<OfficeDriveDownloadRange>
```

Source: [`packages/enterprise/office/src/index.ts`](../../packages/enterprise/office/src/index.ts)

<a id="ctxofficecontroller--officecontroller"></a>

### `ctx.officeController` — `OfficeController`

No method accepts a caller-selected actor id. This adapter is not a shared multiuser login gateway.

```ts cordis-catalog
/**
 * Read this employee's authorized board and directory.
 * @param date - Optional local day; absent selects office today.
 * @returns safe view or a business denial.
 */
@Remote view(date?: string): Promise<OfficeOutcome<OfficeView>>

/**
 * Search retained audit metadata using the Host's current administrator identity.
 * @param query - Explicit bounded filters and an exclusive older-page position.
 * @returns Authorized allowlisted metadata, or a denial rechecked by the office authority for this page.
 */
@Remote auditPage(query: OfficeAuditQuery): Promise<OfficeOutcome<OfficeAuditPage>>

/**
 * Read one bounded NDJSON batch after fresh administrator authorization.
 * @param query - Same reviewed filters and continuation used for audit search.
 * @returns Credential-free metadata content; each later batch requires another authorized request.
 */
@Remote auditExport(query: OfficeAuditQuery): Promise<OfficeOutcome<OfficeAuditExport>>

/**
 * Read only this employee's association draft for one native logical conversation.
 * @param conversationId - Native conversation identity; it is not an authorization credential.
 * @returns Reviewed private choices and explicit resolved/missing dependency metadata, without execution permission.
 */
@Remote conversationLinks(conversationId: OfficeConversationId): Promise<OfficeOutcome<OfficeConversationLinksView>>

/**
 * Save a reviewed private association list while keeping the actor assigned by the authenticated Host.
 * @param input - Conversation identity, reviewed version, exact retry id and selected tools or integrations.
 * @returns Confirmed association choices; this operation never prompts an Agent or runs a selected capability.
 */
@Remote saveConversationLinks(input: OfficeConversationLinksInput): Promise<OfficeOutcome<OfficeConversationLinks>>

/**
 * Bind an explicit office gesture before its separate Native prompt reaches this Host.
 * @param id - Exact Native input; this restriction never grants Session visibility or execution authority.
 * @returns A Host-lifetime restriction to the current employee; empty inputs carry no private history across restarts.
 */
@Remote prepareNativeInput(id: OfficeConversationId): Promise<OfficeOutcome<null>>

/**
 * Capture the employee's reviewed association version independently of native message delivery.
 * @param input - Logical conversation, reviewed version and exact native prompt retry id.
 * @returns Immutable private prepared context without execution authority, addresses or credentials.
 */
@Remote captureConversation(input: OfficeConversationCaptureInput): Promise<OfficeOutcome<OfficeConversationCapture>>

/**
 * Read the current employee's immutable prepared context after an uncertain response or restart.
 * @param id - Opaque context identity; ownership is checked independently of this value.
 * @returns Historical metadata that does not imply a native prompt was admitted or dispatched.
 */
@Remote conversationCapture(id: OfficeConversationCaptureId): Promise<OfficeOutcome<OfficeConversationCapture>>

/**
 * Read this employee's reviewed drive references for one logical native conversation.
 * @param id - Native Session identity, without file access authority.
 * @returns Private immutable-version metadata; content reads remain separately authorized.
 */
@Remote conversationFiles(id: OfficeConversationId): Promise<OfficeOutcome<OfficeConversationFilesView>>

/**
 * Save reviewed immutable file coordinates as the authenticated employee.
 * @param input - Current selection revision, exact retry UUID and selected file versions.
 * @returns Committed metadata; client-supplied names, bytes and employee identities are not admitted.
 */
@Remote saveConversationFiles(input: OfficeConversationFilesInput): Promise<OfficeOutcome<OfficeConversationFiles>>

/**
 * Prepare file context before a separate native prompt admission.
 * @param input - Reviewed file selection and exact native prompt request identity.
 * @returns Private immutable metadata; later reads still require current permissions.
 */
@Remote captureConversationFiles(input: OfficeConversationCaptureInput): Promise<OfficeOutcome<OfficeConversationFilesCapture>>

/**
 * Recover submitted file evidence after an uncertain response or restart.
 * @param id - Server-issued private capture identity.
 * @returns Historical metadata for this employee and authority role, without execution authority.
 */
@Remote conversationFilesCapture(id: OfficeConversationFilesCaptureId): Promise<OfficeOutcome<OfficeConversationFilesCapture>>

/**
 * Read a bounded verified UTF-8 window from a file selected in submitted context.
 * @param input - Owned capture, selected file id and character coordinates.
 * @returns Inert text only after fresh membership, ancestor ACL and version checks.
 */
@Remote readConversationFile(input: OfficeConversationFileReadInput): Promise<OfficeOutcome<OfficeConversationFileRead>>

/**
 * Read one submitted PDF page for a native tool without creating an attachment copy or a browser RPC.
 * @param input - Owned capture, selected immutable file and page text window.
 * @param signal - Original native tool cancellation; unload also stops the operation.
 * @returns Actual bounded PDF text after fresh authority checks, or a stable office denial.
 */
readConversationPdf(input: OfficeConversationPdfReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationPdfRead>>

/**
 * Read submitted DOCX body paragraphs and tables for the exact original native tool call.
 * @param input - Owned submitted file and bounded body-text window.
 * @param signal - Original native cancellation, combined with the controller lifetime.
 * @returns Actual verified text after current authority checks, or a stable office denial; no browser RPC is added.
 */
readConversationDocx(input: OfficeConversationDocxReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationDocxRead>>

/**
 * Read exact saved spreadsheet cells for the original native tool without adding a browser RPC.
 * @param input - Owned submitted file, workbook sheet number and sparse-cell window.
 * @param signal - Original native cancellation, combined with controller lifetime.
 * @returns Verified raw values and saved formula caches after current authority checks, or a stable office denial.
 */
readConversationXlsx(input: OfficeConversationXlsxReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationXlsxRead>>

/**
 * Read saved presentation text or explicit speaker notes for the original native tool without a browser RPC.
 * @param input - Submitted immutable file, actual slide number, explicit section and bounded UTF-16 window.
 * @param signal - Original native cancellation, combined with the controller lifetime.
 * @returns Verified saved text after current authority checks, or a stable office denial.
 */
readConversationPptx(input: OfficeConversationPptxReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationPptxRead>>

/**
 * Register a bounded descriptive integration manifest as the authenticated administrator.
 * @param input - Exact JSON object and retained retry UUID; contains no executable code or credentials.
 * @returns Committed company registration or a business denial.
 */
@Remote importIntegration(input: OfficeIntegrationImportInput): Promise<OfficeOutcome<OfficeIntegration>>

/**
 * Read company connection readiness without resolving credential values in the employee Host.
 * @returns Current versions and administrator-only configuration choices.
 */
@Remote connections(): Promise<OfficeOutcome<OfficeConnectorView>>

/**
 * Read one company system's role-filtered declarations without performing a business operation.
 * @param integrationId - Registered system identity, never a caller-selected address or actor.
 * @returns Bounded current directory without private connection configuration or role-admission rules.
 */
@Remote connectorActions(integrationId: OfficeIntegrationId): Promise<OfficeOutcome<OfficeConnectorActionsView>>

/**
 * Read this authenticated employee's retained external-operation receipts without another employee's request data.
 * @returns Own execution stages and authoritative results; unknown outcomes never imply success or an automatic retry.
 */
@Remote connectorExecutions(): Promise<OfficeOutcome<readonly OfficeConnectorExecutionReceipt[]>>

/**
 * Read this employee's bounded execution metadata for one system without large results or raw input values.
 * @param query - Registered system and optional own last-entry cursor.
 * @returns Newest-first own receipt page with an explicit older-page anchor.
 */
@Remote connectorExecutionPage(query: OfficeConnectorExecutionQuery): Promise<OfficeOutcome<OfficeConnectorExecutionPage>>

/**
 * Read one retained own receipt after an explicit detail selection.
 * @param executionId - Server-generated own operation identity, never another employee's claimed actor.
 * @returns Bounded result and audit history; adapter removal does not erase retained evidence.
 */
@Remote connectorExecutionDetail(executionId: OfficeConnectorExecutionId): Promise<OfficeOutcome<OfficeConnectorExecutionReceipt>>

/**
 * Query the original customer's outcome for an own unknown operation without replaying its business request.
 * @param executionId - Own server-generated execution identity.
 * @returns Current private receipt and explicit availability/uncertainty, after current authority and durable result checks.
 */
@Remote checkConnectorExecution(executionId: OfficeConnectorExecutionId): Promise<OfficeOutcome<OfficeConnectorExecutionCheck>>

/**
 * Submit a reviewed declared write; unknown outcomes never trigger automatic re-dispatch.
 * @param input - Exact declared business fields, reviewed connection/provider coordinates and stable retry UUID.
 * @returns Own durable receipt or a stable denial/unknown handling identity, without private diagnostics.
 */
@Remote writeConnectorAction(input: OfficeConnectorWriteInput): Promise<OfficeOutcome<OfficeConnectorExecutionReceipt>>

/**
 * Query a declared read action under the authenticated employee's current permissions.
 * @param input - Reviewed system, read action, saved connection and provider versions.
 * @returns Bounded plain-text fields or a network outcome; caller-supplied identities and URLs are rejected.
 */
@Remote readConnectorAction(input: OfficeConnectorReadInput): Promise<OfficeOutcome<OfficeConnectorReadReceipt>>

/**
 * Persist a reviewed declared read under an exact employee-scoped retry identity.
 * @param input - Original action/source coordinates and stable request UUID.
 * @returns Durable network outcome and currently authorized retained data.
 */
@Remote syncConnectorAction(input: OfficeConnectorSyncInput): Promise<OfficeOutcome<OfficeConnectorSyncDetail>>

/**
 * Read this employee's small synchronization metadata without a customer request.
 * @param query - Selected system and owner-scoped older anchor.
 * @returns Bounded private metadata page.
 */
@Remote connectorSyncPage(query: OfficeConnectorSyncQuery): Promise<OfficeOutcome<OfficeConnectorSyncPage>>

/**
 * Recheck current access before returning the owner's retained synchronization fields.
 * @param id - Server synchronization identity.
 * @returns Actual historical metadata with unavailable content withheld.
 */
@Remote connectorSyncDetail(id: OfficeConnectorSyncId): Promise<OfficeOutcome<OfficeConnectorSyncDetail>>

/**
 * Discover actions only for a system in this employee's submitted native conversation context.
 * @param input - Private capture and selected registered system identity.
 * @returns Role-admitted directory after current association and connection checks.
 */
@Remote conversationConnectorActions(input: OfficeConversationConnectorInput): Promise<OfficeOutcome<OfficeConnectorActionsView>>

/**
 * Query a declared read action under the authenticated employee's current native conversation associations.
 * @param input - Private capture and exact reviewed action/connection/provider coordinates.
 * @returns Real bounded result or a current business denial; arbitrary actors and URLs are rejected.
 */
@Remote readConnectorActionFromConversation(input: OfficeConversationConnectorReadInput): Promise<OfficeOutcome<OfficeConnectorReadReceipt>>

/**
 * Save a reviewed connection as the authenticated administrator.
 * @param input - Deployment-approved location and credential alias, version and exact retry UUID.
 * @returns Durable metadata; importing a manifest remains an independent operation.
 */
@Remote saveConnection(input: OfficeConnectorInput): Promise<OfficeOutcome<OfficeConnectorEntry>>

/**
 * Check a reviewed connection with credentials resolved only by its owning office server.
 * @param integrationId - Saved integration identity, never an arbitrary URL.
 * @param revision - Reviewed connection version.
 * @returns Sanitized bounded probe outcome; no business writes or remote response content.
 */
@Remote probeConnection(integrationId: OfficeIntegrationId, revision: number): Promise<OfficeOutcome<OfficeConnectorProbe>>

/**
 * Publish an administrator-reviewed announcement and recipient list atomically.
 * @param input - Plain text, delivery scope and stable retry UUID.
 * @returns Durable publication or a business denial.
 */
@Remote publishAnnouncement(input: OfficeAnnouncementInput): Promise<OfficeOutcome<OfficeAnnouncement>>

/**
 * Acknowledge only this employee's delivered announcement.
 * @param id - Publication identity.
 * @returns Null after durability, or a business denial.
 */
@Remote markAnnouncementRead(id: OfficeAnnouncementId): Promise<OfficeOutcome<null>>

/**
 * Withdraw a reviewed company announcement as the current administrator.
 * @param id - Publication identity.
 * @param expectedRevision - Reviewed content revision.
 * @returns Null after withdrawal, or a business denial.
 */
@Remote withdrawAnnouncement(id: OfficeAnnouncementId, expectedRevision: number): Promise<OfficeOutcome<null>>

/**
 * List or search an employee-authorized virtual drive location.
 * @param input - Space, opaque folder and name query.
 * @returns Only visible metadata and breadcrumbs.
 */
@Remote drive(input: OfficeDriveQuery): Promise<OfficeOutcome<OfficeDriveView>>

/**
 * Create a directory whose owner comes from the Host identity.
 * @param input - Logical destination and name.
 * @returns Committed directory metadata.
 */
@Remote createDriveFolder( input: OfficeDriveFolderInput, ): Promise<OfficeOutcome<OfficeDriveEntry>>

/**
 * Commit actual bounded bytes and their authorized file metadata.
 * @param input - Logical destination, file content, length and stable retry id.
 * @returns File metadata after durability, or a business denial.
 */
@Remote uploadDriveFile( input: OfficeDriveUploadInput, ): Promise<OfficeOutcome<OfficeDriveEntry>>

/**
 * Read immutable file bytes through current employee and ancestor authorization.
 * @param id - Opaque enterprise file identity, never a native path.
 * @returns Verified bytes with their SHA-256 digest.
 */
@Remote downloadDriveFile( id: OfficeDriveId, ): Promise<OfficeOutcome<OfficeDriveDownload>>

/**
 * Rename a reviewed, editable directory entry.
 * @param input - Opaque identity, version and name.
 * @returns Committed metadata or a business denial.
 */
@Remote renameDriveEntry( input: OfficeDriveRenameInput, ): Promise<OfficeOutcome<OfficeDriveEntry>>

/**
 * Replace shared account conditions through ownership and a reviewed version.
 * @param input - Entry, version, default and account overrides.
 * @returns Owner-authorized committed metadata.
 */
@Remote saveDrivePermissions( input: OfficeDrivePermissionsInput, ): Promise<OfficeOutcome<OfficeDriveEntry>>

/**
 * Create and durably dispatch employee work.
 * @param input - Task or to-do fields.
 * @returns committed item or a business denial.
 */
@Remote createWork(input: OfficeWorkInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Execute one internal task/to-do under this employee's reviewed reminder context.
 * @param input - Private capture, stable execution retry identity and work fields.
 * @returns Durable receipt or a current business denial; retries do not create another item.
 */
@Remote createWorkFromConversation(input: OfficeAgentWorkInput): Promise<OfficeOutcome<OfficeAgentWorkReceipt>>

/**
 * Create a meeting and its recipient invitations atomically.
 * @param input - Schedule and invitees.
 * @returns committed meeting or a business denial.
 */
@Remote createSchedule( input: OfficeScheduleInput, ): Promise<OfficeOutcome<OfficeItem>>

/**
 * Submit a task delivery or review its current submission through the authenticated employee.
 * @param id - Existing task identity.
 * @param revision - Parent revision reviewed before submitting or deciding.
 * @param input - Submission, confirmation or return with an explanation.
 * @returns Committed task with retained delivery history, or a business denial without partial changes.
 */
@Remote reviewTaskDelivery(id: OfficeItemId, revision: number, input: OfficeTaskDeliveryInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Replace a task/to-do checklist under its current parent permissions and reviewed version.
 * @param id - Existing work item identity.
 * @param revision - Parent revision reviewed before editing.
 * @param input - Existing entries or null ids for server-created entries.
 * @returns Committed work or a business denial without partial checklist changes.
 */
@Remote updateWorkSubtasks(id: OfficeItemId, revision: number, input: OfficeWorkSubtasksInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Read attachment metadata under current work and Drive access.
 * @param id - Existing task/to-do identity.
 * @returns Available names or metadata-free unavailable references.
 */
@Remote workAttachments(id: OfficeItemId): Promise<OfficeOutcome<OfficeWorkAttachmentsView>>

/**
 * Apply a confirmed archive, recycle-bin deletion or restoration under creator/admin authority.
 * @param id - Existing readable work, including inactive records.
 * @param revision - Item revision reviewed before confirmation.
 * @param input - Action and retained explanation.
 * @returns Committed record or denial without partial lifecycle changes.
 */
@Remote changeWorkLifecycle(id: OfficeItemId, revision: number, input: OfficeWorkLifecycleInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Save reviewed Drive references without granting file access.
 * @param id - Existing open task/to-do.
 * @param revision - Reviewed parent revision.
 * @param input - At most 20 distinct reviewed file versions.
 * @returns Committed work or denial without partial changes.
 */
@Remote updateWorkAttachments(id: OfficeItemId, revision: number, input: OfficeWorkAttachmentsInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Authorize one linked reviewed version before verified Drive download.
 * @param id - Readable task/to-do retaining the reference.
 * @param fileId - Logical Drive file identity.
 * @returns Physically verified metadata or current-access denial.
 */
@Remote workAttachmentInfo(id: OfficeItemId, fileId: OfficeDriveId): Promise<OfficeOutcome<OfficeDriveDownloadInfo>>

/**
 * Query coworkers' busy flags through the company's explicitly enabled internal meeting policy.
 * @param input - Office-local interval, selected members and an optional readable meeting to exclude.
 * @returns Current busy flags or an authenticated business denial, without private meeting content.
 */
@Remote scheduleAvailability(input: OfficeScheduleAvailabilityInput): Promise<OfficeOutcome<OfficeScheduleAvailability>>

/**
 * Update an existing meeting using its reviewed revision.
 * @param id - Existing meeting identity.
 * @param revision - Revision reviewed before editing.
 * @param input - Content, time and optional invitees; the organizer and lifecycle remain unchanged.
 * @returns Committed meeting or a business denial.
 */
@Remote updateSchedule(id: OfficeItemId, revision: number, input: OfficeScheduleUpdateInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Decide a task or transfer a to-do under the current authenticated employee.
 * @param id - Task or to-do being reviewed.
 * @param revision - Last reviewed task revision.
 * @param input - Accept, reject with reason, or transfer to an active new assignee with reason.
 * @returns Committed work with history or a business denial; stale and closed items are not changed.
 */
@Remote decideTask(id: OfficeItemId, revision: number, input: OfficeTaskDecisionInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Edit task/to-do content on the revision reviewed by this employee.
 * @param id - Existing task or to-do identity.
 * @param revision - Reviewed version, including task decisions.
 * @param input - Content and deadline; assignment, kind and status remain unchanged.
 * @returns Committed work or a business denial; stale and closed edits are not written.
 */
@Remote updateWork(id: OfficeItemId, revision: number, input: OfficeWorkUpdateInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Update one authorized item without overwriting a concurrent edit.
 * @param id - Target item.
 * @param revision - Last observed item revision.
 * @param status - Desired state.
 * @returns committed item or a business denial.
 */
@Remote setStatus( id: OfficeItemId, revision: number, status: OfficeItemStatus, ): Promise<OfficeOutcome<OfficeItem>>

/**
 * Answer only this employee's invitation on the version they reviewed.
 * @param id - Invited meeting identity.
 * @param revision - Last observed item revision.
 * @param reply - Accept or decline the invitation.
 * @returns The committed meeting or an expected business denial.
 */
@Remote reply( id: OfficeItemId, revision: number, reply: 'accepted' | 'declined', ): Promise<OfficeOutcome<OfficeItem>>

/**
 * Mark one notification in this employee's own inbox as read.
 * @param id - Recipient-owned notification identity.
 * @returns Confirmation or an expected business denial.
 */
@Remote markRead(id: OfficeNotificationId): Promise<OfficeOutcome<null>>

/**
 * Acknowledge a currently eligible reminder owned by this authenticated employee.
 * @param id - Server-created reminder occurrence identity.
 * @returns A durable read acknowledgement or an expected authorization denial.
 */
@Remote markReminderRead(id: OfficeReminderId): Promise<OfficeOutcome<null>>

/**
 * Edit contact details without changing this principal or authorization role.
 * @param profile - Complete public contact fields.
 * @returns committed employee or a business denial.
 */
@Remote updateProfile(profile: OfficeProfile): Promise<OfficeOutcome<OfficeMember>>

/**
 * Create or edit an employee through administrator authority and a reviewed record.
 * @param member - Complete employee fields.
 * @param expected - Null creates a new identity; a prior record protects an edit.
 * @returns Committed member or a business denial without overwriting another edit.
 */
@Remote saveMember( member: OfficeMember, expected: OfficeMember | null, ): Promise<OfficeOutcome<OfficeMember>>

/**
 * Read only this employee's private conversations and one bounded history page.
 * @param peer - Optional other participant.
 * @param before - Exclusive sequence for older history.
 * @returns Participant-authorized private projection.
 */
@Remote chat( peer?: OfficeMemberId, before?: number, ): Promise<OfficeOutcome<OfficeChatView>>

/**
 * Read only this Host employee's private unsent drafts.
 * @returns Authorized drafts and versions, or an expected denial.
 */
@Remote chatDrafts(): Promise<OfficeOutcome<OfficeChatDraftView>>

/**
 * Read only the current employee's file-message limits and usage.
 * @returns Advertised inline-file policy, or an expected denial.
 */
@Remote chatFileLimits(): Promise<OfficeOutcome<OfficeChatFileLimits>>

/**
 * Publish a private message after its ordered files are durable and verified.
 * @param input - Stable original message identity, caption and bounded files.
 * @returns Published header with immutable file metadata.
 */
@Remote sendMessageFiles(input: OfficeChatFilesInput): Promise<OfficeOutcome<OfficeChatMessage>>

/**
 * Download one private message file as its active sender or recipient.
 * @param input - Message and opaque immutable attachment coordinates.
 * @returns Verified complete content without any server path.
 */
@Remote downloadChatFile(input: OfficeChatFileCoordinates): Promise<OfficeOutcome<OfficeChatFileDownload>>

/**
 * Read only the authenticated employee's file draft metadata and versions.
 * @returns Private contact selections and owner quota without inline file bytes.
 */
@Remote chatFileDrafts(): Promise<OfficeOutcome<OfficeChatFileDraftView>>

/**
 * Save one reviewed private contact selection with bounded real bytes.
 * @param input - Exact retry UUID, contact version and ordered complete files.
 * @returns Durable metadata or a stable denial retaining the existing draft.
 */
@Remote saveChatFileDraft(input: OfficeChatFileDraftInput): Promise<OfficeOutcome<OfficeChatFileDraft>>

/**
 * Restore one file from the authenticated employee's own reviewed contact selection.
 * @param input - Contact, version and opaque file identity.
 * @returns Verified bounded bytes without granting the intended recipient draft access.
 */
@Remote downloadChatFileDraft(input: OfficeChatFileDraftCoordinates): Promise<OfficeOutcome<OfficeChatFileDraftDownload>>

/**
 * Publish the exact reviewed durable selection and reconcile its original clear-on-send decision.
 * @param input - Draft version, captured caption and stable message retry identity.
 * @returns One committed private file message; a retry never clears a newer selection.
 */
@Remote sendChatFileDraft(input: OfficeChatFileDraftSendInput): Promise<OfficeOutcome<OfficeChatMessage>>

/**
 * Save an unsent contact draft using a reviewed version and retry identity.
 * @param input - Contact, text, version and idempotency key.
 * @returns Committed draft or a conflict that preserves the user's local input.
 */
@Remote saveChatDraft( input: OfficeChatDraftInput, ): Promise<OfficeOutcome<OfficeChatDraft>>

/**
 * Send a private human message with an idempotent retry identity.
 * @param input - Message identity, recipient and text.
 * @returns Confirmed message or an expected denial.
 */
@Remote sendMessage( input: OfficeChatInput, ): Promise<OfficeOutcome<OfficeChatMessage>>

/**
 * Acknowledge an observed cursor in this employee's own conversation.
 * @param peer - Other participant.
 * @param through - Message sequence actually displayed to this employee.
 * @returns Durable acknowledgement or an expected denial.
 */
@Remote readChat( peer: OfficeMemberId, through: number, ): Promise<OfficeOutcome<null>>

/**
 * Read the configured office connection without exposing its secret session.
 * @returns Sanitized connection state or a business denial.
 */
@Remote connection(): Promise<OfficeOutcome<OfficeConnection>>

/**
 * Inspect declared local integration packages through the existing profile manager without executing package operations.
 * @returns Actual package selection and Loader phases; gateway mode never represents the employee Host as its server.
 */
@Remote integrationPlugins(): Promise<OfficeOutcome<OfficeIntegrationPlugins>>

/**
 * Sign in to the configured central office and retain its token in the Host credential provider.
 * @param input - Employee id and password, with no claimed role.
 * @returns Sanitized connection state after the credential write completes.
 */
@Remote signIn(input: OfficeLoginInput): Promise<OfficeOutcome<OfficeConnection>>

/**
 * Revoke the central office session before clearing the exact local credential.
 * @returns Confirmation after durable server revocation and local credential cleanup.
 */
@Remote signOut(): Promise<OfficeOutcome<null>>

/**
 * Read only the signed-in employee's device-session handles.
 * @returns Sanitized own-session metadata or a business denial.
 */
@Remote identitySessions(): Promise<OfficeOutcome<readonly OfficeSessionInfo[]>>

/**
 * Revoke a session belonging to the current employee.
 * @param id - Public own-session handle.
 * @returns Confirmation after the server commit.
 */
@Remote revokeIdentitySession(id: OfficeSessionId): Promise<OfficeOutcome<null>>

/**
 * Verify the old password, replace it and revoke every previous session.
 * @param input - Current and replacement passwords.
 * @returns Confirmation; the employee must then sign in again.
 */
@Remote changeIdentityPassword( input: OfficePasswordChangeInput, ): Promise<OfficeOutcome<null>>

/**
 * Discover a safe optional invitation capability without making it a login precondition.
 * @returns Capability from the configured gateway, or null for local, older or unavailable authorities.
 */
@Remote memberInviteCapability(): Promise<OfficeOutcome<OfficeMemberInviteCapability | null>>

/**
 * Read one managed member's latest invitation through current central administrator authority.
 * @param memberId - Existing company employee from the administrator's directory.
 * @returns Safe metadata and current independent facts without a code or hash.
 */
@Remote memberInvite(memberId: OfficeMemberId): Promise<OfficeOutcome<OfficeMemberInviteView>>

/**
 * Sign a reviewed first-password invitation through the selected central authority.
 * @param input - Current member/role, finite expiry and retained issuance request UUID.
 * @returns Original metadata; only the first committed response contains its nonrecoverable code.
 */
@Remote issueMemberInvite(input: OfficeMemberInviteIssueInput): Promise<OfficeOutcome<OfficeMemberInviteIssueReceipt>>

/**
 * Revoke a reviewed invitation without removing an already-set credential.
 * @param input - Exact invitation id and observed revision.
 * @returns Retained revocation metadata after current administrator authorization.
 */
@Remote revokeMemberInvite(input: OfficeMemberInviteRevokeInput): Promise<OfficeOutcome<OfficeMemberInvite>>

/**
 * Accept a limited first-password code without signing in or replacing the current Host account.
 * @param input - Recipient-selected code and new password; no member or role override is accepted.
 * @returns Committed member id for the existing login form, or a safe denial.
 */
@Remote acceptMemberInvite(input: OfficeMemberInviteAcceptInput): Promise<OfficeOutcome<OfficeMemberInviteAcceptReceipt>>

/**
 * Read credential-enrollment presence through central administrator authority.
 * @returns Enrollment presence without credential values, or a business denial.
 */
@Remote identityOverview(): Promise<OfficeOutcome<OfficeIdentityOverview>>

/**
 * Enroll or reset an active employee through central administrator authority.
 * @param memberId - Target employee from the managed directory.
 * @param password - Replacement password; no token or hash is returned.
 * @returns Confirmation after all target sessions have been revoked.
 */
@Remote setIdentityPassword( memberId: OfficeMemberId, password: string, ): Promise<OfficeOutcome<null>>

/**
 * Read authorized formal organization or its explicit first-configuration state.
 * @returns Departments, positions and current affiliations without secret account data.
 */
@Remote organization(): Promise<OfficeOutcome<OfficeOrganizationView>>

/**
 * Adopt the directory's reviewed department/position labels once through administrator authority.
 * @param officeRevision - Office revision displayed at the configuration review.
 * @returns Committed organization; repeated calls preserve existing formal assignments.
 */
@Remote initializeOrganization( officeRevision: number, ): Promise<OfficeOutcome<OfficeOrganizationView>>

/**
 * Create, edit or deactivate one reviewed department.
 * @param input - Opaque department, reviewed version, name and parent.
 * @returns Committed department after server authority and hierarchy validation.
 */
@Remote saveOrganizationUnit( input: OfficeUnitInput, ): Promise<OfficeOutcome<OfficeOrganizationUnit>>

/**
 * Create, edit or deactivate an administrator-managed position.
 * @param input - Position, department and reviewed version.
 * @returns Committed position; this does not grant an authorization role.
 */
@Remote savePosition( input: OfficePositionInput, ): Promise<OfficeOutcome<OfficePosition>>

/**
 * Change a formal employee affiliation through administrator authority.
 * @param input - Employee, department, position and observed assignment version.
 * @returns Committed formal affiliation, independent of editable profile labels.
 */
@Remote assignOrganization( input: OfficeAssignmentInput, ): Promise<OfficeOutcome<OfficeOrganizationAssignment>>

/**
 * Reserve a resumable file using the Host's current authenticated employee.
 * @param input - Reviewed immutable destination, length, digest and retry identity.
 * @returns An owner-only durable ticket or business denial.
 */
@Remote beginDriveUpload(input: OfficeDriveUploadDeclaration): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Recover only the current employee's unfinished uploads.
 * @returns Private resumable tickets, excluding other employees and terminal history.
 */
@Remote driveUploads(): Promise<OfficeOutcome<readonly OfficeDriveUploadTicket[]>>

/**
 * Resolve an owned upload after an uncertain response.
 * @param id - Server-minted upload coordinate.
 * @returns Confirmed receipt state or an indistinguishable missing/foreign denial.
 */
@Remote getDriveUpload(id: OfficeDriveUploadId): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Stage one bounded chunk under current membership, session and directory permissions.
 * @param input - Owned upload, position, digest and canonical encoded bytes.
 * @returns Receipt positions only after durable acknowledgement.
 */
@Remote appendDriveUpload(input: OfficeDriveUploadChunkInput): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Publish the reviewed complete file once after verifying all bytes.
 * @param id - Owned upload identity.
 * @returns A confirmed completed ticket or a retryable denial.
 */
@Remote completeDriveUpload(id: OfficeDriveUploadId): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Cancel owned staging while retaining an already committed file after an uncertain completion response.
 * @param id - Server-owned upload coordinate.
 * @returns The confirmed terminal outcome.
 */
@Remote cancelDriveUpload(id: OfficeDriveUploadId): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Authorize and verify a file before starting bounded downloads.
 * @param id - Logical enterprise file identity.
 * @returns Safe metadata, immutable version and negotiated range size.
 */
@Remote driveFileInfo(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDriveDownloadInfo>>

/**
 * Read version metadata using the employee's current file permissions.
 * @param id - Logical file identity.
 * @returns Authorized version history without content or retry credentials.
 */
@Remote driveHistory(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDriveHistory>>

/**
 * Read the employee's recoverable deleted roots.
 * @returns Authorized owner metadata and current restore capabilities.
 */
@Remote driveTrash(): Promise<OfficeOutcome<OfficeDriveTrash>>

/**
 * Review the exact owned deleted subtree before irreversible cleanup.
 * @param id - Deleted root identity.
 * @returns Current scope totals and confirmation digest.
 */
@Remote drivePurgePlan(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDrivePurgePlan>>

/**
 * Submit the original reviewed permanent-cleanup confirmation.
 * @param input - Exact revision, digest and stable request identity.
 * @returns Durable pending or completed cleanup receipt.
 */
@Remote purgeDrive(input: OfficeDrivePurgeInput): Promise<OfficeOutcome<OfficeDrivePurgeReceipt>>

/**
 * Read an owner's existing cleanup status without touching bytes.
 * @param id - Original deleted root identity.
 * @returns Durable receipt, or null before approval.
 */
@Remote drivePurgeStatus(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDrivePurgeReceipt | null>>

/**
 * Continue only an already approved permanent cleanup.
 * @param id - Original approved root identity.
 * @returns Current durable status; a completed retry does not repeat metadata writes.
 */
@Remote retryDrivePurge(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDrivePurgeReceipt>>

/**
 * Confirm one reviewed owner deletion or restoration.
 * @param input - Exact revision, action and optional restore name.
 * @returns Confirmed metadata or a typed denial; versions and Native files remain retained.
 */
@Remote changeDriveLifecycle(input: OfficeDriveLifecycleInput): Promise<OfficeOutcome<OfficeDriveEntry | OfficeDriveTrashEntry>>

/**
 * Verify one historical file version before downloading its bytes.
 * @param id - Logical file identity.
 * @param versionId - Immutable authorized history selection.
 * @returns Verified version metadata and bounded download coordinates.
 */
@Remote driveVersionInfo(id: OfficeDriveId, versionId: OfficeDriveVersionId): Promise<OfficeOutcome<OfficeDriveDownloadInfo>>

/**
 * Read one immutable version range after fresh employee and ancestor authorization.
 * @param input - Reviewed file, version and bounded byte coordinates.
 * @returns Verified bytes and a range digest.
 */
@Remote downloadDriveRange(input: OfficeDriveRangeInput): Promise<OfficeOutcome<OfficeDriveDownloadRange>>

/**
 * Read this employee's private customization metadata through the selected office authority.
 * @param before - Exclusive own save position, or null for the newest page.
 * @returns Bounded own metadata without requirement bodies.
 */
@Remote customizationRequests(before: number | null): Promise<OfficeOutcome<OfficeCustomizationPage>>

/**
 * Read a currently authorized saved draft for explicit editing or export.
 * @param id - Server-issued request identity.
 * @returns Latest own record; this never sends externally.
 */
@Remote customizationRequest(id: OfficeCustomizationId): Promise<OfficeOutcome<OfficeCustomizationRecord>>

/**
 * Save reviewed private requirements without choosing a recipient or transport.
 * @param input - Strict fields, reviewed version and original retry UUID.
 * @returns Durable original receipt or an expected denial.
 */
@Remote saveCustomizationRequest(input: OfficeCustomizationInput): Promise<OfficeOutcome<OfficeCustomizationSaveReceipt>>
```

Source: [`packages/client/ui-office/src/index.ts`](../../packages/client/ui-office/src/index.ts)

<a id="ctxofficegateway--officegateway"></a>

### `ctx.officeGateway` — `OfficeGateway`

Central authenticated office listener; a separate employee Host retains all native Agent tools.

Source: [`packages/enterprise/office-gateway/src/index.ts`](../../packages/enterprise/office-gateway/src/index.ts)

<a id="office-events"></a>

### `office/*` events

<a id="officeannouncements-changed--parallel"></a>

#### `office/announcements-changed` — parallel

A publication, withdrawal or acknowledgement changed; no text or recipient identities are broadcast.

```ts cordis-catalog
/**
 * A publication, withdrawal or acknowledgement changed; no text or recipient identities are broadcast.
 * @mode parallel
 */
'office/announcements-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officechanged--parallel"></a>

#### `office/changed` — parallel

Committed office revision. Consumers re-read an employee-authorized projection.

```ts cordis-catalog
/**
 * Committed office revision. Consumers re-read an employee-authorized projection.
 * @mode parallel
 * @param revision - New durable revision.
 */
'office/changed'(revision: number): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officechat-changed--parallel"></a>

#### `office/chat-changed` — parallel

Committed private messaging change; consumers re-read only their own conversations.

```ts cordis-catalog
/**
 * Committed private messaging change; consumers re-read only their own conversations.
 * @mode parallel
 */
'office/chat-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officechat-drafts-changed--parallel"></a>

#### `office/chat-drafts-changed` — parallel

Private drafts changed; readers fetch only their authenticated employee's drafts.

```ts cordis-catalog
/**
 * Private drafts changed; readers fetch only their authenticated employee's drafts.
 * @mode parallel
 */
'office/chat-drafts-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officeconversation-links-changed--parallel"></a>

#### `office/conversation-links-changed` — parallel

A private conversation choice version changed; identities and selected capabilities are not broadcast.

```ts cordis-catalog
/**
 * A private conversation choice version changed; identities and selected capabilities are not broadcast.
 * @mode parallel
 */
'office/conversation-links-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officedrive-changed--parallel"></a>

#### `office/drive-changed` — parallel

Drive metadata changed; clients re-read an authorized directory.

```ts cordis-catalog
/**
 * Drive metadata changed; clients re-read an authorized directory.
 * @mode parallel
 */
'office/drive-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officeintegrations-changed--parallel"></a>

#### `office/integrations-changed` — parallel

Company integration catalog changed; no manifest or credentials enter this event.

```ts cordis-catalog
/**
 * Company integration catalog changed; no manifest or credentials enter this event.
 * @mode parallel
 */
'office/integrations-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officeorganization-changed--parallel"></a>

#### `office/organization-changed` — parallel

Formal organization changed; clients fetch their authorized company projection.

```ts cordis-catalog
/**
 * Formal organization changed; clients fetch their authorized company projection.
 * @mode parallel
 */
'office/organization-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officereminders-changed--parallel"></a>

#### `office/reminders-changed` — parallel

Durable central reminder delivery or acknowledgement changed; recipients re-read their authorized view.

```ts cordis-catalog
/**
 * Durable central reminder delivery or acknowledgement changed; recipients re-read their authorized view.
 * @mode parallel
 */
'office/reminders-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)
<!-- END GENERATED cordis-surface -->
