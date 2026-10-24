---
description: "Configure an explicit MySQL 8.4 connection, initialize the complete R7 schema, and handle prepared statements and transaction failures."
kind: "package-reference"
---

# @deepseek-ai/dsh-mysql

English | [中文](README.zh.md)

## Summary

Connect a chosen MySQL 8.4 database through Host-managed credentials and execute positional prepared statements without losing BIGINT or DECIMAL precision. Initialize the complete R7 schema in a reviewed empty database, explicitly upgrade a recognized predecessor, or verify the latest schema before serving consumers. Connections enforce UTC and strict SQL mode; cancellation closes the affected connection. This opt-in transport leaves the existing JSON and SQLite selections in place and does not import Native history.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service in an explicit Cordis composition whose consumers use `ctx.mysql`. The package has no application launcher or profile layer.

### Deployment prerequisites

An administrator supplies the host, port, existing database, database-scoped account and password credential reference. Oracle MySQL 8.4 must have `ngram_token_size=2` and `innodb_ft_enable_stopword=OFF`; the database must use `utf8mb4` with `utf8mb4_0900_bin`. Initialization needs permission to create and alter the R7 tables and indexes; normal verification and data access need the corresponding table grants. The plugin never creates a database or changes global server settings.

Load a Host credential provider before this row and provision the referenced secret through that provider. `passwordRef` names a credential; it is not a literal password or an automatically read environment variable. Mount this row through the existing `dsh` composition and patch mechanism.

```yaml
- name: '@deepseek-ai/dsh-mysql'
  config:
    host: 127.0.0.1
    port: 11406
    database: dsh_private
    user: dsh_runtime
    passwordRef: DSH_MYSQL_PASSWORD
    schemaMode: verify
```

| Choice | Behavior |
|---|---|
| `schemaMode: verify` | Default; requires the latest complete schema and all three matching receipts; never writes schema or receipts |
| `schemaMode: initialize` | Creates all twenty R7 tables and applies the successor in order only when the selected database has no tables or views; existing latest schemas are verified |
| `schemaMode: upgrade` | Accepts a complete recognized predecessor; existing stores need explicit Workspace global/source decisions through the reviewed migration API before v3 DDL |
| `tlsCAFile` | A PEM CA file enables TLS with certificate and identity verification; a literal IP endpoint also requires `tlsServerName` |
| `tlsServerName` | Expected DNS/CN certificate identity when dialing another host or an IP; requires `tlsCAFile`, and never changes the physical `host`/`port` |
| Resource settings | Validated connection, acquisition, operation, schema-lock and prepared-statement limits; accepted work has no automatic retry |

The [configuration catalog](../../../docs/config-catalog.md) owns the complete field reference. Review the endpoint before `initialize` or `upgrade`, then use `verify` for normal startup. `status()` reports the latest verified generation, checksum and table/foreign-key counts without returning credentials or application rows. An already-current database refuses `upgrade`; the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-alpha.2/mysql-json-integers/guide.md) gives the v1 procedure.

### TLS server identity

Keep `host` and `port` as the physical database endpoint. Set `tlsCAFile` to the administrator-provided PEM CA. When that endpoint is a literal IP, also set `tlsServerName` to the server certificate's expected DNS name or CN, for example:

```yaml
tlsCAFile: /deployment/certificates/mysql-ca.pem
tlsServerName: mysql.internal.example
```

The public mysql2 stream factory dials the original `host`/`port`, while mysql2 verifies the CA chain and explicit certificate identity and uses that identity for TLS SNI. It does not change DNS or system hosts. DNS endpoints without an explicit name keep verifying `host` through the original driver path. An IP with TLS but no name, a name without a CA, or an IP used as the name rejects before resolving a credential or opening a connection. Existing unencrypted IP configurations retain their original behavior.

Existing IP-plus-CA deployments must add the expected DNS/CN identity before upgrading. There is no implicit `localhost` identity. Direct verification against an IP SAN remains unsupported; do not put an IP literal in `tlsServerName` or treat these DNS/CN tests as IP SAN coverage.

### Failures and recovery

`MysqlError` carries a stable `code`, commit `outcome`, `retryable` hint and optional driver code. Diagnostics omit raw driver messages, SQL, parameters and passwords. A missing credential, unavailable server or incompatible deployment rejects service activation; correct the configuration or service and reload the plugin.

An unknown autocommit or COMMIT outcome requires a consumer-owned durable receipt or readback before another write. The provider never retries a transaction or external tool action. Initialization or upgrade can leave committed DDL after failure: `schema_incomplete` stops activation and preserves the database and earlier receipts for inspection instead of silently completing or resetting it. A partially applied v2 cannot be mistaken for a complete v1 and retried automatically.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each admitted operation owns one pooled connection. Session setup applies UTC, strict SQL mode and the required collation after authentication. Positional parameters travel through mysql2 prepared statements; BIGINT and DECIMAL rows remain strings, dates remain SQL strings, and unsafe integer inputs reject before execution. Consumers decode rows, limit result sizes and use trusted static SQL. `mysqlConsumerTransaction` retains typed consumer refusals after confirmed rollback; unknown outcomes retain precedence.

The [v3 Workspace successor](assets/003-workspace-order-and-lease.sql) adds archive ordinals, explicit global presence and fenced registry ownership. Existing stores require an explicit source decision; unordered archive booleans cannot supply original order. Nullable-column backfill precedes final constraints and structural verification; partial failure never grants a successful migration receipt. See the [Workspace upgrade guide](../../../docs/upgrade-guide/v0.2.1-alpha.2/mysql-workspace-v3/guide.md).

