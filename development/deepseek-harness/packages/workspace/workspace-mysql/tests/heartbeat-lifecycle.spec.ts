/** Protocol-only ownership failures and shutdown barriers; no database or GUI acceptance is claimed. */
import { Context } from '@deepseek-ai/cordis'
import type { MysqlConsumer, MysqlExecutor, MysqlResult } from '@deepseek-ai/dsh-mysql'
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createWorkspaceMysqlBackend } from '../src/adapter.ts'
import { workspaceSql } from '../src/sql.ts'

async function fixture(renew: () => Promise<MysqlResult>) {
  const ctx = new Context()
  const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const row: Record<string, unknown> = { store_id: '1', workspace_domain_version: 2, registry_initialized: 0,
    default_workspace_external_id: null, registry_revision: '0', search_epoch: '0', workspace_global_written: 0,
    workspace_owner_token: null, workspace_fence: '0', lease_valid: 0 }
  const write = (): MysqlResult => ({ kind: 'write', affectedRows: 1, insertId: '0', warningStatus: 0 })
  const execute = vi.fn<MysqlExecutor['execute']>(async (sql, params) => {
    if (sql === workspaceSql.store) return { kind: 'rows', rows: [{ ...row }] }
    if ([workspaceSql.records, workspaceSql.order, workspaceSql.candidates, workspaceSql.preferences].some(value => value === sql)) {
      return { kind: 'rows', rows: [] }
    }
    if (sql === workspaceSql.acquire) {
      row['workspace_owner_token'] = params[0]
      row['workspace_fence'] = String(BigInt(String(row['workspace_fence'])) + 1n)
      row['lease_valid'] = 1
      return write()
    }
    if (sql === workspaceSql.renew) return renew()
    if (sql === workspaceSql.release) { row['workspace_owner_token'] = null; return write() }
    throw new Error('Unexpected Workspace lifecycle statement.')
  })
  const dispose = vi.fn(async () => {})
  const scope: MysqlConsumer = { execute, transaction: work => work({ execute }), dispose }
  const backend = await createWorkspaceMysqlBackend(ctx, {
    registerConsumer: () => scope,
    status: () => ({ version: 3, migrationName: 'protocol', scriptSha256: 'protocol', tableCount: 20, foreignKeyCount: 25 }),
  }, { storeKey: 'agent05-heartbeat', leaseTtlMs: 900, heartbeatIntervalMs: 200 },
  { closeBackend: async (_name, close) => { await close() } }, 'workspace-mysql', () => {})
  const unit = await backend.kv!.open({ name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true })
  const expected = { closeFails: false }
  onTestFinished(async () => {
    try { await backend.close() } catch (error) { if (!expected.closeFails) throw error }
    await ctx.fiber.dispose()
  })
  return { backend, unit, execute, dispose, warning, expected }
}

it('reports a failed background heartbeat once and refuses cached GUI reads and writes without more SQL', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const failure = new MysqlError('connection_unavailable', 'Controlled renewal failure.', 'not-started')
  const target = await fixture(async () => { throw failure })
  target.expected.closeFails = true
  expect((await target.unit.loadAll()).global).toBeNull()
  await vi.advanceTimersByTimeAsync(200)
  expect(target.warning).toHaveBeenCalledExactlyOnceWith(
    'MySQL Workspace cache is frozen; close and reopen its provider before continuing.')
  const commands = vi.mocked(target.execute).mock.calls.length
  await expect(target.unit.loadAll()).rejects.toBe(failure)
  await expect(target.unit.setGlobal({})).rejects.toBe(failure)
  await vi.advanceTimersByTimeAsync(2000)
  expect(vi.mocked(target.execute).mock.calls).toHaveLength(commands)
  expect(target.warning).toHaveBeenCalledTimes(1)
  await expect(target.unit.close()).rejects.toBe(failure)
  expect(vi.mocked(target.execute).mock.calls.at(-1)?.[0]).toBe(workspaceSql.release)
})

it('leaves an unwritten singleton readable after a pre-SQL validation refusal without reporting a frozen cache', async () => {
  const target = await fixture(async () => ({ kind: 'write', affectedRows: 1, insertId: '0', warningStatus: 0 }))
  const commands = vi.mocked(target.execute).mock.calls.length
  await expect(target.unit.setGlobal(null)).rejects.toMatchObject({
    code: 'invalid-mutation', outcome: 'not-started', cause: { code: 'unrepresentable-state' },
  })
  expect((await target.unit.loadAll()).global).toBeNull()
  expect(vi.mocked(target.execute).mock.calls).toHaveLength(commands)
  expect(target.warning).not.toHaveBeenCalled()
})

it('waits for an admitted heartbeat before releasing the unit and SQL scope during provider close', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const reached = Promise.withResolvers<undefined>(), release = Promise.withResolvers<MysqlResult>()
  onTestFinished(() => { release.resolve({ kind: 'write', affectedRows: 1, insertId: '0', warningStatus: 0 }) })
  const target = await fixture(() => { reached.resolve(undefined); return release.promise })
  await vi.advanceTimersByTimeAsync(200)
  await reached.promise
  const closing = target.backend.close()
  expect(vi.mocked(target.execute).mock.calls.some(call => call[0] === workspaceSql.release)).toBe(false)
  expect(target.dispose).not.toHaveBeenCalled()
  release.resolve({ kind: 'write', affectedRows: 1, insertId: '0', warningStatus: 0 })
  await closing
  expect(vi.mocked(target.execute).mock.calls.at(-1)?.[0]).toBe(workspaceSql.release)
  expect(target.dispose).toHaveBeenCalledTimes(1)
  const commands = vi.mocked(target.execute).mock.calls.length
  await vi.advanceTimersByTimeAsync(2000)
  expect(vi.mocked(target.execute).mock.calls).toHaveLength(commands)
})
