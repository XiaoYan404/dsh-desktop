/** Remaining real-engine failures: COMMIT never reached the server, and a conflicting durable receipt. */
import { randomBytes } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import type { RowDataPacket } from 'mysql2/promise'
import { newTarget, bootV3 } from '../../../workspace/workspace-mysql/tests/fixtures/loader.ts'
import { MysqlSessionRepository } from '../src/repository.ts'
import { createBeforeCommitDisconnectProxy } from './fixtures/mysql-before-commit-proxy.ts'

const events: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]
const header = (id: SessionId): SessionHeader => ({ id, version: SESSION_FORMAT_VERSION, createdAt: 100, isSeeded: false })

it('keeps the frozen batch when the server never receives COMMIT and only resends it after missing-receipt readback', async () => {
  const target = await newTarget()
  const proxy = await createBeforeCommitDisconnectProxy()
  const boot = await bootV3(target, { port: proxy.port })
  onTestFinished(async () => { await boot.close(); await proxy.close(); await target.close() })
  const writer = await boot.ctx.sessionPersistence.create(header(SessionId('missing-receipt-真实回滚')))
  await writer.flush()
  const capture = vi.spyOn(MysqlSessionRepository.prototype, 'append')
  onTestFinished(() => { capture.mockRestore() })
  proxy.arm()
  await expect(writer.append(events)).rejects.toMatchObject({ code: 'transaction_unknown', outcome: 'unknown', retryable: false })
  const [before] = await target.connection.execute<RowDataPacket[]>(
    'SELECT (SELECT COUNT(*) FROM dsh_session_events WHERE store_id=?) AS events,(SELECT COUNT(*) FROM dsh_append_batches WHERE store_id=?) AS receipts', [target.storeId, target.storeId])
  expect(Number(before[0]?.['events'])).toBe(0)
  expect(Number(before[0]?.['receipts'])).toBe(0)
  expect(proxy.stats()).toMatchObject({ dropped: 1, receiptExecutions: 1 })
  const batch = capture.mock.calls[0]?.[4]
  expect(batch).toBeDefined()
  await writer.flush()
  expect(capture.mock.calls).toHaveLength(2)
  expect(capture.mock.calls[1]?.[4]).toBe(batch)
  const reader = await boot.ctx.sessionPersistence.open(writer.id, 'read')
  try { expect((await reader.read()).events).toEqual(events) } finally { await reader.close() }
  const [after] = await target.connection.execute<RowDataPacket[]>(
    'SELECT COUNT(*) AS count,HEX(payload_sha256) AS digest FROM dsh_append_batches WHERE store_id=? GROUP BY payload_sha256', [target.storeId])
  expect(after).toHaveLength(1)
  expect(Number(after[0]?.['count'])).toBe(1)
  expect(after[0]?.['digest']).toBe(batch?.sha256.toString('hex').toUpperCase())
  await writer.close()
})

it('freezes a handle on a conflicting real receipt and never converts that corruption into another append', async () => {
  const target = await newTarget()
  const proxy = await createBeforeCommitDisconnectProxy()
  const boot = await bootV3(target, { port: proxy.port })
  onTestFinished(async () => { await boot.close(); await proxy.close(); await target.close() })
  const writer = await boot.ctx.sessionPersistence.create(header(SessionId('conflicting-receipt')))
  await writer.flush()
  const capture = vi.spyOn(MysqlSessionRepository.prototype, 'append')
  onTestFinished(() => { capture.mockRestore() })
  proxy.arm()
  await expect(writer.append(events)).rejects.toMatchObject({ outcome: 'unknown' })
  const first = capture.mock.calls[0]
  if (!first) throw new Error('No captured original append.')
  const [owner, _header, _inherited, _parent, batch] = first
  await target.connection.execute('INSERT INTO dsh_append_batches (store_id,slot_id,lifecycle_id,format_version,batch_id,first_seq,batch_event_count,payload_sha256,committed_revision,writer_fence) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [owner.storeId, owner.slotId, owner.lifecycle, owner.version, batch.batchId, batch.firstSeq, batch.events.length, randomBytes(32), '1', owner.fence])
  const failure: unknown = await writer.flush().then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(SessionPersistenceCorruptionError)
  await expect(writer.append(events)).rejects.toBe(failure)
  await expect(writer.flush()).rejects.toBe(failure)
  await expect(writer.close()).rejects.toBe(failure)
  expect(capture.mock.calls).toHaveLength(2)
  const [state] = await target.connection.execute<RowDataPacket[]>(
    'SELECT (SELECT COUNT(*) FROM dsh_session_events WHERE store_id=?) AS events,(SELECT owner_token FROM dsh_writer_leases WHERE store_id=?) AS owner', [target.storeId, target.storeId])
  expect(Number(state[0]?.['events'])).toBe(0)
  expect(state[0]?.['owner']).toBeNull()
})

it('persists an exact seeded cut and keeps an old read handle bound when the external slot is recreated', async () => {
  const target = await newTarget()
  const boot = await bootV3(target)
  onTestFinished(async () => { await boot.close(); await target.close() })
  const id = SessionId('seeded-reused-slot')
  const writer = await boot.ctx.sessionPersistence.create({ ...header(id), isSeeded: true, parentSession: SessionId('original-parent') },
    { inheritedEventCount: SessionLogOffset(2) })
  const seed: SessionEvent[] = [...events, { type: 'session/end-seed', seq: SessionSeq(2), time: 3, data: { inherited: true } }]
  await writer.append(seed)
  await writer.close()
  const reader = await boot.ctx.sessionPersistence.open(id, 'read')
  const [before] = await target.connection.execute<RowDataPacket[]>('SELECT slot_id,HEX(current_lifecycle_id) AS lifecycle FROM dsh_session_slots WHERE store_id=? AND external_session_id=?', [target.storeId, id])
  await target.connection.beginTransaction()
  try {
    await target.connection.execute('SELECT store_id FROM dsh_stores WHERE store_id=? FOR UPDATE', [target.storeId])
    await target.connection.execute('UPDATE dsh_session_slots SET current_lifecycle_id=NULL,current_format_version=NULL WHERE store_id=? AND slot_id=?', [target.storeId, before[0]?.['slot_id']])
    await target.connection.execute("UPDATE dsh_session_logs SET log_state='sealed' WHERE store_id=? AND slot_id=?", [target.storeId, before[0]?.['slot_id']])
    await target.connection.commit()
  } catch (error) { await target.connection.rollback(); throw error }
  const successor = await boot.ctx.sessionPersistence.create(header(id))
  await successor.flush()
  await successor.close()
  try { expect((await reader.read()).events).toEqual(seed) } finally { await reader.close() }
  const [after] = await target.connection.execute<RowDataPacket[]>('SELECT HEX(current_lifecycle_id) AS lifecycle FROM dsh_session_slots WHERE store_id=? AND external_session_id=?', [target.storeId, id])
  expect(after[0]?.['lifecycle']).not.toBe(before[0]?.['lifecycle'])
  const [logs] = await target.connection.execute<RowDataPacket[]>('SELECT inherited_event_count,event_count,log_state FROM dsh_session_logs WHERE store_id=? ORDER BY log_state', [target.storeId])
  expect(logs).toHaveLength(2)
  expect(logs.some(row => row['inherited_event_count'] === '2' && row['event_count'] === '3' && row['log_state'] === 'sealed')).toBe(true)
})
