/** Canonical v3 fields and actual Workspace/Domain/SQL publication and retirement, through the Loader. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { workspaceDomainSpec, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { RowDataPacket } from 'mysql2/promise'
import { bootV3, newTarget } from './fixtures/loader.ts'

it('round trips unwritten global, original IDs/candidates, exact archive/pin order and retained default identity', async () => {
  const target = await newTarget()
  const boot = await bootV3(target, { workspace: true, registry: false })
  onTestFinished(async () => { await boot.close(); await target.close() })
  const facet = boot.ctx.storage.backend.get('mysql-workspace').kv
  if (!facet) throw new Error('The actual Workspace backend has no KV facet.')
  const unit = await facet.open(descriptorOf(workspaceDomainSpec))
  expect((await unit.loadAll()).global).toBeNull()
  const id = WorkspaceId('original / 工作区 😀')
  const record = { path: target.workspaceRoot, title: '标题 / 原值', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    sessionIds: [SessionId('unresolved-z'), SessionId('unresolved-a')] }
  await unit.putRecord('workspaces', id, record)
  expect((await unit.loadAll()).global).toBeNull()
  const [unwritten] = await target.connection.execute<RowDataPacket[]>('SELECT workspace_global_written FROM dsh_stores WHERE store_id=?', [target.storeId])
  expect(unwritten[0]?.['workspace_global_written']).toBe(0)
  await expect(unit.setGlobal(null)).rejects.toMatchObject({ code: 'unrepresentable-state' })
  expect((await unit.loadAll()).global).toBeNull()
  const global = { initialized: true, defaultWorkspaceId: id, workspaceIds: [id],
    archivedSessionIds: [SessionId('z-first-归档'), SessionId('a-second-归档')], pinnedSessionIds: [SessionId('pinned-z'), SessionId('pinned-a')] }
  await unit.commitAtomic?.({ records: [], global: { value: global } })
  expect(await unit.loadAll()).toEqual({ tables: { workspaces: { [id]: record } }, global })
  await unit.close()
  const reopened = await facet.open(descriptorOf(workspaceDomainSpec))
  expect(await reopened.loadAll()).toEqual({ tables: { workspaces: { [id]: record } }, global })
  await reopened.commitAtomic?.({ records: [{ operation: 'delete', table: 'workspaces', key: id }],
    global: { value: { ...global, workspaceIds: [] } } })
  expect((await reopened.loadAll()).global).toEqual({ ...global, workspaceIds: [] })
  const [candidates] = await target.connection.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM dsh_session_slots WHERE store_id=?', [target.storeId])
  expect(Number(candidates[0]?.['count'])).toBe(6)
  await reopened.close()
})

it('publishes Registry and held Entity values once after ACK, preserves accounting under archive, and refuses another process owner', async () => {
  const target = await newTarget()
  const boot = await bootV3(target, { workspace: true })
  onTestFinished(async () => { await boot.close(); await target.close() })
  const pathA = join(target.workspaceRoot, 'path-a'), pathB = join(target.workspaceRoot, 'path-b')
  await mkdir(pathA); await mkdir(pathB)
  const registry = boot.ctx.workspaceRegistry
  const gate = boot.hold('UPDATE dsh_stores SET registry_initialized=')
  const creation = registry.create(pathA, 'Original A')
  await gate.reached.promise
  expect(registry.list()).toHaveLength(0)
  const [committed] = await target.connection.execute<RowDataPacket[]>('SELECT COUNT(*) AS count FROM dsh_workspaces WHERE store_id=?', [target.storeId])
  expect(Number(committed[0]?.['count'])).toBe(1)
  gate.release.resolve(undefined)
  const a = await creation
  const b = await registry.create(pathB, 'Original B')
  await registry.insertBefore(a.id, b.id)
  const ids = [SessionId('actual-member-z'), SessionId('actual-member-a')]
  for (const id of ids) {
    const writer = await boot.ctx.sessionPersistence.create({ id, cwd: a.path, createdAt: 123,
      version: SESSION_FORMAT_VERSION, isSeeded: false })
    await writer.flush(); await writer.close(); await a.attachSession(id)
  }
  await registry.pinSession(ids[0]!)
  await registry.archiveSession(ids[1]!)
  await registry.archiveSession(ids[0]!)
  expect(registry.archivedSessionIds).toEqual([ids[1], ids[0]])
  expect(registry.pinnedSessionIds).toEqual([])
  expect(a.sessionIds).toEqual([ids[1], ids[0]])
  const titleGate = boot.hold('UPDATE dsh_stores SET registry_initialized=')
  const title = a.setTitle('ACKed A')
  await titleGate.reached.promise
  expect(a.title).toBe('Original A')
  titleGate.release.resolve(undefined); await title
  expect(a.title).toBe('ACKed A')
  const competitor = await bootV3(target, { workspace: true, registry: false })
  try {
    const facet = competitor.ctx.storage.backend.get('mysql-workspace').kv
    if (!facet) throw new Error('Missing competitor KV facet.')
    await expect(facet.open(descriptorOf(workspaceDomainSpec))).rejects.toMatchObject({ code: 'already-owned' })
  } finally { await competitor.close() }
  const expected = { ids: registry.list().map(value => value.id), archived: [...registry.archivedSessionIds] }
  await boot.close()
  const reopened = await bootV3(target, { workspace: true })
  try {
    expect(reopened.ctx.workspaceRegistry.list().map(value => value.id)).toEqual(expected.ids)
    expect(reopened.ctx.workspaceRegistry.archivedSessionIds).toEqual(expected.archived)
    expect(reopened.ctx.workspaceRegistry.get(a.id)?.sessionIds).toEqual([ids[1], ids[0]])
  } finally { await reopened.close() }
})

it('freezes ordinary Domain, Registry and held Entity reads after an unknown real commit and reconciles only on reopen', async () => {
  const target = await newTarget()
  const boot = await bootV3(target, { workspace: true })
  onTestFinished(async () => { await boot.close(); await target.close() })
  const path = join(target.workspaceRoot, 'held-unknown'); await mkdir(path)
  const entity = await boot.ctx.workspaceRegistry.create(path, 'before')
  const gate = boot.hold('UPDATE dsh_stores SET registry_initialized=', true)
  const update = entity.setTitle('durably-after')
  await gate.reached.promise; gate.release.resolve(undefined)
  await expect(update).rejects.toMatchObject({ outcome: 'unknown' })
  expect(() => entity.title).toThrow()
  expect(() => boot.ctx.workspaceRegistry.list()).toThrow()
  await expect(entity.setTitle('must-not-write')).rejects.toMatchObject({ outcome: 'unknown' })
  const [rows] = await target.connection.execute<RowDataPacket[]>('SELECT title FROM dsh_workspaces WHERE store_id=?', [target.storeId])
  expect(rows.map((row) => { const value: unknown = row['title']; return value })).toEqual(['durably-after'])
  await boot.close()
  const recovered = await bootV3(target, { workspace: true })
  try { expect(recovered.ctx.workspaceRegistry.get(entity.id)?.title).toBe('durably-after') }
  finally { await recovered.close() }
})

it.each([false, true])('drains admitted Registry and Entity work before SQL close with reverse mount order %s', async (reverse) => {
  const target = await newTarget()
  const boot = await bootV3(target, { workspace: true, reverse })
  onTestFinished(async () => { await boot.close(); await target.close() })
  const path = join(target.workspaceRoot, 'drained'); await mkdir(path)
  const entity = await boot.ctx.workspaceRegistry.create(path, 'before-drain')
  const gate = boot.hold('UPDATE dsh_stores SET registry_initialized=')
  const first = entity.setTitle('accepted-1')
  await gate.reached.promise
  const second = entity.setTitle('accepted-2')
  const closing = boot.close()
  gate.release.resolve(undefined)
  await Promise.all([first, second, closing])
  const [rows] = await target.connection.execute<RowDataPacket[]>('SELECT title FROM dsh_workspaces WHERE store_id=?', [target.storeId])
  expect(rows.map((row) => { const value: unknown = row['title']; return value })).toEqual(['accepted-2'])
  const [lease] = await target.connection.execute<RowDataPacket[]>('SELECT workspace_owner_token FROM dsh_stores WHERE store_id=?', [target.storeId])
  expect(lease[0]?.['workspace_owner_token']).toBeNull()
})
