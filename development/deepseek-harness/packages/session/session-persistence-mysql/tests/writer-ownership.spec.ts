/** Local writer proofs reject foreign generations and lifecycle transitions without issuing SQL. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import type { MysqlConsumer } from '@deepseek-ai/dsh-mysql'
import { MysqlSessionHandle } from '../src/handle.ts'
import { MysqlSessionRepository } from '../src/repository.ts'
import { slotId, storeId } from '../src/records.ts'
import type { WriterIdentity } from '../src/types.ts'

function fixture(materialized = false) {
  const config = { storeKey: 'agent05-owned-writer', leaseTtlMs: 1000, heartbeatIntervalMs: 200,
    batchDelayMs: 0, readPageSize: 4 }
  const execute = vi.fn(async () => { throw new Error('Writer matching must not execute SQL.') })
  const transaction = vi.fn(async () => { throw new Error('Writer matching must not open a transaction.') })
  const sql: MysqlConsumer = {
    execute, transaction,
    dispose: async () => {},
  }
  const repository = new MysqlSessionRepository(sql, config)
  vi.spyOn(repository, 'release').mockResolvedValue(undefined)
  const renewal = vi.spyOn(repository, 'renew').mockResolvedValue(undefined)
  const writer: WriterIdentity = { id: SessionId('owned-writer'), storeId: storeId('1'), slotId: slotId('2'),
    lifecycle: Buffer.alloc(16, 1), version: SESSION_FORMAT_VERSION, owner: Buffer.alloc(16, 2), fence: '9007199254740993' }
  const report = vi.fn()
  const owner = { config, repository, report, pending: () => true, closed: () => {} }
  const header: SessionHeader = { id: writer.id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }
  const handle = new MysqlSessionHandle(owner, writer, header, SessionLogOffset(0), 'write', materialized, writer)
  const expected: { closeFailure?: unknown } = {}
  onTestFinished(async () => {
    try { await handle.close() } catch (error) { if (error !== expected.closeFailure) throw error }
  })
  return { handle, writer, repository, owner, header, report, execute, transaction, renewal, expected }
}

it('recognizes an unpublished creator while rejecting every foreign writer identity without SQL', () => {
  const target = fixture()
  const exact = { ...target.writer, lifecycle: Buffer.from(target.writer.lifecycle), owner: Buffer.from(target.writer.owner) }
  expect(target.handle.isMaterialized).toBe(false)
  expect(target.handle.ownsWriter(exact)).toBe(true)
  const foreign: WriterIdentity[] = [
    { ...exact, id: SessionId('other') }, { ...exact, storeId: storeId('3') }, { ...exact, slotId: slotId('3') },
    { ...exact, lifecycle: Buffer.alloc(16, 3) }, { ...exact, version: exact.version + 1 },
    { ...exact, owner: Buffer.alloc(16, 3) }, { ...exact, fence: '9007199254740992' },
  ]
  for (const writer of foreign) expect(target.handle.ownsWriter(writer)).toBe(false)
  expect(target.handle.ownsWriter(exact)).toBe(true)
  expect(target.execute).not.toHaveBeenCalled()
  expect(target.transaction).not.toHaveBeenCalled()
})

it('does not use a read handle as writer proof and revokes proof before a blocked close releases its lease', async () => {
  const target = fixture(true)
  const reader = new MysqlSessionHandle(target.owner, target.writer, target.header, SessionLogOffset(0), 'read', true)
  expect(reader.ownsWriter(target.writer)).toBe(false)
  await reader.close()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(target.repository, 'release').mockImplementation(() => release.promise)
  const closing = target.handle.close()
  try { expect(target.handle.ownsWriter(target.writer)).toBe(false) }
  finally { release.resolve(undefined); await closing }
})

it('revokes proof as soon as retirement starts while the admitted producer is still draining', async () => {
  const target = fixture(true)
  const producer = Promise.withResolvers<undefined>()
  target.handle.beforeBackendClose(() => producer.promise)
  const retiring = target.handle.retire()
  try { expect(target.handle.ownsWriter(target.writer)).toBe(false) }
  finally { producer.resolve(undefined); await retiring }
})

it('never restores writer proof after a failed heartbeat', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const target = fixture(true)
  const failure = new Error('Controlled renewal failure.')
  target.renewal.mockRejectedValue(failure)
  expect(target.handle.ownsWriter(target.writer)).toBe(true)
  await vi.advanceTimersByTimeAsync(200)
  expect(target.report).toHaveBeenCalledWith(failure)
  expect(target.handle.ownsWriter(target.writer)).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  expect(target.renewal).toHaveBeenCalledTimes(1)
  expect(target.handle.ownsWriter(target.writer)).toBe(false)
})

it('revokes writer proof after a terminal read failure and retains the native close failure', async () => {
  const target = fixture(true)
  const failure = new SessionPersistenceCorruptionError('Controlled malformed prefix.', {})
  target.expected.closeFailure = failure
  vi.spyOn(target.repository, 'read').mockRejectedValue(failure)
  await expect(target.handle.read()).rejects.toBe(failure)
  expect(target.handle.ownsWriter(target.writer)).toBe(false)
  await expect(target.handle.close()).rejects.toBe(failure)
})
