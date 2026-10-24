/** Office history denial must also stop the production Native job output executor. */
import { expect, it, vi } from 'vitest'
import { bob, nativeJobsFixture } from './native-jobs-harness.host.ts'

it('withholds an office-owned job output after switching employees', async () => {
  const fixture = await nativeJobsFixture()
  expect(await fixture.visible()).toEqual([fixture.session.id])
  const job = fixture.start()
  job.append('PRIVATE_NATIVE_JOB_OUTPUT')
  await job.finish()
  await fixture.signIn(bob)
  expect(await fixture.visible()).toEqual([])
  const abort = new AbortController()
  const output = (async () => {
    for await (const frame of fixture.ctx.jobController.follow({ sessionId: fixture.session.id, jobId: job.id }, abort.signal)) {
      if (frame.type === 'output') return frame.chunks.map(chunk => chunk.text).join('')
    }
    return ''
  })()
  try {
    await expect(output).rejects.toMatchObject({ code: 'session/not-found' })
  } finally {
    abort.abort()
    await Promise.allSettled([output])
  }
})

it('refuses hidden job rosters and Remote cancellation after employee replacement or sign-out', async () => {
  const fixture = await nativeJobsFixture()
  const job = fixture.start()
  const abort = new AbortController()
  for (const change of [() => fixture.signIn(bob), () => fixture.ctx.officeController.signOut()]) {
    await change()
    expect(await fixture.visible()).toEqual([])
    const rows = fixture.ctx.jobController.list({ sessionId: fixture.session.id }, abort.signal)[Symbol.asyncIterator]()
    try {
      await expect(rows.next()).rejects.toMatchObject({ code: 'session/not-found' })
      await expect(fixture.ctx.jobController.requestKill({ sessionId: fixture.session.id, jobId: job.id }, abort.signal))
        .rejects.toMatchObject({ code: 'session/not-found' })
      expect(job.cancels).toEqual([])
      expect(fixture.ctx.jobs.get(job.id, fixture.session.id).status).toBe('running')
    } finally {
      await rows.return?.()
    }
  }
  abort.abort()
})

it('withholds the next output after an actual employee change while leaving the job running', async () => {
  const fixture = await nativeJobsFixture()
  const job = fixture.start()
  job.append('visible to the original employee')
  const abort = new AbortController()
  const output = fixture.ctx.jobController.follow({ sessionId: fixture.session.id, jobId: job.id }, abort.signal)[Symbol.asyncIterator]()
  try {
    expect((await output.next()).value).toMatchObject({ type: 'opened' })
    expect((await output.next()).value).toMatchObject({ type: 'output' })
    await fixture.signIn(bob)
    job.append('private output after replacement')
    await expect(output.next()).rejects.toMatchObject({ code: 'session/not-found' })
    expect(job.cancels).toEqual([])
    expect(fixture.ctx.jobs.get(job.id, fixture.session.id).status).toBe('running')
  } finally {
    abort.abort()
    await output.return?.()
  }
})

it('rejects a delayed authority response before Remote cancellation can reach the producer', async () => {
  const fixture = await nativeJobsFixture()
  const job = fixture.start()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const fetch = globalThis.fetch.bind(globalThis)
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (...args) => {
    const response = await fetch(...args)
    entered.resolve(undefined)
    await release.promise
    return response
  })
  const abort = new AbortController()
  const pending = fixture.ctx.jobController.requestKill({ sessionId: fixture.session.id, jobId: job.id }, abort.signal)
  const settled = Promise.allSettled([pending])
  try {
    await entered.promise
    await fixture.signIn(bob)
    release.resolve(undefined)
    await expect(pending).rejects.toMatchObject({ code: 'session/not-found' })
    expect(job.cancels).toEqual([])
    expect(fixture.ctx.jobs.get(job.id, fixture.session.id).status).toBe('running')
  } finally {
    release.resolve(undefined)
    abort.abort()
    await settled
    transport.mockRestore()
  }
})

it('withdraws idle job observations when the Office policy unloads without killing the job', async () => {
  const fixture = await nativeJobsFixture()
  const job = fixture.start()
  const abort = new AbortController()
  const output = fixture.ctx.jobController.follow({ sessionId: fixture.session.id, jobId: job.id }, abort.signal)[Symbol.asyncIterator]()
  await output.next()
  const pending = output.next()
  const settled = Promise.allSettled([pending])
  try {
    const office = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-office')
    if (office?.fiber === undefined) throw new Error('Fixture has no active Office policy fiber')
    await office.fiber.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const reopened = fixture.ctx.jobController.list({ sessionId: fixture.session.id }, abort.signal)[Symbol.asyncIterator]()
    await expect(reopened.next()).rejects.toMatchObject({ code: 'job/access-unavailable' })
    await reopened.return?.()
    expect(job.cancels).toEqual([])
    expect(fixture.ctx.jobs.get(job.id, fixture.session.id).status).toBe('running')
  } finally {
    abort.abort()
    await settled
    await output.return?.()
  }
})

it('keeps unassociated Native jobs and unowned observations available to the current employee', async () => {
  const fixture = await nativeJobsFixture()
  const native = fixture.ctx.sessions.create()
  const agent = await fixture.register(native)
  await fixture.signIn(bob)
  const owned = fixture.start(agent)
  const unowned = fixture.start(null)
  owned.append('native owned output')
  unowned.append('unowned output')
  await owned.finish()
  await unowned.finish()
  const abort = new AbortController()
  try {
    for (const [job, sessionId, expected] of [
      [owned, native.id, 'native owned output'],
      [unowned, undefined, 'unowned output'],
    ] as const) {
      const frames = []
      for await (const frame of fixture.ctx.jobController.follow({ jobId: job.id,
        ...(sessionId === undefined ? {} : { sessionId }) }, abort.signal)) frames.push(frame)
      expect(frames.flatMap(frame => frame.type === 'output' ? frame.chunks.map(chunk => chunk.text) : []).join('')).toBe(expected)
    }
    expect(await fixture.ctx.jobController.requestKill({ sessionId: native.id, jobId: owned.id }, abort.signal))
      .toEqual({ outcome: 'already-finished' })
  } finally {
    abort.abort()
  }
})
