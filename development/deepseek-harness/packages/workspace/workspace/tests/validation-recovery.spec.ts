/** Declared pre-IO refusals leave real Domain/Registry caches usable; uncertain or committed failures still freeze. */
import { expect, it, vi } from 'vitest'
import { StorageMutationValidationError } from '@deepseek-ai/dsh-storage'
import { DomainAtomicPublicationError } from '@deepseek-ai/dsh-storage-domain'
import { workspaceDomainState, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { bridgeHarness } from './helpers/atomic-bridge.ts'

it('keeps the old registry visible while an already queued corrected create waits for its own acknowledgement', async () => {
  const host = await bridgeHarness(true, (unit) => { vi.spyOn(unit, 'commitAtomic') })
  const original = await host.registry.create(host.first, 'original')
  const before = structuredClone(host.medium.snapshot)
  host.changes.length = 0
  const cause = new Error('Controlled input validation failure before IO.')
  const refusal = new StorageMutationValidationError(cause)
  const commit = vi.mocked(host.unit.commitAtomic)
  if (!commit) throw new Error('The explicit commit fault hook is absent.')
  commit.mockClear()
  commit.mockRejectedValueOnce(refusal)
  const held = host.unit.holdCommit()
  const rejected = host.registry.create(host.second, 'refused')
  const corrected = host.registry.create(host.second, 'corrected').then(value => ({ value }), (error: unknown) => ({ error }))
  await expect(rejected).rejects.toBe(refusal)
  const reached = await Promise.race([held.entered.promise.then(() => ({ entered: true })), corrected])
  if ('error' in reached) throw reached.error
  expect(reached).toEqual({ entered: true })
  expect(refusal.cause).toBe(cause)
  expect(host.medium.snapshot).toEqual(before)
  expect(host.registry.list().map(item => item.id)).toEqual([original.id])
  expect(original.title).toBe('original')
  expect([...host.domain.table('workspaces').keys()]).toEqual([original.id])
  expect(host.domain.global.get()).toEqual(before.global)
  expect(host.changes).toEqual([])
  held.release.resolve(undefined)
  const result = await corrected
  if ('error' in result) throw result.error
  expect(host.registry.get(result.value.id)?.title).toBe('corrected')
  expect(host.registry.list()).toHaveLength(2)
  expect(commit).toHaveBeenCalledTimes(2)
  expect(host.unit.atomicCalls).toBe(2)
  expect(host.changes).toHaveLength(2)
})

it('keeps a refused deletion visible and lets the queued corrected deletion publish after ACK', async () => {
  const host = await bridgeHarness(true, (unit) => { vi.spyOn(unit, 'commitAtomic') })
  const original = await host.registry.create(host.first, 'retained')
  const before = structuredClone(host.medium.snapshot)
  host.changes.length = 0
  const commit = vi.mocked(host.unit.commitAtomic)
  if (!commit) throw new Error('The explicit commit fault hook is absent.')
  commit.mockRejectedValueOnce(new StorageMutationValidationError(new Error('Invalid delete plan.')))
  const held = host.unit.holdCommit()
  const rejected = host.registry.delete(original.id)
  const corrected = host.registry.delete(original.id).then(value => ({ value }), (error: unknown) => ({ error }))
  await expect(rejected).rejects.toBeInstanceOf(StorageMutationValidationError)
  const reached = await Promise.race([held.entered.promise.then(() => ({ entered: true })), corrected])
  if ('error' in reached) throw reached.error
  expect(reached).toEqual({ entered: true })
  expect(host.registry.get(original.id)).toBe(original)
  expect(original.title).toBe('retained')
  expect(host.medium.snapshot).toEqual(before)
  expect(host.changes).toEqual([])
  held.release.resolve(undefined)
  const result = await corrected
  if ('error' in result) throw result.error
  expect(result.value).toBe(true)
  expect(host.registry.list()).toEqual([])
  expect(workspaceDomainState.parse(host.domain.global.get()).defaultWorkspaceId)
    .toBe(workspaceDomainState.parse(before.global).defaultWorkspaceId)
  expect(host.changes).toHaveLength(2)
})

it('retains a held Entity after ordinary put validation and publishes a queued corrected title only after ACK', async () => {
  const host = await bridgeHarness(true)
  const original = await host.registry.create(host.first, 'before')
  const before = structuredClone(host.medium.snapshot)
  host.changes.length = 0
  const write = host.unit.putRecord.bind(host.unit)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const refusal = new StorageMutationValidationError(new Error('Invalid title representation.'))
  vi.spyOn(host.unit, 'putRecord').mockRejectedValueOnce(refusal).mockImplementationOnce(async (table, key, value) => {
    entered.resolve(undefined)
    await release.promise
    await write(table, key, value)
  })
  const rejected = original.setTitle('refused')
  const corrected = original.setTitle('after').then(() => ({}), (error: unknown) => ({ error }))
  try {
    await expect(rejected).rejects.toBe(refusal)
    const reached = await Promise.race([entered.promise.then(() => ({ entered: true })), corrected])
    if ('error' in reached) throw reached.error
    expect(reached).toEqual({ entered: true })
    expect(original.title).toBe('before')
    expect(host.registry.get(original.id)).toBe(original)
    expect(host.domain.table('workspaces').get(original.id)).toEqual(before.tables['workspaces']?.[original.id])
    expect(host.medium.snapshot).toEqual(before)
    expect(host.changes).toEqual([])
  } finally { release.resolve(undefined) }
  const result = await corrected
  if ('error' in result) throw result.error
  expect(original.title).toBe('after')
  expect(host.changes).toHaveLength(1)
})

it('keeps the acknowledged global available after an ordinary validation refusal and accepts the next valid set', async () => {
  const host = await bridgeHarness(true)
  const before = structuredClone(host.domain.global.get())
  const refusal = new StorageMutationValidationError(new Error('Invalid global representation.'))
  const set = vi.spyOn(host.unit, 'setGlobal').mockRejectedValueOnce(refusal)
  await expect(host.domain.global.set(before)).rejects.toBe(refusal)
  expect(host.domain.global.get()).toEqual(before)
  expect(host.registry.list()).toEqual([])
  expect(host.changes).toEqual([])
  await host.domain.global.set(before)
  expect(set).toHaveBeenCalledTimes(2)
  expect(host.medium.snapshot.global).toEqual(before)
  expect(host.changes).toHaveLength(1)
})

it('still freezes raw not-started errors and errors with forged validation fields without replacing their identity', async () => {
  const failures = [Object.assign(new Error('Transport refused.'), { code: 'connection_unavailable', outcome: 'not-started' }),
    Object.assign(new Error('Untrusted validation classification.'), {
      name: 'StorageMutationValidationError', code: 'invalid-mutation', outcome: 'not-started',
    })]
  for (const failure of failures) {
    const host = await bridgeHarness(true, (unit) => { vi.spyOn(unit, 'commitAtomic') })
    const original = await host.registry.create(host.first, 'held')
    const before = structuredClone(host.medium.snapshot)
    host.changes.length = 0
    const commit = vi.mocked(host.unit.commitAtomic)
    if (!commit) throw new Error('The explicit commit fault hook is absent.')
    commit.mockClear()
    commit.mockRejectedValueOnce(failure)
    await expect(host.registry.create(host.second)).rejects.toBe(failure)
    expect(host.medium.snapshot).toEqual(before)
    expect(host.changes).toEqual([])
    expect(() => host.registry.list()).toThrow(failure)
    expect(() => original.title).toThrow(failure)
    expect(() => host.domain.global.get()).toThrow(failure)
    await expect(host.registry.create(host.second)).rejects.toBe(failure)
    expect(commit).toHaveBeenCalledTimes(1)
  }
})

it('wraps a validation error thrown by an ACKed publisher as committed publication failure and freezes reads', async () => {
  const host = await bridgeHarness(true)
  const mutation = host.domain.mutateAtomic
  if (!mutation) throw new Error('The explicit atomic capability is absent.')
  const target = { ...workspaceDomainState.parse(host.domain.global.get()), defaultWorkspaceId: WorkspaceId('committed') }
  const cause = new StorageMutationValidationError(new Error('Publisher defect after backend ACK.'))
  const failure: unknown = await mutation(() => ({ mutation: { records: [], global: { value: target } }, value: target }),
    () => { throw cause }).then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(DomainAtomicPublicationError)
  expect(failure).toMatchObject({ committed: true, failures: [cause] })
  expect(host.medium.snapshot.global).toEqual(target)
  expect(() => host.registry.list()).toThrow(DomainAtomicPublicationError)
  expect(() => host.domain.global.get()).toThrow(DomainAtomicPublicationError)
})
