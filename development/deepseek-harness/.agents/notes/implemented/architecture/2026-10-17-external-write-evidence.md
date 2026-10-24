# Agent Note: External write evidence separates dispatch from a known outcome

Status: implemented

English | [中文](2026-10-17-external-write-evidence.zh.md)

## Problem

An external system and the office JSON backend cannot commit one shared transaction. A timeout or lost acknowledgement after dispatch does not establish that a customer operation failed. Treating it as an ordinary retry can repeat a business effect, while storing success before receiving and retaining authoritative evidence can invent an outcome.

## Decision

An independent versioned execution domain reserves an employee-scoped request and a separate server execution id. The trusted office queue records dispatch before any separate executor may send. Dispatched evidence projects an unknown outcome and cannot dispatch again. Explicit unknown evidence can only resolve to an authoritative success or rejection; cancellation belongs only to an undispatched reservation. Exact terminal acknowledgements preserve their existing revision.

Admission reserves the largest audit envelope and the request's negotiated result capacity. Unfinished requests retain that capacity until a terminal outcome releases unused space. This prevents a predictable quota failure after an external effect. The result bound belongs to the admitted request, so lowering a deployment default does not silently change its existing contract. Failed durability retains the prior conservative stage instead of reporting success.

Private receipt projections omit input values and retry fingerprints. Current employee authentication controls reads, with no administrator ownership bypass. Startup refuses corrupted evidence or a missing original directory/catalog. Restart never interprets a retained dispatch as permission to replay it. The ledger owns evidence; a separate queue-owned write coordinator enforces declared roles, exact provider/connection versions, flat text fields and any supplied private capture before admission. A new retry UUID cannot replay an equivalent unresolved business operation.

The optional trusted adapter receives a fresh private credential, authenticated employee identity and the server execution id as the external idempotency key. The coordinator persists dispatch before invoking it. Cooperative abort, malformed results and unexpected defects after dispatch retain unknown evidence; a safe handling error retains diagnostics only in its private cause. An authoritative result must commit before success is returned. The closed office request list exposes this coordinator, never raw ledger mutations or arbitrary transports.

## Alternatives considered

**Retry every failed request.** A transport failure can follow an already committed remote operation. The ledger requires authoritative reconciliation rather than assuming the operation is absent.

**Record dispatch after the external call.** A crash between the effect and the local marker would leave a reservation that appears safe to send again. The durable marker precedes any effect.

**Charge only current JSON bytes.** An accepted remote operation could consume its remaining quota when its result arrives. Reserving result and audit capacity before dispatch bounds that later growth.

## Verification

Real Loader/JSON tests retain identities across restarts, project dispatched records as unknown and reject repeated dispatch. Fault injection covers reservation, dispatch and terminal commits. Other cases cover private ownership, changed retries, key-order stability, cancellation limits, monotonic timestamps, multibyte bounds, reserved result capacity, policy changes, corruption and lost-directory refusal. Actual local HTTP POST tests verify dispatch durability, rotated credentials, server employee identity and idempotency keys. Committed-but-unconfirmed responses, timeouts, provider replacement/unload, root drain and expired sessions never authorize replay or disclose a late private result.

## Consequences

Internal office creation keeps its existing reservation owner and transaction semantics. External write evidence does not alter Session formats, original native tools or the original office domains. An optional scoped native consumer provides business-write approval and appends real receipts to model history. The employee workbench reads bounded metadata pages and explicit receipt details without replaying operations; cursors and detail identities remain private to the current employee. Declared employee forms review exact fields before sending and retain the same payload/retry UUID after an ambiguous reply. These form operations do not add native model messages. An explicit read-only checker may settle the original receipt using current authority and its original result bound; provider absence and uncertainty never authorize another dispatch. A reservation alone grants no permission to execute, and an unknown result requires authoritative checking rather than automatic resend.
