/** Workspace values and explicit global presence over schema v3 normalized tables. */
import { Buffer } from 'node:buffer'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { KvAtomicMutation } from '@deepseek-ai/dsh-storage'
import { workspaceDomainState, workspaceRecord } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceDomainState, WorkspaceId, WorkspaceRecord } from '@deepseek-ai/dsh-workspace'

/** Mapper refusals; transport failures, including unknown COMMIT, retain their original object. */
export class WorkspaceAdapterError extends Error {
  override readonly name = 'WorkspaceAdapterError'
  /** @param code - Safe diagnostic classification; SQL values are never included. */
  constructor(readonly code: 'unsupported-unit' | 'store-missing' | 'version-mismatch' | 'malformed-medium'
    | 'archive-order-unavailable' | 'pending-mutation-unrecovered' | 'registry-conflict' | 'record-conflict'
    | 'hash-collision' | 'revision-exhausted' | 'unrepresentable-state' | 'ownership-lost' | 'already-owned') {
    super('MySQL Workspace operation refused: ' + code)
  }
}

/** Explicitly provisioned schema v3 namespace and registry ownership policy. */
export interface WorkspaceAdapterConfig {
  /** Existing provisioned store key: 1-128 non-space printable ASCII characters; never creates the store. */
  readonly storeKey: string
  /** Registry lease duration in milliseconds; a positive safe integer, restricted to 1000-600000 by Loader configuration. */
  readonly leaseTtlMs: number
  /** Lease renewal interval in milliseconds; a positive safe integer at most leaseTtlMs / 3, restricted to 100-200000 by Loader configuration. */
  readonly heartbeatIntervalMs: number
}

/** Fixed owner and exact monotonically increasing fence, checked on every transaction. */
export interface WorkspaceLease { readonly owner: Buffer; readonly fence: string }

/** Internal SQL identity and record CAS accompany each typed record without changing the public value. */
export interface StoredWorkspace {
  readonly pk: string
  readonly revision: string
  readonly value: WorkspaceRecord
}

/** An acknowledged normalized registry observation with an explicit global-written bit. */
export interface WorkspaceImage {
  readonly storeId: string
  readonly revision: string
  readonly global: WorkspaceDomainState
  readonly globalWritten: boolean
  readonly records: ReadonlyMap<string, StoredWorkspace>
}

/** A detached, validated target for one transaction; existing rows retain their internal keys. */
export interface WorkspacePlan {
  readonly global: WorkspaceDomainState
  readonly globalWritten: boolean
  readonly records: ReadonlyMap<string, WorkspaceRecord>
  readonly touched: ReadonlySet<string>
}

const MAX_UNSIGNED = 18_446_744_073_709_551_615n

/** @param value - BIGINT column or explicitly bound decimal text. @returns Exact unsigned decimal text. */
export function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value) || BigInt(value) > MAX_UNSIGNED) {
    throw new WorkspaceAdapterError('malformed-medium')
  }
  return value
}

/** @param value - Existing exact revision. @returns One increment, without Number coercion. */
export function increment(value: string): string {
  if (BigInt(value) === MAX_UNSIGNED) throw new WorkspaceAdapterError('revision-exhausted')
  return (BigInt(value) + 1n).toString()
}

/** @param value - Wire column. @returns UTF8-roundtrippable text, with no trimming or case changes. */
export function text(value: unknown): string {
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new WorkspaceAdapterError('malformed-medium')
  }
  return value
}

/** @param left - Original UTF8 text. @param right - Lookup text. @returns Exact byte equality after a hash hit. */
export function sameBytes(left: string, right: string): boolean {
  return Buffer.from(left, 'utf8').equals(Buffer.from(right, 'utf8'))
}

/** @param value - Required semantic ID/path. @returns The unchanged nonempty text. */
export function nonempty(value: unknown): string {
  const result = text(value)
  if (result.length === 0) throw new WorkspaceAdapterError('unrepresentable-state')
  return result
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new WorkspaceAdapterError('unrepresentable-state')
  for (const value of values) nonempty(value)
}

