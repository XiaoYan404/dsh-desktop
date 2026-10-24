/** Consumer disposal preserves accepted SQL and failures independently of the enclosing Cordis logger. */
import { expect, it, vi } from 'vitest'
import { MysqlConsumerScope } from '../src/consumer.ts'
import type { MysqlClient } from '../src/types.ts'

it('fences producers synchronously, retains accepted SQL, and joins one disposal', async () => {
  const operation = Promise.withResolvers<undefined>()
  const drain = Promise.withResolvers<undefined>()
  const release = vi.fn()
  let accepting = true
  const client: MysqlClient = {
    execute: async () => { await operation.promise; return { kind: 'rows', rows: [] } },
    transaction: async work => work({ execute: async () => ({ kind: 'rows', rows: [] }) }),
  }
  const scope = new MysqlConsumerScope(client, () => { accepting = false; return drain.promise }, release)
  const admitted = scope.execute('SELECT ?', [1])
  const closing = scope.dispose()
  expect(accepting).toBe(false)
  expect(scope.dispose()).toBe(closing)
  drain.resolve(undefined)
  await Promise.resolve()
  expect(release).not.toHaveBeenCalled()
  operation.resolve(undefined)
  await admitted
  await closing
  expect(release).toHaveBeenCalledTimes(1)
  await expect(scope.execute('SELECT 1', [])).rejects.toMatchObject({ code: 'closed' })
})

it('retains a producer refusal and an unobserved accepted SQL refusal while always releasing', async () => {
  const sql = Promise.withResolvers<never>()
  const producerFailure = new Error('controlled producer refusal')
  const sqlFailure = new Error('controlled SQL refusal')
  const release = vi.fn()
  const producer = vi.fn(async () => { throw producerFailure })
  const scope = new MysqlConsumerScope({ execute: async () => sql.promise,
    transaction: async work => work({ execute: async () => ({ kind: 'rows', rows: [] }) }) }, producer, release)
  const admitted = scope.execute('SELECT 1', [])
  const observed = expect(admitted).rejects.toBe(sqlFailure)
  const closing = scope.dispose()
  const refused = closing.then(() => { throw new Error('The controlled drain must reject.') }, (error: unknown) => {
    expect(error).toBeInstanceOf(AggregateError)
    if (error instanceof AggregateError) {
      expect(error.errors).toHaveLength(2)
      expect(error.errors).toContain(producerFailure)
      expect(error.errors).toContain(sqlFailure)
    }
  })
  sql.reject(sqlFailure)
  await observed
  await refused
  expect(scope.dispose()).toBe(closing)
  expect(producer).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
})
