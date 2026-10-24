/** Full native/session/workspace validation and per-session deep differences. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { validateMysqlSessionPrefix } from '@deepseek-ai/dsh-session-persistence-mysql'
import { buildSessionEventRecords } from '@deepseek-ai/dsh-session-query'
import { snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import { workspaceDomainState, workspaceRecord } from '@deepseek-ai/dsh-workspace'
import { MigrationError } from './error.ts'
import type { LogicalSession, LogicalStore, MigrationLimits } from './types.ts'

/**
 * @param bytes - Exact original bytes or explicit JSON text.
 * @returns Lowercase SHA-256.
 */
export function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }

/**
 * Reject values MySQL cannot preserve without replacement, including lone UTF-16 surrogates.
 * @param value - A lossless JSON value or identity, validated before SQL mutation.
 */
export function assertRepresentable(value: unknown): void {
  const pending = [value]
  while (pending.length > 0) {
    const item = pending.pop()
    if (typeof item === 'string' && !item.isWellFormed()) throw new MigrationError('UNREPRESENTABLE')
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) {
      throw new MigrationError('UNREPRESENTABLE')
    }
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) pending.push(key, child)
  }
}

/**
 * Validate the complete native export without balancing turns, omitting fields or rewriting events.
 * @param value - Durable JSON containing all sessions and the complete workspace domain.
 * @param limits - Complete-value capacity bounds.
 */
export function validateLogical(value: unknown, limits: MigrationLimits): asserts value is LogicalStore {
  const logical = logicalEnvelope(value)
  snapshotSessionFormatJson(logical)
  assertRepresentable(logical)
  const ids = new Set<string>()
  for (const session of logical.sessions) {
    if (ids.has(session.header.id)) throw new MigrationError('INVALID_ARCHIVE')
    ids.add(session.header.id)
    validateSession(session, limits)
  }
  const global = workspaceDomainState.strict().parse(logical.workspace.global)
  if (global.pendingMutation !== undefined) throw new MigrationError('SOURCE_CHANGED')
  const records = logical.workspace.records
  const workspaceIds = records.map(record => record.id)
  if (new Set(workspaceIds).size !== workspaceIds.length || new Set(global.workspaceIds).size !== global.workspaceIds.length
    || global.workspaceIds.length !== records.length || global.workspaceIds.some(id => !workspaceIds.includes(id))) {
    throw new MigrationError('INVALID_ARCHIVE')
  }
  const candidates = new Set<string>(), paths = new Set<string>()
  for (const { value } of records) {
    workspaceRecord.strict().parse(value)
    if (paths.has(value.path) || Array.from(value.createdAt).length > 64 || Array.from(value.updatedAt).length > 64) {
      throw new MigrationError('UNREPRESENTABLE')
    }
    paths.add(value.path)
    for (const id of value.sessionIds) {
      if (candidates.has(id)) throw new MigrationError('INVALID_ARCHIVE')
      candidates.add(id)
    }
  }
  if (new Set(global.archivedSessionIds).size !== global.archivedSessionIds.length
    || new Set(global.pinnedSessionIds).size !== global.pinnedSessionIds.length
    || global.pinnedSessionIds.some(id => global.archivedSessionIds.includes(id))) throw new MigrationError('INVALID_ARCHIVE')
}

function validateSession(session: LogicalSession, limits: MigrationLimits): void {
  if (session.generations.some(generation => generation.format > SESSION_FORMAT_VERSION)) {
    throw new MigrationError('FUTURE_FORMAT')
  }
  if (!/^[0-9a-f]{32}$/u.test(session.lifecycle)
    || !/^[1-9]\d*$/u.test(session.logRevision) || !session.header.id
    || !Number.isSafeInteger(session.inheritedEventCount) || session.inheritedEventCount < 0
    || session.inheritedEventCount > session.events.length || !session.header.isSeeded && session.inheritedEventCount !== 0) {
    throw new MigrationError('INVALID_ARCHIVE')
  }
  const generationIds = session.generations.map(generation => `${generation.lifecycle}:${generation.format}`)
  if (new Set(generationIds).size !== generationIds.length || session.generations.some(generation =>
    !/^[0-9a-f]{32}$/u.test(generation.lifecycle) || !Number.isSafeInteger(generation.format) || generation.format < 0
    || generation.sourceFiles.length === 0) || session.selectedGeneration.lifecycle !== session.lifecycle
    || !session.generations.some(generation => generation.lifecycle === session.selectedGeneration.lifecycle
      && generation.format === session.selectedGeneration.format)
    || session.generations.some(generation => generation.lifecycle === session.selectedGeneration.lifecycle
      && generation.format > session.selectedGeneration.format)) throw new MigrationError('INVALID_ARCHIVE')
  if (Buffer.byteLength(JSON.stringify(session)) > limits.maxSessionBytes) throw new MigrationError('CAPACITY')
  validateMysqlSessionPrefix({ header: session.header, inheritedEventCount: session.inheritedEventCount }, [...session.events], true)
  for (const [seq, event] of session.events.entries()) {
    if (event.seq !== seq || !Number.isSafeInteger(event.time) || event.time < 0) throw new MigrationError('INVALID_ARCHIVE')
  }
  if (!isDeepStrictEqual(buildSessionEventRecords(session.header.id, session.events), session.surface)) {
    throw new MigrationError('DIFFERENCE')
  }
}

