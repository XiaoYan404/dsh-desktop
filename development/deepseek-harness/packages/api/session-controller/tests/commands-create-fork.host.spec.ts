import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
} from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

async function expectFailure(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code })
}

function controllerAgents(overrides: object = {}): ApiSessionAgentController {
  return {
    ensureSession: () => Promise.resolve(),
    composeAgent: () => Promise.resolve({ setup: () => {} }),
    presetForSession: () => undefined,
    presetForObservation: () => undefined,
    ...overrides,
  } as unknown as ApiSessionAgentController
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return ctx
}

describe('Session creation workspace visibility', () => {
  it.each(['before-attach', 'after-attach'] as const)('withdraws an adoption result when visibility changes %s', async (phase) => {
    const ctx = await baseContext()
    const id = SessionId('workspace-adoption-visibility')
    const session = ctx.sessions.create(id, { meta: { cwd: '/workspace' } })
    const current = { id, session } as Agent
    let visible = true
    const attachSession = vi.fn(async () => { visible = false })
    const workspace = { id: 'visibility-workspace' as WorkspaceId, path: '/workspace', attachSession } as unknown as Workspace
    ctx.provide('workspaceRegistry', { get: () => workspace, list: () => [workspace] } as never)
    ctx.on('api-session/visible', async (_payload, next) => { await next(); return visible ? [id] : [] })
    const controller = new SessionCommandController(ctx, controllerAgents({ ensureSession: () => {
      visible = phase === 'after-attach'
      return Promise.resolve(current)
    } }), '/default')
    await expectFailure(controller.create({ sessionId: id, workspaceId: workspace.id }), 'session/not-found')
    expect(attachSession).toHaveBeenCalledTimes(phase === 'before-attach' ? 0 : 1)
    if (phase === 'after-attach') expect(attachSession).toHaveBeenCalledWith(id)
  })
})

describe('Session creation failures', () => {
  it('mints an identity with the default cwd when no explicit target is supplied', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const ensureSession = vi.fn((sessionId: SessionId, cwd: string) => {
      const session = ctx.sessions.create(sessionId, { meta: { cwd } })
      return Promise.resolve({ id: sessionId, session } as Agent)
    })
    const controller = new SessionCommandController(
      ctx,
      controllerAgents({ ensureSession }),
      '/default-workspace',
    )

    const created = await controller.create({})

    expect(created.sessionId).toMatch(/^session-/)
    expect(created).not.toHaveProperty('agentPreset')
    expect(ensureSession).toHaveBeenCalledWith(
      created.sessionId,
      '/default-workspace',
      false,
      undefined,
    )
    await ctx.fiber.dispose()
  })

  it('maps missing Workspaces and attachment failures', async () => {
    const missing = await baseContext()
    missing.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const missingController = new SessionCommandController(
      missing,
      controllerAgents(),
      '/default',
    )
    await expectFailure(missingController.create({
      workspaceId: 'missing' as WorkspaceId,
    }), 'workspace/not-found')
    await missing.fiber.dispose()

    const failed = await baseContext()
    const workspace = {
      id: 'workspace-1' as WorkspaceId,
      path: '/workspace',
      attachSession: () => Promise.reject(new Error('read-only workspace')),
    } as unknown as Workspace
    failed.provide('workspaceRegistry', {
      get: () => workspace,
      list: () => [workspace],
    } as never)
    const failedController = new SessionCommandController(
      failed,
      controllerAgents(),
      '/default',
    )
    await expectFailure(failedController.create({
      sessionId: SessionId('workspace-session'),
      workspaceId: workspace.id,
    }), 'session/workspace-attach-failed')
    await failed.fiber.dispose()
  })

  it.each([
    {
      error: new RemoteError(
        'agent-preset/invalid',
        'agent-presets: preset "broken" failed to mount: invalid composition',
        { agentPreset: 'broken', reason: 'invalid composition' },
      ),
      code: 'agent-preset/invalid',
    },
    {
      error: new ApiSessionCwdConflict(SessionId('cwd-less'), '/requested', undefined),
      code: 'session/conflict',
    },
    {
      error: new ApiSessionCwdConflict(SessionId('wrong-cwd'), '/requested', '/stored'),
      code: 'session/conflict',
    },
    {
      error: Object.assign(new Error('writer already held'), { name: 'SessionAlreadyOwnedError' }),
      code: 'session/writer-held',
    },
    {
      error: new Error('factory unavailable'),
      code: 'gateway/internal',
    },
  ])('maps $code creation failures', async ({ error, code }) => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [] } as never)
    const controller = new SessionCommandController(
      ctx,
      controllerAgents({ ensureSession: () => Promise.reject(error) }),
      '/default',
    )

    await expectFailure(controller.create({
      sessionId: SessionId('failed-create'), cwd: '/requested',
    }), code)
    await ctx.fiber.dispose()
  })

  it('rejects contradictory create targets', async () => {
    const ctx = await baseContext()
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    await expectFailure(controller.create({
      workspaceId: 'workspace-1' as WorkspaceId,
      cwd: '/workspace',
    }), 'gateway/bad-request')
    await ctx.fiber.dispose()
  })

})