Schema activation holds a database-scoped advisory lock. The immutable [v1 R7 SQL](assets/001-r7.sql) contains all twenty tables and twenty-five foreign keys, including the current-session pointer, writer leases, append receipts, projections, search and import records. The additive [v2 SQL](assets/002-json-safe-integers.sql) changes only four JSON numeric-type predicates in `ck_log_header` and `ck_event_json`, accepting `INTEGER` and `UNSIGNED INTEGER` while preserving safe bounds and derived-column equality. MySQL uses the latter type for real millisecond timestamps. Each SHA-256 covers one executable asset; initialization records v1 before applying v2. A generation's receipt is inserted only after complete structural verification. No asset creates or selects a database, and an applied predecessor is never rewritten.

`transaction()` confines its executor to the callback and waits for COMMIT acknowledgement. Callbacks must not issue DDL, transaction control or session changes. Cancellation, timeout or unload closes the owned transport and invalidates the executor. The implementation uses the pinned mysql2 transport because its graceful `destroy()` does not promptly terminate an active statement; a driver upgrade must retain the controlled cancellation check.

Consumers that own asynchronous producers register `ctx.mysql.registerConsumer(drain)` during activation and use its returned SQL capability. The caller's `ctx.effect` owns registration and disposal. The drain immediately fences new business work, stops its exact producers and settles accepted queues; it must not await its own SQL scope or connection unload. Connection shutdown rejects ordinary SQL and new registrations, cancels ordinary operations, and waits for every registered consumer before cancelling the remaining transport and closing the pool. A draining consumer can await pool capacity within the operation deadline; ordinary admission still rejects excess work. Repeated disposal joins one settlement, retaining producer and SQL failures after cleanup.

The current consumer is [MySQL Session persistence](../../session/session-persistence-mysql/README.md), which retains its live routes through Native producer teardown. Cordis logs failed fiber disposers with `logger.error`; scope disposal retains its rejection, while root fiber disposal may resolve after logging it.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Cordis service, credentials, pool ownership, bound statements and transactions |
| [`src/schema.ts`](src/schema.ts) | Migration checksum, deployment preflight and schema verification |
| [`src/schema-checks.ts`](src/schema-checks.ts) | Grouping-preserving comparison of Oracle CHECK renderings |
| [`src/error.ts`](src/error.ts) | Sanitized failure codes and commit knowledge |
| [`src/consumer.ts`](src/consumer.ts) | Consumer SQL lifetime, idempotent drain and retained failures |
| [`src/types.ts`](src/types.ts) | Consumer result, executor and schema-status types |

The explicit [isolated-instance acceptance test](tests/mysql-isolated.acceptance.ts) boots the real Loader with `credentials-local`; its separate [Vitest configuration](vitest.mysql.config.ts) requires the round144 public descriptor and fails when it is absent. It never discovers local MySQL services or silently skips a missing database. Ordinary package tests use a controlled unavailable loopback endpoint and need no database.

The separately filtered [migration acceptance](tests/mysql-upgrade.acceptance.ts) verifies the owned v1 without writing, then requires review of the exact v2 checksum before applying the upgrade. It retains the original receipt and event-text hash, tests real timestamps and rejection of fractional/string JSON numbers and derived mismatches, and rolls back only its own predicate-test rows. It never resets the database or reruns initialization.

The separate [IP/TLS acceptance](tests/mysql-tls-ip.acceptance.ts) and [configuration](vitest.mysql-tls-ip.config.ts) verify the real CA chain and explicit DNS/CN identity while dialing the owned IP through the public stream factory. They reject a wrong identity during TLS and missing or incompatible TLS settings before credential resolution or transport. These read-only cases leave DNS, certificates, server configuration and schema receipts unchanged.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MySQL subsystem](../../../docs/subsystems/mysql.md) — consumer semantics and failure ownership.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the independent domain-storage backend API.
- [Session persistence](../../../docs/subsystems/persistence.md) — the event-log providers and released Session formats.
- [Credentials](../../../docs/subsystems/credentials.md) — Host credential references and providers.

-----

<a id="model-experience"></a>
## Model Experience

### Database transport

#### What the model sees

Nothing. `ctx.mysql` registers no prompt, tool, model schema or session event; consumers own any model-visible use of stored data.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None. The transport does not modify model request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Consumers and deployment owners must account for these limits.

- The service supplies connections and schema initialization; it does not implement a Session provider, domain backend, lease renewal, append idempotency, search projection or Native import. Creating their R7 tables does not activate those behaviors.
- Schema inspection verifies table inventory, column types/nullability/collation/generated expressions/defaults/extra, foreign keys, exact explicit and InnoDB-created support indexes, grouping-preserving CHECK expressions and the ngram parser. Comments and current AUTO_INCREMENT counters are not identity fields; the migration checksum identifies each bundled SQL asset, not a live-schema dump.
- TLS trust and certificate identity still require target-environment validation. The owning TLS cases cover one reviewed MySQL 8.4 instance, including literal-IP dialing with an explicit DNS/CN identity; direct IP SAN verification, certificate rotation and client certificates remain outside that coverage.
- Lost-COMMIT recovery belongs to the consuming adapter and still needs qualification in its target environment. Callbacks must contain their own external work after cancellation.
- This is a trusted Host SQL API with caller-owned result bounds. It supplies no tenant authorization, SQL firewall, process network isolation, backup policy or automatic schema upgrade.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
