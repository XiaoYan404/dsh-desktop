/** A generation-bound handle owns its mutation chain, heartbeat and fixed uncertain batch. */
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionHandleClosedError, SessionOwnershipLostError, SessionPersistenceNotFoundError, SessionReadOnlyError,
  SessionPersistenceCorruptionError,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle, SessionHandleReadResult, SessionHandleReadOptions,
  SessionHandleAppendOptions, SessionHandleFlushOptions } from '@deepseek-ai/dsh-session-persistence'
import type { Config } from './index.ts'
import type { FrozenBatch, LogIdentity, SlotId, WriterIdentity } from './types.ts'
import { freezeBatch } from './records.ts'
import type { MysqlSessionRepository } from './repository.ts'

/** Provider-owned capabilities do not expose its mutable handle registries. */
export interface HandleOwner {
  readonly repository: MysqlSessionRepository
  readonly config: Config
  /** @param identity - Fixed pending lifecycle. @returns Whether its local creator remains unpublished. */
  pending(identity: LogIdentity): boolean
  /** @param handle - Settled handle to remove from provider ownership. */
  closed(handle: MysqlSessionHandle): void
  /** @param error - Native or sanitized failure from a background writer. */
  report(error: unknown): void
}

/** One MySQL Session handle; callers close it before unloading the shared connection owner. */
export class MysqlSessionHandle implements SessionHandle {
  private chain: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private retiring: Promise<void> | undefined
  private readonly producers = new Set<() => Promise<void>>()
  private lost = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setTimeout> | undefined
  private paused = false
  private buffered: SessionEvent[] = []
  private batch: FrozenBatch | undefined
  private observedLength = 0
  private materialized: boolean
  private failure: { readonly error: unknown } | undefined
  private routingFailureReported = false

  constructor(private readonly owner: HandleOwner, readonly identity: LogIdentity,
    readonly header: SessionHeader, readonly inheritedEventCount: SessionLogOffset, readonly access: SessionAccess,
    materialized: boolean, readonly writer?: WriterIdentity, private readonly parentSlot: SlotId | null = null) {
    this.materialized = materialized
    this.armHeartbeat()
  }

  /** External Session identity remains unchanged. */
  get id(): SessionId { return this.identity.id }
  /** Whether this creator has published a committed log. */
  get isMaterialized(): boolean { return this.materialized }

  /** Match only this live local writer; the caller must independently lock and verify its database lease.
   * @param expected - Borrowed database-observed identity; no reference is retained.
   * @returns Exact ownership, including unpublished creators, until close, retirement or failure starts.
   */
  ownsWriter(expected: WriterIdentity): boolean {
    const writer = this.writer
    return this.access === 'write' && writer !== undefined && !this.closing && !this.retiring && !this.lost && !this.failure
      && writer.id === expected.id && writer.storeId === expected.storeId && writer.slotId === expected.slotId
      && writer.version === expected.version && writer.lifecycle.equals(expected.lifecycle)
      && writer.owner.equals(expected.owner) && writer.fence === expected.fence
  }

  beforeBackendClose(drain: () => Promise<void>): () => void {
    this.assertOpen('bind producer')
    if (this.retiring) throw new SessionHandleClosedError(this.id, 'bind producer')
    this.assertWriter('bind producer')
    this.producers.add(drain)
    return () => { this.producers.delete(drain) }
  }

