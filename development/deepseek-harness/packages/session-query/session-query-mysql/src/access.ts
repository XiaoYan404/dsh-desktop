/** Search drains the captured native writer outside SQL locks, then verifies every active database lease. */
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { MysqlSessionWriterOwnership } from '@deepseek-ai/dsh-session-persistence-mysql'
import type { MysqlSearchRepository } from './repository.ts'
import type { MysqlSearchAccess } from './types.ts'

/**
 * Preserve the Host policy while enforcing the native provider's local flush and ownership proof.
 * @param persistence - Captured matching provider; a runtime Session's presence is not ownership evidence.
 * @param access - Original Host authorization, live registry and accepted-write barrier.
 * @param repository - Namespace-local store-lock and active-lease observation.
 * @returns Request-scoped access; foreign or unobservable creators fail before search reads bodies.
 */
export function bindMysqlSearchAccess(persistence: Pick<SessionPersistence, 'flush'> & MysqlSessionWriterOwnership,
  access: MysqlSearchAccess, repository: Pick<MysqlSearchRepository, 'assertLocalWriters'>): MysqlSearchAccess {
  return {
    async flush(signal) {
      signal.throwIfAborted()
      await access.flush(signal)
      signal.throwIfAborted()
      await persistence.flush()
      signal.throwIfAborted()
      await repository.assertLocalWriters(persistence, signal)
      signal.throwIfAborted()
    },
    authorize: (candidates, signal) => access.authorize(candidates, signal),
    isLive: id => access.isLive(id),
  }
}
