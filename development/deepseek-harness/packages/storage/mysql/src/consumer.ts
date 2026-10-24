/** A registered consumer retains SQL through one idempotent producer/queue drain. */
import { MysqlError } from './error.ts'
import type { MysqlClient, MysqlConsumer, MysqlExecutor, MysqlParameter, MysqlResult } from './types.ts'

/** Connection-owned registration; ordinary public SQL never acquires this shutdown capability. */
export class MysqlConsumerScope implements MysqlConsumer {
  private closing: Promise<void> | undefined
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()
  private readonly drainFailures = new Set<unknown>()

  constructor(private readonly client: MysqlClient, private readonly drain: () => Promise<void>,
    private readonly release: () => void) {}

  /** Whether connection teardown may wait for capacity instead of refusing an already-admitted consumer queue. */
  get isDraining(): boolean { return this.closing !== undefined }
  /** Whether this SQL capability has finished its lifetime. */
  get isClosed(): boolean { return this.closed }

  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new MysqlError('closed', 'The MySQL consumer has finished draining.', 'not-started'))
    const operation = (async () => work())()
    this.pending.add(operation)
    void operation.then(() => { this.pending.delete(operation) }, (error: unknown) => {
      this.pending.delete(operation)
      if (this.closing) this.drainFailures.add(error)
    })
    return operation
  }

  execute(sql: string, values: readonly MysqlParameter[], signal?: AbortSignal): Promise<MysqlResult> {
    return this.track(() => this.client.execute(sql, values, signal))
  }
  transaction<T>(work: (executor: MysqlExecutor) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.track(() => this.client.transaction(work, signal))
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing
    const settled = Promise.withResolvers<void>()
    this.closing = settled.promise
    // The callback fences producer admission synchronously, before another caller can enter.
    const drain = (async () => this.drain())()
    void (async () => {
      const failures = this.drainFailures
      try { await drain } catch (error) { failures.add(error) }
      while (this.pending.size > 0) {
        for (const result of await Promise.allSettled([...this.pending])) {
          if (result.status === 'rejected') { const error: unknown = result.reason; failures.add(error) }
        }
      }
      if (failures.size > 0) throw new AggregateError([...failures], 'MySQL consumer failed to drain; accepted SQL has settled.')
    })().finally(() => { this.closed = true; this.release() }).then(settled.resolve, settled.reject)
    return this.closing
  }
}
