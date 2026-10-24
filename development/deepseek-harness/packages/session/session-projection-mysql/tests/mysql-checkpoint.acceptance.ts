/** Real schema v3 checkpoint CAS, bounded rebuild, provider writes and unknown-commit recovery. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { Session, SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { CheckpointRecord } from '@deepseek-ai/dsh-session-projection-cache'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { RowDataPacket } from 'mysql2/promise'
import { bootV3, newTarget } from '../../../workspace/workspace-mysql/tests/fixtures/loader.ts'
import { createProjectionMysqlAdapter } from '../src/adapter.ts'
import type { ProjectionObservation } from '../src/model.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { 'agent05/count': number }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:agent05/checkpoint': { value: string } }
}
const config = { storeKey: 'replaced-by-target', maxEvents: 100, maxInputBytes: 10000, maxCheckpointBytes: 4000,
  maxUnits: 8, readPageSize: 2, maxPendingOperations: 8 }
const events: SessionEvent[] = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]
function record(observation: ProjectionObservation, rows: CheckpointRecord['rows']): CheckpointRecord {
  return { identity: { formatVersion: observation.header.version, createdAt: observation.header.createdAt,
    isSeeded: observation.header.isSeeded, inheritedEventCount: observation.inheritedEventCount,
    ...(observation.header.cwd === undefined ? {} : { cwd: observation.header.cwd }) }, rows }
}
const definition = (version: number): ProjectionDefinition<'agent05/count', number> => ({ key: 'agent05/count',
  stateVersion: version, stateSchema: z.number().int().nonnegative(), init: () => 0,
  apply: (state, event) => state + (event.type === 'turn/end' ? 1 : 0) })

it('uses actual CAS across connections, deletes omitted keys, bounds damaged caches, and refuses a replaced lifecycle', async () => {
  const target = await newTarget(), boot = await bootV3(target)
  onTestFinished(async () => { await boot.close(); await target.close() })
  const id = SessionId('checkpoint-CAS')
  const header: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: 77, isSeeded: false }
  const writer = await boot.ctx.sessionPersistence.create(header)
  await writer.append(events); await writer.close()
  const a = await createProjectionMysqlAdapter(boot.ctx, boot.ctx.mysql, { ...config, storeKey: target.storeKey })
  const b = await createProjectionMysqlAdapter(boot.ctx, boot.ctx.mysql, { ...config, storeKey: target.storeKey })
  const first = await a.observe(id), competing = await b.observe(id)
  const initial = record(first, Object.fromEntries([['old', { ver: 1, seq: SessionSeq(1), val: { original: true } }],
    ['', { ver: 1, seq: -1, val: null }], ['__proto__', { ver: 1, seq: -1, val: { own: true } }]]))
  expect(await a.replace(first, initial)).toBe('1')
  await expect(b.replace(competing, record(competing, {}))).rejects.toMatchObject({ code: 'checkpoint-conflict' })
  const observed = await a.observe(id)
  expect(observed.checkpoint).toEqual(initial)
  expect(Object.hasOwn(observed.checkpoint?.rows ?? {}, '__proto__')).toBe(true)
  expect(await a.replace(observed, record(observed, {}))).toBe('2')
  const empty = await a.observe(id)
  expect(empty.checkpoint?.rows).toEqual({})
  expect(empty.eventCount).toBe(2)
  await target.connection.execute('UPDATE dsh_projection_checkpoints SET unit_count=1000 WHERE store_id=?', [target.storeId])
  const damaged = await a.observe(id)
  expect(damaged.checkpoint).toBeUndefined()
  expect(damaged.cacheRevision).toBe('2')
  await a.replace(damaged, record(damaged, { huge: { ver: 1, seq: -1, val: null } }))
  await target.connection.execute('UPDATE dsh_projection_states SET state_json=? WHERE store_id=?', [JSON.stringify('x'.repeat(10000)), target.storeId])
  const tooLarge = await a.observe(id)
  expect(tooLarge.checkpoint).toBeUndefined()
  await a.replace(tooLarge, record(tooLarge, {}))
  const stale = await a.observe(id)
  await target.connection.beginTransaction()
  try {
    await target.connection.execute('SELECT store_id FROM dsh_stores WHERE store_id=? FOR UPDATE', [target.storeId])
    await target.connection.execute('UPDATE dsh_session_slots SET current_lifecycle_id=NULL,current_format_version=NULL WHERE store_id=? AND external_session_id=?', [target.storeId, id])
    await target.connection.execute("UPDATE dsh_session_logs SET log_state='sealed' WHERE store_id=?", [target.storeId])
    await target.connection.commit()
  } catch (error) { await target.connection.rollback(); throw error }
  const replacement = await boot.ctx.sessionPersistence.create(header)
  await replacement.flush(); await replacement.close()
  await expect(a.replace(stale, record(stale, {}))).rejects.toMatchObject({ code: 'identity-mismatch' })
  const [preserved] = await target.connection.execute<RowDataPacket[]>('SELECT event_json FROM dsh_session_events WHERE store_id=? ORDER BY seq', [target.storeId])
  expect(preserved.map((row) => { const value: unknown = JSON.parse(String(row['event_json'])); return value })).toEqual(events)
  const [receipts] = await target.connection.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM dsh_append_batches WHERE store_id=?', [target.storeId])
  expect(Number(receipts[0]?.['count'])).toBe(1)
  await a.close(); await b.close()
})

it('routes mandatory create/end/detach writes through the real cache owner and refolds incompatible unit versions from MySQL', async () => {
  const target = await newTarget(), boot = await bootV3(target, { projection: true })
  onTestFinished(async () => { await boot.close(); await target.close() })
  boot.ctx.sessionProjections.register(definition(1))
  const backend = boot.ctx.sessionProjectionCheckpointBackend
  const original = backend.write.bind(backend)
  const waiting: Array<ReturnType<typeof Promise.withResolvers<CheckpointRecord>>> = []
  const spy = vi.spyOn(backend, 'write').mockImplementation((session) => {
    const pending = original(session), next = waiting.shift()
    if (next) void pending.then(next.resolve, next.reject)
    return pending
  })
  onTestFinished(() => { spy.mockRestore() })
  const next = (): Promise<CheckpointRecord> => {
    const gate = Promise.withResolvers<CheckpointRecord>(); waiting.push(gate); return gate.promise
  }
  const session = boot.ctx.sessions.prepare(SessionId('mandatory-cache'), { meta: { cwd: target.workspaceRoot } })
  const writer = await boot.ctx.sessionPersistence.create(session.header)
  await writer.flush()
  const detach = boot.ctx.sessions.enter(session)
  const created = next(); boot.ctx.sessions.announce(session)
  expect((await created).rows['agent05/count']).toEqual({ ver: 1, seq: -1, val: 0 })
  const ended = next()
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect((await ended).rows['agent05/count']).toEqual({ ver: 1, seq: 1, val: 1 })
  const detached = next()
  appendPluginRecord(session, 'plugin:agent05/checkpoint', { value: 'last-admitted' })
  detach()
  const final = await detached
  expect(final.rows['agent05/count']).toEqual({ ver: 1, seq: 2, val: 1 })
  expect(boot.ctx.sessionProjectionCache.cachedSnapshot(session.header)).toBeUndefined()
  expect(existsSync(join(boot.home, 'native-domains', 'session_projcache'))).toBe(false)
  const reader = await boot.ctx.sessionPersistence.open(session.id, 'read')
  const persisted = await reader.read(); await reader.close()
  expect(persisted.events).toHaveLength(3)
  await boot.close()
  const reopened = await bootV3(target, { projection: true })
  try {
    reopened.ctx.sessionProjections.register(definition(2))
    const restored = Session.fromRestore(session.id, persisted.events, session.header, SessionLogOffset(0), 'detached')
    await reopened.ctx.sessionProjectionCache.write(restored)
    const [rows] = await target.connection.execute<RowDataPacket[]>(
      'SELECT state_version,last_seq,state_json FROM dsh_projection_states WHERE store_id=? AND projection_key=?', [target.storeId, 'agent05/count'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['state_version']).toBe(2)
    expect(rows[0]?.['last_seq']).toBe('2')
    expect(JSON.parse(String(rows[0]?.['state_json']))).toBe(1)
  } finally { await reopened.close() }
})

it('freezes all later projection SQL after unknown ACK, then reopens the committed cache without touching events', async () => {
  const target = await newTarget(), boot = await bootV3(target)
  onTestFinished(async () => { await boot.close(); await target.close() })
  const id = SessionId('unknown-checkpoint'), writer = await boot.ctx.sessionPersistence.create({ id,
    version: SESSION_FORMAT_VERSION, createdAt: 88, isSeeded: false })
  await writer.append(events); await writer.close()
  const adapter = await createProjectionMysqlAdapter(boot.ctx, boot.ctx.mysql, { ...config, storeKey: target.storeKey })
  const observation = await adapter.observe(id)
  const gate = boot.hold('INSERT INTO dsh_projection_checkpoints (', true)
  const pending = adapter.replace(observation, record(observation, { one: { ver: 1, seq: SessionSeq(1), val: null } }))
  await gate.reached.promise; gate.release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ outcome: 'unknown' })
  const before = boot.sqlCommands()
  await expect(adapter.observe(id)).rejects.toMatchObject({ outcome: 'unknown' })
  await expect(adapter.replace(observation, record(observation, {}))).rejects.toMatchObject({ outcome: 'unknown' })
  expect(boot.sqlCommands()).toBe(before)
  await expect(adapter.close()).rejects.toBeInstanceOf(AggregateError)
  const fresh = await createProjectionMysqlAdapter(boot.ctx, boot.ctx.mysql, { ...config, storeKey: target.storeKey })
  const recovered = await fresh.observe(id)
  expect(recovered.cacheRevision).toBe('1')
  expect(recovered.checkpoint?.rows['one']?.val).toBeNull()
  expect(recovered.events).toEqual(events)
  await fresh.close()
})