/** A difference names the affected field without exporting private event bodies. */
export interface LogicalDifference { readonly sessionId?: string; readonly field: string }

/**
 * Compare every header field, raw event/stream, surface, lineage, generation, receipt, projection and store/workspace value.
 * @param source - Frozen complete source export.
 * @param target - Complete staging or freshly reloaded target export.
 * @returns Per-session and workspace differences; an empty list means deep equality.
 */
export function diffLogical(source: LogicalStore, target: LogicalStore): LogicalDifference[] {
  const differences: LogicalDifference[] = []
  const targetSessions = new Map(target.sessions.map(session => [session.header.id, session]))
  const fields = ['header', 'lifecycle', 'logRevision', 'inheritedEventCount', 'events', 'surface', 'projections',
    'appendReceipts', 'generations', 'selectedGeneration'] as const
  for (const session of source.sessions) {
    const other = targetSessions.get(session.header.id)
    if (!other) { differences.push({ sessionId: session.header.id, field: 'missing' }); continue }
    for (const field of fields) {
      if (!isDeepStrictEqual(session[field], other[field])) differences.push({ sessionId: session.header.id, field })
    }
    if (fields.every(field => isDeepStrictEqual(session[field], other[field])) && !isDeepStrictEqual(session, other)) {
      differences.push({ sessionId: session.header.id, field: 'session-record' })
    }
    targetSessions.delete(session.header.id)
  }
  for (const id of targetSessions.keys()) differences.push({ sessionId: id, field: 'unexpected' })
  if (source.sessions.length !== target.sessions.length && differences.length === 0) differences.push({ field: 'sessions' })
  if (!isDeepStrictEqual(source.workspace, target.workspace)) differences.push({ field: 'workspace' })
  const { sessions: _sourceSessions, workspace: _sourceWorkspace, ...sourceRecord } = source
  const { sessions: _targetSessions, workspace: _targetWorkspace, ...targetRecord } = target
  if (!isDeepStrictEqual(sourceRecord, targetRecord)) differences.push({ field: 'store-record' })
  return differences
}

function logicalEnvelope(value: unknown): LogicalStore {
  if (!value || typeof value !== 'object' || !('version' in value) || !('workspace' in value)) {
    throw new MigrationError('INVALID_ARCHIVE')
  }
  if (value.version !== 1) throw new MigrationError('FUTURE_FORMAT')
  // v1 targets stage only sessions and workspace; another durable domain needs its own format and adapter.
  if (Object.keys(value).some(key => !['version', 'sessions', 'workspace'].includes(key))) throw new MigrationError('FUTURE_FORMAT')
  const workspace = value.workspace
  if (!workspace || typeof workspace !== 'object' || !('version' in workspace)) throw new MigrationError('INVALID_ARCHIVE')
  if (workspace.version !== 2) throw new MigrationError('FUTURE_FORMAT')
  if (Object.keys(workspace).some(key => !['version', 'global', 'records'].includes(key))) throw new MigrationError('FUTURE_FORMAT')
  if (!('sessions' in value) || !Array.isArray(value.sessions) || !('records' in workspace) || !Array.isArray(workspace.records)
    || !('global' in workspace)) throw new MigrationError('INVALID_ARCHIVE')
  const sessions: readonly unknown[] = value.sessions
  for (const session of sessions) {
    if (!session || typeof session !== 'object' || !('header' in session) || !session.header
      || typeof session.header !== 'object' || !('version' in session.header)) throw new MigrationError('INVALID_ARCHIVE')
    if (typeof session.header.version !== 'number') throw new MigrationError('INVALID_ARCHIVE')
    if (session.header.version > SESSION_FORMAT_VERSION) throw new MigrationError('FUTURE_FORMAT')
    if (session.header.version !== SESSION_FORMAT_VERSION) throw new MigrationError('INVALID_ARCHIVE')
  }
  return value as LogicalStore
}
