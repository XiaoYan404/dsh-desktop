---
kind: upgrade-guide
description: "MySQL schema verification now requires the workspace-order-and-lease v3 successor."
---

# Upgrade the MySQL Workspace schema

English | [中文](guide.zh.md)

## Change

The optional MySQL provider requires schema v3, adding archive ordinals, explicit Workspace global presence and a fenced registry lease. A v1/v2 database no longer passes normal `schemaMode: verify`. The original 001/002 migration bytes, receipts, logs and file-backed providers remain intact.

Projection activation also requires the MySQL Session persistence provider for the same `storeKey`; JSONL or another namespace is refused. Direct Workspace factory callers must supply both context effects and a logger so background cache failures are visible.

Pure Workspace mutation validation errors now use `StorageMutationValidationError` (`code: invalid-mutation`) instead of the former raw error; `cause` retains it. Only this pre-IO refusal keeps acknowledged caches usable after corrected input. Other backend failures retain their original identities and freeze behavior.

## Migration

1. Back up the approved database and original Workspace documents. Pause every application and database scenario sharing its schema, then drain accepted writes. Different store namespaces do not isolate DDL.
2. Supply a `MysqlWorkspaceAdoption` decision for every existing store to `prepareMysqlSchema` in `packages/storage/mysql/src/schema.ts`. Choose original `global:null` or explicitly adopt the normalized singleton as written. Supply the authoritative `archivedSessionIds` order; refuse migration when only an unordered boolean set survives.
3. Apply the bundled `003-workspace-order-and-lease.sql` through that reviewed upgrade path. Nullable columns precede source-checked backfill and final constraints. No success receipt is written after partial DDL, backfill or verification failure; preserve that state for inspection instead of automatically replaying migration SQL.
4. Confirm schema version 3, its script checksum, twenty InnoDB tables and twenty-five restrictive foreign keys, plus unchanged v1/v2 receipts. Resume applications using `schemaMode: verify`. Select the new Workspace/projection providers explicitly; default JSONL/JSON/SQLite routes are retained.
5. Configure `session-persistence-mysql` and `session-projection-mysql` with the same `storeKey`. Pass the plugin Context to `createWorkspaceMysqlBackend`, including its logger. Custom Host query barriers must flush outside the transaction, then validate the active database lease and call `ownsMysqlWriter` under the store lock; local ownership is not a remote-host flush or employee authorization.
6. Import `StorageMutationValidationError` from the same `@deepseek-ai/dsh-storage` public export used by the providers. Inspect `cause` for the former validation error and retry only after correcting input. Close/reopen and reconcile other backend failures; name/code/outcome matching alone does not establish a safe refusal.

Built CLI/SDK and installer composition must be validated by release integration before deployment. The Workspace lease is not a store-wide migration/export freeze.
