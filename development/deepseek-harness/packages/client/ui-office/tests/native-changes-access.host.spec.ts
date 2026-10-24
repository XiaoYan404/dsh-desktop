/** Real HTTP change reads must obey the current employee and the captured policy lifetime. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { bob, changesAccessFixture } from './native-changes-harness.host.ts'

type Fixture = Awaited<ReturnType<typeof changesAccessFixture>>

/** Delay only delivery of an already computed real comparison. */
function delayedComparison(fixture: Fixture) {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = fixture.ctx.workspaceChanges.diff.bind(fixture.ctx.workspaceChanges)
  let active: AbortSignal | undefined
  const spy = vi.spyOn(fixture.ctx.workspaceChanges, 'diff').mockImplementationOnce(async (...args) => {
    active = args[3]
    const value = await original(...args)
    entered.resolve(undefined)
    await release.promise
    return value
  })
  onTestFinished(() => { spy.mockRestore() })
  return { entered: entered.promise, release: () => { release.resolve(undefined) },
    signal: () => {
      if (active === undefined) throw new Error('Comparison has not started')
      return active
    } }
}

it('withholds recorded changes summary and diff after switching Office employees', async () => {
  const fixture = await changesAccessFixture()
  expect(await fixture.visible()).toEqual([fixture.session.id])
  expect((await fixture.http(fixture.paths.summary, false)).status).toBe(401)
  const before = await Promise.all([fixture.http(fixture.paths.summary), fixture.http(fixture.paths.diff)])
  expect(before.map(response => response.status)).toEqual([200, 200])
  expect(before[0]?.text).toContain(fixture.filename)
  expect(before[1]?.text).toContain(fixture.marker)
  await fixture.signIn(bob)
  expect(await fixture.visible()).toEqual([])
  const after = await Promise.all([fixture.http(fixture.paths.summary), fixture.http(fixture.paths.diff)])
  expect(after.map(response => response.status)).toEqual([404, 404])
  expect(after[0]?.text).not.toContain(fixture.filename)
  expect(after[1]?.text).not.toContain(fixture.marker)
})

it('denies hidden and signed-out changes before either retained reader runs', async () => {
  const fixture = await changesAccessFixture()
  const summary = vi.spyOn(fixture.ctx.workspaceChanges, 'summary')
  const diff = vi.spyOn(fixture.ctx.workspaceChanges, 'diff')
  onTestFinished(() => { summary.mockRestore(); diff.mockRestore() })
  await fixture.signIn(bob)
  for (const signedOut of [false, true]) {
    if (signedOut) expect((await fixture.ctx.officeController.signOut()).ok).toBe(true)
    expect(await fixture.visible()).toEqual([])
    const responses = await Promise.all([fixture.http(fixture.paths.summary), fixture.http(fixture.paths.diff)])
    expect(responses.map(response => response.status)).toEqual([404, 404])
    expect(summary).not.toHaveBeenCalled()
    expect(diff).not.toHaveBeenCalled()
  }
})

it('reauthorizes a computed summary before handing it to the HTTP carrier', async () => {
  const fixture = await changesAccessFixture()
  const summary = vi.spyOn(fixture.ctx.workspaceChanges, 'summary')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let checks = 0
  const remove = fixture.ctx.on('deliverables/access', async (_request, next) => {
    if (++checks === 2) {
      entered.resolve(undefined)
      await release.promise
    }
    return next()
  })
  const pending = fixture.http(fixture.paths.summary)
  const settled = Promise.allSettled([pending])
  try {
    await entered.promise
    expect(summary).toHaveBeenCalledOnce()
    await fixture.signIn(bob)
    release.resolve(undefined)
    const response = await pending
    expect(response.status).toBe(404)
    expect(response.text).not.toContain(fixture.filename)
  } finally {
    release.resolve(undefined)
    await settled
    remove()
    summary.mockRestore()
  }
})

