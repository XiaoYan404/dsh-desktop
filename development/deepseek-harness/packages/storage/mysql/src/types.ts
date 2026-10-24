/** Public MySQL operation values; consumers decode row columns before domain use. */

/** Values accepted by the prepared-statement protocol; bigint is sent as exact decimal text. */
export type MysqlParameter = null | string | number | boolean | bigint | Uint8Array | Date

/** Driver-returned column values require domain-specific decoding at the consumer. */
export type MysqlRow = Readonly<Record<string, unknown>>

/** One statement result; internal BIGINT and DECIMAL columns remain strings in row results. */
export type MysqlResult =
  | { readonly kind: 'rows'; readonly rows: readonly MysqlRow[] }
  | { readonly kind: 'write'; readonly affectedRows: number; readonly insertId: string; readonly warningStatus: number }

/** A transaction-scoped executor expires when its callback settles or its operation is cancelled. */
export interface MysqlExecutor {
  /**
   * Execute one prepared statement on the transaction's owned connection.
   * @param sql - Static SQL with positional placeholders; no DDL, transaction control or session changes inside a transaction.
   * @param parameters - Positional data values; values are never interpolated into SQL or diagnostics.
   * @returns Driver rows or write metadata after the server response; this does not independently commit a transaction.
   */
  execute(sql: string, parameters: readonly MysqlParameter[]): Promise<MysqlResult>
}

/** Prepared operations shared by the connection owner and its registered consumers. */
export interface MysqlClient {
  /**
   * @param sql - Trusted positional statement.
   * @param values - Bound data.
   * @param signal - Caller cancellation.
   * @returns Acknowledged result; lost write acknowledgement can remain unknown.
   */
  execute(sql: string, values: readonly MysqlParameter[], signal?: AbortSignal): Promise<MysqlResult>
  /**
   * @param work - One callback using its expiring executor; no DDL or external actions.
   * @param signal - Caller cancellation.
   * @returns The callback result after COMMIT acknowledgement.
   */
  transaction<T>(work: (executor: MysqlExecutor) => Promise<T>, signal?: AbortSignal): Promise<T>
}

/** One consumer's SQL capability, retained until its producer and accepted SQL queues finish draining. */
export interface MysqlConsumer extends MysqlClient {
  /** Fence the consumer through its registered drain, settle its SQL, and release registration.
   * @returns The same uncancellable settlement on every call, including retained drain/SQL failures.
   */
  dispose(): Promise<void>
}

/** Verified schema identity from the configured database; no credentials or application rows. */
export interface MysqlSchemaStatus {
  readonly version: number
  readonly migrationName: string
  readonly scriptSha256: string
  readonly tableCount: number
  readonly foreignKeyCount: number
}

/** Failure handling uses stable codes and commit knowledge, never a server message or SQL text. */
export type MysqlErrorCode = 'configuration' | 'credential_missing' | 'connection_unavailable' | 'authentication_failed'
  | 'unsupported_server' | 'capacity' | 'statement_failed' | 'constraint_failed' | 'deadlock' | 'lock_timeout'
  | 'cancelled' | 'timeout' | 'closed' | 'transaction_unknown' | 'schema_missing' | 'schema_conflict'
  | 'schema_incomplete' | 'driver_incompatible'

/** Unknown outcomes require a consumer-owned receipt/readback before retrying a write. */
export type MysqlCommitOutcome = 'not-started' | 'not-committed' | 'unknown' | 'not-applicable'