function completedSession(
  ctx: Context,
  id: string,
  cwd?: string,
  lineage: { parentSession?: SessionId; origin?: 'subagent' } = {},
) {
  const session = ctx.sessions.create(SessionId(id), {
    meta: { ...(cwd === undefined ? {} : { cwd }), ...lineage },
  })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'work' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function resolvedHandle(ctx: Context, sessionId: SessionId): AgentHandle {
  return {
    agent: { id: sessionId, status: 'idle', ctx } as Agent,
    dispose: () => Promise.resolve(),
  }
}

describe('Session fork visibility', () => {
  it('rejects hidden live and cold sources before reading or composing a child', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const source = completedSession(ctx, 'hidden-fork')
    const before = source.snapshotEvents()
    const stat = vi.fn(() => Promise.resolve(undefined))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, { stat }) as never)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const composeAgent = vi.fn(() => Promise.resolve({ setup: () => {} }))
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(
      (options: CreateAgentOptions) => Promise.resolve(resolvedHandle(ctx, options.sessionId)),
    )
    ctx.on('api-session/visible', () => Promise.resolve([]))
    const controller = new SessionCommandController(ctx, controllerAgents({ composeAgent }), '/default')

    await expectFailure(controller.fork({ sessionId: source.id }), 'session/not-found')
    await expectFailure(controller.fork({ sessionId: SessionId('hidden-cold-fork') }), 'session/not-found')
    await expectFailure(controller.fork({ sessionId: SessionId('hidden-cold-fork'), allowMigration: false }), 'session/not-found')
    expect(stat).toHaveBeenCalledExactlyOnceWith(SessionId('hidden-cold-fork'))
    expect(observe).not.toHaveBeenCalled()
    expect(composeAgent).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(source.snapshotEvents()).toEqual(before)
  })

  it('withholds a migration hint when visibility changes during cold preflight', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const source = ctx.sessions.prepare(SessionId('cold-fork-preflight'))
    let visible = true
    ctx.on('api-session/visible', (_request, next) => visible ? next() : Promise.resolve([]))
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      stat: async () => {
        ready.resolve(undefined)
        await release.promise
        return { header: source.header, revision: SessionPersistenceRevision('cold-fork'), formatStatus: 'migration-required' }
      },
    }) as never)
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')
    const pending = controller.fork({ sessionId: source.id, allowMigration: false })
    await ready.promise
    visible = false
    release.resolve(undefined)
    await expectFailure(pending, 'session/not-found')
    expect(observe).not.toHaveBeenCalled()
    expect(ctx.sessions.get(source.id)).toBeUndefined()
  })

  it('withholds an admitted child and its workspace attachment after access is withdrawn', async () => {
    const ctx = await baseContext()
    const source = completedSession(ctx, 'admitted-fork', '/workspace')
    const attachSession = vi.fn(() => Promise.resolve())
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace', sessionIds: [source.id], attachSession }] } as never)
    let visible = true
    ctx.on('api-session/visible', (_request, next) => visible ? next() : Promise.resolve([]))
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async (options: CreateAgentOptions) => {
      const child = resolvedHandle(ctx, options.sessionId)
      ready.resolve(undefined)
      await release.promise
      return child
    })
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')
    const pending = controller.fork({ sessionId: source.id })
    await ready.promise
    visible = false
    release.resolve(undefined)
    await expectFailure(pending, 'session/not-found')
    expect(create).toHaveBeenCalledOnce()
    expect(attachSession).not.toHaveBeenCalled()
  })

  it.each(['observation', 'lineage', 'composition', 'unload'] as const)(
    'does not create a child after visibility changes during %s', async (stage) => {
      const ctx = await baseContext()
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      const parent = stage === 'lineage' ? completedSession(ctx, 'fork-parent') : undefined
      const source = completedSession(ctx, 'held-fork', '/workspace',
        parent ? { parentSession: parent.id, origin: 'subagent' } : {})
      const before = source.snapshotEvents()
      let visible = true
      ctx.on('api-session/visible', (_request, next) => visible ? next() : Promise.resolve([]))
      const ready = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      onTestFinished(() => { release.resolve(undefined) })
      const hold = async () => { ready.resolve(undefined); await release.promise }
      const composeAgent = vi.fn(async () => {
        if (stage === 'composition' || stage === 'unload') await hold()
        return { setup: () => {} }
      })
      if (stage === 'observation') {
        const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
        vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (...args) => {
          const result = await observe(...args)
          await hold()
          return result
        })
      } else if (stage === 'lineage') {
        const trace = ctx.sessionQuery.traceSession.bind(ctx.sessionQuery)
        vi.spyOn(ctx.sessionQuery, 'traceSession').mockImplementationOnce(async (...args) => {
          const result = await trace(...args)
          await hold()
          return result
        })
      }
      const create = vi.spyOn(ctx.agents, 'create').mockImplementation(
        (options: CreateAgentOptions) => Promise.resolve(resolvedHandle(ctx, options.sessionId)),
      )
      const controller = new SessionCommandController(ctx, controllerAgents({ composeAgent }), '/default')
      const pending = controller.fork({ sessionId: source.id })
      await ready.promise
      if (stage === 'unload') await ctx.fiber.dispose()
      else visible = false
      release.resolve(undefined)
      if (stage === 'unload') await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      else await expectFailure(pending, 'session/not-found')
      expect(create).not.toHaveBeenCalled()
      if (stage === 'observation' || stage === 'lineage') expect(composeAgent).not.toHaveBeenCalled()
      expect(source.snapshotEvents()).toEqual(before)
    },
  )
})

