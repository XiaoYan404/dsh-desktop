---
description: "Write bounded MySQL projection checkpoints from complete validated Session cuts."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-projection-mysql

English | [中文](README.zh.md)

## Use this package

Load MySQL, native Session persistence and SessionProjectionRegistry, then this optional provider. Explicitly set `checkpointBackend: provider` on SessionProjectionCache. The default cache continues using its existing Domain. Configure `storeKey`, `maxEvents`, `maxInputBytes`, `maxCheckpointBytes`, `maxUnits`, `readPageSize` and `maxPendingOperations`; the store must exist and schema activation uses `verify`.

The injected persistence provider must expose MySQL writer ownership capabilities for the same `storeKey`; a different provider or namespace fails activation before projection SQL opens. Accepted writes flush the bound provider instance. Local flush does not drain another Host's writer: projection folding uses only the committed observed prefix. Invalid Session identifiers are refused before SQL admission without freezing unrelated observations.

## Checkpoints

The provider observes the current lifecycle UUID, format, exact log revision, complete event count and validated prefix in one transaction, using store-before-slot locks. Header and event lengths are checked before fetching payloads. Checkpoint reads validate head count before bounded key pages and server-limited JSON values. Native projection definitions own per-unit state version/schema validation and replay.

Whole replacement compares the original lifecycle and exact checkpoint CAS, removes omitted keys, and publishes only after COMMIT acknowledgement. Empty rows preserve the complete observed input watermark. Unknown outcomes freeze subsequent SQL until reopen; a new provider reads the actual committed cache or rebuilds. Cache writes never mutate events or append receipts.

## Model Experience

### Projection state

The provider folds committed events through existing projection definitions. It adds no prompts or tools and does not persist repaired unpublished events.

## Known Limitations and Deferred Work

A bare SessionHeader does not witness the MySQL lifecycle UUID, so synchronous listing and hydration return an uncached miss and use canonical replay. SQL checkpoints remain available to the asynchronous provider's validated observation/rebuild path. Direct cache keys over 191 Unicode code points, state versions over UINT32, and isolated UTF-16 surrogates are refused without coercion; these refusals are fail-soft at the cache owner. Unknown cache writes have no immutable write receipt and are never automatically resent. This provider does not offer a maintenance/export freeze. Built and installer validation belongs to release integration.