/** @param value - Public unknown KV record at the durability boundary. @returns Detached current Workspace fields. */
export function recordValue(value: unknown): WorkspaceRecord {
  const parsed = workspaceRecord.strict().safeParse(value)
  if (!parsed.success) throw new WorkspaceAdapterError('unrepresentable-state')
  const record = parsed.data
  nonempty(record.path)
  text(record.title)
  unique(record.sessionIds)
  for (const timestamp of [record.createdAt, record.updatedAt]) {
    if (!/^[\x00-\x7f]{0,64}$/u.test(timestamp)) throw new WorkspaceAdapterError('unrepresentable-state')
  }
  return record
}

/** @param value - Public unknown KV singleton. @returns Current fields represented by schema v3. */
export function globalValue(value: unknown): WorkspaceDomainState {
  const parsed = workspaceDomainState.strict().safeParse(value)
  if (!parsed.success) throw new WorkspaceAdapterError('unrepresentable-state')
  const global = parsed.data
  if (global.pendingMutation !== undefined) throw new WorkspaceAdapterError('pending-mutation-unrecovered')
  unique(global.workspaceIds)
  unique(global.archivedSessionIds)
  unique(global.pinnedSessionIds)
  if (global.archivedSessionIds.some(id => global.pinnedSessionIds.includes(id))) throw new WorkspaceAdapterError('unrepresentable-state')
  if (global.defaultWorkspaceId !== undefined) text(global.defaultWorkspaceId)
  return global
}

/** Validate both initialization stages and the one-owner candidate ledger without resolving Session logs.
 * @param global - Proposed authoritative order/default/preferences.
 * @param records - Full Workspace records including unresolved candidates.
 */
export function validateImage(global: WorkspaceDomainState, records: ReadonlyMap<string, WorkspaceRecord>): void {
  const paths = new Set<string>(), sessions = new Set<string>()
  for (const [id, record] of records) {
    nonempty(id)
    if (paths.has(record.path)) throw new WorkspaceAdapterError('unrepresentable-state')
    paths.add(record.path)
    for (const session of record.sessionIds) {
      if (sessions.has(session)) throw new WorkspaceAdapterError('unrepresentable-state')
      sessions.add(session)
    }
  }
  for (const id of global.workspaceIds) {
    if (!records.has(id)) throw new WorkspaceAdapterError('unrepresentable-state')
  }
  // History bootstrap writes records before its final order/initialized singleton.
  if (global.initialized && global.workspaceIds.length !== records.size) {
    throw new WorkspaceAdapterError('unrepresentable-state')
  }
}

/** @param current - Acknowledged opening/current image. @param mutation - One frozen input batch.
 * @returns A complete, representable target; no cache mutation or SQL occurs here.
 */
export function planMutation(current: WorkspaceImage, mutation: KvAtomicMutation): WorkspacePlan {
  const records = new Map([...current.records].map(([id, stored]) => [id, stored.value]))
  const touched = new Set<string>()
  for (const change of mutation.records) {
    if (change.table !== 'workspaces') throw new WorkspaceAdapterError('unsupported-unit')
    nonempty(change.key)
    if (touched.has(change.key)) throw new WorkspaceAdapterError('unrepresentable-state')
    touched.add(change.key)
    if (change.operation === 'put') records.set(change.key, recordValue(change.value))
    else records.delete(change.key)
  }
  const global = mutation.global === undefined ? current.global : globalValue(mutation.global.value)
  validateImage(global, records)
  return { global, globalWritten: current.globalWritten || mutation.global !== undefined, records, touched }
}

/** @param value - Exact persisted external ID. @returns Current public Workspace identity. */
export function workspaceIdentity(value: string): WorkspaceId { return brandString<WorkspaceId>(value) }

/** @param image - Acknowledged private cache. @returns Detached KV projection, including every current record/global field. */
export function projectImage(image: WorkspaceImage): { tables: Record<string, Record<string, unknown>>; global: unknown } {
  return structuredClone({ tables: { workspaces: Object.fromEntries([...image.records].map(([id, stored]) => [id, stored.value])) },
    global: image.globalWritten ? image.global : null })
}