  /** Stop exact bound producers before storage close; ordinary close remains an independent, joinable task.
   * @returns One backend retirement, retaining every producer and close failure.
   */
  retire(): Promise<void> {
    if (this.retiring) return this.retiring
    this.retiring = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      for (const result of await Promise.allSettled([...this.producers].map(async drain => drain()))) {
        if (result.status === 'rejected') { const error: unknown = result.reason; failures.push(error) }
      }
      try { await this.close() } catch (error) { failures.push(error) }
      finally { this.producers.clear() }
      if (failures.length > 0) throw new AggregateError(failures, 'MySQL Session backend retirement failed after producer and handle drain.')
    })
    return this.retiring
  }

  private assertOpen(operation: string): void {
    if (this.failure) throw this.failure.error
    if (this.closing) throw new SessionHandleClosedError(this.id, operation)
  }
  private assertWriter(operation: string): WriterIdentity {
    if (this.failure) throw this.failure.error
    if (!this.writer) throw new SessionReadOnlyError(this.id, operation)
    if (this.lost) throw new SessionOwnershipLostError(this.id)
    return this.writer
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const operation = this.chain.then(work)
    this.chain = operation.then(() => undefined, () => undefined)
    return operation
  }
  private armHeartbeat(): void {
    if (!this.writer || this.closing || this.lost) return
    this.heartbeat = setTimeout(() => {
      this.heartbeat = undefined
      void this.enqueue(async () => {
        const writer = this.assertWriter('renew')
        await this.owner.repository.renew(writer, !this.materialized)
      }).then(() => { this.armHeartbeat() }, (error: unknown) => {
        this.lost = true
        this.owner.report(error)
      })
    }, this.owner.config.heartbeatIntervalMs)
    this.heartbeat.unref()
  }

  /** Read an owned event slice from this original generation.
   * @param offset - First seq, default zero.
   * @param length - Maximum number of events, default the rest.
   * @param options - Cancellation checked before and after the storage read.
   * @returns Detached event values and caller-owned outer array.
   */
  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new TypeError('Session read offset and length must be non-negative safe integers.')
    }
    options?.signal?.throwIfAborted()
    try {
      const result = await this.owner.repository.read(this.identity)
      options?.signal?.throwIfAborted()
      if (result.events.length < this.observedLength) throw new Error('The Session log shrank below this handle\'s observed prefix.')
      this.observedLength = result.events.length
      this.materialized = true
      return { eventState: 'detached', events: result.events.slice(offset, offset + length) }
    } catch (error) {
      if (error instanceof SessionPersistenceCorruptionError) this.failure ??= { error }
      if (error instanceof SessionPersistenceNotFoundError && this.owner.pending(this.identity)) {
        return { eventState: 'detached', events: [] }
      }
      throw error
    }
  }

  /** Append a detached batch once; an uncertain prior batch keeps its original receipt identity.
   * @param events - Contiguous native events, snapshotted before queueing.
   * @param options - Cancellation observed before the mutation starts.
   */
  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    if (this.retiring) throw new SessionHandleClosedError(this.id, 'append')
    this.assertWriter('append')
    const batch = freezeBatch(events)
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      this.assertWriter('append')
      if (!batch) return
      if (this.batch && this.batch.firstSeq === batch.firstSeq) {
        if (!this.batch.sha256.equals(batch.sha256)) throw new TypeError('A pending Session batch cannot be retried with different events.')
        await this.persistPending()
        return
      }
      await this.drainBuffered()
      this.batch = batch
      await this.persistPending()
    })
  }

  private async persistPending(): Promise<void> {
    const batch = this.batch
    if (!batch) return
    const writer = this.assertWriter('append')
    try {
      const receipt = await this.owner.repository.append(writer, this.header, this.inheritedEventCount, this.parentSlot, batch)
      this.observedLength = Math.max(this.observedLength, receipt.eventCount)
      this.materialized = true
      this.batch = undefined
    } catch (error) {
      if (error instanceof SessionPersistenceCorruptionError) this.failure ??= { error }
      if (error instanceof SessionOwnershipLostError) { this.lost = true; this.batch = undefined }
      if (!(error instanceof MysqlError) && !(error instanceof SessionOwnershipLostError)) this.batch = undefined
      throw error
    }
  }

  /** Route one published event into this handle's bounded batching window.
   * @param event - Native event; copied before the producer can continue.
   */
  enqueueLive(event: SessionEvent): void {
    if (this.failure || this.closing || this.lost) {
      if (this.routingFailureReported) return
      this.routingFailureReported = true
      this.owner.report(this.failure ? this.failure.error
        : this.lost ? new SessionOwnershipLostError(this.id) : new SessionHandleClosedError(this.id, 'route'))
      return
    }
    const prepared = freezeBatch([event])
    if (!prepared?.events[0]) return
    this.buffered.push(prepared.events[0])
    if (this.timer || this.paused) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.enqueue(() => this.drainBuffered()).catch((error: unknown) => {
        this.paused = true
        this.owner.report(error)
      })
    }, this.owner.config.batchDelayMs)
    this.timer.unref()
  }

  private stopBatchTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
  private async drainBuffered(): Promise<void> {
    this.stopBatchTimer()
    this.paused = false
    await this.persistPending()
    while (this.buffered.length > 0) {
      const events = this.buffered.splice(0)
      this.batch = freezeBatch(events)
      try { await this.persistPending() }
      catch (error) {
        if (!this.batch) this.buffered = events.concat(this.buffered)
        this.paused = true
        throw error
      }
    }
  }

  /** Drain all admitted writes and publish a legitimately empty unseeded creator.
   * @param options - Cancellation observed before the barrier starts.
   */
  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    this.assertWriter('flush')
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      const writer = this.assertWriter('flush')
      await this.drainBuffered()
      if (!this.materialized) {
        await this.owner.repository.materializeEmpty(writer, this.header, this.parentSlot)
        this.materialized = true
      }
    })
  }

  /** Drain admitted work and conditionally release only this owner; repeated close joins the same uncancellable task.
   * @returns Settlement after release and local registry cleanup, including any drain or release failures.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopBatchTimer()
    if (this.heartbeat) clearTimeout(this.heartbeat)
    this.heartbeat = undefined
    this.closing = this.enqueue(async () => {
      const failures: unknown[] = []
      try {
        if (this.writer) await this.drainBuffered()
        if (this.failure) throw this.failure.error
      }
      catch (error) { failures.push(error) }
      try { if (this.writer) await this.owner.repository.release(this.writer) }
      catch (error) { failures.push(error) }
      finally { this.owner.closed(this) }
      if (failures.length > 1) throw new AggregateError(failures, 'MySQL Session close failed to drain and release its lease.')
      if (failures.length === 1) throw failures[0]
    })
    return this.closing
  }

  /** @returns The same uncancellable close task. */
  [Symbol.asyncDispose](): Promise<void> { return this.close() }
}
