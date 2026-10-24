/** Lifecycle-bound checkpoint adapter; the MySQL consumer owns admitted SQL and producer retirement. */
import type { Context } from '@deepseek-ai/cordis'
import { mysqlConsumerTransaction } from '@deepseek-ai/dsh-mysql'
import type MysqlRuntime from '@deepseek-ai/dsh-mysql'
import type { MysqlConsumer } from '@deepseek-ai/dsh-mysql'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { assertMysqlSessionRepresentable } from '@deepseek-ai/dsh-session-persistence-mysql'
import { captureRecord, policy, ProjectionAdapterError } from './model.ts'
import type { ProjectionAdapterConfig, ProjectionObservation } from './model.ts'
import { completePrefix, currentLog, initializeProjectionStore, readCheckpoint, readHead, replaceCheckpoint } from './sql.ts'
import type { ProjectionWitness } from './sql.ts'

/** One adapter instance is a CAS and uncertainty scope, never an authority for events or projection folding. */
export class MysqlProjectionAdapter {
  private readonly sql: MysqlConsumer
  private readonly witnesses = new WeakMap<ProjectionObservation, ProjectionWitness>()
  private store: string | undefined
  private accepting = true
  private pending = 0
  private tail: Promise<void> = Promise.resolve()
  private readonly failures = new Set<unknown>()
  private uncertain: { readonly error: unknown } | undefined
  private draining: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private retiring: Promise<void> | undefined

  constructor(owner: Pick<MysqlRuntime, 'registerConsumer'>, private readonly config: ProjectionAdapterConfig,
    private readonly drainProducer?: () => Promise<void>) {
    this.sql = owner.registerConsumer(() => this.retire())
  }

  /** Verify only existing namespace/column metadata through the already configured connection owner. */
  async initialize(): Promise<void> {
    this.store = await this.run(() => mysqlConsumerTransaction(this.sql, tx => initializeProjectionStore(tx, this.config)))
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.uncertain) throw this.uncertain.error
    if (!this.accepting) return Promise.reject(new ProjectionAdapterError('closed'))
    if (this.pending >= this.config.maxPendingOperations) return Promise.reject(new ProjectionAdapterError('capacity'))
    this.pending++
    const operation = this.tail.then(async () => {
      if (this.uncertain) throw this.uncertain.error
      try { return await work() }
      catch (error) {
        if (!(error instanceof ProjectionAdapterError)) {
          this.uncertain = { error }
          this.accepting = false
          this.failures.add(error)
        } else if (this.draining) this.failures.add(error)
        throw error
      }
    })
    this.tail = operation.then(() => { this.pending-- }, (_error: unknown) => { this.pending-- })
    return operation
  }

  private storeId(): string {
    if (this.store === undefined) throw new ProjectionAdapterError('closed')
    return this.store
  }

  /** Capture the complete canonical log and original checkpoint CAS before a caller folds any internal states.
   * @param id - External Session identity within the explicitly configured namespace.
   * @returns Read observation accepted only by this adapter's replace method; it cannot be fabricated or transferred.
   */
  async observe(id: SessionId): Promise<ProjectionObservation> {
    assertMysqlSessionRepresentable(id)
    return this.run(async () => {
      const result = await mysqlConsumerTransaction(this.sql, async (tx) => {
        const log = await currentLog(tx, this.storeId(), id, this.config)
        const events = await completePrefix(tx, log, this.config)
        const head = await readHead(tx, log, this.config)
        const checkpoint = await readCheckpoint(tx, log, head, this.config)
        return { log, events, head, checkpoint }
      })
      const observation: ProjectionObservation = Object.freeze({ id, header: Object.freeze({ ...result.log.header }),
        inheritedEventCount: result.log.inheritedEventCount, events: Object.freeze(result.events),
        eventCount: result.log.eventCount, logRevision: result.log.revision,
        cacheRevision: result.head?.revision ?? null, checkpoint: result.checkpoint })
      this.witnesses.set(observation, { log: result.log, revision: observation.cacheRevision })
      return observation
    })
  }

  /** Commit a full snapshot only from this instance's complete source observation, publishing after acknowledgement.
   * @param observation - Exact prior source cut, including empty-prefix or empty-unit snapshots.
   * @param input - Full native identity and internal rows; old keys missing here are deleted atomically.
   * @returns Exact new checkpoint CAS; no retry or write-after-unknown is issued.
   */
  async replace(observation: ProjectionObservation, input: unknown): Promise<string> {
    const witness = this.witnesses.get(observation)
    if (!witness) throw new ProjectionAdapterError('identity-mismatch')
    const captured = captureRecord(input, witness.log, this.config)
    return this.run(() => mysqlConsumerTransaction(this.sql, tx => replaceCheckpoint(tx, this.storeId(), witness, captured, this.config)))
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining
    this.accepting = false
    this.draining = (async () => {
      await this.tail
      if (this.failures.size > 0) throw new AggregateError([...this.failures], 'Projection checkpoint operations failed after draining.')
    })()
    return this.draining
  }

  private retire(): Promise<void> {
    if (this.retiring) return this.retiring
    const settled = Promise.withResolvers<void>()
    this.retiring = settled.promise
    void (async () => {
      const failures: unknown[] = []
      try { await this.drainProducer?.() } catch (error) { failures.push(error) }
      try { await this.drain() } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'Projection producers and SQL queue finished with failures.')
    })().then(settled.resolve, settled.reject)
    return this.retiring
  }

  /** Fence admission, settle already accepted queues, then release this one consumer without a drain/dispose cycle. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    const drain = this.retire()
    this.closing = (async () => {
      const failures = new Set<unknown>()
      try { await drain } catch (error) { failures.add(error) }
      try { await this.sql.dispose() } catch (error) { failures.add(error) }
      if (failures.size > 0) throw new AggregateError([...failures], 'Projection checkpoint consumer closed after settling failures.')
    })()
    return this.closing
  }
}

/** Construct one optional unrouted adapter and register its actual effect owner; never create stores or change schema.
 * @param ctx - Future plugin context that owns shutdown.
 * @param owner - Activated existing kernel with a reviewed schema.
 * @param input - Explicit namespace and complete resource limits.
 * @returns Verified adapter only after its fixed read-only metadata checks acknowledge.
 */
export async function createProjectionMysqlAdapter(ctx: Pick<Context, 'effect'>,
  owner: Pick<MysqlRuntime, 'registerConsumer' | 'status'>, input: ProjectionAdapterConfig,
  drainProducer?: () => Promise<void>): Promise<MysqlProjectionAdapter> {
  const config = policy(input)
  if (owner.status().version !== 3) throw new ProjectionAdapterError('configuration')
  const adapter = new MysqlProjectionAdapter(owner, config, drainProducer)
  try {
    await adapter.initialize()
    ctx.effect(() => () => adapter.close(), 'mysql.projection-checkpoints()')
    return adapter
  } catch (error) {
    try { await adapter.close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Projection initialization and cleanup failed.') }
    throw error
  }
}
