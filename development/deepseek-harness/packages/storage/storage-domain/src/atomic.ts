/** Atomic Domain mutations: prepare on the existing chain, commit once, publish complete caches, then notify. */
import type { KvAtomicMutation, KvAtomicRecordMutation, KvUnit } from '@deepseek-ai/dsh-storage'
import { StorageMutationValidationError } from '@deepseek-ai/dsh-storage'
import type { DomainChanged, DomainSpec, GlobalValueOf, TableKeyOf, TableValueOf } from '@deepseek-ai/dsh-storage-domain'

/** Table-specific atomic record changes preserve the existing spec's branded keys and value types. */
export type DomainAtomicRecordMutation<S extends DomainSpec> = {
  [N in keyof S['tables'] & string]:
    | { readonly operation: 'put'; readonly table: N; readonly key: TableKeyOf<S, N>; readonly value: TableValueOf<S, N> }
    | { readonly operation: 'delete'; readonly table: N; readonly key: TableKeyOf<S, N> }
}[keyof S['tables'] & string]

/** Typed batch and the callback's local result; neither the result nor memory changes publish before acknowledgement. */
export interface PreparedDomainAtomicMutation<S extends DomainSpec, T> {
  readonly mutation: {
    readonly records: readonly DomainAtomicRecordMutation<S>[]
    readonly global?: { readonly value: GlobalValueOf<S> }
  }
  readonly value: T
}

/**
 * Optional typed capability exposed only by a backend that declares one atomic commit.
 * @param prepare - Pure synchronous work on the Domain's existing write chain; read through its current handles.
 * @param publish - Optional synchronous consumer-cache replacement after every Domain cache changed and before notifications; no IO.
 * @returns The prepared result after acknowledged commit and publication; no automatic retry or legacy fallback occurs on failure.
 * Declared pre-IO validation refusals leave caches intact; other backend failures require close/reopen.
 */
export type DomainAtomicMutator<S extends DomainSpec> = <T>(
  prepare: () => PreparedDomainAtomicMutation<S, T>, publish?: (value: T) => undefined,
) => Promise<T>

/** Runtime erasure matches DomainImpl's current untyped record/global maps. */
export type RuntimeDomainAtomicMutator = <T>(
  prepare: () => { readonly mutation: KvAtomicMutation; readonly value: T }, publish?: (value: T) => undefined,
) => Promise<T>

/** A backend acknowledged commit, but a local publisher/notification failed; this error never represents rollback. */
export class DomainAtomicPublicationError extends Error {
  override readonly name = 'DomainAtomicPublicationError'
  /** The backend acknowledged durability before this local publication failure. */
  readonly committed = true
  /** @param failures - Original publication failures, retained in order after all notifications were attempted. */
  constructor(readonly failures: readonly unknown[]) {
    super('The atomic Domain mutation committed, but local publication failed; close and reload before another operation.',
      { cause: new AggregateError(failures, 'Atomic Domain publication failures') })
  }
}

/** Private callbacks supplied by the real DomainImpl; none exposes or reflects its private fields outside the class. */
export interface DomainAtomicHost {
  readonly name: string
  enqueue<T>(work: () => Promise<T>): Promise<T>
  /** Validate a declared record and capture its memory update; an absent delete is a no-op. */
  prepareRecord(change: KvAtomicRecordMutation): (() => void) | undefined
  /** Reject global writes for domains without a declared global and capture the memory update. */
  prepareGlobal(value: unknown): () => void
  /** Fence later queued/new work and trusted reads until close/reopen; retain the original failure. */
  invalidate(error: unknown): void
  emit(change: DomainChanged): void
}

/**
 * Create the optional bridge without touching a legacy unit or guessing support.
 * @param host - Real Domain's queue, memory publication and contained event emission.
 * @param unit - Open backend; commitAtomic is a declared transaction capability, never a loop over putRecord/setGlobal.
 * @returns An atomic mutator only when the backend provides the capability.
 */
export function createDomainAtomicMutator(host: DomainAtomicHost, unit: KvUnit): RuntimeDomainAtomicMutator | undefined {
  const commit = unit.commitAtomic?.bind(unit)
  if (!commit) return undefined
  return (prepare, publish) => host.enqueue(async () => {
    const prepared = prepare()
    const updates: Array<() => void> = [], changes: DomainChanged[] = [], records: KvAtomicRecordMutation[] = []
    const named = new Set<string>()
    for (const change of prepared.mutation.records) {
      const location = JSON.stringify([change.table, change.key])
      if (named.has(location)) throw new Error('An atomic Domain mutation must name each record at most once.')
      named.add(location)
      const update = host.prepareRecord(change)
      if (!update) continue
      updates.push(update)
      records.push(change)
      const locationFields = { domain: host.name, table: change.table, key: change.key }
      changes.push(change.operation === 'put' ? { ...locationFields, operation: 'put', value: change.value }
        : { ...locationFields, operation: 'deleted' })
    }
    const global = prepared.mutation.global
    if (global) {
      updates.push(host.prepareGlobal(global.value))
      changes.push({ domain: host.name, table: '', key: '', operation: 'put', value: global.value })
    }
    if (records.length === 0 && !global) return prepared.value
    try { await commit({ records, ...(global ? { global } : {}) }) }
    catch (error) {
      if (!(error instanceof StorageMutationValidationError)) host.invalidate(error)
      throw error
    }
    const failures: unknown[] = []
    let publicationError: DomainAtomicPublicationError | undefined
    try { for (const update of updates) update(); publish?.(prepared.value) }
    catch (error) {
      failures.push(error)
      publicationError = new DomainAtomicPublicationError(failures)
      host.invalidate(publicationError)
    }
    for (const change of changes) {
      try { host.emit(change) } catch (error) { failures.push(error) }
    }
    if (failures.length) {
      const error = publicationError ?? new DomainAtomicPublicationError(failures)
      host.invalidate(error)
      throw error
    }
    return prepared.value
  })
}
