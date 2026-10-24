/** Reject projection configurations that flush a different persistence provider or namespace. */
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { hasMysqlSessionWriterOwnership } from '@deepseek-ai/dsh-session-persistence-mysql'
import type { MysqlSessionWriterOwnership } from '@deepseek-ai/dsh-session-persistence-mysql'
import { ProjectionAdapterError } from './model.ts'

/** Bind the exact Host persistence instance before opening the projection SQL consumer.
 * @param persistence - Actual injected Host provider; no runtime Session or remote input proves its identity.
 * @param storeKey - Explicit projection namespace that must match the configured MySQL provider.
 * @returns The same provider with local ownership capabilities; no flush, SQL, lease claim or migration occurs.
 * @throws A configuration refusal for JSONL, another store or a provider without exact local writer matching.
 */
export function requireMysqlProjectionPersistence(persistence: SessionPersistence,
  storeKey: string): SessionPersistence & MysqlSessionWriterOwnership {
  if (!hasMysqlSessionWriterOwnership(persistence) || persistence.mysqlStoreKey !== storeKey) {
    throw new ProjectionAdapterError('configuration')
  }
  return persistence
}
