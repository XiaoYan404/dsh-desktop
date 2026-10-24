/** Native error identity returns only when the connection owner confirms rollback. */
import { expect, it } from 'vitest'
import type MysqlRuntime from '@deepseek-ai/dsh-mysql'
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import type { MysqlExecutor } from '@deepseek-ai/dsh-mysql'
import { SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sessionTransaction } from '../src/transaction.ts'

const executor: MysqlExecutor = { execute: async () => ({ kind: 'rows', rows: [] }) }

function connection(rollbackFails: boolean): Pick<MysqlRuntime, 'transaction'> {
  return { transaction: async (work) => {
    try { return await work(executor) }
    catch (error) {
      if (rollbackFails) throw new MysqlError('connection_unavailable', 'ROLLBACK was not acknowledged.', 'unknown')
      if (error instanceof MysqlError) throw error
      throw new MysqlError('statement_failed', 'Non-driver details omitted.')
    }
  } }
}

it('preserves the original Session ownership error after acknowledged rollback', async () => {
  const lost = new SessionOwnershipLostError(SessionId('owned'))
  await expect(sessionTransaction(connection(false), async () => { throw lost })).rejects.toBe(lost)
})

it('keeps unknown rollback outcomes instead of replacing them with a Session refusal', async () => {
  await expect(sessionTransaction(connection(true), async () => { throw new SessionOwnershipLostError(SessionId('owned')) }))
    .rejects.toMatchObject({ code: 'connection_unavailable', outcome: 'unknown' })
})
