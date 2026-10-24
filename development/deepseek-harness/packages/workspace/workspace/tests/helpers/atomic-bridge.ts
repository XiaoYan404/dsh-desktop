/** Workspace-owned KV protocol peer; it exercises real Domain/Workspace classes without a database. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvAtomicMutation, KvUnit } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import WorkspaceRegistry, { workspaceDomainState } from '@deepseek-ai/dsh-workspace'

/** Shared simulated durable medium; unlike a product provider, it deliberately stores the public KV unit vocabulary. */
export interface BridgeMedium {
  revision: bigint
  snapshot: { tables: Record<string, Record<string, unknown>>; global: unknown }
}

/** Local protocol errors distinguish unknown acknowledged transport from definite refusal without reading text. */
export class BridgeFixtureError extends Error {
  override readonly name = 'BridgeFixtureError'
  /** @param code - Injected protocol failure. @param outcome - Whether this fixture published its durable medium. */
  constructor(readonly code: 'rejected' | 'stale' | 'ack-lost', readonly outcome: 'not-committed' | 'unknown') { super(code) }
}

/** Controllable opened unit, including a truthful absence of commitAtomic on legacy instances. */
export class BridgeUnit implements KvUnit {
  readonly commitAtomic?: (mutation: KvAtomicMutation) => Promise<void>
  readonly calls: string[] = []
  atomicCalls = 0
  closed = false
  private expected: bigint
  private pause: { entered: PromiseWithResolvers<undefined>; release: PromiseWithResolvers<undefined> } | undefined
  failure: { phase: 'before' | 'after'; error: Error } | undefined

  /** @param medium - This scenario's private durable peer. @param atomic - Whether the unit explicitly promises batch transactions. */
  constructor(readonly medium: BridgeMedium, atomic: boolean) {
    this.expected = medium.revision
    if (atomic) this.commitAtomic = mutation => this.commit(mutation)
  }
  /** @returns A controlled pending acknowledgement, whose owner must release it even on test failure. */
  holdCommit() {
    const state = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() }
    this.pause = state
    return state
  }
  /** Release only this fixture's held operation during failure cleanup. */
  releasePending(): void { this.pause?.release.resolve(undefined) }
  private assertActive(): void { if (this.closed) throw new Error('Owned bridge unit is closed.') }
  /** @returns An independently cloned medium snapshot. */
  async loadAll() { this.assertActive(); this.expected = this.medium.revision; return structuredClone(this.medium.snapshot) }
  /** @param table - Declared fixture table. @param key - Record key. @param value - Typed consumer value. */
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertActive(); this.calls.push('putRecord')
    const records = this.medium.snapshot.tables[table]
    if (!records) throw new Error('Undeclared bridge table.')
    records[key] = structuredClone(value); this.expected = ++this.medium.revision
  }
  /** @param table - Declared fixture table. @param key - Record key. */
  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertActive(); this.calls.push('deleteRecord')
    const records = this.medium.snapshot.tables[table]
    if (!records) throw new Error('Undeclared bridge table.')
    Reflect.deleteProperty(records, key); this.expected = ++this.medium.revision
  }
  /** @param value - Whole declared global value. */
  async setGlobal(value: unknown): Promise<void> {
    this.assertActive()
    const state = workspaceDomainState.parse(value)
    this.calls.push('setGlobal:' + (state.pendingMutation?.operation ?? 'settled'))
    this.medium.snapshot.global = structuredClone(value); this.expected = ++this.medium.revision
  }
  /** Caller has already drained the Domain; no unrelated resource is owned by this peer. */
  async close(): Promise<void> { this.closed = true }
  private async commit(mutation: KvAtomicMutation): Promise<void> {
    this.assertActive(); this.atomicCalls++
    const held = this.pause
    if (held) { held.entered.resolve(undefined); await held.release.promise; this.pause = undefined }
    if (this.failure?.phase === 'before') throw this.failure.error
    if (this.medium.revision !== this.expected) throw new BridgeFixtureError('stale', 'not-committed')
    const next = structuredClone(this.medium.snapshot)
    for (const change of mutation.records) {
      const records = next.tables[change.table]
      if (!records) throw new Error('Undeclared atomic bridge table.')
      if (change.operation === 'put') records[change.key] = structuredClone(change.value)
      else Reflect.deleteProperty(records, change.key)
    }
    if (mutation.global) next.global = structuredClone(mutation.global.value)
    this.medium.snapshot = next; this.medium.revision++
    if (this.failure?.phase === 'after') throw this.failure.error
    this.expected = this.medium.revision
  }
}

/** Real SessionPersistence fixture provider; Workspace's required history dependency is never replaced by a typed object cast. */
class EmptyHistory extends SessionPersistence {
  async create(): Promise<SessionHandle> { throw new Error('Bridge tests cannot create Sessions.') }
  async open(): Promise<SessionHandle> { throw new Error('Bridge tests cannot read event bodies.') }
  async flush(): Promise<void> {}
  async stat(): Promise<SessionPersistenceSnapshot | undefined> { return undefined }
  async list(): Promise<readonly SessionPersistenceSnapshot[]> { return [] }
}

/**
 * Mount real Storage/Domain/Workspace services around a controllable transaction peer.
 * @param atomic - Whether this unit declares the optional capability.
 * @param configure - Optional protocol fault setup before Domain captures its atomic commit callback.
 * @returns Real registry, Domain facility, owned directories, observations and medium; teardown is registered immediately.
 */
export async function bridgeHarness(atomic: boolean, configure?: (unit: BridgeUnit) => void) {
  const owner = resolve(tmpdir()), root = await mkdtemp(join(owner, 'dsh-workspace-atomic-'))
  const medium: BridgeMedium = { revision: 0n, snapshot: { tables: { workspaces: {} },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] } } }
  const unit = new BridgeUnit(medium, atomic), ctx = new Context()
  onTestFinished(async () => {
    const failures: unknown[] = []
    unit.releasePending()
    try { await ctx.fiber.dispose() } catch (error) { failures.push(error) }
    try { await unit.close() } catch (error) { failures.push(error) }
    try {
      if (dirname(root) !== owner || !basename(root).startsWith('dsh-workspace-atomic-')) throw new Error('Unexpected owned bridge directory.')
      await rm(root, { recursive: true, force: true })
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Bridge fixture cleanup failures')
  })
  configure?.(unit)
  await ctx.plugin(Storage)
  ctx.effect(() => ctx.storage.backend.register('bridge', { kv: { open: async () => unit }, close: () => unit.close() }))
  const facility = new DomainFacility(ctx, { backend: 'bridge', routes: {} })
  ctx.effect(() => ctx.storage.mount('domain', facility))
  ctx.provide('storageDomain', facility)
  ctx.effect(() => () => facility.closeAll())
  await ctx.plugin(EmptyHistory)
  await ctx.plugin(SessionStore)
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  await ctx.plugin(WorkspaceRegistry)
  const domain = facility.get('workspace')
  if (!domain) throw new Error('The real staged Workspace Domain did not open.')
  const first = join(root, 'first'), second = join(root, 'second')
  await mkdir(first); await mkdir(second)
  return { root, first, second, ctx, unit, medium, domain, facility, changes, registry: ctx.workspaceRegistry }
}
