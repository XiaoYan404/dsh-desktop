/** New duplicate-publication, incomplete staging and unconfirmed receipt branches; no database is used. */
import { expect, it } from 'vitest'
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import type { MysqlClient, MysqlExecutor, MysqlParameter, MysqlResult } from '@deepseek-ai/dsh-mysql'
import { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { MysqlSearchRepository } from '../src/repository.ts'
import type { SearchClaim, SearchLimits } from '../src/types.ts'

const limits: SearchLimits = { pageSize: 2, claimTtlMs: 30000, maxDocumentBytes: 10000, maxBuildBytes: 10000,
  maxDocuments: 100, maxCandidates: 100, maxCandidateBytes: 10000, defaultLimit: 2, maxLimit: 10, snippetChars: 20 }

async function fixture(options: { duplicate?: boolean; changedCut?: boolean; unknownCommit?: boolean; hugeStore?: boolean } = {}) {
  const store = options.hugeStore ? '18446744073709551615' : '1'
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('publication'), createdAt: 1, isSeeded: false }
  const claim: SearchClaim = { cut: { storeId: store, slotId: '2', lifecycle: Buffer.alloc(16, 1), format: SESSION_FORMAT_VERSION,
    revision: '2', eventCount: 0, inheritedEventCount: SessionLogOffset(0), header }, token: Buffer.alloc(16, 2),
  buildId: Buffer.alloc(16, 3), expectedStateRevision: '0' }
  const calls: { sql: string; parameters: readonly MysqlParameter[] }[] = []
  let analyzerVersion = 1
  const execute = async (sql: string, parameters: readonly MysqlParameter[]): Promise<MysqlResult> => {
    calls.push({ sql, parameters })
    if (sql.startsWith('SELECT')) {
      if (sql.includes('FROM dsh_stores')) return { kind: 'rows', rows: [{ store_id: store, search_analyzer_version: analyzerVersion,
        search_epoch: '1', registry_revision: '0',
        ngram_size: 2, stopwords: 0, search_config_json: JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 }) }] }
      if (sql.includes('FROM dsh_session_slots')) return { kind: 'rows', rows: [{ store_id: store, slot_id: '2', lifecycle_id: claim.cut.lifecycle,
        format_version: SESSION_FORMAT_VERSION, log_state: 'active', log_revision: options.changedCut ? '3' : '2', event_count: '0',
        inherited_event_count: '0', header_json: JSON.stringify(header), external_session_id: header.id }] }
      if (sql.includes('FROM dsh_search_state')) return { kind: 'rows', rows: [{ active_build_id: options.duplicate ? Buffer.alloc(16, 9) : null,
        state_revision: '0', indexed_log_revision: options.duplicate ? '2' : null, indexed_event_count: '0' }] }
      if (sql.includes('FROM dsh_search_jobs')) return { kind: 'rows', rows: [{ claim_token: claim.token, valid: 1, target_log_revision: '2', target_event_count: '0' }] }
      if (sql.includes('COUNT(*)')) return { kind: 'rows', rows: [{ total: '0' }] }
      if (sql.includes('published_at')) return { kind: 'rows', rows: [] }
      throw new Error('Unexpected publication fixture SELECT.')
    }
    return { kind: 'write', affectedRows: 1, insertId: '0', warningStatus: 0 }
  }
  const client: MysqlClient = { execute, transaction: async <T>(work: (tx: MysqlExecutor) => Promise<T>) => {
    const result = await work({ execute })
    if (options.unknownCommit) throw new MysqlError('transaction_unknown', 'Owned protocol COMMIT unknown.', 'unknown')
    return result
  } }
  const repository = new MysqlSearchRepository(client, 'owned-publication-fixture', limits)
  await repository.initialize()
  calls.splice(0)
  return { repository, claim, calls, changeAnalyzer: () => { analyzerVersion = 2 } }
}

it('coalesces a duplicate fixed-cut build without republishing or changing epoch', async () => {
  const f = await fixture({ duplicate: true, hugeStore: true })
  await f.repository.publish(f.claim, 0)
  expect(f.calls[0]?.sql).toContain('FROM dsh_stores')
  expect(f.calls[0]?.parameters[0]).toBe('18446744073709551615')
  expect(f.calls.some(call => call.sql.includes('SET search_epoch='))).toBe(false)
  expect(f.calls.some(call => call.sql.includes("build_state='retired',document_count=?"))).toBe(true)
})

it('refuses a changed log revision even when the event count stayed equal', async () => {
  const f = await fixture({ changedCut: true })
  await expect(f.repository.publish(f.claim, 0)).rejects.toMatchObject({ reason: 'CUT_CHANGED' })
  expect(f.calls.every(call => call.sql.startsWith('SELECT'))).toBe(true)
})

it('refuses incomplete staging instead of publishing its claimed document count', async () => {
  const f = await fixture()
  await expect(f.repository.publish(f.claim, 1)).rejects.toMatchObject({ reason: 'INVALID_RECORD' })
  expect(f.calls.every(call => call.sql.startsWith('SELECT'))).toBe(true)
})

it('reports unknown publication when its durable build receipt cannot confirm COMMIT', async () => {
  const f = await fixture({ unknownCommit: true })
  await expect(f.repository.publish(f.claim, 0)).rejects.toMatchObject({ reason: 'PUBLICATION_UNKNOWN' })
  expect(f.calls.filter(call => call.sql.includes('SELECT build_state,published_at'))).toHaveLength(1)
})

it('refuses publication after the analyzer version changes beneath an existing worker', async () => {
  const f = await fixture()
  f.changeAnalyzer()
  await expect(f.repository.publish(f.claim, 0)).rejects.toMatchObject({ reason: 'UNSUPPORTED_ANALYZER' })
  expect(f.calls.every(call => call.sql.startsWith('SELECT'))).toBe(true)
})
