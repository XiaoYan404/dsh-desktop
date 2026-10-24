/** Fenced Workspace KV provider; ACK publishes one image and retirement drains its real producers. */
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { mysqlConsumerTransaction } from '@deepseek-ai/dsh-mysql'
import type MysqlRuntime from '@deepseek-ai/dsh-mysql'
import type { MysqlConsumer } from '@deepseek-ai/dsh-mysql'
import { StorageError, StorageMutationValidationError } from '@deepseek-ai/dsh-storage'
import type { KvAtomicMutation, KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { planMutation, projectImage, WorkspaceAdapterError } from './model.ts'
import type { WorkspaceAdapterConfig, WorkspaceImage, WorkspaceLease, WorkspacePlan } from './model.ts'
import type Storage from '@deepseek-ai/dsh-storage'
import { acquireWorkspace, assertWorkspaceOwner, commitWorkspaceImage, readWorkspaceImage, workspaceSql } from './sql.ts'
import { createWorkspaceRetirement } from './retirement.ts'
import type { WorkspaceRetirement } from './retirement.ts'

function closed(): StorageError { return new StorageError('closed', 'The staged Workspace unit has finished admitting operations.') }

function failTogether(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

class WorkspaceUnit implements KvUnit {
  private accepting = true
  private failure: { readonly error: unknown } | undefined
  private tail: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private heartbeat: ReturnType<typeof setTimeout> | undefined
  private validUntil: number
  private finished = false

  constructor(private readonly sql: MysqlConsumer, private readonly config: WorkspaceAdapterConfig,
    private image: WorkspaceImage, private readonly lease: WorkspaceLease, validUntil: number,
    private readonly release: () => void, private readonly reportFrozen: () => void) {
    this.validUntil = validUntil
    this.armHeartbeat()
  }

  stopAdmission(): void { this.accepting = false }

  private freeze(error: unknown): void {
    if (this.failure) return
    this.failure = { error }
    if (this.heartbeat) clearTimeout(this.heartbeat)
    this.heartbeat = undefined
    this.reportFrozen()
  }

  private check(): void {
    if (!this.accepting) throw closed()
    if (this.failure) throw this.failure.error
  }

  assertReadable(): void {
    if (this.failure) throw this.failure.error
    if (this.finished) throw closed()
    if (performance.now() >= this.validUntil) {
      const error = new WorkspaceAdapterError('ownership-lost')
      this.freeze(error)
      throw error
    }
  }

  private armHeartbeat(): void {
    if (this.closing || this.failure) return
    this.heartbeat = setTimeout(() => {
      this.heartbeat = undefined
      const operation = this.tail.then(async () => {
        this.assertReadable()
        const started = performance.now()
        try {
          await mysqlConsumerTransaction(this.sql, async (tx) => {
            await assertWorkspaceOwner(tx, this.config.storeKey, this.lease)
            const result = await tx.execute(workspaceSql.renew,
              [this.config.leaseTtlMs * 1000, this.config.storeKey, this.lease.owner, this.lease.fence])
            if (result.kind !== 'write' || result.affectedRows !== 1) throw new WorkspaceAdapterError('ownership-lost')
          })
          this.validUntil = started + this.config.leaseTtlMs
        } catch (error) { this.freeze(error); throw error }
      })
      this.tail = operation.then(() => { this.armHeartbeat() }, (_error: unknown) => undefined)
    }, this.config.heartbeatIntervalMs)
    this.heartbeat.unref()
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.check()
    this.assertReadable()
    return Promise.resolve(projectImage(this.image))
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    return this.commitAtomic({ records: [{ operation: 'put', table, key, value }] })
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.commitAtomic({ records: [{ operation: 'delete', table, key }] })
  }

  setGlobal(value: unknown): Promise<void> { return this.commitAtomic({ records: [], global: { value } }) }

  async commitAtomic(mutation: KvAtomicMutation): Promise<void> {
    this.check()
    // Capture at admission, before the write chain yields to a caller that still owns its input objects.
    let captured: { readonly value: KvAtomicMutation } | { readonly error: unknown }
    try { captured = { value: structuredClone(mutation) } } catch (error) { captured = { error } }
    const operation = this.tail.then(async () => {
      if (this.failure) throw this.failure.error
      if ('error' in captured) throw new StorageMutationValidationError(captured.error)
      this.assertReadable()
      let plan: WorkspacePlan
      try { plan = planMutation(this.image, captured.value) }
      catch (error) { throw new StorageMutationValidationError(error) }
      if (plan.touched.size === 0 && captured.value.global === undefined) return
      try {
        const next = await mysqlConsumerTransaction(this.sql,
          tx => commitWorkspaceImage(tx, this.config.storeKey, this.image, plan, this.lease))
        this.image = next
      } catch (error) {
        this.freeze(error)
        throw error
      }
    })
    // The barrier alone consumes rejection. The operation, close and scope drain retain the original failure.
    this.tail = operation.then(() => undefined, (_error: unknown) => undefined)
    return operation
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopAdmission()
    if (this.heartbeat) clearTimeout(this.heartbeat)
    this.heartbeat = undefined
    this.closing = (async () => {
      try {
        await this.tail
        const errors: unknown[] = this.failure ? [this.failure.error] : []
        try { await mysqlConsumerTransaction(this.sql, async (tx) => {
          await tx.execute(workspaceSql.store, [this.config.storeKey])
          await tx.execute(workspaceSql.release, [this.config.storeKey, this.lease.owner, this.lease.fence])
        }) } catch (error) { errors.push(error) }
        failTogether(errors, 'Workspace close retained an ownership or SQL failure.')
      } finally { this.finished = true; this.release() }
    })()
    return this.closing
  }
}

class WorkspaceBackend implements StorageBackend {
  readonly kv: KvFacet = { open: descriptor => this.open(descriptor) }
  private readonly sql: MysqlConsumer
  private readonly reservations = new Map<string, Promise<WorkspaceUnit>>()
  private readonly units = new Set<WorkspaceUnit>()
  private accepting = true
  private draining: Promise<void> | undefined
  private readonly retirement: WorkspaceRetirement

  constructor(owner: Pick<MysqlRuntime, 'registerConsumer'>, private readonly config: WorkspaceAdapterConfig,
    storage: Pick<Storage, 'closeBackend'>, backendName: string, unregister: () => void,
    private readonly reportFrozen: () => void) {
    this.sql = owner.registerConsumer(() => this.retirement.retire())
    this.retirement = createWorkspaceRetirement(storage, backendName, {
      stopOpening: () => { this.accepting = false },
      closeUnits: async () => { try { await this.drain() } finally { unregister() } },
      disposeScope: () => this.sql.dispose(),
    })
  }

  private open(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (!this.accepting) return Promise.reject(closed())
    if (descriptor.name !== 'workspace' || descriptor.version !== 2 || !descriptor.hasGlobal
      || descriptor.tables.length !== 1 || descriptor.tables[0] !== 'workspaces'
      || (descriptor.layout !== undefined && descriptor.layout !== 'single')
      || (descriptor.compatibleVersions !== undefined && descriptor.compatibleVersions.length > 0)) {
      return Promise.reject(new WorkspaceAdapterError('unsupported-unit'))
    }
    if (this.reservations.has(descriptor.name)) {
      return Promise.reject(new WorkspaceAdapterError('unsupported-unit'))
    }
    const started = performance.now()
    const opening = mysqlConsumerTransaction(this.sql, async (tx) => {
      const lease = await acquireWorkspace(tx, this.config.storeKey, randomBytes(16), this.config.leaseTtlMs)
      return { lease, image: await readWorkspaceImage(tx, this.config.storeKey) }
    }).then(({ lease, image }) => {
      const unit = new WorkspaceUnit(this.sql, this.config, image, lease, started + this.config.leaseTtlMs, () => {
        this.reservations.delete(descriptor.name)
        this.units.delete(unit)
      }, this.reportFrozen)
      this.units.add(unit)
      if (!this.accepting) unit.stopAdmission()
      return unit
    })
    this.reservations.set(descriptor.name, opening)
    void opening.catch((_error: unknown) => {
      // An unsuccessful open owns no unit; its returned promise remains rejected for the caller.
      this.reservations.delete(descriptor.name)
    })
    return opening
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining
    // Synchronous admission fence; already accepted opens and unit queues still own the scoped SQL.
    this.accepting = false
    for (const unit of this.units) unit.stopAdmission()
    const openings = [...this.reservations.values()]
    this.draining = (async () => {
      const failures: unknown[] = []
      const opened = await Promise.allSettled(openings)
      const units: WorkspaceUnit[] = []
      for (const result of opened) {
        if (result.status === 'fulfilled') units.push(result.value)
        else { const error: unknown = result.reason; failures.push(error) }
      }
      // Unit close never disposes the shared SQL scope, avoiding scope.dispose -> drain -> scope.dispose cycles.
      for (const result of await Promise.allSettled(units.map(unit => unit.close()))) {
        if (result.status === 'rejected') { const error: unknown = result.reason; failures.push(error) }
      }
      failTogether(failures, 'Staged Workspace queues failed to drain; close/reopen is required.')
    })()
    return this.draining
  }

  close(): Promise<void> {
    return this.retirement.close()
  }
}

/** Construct only this optional mapper; no backend registration, routing, store creation or schema migration occurs.
 * @param ctx - Provider context owning the backend closer as an effect.
 * @param owner - Existing connection service, already activated against the reviewed schema.
 * @param config - Explicit provisioned store and fenced lease policy; global presence comes from its durable marker.
 * @param storage - Hub that drains upstream Domain and Registry producers.
 * @param backendName - Explicit route registration name.
 * @param unregister - Effect-owned registry removal, invoked after upstream drain.
 * @returns A Workspace-only KV backend. Each unit serves its last ACKed snapshot; reopen observes other writers.
 */
export async function createWorkspaceMysqlBackend(ctx: Pick<Context, 'effect' | 'logger'>,
  owner: Pick<MysqlRuntime, 'registerConsumer' | 'status'>, config: WorkspaceAdapterConfig,
  storage: Pick<Storage, 'closeBackend'>, backendName: string, unregister: () => void): Promise<StorageBackend> {
  if (!/^[\x21-\x7e]{1,128}$/u.test(config.storeKey)) throw new WorkspaceAdapterError('unrepresentable-state')
  if (owner.status().version !== 3) throw new WorkspaceAdapterError('version-mismatch')
  if (!Number.isSafeInteger(config.leaseTtlMs) || config.leaseTtlMs < 1 || !Number.isSafeInteger(config.heartbeatIntervalMs)
    || config.heartbeatIntervalMs < 1 || config.heartbeatIntervalMs * 3 > config.leaseTtlMs) throw new WorkspaceAdapterError('unrepresentable-state')
  const backend = new WorkspaceBackend(owner, { ...config }, storage, backendName, unregister, () => {
    ctx.logger.warn('MySQL Workspace cache is frozen; close and reopen its provider before continuing.')
  })
  try { ctx.effect(() => () => backend.close(), 'mysql.workspace.adapter()') }
  catch (error) {
    try { await backend.close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Workspace effect registration and cleanup failed.') }
    throw error
  }
  return backend
}
