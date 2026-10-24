---
kind: upgrade-guide
description: "Session adoption, scoped lookup, uploads, file previews and terminal delivery now require current target visibility."
---

# Authorize Session adoption and Native resources

English | [中文](guide.zh.md)

## Change

`session.create` checks `api-session/visible` before adopting an existing Agent or activating cold history, and after asynchronous preparation. Hidden targets return `session/not-found` without disclosing cwd or preset details. Workspace attachment follows the same policy.

Office Hosts reject other employees' attributed conversations, including reviewed empty selections. Original employees retain access; Hosts without visibility policies keep Native creation and adoption. Session formats, writer locks and wire types remain unchanged.

Agent/Session/Host-context lookups and both upload transports check visibility before target delivery or activation. Uploads recheck after storage and withhold receipts after authority changes. Resolver withdrawal denies uploads until replacement; never-configured Native Hosts retain live uploads. Stored bytes may remain without a receipt.

Session-scoped file previews check before header lookup and again before content, metadata or each watch frame. Employee changes suppress late reads. Policy withdrawal cancels retained authority and keeps reads unavailable until replacement; Native Hosts without a policy retain their filesystem permissions.

Terminal lists and holds check Session history authority without Agent activation. Followers recheck each snapshot, output or state frame. Rejection releases observation without killing the shell. Unconfigured Native Hosts retain access; this does not partition operating-system accounts or browser storage.

## Migration

Workspace archive/stop, restore, pin/unpin and ordering enforce current visibility, including anchors and queued preflight. Results and follow frames filter private Session ids. Upgrade the registry, API Workspace Controller and office provider together. Existing data needs no conversion; custom policies delegate the documented Workspace waterfalls.

1. Rebuild the Host Session Controller and `dsh-client-file-upload` with the employee visibility provider. Keep existing Session, attachment and workspace directories.
2. Confirm own live/cold explicit-id adoption; another employee must receive `session/not-found` without activating or modifying private history.
3. Verify Native creation and repeated adoption. Select an authorized target after not-found; writer contention still uses `session/writer-held`.
4. Check binary/encoded uploads and employee replacement during storage. Rejection must withhold receipts. Reloaded resolvers must register replacements; withdrawal cannot restore unrestricted fallback.
5. Upgrade `dsh-api-workspace-files` with office policy. Verify previews and withheld late bytes. Restore policy before retrying `workspace-file/access-unavailable`; custom policies return and preserve delegated cancellation lifetimes.
6. Upgrade `dsh-api-terminal-controller` with office policy. Host callers await `list(sessionId, signal)`; Client wire arguments remain unchanged. Consume `retain`/`follow` to receive admission errors from iteration. Custom `terminal/access` policies delegate and preserve cancellation lifetimes. Restore policy before retrying `terminal/access-unavailable`. Check replacement-employee denial and original-owner reattachment to the same shell.
