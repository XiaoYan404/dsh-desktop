/** Invalid identifiers fail before SQL admission without freezing unrelated checkpoint observations. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MysqlConsumer, MysqlExecutor } from '@deepseek-ai/dsh-mysql'
import { MysqlProjectionAdapter } from '../src/adapter.ts'
import { projectionSql } from '../src/sql.ts'

it('refuses a lone surrogate before SQL without stopping later representable Session observations', async () => {
  const execute = vi.fn<MysqlExecutor['execute']>(async (sql) => {
    if (sql === projectionSql.keyMetadata) return { kind: 'rows', rows: [{ CHARACTER_SET_NAME: 'utf8mb4',
      COLLATION_NAME: 'utf8mb4_0900_bin', CHARACTER_MAXIMUM_LENGTH: 191 }] }
    if (sql === projectionSql.store) return { kind: 'rows', rows: [{ store_id: '1', store_key: 'agent05-admission' }] }
    if (sql === projectionSql.storeLock) return { kind: 'rows', rows: [{ store_id: '1' }] }
    if (sql === projectionSql.slot) return { kind: 'rows', rows: [] }
    throw new Error('Unexpected observation admission statement.')
  })
  const dispose = vi.fn(async () => {})
  const sql: MysqlConsumer = { execute, transaction: work => work({ execute }), dispose }
  const adapter = new MysqlProjectionAdapter({ registerConsumer: () => sql }, {
    storeKey: 'agent05-admission', maxEvents: 10, maxInputBytes: 1000, maxCheckpointBytes: 1000,
    maxUnits: 10, readPageSize: 2, maxPendingOperations: 2,
  })
  try {
    await adapter.initialize()
    const commands = vi.mocked(execute).mock.calls.length
    await expect(adapter.observe(SessionId('\uD800'))).rejects.toBeInstanceOf(TypeError)
    expect(vi.mocked(execute).mock.calls).toHaveLength(commands)
    await expect(adapter.observe(SessionId('representable'))).rejects.toMatchObject({ code: 'missing-session' })
    expect(vi.mocked(execute).mock.calls.at(-1)?.[0]).toBe(projectionSql.slot)
  } finally { await adapter.close() }
  expect(dispose).toHaveBeenCalledTimes(1)
})
