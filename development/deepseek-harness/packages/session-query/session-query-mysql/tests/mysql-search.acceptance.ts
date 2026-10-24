/** New real-Loader/real-MySQL search lane. It retains its independent namespace and never runs DDL. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import MysqlRuntime, { MysqlError } from '@deepseek-ai/dsh-mysql'
import type { MysqlClient } from '@deepseek-ai/dsh-mysql'
import SessionStore, { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import MysqlSessionPersistence from '@deepseek-ai/dsh-session-persistence-mysql'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import { ownedV3Target } from '../../../storage/mysql/tests/fixtures/owned-v3.ts'
import MysqlSessionQueryEngine from '../src/index.ts'
import { MysqlSearchRepository } from '../src/repository.ts'
import type { MysqlSearchAccess, SearchLimits } from '../src/types.ts'

const repo = resolve(import.meta.dirname, '../../../..')
const limits: SearchLimits = { pageSize: 2, claimTtlMs: 30000, maxDocumentBytes: 100000, maxBuildBytes: 1000000,
  maxDocuments: 1000, maxCandidates: 1000, maxCandidateBytes: 1000000, defaultLimit: 2, maxLimit: 10, snippetChars: 40 }

it('publishes complete semantic builds, isolates employee queries, rejects stale cuts/cursors and queries after a fresh Loader', async () => {
  const target = await ownedV3Target(repo)
  const storeKey = 'agent06-search-' + randomUUID().replaceAll('-', '')
  const homes: string[] = [], contexts: Context[] = []
  const evidence: Record<string, unknown> = { node: process.version, schemaMode: 'verify', namespace: storeKey,
    databaseFixture: 'reviewed-owned-v3', productionAccessBound: false, migrationRestoreAccepted: false }
  let principal = 'alice', authorityRevision = 'login-1:policy-1'
  const allowed = new Set<SessionId>([SessionId('alice-a'), SessionId('alice-b')])

  class FixtureAccess extends Service implements MysqlSearchAccess {
    static inject = ['sessions', 'sessionPersistence']
    constructor(ctx: Context) { super(ctx, 'sessionQueryMysqlAccess') }
    async flush(signal: AbortSignal) { signal.throwIfAborted(); await this.ctx.sessionPersistence.flush(); signal.throwIfAborted() }
    async authorize(candidates: readonly SessionRecord[], signal: AbortSignal) {
      signal.throwIfAborted()
      return { principal, revision: authorityRevision,
        sessionIds: candidates.filter(value => allowed.has(value.header.id)).map(value => value.header.id) }
    }
    isLive(id: SessionId) { return this.ctx.sessions.get(id) !== undefined }
  }

  async function boot() {
    const home = await mkdtemp(join(tmpdir(), 'dsh06-search-'))
    homes.push(home)
    const ref = 'DSH_MYSQL_SEARCH_' + randomUUID().replaceAll('-', '').toUpperCase()
    const seed = new Context()
    try {
      await seed.plugin(CredentialsLocal, { dshHome: home, watch: false })
      await seed.credentials.set(credentialRef(ref), target.password)
    } finally { await seed.fiber.dispose() }
    const modules = new Map<string, unknown>([
      ['credentials', CredentialsLocal], ['mysql', MysqlRuntime], ['sessions', SessionStore], ['projections', SessionProjectionRegistry],
      ['persistence', MysqlSessionPersistence], ['fixture-access', FixtureAccess], ['query', MysqlSessionQueryEngine],
    ])
    const rows = [
      { name: 'credentials', config: { dshHome: home, watch: false } },
      { name: 'mysql', config: { host: '127.0.0.1', port: 11406, database: target.database, user: target.user,
        passwordRef: ref, schemaMode: 'verify', connectionLimit: 4 } },
      { name: 'projections' }, { name: 'sessions' }, { name: 'persistence', config: { storeKey } },
      { name: 'fixture-access' }, { name: 'query', config: { storeKey, ...limits } },
    ]
    const file = join(home, 'cordis.yml')
    await writeFile(file, JSON.stringify(rows), { mode: 0o600 })
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const internal = ctx.loader.internal
    if (!internal) throw new Error('The real Node Loader is unavailable.')
    ctx.loader.internal = new Proxy(internal, { get(owner, property) {
      if (property === 'import') return async (specifier: string) => {
        if (!modules.has(specifier)) throw new Error('Unexpected isolated search fixture module.')
        return modules.get(specifier)
      }
      const value: unknown = Reflect.get(owner, property, owner)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(owner) : value
    } })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) if (entry.fiber) await entry.fiber.await()
    const query = ctx.get('sessionQuery')
    if (!(query instanceof MysqlSessionQueryEngine)) throw new Error('The real MySQL query provider did not activate.')
    return { ctx, query }
  }

  try {
    const [before] = await target.connection.execute('SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version')
    await target.connection.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)',
      [storeKey, 'Agent 06 owned search acceptance', JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 })])
    const first = await boot()
    for (const id of ['alice-a', 'alice-b', 'bob-private']) {
      const header: SessionHeader = { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/owned-search' }
      const writer = await first.ctx.sessionPersistence.create(header)
      const message = (seq: number, text: string, replacement = false): SessionEvent<'user/message'> => ({
        type: 'user/message', seq: SessionSeq(seq), time: seq + (id === 'alice-a' ? 100 : 200),
        data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
        surfaceOp: replacement ? { op: 'replace', startSeq: SessionSeq(2), endSeq: SessionSeq(2) } : 'append',
        ...(replacement ? { sourceEventSeqs: [SessionSeq(2)] } : {}),
      })
      try { await writer.append([
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
        message(2, '旧计划 secret-shadowed'), message(3, id === 'bob-private' ? '计划 '.repeat(20) + 'bob private' : '计划 审核 😀 foo() A\n B', true),
        { type: 'step/end', seq: SessionSeq(4), time: 4, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: SessionSeq(5), time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      ]) }
      finally { await writer.close() }
    }
    await expect(first.query.searchSessions({ query: '计划' })).rejects.toMatchObject({ reason: 'INDEX_NOT_READY' })
    const repository = new MysqlSearchRepository(first.ctx.mysql, storeKey, limits)
    await repository.initialize()
    const claim = await repository.claim()
    if (!claim) throw new Error('Expected an owned pending search job.')
    const stagedCount = await repository.stage(claim)
    await expect(first.query.searchSessions({ query: '计划' })).rejects.toMatchObject({ reason: 'INDEX_NOT_READY' })
    const expire = async (owned: typeof claim) => {
      await first.ctx.mysql.execute('UPDATE dsh_search_jobs SET claim_expires_at=TIMESTAMPADD(MICROSECOND,-1,UTC_TIMESTAMP(6)) WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=? AND claim_token=?',
        [owned.cut.storeId, owned.cut.slotId, owned.cut.lifecycle, owned.cut.format, owned.token])
    }
    await expire(claim)
    await expect(repository.publish(claim, stagedCount)).rejects.toMatchObject({ reason: 'CLAIM_LOST' })
    const replacementClaim = await repository.claim()
    if (!replacementClaim) throw new Error('Expected replacement of the expired owned claim.')
    const replacementCount = await repository.stage(replacementClaim)
    await first.ctx.mysql.execute('UPDATE dsh_search_state SET state_revision=state_revision+1 WHERE store_id=? AND slot_id=? AND lifecycle_id=? AND format_version=?',
      [replacementClaim.cut.storeId, replacementClaim.cut.slotId, replacementClaim.cut.lifecycle, replacementClaim.cut.format])
    await expect(repository.publish(replacementClaim, replacementCount)).rejects.toMatchObject({ reason: 'CAS_CONFLICT' })
    await expire(replacementClaim)
    while (await first.query.rebuildNext()) { /* Drain this new namespace's three jobs only. */ }
    const current = [{ kind: 'surface' as const, values: ['current' as const] }]
    for (const query of ['计划', '审', '😀', 'foo()', 'A B']) {
      const page = await first.query.searchSessions({ query, eventFilters: current })
      expect(page.items.map(item => item.header.id).sort()).toEqual(['alice-a', 'alice-b'])
    }
    expect((await first.query.searchSessions({ query: 'secret-shadowed', eventFilters: current })).items).toEqual([])
    expect((await first.query.searchSessions({ query: 'secret-shadowed', eventFilters: [{ kind: 'surface', values: ['shadowed'] }] })).items).toHaveLength(2)
    const request = { query: '计划', eventFilters: current, limit: 1 }
    const page = await first.query.searchSessions(request)
    expect(page.nextCursor).toBeDefined()
    const next = await first.query.searchSessions({ ...request, cursor: page.nextCursor! })
    expect(new Set([...page.items, ...next.items].map(value => value.header.id)).size).toBe(2)
    authorityRevision = 'login-1:policy-2'
    await expect(first.query.searchSessions({ ...request, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'SESSION_QUERY_STALE_CURSOR' })
    principal = 'bob'; authorityRevision = 'login-2:policy-1'; allowed.clear(); allowed.add(SessionId('bob-private'))
    expect((await first.query.searchSessions({ query: '计划', eventFilters: current })).items.map(value => value.header.id)).toEqual(['bob-private'])
    principal = 'alice'; authorityRevision = 'login-3:policy-1'; allowed.clear(); allowed.add(SessionId('alice-a')); allowed.add(SessionId('alice-b'))
    const old = await first.query.searchSessions(request)
    const reopened = await first.ctx.sessionPersistence.open(SessionId('alice-a'), 'write')
    try { await reopened.append([{ type: 'user/message', seq: SessionSeq(6), time: 999,
      data: createUserMessage({ content: [{ type: 'text', text: '新增恢复计划' }], source: { kind: 'user' } }), surfaceOp: 'append' }]) }
    finally { await reopened.close() }
    await expect(first.query.searchSessions({ query: '计划', eventFilters: current })).rejects.toMatchObject({ reason: 'INDEX_NOT_READY' })
    await expect(first.query.searchSessions({ ...request, cursor: old.nextCursor! })).rejects.toMatchObject({ code: 'SESSION_QUERY_STALE_CURSOR' })
    while (await first.query.rebuildNext()) { /* Complete the new native prefix before fresh-loader queries. */ }
    const nativeBefore = await first.ctx.sessionQuery.readSession(SessionId('alice-a'))
    await first.ctx.fiber.dispose()
    const second = await boot()
    expect((await second.query.searchSessions({ query: '新增恢复计划', eventFilters: current })).items.map(value => value.header.id)).toEqual(['alice-a'])
    expect(await second.ctx.sessionQuery.readSession(SessionId('alice-a'))).toEqual(nativeBefore)
    const reopenedAgain = await second.ctx.sessionPersistence.open(SessionId('alice-a'), 'write')
    try { await reopenedAgain.append([{ type: 'user/message', seq: SessionSeq(7), time: 1000,
      data: createUserMessage({ content: [{ type: 'text', text: '再次追加恢复' }], source: { kind: 'user' } }), surfaceOp: 'append' }]) }
    finally { await reopenedAgain.close() }
    let loseCommit = false
    const sql: MysqlClient = { execute: (text, values, signal) => second.ctx.mysql.execute(text, values, signal),
      transaction: async (work, signal) => {
        const result = await second.ctx.mysql.transaction(work, signal)
        if (loseCommit) { loseCommit = false; throw new MysqlError('transaction_unknown', 'Owned COMMIT acknowledgement dropped after commit.', 'unknown') }
        return result
      } }
    const recovering = new MysqlSearchRepository(sql, storeKey, limits)
    await recovering.initialize()
    const recoveryClaim = await recovering.claim()
    if (!recoveryClaim) throw new Error('Expected post-reload native append job.')
    const recoveryCount = await recovering.stage(recoveryClaim)
    loseCommit = true
    await recovering.publish(recoveryClaim, recoveryCount)
    expect((await second.query.searchSessions({ query: '再次追加', eventFilters: current })).items.map(value => value.header.id)).toEqual(['alice-a'])
    const nativeAfter = await second.ctx.sessionQuery.readSession(SessionId('alice-a'))
    expect(nativeAfter.events.slice(0, nativeBefore.events.length)).toEqual(nativeBefore.events)
    const [after] = await target.connection.execute('SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version')
    expect(after).toEqual(before)
    evidence['schemaReceiptsUnchanged'] = true
    evidence['semanticQueries'] = ['计划', '审', '😀', 'foo()', 'A B']
    evidence['stagingInvisible'] = true; evidence['authorityAndCursorChecks'] = true
    evidence['freshLoaderReadEqual'] = true; evidence['postReloadAppendSearchable'] = true
    evidence['expiredClaimRejected'] = true; evidence['stateCasRejected'] = true; evidence['unknownPublicationReadBack'] = true
    evidence['nativePrefixSha256'] = createHash('sha256').update(JSON.stringify(nativeBefore)).digest('hex')
    evidence['nativeEventCountBefore'] = nativeBefore.events.length; evidence['nativeEventCountAfter'] = nativeAfter.events.length
    evidence['status'] = 'real-database-search-passed; production-access-and-frozen-migration-not-accepted'
    await writeFile(resolve(repo, '.artifacts/parallel-handoff/06/mysql-search-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await target.connection.end()
    for (const home of homes) {
      const actual = await realpath(home)
      if (dirname(actual).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(actual).startsWith('dsh06-search-')) throw new Error('Refusing non-owned search fixture cleanup.')
      await rm(actual, { recursive: true, force: true })
    }
    // The namespace and all its events/builds/receipts remain in the reviewed database.
  }
})

