import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type {
  RemoteEventHostInfo,
  TypertRemoteEventInvocation,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/index.ts'

interface GatewayProbe {
  source: TypertRemoteEventSource | undefined
  host: RemoteEventHostInfo | undefined
  removals: number
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>
}

async function setup(): Promise<{
  readonly ctx: Context
  readonly gateway: GatewayProbe
  readonly fiber: Fiber
}> {
  const ctx = new Context()
  const gateway: GatewayProbe = {
    source: undefined,
    host: undefined,
    removals: 0,
    registerRemoteEvents(source, host) {
      gateway.source = source
      gateway.host = host
      return async () => {
        if (gateway.source !== source) return
        gateway.source = undefined
        gateway.host = undefined
        gateway.removals += 1
      }
    },
  }
  ctx.reflect.provide('typertGateway', gateway)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return { ctx, gateway, fiber }
}

function sourceOf(gateway: GatewayProbe): TypertRemoteEventSource {
  if (gateway.source === undefined) throw new Error('fixture Gateway has no Remote event source')
  return gateway.source
}

function emitRaw(ctx: Context, event: string, args: readonly unknown[]): void {
  const emit = ctx.emit.bind(ctx) as (name: string, ...values: readonly unknown[]) => void
  emit(event, ...args)
}

function waterfallRaw(
  ctx: Context,
  target: object,
  event: string,
  args: readonly unknown[],
  next: () => Promise<unknown>,
): Promise<unknown> {
  const waterfall = ctx.waterfall.bind(ctx) as (
    receiver: object,
    name: string,
    ...values: readonly unknown[]
  ) => Promise<unknown>
  return waterfall(target, event, ...args, next)
}

function invocationOf(value: unknown): TypertRemoteEventInvocation {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'context')) {
    throw new Error('fixture did not receive a scoped Remote Event invocation')
  }
  return value as TypertRemoteEventInvocation
}

