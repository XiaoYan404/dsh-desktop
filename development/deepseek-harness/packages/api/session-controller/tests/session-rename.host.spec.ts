/**
 * Session Controller rename delegation through the composed SessionTitleService. The
 * agent factory is a structural stub whose createAgent forwards seed/meta into
 * the real SessionStore, and whose resume never runs (every source here is
 * already attached). Cold-session resolution is the shared `agentFor` path —
 * remote-proxy-cold.spec.ts owns the resume evidence for every unary that rides
 * it, rename included.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createSessionTestRemote } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

function request<P>(payload: P): P {
  return payload
}

async function composed(withTitles = true): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  if (withTitles) {
    await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 40 })
  }
  // Store-backed structural factory: create builds the session with the
  // forwarded seed/meta (the store validates the balanced prefix) and
  // registers an idle agent stub over it.
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
      await ctx.agents.register(agent)
      return Promise.resolve({ agent, dispose: () => Promise.resolve() })
    },
    resume: () => Promise.reject(new Error('resume must not run: every source is attached')),
  })
  return ctx
}

/** Register one live agent whose log holds `turns` completed turns. */
async function liveAgent(ctx: Context, id: string, turns: number): Promise<Session> {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const remote = (ctx: Context) => createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

describe('sessions.rename', () => {
  it('rejects hidden targets before resolving an Agent or appending a title', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'hidden-rename', 1)
    const api = remote(ctx)
    const before = source.seq
    const rename = vi.spyOn(ctx.sessionTitle, 'rename')
    const resolve = vi.spyOn(ctx.agents, 'resume')
    ctx.on('api-session/visible', () => Promise.resolve([]))
    expect(await api.rename({ sessionId: source.id, title: 'Forbidden title' }))
      .toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    expect(await api.rename({ sessionId: sid('hidden-cold-rename'), title: 'Forbidden cold title' }))
      .toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    expect(source.seq).toBe(before)
    expect(rename).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('rechecks visibility after asynchronous Agent resolution before appending a title', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'late-hidden-rename', 1)
    const api = remote(ctx)
    const before = source.seq
    let allowed = true
    ctx.on('api-session/visible', (_payload, next) => allowed ? next() : Promise.resolve([]))
    const get = ctx.agents.get.bind(ctx.agents)
    vi.spyOn(ctx.agents, 'get').mockImplementation((id) => {
      const agent = get(id)
      if (id === source.id) allowed = false
      return agent
    })
    expect(await api.rename({ sessionId: source.id, title: 'Late forbidden title' }))
      .toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    expect(allowed).toBe(false)
    expect(source.seq).toBe(before)
    await ctx.fiber.dispose()
  })

  it('preserves the log when a visibility provider fails', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'rename-policy-failure', 1)
    const api = remote(ctx)
    const before = source.seq
    ctx.on('api-session/visible', () => Promise.reject(new Error('Expected visibility failure')))
    expect(await api.rename({ sessionId: source.id, title: 'Failed policy title' }))
      .toMatchObject({ ok: false, error: { code: 'gateway/internal', message: 'Expected visibility failure' } })
    expect(source.seq).toBe(before)
  })

  it('withholds a delayed rename after the controller unloads', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'rename-unloaded', 1)
    const api = remote(ctx)
    const rename = vi.spyOn(ctx.sessionTitle, 'rename')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    ctx.on('api-session/visible', async (_payload, next) => {
      const result = await next()
      entered.resolve(undefined)
      await release.promise
      return result
    })
    const pending = api.rename({ sessionId: source.id, title: 'Unloaded title' })
    await entered.promise
    await ctx.fiber.dispose()
    release.resolve(undefined)
    expect(await pending).toMatchObject({ ok: false })
    expect(rename).not.toHaveBeenCalled()
  })

  it('accepts through the composed title service: normalized user-source event, echoed seq', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-rename', 1)

    const renamed = await remote(ctx).rename(request({ sessionId: source.id, title: '  new   name  ' }))
    expect(renamed.ok).toBe(true)
    if (!renamed.ok) return
    expect(renamed.value.title).toBe('new name')
    const event = source.snapshotEvents().findLast(item => item.type === 'session/title')
    expect(event?.seq).toBe(renamed.value.seq)
    expect(event?.data).toMatchObject({ title: 'new name', source: { kind: 'user' } })
  })

  it('maps only an empty-normalizing title to title-invalid, with a presentable message', async () => {
    const ctx = await composed()
    const source = await liveAgent(ctx, 'session-rename-bad', 1)

    // U+200B passes a client-side trim gate but normalizes to empty host-side.
    const response = await remote(ctx).rename(request({ sessionId: source.id, title: ' ​ ' }))
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error).toMatchObject({
        code: 'session/title-invalid',
        details: { sessionId: source.id },
      })
      // The message renders verbatim in the rename dialog's alert.
      expect(response.error.message).toBe('session title must contain visible characters')
    }
  })

  it('maps a non-validation rename failure (stale session object) to internal, not title-invalid', async () => {
    const ctx = await composed()
    // The registered agent holds a session object from another store: the
    // title service's liveness check throws a plain Error, which must not
    // read as the user's fault.
    const foreign = await composed(false)
    const stale = await liveAgent(foreign, 'session-rename-stale', 1)
    await ctx.agents.register({ id: stale.id, session: stale, status: 'idle', ctx } as Agent)

    const response = await remote(ctx).rename(request({ sessionId: stale.id, title: 'name' }))
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('gateway/internal')
  })

  it('answers internal when the composition mounts no session-title service', async () => {
    const ctx = await composed(false)
    const source = await liveAgent(ctx, 'session-no-titles', 1)

    const response = await remote(ctx).rename(request({ sessionId: source.id, title: 'name' }))
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('gateway/internal')
      expect(response.error.message).toMatch(/mounts no session-title service/)
    }
  })
})
