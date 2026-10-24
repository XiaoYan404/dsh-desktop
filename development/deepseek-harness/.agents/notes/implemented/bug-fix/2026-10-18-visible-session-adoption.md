# Agent Note: Check current visibility at explicit Session adoption

Status: implemented

English | [中文](2026-10-18-visible-session-adoption.zh.md)

## Problem

An explicit-id create request can reuse a live Agent or resume persisted history. Entry points that protect listing, renaming and prompts do not constrain this adoption path. A changed employee can activate private history, and cwd/preset conflicts can disclose details before access is checked. Shared creation and its raced-live fallback can also outlast an earlier policy result.

## Decision

The [Host Agent controller](../../../../packages/api/session-controller/src/agent.ts) applies the existing visibility waterfall at adoption boundaries. It checks known live/cold identities before inspecting private compatibility, rechecks after composition before cold activation, and checks each shared-promise waiter before returning its Agent. Visibility rejections propagate before the raced-live fallback. Other creation failures can reuse a raced live Agent only after another visibility check. The command checks current visibility before workspace attachment and after it settles.

The [Client reference decision](../architecture/2026-09-15-client-session-references.md) continues to own borrowed bindings and retained Client generations. The [blank-session policy](../architecture/2026-09-17-process-local-blank-sessions.md) still selects and reuses blanks. Host adoption checks current visibility of its chosen target independently of those Client lifetime rules.

The same controller checks current visibility before scoped live-object delivery or retained-observation activation, after asynchronous composition, and for each shared resume waiter. The [upload service](../../../../packages/client/file-upload/README.md) treats its registered resolver as authority for both live and cold targets. It checks before storing bytes and again before publishing a receipt, with exact Agent identity and resolver-contribution checks. Resolver withdrawal denies uploads until replacement, while a Host that never registered one retains standalone Native behavior. Plugin disposal aborts streaming storage; a saved but unpublished content-addressed object is retained because deleting it could remove shared bytes.

Workspace metadata uses the same history authority. A visibility check only in a Session controller does not protect archive-triggered cancellation, global pins or ordering anchors. The registry therefore admits metadata mutations on its own executor and repeats admission after asynchronous preflight. The API filters response and stream identities at delivery without removing durable membership. An admitted durable write may finish after sign-out; already authorized archive stop requests remain part of that operation. This policy does not turn a shared Host directory into an employee-owned filesystem.

File previews resolve a header separately from Agent lookup. Their owning file service therefore checks the Session before lookup or filesystem access and before delivering bytes, metadata, path-bearing errors or watch frames. A policy returns its registration lifetime and preserves delegated lifetimes; withdrawal suppresses pending reads and closes retained watches. Once a policy has participated, an empty chain remains unavailable until replacement, following the upload resolver's existing withdrawal rule. Native Hosts that never install a policy retain their composed filesystem authority.

The [terminal controller](../../../../packages/api/terminal-controller/README.md) owns metadata and retained streams that also bypass a new Agent lookup. It checks lists and window holds by Session id without activating an Agent, then checks each snapshot, output and state frame against current authority. Policy lifetimes close retained followers or holds after withdrawal; an empty chain cannot restore unrestricted access. Rejection closes observation rather than the shell, preserving the terminal owner's independent process lifetime. Host list consumers await authorization and supply request cancellation; the generated Client protocol remains unchanged.

## Alternatives considered

**Check only in the create wrapper.** A wrapper cannot enforce admission immediately before activation inside asynchronous adoption or before private cwd/preset errors.

**Check only after adoption.** The request can already activate another employee's history and append Native lifecycle metadata. Early checks prevent those effects; later checks cover changed authority and shared waiters.

## Consequences

Installed policies add asynchronous checks to adoption and scope resolution. Native deployments without a provider retain their ordinary creation, writer and idempotency behavior. Existing Session records and wire types remain unchanged. The focused tests cover hidden live/cold office histories, employee replacement during review or storage, original-employee recovery, Native repeated adoption and upload-resolver withdrawal. Other operations retain their current policy owners.
