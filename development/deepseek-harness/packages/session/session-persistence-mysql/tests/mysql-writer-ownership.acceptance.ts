/** New real-engine proof for an unpublished creator; run only in Agent 08's drained verification window. */
import { randomBytes } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { hasMysqlSessionWriterOwnership, mysqlSessionBinaryId, mysqlSessionCount, mysqlSessionSlotId, mysqlSessionStoreId,
  mysqlSessionText } from '../src/index.ts'
import type { MysqlSessionWriterIdentity } from '../src/index.ts'
import type { RowDataPacket } from 'mysql2/promise'
import { bootV3, newTarget } from '../../../workspace/workspace-mysql/tests/fixtures/loader.ts'

it('matches the real unpublished writer lease under store locks and revokes proof before release completes', async () => {
  if (process.env['DSH_AGENT05_DB_WINDOW'] !== 'owned-writer-proof') {
    throw new Error('Agent 08 must confirm the paused and drained writer-proof database window before this case runs.')
  }
  const target = await newTarget()
  const boot = await bootV3(target)
  onTestFinished(async () => { await boot.close(); await target.close() })
  const persistence = boot.ctx.sessionPersistence
  if (!hasMysqlSessionWriterOwnership(persistence)) throw new Error('The formal Host ownership capability is absent.')
  expect(persistence.mysqlStoreKey).toBe(target.storeKey)
  const id = SessionId('agent05-unpublished-owned-proof')
  const handle = await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
  let expected: MysqlSessionWriterIdentity
  await target.connection.beginTransaction()
  try {
    await target.connection.execute('SELECT store_id FROM dsh_stores WHERE store_id=? FOR UPDATE', [target.storeId])
    const [slots] = await target.connection.execute<RowDataPacket[]>(
      'SELECT slot_id,current_lifecycle_id,current_format_version FROM dsh_session_slots WHERE store_id=? AND external_session_id=? FOR UPDATE',
      [target.storeId, id])
    const slot = slots[0]
    if (!slot) throw new Error('The actual unpublished creator has no slot.')
    expect(slot['current_lifecycle_id']).toBeNull()
    expect(slot['current_format_version']).toBeNull()
    const slotId = mysqlSessionSlotId(slot['slot_id'])
    const [leases] = await target.connection.execute<RowDataPacket[]>(
      'SELECT owner_token,lifecycle_id,fence_token,(expires_at>UTC_TIMESTAMP(6)) AS lease_valid FROM dsh_writer_leases WHERE store_id=? AND slot_id=? FOR UPDATE',
      [target.storeId, slotId])
    const lease = leases[0]
    if (!lease) throw new Error('The actual unpublished creator has no lease.')
    expect(mysqlSessionCount(lease['lease_valid'])).toBe(1)
    expected = { id, storeId: mysqlSessionStoreId(target.storeId), slotId, version: SESSION_FORMAT_VERSION,
      lifecycle: mysqlSessionBinaryId(lease['lifecycle_id']), owner: mysqlSessionBinaryId(lease['owner_token']),
      fence: mysqlSessionText(lease, 'fence_token') }
    expect(persistence.ownsMysqlWriter(expected)).toBe(true)
    expect(persistence.ownsMysqlWriter({ ...expected, owner: randomBytes(16) })).toBe(false)
    await target.connection.commit()
  } catch (error) { await target.connection.rollback(); throw error }
  const closing = handle.close()
  expect(persistence.ownsMysqlWriter(expected)).toBe(false)
  await closing
  expect(await persistence.stat(id)).toBeUndefined()
  const [released] = await target.connection.execute<RowDataPacket[]>(
    'SELECT owner_token FROM dsh_writer_leases WHERE store_id=? AND slot_id=?', [target.storeId, expected.slotId])
  expect(released[0]?.['owner_token']).toBeNull()
})
