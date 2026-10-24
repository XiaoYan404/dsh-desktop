/** Staged projection checkpoints reuse the native cache schema and MySQL kernel's lossless representation boundary. */
import { z } from 'zod'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { checkpointIdentity, checkpointRow } from '@deepseek-ai/dsh-session-projection-cache'
import type { CheckpointRecord } from '@deepseek-ai/dsh-session-projection-cache'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { assertMysqlSessionRepresentable as assertRepresentable } from '@deepseek-ai/dsh-session-persistence-mysql'
import type { MysqlStoredSessionLog as StoredLog } from '@deepseek-ai/dsh-session-persistence-mysql'

/** Explicit staging limits; no deployment default, registration or route is implied. */
export interface ProjectionAdapterConfig {
  readonly storeKey: string
  readonly maxEvents: number
  readonly maxInputBytes: number
  readonly maxCheckpointBytes: number
  readonly maxUnits: number
  readonly readPageSize: number
  readonly maxPendingOperations: number
}

/** One validated complete log cut; the adapter additionally retains its unforgeable private write witness. */
export interface ProjectionObservation {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
  readonly eventCount: number
  readonly logRevision: string
  readonly cacheRevision: string | null
  readonly checkpoint: CheckpointRecord | undefined
}

/** Stable staged failures never include SQL, credentials, event text or projection values. */
export class ProjectionAdapterError extends Error {
  constructor(readonly code: 'configuration' | 'capacity' | 'closed' | 'missing-session' | 'identity-mismatch'
    | 'checkpoint-conflict' | 'watermark-regression' | 'unrepresentable-checkpoint' | 'malformed-checkpoint') {
    super(`Staged MySQL projection checkpoint failed: ${code}.`)
    this.name = 'ProjectionAdapterError'
  }
}

const uint = z.number().int().nonnegative().max(4294967295)
const completeIdentity = checkpointIdentity.extend({ formatVersion: uint,
  isSeeded: checkpointIdentity.shape.isSeeded.unwrap(),
  inheritedEventCount: checkpointIdentity.shape.inheritedEventCount.unwrap() }).strict()
const row = checkpointRow.strict()
const record = z.object({ identity: completeIdentity, rows: z.custom<Record<string, unknown>>(value =>
  typeof value === 'object' && value !== null && !Array.isArray(value)) }).strict()

/** @param input - Complete explicit staging policy. @returns Validated policy detached from its caller. */
export function policy(input: ProjectionAdapterConfig): ProjectionAdapterConfig {
  if (!/^[\x21-\x7e]{1,128}$/u.test(input.storeKey)) throw new ProjectionAdapterError('configuration')
  for (const value of [input.maxEvents, input.maxInputBytes, input.maxCheckpointBytes, input.maxUnits,
    input.readPageSize, input.maxPendingOperations]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ProjectionAdapterError('configuration')
  }
  if (input.readPageSize > input.maxEvents || input.maxUnits > 4294967295) throw new ProjectionAdapterError('configuration')
  return { ...input }
}

/** @param value - SQL BIGINT text. @returns Exact unsigned counter without JavaScript-number coercion. */
export function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value) || BigInt(value) > 18446744073709551615n)
    throw new ProjectionAdapterError('malformed-checkpoint')
  return value
}

/** @param value - Existing SQL revision. @returns Its exact next value, refusing overflow. */
export function increment(value: string): string {
  if (BigInt(decimal(value)) === 18446744073709551615n) throw new ProjectionAdapterError('capacity')
  return (BigInt(value) + 1n).toString()
}

/** @param log - Canonical kernel-decoded log. @returns Current complete native checkpoint identity. */
export function identityOf(log: Pick<StoredLog, 'version' | 'header' | 'inheritedEventCount'>): CheckpointRecord['identity'] {
  return { formatVersion: log.version, createdAt: log.header.createdAt, isSeeded: log.header.isSeeded,
    inheritedEventCount: log.inheritedEventCount, ...(log.header.cwd === undefined ? {} : { cwd: log.header.cwd }) }
}

/** @param value - Candidate identity. @param log - Exact authoritative lifecycle. @returns Exact native identity match. */
export function matches(value: CheckpointRecord['identity'], log: Pick<StoredLog, 'version' | 'header' | 'inheritedEventCount'>): boolean {
  const expected = identityOf(log)
  return value.formatVersion === expected.formatVersion && value.createdAt === expected.createdAt
    && value.cwd === expected.cwd && value.isSeeded === expected.isSeeded
    && value.inheritedEventCount === expected.inheritedEventCount
}

/** @param value - Projection key. @returns Exact representable key; no truncation or collation folding. */
export function projectionKey(value: unknown): string {
  if (typeof value !== 'string' || Array.from(value).length > 191) throw new ProjectionAdapterError('unrepresentable-checkpoint')
  try { assertRepresentable(value) } catch { throw new ProjectionAdapterError('unrepresentable-checkpoint') }
  return value
}

/** Validate and snapshot the complete internal checkpoint before admission to an asynchronous queue.
 * @param input - Full identity and internal unit states, never UI wire values.
 * @param log - Original observation's private canonical metadata.
 * @param config - Explicit complete JSON and unit limits.
 * @returns A detached whole record; null states, empty keys and opaque own JSON keys are preserved.
 */
export function captureRecord(input: unknown, log: Pick<StoredLog, 'version' | 'header' | 'inheritedEventCount' | 'eventCount'>,
  config: ProjectionAdapterConfig): CheckpointRecord {
  const detached = snapshotJsonValue(input)
  if (detached === undefined) throw new ProjectionAdapterError('unrepresentable-checkpoint')
  const parsed = record.safeParse(detached)
  if (!parsed.success) throw new ProjectionAdapterError('unrepresentable-checkpoint')
  if (!matches(parsed.data.identity, log)) throw new ProjectionAdapterError('identity-mismatch')
  const entries = Object.entries(parsed.data.rows)
  if (entries.length > config.maxUnits || Buffer.byteLength(JSON.stringify(detached)) > config.maxCheckpointBytes)
    throw new ProjectionAdapterError('capacity')
  try { assertRepresentable(detached) } catch { throw new ProjectionAdapterError('unrepresentable-checkpoint') }
  const accepted: Array<[string, z.infer<typeof row>]> = []
  for (const [key, inputRow] of entries) {
    projectionKey(key)
    const parsedRow = row.safeParse(inputRow)
    if (!parsedRow.success || parsedRow.data.ver > 4294967295 || parsedRow.data.seq > log.eventCount - 1)
      throw new ProjectionAdapterError('unrepresentable-checkpoint')
    accepted.push([key, parsedRow.data])
  }
  return { identity: parsed.data.identity, rows: Object.fromEntries(accepted) }
}