it('checks the current analyzer under the store lock and refuses a changed version in verify mode', async () => {
  const target = await ownedV3Target(repo)
  const home = await mkdtemp(join(tmpdir(), 'dsh06-analyzer-'))
  const ctx = new Context()
  const storeKey = 'agent06-analyzer-' + randomUUID().replaceAll('-', '')
  try {
    const ref = 'DSH_MYSQL_ANALYZER_' + randomUUID().replaceAll('-', '').toUpperCase()
    await ctx.plugin(CredentialsLocal, { dshHome: home, watch: false })
    await ctx.credentials.set(credentialRef(ref), target.password)
    await ctx.plugin(MysqlRuntime, { host: '127.0.0.1', port: 11406, database: target.database, user: target.user,
      passwordRef: ref, schemaMode: 'verify' })
    expect(ctx.mysql.status().version).toBe(3)
    const before = await ctx.mysql.execute('SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version', [])
    await ctx.mysql.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)',
      [storeKey, 'Agent 06 analyzer-only acceptance', JSON.stringify({ ngramTokenSize: 2, stopwords: false, extractorVersion: 1 })])
    const repository = new MysqlSearchRepository(ctx.mysql, storeKey, limits)
    await repository.initialize()
    expect((await repository.snapshot()).cuts).toEqual([])
    await ctx.mysql.execute('UPDATE dsh_stores SET search_analyzer_version=2 WHERE store_key=?', [storeKey])
    await expect(repository.snapshot()).rejects.toMatchObject({ reason: 'UNSUPPORTED_ANALYZER' })
    await ctx.mysql.execute('UPDATE dsh_stores SET search_analyzer_version=1 WHERE store_key=?', [storeKey])
    const after = await ctx.mysql.execute('SELECT schema_version,migration_name,HEX(script_sha256) AS checksum,applied_at FROM dsh_schema_migrations ORDER BY schema_version', [])
    expect(after).toEqual(before)
    await writeFile(resolve(repo, '.artifacts/parallel-handoff/06/mysql-analyzer-evidence.json'), JSON.stringify({
      node: process.version, schemaMode: 'verify', schemaVersion: 3, namespace: storeKey,
      currentAnalyzerCheckedUnderStoreLock: true, changedAnalyzerRefused: true, schemaReceiptsUnchanged: true,
    }, null, 2) + '\n')
  } finally {
    await ctx.fiber.dispose()
    await target.connection.end()
    const actual = await realpath(home)
    if (dirname(actual).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(actual).startsWith('dsh06-analyzer-')) throw new Error('Refusing non-owned analyzer fixture cleanup.')
    await rm(actual, { recursive: true, force: true })
  }
})
