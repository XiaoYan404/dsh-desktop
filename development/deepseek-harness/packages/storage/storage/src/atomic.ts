/** Optional atomic storage batches; single-record writes cannot provide their transaction guarantee. */

/** One final value or deletion for a record; a batch cannot name the same table/key twice. */
export type KvAtomicRecordMutation =
  | { readonly operation: 'put'; readonly table: string; readonly key: string; readonly value: unknown }
  | { readonly operation: 'delete'; readonly table: string; readonly key: string }

/** One backend transaction; absent global differs from an explicitly carried global value. */
export interface KvAtomicMutation {
  readonly records: readonly KvAtomicRecordMutation[]
  readonly global?: { readonly value: unknown }
}

/** A provider refused this mutation before backend IO; prior caches are unchanged and their ownership guards still apply. */
export class StorageMutationValidationError extends Error {
  override readonly name = 'StorageMutationValidationError'
  /** Stable local classification; arbitrary errors with this code do not establish the same guarantee. */
  readonly code = 'invalid-mutation'
  /** No transaction, SQL or medium write was started for this mutation. */
  readonly outcome = 'not-started'

  /** Only providers that have not started backend IO may construct this refusal.
   * @param cause - Original input-cloning or pure validation failure; retained without exposing its values in the message.
   */
  constructor(cause: unknown) {
    super('The storage mutation failed validation before backend IO; correct the input before retrying.', { cause })
  }
}
