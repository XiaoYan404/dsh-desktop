/** Retirement keeps failures joinable and releases SQL after synchronous upstream failures. */
import { expect, it, vi } from 'vitest'
import { createWorkspaceRetirement } from '../src/retirement.ts'

it('retains a synchronous admission-fence failure while outer close still disposes its SQL scope', async () => {
  const failure = new Error('Controlled admission fence failure.')
  const disposeScope = vi.fn(async () => {})
  const retirement = createWorkspaceRetirement({ closeBackend: async (_name, close) => { await close() } }, 'workspace', {
    stopOpening: () => { throw failure }, closeUnits: async () => {}, disposeScope,
  })
  const retiring = retirement.retire()
  expect(retirement.retire()).toBe(retiring)
  await expect(retiring).rejects.toBe(failure)
  const closing = retirement.close()
  expect(retirement.close()).toBe(closing)
  await expect(closing).rejects.toMatchObject({ errors: [failure] })
  expect(disposeScope).toHaveBeenCalledTimes(1)
})

it('memoizes retirement before a synchronous callback can re-enter it', async () => {
  let reentered: Promise<void> | undefined
  const retirement = createWorkspaceRetirement({ closeBackend: async (_name, close) => { await close() } }, 'workspace', {
    stopOpening: () => { reentered = retirement.retire() }, closeUnits: async () => {}, disposeScope: async () => {},
  })
  const retiring = retirement.retire()
  expect(reentered).toBe(retiring)
  await retirement.close()
})
