/** Optional Remote getter failures leave the ordinary connection usable and produce no detached rejection. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnection, OfficeOutcome } from '../src/types.ts'
import { OfficeConnectionModel } from '../src/client/connection-model.ts'

type Remote = ConstructorParameters<typeof OfficeConnectionModel>[0]
function success<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
const local: OfficeConnection = { mode: 'local', gateway: null, connected: true, member: null, expiresAt: null }
const gateway: OfficeConnection = { mode: 'gateway', gateway: 'https://getter-fixture.example.invalid/',
  connected: false, member: null, expiresAt: null }

function fixture(connection: OfficeConnection) {
  const getter = vi.fn<() => NonNullable<Remote['memberInviteCapability']>>(() => {
    throw new Error('Optional Remote property is unavailable')
  })
  const remote: Remote = {
    connection: vi.fn<Remote['connection']>().mockResolvedValue(success(connection)),
    signIn: vi.fn<Remote['signIn']>(), signOut: vi.fn<Remote['signOut']>(),
    identitySessions: vi.fn<Remote['identitySessions']>(), revokeIdentitySession: vi.fn<Remote['revokeIdentitySession']>(),
    changeIdentityPassword: vi.fn<Remote['changeIdentityPassword']>(), identityOverview: vi.fn<Remote['identityOverview']>(),
    setIdentityPassword: vi.fn<Remote['setIdentityPassword']>(),
    get memberInviteCapability() { return getter() },
  }
  const notify = vi.fn()
  const model = new OfficeConnectionModel(remote, vi.fn(), notify)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  onTestFinished(() => {
    model.dispose()
    process.off('unhandledRejection', onUnhandled)
  })
  return { model, getter, notify, unhandled }
}

async function settleDetachedDiscovery(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

it('does not resolve an optional invitation capability getter for a local connection', async () => {
  const { model, getter, notify, unhandled } = fixture(local)
  await model.load()
  await model.load()
  await settleDetachedDiscovery()
  expect(getter).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ connection: local, loading: false, busy: false,
    error: null, memberInvitations: null })
  expect(notify).not.toHaveBeenCalled()
  expect(unhandled).toEqual([])
})

it('contains a throwing gateway capability getter without a sign-in error or unhandled rejection', async () => {
  const { model, getter, notify, unhandled } = fixture(gateway)
  await expect(model.load()).resolves.toBeUndefined()
  await settleDetachedDiscovery()
  expect(getter).toHaveBeenCalledOnce()
  expect(model.state.getSnapshot()).toMatchObject({ connection: gateway, loading: false, busy: false,
    error: null, memberInvitations: null })
  expect(notify).not.toHaveBeenCalled()
  expect(unhandled).toEqual([])
})
