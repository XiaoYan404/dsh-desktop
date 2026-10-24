/** Job Remote authority checks surround actual registry observations and cancellation. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { JobController } from '../src/index.ts'
import { harness, registerAgent, startJob } from './host-harness.ts'

async function fixture() {
  const ctx = await harness()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JobController, { observeFlushMs: 1, observeMaxFrameBytes: 1 })
  const agent = await registerAgent(ctx, 'owner')
  const job = startJob(ctx, { owner: agent.id })
  return { ctx, agent, job, controller: ctx.jobController }
}

it('keeps Native observations, the model cursor and synchronous trusted Host cancellation', async () => {
  const { ctx, agent, job, controller } = await fixture()
  job.append('native output')
  const abort = new AbortController()
  const rows = controller.list({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
  const output = controller.follow({ sessionId: agent.id, jobId: job.id }, abort.signal)[Symbol.asyncIterator]()
  try {
    expect((await rows.next()).value).toMatchObject({ type: 'rows', jobs: [{ id: job.id }] })
    expect((await output.next()).value).toMatchObject({ type: 'opened', job: { id: job.id } })
    expect((await output.next()).value).toMatchObject({ type: 'output', chunks: [{ text: 'native output' }] })
    expect(ctx.jobs.read(job.id, agent.id).chunks.map(chunk => chunk.text).join('')).toBe('native output')
    expect(controller.kill({ sessionId: agent.id, jobId: job.id })).toEqual({ outcome: 'requested' })
  } finally {
    abort.abort()
    await rows.return?.()
    await output.return?.()
  }
})

it('exports only the authorized implementation under the original kill endpoint', async () => {
  const { controller } = await fixture()
  const markers = remoteMethods(controller)
  expect(markers.map(marker => marker.exportName ?? marker.method)).toEqual(['list', 'follow', 'kill'])
  expect(markers.find(marker => marker.exportName === 'kill')?.method).toBe('requestKill')
})

it('refuses denied list, follow and Remote kill before registry access or producer cancellation', async () => {
  const { ctx, agent, job, controller } = await fixture()
  const list = vi.spyOn(ctx.jobs, 'list')
  const get = vi.spyOn(ctx.jobs, 'get')
  const kill = vi.spyOn(ctx.jobs, 'kill')
  ctx.on('job/access', async (_request, next) => {
    await next()
    throw new RemoteError('job/access-unavailable', 'Withdrawn job authority', {})
  })
  const abort = new AbortController()
  const rows = controller.list({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
  const output = controller.follow({ sessionId: agent.id, jobId: job.id }, abort.signal)[Symbol.asyncIterator]()
  try {
    await expect(rows.next()).rejects.toMatchObject({ code: 'job/access-unavailable' })
    await expect(output.next()).rejects.toMatchObject({ code: 'job/access-unavailable' })
    await expect(controller.requestKill({ sessionId: agent.id, jobId: job.id }, abort.signal))
      .rejects.toMatchObject({ code: 'job/access-unavailable' })
    expect(list).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  } finally {
    abort.abort()
    await rows.return?.()
    await output.return?.()
  }
})

it('checks authority before each retained output frame without cancelling its producer', async () => {
  const { ctx, agent, job, controller } = await fixture()
  let allowed = true
  const lifetime = new AbortController()
  ctx.on('job/access', async (_request, next) => {
    await next()
    if (!allowed) throw new RemoteError('job/access-unavailable', 'Changed job authority', {})
    return lifetime.signal
  })
  job.append('first')
  job.append('second')
  const abort = new AbortController()
  const output = controller.follow({ sessionId: agent.id, jobId: job.id }, abort.signal)[Symbol.asyncIterator]()
  try {
    expect((await output.next()).value).toMatchObject({ type: 'opened' })
    expect((await output.next()).value).toMatchObject({ type: 'output', chunks: [{ text: 'first' }] })
    allowed = false
    await expect(output.next()).rejects.toMatchObject({ code: 'job/access-unavailable' })
    expect(ctx.jobs.get(job.id, agent.id).status).toBe('running')
  } finally {
    abort.abort()
    await output.return?.()
  }
})

it('checks authority before publishing refreshed roster metadata', async () => {
  const { ctx, agent, job, controller } = await fixture()
  let allowed = true
  const lifetime = new AbortController()
  ctx.on('job/access', async (_request, next) => {
    await next()
    if (!allowed) throw new RemoteError('job/access-unavailable', 'Changed job authority', {})
    return lifetime.signal
  })
  const abort = new AbortController()
  const rows = controller.list({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
  try {
    expect((await rows.next()).value).toMatchObject({ type: 'rows' })
    allowed = false
    job.progress('private progress after authority changed')
    await expect(rows.next()).rejects.toMatchObject({ code: 'job/access-unavailable' })
    expect(ctx.jobs.get(job.id, agent.id).status).toBe('running')
  } finally {
    abort.abort()
    await rows.return?.()
  }
})

it('aborts a bound idle observation on policy withdrawal and refuses unprotected reopening', async () => {
  const { ctx, agent, job, controller } = await fixture()
  const lifetime = new AbortController()
  const remove = ctx.on('job/access', async (_request, next) => { await next(); return lifetime.signal })
  const abort = new AbortController()
  const output = controller.follow({ sessionId: agent.id, jobId: job.id }, abort.signal)[Symbol.asyncIterator]()
  await output.next()
  const pending = output.next()
  const settled = Promise.allSettled([pending])
  try {
    remove()
    const reason = new Error('Job authority withdrawn')
    lifetime.abort(reason)
    await expect(pending).rejects.toBe(reason)
    const reopened = controller.list({ sessionId: agent.id }, abort.signal)[Symbol.asyncIterator]()
    await expect(reopened.next()).rejects.toMatchObject({ code: 'job/access-unavailable' })
    await reopened.return?.()
    expect(ctx.jobs.get(job.id, agent.id).status).toBe('running')
  } finally {
    lifetime.abort()
    abort.abort()
    await settled
    await output.return?.()
  }
})

it('preserves the registry owner fence even when a job policy allows the caller', async () => {
  const { ctx, agent, job, controller } = await fixture()
  const other = await registerAgent(ctx, 'other')
  const lifetime = new AbortController()
  ctx.on('job/access', async (_request, next) => { await next(); return lifetime.signal })
  const abort = new AbortController()
  const output = controller.follow({ sessionId: other.id, jobId: job.id }, abort.signal)[Symbol.asyncIterator]()
  try {
    await expect(output.next()).rejects.toThrow('belongs to another session')
    await expect(controller.requestKill({ sessionId: other.id, jobId: job.id }, abort.signal))
      .rejects.toMatchObject({ code: 'job/not-found' })
    expect(ctx.jobs.get(job.id, agent.id).status).toBe('running')
  } finally {
    abort.abort()
    await output.return?.()
  }
})
