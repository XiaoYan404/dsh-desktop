/** New allocation cases exercise server-side value refusal before any JSON body reaches the driver result. */
import { expect, it } from 'vitest'
import { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { mysqlSessionStoreId, mysqlSessionSlotId } from '@deepseek-ai/dsh-session-persistence-mysql'
import type { MysqlStoredSessionLog } from '@deepseek-ai/dsh-session-persistence-mysql'
import type { MysqlExecutor, MysqlRow } from '@deepseek-ai/dsh-mysql'
import { identityOf } from '../src/model.ts'
import { completePrefix, readCheckpoint, projectionSql } from '../src/sql.ts'
import type { CheckpointHead } from '../src/sql.ts'

const config = { storeKey: 'owned', maxEvents: 100, maxInputBytes: 1000, maxCheckpointBytes: 1000,
  maxUnits: 8, readPageSize: 2, maxPendingOperations: 3 }
const log: MysqlStoredSessionLog = { id: SessionId('bounded'), storeId: mysqlSessionStoreId('1'), slotId: mysqlSessionSlotId('2'),
  lifecycle: Buffer.alloc(16, 1), version: SESSION_FORMAT_VERSION,
  header: { id: SessionId('bounded'), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
  inheritedEventCount: SessionLogOffset(0), eventCount: 0, revision: '1' }
const head = (units: number): CheckpointHead => ({ revision: '1', observedRevision: '1', eventCount: 0,
  raw: { cache_record_version: 7, identity_json: JSON.stringify(identityOf(log)), unit_count: units } })
function peer(metadata: readonly MysqlRow[], value: () => string | never) {
  let pages = 0, values = 0
  const executor: MysqlExecutor = { execute: async (sql) => {
    if (sql === projectionSql.states) { pages++; return { kind: 'rows', rows: pages === 1 ? metadata : [] } }
    if (sql === projectionSql.stateValue) { values++; return { kind: 'rows', rows: [{ state_json: value() }] } }
    throw new Error('Unexpected bounded checkpoint SQL')
  } }
  return { executor, counts: () => ({ pages, values }) }
}

it('rejects excessive head counts without querying state rows and oversized values without fetching their JSON', async () => {
  const count = peer([], () => { throw new Error('No value may be read') })
  expect(await readCheckpoint(count.executor, log, head(9), config)).toBeUndefined()
  expect(count.counts()).toEqual({ pages: 0, values: 0 })
  const bytes = peer([{ projection_key: '', state_version: 1, last_seq: '-1', state_bytes: '9000000' }], () => { throw new Error('Oversized value was fetched') })
  expect(await readCheckpoint(bytes.executor, log, head(1), config)).toBeUndefined()
  expect(bytes.counts().values).toBe(0)
})
it('pages and restores an empty key with JSON null, and keeps raw read failures observable', async () => {
  const valid = peer([{ projection_key: '', state_version: 1, last_seq: '-1', state_bytes: '4' }], () => 'null')
  const checkpoint = await readCheckpoint(valid.executor, log, head(1), config)
  expect(checkpoint?.rows['']).toEqual({ ver: 1, seq: -1, val: null })
  expect(valid.counts()).toEqual({ pages: 2, values: 1 })
  const failure = new Error('raw IO retained')
  const failed = peer([{ projection_key: '', state_version: 1, last_seq: '-1', state_bytes: '4' }], () => { throw failure })
  await expect(readCheckpoint(failed.executor, log, head(1), config)).rejects.toBe(failure)
})
it('refuses an oversized event from length metadata before allocating its payload response', async () => {
  let bodyQueries = 0
  const executor: MysqlExecutor = { execute: async (sql) => {
    if (sql === projectionSql.events) return { kind: 'rows', rows: [{ seq: '0', event_bytes: '2000000' }] }
    bodyQueries++; throw new Error('Oversized event body was fetched')
  } }
  await expect(completePrefix(executor, { ...log, eventCount: 1 }, config)).rejects.toMatchObject({ code: 'capacity' })
  expect(bodyQueries).toBe(0)
})