it('withholds an already computed comparison after a real employee change', async () => {
  const fixture = await changesAccessFixture()
  const delay = delayedComparison(fixture)
  const pending = fixture.http(fixture.paths.diff)
  const settled = Promise.allSettled([pending])
  try {
    await delay.entered
    await fixture.signIn(bob)
    delay.release()
    const response = await pending
    expect(response.status).toBe(404)
    expect(response.text).not.toContain(fixture.marker)
  } finally {
    delay.release()
    await settled
  }
})

it('aborts a retained comparison on Office withdrawal and refuses unprotected reopening', async () => {
  const fixture = await changesAccessFixture()
  const delay = delayedComparison(fixture)
  const pending = fixture.http(fixture.paths.diff)
  const settled = Promise.allSettled([pending])
  try {
    await delay.entered
    const office = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-office')
    if (office?.fiber === undefined) throw new Error('Fixture has no active Office policy')
    await office.fiber.dispose()
    expect(delay.signal().aborted).toBe(true)
    delay.release()
    const response = await pending
    expect(response.status).toBe(503)
    expect(response.text).not.toContain(fixture.marker)
    expect((await fixture.http(fixture.paths.summary)).status).toBe(503)
    expect(fixture.ctx.workspaceChanges.summary(fixture.session.id, fixture.event.seq)).toEqual(fixture.summary)
    const trusted = await fixture.ctx.workspaceChanges.diff(fixture.session.id, fixture.event.seq,
      fixture.index, new AbortController().signal)
    expect(JSON.stringify(trusted)).toContain(fixture.marker)
  } finally {
    delay.release()
    await settled
  }
})

it('propagates request cancellation to the comparison and rejects late delivery', async () => {
  const fixture = await changesAccessFixture()
  const delay = delayedComparison(fixture)
  const abort = new AbortController()
  const reason = new Error('Changes request cancelled')
  const pending = fixture.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
    'http://127.0.0.1' + fixture.paths.diff, { signal: abort.signal }))
  const settled = Promise.allSettled([pending])
  try {
    await delay.entered
    abort.abort(reason)
    expect(delay.signal().aborted).toBe(true)
    delay.release()
    await expect(pending).rejects.toBe(reason)
    expect(fixture.ctx.workspaceChanges.summary(fixture.session.id, fixture.event.seq)).toEqual(fixture.summary)
  } finally {
    abort.abort()
    delay.release()
    await settled
  }
})

it('settles owned in-flight reads when their exact-route contribution unloads', async () => {
  const fixture = await changesAccessFixture()
  const delay = delayedComparison(fixture)
  const pending = fixture.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
    'http://127.0.0.1' + fixture.paths.diff))
  const settled = Promise.allSettled([pending])
  let disposal: Promise<void> | undefined
  let stop: (() => void) | undefined
  try {
    await delay.entered
    const routes = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === 'fixture-deliverables-routes')
    if (routes?.fiber === undefined) throw new Error('Fixture has no active change routes')
    const signal = delay.signal()
    const withdrawn = Promise.withResolvers<undefined>()
    const observed = (): void => { withdrawn.resolve(undefined) }
    signal.addEventListener('abort', observed, { once: true })
    stop = () => { signal.removeEventListener('abort', observed) }
    disposal = routes.fiber.dispose()
    const disposalSettled = Promise.allSettled([disposal])
    await withdrawn.promise
    delay.release()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await disposal
    await disposalSettled
    const removed = await fixture.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
      'http://127.0.0.1' + fixture.paths.summary))
    expect(removed.status).toBe(404)
  } finally {
    stop?.()
    delay.release()
    await Promise.allSettled([settled, ...(disposal === undefined ? [] : [disposal])])
  }
})

it('preserves unassociated Native HTTP reads with and without an Office policy', async () => {
  for (const office of [true, false]) {
    const fixture = await changesAccessFixture({ office, attributed: false })
    if (office) await fixture.signIn(bob)
    expect(await fixture.visible()).toEqual([fixture.session.id])
    const responses = await Promise.all([fixture.http(fixture.paths.summary), fixture.http(fixture.paths.diff)])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(responses[0]?.text).toContain(fixture.filename)
    expect(responses[1]?.text).toContain(fixture.marker)
  }
})
