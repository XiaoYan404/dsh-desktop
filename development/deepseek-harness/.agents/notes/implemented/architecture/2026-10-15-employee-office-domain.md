# Agent Note: Employee office data stays separate from Agent execution

Status: implemented

English | [中文](2026-10-15-employee-office-domain.zh.md)

## Problem

Employee assignments, to-dos and meeting invitations have owners, recipients and office authorization. Harness Todo, Goal and Schedule describe an Agent's work and follow-up prompts. Using those records as an employee calendar couples human status changes to model execution and does not provide recipient authorization or durable invitations.

## Decision

The [office service](../../../../packages/enterprise/office/README.md) owns an independent versioned StorageDomain. It uses explicit trusted actor identities, checks active membership in each operation and filters reads before producing a day projection. An actor id is not an authentication credential; a transport adapter must authenticate its caller.

One domain commit contains a work item, participation, inbox entries and its audit record. A single owner serializes read-modify-write operations and uses per-item revisions to reject stale edits. The service publishes changes after durability; observer errors are contained after all observers run. Shutdown stops new admissions and drains accepted writes before closing the domain.

The service captures its owning fiber at construction. Cordis rebinds a service's `ctx` to its caller, so reading `this.ctx.fiber` in a public method can inspect the caller's lifecycle and incorrectly admit work while the service unloads.

Private file messages use a separate declaration domain and immutable object tree without adding fields to the original stored text headers. The original header commit determines publication after all bytes are ready; the file ledger can reconcile an uncertain final receipt against that header. Persisting the file identities before writing bytes makes interrupted sends collectable without guessing ownership from a filesystem scan. A positive retained chat watermark prevents a lost original chat unit from being mistaken for an unpublished message. Backups must retain all three components together.

The existing [domain storage design](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) remains the storage owner. This decision adds its office consumer and does not change Session formats, the Agent loop, workspace records, CLI/SDK entrypoints or existing schedules.

Unsent file drafts use a separate bounded atomic unit containing canonical bytes, contact versions and send identities. This avoids filesystem ownership and cleanup decisions for every draft replacement; explicit employee/office logical quotas bound the larger encoded snapshot. Sent files retain their immutable object tree. Persisting an exact draft send before message publication allows a failed clear to recover from the original message rather than sending again or clearing a newer selection.

Connection configuration has an independent domain rather than adding endpoints or secrets to descriptive imports. Deployment-owned origin and credential-alias policy constrains what an office administrator can connect; an administrator cannot select arbitrary ambient model or gateway credentials. Only the owning office server resolves aliases through its credential provider for each operation. This reuses credential rotation and storage ownership without exposing central values to employee Hosts. Readiness and point-in-time network checks remain separate facts, and native MCP/plugin installation retains its original owner.

Connector declarations separate discovery from execution. Exact allowed roles and process-local provider versions prevent a metadata snapshot from authorizing another employee or a replacement implementation. Read callbacks receive server-owned employee identity and private connection inputs, while the employee transport accepts only declared action/version coordinates. Structured plain-text fields bound what the UI renders without treating arbitrary remote documents as executable content. This read-only boundary leaves customer write idempotency and durable execution audit to a separate owner; importing a manifest or viewing its directory cannot create those powers.

## Alternatives considered

**Reuse Agent Todo and Schedule.** Those records track Agent planning and prompt delivery. Employee invitations and per-recipient access need a separate lifecycle, so reusing them would change existing semantics.

**Keep business records in component stores.** That cannot preserve work across Host restarts or enforce authorization for non-UI callers.

**Write one table record per effect without a transaction.** A failed second write could create a meeting without invitations or notifications. The current single-unit backend supports one atomic office commit; a future centralized transactional provider can scale this without claiming JSON files coordinate separate Hosts.

## Consequences

The office package is opt-in and supplies business operations; separate UI and authenticated gateway packages consume them. Messaging, text/file drafts, file messages and drives have independent durable domains. Multiple employee Hosts connect to one central office writer rather than concurrently mutating shared JSON files. Complete snapshots still grow with office history; scalable transactional storage and customer connector execution remain separate work. Each UI owns its draft-save confirmation and recovery flow.

The Loader composition tests use the real JSON backend to verify persisted work and replies, authorization, stale writes, invalid input, notification failure, restart and unload during a pending commit. A keyless snapshot pins the authorized day projection. These tests do not establish SSO, external calendar delivery or a finished enterprise UI.
