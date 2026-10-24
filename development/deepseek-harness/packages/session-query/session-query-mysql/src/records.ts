/** Decode database responses and retain domain errors only after acknowledged rollback. */
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import type { MysqlClient, MysqlExecutor, MysqlResult, MysqlRow } from '@deepseek-ai/dsh-mysql'
import { SessionId } from '@deepseek-ai/dsh-session'
import { decodeMysqlSessionLog } from '@deepseek-ai/dsh-session-persistence-mysql'
import type { MysqlStoredSessionLog } from '@deepseek-ai/dsh-session-persistence-mysql'
import { MysqlSearchError } from './error.ts'
import type { SearchCut } from './types.ts'

/**
 * @param result - SQL response.
 * @returns Validated row collection.
 */
export function rows(result: MysqlResult): readonly MysqlRow[] {
  if (result.kind !== 'rows') throw new MysqlSearchError('INVALID_RECORD')
  return result.rows
}
/**
 * @param value - SQL text.
 * @returns Exact string, without lossy conversion.
 */
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new MysqlSearchError('INVALID_RECORD')
  return value
}
/**
 * @param value - SQL BIGINT.
 * @returns Exact unsigned decimal text.
 */
export function decimal(value: unknown): string {
  const result = string(value)
  if (!/^(0|[1-9]\d*)$/u.test(result)) throw new MysqlSearchError('INVALID_RECORD')
  return result
}
/**
 * @param value - Business counter.
 * @returns Nonnegative safe integer.
 */
export function count(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new MysqlSearchError('INVALID_RECORD')
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0 || Object.is(result, -0)) throw new MysqlSearchError('INVALID_RECORD')
  return result
}
/**
 * @param value - Persisted UUID.
 * @returns Detached sixteen-byte identity.
 */
export function binary(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16) throw new MysqlSearchError('INVALID_RECORD')
  return Buffer.from(value)
}
/**
 * @param value - JSON field.
 * @returns An object accepted at the durable boundary.
 */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MysqlSearchError('INVALID_RECORD')
  return value as Record<string, unknown>
}
/**
 * @param row - Selected complete log metadata.
 * @returns A validated immutable generation cut.
 */
export function decodeCut(row: MysqlRow): SearchCut {
  const id = SessionId(string(row['external_session_id']))
  return cutFromLog(decodeMysqlSessionLog(row, id))
}
/**
 * @param log - Formal 05 native cut metadata.
 * @returns Search identity without parsing opaque public revisions.
 */
export function cutFromLog(log: MysqlStoredSessionLog): SearchCut {
  return { storeId: log.storeId, slotId: log.slotId, lifecycle: Buffer.from(log.lifecycle), format: log.version,
    revision: log.revision, eventCount: log.eventCount, inheritedEventCount: log.inheritedEventCount, header: log.header }
}
/**
 * @param cut - Fixed native generation.
 * @returns Positional identity bindings.
 */
export function key(cut: SearchCut): [string, string, Uint8Array, number] {
  return [cut.storeId, cut.slotId, cut.lifecycle, cut.format]
}

class SearchRefusal extends MysqlError {
  constructor(readonly failure: unknown) { super('statement_failed', 'Search transaction refused.', 'not-committed') }
}
/**
 * Retain domain failures after confirmed rollback; unknown COMMIT/ROLLBACK always wins.
 * @param sql - Consumer-scoped client.
 * @param work - SQL-only transaction callback.
 * @param signal - Optional cancellation.
 * @returns Callback value after acknowledged COMMIT.
 */
export async function transaction<T>(sql: MysqlClient, work: (tx: MysqlExecutor) => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await sql.transaction(async (tx) => {
      try { return await work(tx) }
      catch (error) {
        if (error instanceof MysqlError) throw error
        throw new SearchRefusal(error)
      }
    }, signal)
  } catch (error) {
    if (error instanceof SearchRefusal) throw error.failure
    throw error
  }
}
