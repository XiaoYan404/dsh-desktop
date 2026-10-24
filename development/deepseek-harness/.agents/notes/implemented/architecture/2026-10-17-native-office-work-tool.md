# Agent Note: Bind internal office work to the claimed native input

Status: implemented

English | [中文](2026-10-17-native-office-work-tool.zh.md)

## Problem

A submitted reminder association records employee intent but does not create office work. Adding a global creation tool would expose the capability to unrelated conversations. Binding the tool in `agent/pre-step` is too late for the first request: the native loop assembles tool schemas before that waterfall. An approval can also outlive the employee's selected associations or the plugin itself.

## Decision

The opt-in `tool-office` Host consumer contributes one internal work tool. Each claimed human message supplies its immutable prepared reminder capture. The claim notification precedes prompt assembly, so its exact Agent scope receives the tool before the first schema collection. A later human input replaces the binding; non-human context does not grant one. Turn completion, Agent disposal and plugin unload remove the exact registration without disposing the native Agent scope or its other tools.

The tool requires its exact live calling driver and derives a stable execution UUID from the capture, Agent and native call id. The employee BFF selects the authenticated actor. The [office reservation operation](2026-10-17-office-agent-work-reservations.md) owns current authorization, durable creation and retry recovery; historical prompt metadata is descriptive evidence rather than execution authority.

The default policy adds the existing native manual approval request. An explicit automatic setting skips only this additional request, preserving every other native denial or approval gate. The operation checks plugin and execution lifetimes before and after awaiting the BFF. Unload aborts future execution and removes visibility; cancellation after a committed business write cannot roll it back.

The office request also supplies a complete bilingual review of the immutable execution fields and resolved default owner. It retains another policy's reason and locale entries when that policy already asks. Quoted text prevents embedded newlines from imitating field labels. The existing approval card preserves those labels and wraps long values inside its scroll region while keeping decision buttons visible. Review does not replace server-side authorization after confirmation.

The same claim boundary offers directory/read tools only when the submitted capture contains a selected configured system. Claims are synchronous, so discovery remains an explicit model tool call rather than an asynchronous registration side effect. Current private capture ownership, role, association version and connection version are checked by the office server; a read also retains the provider version returned by discovery. Independent manual read approval shows the exact system, action, employee and versions, while other native decisions remain authoritative. Ordinary tool-result records carry directory metadata and actual business fields into subsequent model input. The consumer owns each registered name and disposer, so a collision neither overwrites another tool nor adds office approval to it.

Selected systems also offer a separate business-write tool. Directory output includes installed write support and frozen public field declarations. Independent manual write approval shows the system, action, employee, precise versions and every unique text name/value row without rewriting it. The same native call identity derives the same retry UUID as internal work. The external write coordinator owns current authority, durable dispatch and authoritative/unknown receipt semantics. A different native call cannot replay equivalent unresolved business values. Actual receipts append to native history and subsequent model input; no original Session format or global tool is replaced.

The native consumer contains unexpected BFF failures before the generic tool runtime formats their diagnostic messages. A stable failure retains the original private cause, while structured business denials keep their existing handling code. This prevents an adapter's credential-bearing exception from entering model input or the durable tool-result text, without turning a failure or unknown write outcome into success.

Submitted PDF references use the same claimed-input registration and native read approval. The office authority checks the exact reviewed version and current file access before obtaining bytes and again before returning parsed text. A complete binary attachment copy could outlive the office grant, so this reader emits bounded page text through the original tool-result log and retains no document cache. One disposable Worker owns each parse with configured input, page, character, output, deadline and V8 heap limits; termination settles before the operation returns. This keeps parser work off the Host event loop and makes cancellation effective. The original UTF-8 reader keeps its separate limits.

Legacy ancestry is restriction evidence, so failure to find it cannot establish a Native scope. History delivery and model/tool admission reject an unresolved child instead of falling back to its empty local fold. A complete retained parent chain with no office claim establishes Native ancestry without a catalog boundary; any attributed parent still needs its exact creation boundary. New runtime children recover their parent before inheriting, preserving current-process proof for Native children. This preserves original logs and avoids inventing an employee when backup evidence is missing.

## Alternatives considered

**Register after pre-step.** Execution can find the definition, but the first model request lacks its schema. The claim boundary preserves the existing loop order without changing core execution.

**Register a global office tool and rely on the description.** Descriptions do not enforce selection, scope or current business authority.

**Create another scope with the same Agent key.** The native Agent already owns that scope. A consumer owns only its registration disposer, not the Agent's shared registry lifecycle.

**Treat approval as durable business authorization.** The employee can unlink a reminder while approval waits. The service rechecks current authority before a new business write.

## Verification

Keyless browser model replies execute the actual native tool and durable office operation. Coverage checks the offered schema, original file tool, one real work item, stable acknowledgement retry, work-page reload and unchanged session events. Native approval allows or rejects creation; unlinking while approval waits rejects a subsequent allow. Unloading during approval prevents a write and retains the original Agent and file tools. A second live native Agent has its original tools but receives no office tool from the waiting conversation.

## Consequences

Focused PDF tests exercise real binary parsing, complete-output limits and Worker cancellation. The real browser selects a PDF in Drive, approves page two, compares the durable result with subsequent model input, and rejects a second read after ancestor access is revoked. Its expected page text is independent of the original Native image and file snapshots.

The enterprise overlay enables this optional consumer; ordinary Web composition keeps it disabled. Submitted reminder requests can create internal tasks or to-dos through native approval. External company-system writes require separate executors. The employee Host remains trusted; this consumer does not isolate office identities from its administrator or independently configured native tools.
