/** Wrong Host providers and namespaces fail before flushing or opening projection SQL. */
import { Context } from '@deepseek-ai/cordis'
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished, vi } from 'vitest'
import { requireMysqlProjectionPersistence } from '../src/persistence.ts'

class UnownedPersistence extends SessionPersistence {
  async create(): Promise<never> { throw new Error('No Session creation belongs to configuration validation.') }
  async open(): Promise<never> { throw new Error('No Session open belongs to configuration validation.') }
  flush = vi.fn(async () => {})
  async stat(): Promise<undefined> { return undefined }
  async list(): Promise<[]> { return [] }
}
class MysqlOwnedPersistence extends UnownedPersistence {
  readonly mysqlStoreKey = 'owned-store'
  ownsMysqlWriter(): boolean { return false }
}

async function boot(provider: typeof UnownedPersistence) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(provider)
  const persistence = ctx.sessionPersistence
  const flush = vi.spyOn(persistence, 'flush')
  return { persistence, flush }
}

it('refuses a non-MySQL Host provider without flushing it', async () => {
  const { persistence, flush } = await boot(UnownedPersistence)
  expect(() => requireMysqlProjectionPersistence(persistence, 'owned-store')).toThrow(
    expect.objectContaining({ code: 'configuration' }))
  expect(flush).not.toHaveBeenCalled()
})

it('refuses a different MySQL namespace without observing or flushing the other store', async () => {
  const { persistence, flush } = await boot(MysqlOwnedPersistence)
  expect(() => requireMysqlProjectionPersistence(persistence, 'other-store')).toThrow(
    expect.objectContaining({ code: 'configuration' }))
  expect(flush).not.toHaveBeenCalled()
})

it('keeps the exact configured Host instance without claiming writer ownership or lease validity', async () => {
  const { persistence, flush } = await boot(MysqlOwnedPersistence)
  const owned = requireMysqlProjectionPersistence(persistence, 'owned-store')
  expect(owned).toBe(persistence)
  expect(owned.mysqlStoreKey).toBe('owned-store')
  expect(flush).not.toHaveBeenCalled()
})
