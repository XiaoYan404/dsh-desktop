/** Real Loader composition on the reviewed schema v3 fixture; faults control only acknowledgement delivery. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import MysqlRuntime, { MysqlError } from '@deepseek-ai/dsh-mysql'
import type { MysqlConsumer, MysqlExecutor } from '@deepseek-ai/dsh-mysql'
import SessionStore from '@deepseek-ai/dsh-session'
import MysqlSessionPersistence from '@deepseek-ai/dsh-session-persistence-mysql'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import * as WorkspaceMysql from '../../src/index.ts'
import ProjectionMysql from '../../../../session/session-projection-mysql/src/index.ts'
import { ownedV3Target } from '../../../../storage/mysql/tests/fixtures/owned-v3.ts'
import type { RowDataPacket } from 'mysql2/promise'
import { onTestFinished } from 'vitest'

/** Acknowledgement control is independent of SQL execution; release always lets the accepted transaction settle. */
export interface AckGate {
  readonly prefix: string
  readonly reached: ReturnType<typeof Promise.withResolvers<undefined>>
  readonly release: ReturnType<typeof Promise.withResolvers<undefined>>
  readonly unknown: boolean
}
/** Fresh adopted namespace and database-level SQL observer; closing never removes historical stores. */
export async function newTarget() {
  const target = await ownedV3Target(process.cwd())
  const resources: { workspaceRoot: string | undefined } = { workspaceRoot: undefined }
  let closeTask: Promise<void> | undefined
  const close = (): Promise<void> => {
    closeTask ??= (async () => {
      try { await target.connection.end() } finally {
        const workspaceRoot = resources.workspaceRoot
        if (workspaceRoot !== undefined) {
          if (dirname(workspaceRoot) !== resolve(tmpdir()) || !basename(workspaceRoot).startsWith('dsh-agent05-workspace-')) {
            throw new Error('Unexpected owned Workspace fixture path.')
          }
          await rm(workspaceRoot, { recursive: true, force: true })
        }
      }
    })()
    return closeTask
  }
  onTestFinished(close)
  const storeKey = 'agent05-' + randomUUID().replaceAll('-', '')
  await target.connection.execute('INSERT INTO dsh_stores (store_key,display_name,search_config_json) VALUES (?,?,?)',
    [storeKey, 'Agent 05 v3 acceptance', '{"ngramTokenSize":2,"stopwords":false,"extractorVersion":1}'])
  const [stores] = await target.connection.execute<RowDataPacket[]>('SELECT store_id FROM dsh_stores WHERE store_key=?', [storeKey])
  const storeId: unknown = stores[0]?.['store_id']
  if (typeof storeId !== 'string') throw new Error('New acceptance store has no exact identity.')
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-agent05-workspace-'))
  resources.workspaceRoot = workspaceRoot
  return { ...target, storeKey, storeId, workspaceRoot, close }
}

/** Start actual credential/MySQL/Session/Workspace/cache owners through a test-only cordis.yml.
 * @param target - Reviewed unique namespace; password never enters YAML or diagnostics.
 * @param options - Real network port and optional Workspace/projection composition.
 * @returns Context, acknowledgement controller and joined cleanup.
 */
