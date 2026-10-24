/** MySQL diagnostics omit raw driver messages, SQL, parameters, credentials and connection URLs. */
import type { MysqlCommitOutcome, MysqlErrorCode } from './types.ts'

/** Sanitized operational failure with a stable recovery decision and commit knowledge. */
export class MysqlError extends Error {
  constructor(readonly code: MysqlErrorCode, message: string,
    readonly outcome: MysqlCommitOutcome = 'not-applicable', readonly retryable = false,
    readonly driverCode?: string) {
    super(message)
    this.name = 'MysqlError'
  }
}

/** Convert driver errors at the database boundary without retaining private driver payloads.
 * @param error - Failure from mysql2 or transport setup.
 * @param outcome - Commit knowledge owned by the executing operation.
 * @returns A stable error whose message and fields are safe for ordinary Host diagnostics.
 */
export function mysqlFailure(error: unknown, outcome: MysqlCommitOutcome = 'not-applicable'): MysqlError {
  if (error instanceof MysqlError) return error
  const raw = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  const driverCode = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : undefined
  if (driverCode === 'ER_ACCESS_DENIED_ERROR' || driverCode === 'ER_DBACCESS_DENIED_ERROR') {
    return new MysqlError('authentication_failed', 'MySQL rejected the configured account. Check the Host credential reference and database grants.', outcome, false, driverCode)
  }
  if (driverCode === 'ECONNREFUSED' || driverCode === 'ENOTFOUND' || driverCode === 'ETIMEDOUT' ||
    driverCode === 'PROTOCOL_CONNECTION_LOST' || driverCode === 'ECONNRESET') {
    return new MysqlError('connection_unavailable', 'MySQL is unreachable or the connection was lost. Restore the configured service; confirm any write outcome before retrying.', outcome, true, driverCode)
  }
  if (driverCode === 'POOL_CONNLIMIT' || driverCode === 'ER_CON_COUNT_ERROR') {
    return new MysqlError('capacity', 'The MySQL connection limit is occupied. Retry after accepted work finishes or adjust the configured limit.', outcome, true, driverCode)
  }
  if (driverCode === 'ER_LOCK_DEADLOCK' || driverCode === 'ER_LOCK_WAIT_TIMEOUT') {
    return new MysqlError(driverCode === 'ER_LOCK_DEADLOCK' ? 'deadlock' : 'lock_timeout',
      'MySQL could not obtain the required locks. Retry the complete transaction only after its rollback is confirmed.', outcome, true, driverCode)
  }
  if (driverCode === 'ER_DUP_ENTRY' || driverCode === 'ER_NO_REFERENCED_ROW_2' ||
    driverCode === 'ER_ROW_IS_REFERENCED_2' || driverCode === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    return new MysqlError('constraint_failed', 'MySQL rejected a uniqueness, relationship or CHECK constraint. Review the operation; existing history is retained.', outcome, false, driverCode)
  }
  return new MysqlError('statement_failed', 'MySQL rejected the statement. Review the adapter and configured database; SQL and parameter values are omitted.', outcome, false, driverCode)
}
