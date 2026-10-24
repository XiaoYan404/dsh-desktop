/** Active-lease and local-flush protocol cases; SQL responses are explicit fixtures, not database acceptance. */
import { expect, it, vi } from 'vitest'
import type { MysqlClient, MysqlExecutor, MysqlParameter, MysqlResult } from '@deepseek-ai/dsh-mysql'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { MysqlSessionWriterOwnership, MysqlSessionWriterIdentity } from '@deepseek-ai/dsh-session-persistence-mysql'
import { MysqlSearchRepository } from '../src/repository.ts'
import { bindMysqlSearchAccess } from '../src/access.ts'
import type { MysqlSearchAccess, SearchLimits } from '../src/types.ts'

const storeKey = 'owned-search-barrier'
const limits: SearchLimits = { pageSize: 1, claimTtlMs: 30000, maxDocumentBytes: 10000, maxBuildBytes: 100000,
  maxDocuments: 100, maxCandidates: 100, maxCandidateBytes: 100000, defaultLimit: 2, maxLimit: 10, snippetChars: 20 }

async function fixture(options: { creator?: boolean; expired?: boolean; changedLifecycle?: boolean } = {}) {
  const store = '18446744073709551615', slot = '9007199254740993'
  const lifecycle = Buffer.alloc(16, 1), owner = Buffer.alloc(16, 2)
  const calls: { sql: string; parameters: readonly MysqlParameter[] }[] = []
  const execute = async (sql: string, parameters: readonly MysqlParameter[]): Promise<MysqlResult> => {
    calls.push({ sql, parameters })
    if (sql.includes('FROM dsh_stores')) return { kind: 'rows', rows: [{ store_id: store, search_analyzer_version: 1,
      ngram_size: 2, stopwords: 0, search_config_json: JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 }) }] }
    if (sql.includes('ORDER BY slot_id LIMIT')) return { kind: 'rows', rows: parameters[1] === '0' ? [{ slot_id: slot }] : [] }
    if (sql.includes('FROM dsh_session_slots')) return { kind: 'rows', rows: [{ slot_id: slot, external_session_id: 'creator',
      current_lifecycle_id: options.creator ? null : options.changedLifecycle ? Buffer.alloc(16, 9) : lifecycle,
      current_format_version: options.creator ? null : SESSION_FORMAT_VERSION }] }
    if (sql.includes('FROM dsh_writer_leases')) return { kind: 'rows', rows: [{ lifecycle_id: lifecycle,
      owner_token: owner, fence_token: '9007199254740995', valid: options.expired ? 0 : 1 }] }
    throw new Error('Unexpected writer-barrier protocol statement')
  }
  const sql: MysqlClient = { execute,
    transaction: async <T>(work: (tx: MysqlExecutor) => Promise<T>) => work({ execute }) }
  const repository = new MysqlSearchRepository(sql, storeKey, limits)
  await repository.initialize()
  calls.splice(0)
  return { repository, calls, store, slot, lifecycle, owner }
}

it('checks an unpublished creator with exact store, slot, lifecycle, format, owner and bigint fence', async () => {
  const f = await fixture({ creator: true })
  const owns = vi.fn((_writer: MysqlSessionWriterIdentity) => true)
  await f.repository.assertLocalWriters({ mysqlStoreKey: storeKey, ownsMysqlWriter: owns })
  expect(owns).toHaveBeenCalledWith({ id: SessionId('creator'), storeId: f.store, slotId: f.slot,
    lifecycle: f.lifecycle, version: SESSION_FORMAT_VERSION, owner: f.owner, fence: '9007199254740995' })
  const locked = f.calls.filter(call => call.sql.includes('FOR UPDATE'))
  expect(locked.map(call => call.sql.includes('dsh_stores') ? 'store' : call.sql.includes('dsh_session_slots') ? 'slot' : 'lease'))
    .toEqual(['store', 'slot', 'lease'])
  expect(f.calls.every(call => !call.sql.includes('dsh_session_logs'))).toBe(true)
})

it('rejects a foreign unpublished creator instead of reporting a complete empty corpus', async () => {
  const f = await fixture({ creator: true })
  await expect(f.repository.assertLocalWriters({ mysqlStoreKey: storeKey, ownsMysqlWriter: () => false }))
    .rejects.toMatchObject({ reason: 'ACCESS_UNAVAILABLE' })
})

it('refuses an active lease for a different current lifecycle before borrowing local proof', async () => {
  const f = await fixture({ changedLifecycle: true })
  const owns = vi.fn(() => true)
  await expect(f.repository.assertLocalWriters({ mysqlStoreKey: storeKey, ownsMysqlWriter: owns }))
    .rejects.toMatchObject({ reason: 'ACCESS_UNAVAILABLE' })
  expect(owns).not.toHaveBeenCalled()
})

it('rechecks expiry under the store lock and rejects a different namespace before SQL', async () => {
  const f = await fixture({ expired: true })
  const owns = vi.fn(() => false)
  await f.repository.assertLocalWriters({ mysqlStoreKey: storeKey, ownsMysqlWriter: owns })
  expect(owns).not.toHaveBeenCalled()
  f.calls.splice(0)
  await expect(f.repository.assertLocalWriters({ mysqlStoreKey: 'other-store', ownsMysqlWriter: owns }))
    .rejects.toMatchObject({ reason: 'ACCESS_UNAVAILABLE' })
  expect(f.calls).toHaveLength(0)
})

function policy(): MysqlSearchAccess {
  return { flush: async () => {}, authorize: async () => ({ principal: 'employee', revision: 'login-policy', sessionIds: [] }), isLive: () => false }
}

it('waits for local flush to settle before entering store-lock ownership checks', async () => {
  const pending = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const order: string[] = []
  const persistence: MysqlSessionWriterOwnership & { flush(): Promise<void> } = {
    mysqlStoreKey: storeKey, ownsMysqlWriter: () => true,
    flush: async () => { order.push('flush'); entered.resolve(undefined); await pending.promise; order.push('drained') },
  }
  const verify = vi.fn(async () => { order.push('store-locked') })
  const bound = bindMysqlSearchAccess(persistence, policy(), { assertLocalWriters: verify })
  const task = bound.flush(new AbortController().signal)
  await entered.promise
  expect(verify).not.toHaveBeenCalled()
  pending.resolve(undefined)
  await task
  expect(order).toEqual(['flush', 'drained', 'store-locked'])
})

it('cancels after local drain without acquiring SQL locks or invoking authorization', async () => {
  const pending = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  const reason = new Error('GUI search cancelled')
  const verify = vi.fn(async () => {})
  const bound = bindMysqlSearchAccess({ mysqlStoreKey: storeKey, ownsMysqlWriter: () => true,
    flush: async () => { entered.resolve(undefined); await pending.promise } }, policy(), { assertLocalWriters: verify })
  const task = bound.flush(controller.signal)
  const settled = expect(task).rejects.toBe(reason)
  await entered.promise
  controller.abort(reason)
  pending.resolve(undefined)
  await settled
  expect(verify).not.toHaveBeenCalled()
})
