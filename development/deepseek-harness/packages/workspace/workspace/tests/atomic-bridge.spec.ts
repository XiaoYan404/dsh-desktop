/** Workspace-owned optional atomic mutation behavior, including its original pending-marker fallback. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { DomainAtomicPublicationError } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId, workspaceDomainState } from '@deepseek-ai/dsh-workspace'
import { BridgeFixtureError, BridgeUnit, bridgeHarness } from './helpers/atomic-bridge.ts'

it('keeps an undeclared backend on the exact original pending-mutation path', async () => {
  const host = await bridgeHarness(false)
  expect(host.unit.commitAtomic).toBeUndefined()
  expect(host.domain.mutateAtomic).toBeUndefined()
  const created = await host.registry.create(host.first, 'legacy unchanged')
  expect(host.unit.calls).toEqual(['setGlobal:create', 'putRecord', 'setGlobal:settled'])
  expect(host.changes).toHaveLength(3)
  expect(host.registry.list().map(value => value.id)).toEqual([created.id])
  await host.registry.delete(created.id)
  expect(host.unit.calls.slice(3)).toEqual(['setGlobal:delete', 'deleteRecord', 'setGlobal:settled'])
  expect(host.unit.atomicCalls).toBe(0)
  expect(host.registry.list()).toEqual([])
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const createStart = source.indexOf('    this.entities.set(id, entity)\n    const pendingState')
  const createEnd = source.indexOf('  private async deleteKnown', createStart)
  const deleteStart = source.indexOf('    const state = this.requireState()\n    const nextState = {')
  const deleteEnd = source.indexOf('  /**\n   * Complete the one mutation explicitly named by durable state.', deleteStart)
  expect(createStart >= 0 && createEnd > createStart && deleteStart >= 0 && deleteEnd > deleteStart).toBe(true)
  const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
  expect(sha(source.slice(createStart, createEnd))).toBe('0c11c87678ae3f372d5d6f7430e57c67b2844f708433ec0d07d66392a67f549f')
  expect(sha(source.slice(deleteStart, deleteEnd))).toBe('ba0fbfc1de6c60a8f9ad3a64a202216da94951abb41ca88adcfbd1a05fadc854')
})

it('publishes all Domain and Workspace caches only after one acknowledgement and before existing events', async () => {
  const host = await bridgeHarness(true), before = structuredClone(host.medium.snapshot)
  const views: Array<{ tableIds: string[]; globalIds: string[]; registryIds: string[] }> = []
  host.ctx.on('domain/changed', () => {
    views.push({ tableIds: [...host.domain.table('workspaces').keys()],
      globalIds: workspaceDomainState.parse(host.domain.global.get()).workspaceIds,
      registryIds: host.registry.list().map(value => value.id) })
  })
  const held = host.unit.holdCommit()
  const creating = host.registry.initializeDefault(async () => host.first)
  await held.entered.promise
  expect(host.registry.list()).toEqual([])
  expect(host.domain.table('workspaces').size).toBe(0)
  expect(workspaceDomainState.parse(host.domain.global.get()).workspaceIds).toEqual([])
  expect(host.medium.snapshot).toEqual(before)
  expect(host.changes).toEqual([])
  const queued = host.registry.create(host.second, 'queued after commit')
  held.release.resolve(undefined)
  const first = await creating, second = await queued
  if (!first) throw new Error('The staged real default Workspace was not created.')
  expect(host.unit.atomicCalls).toBe(2)
  expect(host.unit.calls).toEqual([])
  expect(host.changes.map(change => [change.table, change.operation])).toEqual([
    ['workspaces', 'put'], ['', 'put'], ['workspaces', 'put'], ['', 'put'],
  ])
  for (const view of views) {
    expect([...view.tableIds].sort()).toEqual([...view.globalIds].sort())
    expect(view.registryIds).toEqual(view.globalIds)
  }
  const deleting = host.unit.holdCommit(), beforeDelete = host.registry.list().map(value => value.id)
  const removal = host.registry.delete(first.id)
  await deleting.entered.promise
  expect(host.registry.list().map(value => value.id)).toEqual(beforeDelete)
  expect(host.registry.get(first.id)).toBe(first)
  deleting.release.resolve(undefined)
  expect(await removal).toBe(true)
  expect(host.registry.list().map(value => value.id)).toEqual([second.id])
  expect(workspaceDomainState.parse(host.domain.global.get()).defaultWorkspaceId).toBe(first.id)
  expect(host.changes.slice(4).map(change => [change.table, change.operation])).toEqual([['workspaces', 'deleted'], ['', 'put']])
  expect(host.changes.some(change => change.operation === 'put' && change.table === ''
    && workspaceDomainState.parse(change.value).pendingMutation !== undefined)).toBe(false)
  for (const view of views) expect(view.registryIds).toEqual(view.globalIds)
})

it('fences rejection, lost acknowledgement and stale CAS without fallback, retry or false cache publication', async () => {
  for (const mode of ['rejected', 'ack-lost', 'stale'] as const) {
    const host = await bridgeHarness(true), before = structuredClone(host.medium.snapshot)
    const oldGlobal = host.domain.global.get()
    const failure = new BridgeFixtureError(mode, mode === 'ack-lost' ? 'unknown' : 'not-committed')
    if (mode === 'stale') {
      const concurrent = new BridgeUnit(host.medium, true)
      await concurrent.loadAll()
      if (!concurrent.commitAtomic) throw new Error('The independent concurrent unit lacks its explicit capability.')
      await concurrent.commitAtomic({ records: [], global: { value: { ...workspaceDomainState.parse(oldGlobal), initialized: false } } })
      await concurrent.close()
    } else { host.unit.failure = { phase: mode === 'ack-lost' ? 'after' : 'before', error: failure } }
    const result = await host.registry.create(host.first).then(value => ({ value }), (error: unknown) => ({ error }))
    if (!('error' in result)) throw new Error('An unconfirmed atomic Workspace mutation falsely succeeded.')
    const error = result.error
    expect(error).toBeInstanceOf(BridgeFixtureError)
    expect(error).toMatchObject({ code: mode })
    if (mode !== 'stale') expect(error).toBe(failure)
    expect(host.changes).toEqual([])
    expect(oldGlobal).toEqual(before.global)
    expect(host.unit.atomicCalls).toBe(1)
    expect(host.unit.calls).toEqual([])
    if (mode === 'ack-lost') expect(Object.keys(host.medium.snapshot.tables['workspaces'] ?? {})).toHaveLength(1)
    if (mode === 'rejected') expect(host.medium.snapshot).toEqual(before)
    expect(() => host.registry.list()).toThrow(error)
    expect(() => host.domain.global.get()).toThrow(error)
    await expect(host.registry.create(host.second)).rejects.toBe(error)
    await expect(host.domain.table('workspaces').put('queued-after-fault', {})).rejects.toBe(error)
    expect(host.unit.atomicCalls).toBe(1)
    expect(host.unit.calls).toEqual([])
  }
  const host = await bridgeHarness(true), atomic = host.domain.mutateAtomic
  if (!atomic) throw new Error('The publication case requires the explicitly declared capability.')
  const primary = new Error('owned cache publisher failure')
  const changedGlobal = { ...workspaceDomainState.parse(host.domain.global.get()), defaultWorkspaceId: WorkspaceId('committed identity') }
  const result = await atomic(() => ({ mutation: { records: [], global: { value: changedGlobal } }, value: changedGlobal }),
    () => { throw primary }).then(value => ({ value }), (error: unknown) => ({ error }))
  if (!('error' in result) || !(result.error instanceof DomainAtomicPublicationError)) throw new Error('Committed publication failure was lost.')
  expect(result.error.committed).toBe(true)
  expect(result.error.failures).toEqual([primary])
  expect(host.medium.snapshot.global).toEqual(changedGlobal)
  expect(host.changes).toHaveLength(1)
  expect(() => host.domain.global.get()).toThrow(result.error)
  expect(host.unit.atomicCalls).toBe(1)
})
