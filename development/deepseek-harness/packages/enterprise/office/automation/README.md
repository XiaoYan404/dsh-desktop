# Office automation reference

English | [中文](README.zh.md)

## Summary

Optional Office automation rules admit stable form, trusted business-event, authenticated Webhook and original native Schedule occurrences into employee-private review records. They reuse the existing connector action directory, current employee/role checks, native approval and execution ledger. The module owns no scheduler, arbitrary HTTP writer or inferred model-completion signal. Omit `automations` to keep its domain and product entry disabled; configured limits explicitly specify `maxRules`, `maxRuns` and `maxBytes`.

## Table of Contents

- [Rules and approval](#rules-and-approval)
- [Trigger sources](#trigger-sources)
- [Recovery and compensation](#recovery-and-compensation)
- [Storage and lifecycle](#storage-and-lifecycle)
- [Product integration](#product-integration)
- [Known limitations](#known-limitations)

## Rules and approval

An own rule contains an exact declared write action, current connection/provider revisions, literal business fields, trigger kind/source and optional explicit compensation action. Creation/edit/enable/disable use the displayed rule revision. The owner and admission role are fixed by current authenticated membership. Neither payload interpolation nor a caller-selected employee, transport or credential is supported. Enabling checks current declared fields; disabling remains possible after a provider disappears. Editing invalidates pending execution under the previous revision.

Triggers only create `pending_approval` runs. The public `automation` request accepts closed `list`, `save`, `form`, `review`, `execute`, `manage` and `recover` commands; there is no public business-event, Webhook or Schedule trigger route. `review` returns exact run revision, operation, literal values and original request UUID. Explicit UI confirmation or the existing native write approval precedes `executeReviewed`. Native execution additionally binds the current submission's selected-system capture and compares every field/version to the retained run. Default native approval remains manual; the tool's separate opt-in must be paired with authority-side configuration.

## Trigger sources

The trusted Host-only `admitAutomationTrigger` uses a deployment-owned employee and configured source. Occurrence deduplication is durable over rule identity and source occurrence, including rule edits. Changing the payload or rule revision does not manufacture a replacement occurrence. There are no automatic external writes.

The product-owned Webhook helper authenticates raw bytes using lowercase HMAC-SHA256 hex over `timestamp + "." + body`. Timestamp is canonical epoch-millisecond text within configured `maxSkewMs`; the freshly resolved secret has at least 32 bytes. The exact JSON body is `{"protocol":1,"eventId":"UUID"}`. Employee/source come from the private endpoint binding, not the body. Bound raw request buffering before calling the helper, provide HTTPS/network policy and resolve secrets through existing Host credentials. Durable source-event deduplication handles replay; a local admission result establishes neither remote delivery nor business completion. This is not a WeCom or OA-vendor callback signature protocol.

The native Schedule helper consumes an actual persisted `lastDelivery` receipt bound to the configured employee, original Session and Schedule id. Current Session ownership is checked before admission. Missing delivery evidence yields no run; an inbox receipt does not prove model execution. The [source adapter](../src/automation-native.ts) consumes the supplied existing `schedule/changed` subscription and current authorized catalog reader, aborting and draining reads on disposal; deployment can explicitly refresh it. Missed/pruned receipts are not synthesized; the helper creates no timer and does not edit the original task. Existing native workflows and daily-office skills retain their execution owners.

## Recovery and compensation

Runs retain primary/compensation request UUIDs and references to the original connector ledger. Only its authoritative receipt establishes `succeeded` or definitive `rejected`. Running or failed acknowledgment/storage outcomes project as unknown. Recovery locates the original execution by retained id, or original request UUID when no execution id was returned, and only calls the existing original-execution check. An absent receipt remains unknown without resubmission. Equivalent unresolved writes can share an original ledger id while retaining their distinct automation requests.

Confirmed success can request configured compensation, which receives its own pending review and UUID. Unknown primary outcomes cannot compensate or retry. Definitive nonacceptance or pre-dispatch cancellation can create an explicit child retry requiring a fresh review. Failed compensation retries retain the confirmed original primary and use a new compensation request; the primary is never replayed. Original runs and receipts remain retained. Compensation is a separately authorized business operation, not an assertion of transactional rollback.

## Storage and lifecycle

`enterprise_office_automations` version 1 is a new domain; old Office, outbox, execution and Session generations are unchanged. Strict durable reading refuses inconsistent ownership, repeated occurrences and request rebinding. Bounds stop new admission without deleting deduplication/recovery evidence. Rule/run state commits before publication and before calling the external execution owner. A failed outcome write leaves conservative prior evidence. A crash between the run marker and the connector reservation may have no original ledger receipt; recovery remains unknown and needs authoritative investigation, never a blind retry.

Mutations use one serial owner. Closing stops admission and drains accepted work before domain close. The original employee directory is required on restoration. Backups include this domain, current identity/directory, integrations, connections, execution ledger and provider outboxes together. Post-commit `office/automation-audit` contains rule/run/revision/phase/execution/system/action identifiers and stage only; it excludes fields, credentials, remote responses and locations. Audit observer failure cannot undo a durable mutation or authorize a retry; retained state remains the recovery source.

## Product integration

The Client leaf has account/role/dialog response fencing, a strict rule editor selecting declared operations, a private run list, conservative unknown-result controls and exact separate compensation review. Localized errors direct users to refresh original state. Rendering never dispatches. Source setup is explicitly separate from saving a rule. Host, Remote, Client slot/Locale and native-tool entry registration belong to the shared integration patches; source/component tests do not establish the assembled page or published build.

The GUI enables changes only after a successful current automation-list read. An unavailable service keeps cached records visible and does not present an empty list as success. The editor locks inputs during requests, retains unsaved text after a failed system-directory change and requires explicit replacement of an unavailable operation. Compensation for another system retains its original fields and coordinates as read-only data until explicitly removed; compensation in the selected system requires current versions. A form trigger admits every enabled rule sharing that source, with separate review for each operation.

The run list searches rule names, sources, source occurrences and original request/execution identifiers. Details retain primary and compensation outcomes together and explain why a changed or disabled rule cannot execute. Review displays the target system, original request, run revision, connection/provider revisions and literal values. Lost mutation responses block further changes until a successful read; recovery still checks the original execution. A lost new-rule creation response additionally locks that draft against resubmission even after refresh, because the save API has no client-owned creation receipt. Refresh remains available inside the editor without another save.

## Known limitations

Real customer credentials and source bindings are deployment dependencies. Native Schedule subscriptions, business-event producers and an HTTP ingress route need actual authorized Host wiring; their helper validation does not establish a connected source. Automatic approval-status subscriptions need a separately authorized read-sync policy. Rule saves perform no automatic mutation retry after a lost response: refresh current configuration first. Unknown writes without authoritative original evidence may require customer investigation. There is no third-party exactly-once claim.
