/** MySQL mapper protocol: only pre-IO validation may keep its private acknowledged image usable. */
import { Context } from '@deepseek-ai/cordis'
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import type { MysqlConsumer, MysqlExecutor, MysqlResult } from '@deepseek-ai/dsh-mysql'
import { StorageMutationValidationError } from '@deepseek-ai/dsh-storage'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createWorkspaceMysqlBackend } from '../src/adapter.ts'
import { workspaceSql } from '../src/sql.ts'

async function fixture() {
  const ctx = new Context()
  const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const store: Record<string, unknown> = { store_id: '1', workspace_domain_version: 2, registry_initialized: 0,
    default_workspace_external_id: null, registry_revision: '0', search_epoch: '0', workspace_global_written: 0,
    workspace_owner_token: null, workspace_fence: '0', lease_valid: 0 }
  const control: { failure: Error | undefined } = { failure: undefined }
  const write = (): MysqlResult => ({ kind: 'write', affectedRows: 1, insertId: '0', warningStatus: 0 })
  const execute = vi.fn<MysqlExecutor['execute']>(async (sql, params) => {
    if (sql === workspaceSql.store) return { kind: 'rows', rows: [{ ...store }] }
    if ([workspaceSql.records, workspaceSql.order, workspaceSql.candidates, workspaceSql.preferences].some(value => value === sql)) {
      return { kind: 'rows', rows: [] }
    }
    if (sql === workspaceSql.acquire) {
      store['workspace_owner_token'] = params[0]
      store['workspace_fence'] = String(BigInt(String(store['workspace_fence'])) + 1n)
      store['lease_valid'] = 1
      return write()
    }
    if ([workspaceSql.clearOrder, workspaceSql.clearCandidates, workspaceSql.clearPreferences].some(value => value === sql)) return write()
    if (sql === workspaceSql.advance) {
      store['registry_initialized'] = params[0] ? 1 : 0
      store['default_workspace_external_id'] = params[1]
      store['workspace_global_written'] = params[2] ? 1 : 0
      store['registry_revision'] = String(BigInt(String(store['registry_revision'])) + 1n)
      store['search_epoch'] = String(BigInt(String(store['search_epoch'])) + 1n)
      return write()
    }
    if (sql === workspaceSql.release) { store['workspace_owner_token'] = null; return write() }
    throw new Error('Unexpected validation protocol statement.')
  })
  let transactions = 0
  const scope: MysqlConsumer = { execute, transaction: async (work) => {
    transactions++
    if (control.failure) throw control.failure
    return work({ execute })
  }, dispose: async () => {} }
  const backend = await createWorkspaceMysqlBackend(ctx, {
    registerConsumer: () => scope,
    status: () => ({ version: 3, migrationName: 'protocol', scriptSha256: 'protocol', tableCount: 20, foreignKeyCount: 25 }),
  }, { storeKey: 'validation-protocol', leaseTtlMs: 30000, heartbeatIntervalMs: 10000 },
  { closeBackend: async (_name, close) => { await close() } }, 'workspace-mysql', () => {})
  if (!backend.kv) throw new Error('The Workspace KV capability is absent.')
  const unit = await backend.kv.open({ name: 'workspace', version: 2, tables: ['workspaces'], hasGlobal: true })
  onTestFinished(async () => { control.failure = undefined; await backend.close(); await ctx.fiber.dispose() })
  return { unit, execute, transactions: () => transactions, warning, control }
}

it('classifies clone and pure plan failures before SQL and accepts a corrected global without reopening', async () => {
  const host = await fixture()
  const commands = host.execute.mock.calls.length, transactions = host.transactions()
  await expect(host.unit.setGlobal(null)).rejects.toMatchObject({ name: 'StorageMutationValidationError',
    code: 'invalid-mutation', outcome: 'not-started', cause: { code: 'unrepresentable-state' } })
  const commit = host.unit.commitAtomic?.bind(host.unit)
  if (!commit) throw new Error('The atomic Workspace capability is absent.')
  const cloneFailure: unknown = await commit({ records: [{ operation: 'put', table: 'workspaces',
    key: 'invalid', value: { callback: () => {} } }] }).catch((error: unknown) => error)
  expect(cloneFailure).toBeInstanceOf(StorageMutationValidationError)
  expect(cloneFailure).toMatchObject({ cause: { name: 'DataCloneError' } })
  expect(host.execute).toHaveBeenCalledTimes(commands)
  expect(host.transactions()).toBe(transactions)
  expect(host.warning).not.toHaveBeenCalled()
  expect((await host.unit.loadAll()).global).toBeNull()
  const corrected = { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }
  await host.unit.setGlobal(corrected)
  expect(host.transactions()).toBe(transactions + 1)
  expect((await host.unit.loadAll()).global).toEqual(corrected)
  expect(host.warning).not.toHaveBeenCalled()
})

it('keeps a real MySQL not-started transport failure unwrapped and frozen even when the connection becomes usable', async () => {
  const host = await fixture()
  const failure = new MysqlError('connection_unavailable', 'Controlled transport refusal.', 'not-started')
  host.control.failure = failure
  await expect(host.unit.setGlobal({ initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }))
    .rejects.toBe(failure)
  expect(host.warning).toHaveBeenCalledTimes(1)
  const commands = host.execute.mock.calls.length, transactions = host.transactions()
  host.control.failure = undefined
  await expect(host.unit.loadAll()).rejects.toBe(failure)
  await expect(host.unit.setGlobal(null)).rejects.toBe(failure)
  expect(host.execute).toHaveBeenCalledTimes(commands)
  expect(host.transactions()).toBe(transactions)
  await expect(host.unit.close()).rejects.toBe(failure)
})