describe('Session fork failures', () => {
  it('maps missing cold sources with and without persistence', async () => {
    const withoutPersistence = await baseContext()
    withoutPersistence.provide('workspaceRegistry', { list: () => [] } as never)
    const unavailableController = new SessionCommandController(
      withoutPersistence, controllerAgents(), '/default',
    )
    await expectFailure(unavailableController.fork({
      sessionId: SessionId('missing'),
    }), 'session/not-found')
    await withoutPersistence.fiber.dispose()

    const missing = await baseContext()
    missing.provide('workspaceRegistry', { list: () => [] } as never)
    missing.provide('sessionPersistence', testSessionPersistence(missing, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    }) as never)
    const missingController = new SessionCommandController(missing, controllerAgents(), '/default')
    await expectFailure(missingController.fork({
      sessionId: SessionId('missing'),
    }), 'session/not-found')
    await missing.fiber.dispose()
  })

  it('maps an observation failure to an internal fork error', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockRejectedValue(new Error('storage offline'))
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    await expectFailure(controller.fork({ sessionId: SessionId('unreadable') }), 'gateway/internal')
    await ctx.fiber.dispose()
  })

  it('rejects a Session with no completed turn', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const source = ctx.sessions.create(SessionId('empty-source'))
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    await expectFailure(controller.fork({ sessionId: source.id }), 'session/fork-unavailable')
    await expect(controller.fork({ sessionId: source.id, atSeq: 0 })).rejects.toMatchObject({
      code: 'session/fork-unavailable',
      message: 'event 0 does not exist in session "empty-source" (last seq: none)',
    })
    await ctx.fiber.dispose()
  })

  it('maps lineage lookup and Agent creation failures', async () => {
    const lineage = await baseContext()
    lineage.provide('workspaceRegistry', { list: () => [] } as never)
    vi.spyOn(lineage.sessionQuery, 'traceSession')
      .mockRejectedValue(new Error('lineage unavailable'))
    const child = completedSession(lineage, 'subagent-source', '/workspace', {
      parentSession: SessionId('parent'),
      origin: 'subagent',
    })
    const lineageController = new SessionCommandController(lineage, controllerAgents(), '/default')
    await expectFailure(lineageController.fork({ sessionId: child.id }), 'gateway/internal')
    await lineage.fiber.dispose()

    const creation = await baseContext()
    creation.provide('workspaceRegistry', { list: () => [] } as never)
    const source = completedSession(creation, 'creation-source', '/workspace')
    vi.spyOn(creation.agents, 'create').mockRejectedValue(new Error('factory failed'))
    const creationController = new SessionCommandController(creation, controllerAgents(), '/default')
    await expectFailure(creationController.fork({ sessionId: source.id }), 'gateway/internal')
    await creation.fiber.dispose()
  })

  it('omits absent cwd and preset metadata before reporting Workspace attachment failure', async () => {
    const ctx = await baseContext()
    const source = completedSession(ctx, 'workspace-source')
    const workspace = {
      id: 'workspace-1' as WorkspaceId,
      sessionIds: [source.id],
      attachSession: () => Promise.reject(new Error('workspace write failed')),
    } as unknown as Workspace
    ctx.provide('workspaceRegistry', { list: () => [workspace] } as never)
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(
      (options: CreateAgentOptions) => Promise.resolve(resolvedHandle(ctx, options.sessionId)),
    )
    const controller = new SessionCommandController(ctx, controllerAgents(), '/default')

    await expectFailure(controller.fork({ sessionId: source.id }), 'session/workspace-attach-failed')
    const options = create.mock.calls[0]?.[0]
    if (options === undefined) throw new Error('Agent creation was not attempted')
    expect(options.meta).not.toHaveProperty('cwd')
    expect(options.meta).not.toHaveProperty('agentPreset')
    await ctx.fiber.dispose()
  })

  it('carries the composed Agent preset into the child metadata', async () => {
    const ctx = await baseContext()
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const source = completedSession(ctx, 'preset-source', '/workspace')
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(
      (options: CreateAgentOptions) => Promise.resolve(resolvedHandle(ctx, options.sessionId)),
    )
    const controller = new SessionCommandController(ctx, controllerAgents({
      composeAgent: () => Promise.resolve({ agentPreset: 'minimal', setup: () => {} }),
    }), '/default')

    const forked = await controller.fork({ sessionId: source.id })
    expect(forked.sessionId).toMatch(/^session-/)
    const options = create.mock.calls[0]?.[0]
    if (options === undefined) throw new Error('Agent creation was not attempted')
    expect(options.meta?.agentPreset).toBe('minimal')
    await ctx.fiber.dispose()
  })
})
