# OA bridge v2 reference

English | [中文](README.zh.md)

## Summary

`oa-bridge-v2` is a product-owned protocol for customer bridges, separately selected from [v1](../oa-bridge/README.md). It implements declared approval queries, material requirements, status snapshots, reviewed submissions, supplements, withdrawals and approval/rejection requests. It does not identify a vendor API or establish a customer connection. Omit `oaV2` to keep it disabled; register the provider with a current allowed origin, private credential alias and `v2/health` probe.

## Table of Contents

- [Configuration](#configuration)
- [HTTP operations](#http-operations)
- [Materials](#materials)
- [Acceptance and recovery](#acceptance-and-recovery)
- [Known limitations](#known-limitations)

## Configuration

`members` maps Office members to distinct exact bridge actors. Each `actions` entry contains an ordinary role-admitted `declaration`, a fixed `scope`, an explicit `materials` boolean and one operation: `approvals`, `requirements`, `status`, `submit`, `supplement`, `withdraw`, `approve` or `reject`. The first three are read declarations; the rest are writes. Neither employees nor models supply a URL, method, credential, actor, operation or scope. Non-submit mutations require declared, reviewed `approval_id` and positive safe-integer `expected_revision` fields. The bridge must enforce current upstream ownership, approver eligibility, workflow transitions and revision conflicts; Office administrator status supplies no business approval override.

The existing directory, timeout, complete-response, result and entry limits apply. `maxMaterialBytes` is explicit, at most 16 MiB over all attachments. Actions using materials must declare the `materials` field and select only `submit` or `supplement`. Advertising materials without an authorized immutable reader fails configuration. The [adapter](../src/oa-v2.ts) validates configurations before requests; the [material reader](../src/oa-materials.ts) reuses Office's existing Drive authorization and object reader inside its owning queue. Calling public queued Drive methods recursively from an adapter is forbidden.

## HTTP operations

All paths retain the configured base path. Requests neither redirect nor retry internally. `X-OA-Actor` is the once-percent-encoded mapped actor; authentication uses existing Host credential headers. Reserved identity/action/idempotency headers cannot be supplied through credential aliases.

| Operation | Fixed request |
| --- | --- |
| Health | `GET v2/health`; exact response `{"protocol":2}` |
| Declared read | `GET v2/actions/{actionId}/read`, `X-OA-Actor` |
| Reviewed mutation | `POST v2/actions/{actionId}/submit`, `X-OA-Actor`, `Idempotency-Key` |
| Original outcome | `GET v2/executions/{executionId}`, `X-OA-Actor`, `X-OA-Action` |

A read response has exactly `protocol: 2`, matching `actor`, `action`, `scope`, `operation`, ISO `observedAt` and `approvals`. Each approval has `id`, positive integer `revision`, `state` and a bounded `requirements` text list. States are `pending`, `needs_materials`, `approved`, `rejected` and `withdrawn`. Duplicate ids and oversized complete projections are refused. These are observed business states, separate from immutable submission receipts; existing explicit read synchronization can retain their snapshots.

A mutation body has exactly `protocol: 2`, mapped `actor`, declared `action`, fixed `operation` and `scope`, original `executionId`, exact reviewed `values` and explicit `attachments`. Its `Idempotency-Key` equals the server execution UUID, never a business approval number. Non-submit operations include reviewed `approval_id` and `expected_revision` in `values`.

Submission and original-outcome responses have matching `protocol`, `actor`, `action`, `scope`, `operation`, `executionId` and `outcome`. Accepted outcome is `{"status":"succeeded","acceptance":"accepted","reference":"OA-1"}`. Other outcomes are `{"status":"unknown"}` and `{"status":"rejected","rejection":"not_accepted"}`; rejection also permits `denied`, `unauthorized`, `rate_limited` and `invalid_input`. Definitive rejection means no upstream acceptance. It never represents a later refusal of the business approval. Unsupported fields or mismatched coordinates remain unknown.

## Materials

The reviewed `materials` value is a strict JSON list of at most 20 distinct `{id, version, sha256}` immutable Drive references. It is a declared business field, not arbitrary transport JSON. Each item resolves under the current employee and ancestor permissions; the reader checks the exact version/digest, verifies real bytes and repeats authorization after every asynchronous chunk and before submission. Paths and caller-provided attachment URLs are absent. The adapter removes this reference field from ordinary `values` and sends each verified attachment as `{id, version, sha256, name, mediaType, contentBase64}`. The bridge must bind the exact metadata and bytes to the original execution key.

## Acceptance and recovery

The original Office execution ledger reserves and marks dispatch before calling the adapter. A successful execution means accepted operation evidence; approval state must be queried separately, including after an `approve` request. It never establishes delivery, payment or model completion. Business POST network errors, non-2xx responses and ambiguous acknowledgments remain unknown. Recovery sends only GET for the original UUID with current credentials and original configured connection. No attachments are re-uploaded, no business POST is replayed, and lookup absence does not authorize a retry.

The customer bridge must durably bind UUID, actor, action, scope, operation, exact values and attachments before an upstream effect, retain authoritative outcomes across restarts/credential rotation, and enforce revision/permission rules itself. A database commit receipt does not establish exactly-once third-party effects. Preflight or result-storage failures may conservatively leave unknown evidence; the UI directs employees to original-execution recovery.

## Known limitations

The protocol is locally tested with real Loader, loopback HTTP, Office uploads and JSON storage. Customer/vendor authentication, addresses, permission scopes, real employee mappings, upstream idempotency and recovery remain commissioning dependencies. Automatic approval-status subscriptions need a configured authenticated source and read-sync policy; v2 has no vendor callback parser or autonomous polling timer. Existing v1 data and Session formats are unchanged.
