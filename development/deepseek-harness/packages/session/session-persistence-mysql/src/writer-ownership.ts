/** Host-only local writer matching; database lease validity and flush remain separate caller obligations. */
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { WriterIdentity } from './types.ts'

/** Optional capability of the actual MySQL persistence instance, never supplied by a remote request. */
export interface MysqlSessionWriterOwnership {
  /** Configured MySQL namespace; readable during unload, but never proof of an active service or database lease. */
  readonly mysqlStoreKey: string
  /** Match an active local write handle by store, slot, external id, lifecycle, format, owner and fence.
   * @param writer - Database-observed identity; byte arrays are borrowed only for this synchronous call.
   * @returns Whether this instance still owns that exact local handle, including an adopted unpublished creator.
   * A true result does not establish database lease validity or drain events: flush before the transaction,
   * then check the active database lease under its store lock before matching. Unknown admissions return false.
   */
  ownsMysqlWriter(writer: WriterIdentity): boolean
}

/** Detect only capability availability on the configured Host provider; this does not establish ownership.
 * @param persistence - Actual configured persistence service, not a remote object or runtime Session registry.
 * @returns Whether the Host can synchronously match a database-observed writer identity.
 */
export function hasMysqlSessionWriterOwnership(
  persistence: SessionPersistence,
): persistence is SessionPersistence & MysqlSessionWriterOwnership {
  return 'mysqlStoreKey' in persistence && typeof persistence.mysqlStoreKey === 'string'
    && 'ownsMysqlWriter' in persistence && typeof persistence.ownsMysqlWriter === 'function'
}
