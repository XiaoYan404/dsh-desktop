/** Opt-in MySQL implementation of the existing SessionQuery service. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-mysql'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import type { Config as QueryConfig, SessionSearchRequest, SessionEventSearchRequest, SessionSearchExecContext } from '@deepseek-ai/dsh-session-query'
import { MysqlSearchError } from './error.ts'
import { MysqlSearchRepository } from './repository.ts'
import { MysqlSearchQueries } from './query.ts'
import { requireMysqlSearchPersistence } from './binding.ts'
import { bindMysqlSearchAccess } from './access.ts'
import type { MysqlSearchAccess, SearchLimits } from './types.ts'

export { MysqlSearchError } from './error.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { sessionQueryMysqlAccess: MysqlSearchAccess }
}

/** Administrator-provisioned namespace, resource budgets and inherited read configuration. */
export interface Config extends SearchLimits, QueryConfig {
  /**
   * Existing MySQL namespace, shared with the active session persistence: 1–128 ASCII letters,
   * digits, underscores, periods, colons or hyphens, starting with a letter or digit.
   * A missing namespace rejects initialization; this provider never provisions or imports it.
   */
  storeKey: string
}

/** Uses the shared exact reader and semantics; mounting never imports or switches historical data. */
export default class MysqlSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions', 'sessionPersistence', 'mysql', 'sessionQueryMysqlAccess']
  static Config: z<Config> = z.object({
    storeKey: z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).required(),
    pageSize: z.number().step(1).min(1).max(1000).required(),
    claimTtlMs: z.number().step(1).min(1000).max(600000).required(),
    maxDocumentBytes: z.number().step(1).min(1).required(), maxBuildBytes: z.number().step(1).min(1).required(),
    maxDocuments: z.number().step(1).min(1).required(), maxCandidates: z.number().step(1).min(1).required(),
    maxCandidateBytes: z.number().step(1).min(1).required(), defaultLimit: z.number().step(1).min(1).required(),
    maxLimit: z.number().step(1).min(1).required(), snippetChars: z.number().step(1).min(1).required(),
    readWindowMax: z.number().step(1).min(0), persistedReadConcurrency: z.number().step(1).min(1),
    preparedSessionCacheSize: z.number().step(1).min(1),
  })
  private readonly repository: MysqlSearchRepository
  private readonly queries: MysqlSearchQueries
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private stopping = false

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const persistence = requireMysqlSearchPersistence(ctx.get('sessionPersistence'), config.storeKey)
    if (config.defaultLimit > config.maxLimit) throw new MysqlSearchError('CAPACITY')
    const sql = ctx.mysql.registerConsumer(async () => {
      this.stopping = true
      this.lifetime.abort()
      await Promise.allSettled([...this.pending])
    })
    this.repository = new MysqlSearchRepository(sql, config.storeKey, config)
    this.queries = new MysqlSearchQueries(this.repository,
      bindMysqlSearchAccess(persistence, ctx.sessionQueryMysqlAccess, this.repository), config)
    ctx.effect(() => () => sql.dispose(), 'mysql.search.drain')
  }

  protected async [Service.init](): Promise<void> { await this.repository.initialize() }

  private track<T>(work: (signal: AbortSignal) => Promise<T>, exec?: SessionSearchExecContext): Promise<T> {
    if (this.stopping) return Promise.reject(new MysqlSearchError('ACCESS_UNAVAILABLE'))
    const signal = exec?.signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, exec.signal])
    const task = work(signal)
    this.pending.add(task)
    void task.then(() => { this.pending.delete(task) }, () => { this.pending.delete(task) })
    return task
  }

  override searchSessions(request: SessionSearchRequest, exec?: SessionSearchExecContext) : Promise<import('@deepseek-ai/dsh-session-query').SessionSearchPage<import('@deepseek-ai/dsh-session-query').SessionSearchHit>> {
    return this.track(signal => this.queries.sessions(request, signal), exec)
  }
  override searchEvents(request: SessionEventSearchRequest, exec?: SessionSearchExecContext) : Promise<import('@deepseek-ai/dsh-session-query').SessionEventSearchPage> {
    return this.track(signal => this.queries.events(request, signal), exec)
  }

  /**
   * Process one queued build; failures retain staging and the expiring claim for diagnosis/retry.
   * @param exec - Optional worker cancellation.
   * @returns False only when no current job can be claimed.
   */
  rebuildNext(exec?: SessionSearchExecContext): Promise<boolean> {
    return this.track(async (signal) => {
      const claim = await this.repository.claim(signal)
      if (!claim) return false
      const count = await this.repository.stage(claim, signal)
      await this.repository.publish(claim, count, signal)
      return true
    }, exec)
  }
}