describe('Remote event Host source', () => {
  it('checks queued notifications at delivery and restores defaults after policy withdrawal', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const stream = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    let admitted = true
    const remove = ctx.on('api-remotes/emit', (payload, next) =>
      payload.event === 'schedule/changed' && !admitted ? false : next())
    try {
      emitRaw(ctx, 'schedule/changed', [])
      admitted = false
      emitRaw(ctx, 'settings/document-updated', ['ui-theme', 2])
      await expect(stream.next()).resolves.toEqual({ done: false,
        value: { event: 'settings/document-updated', args: ['ui-theme', 2] } })
      remove()
      emitRaw(ctx, 'schedule/changed', [])
      await expect(stream.next()).resolves.toEqual({ done: false, value: { event: 'schedule/changed', args: [] } })
    } finally { remove(); abort.abort(); await stream.return?.(); await fiber.dispose() }
  })

  it('does not deliver an asynchronous allow decision after source cancellation', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<boolean>()
    const remove = ctx.on('api-remotes/emit', async (_payload, next) => {
      if (!await next()) return false
      entered.resolve(undefined)
      return release.promise
    })
    const stream = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    try {
      emitRaw(ctx, 'schedule/changed', [])
      const waiting = stream.next()
      await entered.promise
      abort.abort()
      release.resolve(true)
      await expect(waiting).resolves.toEqual({ done: true, value: undefined })
    } finally { release.resolve(false); remove(); abort.abort(); await stream.return?.(); await fiber.dispose() }
  })

  it('reports a notification policy failure and closes the source', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const failure = new Error('Notification policy is unavailable')
    const remove = ctx.on('api-remotes/emit', () => { throw failure })
    const stream = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    try {
      emitRaw(ctx, 'schedule/changed', [])
      await expect(stream.next()).rejects.toBe(failure)
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    } finally { remove(); abort.abort(); await stream.return?.(); await fiber.dispose() }
  })

  it('forwards only an empty invalidation for private office conversation choices', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const stream = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    try {
      const received = stream.next()
      emitRaw(ctx, 'office/conversation-links-changed', [])
      await expect(received).resolves.toEqual({ done: false, value: { event: 'office/conversation-links-changed', args: [] } })
    } finally {
      abort.abort()
      await fiber.dispose()
    }
  })

  it('registers the Host home used by Client connection generations', async () => {
    const { gateway, fiber } = await setup()
    expect(gateway.host?.home).toBeTypeOf('string')
    expect(gateway.host?.home.length).toBeGreaterThan(0)
    await fiber.dispose()
    expect(gateway.host).toBeUndefined()
  })

  it('gives each Client stream an independent allowlisted event queue', async () => {
    const { ctx, gateway, fiber } = await setup()
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = sourceOf(gateway)(firstAbort.signal)[Symbol.asyncIterator]()
    const second = sourceOf(gateway)(secondAbort.signal)[Symbol.asyncIterator]()

    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })

    emitRaw(ctx, 'goal/activation-changed', [{
      sessionId: 'session-1',
      goal: { id: 'goal-1', revision: 1, activation: 'disarmed' },
    }])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: {
        event: 'goal/activation-changed',
        args: [{ sessionId: 'session-1', goal: { id: 'goal-1', revision: 1, activation: 'disarmed' } }],
      },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: {
        event: 'goal/activation-changed',
        args: [{ sessionId: 'session-1', goal: { id: 'goal-1', revision: 1, activation: 'disarmed' } }],
      },
    })

    emitRaw(ctx, 'schedule/changed', [])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { event: 'schedule/changed', args: [] },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'schedule/changed', args: [] },
    })

    const firstDone = first.next()
    firstAbort.abort(new Error('first Client disconnected'))
    emitRaw(ctx, 'commands/change', [])
    await expect(firstDone).resolves.toEqual({ done: true, value: undefined })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'commands/change', args: [] },
    })

    const secondDone = second.next()
    secondAbort.abort(new Error('second Client disconnected'))
    await expect(secondDone).resolves.toEqual({ done: true, value: undefined })

    await fiber.dispose()
    expect(gateway.source).toBeUndefined()
    expect(gateway.removals).toBe(1)
    await ctx.fiber.dispose()
  })

  it('rejects a non-JSON argument without poisoning the stream', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()

    expect(() => {
      emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1n])
    }).toThrow('argument 1 is not lossless JSON data')
    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 2])
    await expect(pending).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 2] },
    })

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(sourceOf(gateway)(alreadyAborted.signal)[Symbol.asyncIterator]().next())
      .resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('bridges scoped waterfall result, next delegation, and rejection', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { id: 'agent-1', ctx: agentCtx }
    const target = scopeTarget(ctx, agent)
    const request = { questions: [], agent }

    await expect(async () => waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [{ questions: [], agent: { id: 'agent-2', ctx: ctx.extend() } }],
      () => Promise.resolve('host fallback'),
    )).rejects.toThrow('must carry its Agent directly')

    const claimed = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const claimedDispatch = invocationOf((await iterator.next()).value)
    expect(claimedDispatch).toMatchObject({
      event: 'user-questions/request',
      request,
      context: { value: agentCtx, subject: agent, agentId: 'agent-1' },
    })
    claimedDispatch.resolve({ kind: 'result', value: 'client answer' })
    await expect(claimed).resolves.toBe('client answer')

    const delegated = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const delegatedDispatch = invocationOf((await iterator.next()).value)
    delegatedDispatch.resolve({ kind: 'next' })
    await expect(delegated).resolves.toBe('host fallback')

    const rejection = Object.assign(new Error('the user cancelled ask_user_question'), {
      code: 'ASK_CANCELLED',
    })
    const rejected = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const rejectedAssertion = expect(rejected).rejects.toBe(rejection)
    const rejectedDispatch = invocationOf((await iterator.next()).value)
    rejectedDispatch.reject(rejection)
    await rejectedAssertion

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('rejects a queued scoped waterfall when its source is withdrawn', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const delivery = iterator.next()
    const agent = { id: 'agent-1', ctx: ctx.extend() }
    const reason = new Error('forwarded event source removed')
    const pending = waterfallRaw(
      ctx,
      scopeTarget(ctx, agent),
      'user-questions/request',
      [{ questions: [], agent }],
      () => Promise.resolve('host fallback'),
    )
    const rejected = expect(pending).rejects.toBe(reason)

    abort.abort(reason)

    await rejected
    await expect(delivery).resolves.toEqual({ done: true, value: undefined })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
