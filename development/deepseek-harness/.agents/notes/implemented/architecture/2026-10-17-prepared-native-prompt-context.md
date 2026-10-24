# Agent Note: Capture Host context at explicit native submission

Status: implemented

English | [中文](2026-10-17-prepared-native-prompt-context.zh.md)

## Problem

Office associations can change while a submitted native prompt waits in its inbox. Reading current associations at model dispatch would describe a different employee selection from the one submitted. Preparing context in the browser would expose metadata admission to client races and require a second prompt representation. Independent native injection can miss a step already being finalized.

## Decision

The Session Controller awaits a Host-owned preparation waterfall before inbox admission. Its payload contains the resolved Session id, native request id, delivery mode and controller lifetime. Providers return immutable text and non-human source metadata. The original user message retains these contributions in its optional RPC-source `preparedContexts`; ordinary input omits the field. Concurrent retries join one preparation, and provider failure or unload prevents admission.

The controller's entering pre-step materializes each captured contribution as an independent identified context message before the original input. Native skill injections retain their existing order and loader. The Agent delivery API, one-message waking contract and model surface derivation remain unchanged. Queue text edits retain the captured source; later association edits do not rewrite it. A rejected pre-step follows the native rule that its claimed input is not requeued.

This is a narrow Host RPC exception to [separate context delivery](2026-07-24-separate-context-injection-from-turn-execution.md): prepared metadata travels with queued input. It does not restore `SendOptions.contexts`, prompt-prefix placement or a caller-supplied envelope. Core inbox code carries an ordinary frozen message without interpreting the field.

Office preparation uses the authenticated central capture service. Snapshots describe selected systems, readiness and unresolved requirements without connection addresses or credentials. They grant no execution authority. A never-saved selection contributes nothing; a reviewed empty selection contributes an explicit empty snapshot. Confirmed sign-out preserves original trusted-Host native use. Operational failures remain failures. Native Chat continues to hide ordinary context; Trajectory exposes the recorded input and producer metadata.

## Alternatives considered

**Read associations only in pre-step.** Queued prompts would adopt later edits, losing the explicit submission's selection.

**Inject context independently before waking input.** Injection has nearest-boundary timing and can enter a different running request. It also leaves delivery and cancellation separate from the prompt being prepared.

**Bake context into the user's text.** This changes what the user appears to have written and duplicates framing across native input, history and model requests.

**Restore generic Agent context attachments.** This spreads a Host-specific transaction through every Agent caller. RPC source metadata keeps that policy with its admitting owner.

## Verification

Native command and real authenticated office Host tests cover concurrent retries, provider failure, disposal, empty selections, opaque request ids and cross-account capture refusal. Browser acceptance checks one actual user message, frozen selections after a concurrent association edit, model-facing text, native skill instructions, attachment bytes and Trajectory reload. The original baseline and current JSONL backends both read the same submitted log without changing its bytes or dropping office metadata.

## Consequences

Prepared text is retained in queued source metadata and then in a separate context record. This costs storage and request tokens but preserves submission evidence without rewriting old history. Central preparation may commit before later native admission fails; it is evidence rather than proof of delivery. A changed review can reject an unadmitted retry. Older Hosts preserve and derive recorded context but do not implement preparation for pending new-format source metadata; office business execution still requires its own current authorization.
