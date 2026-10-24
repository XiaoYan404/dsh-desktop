/** Consumer shutdown contains synchronous producer failures without keeping the SQL scope alive. */
import { expect, it, vi } from 'vitest'
import type { MysqlConsumer } from '@deepseek-ai/dsh-mysql'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MysqlProjectionAdapter } from '../src/adapter.ts'

function scope() {
  const dispose = vi.fn(async () => {})
  const sql: MysqlConsumer = { execute: async () => { throw new Error('No SQL belongs to retirement.') },
    transaction: async () => { throw new Error('No transaction belongs to retirement.') }, dispose }
  return { sql, dispose }
}
const config = { storeKey: 'agent05-retirement', maxEvents: 10, maxInputBytes: 1000,
  maxCheckpointBytes: 1000, maxUnits: 10, readPageSize: 2, maxPendingOperations: 2 }

it('joins close after a synchronous producer failure and still disposes its SQL consumer exactly once', async () => {
  const { sql, dispose } = scope(), failure = new Error('Controlled producer failure.')
  const producer = vi.fn(() => { throw failure })
  const adapter = new MysqlProjectionAdapter({ registerConsumer: () => sql }, config, producer)
  const closing = adapter.close()
  expect(adapter.close()).toBe(closing)
  const result: unknown = await closing.catch((error: unknown) => error)
  expect(result).toMatchObject({ errors: [expect.objectContaining({ errors: [failure] })] })
  expect(producer).toHaveBeenCalledTimes(1)
  expect(dispose).toHaveBeenCalledTimes(1)
  await expect(adapter.observe(SessionId('unused'))).rejects.toMatchObject({ code: 'closed' })
})

it('memoizes retirement before the producer can synchronously trigger its consumer drain again', async () => {
  const { sql, dispose } = scope()
  let drain: (() => Promise<void>) | undefined
  let reentered: Promise<void> | undefined
  const adapter = new MysqlProjectionAdapter({ registerConsumer: (callback) => { drain = callback; return sql } }, config,
    () => { reentered = drain?.(); return Promise.resolve() })
  await adapter.close()
  await reentered
  expect(dispose).toHaveBeenCalledTimes(1)
})
