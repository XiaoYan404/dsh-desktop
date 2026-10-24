/** Infrastructure diagnostics retain their cause without entering model-visible errors; expected business outcomes remain unchanged. */
import { expect, it } from 'vitest'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { officeBffRequest } from '../src/driver.ts'

it('preserves exact successful and denied BFF outcomes without treating a business denial as an infrastructure failure', async () => {
  for (const outcome of [{ ok: true, value: { id: 'item' } }, { ok: false, code: 'forbidden' }]) {
    expect(await officeBffRequest(() => Promise.resolve(outcome))).toBe(outcome)
  }
})

it('retains an unexpected private cause while exposing only a stable failure and safe next action', async () => {
  const cause = new Error('Bearer private-provider-secret')
  try {
    await officeBffRequest(() => Promise.reject(cause))
    expect.unreachable('Expected an office infrastructure failure')
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error
    expect(error.code).toBe('OFFICE_SERVICE_UNAVAILABLE')
    expect(error.cause).toBe(cause)
    expect(error.message).not.toContain('private-provider-secret')
    expect(error.message).toContain('check the original operation outcome before retrying')
  }
})
