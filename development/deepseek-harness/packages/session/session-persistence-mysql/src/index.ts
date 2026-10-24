/** Optional MySQL Session provider; composition alone selects it instead of JSONL. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import type {} from '@deepseek-ai/dsh-mysql'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence, SessionPersistenceRevision, SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle, SessionPersistenceCreateOptions, SessionPersistenceOpenOptions,
  SessionPersistenceSnapshot, SessionPersistenceStatOptions, SessionPersistenceListOptions } from '@deepseek-ai/dsh-session-persistence'
import { creationHeader } from './records.ts'
import { MysqlSessionRepository } from './repository.ts'
import { MysqlSessionHandle } from './handle.ts'
import type { HandleOwner } from './handle.ts'
import type { LogIdentity, StoredLog, WriterIdentity } from './types.ts'
import type { MysqlSessionWriterOwnership } from './writer-ownership.ts'
export { hasMysqlSessionWriterOwnership } from './writer-ownership.ts'
export type { MysqlSessionWriterOwnership } from './writer-ownership.ts'

export { assertRepresentable as assertMysqlSessionRepresentable, binaryId as mysqlSessionBinaryId,
  count as mysqlSessionCount, decodeEvent as decodeMysqlSessionEvent, decodeLog as decodeMysqlSessionLog,
  rows as mysqlSessionRows, slotId as mysqlSessionSlotId, storeId as mysqlSessionStoreId,
  text as mysqlSessionText, validatePrefix as validateMysqlSessionPrefix } from './records.ts'
export type { StoredLog as MysqlStoredSessionLog, LogIdentity as MysqlSessionLogIdentity,
  WriterIdentity as MysqlSessionWriterIdentity, FrozenBatch as MysqlFrozenSessionBatch } from './types.ts'
export { observeMysqlSessionCut } from './observation.ts'
export type { MysqlSessionObservationPolicy, MysqlSessionCut } from './observation.ts'

/** A pre-provisioned R7 store and its Session writer resource settings. */
export interface Config {
  /** Existing administrator-provisioned dsh_stores.store_key; never an ambient namespace. */
  storeKey: string
  /** Database-clock lease duration; failed renewal permanently fences the handle. */
  leaseTtlMs: number
  /** Heartbeat cadence; must leave at least one further interval before lease expiry. */
  heartbeatIntervalMs: number
  /** Maximum intentional delay before a live event batch starts writing. */
  batchDelayMs: number
  /** Maximum events fetched per seq-range page; reads still return the requested complete slice. */
  readPageSize: number
}

/** Deployment settings; relational timer validation runs before any Session work. */
export const Config: z<Partial<Config>, Config> = z.object({
  storeKey: z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).required(),
  leaseTtlMs: z.number().step(1).min(1000).max(600000).default(30000),
  heartbeatIntervalMs: z.number().step(1).min(100).max(300000).default(10000),
  batchDelayMs: z.number().step(1).min(0).max(60000).default(200),
  readPageSize: z.number().step(1).min(1).max(10000).default(1000),
})

