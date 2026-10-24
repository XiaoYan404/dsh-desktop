/** New authorized MySQL query behaviors; these fixtures make no database/composition claim. */
import { describe, expect, it, vi } from 'vitest'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { filterSessionEventDocuments } from '@deepseek-ai/dsh-session-query'
import type { SessionEventMetadataFilter } from '@deepseek-ai/dsh-session-query'
import { MysqlSearchError } from '../src/error.ts'
import { MysqlSearchQueries } from '../src/query.ts'
import type { SearchAuthorization, SearchCandidate, SearchCut, SearchLimits, SearchView } from '../src/types.ts'

const limits: SearchLimits = { pageSize: 20, claimTtlMs: 30000, maxDocumentBytes: 10000, maxBuildBytes: 100000,
  maxDocuments: 100, maxCandidates: 100, maxCandidateBytes: 100000, defaultLimit: 2, maxLimit: 10, snippetChars: 12 }
const signal = new AbortController().signal

function fixture() {
  const cut = (id: string, slot: string): SearchCut => ({ storeId: '1', slotId: slot, lifecycle: Buffer.alloc(16, Number(slot)),
    format: SESSION_FORMAT_VERSION, revision: '1', eventCount: 6, inheritedEventCount: SessionLogOffset(0),
    header: { id: SessionId(id), version: SESSION_FORMAT_VERSION, isSeeded: false, createdAt: 1, cwd: '/workspace' } })
  const cuts = [cut('alice-a', '2'), cut('alice-b', '3'), cut('bob-private', '4')]
  let permission: SearchAuthorization = { principal: 'alice', revision: 'login-1:policy-1', sessionIds: cuts.slice(0, 2).map(cut => cut.header.id) }
  let epoch = '1', snapshotCalls = 0
  const documents: SearchCandidate[] = cuts.flatMap((cut, index) => [
    { sessionId: cut.header.id, seq: SessionSeq(2), type: 'user/message' as const, time: 10 + index,
      surface: 'current' as const, text: index === 2 ? '计划 '.repeat(20) + 'bob secret' : '计划 审核 😀 foo() A\n B',
      record: { header: cut.header, persisted: true, live: false } },
    { sessionId: cut.header.id, seq: SessionSeq(3), type: 'user/message' as const, time: 20,
      surface: 'shadowed' as const, text: '计划 计划 计划 obsolete', record: { header: cut.header, persisted: true, live: false } },
  ])
  const repository = {
    snapshot: vi.fn(async (): Promise<SearchView> => {
      snapshotCalls++
      return structuredClone({ storeId: '1', epoch, registryRevision: '1', cuts })
    }),
    candidates: vi.fn(async (cut: SearchCut, _query: string, filters: readonly SessionEventMetadataFilter[], _fts: boolean) =>
      filterSessionEventDocuments(documents.filter(document => document.sessionId === cut.header.id), filters)),
  }
  const access = { flush: vi.fn(async () => {}), authorize: vi.fn(async () => structuredClone(permission)), isLive: () => false }
  return { query: new MysqlSearchQueries(repository, access, limits), repository, access, cuts, documents,
    setPermission: (value: SearchAuthorization) => { permission = value }, setEpoch: (value: string) => { epoch = value },
    snapshots: () => snapshotCalls }
}

