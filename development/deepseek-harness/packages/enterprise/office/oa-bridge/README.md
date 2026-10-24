# OA bridge v1 reference

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Query configured approval records and material requirements, submit reviewed text fields and recover an uncertain submission by its original server execution id. This is a DeepSeek Harness bridge protocol that customers implement in front of their OA systems. It does not describe an existing vendor API or confirm that a customer system is connected. Omit `oa` to leave the provider disabled.

<a id="contents"></a>
## Table of Contents

- [Deployment configuration](#deployment-configuration)
- [HTTP protocol](#http-protocol)
- [Durability and recovery](#durability-and-recovery)
- [Materials and approval progress](#materials-and-approval-progress)
- [Customer commissioning](#customer-commissioning)

<a id="deployment-configuration"></a>
## Deployment configuration

The office server's optional `oa` configuration contains `members`, mapping Office employee ids to distinct bridge actor strings, and `actions`, using the existing `OfficeConnectorActionDeclaration` fields. Actor matching is exact and case sensitive, without normalization; strings must be valid Unicode, contain no controls and have 1–256 UTF-16 code units with nonblank content. Unmapped employees make no bridge request. Each action explicitly declares allowed Office roles; administrators have no role override. Metadata and fields are frozen at registration and bounded by the existing action count and byte settings.

This example declares local integration fields, not a customer's OA form. Put it inside the office plugin's existing deployment configuration; retain that deployment's directory, storage and other settings.

```yaml
connectorAllowedOrigins: ['http://127.0.0.1:48080']
connectorCredentials:
  oa-key: COMPANY_OA_TOKEN
oa:
  members:
    lin: oa-lin
  actions:
    - id: my-approvals
      label: My approvals
      description: Read the mapped actor's configured approval scope.
      kind: read
      allowedRoles: [employee]
    - id: submit-request
      label: Submit request
      description: Submit reviewed text; acceptance does not mean approval.
      kind: write
      allowedRoles: [employee]
      fields:
        - name: title
          label: Title
          required: true
          maxLength: 200
        - name: reason
          label: Reason
          required: false
          maxLength: 4000
```

`COMPANY_OA_TOKEN` names a Host credential reference, not its value. Register the company integration, then use the existing administrator connection form to save adapter `oa-bridge-v1`, base URL `http://127.0.0.1:48080/oa/`, probe path `v1/health` and a declared credential alias. The example service is not shipped or started automatically. Production origins, paths, credentials and authorization must be supplied by the deployment owner. Saving configuration or reading the action directory makes no bridge request. The [connection owner](../README.md#company-connections) defines canonical origins, credential resolution, versions, deadlines and current-session authorization.

Employees and models select only declared action ids and reviewed versions. They cannot override the base URL, HTTP method, private headers, mapped actor or credential. Write fields are unique declared names and literal text, at most 32 fields and 4,000 UTF-16 code units per value; a declaration may impose a smaller limit. Reads have no caller-provided business arguments. Do not encode a URL, arbitrary JSON request or another employee's identity as a transport instruction inside a field.

<a id="http-protocol"></a>
## HTTP protocol

All paths below resolve relative to the saved base URL, retaining its base path. Requests accept JSON and never follow redirects or retry internally. Responses must be complete bounded UTF-8 JSON with exactly the documented fields. The office's existing response, entry and complete-result limits apply; oversized, malformed and unexpected fields are rejected. `summary` and values are plain text of at most 4,000 UTF-16 code units; each nonempty label has at most 200. Remote markup and diagnostic text are not executable instructions.

| Operation | Method and fixed relative path | Context |
|---|---|---|
| Health | `GET v1/health` | Existing private credential headers; no actor |
| Declared read | `GET v1/actions/{actionId}/read` | `X-OA-Actor` |
| Reviewed submission | `POST v1/actions/{actionId}/submit` | `X-OA-Actor`, `Idempotency-Key`, JSON body |
| Original outcome | `GET v1/executions/{executionId}` | `X-OA-Actor`, `X-OA-Action`; no business body |

`actionId` is the registered action id. `executionId` is the Office server's UUID, not the employee's retry UUID or an OA business number. `X-OA-Actor` is the UTF-8 actor string encoded once with `encodeURIComponent`; decode it once in the bridge. Response `actor` is the original Unicode string. `X-OA-Action` contains the declared write action id. Authentication is selected through the existing private connection configuration; aliases using `X-OA-Actor`, `X-OA-Action` or `Idempotency-Key` are refused before any request. The bridge must authenticate these requests and enforce the actor's upstream access; headers alone do not authenticate an actor.

Health returns HTTP 2xx with exactly:

```json
{"protocol":1}
```

A declared read returns HTTP 2xx with the exact mapped actor and action. `data` uses the existing bounded business-result fields:

```json
{"protocol":1,"actor":"oa-lin","action":"my-approvals","data":{"summary":"Approvals observed now.","entries":[{"label":"Status","value":"Pending approval"}]}}
```

Submission sends this fixed JSON body, together with `Idempotency-Key` equal to `executionId`. Neither key nor actor comes from the reviewed business values:

```json
{"protocol":1,"actor":"oa-lin","action":"submit-request","executionId":"00000000-0000-4000-8000-000000000001","values":{"title":"Reviewed purchase","reason":"Verified material summary"}}
```

Submission and original-outcome lookup share one strict HTTP 2xx response. Confirmed acceptance requires all three coordinates to match the request and a durable authoritative result:

```json
{"protocol":1,"actor":"oa-lin","action":"submit-request","executionId":"00000000-0000-4000-8000-000000000001","outcome":{"status":"succeeded","result":{"summary":"Submission accepted; approval is pending.","entries":[{"label":"Request","value":"OA-LOCAL-1"}]}}}
```

The other permitted `outcome` values are `{"status":"unknown"}` or `{"status":"rejected","rejection":"not_accepted"}`. A rejected result can instead use `denied`, `unauthorized`, `rate_limited` or `invalid_input`. Such rejection is authoritative only when the bridge guarantees that this submission was not accepted; it does not mean a later business approval was refused. Extra properties, missing coordinates, another actor/action/key or a protocol other than 1 cannot confirm either success or rejection.

Read HTTP 401/403, 429 and other non-2xx responses retain unauthorized, rate-limited and HTTP failure states. A business POST that loses a response or receives any non-2xx response remains unknown, including 401, 429 and redirects. Lookup failure, HTTP 404, ambiguous matches and changed actor mappings also remain unknown. Raw remote error bodies are not returned to employees or models.

<a id="durability-and-recovery"></a>
## Durability and recovery

The existing Office execution owner commits a reservation and then `dispatched` before invoking the bridge. An exact employee retry returns its original execution; an equivalent unresolved submission cannot bypass it with a new retry UUID. A failed reservation sends nothing. Once dispatch is durable, neither a lost response nor a restart authorizes another POST. A result becomes visible as confirmed only after its Office receipt is durable.

The customer bridge must reserve each execution UUID durably before any upstream business effect, binding it to the exact actor, action and literal text values while ignoring field order. UUID ownership spans all actors and actions in the bridge's stable execution namespace. The same key and input return the retained original outcome without another upstream submission; changing the binding under that key conflicts. Persist authoritative acceptance/nonacceptance before returning a confirmed outcome. An ambiguous upstream result stays unknown and must not be resubmitted automatically. Retain original-key evidence for at least the Office execution retention period and preserve it through bridge restarts and credential rotation. A bridge that cannot meet these obligations must not advertise submission support.

In the existing execution-history page, the employee explicitly checks an unknown submission. The adapter GETs only the original execution UUID with the current mapped actor, action and freshly resolved credentials; no business values are sent. Only a matching authoritative result can settle the receipt. If the Office result write fails, another explicit GET can recover it. Changed saved connections return the existing `connection_changed` state without querying a replacement location. Unavailable providers or revoked authorization do not erase retained evidence or grant retry authority. Back up the existing execution, connection, integration and employee domains together; this adapter creates no separate persistence domain.

<a id="materials-and-approval-progress"></a>
## Materials and approval progress

The existing approval-material template and selected company-file readers prepare sourced explanations and missing-material lists. Submission transmits only the exact reviewed declared text values; no file bytes, paths, Drive references or arbitrary JSON are implicitly uploaded. The bridge owns fixed business-field interpretation, including any configured form scope; model-generated text cannot choose another endpoint or execute commands.

`succeeded` confirms accepted submission evidence, not approval or payment. Terminal execution receipts are immutable and are not continuously polled. Declare separate read actions for the actor's material requirements and approval progress, then use the existing explicit read synchronization and historical snapshots. These reads take no arbitrary request number, filter or employee argument. Live approval decisions, supplement/retraction operations, attachments, callbacks and automatic synchronization are outside bridge v1.

<a id="customer-commissioning"></a>
## Customer commissioning

A real customer connection requires a supplied bridge deployment and verified upstream OA specification. No customer addresses, credentials or authorization agreements are assumed by this adapter. Agree and verify:

- OA product/version, test and production addresses, application scopes, authentication/token/signature requirements and network/TLS policy.
- Exact employee/tenant mappings, actor ownership and permissions, allowed forms, field types, amount/currency precision and material requirements.
- Durable idempotency scope and retention, original-key lookup, authoritative nonacceptance, uncertain upstream recovery and backup/restore behavior.
- Actual query, reviewed cancellation with zero submissions, one accepted submission, explicit rejection, lost acknowledgment, bridge/Office restart, credential rotation and cross-employee denial.
- Any later attachment, supplement, approval-decision or callback work, including its own authorization, signatures, deduplication and ordering rules.

The [adapter source](../src/oa.ts) owns fixed wire handling; the [focused real-HTTP and storage scenarios](../tests/oa.spec.ts) validate this product protocol locally. They do not verify a customer's OA implementation or application permissions.
