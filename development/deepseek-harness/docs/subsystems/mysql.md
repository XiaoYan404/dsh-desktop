# MySQL

English | [中文](mysql.zh.md)

The MySQL subsystem supplies an optional Host connection service, `ctx.mysql`, through [`dsh-mysql`](../../packages/storage/mysql/README.md). It uses an explicitly selected database and Host credential reference. It does not register a `ctx.storage` backend or a Session persistence provider; those consumers retain their own storage selection. The package README owns deployment prerequisites, configuration, initialization and operator recovery.

Source: [`MysqlRuntime`](../../packages/storage/mysql/src/index.ts) · [operation types](../../packages/storage/mysql/src/types.ts) · [failures](../../packages/storage/mysql/src/error.ts) · [R7 migration](../../packages/storage/mysql/assets/001-r7.sql).

## Statement results

`execute(sql, parameters, signal?)` accepts one trusted SQL statement with positional parameters. `MysqlParameter` supports null, text, finite safe numbers, booleans, bigint, byte arrays and dates. bigint is sent as exact decimal text; byte arrays and dates are copied before an asynchronous operation can use them. SQL identifiers and syntax belong to trusted adapters, not parameters. Consumers bound result size and decode row values before domain use.

`MysqlResult` discriminates `rows` from `write`. Row columns are unknown until decoded, BIGINT and DECIMAL values remain strings, JSON remains serialized text, and dates remain SQL strings under UTC. Write results contain affected-row count, a string insert ID and warning count. Successful autocommit returns after the server response; loss of that response can leave the write outcome unknown.

## Transactions and lifecycle

`transaction(work, signal?)` reserves one connection for BEGIN, callback statements and COMMIT. Its `MysqlExecutor` expires when the callback settles or the operation is cancelled. The callback must use that executor and exclude DDL, transaction control and session changes. Resolution follows COMMIT acknowledgement; a callback failure attempts ROLLBACK before rejection while transport remains available. The provider never retries the callback.

The configured connection limit bounds ordinary admission; excess operations reject `capacity`. Connection acquisition has a separate deadline. After acquisition, the operation deadline includes session setup, callback time and COMMIT. Cancellation and timeout invalidate the executor and close its transport. Callbacks own containment of external work after cancellation.

`registerConsumer(drain)` returns a `MysqlConsumer`: the `execute` and `transaction` operations of `MysqlClient` plus an idempotent `dispose`. The caller's `ctx.effect` owns its registration. Drain synchronously fences new business work and settles its exact producers and accepted queues through that SQL capability. It must not await its own disposal or connection unload. Scope disposal retains drain and SQL failures after settling pending operations, then rejects further scope SQL.

Connection unload immediately rejects ordinary SQL and registrations, cancels ordinary operations, and joins every consumer drain before transport cancellation and pool closure. Only a registered draining scope may wait for pool capacity within the operation deadline, preserving accepted queue drain without changing ordinary admission. [MySQL Session persistence](../../packages/session/session-persistence-mysql/README.md) is the current production consumer. Cordis's existing fiber error containment logs failed owner disposers with `logger.error`; a scope remains rejected even when root disposal resolves after logging.

## Schema identity

`status()` returns a detached `MysqlSchemaStatus` verified during activation: schema version, migration name, executable SQL SHA-256, table count and foreign-key count. It contains no endpoint secrets or application rows. This database generation is independent of the released Session event format.

Initialization executes the immutable R7 v1 asset followed by the v2 integer-CHECK migration under a database-scoped advisory lock, recording each checksum only after structural verification. Default verification accepts only the latest twenty-table schema with both original receipts. Explicit upgrade accepts the complete v1 predecessor and preserves its receipt and event text; unknown or partly migrated structures refuse activation. The [package reference](../../packages/storage/mysql/README.md) owns migration selection and recovery, and its [limitations](../../packages/storage/mysql/README.md#known-limitations-and-deferred-work) define the inspected live-schema details.

## Failure ownership

`MysqlError` exposes stable `MysqlErrorCode`, `MysqlCommitOutcome`, a retryable hint and an optional sanitized driver code. It retains no raw driver cause, SQL or parameter values. Deployment and credential failures stop service activation. Schema mismatch or partial DDL stops activation and preserves existing data for inspection.

`not-started` means admission or setup failed before work began. `not-committed` describes work inside a transaction before COMMIT. `unknown` requires consumer receipt lookup or readback before retrying a write, including a lost COMMIT acknowledgement; it never authorizes repeating external actions. `not-applicable` carries no transaction outcome claim. A retryable hint does not replace the consumer's idempotency decision.

The connection provider owns transport closure and failure sanitization. Domain adapters own validation, statement ordering, authorization, durable receipts and recovery decisions. A connection error must not be converted into successful persistence by a caller.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmysql--mysqlruntime"></a>

### `ctx.mysql` — `MysqlRuntime`

Pooled prepared statements and explicit transactions with connection-owned cancellation and no automatic retries.

```ts cordis-catalog
/** Register a producer/queue owner whose accepted SQL must finish before the pool closes.
 * The caller's ctx.effect owns release. Its drain must synchronously fence new business work,
 * settle producers and queues, and must not await this scope's disposal or connection unload.
 * @param drain - Current consumer's idempotent shutdown, using the returned scope for SQL.
 * @returns SQL retained through that drain, plus its memoized disposal; failures remain rejections.
 */
registerConsumer(drain: () => Promise<void>): MysqlConsumer

/**
 * Return the schema identity verified during this plugin activation.
 * @returns A detached public receipt without endpoint secrets or application data.
 */
status(): MysqlSchemaStatus

/**
 * Execute one positional prepared statement; this may be an autocommitted write.
 * @param sql - Static SQL with positional placeholders; callers bound the result size and decode row values.
 * @param values - Data values; BIGINT inputs use bigint or exact text and returned BIGINT/DECIMAL values remain strings.
 * @param signal - Operation cancellation; a cancelled connection is closed and never reused.
 * @returns Rows or acknowledged write metadata. Lost autocommit responses can have an unknown write outcome.
 */
execute(sql: string, values: readonly MysqlParameter[], signal?: AbortSignal): Promise<MysqlResult>

/**
 * Run transactional statements once on one connection; no deadlock or COMMIT retry is implicit.
 * @param work - Callback using only its executor; no DDL, transaction control or session changes.
 * The executor expires at settlement.
 * @param signal - Cancellation closes the connection. Cancellation during COMMIT has an unknown outcome.
 * @returns Callback value after COMMIT acknowledgement; failures roll back before rejection when transport permits it.
 */
transaction<T>(work: (executor: MysqlExecutor) => Promise<T>, signal?: AbortSignal): Promise<T>
```

Source: [`packages/storage/mysql/src/index.ts`](../../packages/storage/mysql/src/index.ts)
<!-- END GENERATED cordis-surface -->