export async function bootV3(target: Awaited<ReturnType<typeof newTarget>>,
  options: { port?: number; workspace?: boolean; registry?: boolean; projection?: boolean; reverse?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-agent05-v3-'))
  const ref = 'MYSQL_AGENT05_' + randomUUID().replaceAll('-', '').toUpperCase()
  const gate: { value?: AckGate } = {}
  const gates = new Set<AckGate>()
  let sqlCommands = 0
  const ctx = new Context()
  class ControlledMysql extends MysqlRuntime {
    override registerConsumer(drain: () => Promise<void>): MysqlConsumer {
      const scope = super.registerConsumer(drain)
      return { execute: (sql, params, signal) => { sqlCommands++; return scope.execute(sql, params, signal) },
        dispose: () => scope.dispose(),
        transaction: async <T>(work: (tx: MysqlExecutor) => Promise<T>, signal?: AbortSignal): Promise<T> => {
          let selected: AckGate | undefined
          const result = await scope.transaction(tx => work({ execute: (sql, params) => {
            sqlCommands++
            if (gate.value && sql.startsWith(gate.value.prefix)) { selected = gate.value; delete gate.value }
            return tx.execute(sql, params)
          } }), signal)
          if (selected) {
            try {
              selected.reached.resolve(undefined)
              await selected.release.promise
              if (selected.unknown) throw new MysqlError('transaction_unknown', 'Controlled acknowledgement loss after real SQL COMMIT.', 'unknown')
            } finally { gates.delete(selected) }
          }
          return result
        },
      }
    }
  }
  const modules = new Map<string, unknown>([
    ['credentials', CredentialsLocal], ['mysql', ControlledMysql], ['sessions', SessionStore], ['persistence', MysqlSessionPersistence],
    ['storage', Storage], ['domain', Domain], ['workspace-mysql', WorkspaceMysql], ['workspace', WorkspaceRegistry],
    ['json', JsonStorage],
    ['projections', SessionProjectionRegistry], ['projection-mysql', ProjectionMysql], ['cache', SessionProjectionCache],
  ])
  const config: Array<{ name: string; config?: unknown }> = [
    { name: 'credentials', config: { dshHome: home, watch: false } },
    { name: 'mysql', config: { host: '127.0.0.1', port: options.port ?? 11406, database: target.database, user: target.user,
      passwordRef: ref, schemaMode: 'verify', connectionLimit: 4, operationTimeoutMs: 10000 } },
    { name: 'sessions' }, { name: 'persistence', config: { storeKey: target.storeKey, leaseTtlMs: 180000, heartbeatIntervalMs: 60000 } },
  ]
  if (options.workspace) config.push({ name: 'storage' },
    { name: 'workspace-mysql', config: { storeKey: target.storeKey, backendName: 'mysql-workspace', leaseTtlMs: 30000, heartbeatIntervalMs: 10000 } },
    { name: 'domain', config: { backend: 'mysql-workspace' } })
  if (options.workspace && options.registry !== false) config.push({ name: 'workspace' })
  if (options.projection) config.push({ name: 'storage' }, { name: 'json', config: { root: join(home, 'native-domains') } },
    { name: 'domain', config: { backend: 'json' } },
    { name: 'projections' }, { name: 'projection-mysql', config: { storeKey: target.storeKey, maxEvents: 10000,
      maxInputBytes: 1048576, maxCheckpointBytes: 65536, maxUnits: 100, readPageSize: 17, maxPendingOperations: 32 } },
    { name: 'cache', config: { writeEveryEvents: 10000, writeIntervalMs: 60000, checkpointBackend: 'provider' } })
  if (options.reverse) {
    const mysql = config.splice(1, 1)[0]
    if (!mysql) throw new Error('Missing connection owner entry.')
    config.push(mysql)
  }
  const close = async (): Promise<void> => {
    for (const active of gates) active.release.resolve(undefined)
    try { await ctx.fiber.dispose() }
    finally {
      if (dirname(home) !== resolve(tmpdir()) || !basename(home).startsWith('dsh-agent05-v3-')) throw new Error('Unexpected owned fixture path.')
      await rm(home, { recursive: true, force: true })
    }
  }
  try {
    const seed = new Context()
    try {
      await seed.plugin(CredentialsLocal, { dshHome: home, watch: false })
      await seed.credentials.set(credentialRef(ref), target.password)
    }
    finally { await seed.fiber.dispose() }
    const path = join(home, 'cordis.yml')
    await writeFile(path, JSON.stringify(config))
    ctx.baseUrl = pathToFileURL(home).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const internal = ctx.loader.internal
    if (!internal) throw new Error('The actual Node Loader is absent.')
    ctx.loader.internal = new Proxy(internal, { get(owner, key) {
      if (key === 'import') return async (specifier: string) => {
        const module = modules.get(specifier)
        if (!module) throw new Error('Unexpected Agent 05 fixture module.')
        return module
      }
      const value: unknown = Reflect.get(owner, key, owner)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(owner) : value
    } })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) if (entry.fiber) await entry.fiber.await()
    if (!ctx.get('sessionPersistence') || !ctx.get('mysql') || (options.workspace && options.registry !== false && !ctx.get('workspaceRegistry'))
      || (options.projection && !ctx.get('sessionProjectionCache'))) throw new Error('The actual Agent 05 composition did not activate.')
    return { ctx, home, close, sqlCommands: () => sqlCommands,
      hold: (prefix: string, unknown = false): AckGate => {
        if (gate.value) throw new Error('An acknowledgement gate is already armed.')
        const value = { prefix, unknown, reached: Promise.withResolvers<undefined>(),
          release: Promise.withResolvers<undefined>() }
        gates.add(value)
        gate.value = value
        return value
      },
    }
  } catch (error) {
    try { await close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Agent 05 boot and cleanup failed.') }
    throw error
  }
}
