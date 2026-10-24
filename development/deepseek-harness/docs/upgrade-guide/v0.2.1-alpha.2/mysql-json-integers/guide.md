---
kind: upgrade-guide
description: "MySQL startup now requires schema v2, so existing R7 v1 databases need an explicit reviewed upgrade."
---

# Upgrade MySQL JSON integer checks

English | [中文](guide.zh.md)

## Change

The optional `dsh-mysql` provider now requires schema v2. MySQL 8.4 classifies real millisecond timestamps as `UNSIGNED INTEGER`; the original R7 v1 CHECKs accepted only `INTEGER` and rejected normal Native Session writes. The append-only v2 migration broadens exactly four JSON integer predicates in `ck_log_header` and `ck_event_json`. Existing presence, safe-integer bounds and derived-column equality checks remain enforced. Native JSONL, Session event text, ids and headers require no conversion.

Default `schemaMode: verify` refuses v1 without changing it. `initialize` applies both bundled migrations only to an empty database. Explicit `upgrade` accepts only a complete v1 database with its original checksum; unknown, partial or already-current targets reject. The original migration asset and v1 receipt remain immutable.

## Migration

1. Back up the selected database and stop consumers that write to it. Review the [connection prerequisites](../../../../packages/storage/mysql/README.md) and [v2 SQL](../../../../packages/storage/mysql/assets/002-json-safe-integers.sql), including required `ALTER` privileges. Keep the original endpoint and credential reference; do not select an unreviewed database.
2. Set `schemaMode: upgrade` on the existing `@deepseek-ai/dsh-mysql` row through its existing `dsh` profile patch, then start that explicit composition. The provider verifies the complete v1 structure under a database advisory lock, applies two ALTER statements and inserts a separate v2 checksum receipt only after full verification. It does not import Session files or rewrite event text.
3. Confirm `ctx.mysql.status().version === 2`, `migrationName === 'json-safe-integers'` and the checksum of the bundled v2 asset. Confirm both migration receipts exist and the original v1 row is unchanged. Set `schemaMode: verify` before the next normal startup; `upgrade` deliberately refuses an already-current database.
4. If activation reports partial DDL or an unknown checksum, preserve the database and receipts for operator inspection. DDL can commit before a later failure; repeated `initialize` or `upgrade` never automatically completes an unknown or partially migrated state.
