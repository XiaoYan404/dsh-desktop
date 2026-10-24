# @deepseek-ai/dsh-session-migration-mysql

English | [中文](README.zh.md)

Explicit frozen export, resumable staging and guarded selection for the [session-query subsystem](../../../docs/subsystems/session-query.md). This library never scans an ambient Harness home or changes a profile at startup.

## Export and validation

Archive inspection accepts cancellation before opening input and between reads. Reads use one open file, enforce the remaining complete byte budget before allocation, and reject concurrent growth or truncation. Store-v1 and workspace-v2 envelopes reject unmodeled fields with `FUTURE_FORMAT`; complete comparison also checks top-level durable state, so unsupported Office domains cannot disappear behind equal session counts.

`captureArchive()` requires a provider-owned exclusive `MigrationSource.freeze()` capability covering every Host, native writer, workspace mutation, projection publication and generation change. `flush` or a workspace owner's lease alone is insufficient. The archive parent must be explicit and outside the source. Stable operation ids resume immutable files; partial writes retain their temporary file and publish the final path exclusively only after fsync.

Original bytes, all declared historical generations, selected highest source generation, full logical export, SHA-256 inventory and source identity are retained. The final manifest is published last. `readArchive()` checks every byte, source identity and complete-archive budget. Future formats, unsupported UTF-16 values, source changes and incomplete workspace mutations stop migration. Original files remain unchanged, including on failure.

`diffLogical()` compares complete headers, every native event and embedded compact stream, inherited count, surface, generations, append receipts, projections and workspace records/order/archive/pins. Unresolved workspace candidates remain present. A count or summary match is insufficient.

## Import and provider selection

Cancellation before provider selection prevents switching. Once selection commits, verification and the completed receipt finish even if cancellation arrives; cancellation must never imply that the original provider is still selected. Original archives and source bytes remain retained.

`importArchive()` accepts only an explicitly provisioned target with `schemaMode: verify`, a stable run id and an expected empty-target revision. The target owns atomic staging progress, original batch hashes, maintenance fencing and receipt readback. Unknown append COMMIT requires a matching durable prefix; unknown publication COMMIT requires its immutable receipt. Staging is compared deeply before current pointers become visible. Source bytes and operator receipts remain retained.

`activateMysql()` requires explicit MySQL selection, a current source freeze and a confirmed receipt. `rollbackMysql()` holds the MySQL source freeze through full post-switch export, restore to a fresh target, explicit selection and a fresh-load deep comparison. Original provider files and database rows remain retained. Missing baseline lifecycle/history prevents rollback rather than losing data. The integration owner supplies profile selection and keeps writers drained during verification; it must keep both sides stopped after an uncertain selection or reload mismatch.

## Model Experience

None; these explicit maintenance operations register no model tools or prompts.

#### KV Cache effect

None; the library does not send model requests.

## Known Limitations and Deferred Work

Production cross-process freeze, durable MySQL/file staging adapters and integration-owned profile selection are not bound. Calls without these capabilities fail with `FREEZE_UNAVAILABLE`. Protocol fixtures and real filesystem archives are not evidence of a completed database migration or file-provider restore. Current database cut reads give one bounded transaction observation, not an exclusive maintenance lease across operations. The operator sequence and remaining prerequisites are in [the 06 handoff runbook](../../../.artifacts/parallel-handoff/06/RUNBOOK.md).
