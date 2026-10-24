/** Real Loader-owned listener shared only by the new first-password invitation HTTP and Host tests. */
import type { Config as OfficeConfig } from '@deepseek-ai/dsh-enterprise-office'
import OfficeGateway from '../src/index.ts'
import { createMemberInviteFixture, inviteAdmin } from '../../office/tests/member-invite-fixture.ts'

/**
 * Bind one private central service and let its original Loader lifecycle own the listener and storage.
 * @param config - Optional complete Office configuration override.
 * @param attempts - Explicit independent login and invitation-accept budgets per source address.
 * @returns Actual loopback address and the original fixture's storage and lifecycle handles.
 */
export async function createMemberInviteGateway(config?: Partial<OfficeConfig>, attempts = 100) {
  const fixture = await createMemberInviteFixture(config)
  const { ctx } = fixture
  ctx.loader.builtins.inviteGateway = OfficeGateway
  await ctx.loader.create({ name: 'cordis:inviteGateway', config: {
    host: '127.0.0.1', port: 0, administratorId: inviteAdmin, loginRequestsPerMinute: attempts,
  } })
  await ctx.loader.await()
  const address = ctx.officeGateway.address
  if (!address) throw new Error('Real invitation gateway did not bind')
  return { ...fixture, address }
}

/**
 * Send a fixture-owned JSON request without browser origins or any automatic session behavior.
 * @param address - Actual owned loopback listener.
 * @param path - Fixed route selected by this test.
 * @param value - Explicit JSON body.
 * @param token - Optional real sign-in receipt for administrator RPC calls.
 * @returns The actual HTTP response for status, header and body assertions.
 */
export function postMemberInvite(address: string, path: string, value: unknown, token?: string): Promise<Response> {
  return fetch(new URL(path, address), { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...token ? { Authorization: `Bearer ${token}` } : {} },
    body: JSON.stringify(value) })
}
