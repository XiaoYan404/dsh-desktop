---
description: "Create internal office tasks and read or submit declared company operations through authenticated native tools."
kind: "package-reference"
---
# Native office tools

English | [中文](README.zh.md)

## Summary

You can create internal tasks and to-dos after submitting a reminder association, or read and submit declared operations in a company system selected in the current conversation. Current employee permissions and native approval protect execution. Confirmed work remains on the workbench; actual query results and durable business receipts enter the native history. Native runs without submitted office context keep their existing behavior.

See the [Drive-reader reference](../office/drive-readers/README.md) for optional image, authorized knowledge and Office delivery-check configuration, authority, retention and limitations.

## Table of Contents

- [Configuration](#configuration)
- [Execution](#execution)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Configuration

The enterprise workbench overlay enables this plugin; the standard Web bundle keeps it disabled. `approval` defaults to `manual`, which adds the existing native approval request before office creation. `automatic` delegates to the remaining native policy chain without adding that request. Existing denials and approval decisions remain authoritative.

`readApproval` independently defaults to `manual` for remote business queries and submitted company-file reads. `automatic` skips only this additional read confirmation. Action-directory discovery performs no remote business request and retains the other native policy gates.

`writeApproval` independently defaults to `manual` for customer business submissions, including when internal work or reads use automatic mode. `automatic` skips only this additional business-write confirmation; all other native decisions and server authorization still apply.

`pptx` defaults to `false`, preserving the existing file-tool set. Set it to `true` to offer `office_read_pptx` on submitted-file turns; the serving Office authority must independently enable its complete `conversationPptx` policy. Enabling this consumer grants no authority or automatic approval.

## Execution

A live Agent that claims submitted `office` or `office-files` context stays with its first employee. Steering without office context cannot remove that ownership. Child Agents inherit an employee and role snapshot and retain it after their parent ends. A consistent new submission from the same employee can review a changed role; another employee cannot take over the live Agent. Descriptive captures grant no execution permission.

Before a model step and around each approved Native tool dispatch, the plugin checks the authenticated office connection, current employee and role, exact live Agent and plugin lifetime. Account replacement, sign-out, deactivation or a changed role prevents further admission and withholds late final tool results. A previously admitted operation may already have committed; inspect its original outcome before retrying.

For an office-owned conversation, the Native model stream checks current authority before dispatch and before publishing each chunk. A failed check closes the upstream iterator; rejected chunks enter neither the live assistant publication nor the committed attempt. Content already published while authorized remains in history. Unassociated Native calls and auxiliary calls keep their existing stream behavior. These checks can add office-connection requests in centralized deployments; the original model request, output chunks and cancellation signal are preserved.

The Host-only `officeRunOwnership` projection rebuilds recorded employee affiliation from Native input and inheritance events after plugin reload or Agent resume. Its cache state version is 3; cached state is a fold shortcut, never an authorization credential. Pending input pins its employee but cannot change the role of current work. A role review takes effect when that input is claimed. Mixed-employee histories remain restricted. Original event records are preserved. Explicit follow-up can resume a queued review after an earlier authority failure, following the Native driver's existing queue behavior.

The [employee BFF checks attributed history reads](../../client/ui-office/README.md#understand-the-implementation) independently of office tool enablement. This plugin's runtime guards continue to own model and tool admission.

A child created under an office-owned runtime or scoped parent logs `office/run-inherited` before accepting work. The record retains the employee, role and restrictions without retaining the parent object; cold resume can recover them after the parent exits. It grants no authority and never enters model history. Readers without this required event refuse that child log. Historical descendants created without either attribution or an inheritance record cannot reconstruct a missing parent's affiliation.

Submitted drive references offer `office_read_file` only to their exact running Agent for the current turn. It accepts a selected `file_id`, UTF-16 `offset` and `max_characters` from 1 through 16,384. Manual review displays the file name, id, version, SHA-256, employee and complete read window. Each actual read rechecks the active employee, captured role, ancestor permissions, exact latest version and digest. UTF-8 files are limited to 1 MiB; binary or invalid encoding returns no body. Results contain verified metadata, inert text, `next_offset` and `eof`. Later selection edits leave the submitted snapshot intact; permission withdrawal still denies reading. Stopping, disposal or unload prevents a late body from entering the result. No bytes are copied into native attachment storage.

`office_read_pdf` reads actual selectable text from one submitted PDF page with the same native read approval and live Agent checks. It accepts `file_id`, one-based `page_number`, page-relative UTF-16 `offset` and `max_characters`. Approval adds the exact page and window to the reviewed immutable file metadata. The office service owns configurable byte, page, text, worker-memory, deadline and complete native-content JSON limits. `nextOffset` and `eof` describe continuation within that page; no OCR is performed. Exact metadata and text enter the original `tool/result` and the next model request. Stop, disposal and unload cancel parsing; no complete document or native attachment copy is cached. Scanned pages can have no text, while encrypted, damaged and over-budget PDFs return a stable failure without a body.

`office_read_docx` reads actual `.docx` main-body paragraphs and source-order table cells through the same scoped native approval and result pipeline. Its `file_id`, UTF-16 `offset` and `max_characters` identify the exact reviewed file and window. Results include immutable metadata, paragraph/table counts, `text`, `nextOffset` and `eof`; tabs separate cells and line breaks separate paragraphs and rows. The [office service](../office/README.md#prepared-contexts) owns ZIP/XML/text, worker and complete-result limits and the final queued authority check. Native cancellation reaches the disposable parser. Body text is untrusted data; headers, footnotes, comments, drawings, old `.doc`, pagination and OCR are outside this reader.

`office_read_xlsx` reads saved spreadsheet cells through the same native read approval, live Agent checks and exact `tool/result` log. `sheet_number` follows workbook order from 1; `offset` and `nextOffset` count stored cells within that sheet, and `max_cells` is 1–256. Approval displays the exact immutable file, sheet and cell window. The result includes the bounded worksheet directory, typed cells, addresses, hidden states and `eof`. Numeric amounts and date serials preserve raw XML strings; use `dateSystem` and `numberFormat` to interpret them. Formula text remains inert, and `cacheState` distinguishes missing caches from saved results that may be stale, including zero and false. No recalculation, external-link refresh or macro execution occurs. The [office service](../office/README.md#prepared-contexts) owns archive checks, worker lifetime, cancellation, final authority and complete JSON limits; it never truncates a formula or numeric value to fit a result.

`office_read_pptx` reads saved presentation text through the same native read approval, exact live Agent and durable result path. It requires `file_id`, relationship-ordered `slide_number`, explicit `section` (`slide` or `notes`), UTF-16 `offset` and `max_characters`. Approval displays the immutable file/version/digest, employee, slide, section and window. Notes remain separate and are never requested automatically. Results include the bounded slide directory, hidden/notes flags, saved shape/group/table text, counts and section-relative continuation. The [office authority](../office/README.md#prepared-contexts) owns explicit archive/XML/text/worker/output limits and current authorization before and after parsing. No rendering, OCR, macros, attachments or external fetching occurs; saved presentation text is untrusted data.

Captured reminder requirements must be registered, linked and configured before the tool is offered. Each new human input binds its own captured context. The registration belongs to that Agent and ends with its turn, disposal or plugin unload. The tool defaults to the submitting employee when `owner_id` is omitted. Known active employee ids may be supplied for assignment. Dates and work fields are validated by the office service.

Approval shows the work kind, title, local date and time, owner id and complete description from the native call's immutable arguments, including the submitting employee when ownership is omitted. Quoted values keep embedded newlines distinct from field labels. Long content scrolls within the existing approval card. Another native policy's approval reason and locale entries remain visible alongside these fields, including in automatic office mode. Confirmation does not rewrite the arguments.

The exact live driver must own execution. Capture ownership, current role, reviewed choices, required connection versions and current availability are checked by the office service before a new write. The native call and capture derive a stable execution UUID, so retrying the same invocation reconciles its original item. The canonical result contains the office item id, owner, status and request coordinates. [The office reference](../office/README.md#agent-work-execution) owns persistence and retry semantics.

Selected configured systems offer action discovery and read tools in that exact Agent scope. Discovery returns only current role-admitted metadata and the precise connection/provider versions. A read requires those reviewed coordinates; approval shows the actual system, registration name, action id, employee and versions. The office service rechecks the private capture, current role, current associations, connection and provider. Unlinking or changing the reviewed connection rejects execution rather than adopting new authority. Reads accept no alternate employee, URL, credential or arbitrary query arguments. Actual bounded plain-text results use the original tool-result log and become available to the next model request. Failed network statuses contain no business fields; another explicit call performs another query.

Unexpected BFF infrastructure failures expose a stable office-service error and retain their private cause. Raw adapter, credential-provider or storage diagnostics never become native tool-result text. An unknown write outcome requires checking the original operation before retrying; this boundary never reports success or rolls back committed work.

`office_write_action` consumes the discovered write capability, declared fields and exact versions. Approval displays the selected system, registration, action, submitting employee, versions and every supplied name/value row. Duplicate names and malformed or oversized rows reject before approval; the server enforces the current declared required fields, roles and optional capture. The same native call retains its retry UUID. The [write coordinator](../office/README.md#external-write-evidence) persists dispatch before calling a customer adapter and prevents a new call UUID from replaying equivalent unresolved business input. Structured output distinguishes succeeded, definitive rejection and unknown; only authoritative durable success carries confirmed result fields. Another Agent or a later unassociated turn gains no write contribution.

Legacy child recovery uses retained parent evidence before model or tool admission, including after plugin reload. It appends the existing required inheritance event before continuing a proven attributed child; pending new input cannot bypass the catalog check. A complete parent chain without any office claim proves Native ancestry even without a catalog. Missing parents, missing query support or an attributed parent without an exact catalog reject continuation with `OFFICE_NATIVE_AUTHORITY_UNAVAILABLE` and backup-restoration guidance. New runtime-owned children inherit only after the parent passes recovery; proven new Native children retain their process-local Native status. Cancellation and plugin withdrawal abort parent observations and drain outstanding reads. See the [legacy-child upgrade guide](../../../docs/upgrade-guide/v0.2.1-alpha.2/office-legacy-child-history/guide.md). Unresolved history never becomes a current-employee assignment or permission grant.

### Meeting minutes automation

When the native skill registry is present, this opt-in plugin also contributes the bundled `office-minutes` skill. Use its installed entry on the Tools page, or send `/office-minutes` with the meeting material and desired output. The existing meeting-minutes request template remains a separate unsent starter. Project and user skill precedence is unchanged, and unloading this plugin removes its bundled contribution.

The skill reads supplied notes, runs the native `workflow` tool with extraction and review children, then writes, verifies and presents an actual Markdown file. A requested Word file additionally requires the installed `office-docx` skill. It retains uncertain facts and does not infer missing owners, dates or decisions. Missing material or unavailable workflow execution is reported before claiming completion. The [skill instructions](assets/office-minutes/SKILL.md) own the workflow script and delivery procedure.

Original native tool calls, workflow members and terminal results remain in the Session history, including failed or cancelled attempts. A delivery appears only after the actual file is written and the original `present` operation succeeds. Stopping does not delete files already written. Native policies continue to govern reads, workflow children and writes; loading a skill grants no permission. This skill sends no minutes and creates no office tasks, reminders or company-system submissions without a separate explicit request.

### Daily reports and reimbursement checks

The same provider contributes `office-daily-report` and `office-expense-check`. Select their installed Tools entries or invoke them explicitly with source paths and requirements. [Daily reports](assets/office-daily-report/SKILL.md) require an explicit calendar date and actual work notes or authorized office read results. Their extraction and review workflow keeps completed work separate from plans and marks unknown figures and coverage.

[Reimbursement checks](assets/office-expense-check/SKILL.md) consume an actual JSON ledger and an explicit JSON company-rule document. The native workflow parses those documents and calculates separate currency totals in integer minor units, detects duplicate receipts, missing rule-required fields, invalid amounts, per-item limit violations and claimed-total mismatches, then asks a child Agent to review the actual evidence and checks. Rule documents declare currency precision, per-item limits and required fields; missing rules stop execution or remain explicitly unchecked. Source extraction from other formats needs installed readers and retained source references. No exchange rates, tax rules, rounding, approval conclusions or payments are inferred.

Both report skills write, reread and present real files through existing native tools. The reimbursement report retains the exact structured checks alongside review text. Original inputs remain in place, and failed or cancelled attempts remain in native history without a completed delivery. These skills do not submit business operations or send reports.

### Native task reminders

`office-task-reminder` uses the existing `schedule_create`, `schedule_list`, `schedule_update` and `schedule_delete` tools. Its [instructions](assets/office-task-reminder/SKILL.md) require the reminder content, explicit timing and the current AI conversation as target. Local calendar times require a date and IANA zone. A coworker, external chat or office item is not silently replaced with that conversation; creating office work remains a separate explicit operation through its existing association and approval path.

The skill reports the real saved task id and target and verifies active state with native listing. Cancellation deletes the selected native reminder and retains its original tool-call/result history; it cannot retract input already queued. Stopping a model turn does not delete an already saved reminder. Actual due-delivery receipts acknowledge durable inbox input, while model replies and task completion remain separate facts. The configured Host must run to deliver, and existing recurrence and crash-recovery semantics apply. No extra scheduler or permission grant is installed.

## Dev Note

The [binding decision](../../../.agents/notes/implemented/architecture/2026-10-17-native-office-work-tool.md) explains why inbox claims own registration timing and why this consumer releases only its own tool contribution.

## Model Experience

### Internal work creation

#### What the model sees

The selected reminder conversation receives the [office_create_work schema](../../../docs/tool-catalog.md#office_create_work). It creates an internal task/to-do and returns structured item coordinates; it does not send an external company-system message or schedule an Agent prompt. A conversation without a qualifying submitted reminder receives no work-creation schema.

#### Token effect

The offered schema and returned JSON consume request tokens. No additional system-prompt section is installed.

#### KV Cache effect

Scoped tool additions and removals follow the original native tool-update mechanism. Existing history and system prompts are not rewritten.

### Company-system queries

#### What the model sees

A submitted configured system offers [office_list_actions](../../../docs/tool-catalog.md#office_list_actions) and [office_read_action](../../../docs/tool-catalog.md#office_read_action). The model discovers the current directory before querying an explicitly declared read action. Read status distinguishes real data from network/authentication failures. Business fields remain data rather than instructions; write declarations cannot execute through the read tool.

#### Token effect

Scoped schemas, directory metadata and actual query fields consume request tokens. The original native result handling owns output budgeting and presentation.

#### KV Cache effect

Tools follow the original native tool-update mechanism. Query results append to the existing conversation without rewriting prior messages or system prompts.

### Company-system submissions

#### What the model sees

The selected system scope offers [office_write_action](../../../docs/tool-catalog.md#office_write_action). Discovery reports `write_supported` and declared field names, labels, required flags and length limits. The model supplies unique text name/value rows and reviewed versions. Durable output includes the execution id, original retry UUID, stage, status and sanitized result. An unknown outcome instructs the model to check that execution rather than submit the business operation again.

#### Token effect

The scoped schema, public field metadata, submitted values and actual receipt consume request tokens. Approval uses the same immutable call fields; no additional system-prompt section is installed.

#### KV Cache effect

The original native tool mechanism updates scoped availability. Calls and receipts append to existing history without rewriting prior messages or Session formats.

### Submitted company files

#### What the model sees

The employee Host logs descriptive file-version snapshots before admission. `office_read_file` reads verified UTF-8 windows, `office_read_pdf` extracts one actual PDF page, `office_read_docx` extracts Word body paragraphs/table cells and `office_read_xlsx` returns exact saved spreadsheet cells. The optional `office_read_pptx` reads one explicit saved slide or notes section. Their schemas and actual results use the original native tool pipeline. File text and formulas are untrusted task data. A capture grants no access outside the live calling Agent or office authorization.

#### Token effect

Submitted metadata, scoped schemas and returned text consume request tokens. Text readers bound characters; XLSX bounds whole stored cells. PDF, DOCX, XLSX and PPTX also bound complete escaped native tool-content JSON bytes. The native result budget still applies.

#### KV Cache effect

New context and tool results append to the logged history. Existing messages are preserved, and scoped tool availability follows the native mechanism.

### Meeting minutes

#### What the model sees

Native discovery advertises the `office-minutes` description. Explicit invocation or the existing `skill` tool loads its full instructions through the original logged skill mechanism. The instructions require the existing workflow, filesystem and delivery tools; this package contributes no replacement executor or model response. Workflow child requests contain the supplied source material and draft for review.

#### Token effect

The skill catalog, loaded instructions, two child requests, tool results and reviewed text consume their normal native request tokens. Source material is sent to each child; the original tool and model budgets still apply.

#### KV Cache effect

Skill instructions and execution results append through the existing native history. The provider does not rewrite prior messages or install an additional system-prompt section.

### Daily reports, reimbursement checks and reminders

#### What the model sees

The existing catalog advertises the three additional skill descriptions. Native loading records their instructions. Report skills call the existing workflow and filesystem tools; the reimbursement workflow returns exact structured checks and a source review. Reminder instructions call existing Schedule tools and inspect their actual success or structured validation errors. This provider creates no execution or delivery records merely by loading instructions.

#### Token effect

Loaded instructions and native results consume their usual request tokens. Daily-report extraction and review each receive source text. Reimbursement review receives the parsed ledger, rules and calculated checks. Reminder execution adds its actual Schedule calls and due prompt; the original request budgets remain authoritative.

#### KV Cache effect

The additional catalog metadata and explicitly loaded instructions use the existing skill mechanism. Execution and due input append through native history without rewriting earlier messages or changing Session formats.

## Known Limitations and Deferred Work

- Report skills require the configured native workflow engine and file tools. They supply instructions, while source interpretation and review quality remain with the selected model and installed readers. Reimbursement arithmetic accepts sourced JSON and nonnegative decimal amounts with an explicitly declared currency scale from zero through six; currency conversion, refund and tax calculation need separate explicit handling. Unknown rules remain unchecked.
- Reminder delivery supports the current native conversation and requires the existing Host Schedule service. External notifications and office work creation are separate operations. A saved delivery receipt establishes inbox delivery rather than a model response or completed task.

- Actual customer adapters and arbitrary parameterized queries remain separate work. Employee history offers explicit outcome checking; this plugin adds no separate native checking tool. Metadata alone installs no read or write implementation. Employee forms use the same coordinator independently of native tool approval.
- Cancellation can occur after an internal business write commits. Its stable request identity supports acknowledgement recovery; cancellation does not roll back a committed item.
- The serving employee Host remains trusted. This plugin does not create a security boundary against its administrator or independently configured native tools.
- Submitted PDF reading extracts selectable text; DOCX extracts body paragraphs/table cells; XLSX reads exact saved cells and explicitly stale or missing formula caches; optional PPTX reads saved slide or explicit notes text. Formula recalculation, other Office formats, OCR and visual layout remain separate work.
