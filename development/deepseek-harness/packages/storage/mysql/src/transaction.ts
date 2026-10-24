/** Retain consumer-owned refusal objects only after the kernel confirms transaction rollback. */
import { MysqlError } from './error.ts'
import type { MysqlClient, MysqlExecutor } from './types.ts'

class ConsumerTransactionRefusal extends MysqlError {
  constructor(readonly failure: unknown) {
    super('statement_failed', 'The consumer refused its transaction before COMMIT.', 'not-committed')
  }
}

/** Preserve typed validation/CAS failures across kernel sanitization without overriding uncertain outcomes.
 * @param client - Existing consumer or connection owner.
 * @param work - Transaction-local SQL and consumer validation; no external side effects.
 * @returns Callback result after COMMIT ACK; unknown rollback/commit always takes precedence over a refusal.
 */
export async function mysqlConsumerTransaction<T>(client: Pick<MysqlClient, 'transaction'>,
  work: (tx: MysqlExecutor) => Promise<T>): Promise<T> {
  try {
    return await client.transaction(async (tx) => {
      try { return await work(tx) } catch (error) {
        if (error instanceof MysqlError) throw error
        throw new ConsumerTransactionRefusal(error)
      }
    })
  } catch (error) {
    if (error instanceof ConsumerTransactionRefusal) throw error.failure
    throw error
  }
}