/** Session handles over one explicitly selected R7 namespace, with no automatic import or backend switch. */
export default class MysqlSessionPersistence extends SessionPersistence implements MysqlSessionWriterOwnership {
  static inject = ['mysql']
  static Config = Config
  override readonly name = 'session-persistence-mysql'
  private readonly repository: MysqlSessionRepository
  private readonly handles = new Set<MysqlSessionHandle>()
  private readonly writers = new Map<SessionId, MysqlSessionHandle | null>()
  private readonly admissions = new Set<Promise<SessionHandle>>()
  private stopping = false
  private closing: Promise<void> | undefined
  private readonly owner: HandleOwner

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    if (config.heartbeatIntervalMs * 2 >= config.leaseTtlMs) {
      throw new MysqlError('configuration', 'MySQL Session heartbeatIntervalMs must be less than half leaseTtlMs.', 'not-started')
    }
    const sql = ctx.mysql.registerConsumer(() => this.stop())
    this.repository = new MysqlSessionRepository(sql, config)
    this.owner = { repository: this.repository, config,
      pending: identity => this.pending(identity), closed: (handle) => { this.closed(handle) },
      report: (error) => { ctx.logger.warn('MySQL Session persistence stopped a background write or renewal:', error) },
    }
    const writers = this.writers
    const owner = this.owner
    ctx.effect(function* () {
      const remove = [
        ctx.on('session/event', (session: Session, event) => { writers.get(session.id)?.enqueueLive(event) }),
        ctx.on('session/flush', (session: Session) => writers.get(session.id)?.flush()),
        ctx.on('session/disposed', (session: Session) => {
          void writers.get(session.id)?.close().catch((error: unknown) => { owner.report(error) })
        }),
      ]
      yield* remove
      yield async () => {
        try { await sql.dispose() }
        finally { for (const dispose of remove) dispose() }
      }
    }, 'mysql.sessions.live-routing-and-drain')
  }

  private stop(): Promise<void> {
    if (this.closing) return this.closing
    const settled = Promise.withResolvers<void>()
    this.closing = settled.promise
    this.stopping = true
    const result = Promise.allSettled([...this.handles].map(handle => handle.retire()))
    void (async () => {
      const failures: unknown[] = []
      for (const item of await Promise.allSettled([...this.admissions])) {
        if (item.status === 'rejected' && !(item.reason instanceof SessionHandleClosedError)) {
          const failure: unknown = item.reason; failures.push(failure)
        }
      }
      for (const item of await result) {
        if (item.status === 'rejected') { const failure: unknown = item.reason; failures.push(failure) }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'MySQL Session provider could not drain all handles.')
    })().then(settled.resolve, settled.reject)
    return this.closing
  }

  protected async [Service.init](): Promise<void> { await this.repository.initialize() }

  private assertActive(): void {
    if (this.stopping) throw new MysqlError('closed', 'The MySQL Session provider is unloading.', 'not-started')
  }

  /** Configured namespace; remains readable during unload and does not establish database lease validity. */
  get mysqlStoreKey(): string { return this.config.storeKey }

  /** Synchronously match a database-observed writer against this instance's exact live handle.
   * @param writer - Borrowed identity checked under the caller's store lock after an external flush barrier.
   * @returns False for unloading, unknown admissions, foreign owners, closed, failed or retired handles.
   * The caller must separately verify the database lease is active and unexpired; no SQL or flush occurs here.
   */
  ownsMysqlWriter(writer: WriterIdentity): boolean {
    return !this.stopping && (this.writers.get(writer.id)?.ownsWriter(writer) ?? false)
  }
  private pending(identity: LogIdentity): boolean {
    const writer = this.writers.get(identity.id)
    return !!writer && !writer.isMaterialized && writer.identity.lifecycle.equals(identity.lifecycle)
  }
  private closed(handle: MysqlSessionHandle): void {
    this.handles.delete(handle)
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
  }
  private track(task: Promise<SessionHandle>): Promise<SessionHandle> {
    this.admissions.add(task)
    void task.then(() => { this.admissions.delete(task) }, () => { this.admissions.delete(task) })
    return task
  }
  private async adopt(handle: MysqlSessionHandle): Promise<SessionHandle> {
    if (this.stopping) { await handle.close(); throw new SessionHandleClosedError(handle.id, 'open') }
    this.handles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle)
    return handle
  }

  /** Reserve a new pending identity and write lease; publication waits for append or an explicit empty flush.
   * @param header - Immutable native metadata; optional fields preserve absence.
   * @param options - Cancellation before work and exact fork cut.
   * @returns Caller-owned write handle.
   */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    this.assertActive()
    options?.signal?.throwIfAborted()
    const snapshot = Object.freeze(creationHeader(header))
    const inherited = SessionLogOffset(options?.inheritedEventCount ?? 0)
    if ((snapshot.isSeeded && options?.inheritedEventCount === undefined) || (!snapshot.isSeeded && inherited !== 0)) {
      throw new TypeError('Seeded creation requires an exact inherited cut; unseeded creation requires zero.')
    }
    if (this.writers.has(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
    this.writers.set(snapshot.id, null)
    return this.track((async () => {
      try {
        const created = await this.repository.create(snapshot)
        const handle = new MysqlSessionHandle(this.owner, created.writer, snapshot, inherited, 'write', false,
          created.writer, created.parentSlot)
        if (options?.signal?.aborted) { await handle.close(); options.signal.throwIfAborted() }
        return await this.adopt(handle)
      } catch (error) {
        if (this.writers.get(snapshot.id) === null) this.writers.delete(snapshot.id)
        throw error
      }
    })())
  }

  /** Open the current generation, preserving read/write ownership and native failure types.
   * @param id - Original external Session id.
   * @param access - Read-only observation or exclusive writer.
   * @param options - Cancellation before work.
   * @returns A fixed-generation handle.
   */
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    this.assertActive()
    options?.signal?.throwIfAborted()
    const local = this.writers.get(id)
    if (access === 'write' && this.writers.has(id)) throw new SessionAlreadyOwnedError(id)
    if (access === 'read' && local && !local.isMaterialized) {
      return this.adopt(new MysqlSessionHandle(this.owner, local.identity, local.header, local.inheritedEventCount, 'read', false))
    }
    if (access === 'write') this.writers.set(id, null)
    return this.track((async () => {
      try {
        const opened = await this.repository.open(id, access === 'write')
        const handle = new MysqlSessionHandle(this.owner, opened.log, Object.freeze(opened.log.header), opened.log.inheritedEventCount,
          access, true, opened.writer)
        if (options?.signal?.aborted) { await handle.close(); options.signal.throwIfAborted() }
        return await this.adopt(handle)
      } catch (error) {
        if (access === 'write' && this.writers.get(id) === null) this.writers.delete(id)
        throw error
      }
    })())
  }

  /** @returns A barrier over writers present at the call; failures remain observable and other writers still flush. */
  async flush(): Promise<void> {
    this.assertActive()
    const failures: unknown[] = []
    for (const handle of [...this.writers.values()]) {
      if (!handle) continue
      try { await handle.flush() }
      catch (error) {
        if (error instanceof SessionHandleClosedError) {
          try { await handle.close() } catch (closeError) { failures.push(closeError) }
        } else failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'MySQL Session flush failed.')
  }

  private snapshot(log: StoredLog): SessionPersistenceSnapshot {
    return { header: structuredClone(log.header), formatStatus: 'current', eventCount: log.eventCount,
      revision: SessionPersistenceRevision([log.storeId, log.slotId, log.lifecycle.toString('hex'), log.version, log.revision].join(':')) }
  }
  private pendingSnapshot(handle: MysqlSessionHandle): SessionPersistenceSnapshot {
    return { header: structuredClone(handle.header), eventCount: 0,
      revision: SessionPersistenceRevision('pending:' + handle.identity.lifecycle.toString('hex')) }
  }

  /** @param id - External identity. @param options - Cancellation for metadata observation.
   * @returns Current header and revision, or undefined; lease churn never changes its revision.
   */
  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    this.assertActive()
    options?.signal?.throwIfAborted()
    const pending = this.writers.get(id)
    if (pending && !pending.isMaterialized) return this.pendingSnapshot(pending)
    const log = await this.repository.stat(id)
    options?.signal?.throwIfAborted()
    return log ? this.snapshot(log) : undefined
  }

  /** @param options - Cancellation for listing.
   * @returns Published snapshots plus this instance's pending creators, in no promised order.
   */
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    this.assertActive()
    options?.signal?.throwIfAborted()
    const pending = [...this.writers.values()].filter(handle => handle && !handle.isMaterialized)
    const stored = await this.repository.list()
    options?.signal?.throwIfAborted()
    const result = stored.map(log => this.snapshot(log))
    const ids = new Set(stored.map(log => log.id))
    for (const handle of pending) if (handle && !ids.has(handle.id)) result.push(this.pendingSnapshot(handle))
    return result
  }
}
