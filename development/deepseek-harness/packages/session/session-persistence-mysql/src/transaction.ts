/** Preserve Session failures only after the connection provider confirmed their rollback. */
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import type MysqlRuntime from '@deepseek-ai/dsh-mysql'
import type { MysqlExecutor } from '@deepseek-ai/dsh-mysql'

class SessionTransactionRefusal extends MysqlError {
  constructor(readonly failure: unknown) {
    super('statement_failed', 'The Session transaction was rejected before COMMIT.', 'not-committed')
  }
}

/** Run one transaction while retaining caller-facing Session error identities.
 * @param mysql - Injected connection owner.
 * @param work - Provider-owned SQL and validation; no DDL or external side effects.
 * @returns The callback result after COMMIT; rollback/COMMIT uncertainty always takes precedence.
 */
export async function sessionTransaction<T>(mysql: Pick<MysqlRuntime, 'transaction'>, work: (tx: MysqlExecutor) => Promise<T>): Promise<T> {
  try {
    return await mysql.transaction(async (tx) => {
      try { return await work(tx) }
      catch (error) {
        if (error instanceof MysqlError) throw error
        throw new SessionTransactionRefusal(error)
      }
    })
  } catch (error) {
    if (error instanceof SessionTransactionRefusal) throw error.failure
    throw error
  }
}
