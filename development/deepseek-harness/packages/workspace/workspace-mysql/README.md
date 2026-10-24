---
description: "Select a fenced MySQL Workspace backend with exact ordering and acknowledged publication."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-mysql

English | [中文](README.zh.md)

## Use this package

Load the existing MySQL and Storage services, then explicitly configure this plugin with `storeKey`, `backendName`, `leaseTtlMs` and `heartbeatIntervalMs`. Route only `workspace` to that backend through StorageDomain. The administrator provisions the store and schema; normal activation requires schema v3 and `schemaMode: verify`. The heartbeat interval must be at most one third of the lease TTL.

## Persistence and lifecycle

Canonical tables retain original IDs, canonical paths, timestamps, candidate ledgers, display order, archive order, pins and the retained default Workspace identity. An explicit global-written bit keeps unwritten `global:null` distinct from a materialized singleton. Record-only bootstrap writes preserve that bit. Atomic create/delete use the existing Domain bridge; all caches and events publish after SQL acknowledgement.

All mutations lock the store before slots. A single registry lease excludes another process from owning a conflicting synchronous cache. Its exact fence and database expiry are checked on writes; a conservative monotonic deadline refuses local reads after ownership expires. IO, unknown commit or CAS failure freezes dependent caches until close/reopen. The first freeze reports a warning and cancels further heartbeats. Retirement drains Registry producers, Domain writes and units before releasing SQL; it never waits for its own consumer disposal callback.

Mutation cloning or pure plan validation failures before SQL are reported as `StorageMutationValidationError` with `code: invalid-mutation`, `outcome: not-started` and the original error in `cause`. Domain, Registry and held Entity caches keep their acknowledged values, so an explicitly queued corrected input can proceed. Ownership guards still apply. SQL, lease, CAS and unknown failures retain their original objects and freeze caches; a matching error code alone never grants recovery.

## Model Experience

### Workspace context

The provider adds no model prompts, tools or tokens. Existing Workspace consumers continue to determine model context. JSON/SQLite routes remain available.

## Known Limitations and Deferred Work

The backend serves only the Workspace domain. Existing stores need an explicit global-presence decision and authoritative archive order during the [schema upgrade](../../../docs/upgrade-guide/v0.2.1-alpha.2/mysql-workspace-v3/guide.md). An old boolean archive set cannot recover that order. Pending legacy mutation markers must first be recovered by the original provider. Session creation and Workspace attachment remain separate native operations. This registry lease is not a store-wide maintenance/export freeze. Malformed UTF-16 identifiers are refused without replacement.