describe('MySQL authorized query and cursor', () => {
  it.each([['计划', true], ['审', false], ['😀', false], ['foo()', true], ['A B', false]] as const)(
    'preserves literal query %s and selects a complete recall path', async (query, fulltext) => {
      const f = fixture()
      const result = await f.query.sessions({ query, eventFilters: [{ kind: 'surface', values: ['current'] }] }, signal)
      expect(result.items.map(item => item.header.id).sort()).toEqual(['alice-a', 'alice-b'])
      expect(f.repository.candidates.mock.calls.every(call => call[3] === fulltext)).toBe(true)
      expect(result.items.every(item => Array.from(item.bestMatch.snippet).length <= limits.snippetChars)).toBe(true)
      expect(f.repository.candidates.mock.calls.map(call => call[0].header.id)).not.toContain('bob-private')
    })

  it('filters permissions, session, event time and surface before choosing the best event', async () => {
    const f = fixture()
    const result = await f.query.sessions({ query: '计划', sessionFilters: [{ kind: 'id', values: [SessionId('alice-a')] }],
      eventFilters: [{ kind: 'surface', values: ['current'] }, { kind: 'time', from: 10, to: 10 }] }, signal)
    expect(result.items.map(item => [item.header.id, item.bestMatch.seq])).toEqual([['alice-a', 2]])
    expect(f.repository.candidates).toHaveBeenCalledTimes(1)
  })

  it('uses a stable full ranking tuple and does not page events before session grouping', async () => {
    const f = fixture()
    const request = { query: '计划', limit: 1, eventFilters: [{ kind: 'surface' as const, values: ['current' as const] }] }
    const first = await f.query.sessions(request, signal)
    expect(first.items[0]?.header.id).toBe('alice-b')
    expect(first.nextCursor).toBeDefined()
    const next = await f.query.sessions({ ...request, cursor: first.nextCursor! }, signal)
    expect(next.items[0]?.header.id).toBe('alice-a')
    expect(next.nextCursor).toBeUndefined()
  })

  it.each(['query', 'principal', 'permission', 'epoch', 'cut'] as const)('invalidates a cursor when %s changes', async (change) => {
    const f = fixture()
    const request = { query: '计划', limit: 1 }
    const first = await f.query.sessions(request, signal)
    if (change === 'principal' || change === 'permission') f.setPermission({ principal: change === 'principal' ? 'alice-new-login' : 'alice',
      revision: change === 'permission' ? 'login-1:policy-2' : 'login-1:policy-1', sessionIds: f.cuts.slice(0, 2).map(cut => cut.header.id) })
    if (change === 'epoch') f.setEpoch('2')
    if (change === 'cut') f.cuts[0] = { ...f.cuts[0]!, revision: '2' }
    await expect(f.query.sessions({ ...request, query: change === 'query' ? '审' : request.query, cursor: first.nextCursor! }, signal))
      .rejects.toMatchObject({ code: 'SESSION_QUERY_STALE_CURSOR' })
  })

  it('reports an index gap and an exhausted complete-scan budget explicitly', async () => {
    const f = fixture()
    f.repository.candidates.mockRejectedValueOnce(new MysqlSearchError('INDEX_NOT_READY'))
    await expect(f.query.sessions({ query: '计划' }, signal)).rejects.toMatchObject({ reason: 'INDEX_NOT_READY' })
    const constrained = new MysqlSearchQueries(f.repository, f.access, { ...limits, maxCandidates: 1 })
    await expect(constrained.sessions({ query: '😀' }, signal)).rejects.toMatchObject({ reason: 'CAPACITY' })
  })

  it('withholds late results after employee revocation and refuses missing authority identity', async () => {
    const f = fixture()
    f.access.authorize.mockImplementationOnce(async () => ({ principal: 'alice', revision: '1', sessionIds: [SessionId('alice-a')] }))
    f.access.authorize.mockImplementationOnce(async () => ({ principal: 'alice', revision: '2', sessionIds: [] }))
    await expect(f.query.sessions({ query: '计划' }, signal)).rejects.toMatchObject({ code: 'SESSION_QUERY_SOURCE_CONFLICT' })
    f.setPermission({ principal: '', revision: '', sessionIds: [] })
    await expect(f.query.sessions({ query: '计划' }, signal)).rejects.toMatchObject({ reason: 'ACCESS_UNAVAILABLE' })
  })

  it('hides an unauthorized event-search target without reading its index', async () => {
    const f = fixture()
    await expect(f.query.events({ sessionId: SessionId('bob-private'), query: '计划' }, signal))
      .rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    expect(f.repository.candidates).not.toHaveBeenCalled()
  })
})
