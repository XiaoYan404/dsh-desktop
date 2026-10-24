/** Structured search failures retain the existing query error taxonomy. */
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'

/** A caller can rebuild, retry from page one, or inspect an uncertain publication by this reason. */
export type MysqlSearchFailure = 'INDEX_NOT_READY' | 'CLAIM_LOST' | 'CUT_CHANGED' | 'CAS_CONFLICT'
  | 'CAPACITY' | 'UNSUPPORTED_ANALYZER' | 'UNREPRESENTABLE' | 'INVALID_RECORD' | 'ACCESS_UNAVAILABLE' | 'PUBLICATION_UNKNOWN'

/** Search errors contain no SQL, credentials, hidden session ids or candidate counts. */
export class MysqlSearchError extends SessionQueryError {
  constructor(readonly reason: MysqlSearchFailure, options?: ErrorOptions) {
    super(`MySQL session search is unavailable (${reason}); refresh or rebuild after resolving this condition.`,
      'SESSION_QUERY_INDEX_FAILED', options)
  }
}
