/** Provider identity is checked before SQL; these are configuration tests, not database acceptance. */
import { Context } from '@deepseek-ai/cordis'
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { expect, it } from 'vitest'
import { requireMysqlSearchPersistence } from '../src/binding.ts'

class OtherPersistence extends SessionPersistence {
  override readonly name = 'session-persistence-mysql'
  readonly config = { storeKey: 'same-spelling' }
  create(): Promise<never> { throw new Error('The rejected provider must not be read or written') }
  open(): Promise<never> { throw new Error('The rejected provider must not be read or written') }
  flush(): Promise<void> { throw new Error('The rejected provider must not be read or written') }
  stat(): Promise<undefined> { throw new Error('The rejected provider must not be read or written') }
  list(): Promise<never[]> { throw new Error('The rejected provider must not be read or written') }
}

it('rejects missing persistence before any search SQL resource is acquired', () => {
  expect(() => requireMysqlSearchPersistence(undefined, 'selected-store')).toThrow(expect.objectContaining({
    code: 'SESSION_QUERY_INVALID_CONFIG',
  }))
})

it('rejects another provider even when its name and namespace spelling match MySQL', async () => {
  const ctx = new Context()
  try {
    const persistence = new OtherPersistence(ctx)
    expect(() => requireMysqlSearchPersistence(persistence, 'same-spelling')).toThrow(expect.objectContaining({
      code: 'SESSION_QUERY_INVALID_CONFIG',
    }))
  } finally { await ctx.fiber.dispose() }
})
