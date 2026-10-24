/** Late terminal allocation must recheck employee authority before publishing its process or metadata. */
import { expect, it } from 'vitest'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { alice } from './native-jobs-harness.host.ts'
import { nativeTerminalFixture } from './native-terminal-harness.host.ts'

const admin = 'admin' as OfficeMemberId
const request = { id: 'late-allocation' as WebTerminalId, cols: 80, rows: 24 }
const signal = (): AbortSignal => new AbortController().signal

async function downgrade(fixture: Awaited<ReturnType<typeof nativeTerminalFixture>>): Promise<void> {
  const member = fixture.central.office.view(admin).members.find(value => value.id === alice)
  if (member === undefined) throw new Error('Fixture employee is missing')
  await fixture.central.office.saveMember(admin, { ...member, role: 'employee' }, member)
}

it('rejects and releases an Office terminal allocated after its employee is downgraded', async () => {
  const fixture = await nativeTerminalFixture()
  const { ctx, runtime, agent } = fixture
  const creating = ctx.terminalController.create(agent, request, signal()).then(
    value => ({ accepted: true as const, value }), (error: unknown) => ({ accepted: false as const, error }),
  )
  try {
    await runtime.allocated.promise
    const handle = runtime.handle
    if (handle === undefined) throw new Error('Fixture allocation is missing')
    const sequence = fixture.session.seq
    expect(() => process.kill(handle.pid, 0)).not.toThrow()
    await downgrade(fixture)
    runtime.release.resolve(undefined)
    const result = await creating
    expect(result).toMatchObject({ accepted: false, error: { code: 'session/not-found' } })
    expect(runtime.terminations).toBe(1)
    const outcome = await handle.done
    expect(outcome.exitCode !== null || outcome.signal !== null).toBe(true)
    expect(() => process.kill(handle.pid, 0)).toThrow()
    // A restored role requires a new login before inspecting the registry; the rejected request stays settled.
    const member = fixture.central.office.view(admin).members.find(value => value.id === alice)
    if (member === undefined) throw new Error('Fixture employee is missing')
    await fixture.central.office.saveMember(admin, { ...member, role: 'manager' }, member)
    await fixture.signIn(alice)
    expect(await ctx.terminalController.list(agent.id, signal())).toEqual([])
    expect(fixture.session.seq).toBe(sequence)
  } finally {
    runtime.release.resolve(undefined)
    await creating
  }
})

it('keeps an unassociated Native terminal allocation valid across the same employee downgrade', async () => {
  const fixture = await nativeTerminalFixture()
  const { ctx, runtime } = fixture
  const native = ctx.sessions.create()
  const agent = await fixture.register(native)
  const creating = ctx.terminalController.create(agent, request, signal())
  try {
    await runtime.allocated.promise
    const sequence = native.seq
    await downgrade(fixture)
    runtime.release.resolve(undefined)
    expect(await creating).toMatchObject({ id: request.id, cwd: fixture.cwd, state: 'running' })
    expect(runtime.terminations).toBe(0)
    expect(native.seq).toBe(sequence)
    await ctx.terminalController.close(agent, request.id)
    expect(runtime.terminations).toBe(1)
    expect(await ctx.terminalController.list(native.id, signal())).toEqual([])
  } finally {
    runtime.release.resolve(undefined)
    await creating
  }
})
