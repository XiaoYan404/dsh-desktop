/** Search and exact-history reads must use the same native persistence namespace. */
import MysqlSessionPersistence from '@deepseek-ai/dsh-session-persistence-mysql'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'

/**
 * Reject a composition that would authorize or open search hits through a different store.
 * @param persistence - Currently mounted native persistence, including its provider identity.
 * @param storeKey - Explicit namespace selected by the search provider.
 * @returns The matching MySQL persistence; rejection occurs before search acquires SQL resources.
 */
export function requireMysqlSearchPersistence(persistence: SessionPersistence | undefined, storeKey: string): MysqlSessionPersistence {
  if (!(persistence instanceof MysqlSessionPersistence) || persistence.mysqlStoreKey !== storeKey) {
    throw new SessionQueryError('MySQL history search requires the active MySQL session persistence in the same namespace.',
      'SESSION_QUERY_INVALID_CONFIG')
  }
  return persistence
}
