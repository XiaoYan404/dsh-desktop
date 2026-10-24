/** A permanently invalid writer reports rejected live routing without unbounded repeated log output. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { MysqlSessionHandle } from '../src/handle.ts'
import { MysqlSessionRepository } from '../src/repository.ts'
import { slotId, storeId } from '../src/records.ts'

it('reports one terminal routing failure and never appends the following live events', async () => {
  const config = { storeKey: 'agent05-routing', leaseTtlMs: 1000, heartbeatIntervalMs: 200,
    batchDelayMs: 0, readPageSize: 4 }
  const repository = new MysqlSessionRepository({
    execute: async () => { throw new Error('No SQL belongs to failed event routing.') },
    transaction: async () => { throw new Error('No SQL belongs to failed event routing.') },
  }, config)
  const failure = new SessionPersistenceCorruptionError('Controlled malformed prefix.', {})
  vi.spyOn(repository, 'read').mockRejectedValue(failure)
  vi.spyOn(repository, 'release').mockResolvedValue(undefined)
  const append = vi.spyOn(repository, 'append')
  const report = vi.fn()
  const writer = { id: SessionId('routing-failure'), storeId: storeId('1'), slotId: slotId('2'),
    lifecycle: Buffer.alloc(16, 1), version: SESSION_FORMAT_VERSION, owner: Buffer.alloc(16, 2), fence: '1' }
  const handle = new MysqlSessionHandle({ config, repository, report, pending: () => false, closed: () => {} }, writer,
    { id: writer.id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false }, SessionLogOffset(0), 'write', true, writer)
  onTestFinished(async () => { await expect(handle.close()).rejects.toBe(failure) })
  await expect(handle.read()).rejects.toBe(failure)
  for (let seq = 0; seq < 1000; seq++) {
    handle.enqueueLive({ type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn: 1 } })
  }
  expect(report).toHaveBeenCalledExactlyOnceWith(failure)
  expect(append).not.toHaveBeenCalled()
  await expect(handle.flush()).rejects.toBe(failure)
  await expect(handle.close()).rejects.toBe(failure)
})
