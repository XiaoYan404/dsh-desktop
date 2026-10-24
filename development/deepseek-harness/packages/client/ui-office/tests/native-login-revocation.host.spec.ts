/** Committed credential replacement withdraws admitted Office resources without granting identity from cached metadata. */
import { expect, it } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import { alice, bob, nativeJobsFixture } from './native-jobs-harness.host.ts'

it('withdraws an admitted Office terminal hold at committed sign-out', async () => {
  const fixture = await nativeJobsFixture()
  const signal = new AbortController().signal
  const authority = await fixture.ctx.waterfall('terminal/access', { sessionId: fixture.session.id, signal },
    () => Promise.resolve(undefined))
  expect(authority?.aborted).toBe(false)
  expect((await fixture.ctx.officeController.signOut()).ok).toBe(true)
  expect(authority?.aborted).toBe(true)
})

it('refuses old job output after the same employee signs out and signs in again', async () => {
  const fixture = await nativeJobsFixture()
  const job = fixture.start()
  const abort = new AbortController()
  const output = fixture.ctx.jobController.follow({ sessionId: fixture.session.id, jobId: job.id },
    abort.signal)[Symbol.asyncIterator]()
  try {
    expect((await output.next()).value).toMatchObject({ type: 'opened' })
    expect((await fixture.ctx.officeController.signOut()).ok).toBe(true)
    await fixture.signIn(alice)
    expect(await fixture.visible()).toEqual([fixture.session.id])
    job.append('PRIVATE_PREVIOUS_LOGIN_OUTPUT')
    await expect(output.next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(job.cancels).toEqual([])
    const freshAbort = new AbortController()
    const fresh = fixture.ctx.jobController.follow({ sessionId: fixture.session.id, jobId: job.id },
      freshAbort.signal)[Symbol.asyncIterator]()
    try { expect((await fresh.next()).value).toMatchObject({ type: 'opened' }) }
    finally { freshAbort.abort(); await fresh.return?.() }
  } finally { abort.abort(); await output.return?.() }
})

it('keeps an admitted resource revoked across Alice to Bob to Alice grant replacements', async () => {
  const fixture = await nativeJobsFixture()
  const signal = new AbortController().signal
  const authority = await fixture.ctx.waterfall('workspace-files/access', { sessionId: fixture.session.id, signal },
    () => Promise.resolve(undefined))
  await fixture.signIn(bob)
  await fixture.signIn(alice)
  expect(await fixture.visible()).toEqual([fixture.session.id])
  expect(authority?.aborted).toBe(true)
  const fresh = await fixture.ctx.waterfall('workspace-files/access', { sessionId: fixture.session.id,
    signal: new AbortController().signal }, () => Promise.resolve(undefined))
  expect(fresh?.aborted).toBe(false)
})

it('refuses resource admission when the login grant changes during the original visibility check', async () => {
  const fixture = await nativeJobsFixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const remove = fixture.ctx.on('api-session/visible', async (_request, next) => {
    const result = await next()
    entered.resolve()
    await release.promise
    return result
  })
  const pending = fixture.ctx.waterfall('workspace-files/access', { sessionId: fixture.session.id,
    signal: new AbortController().signal }, () => Promise.resolve(undefined))
  const settled = Promise.allSettled([pending])
  try {
    await entered.promise
    expect((await fixture.ctx.officeController.signOut()).ok).toBe(true)
    await fixture.signIn(alice)
    release.resolve()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  } finally { release.resolve(); remove(); await settled }
})

it('keeps unrelated credential writes from withdrawing an admitted Office resource', async () => {
  const fixture = await nativeJobsFixture()
  const authority = await fixture.ctx.waterfall('terminal/access', { sessionId: fixture.session.id,
    signal: new AbortController().signal }, () => Promise.resolve(undefined))
  await fixture.ctx.credentials.modifyRecord(credentialKey('native-lifetime-fixture', 'unrelated'),
    async () => ({ kind: 'grant', payload: { version: 1 } }))
  expect(authority?.aborted).toBe(false)
})

it('keeps an unassociated Native resource attached when the Office grant signs out', async () => {
  const fixture = await nativeJobsFixture()
  const native = fixture.ctx.sessions.create()
  const authority = await fixture.ctx.waterfall('terminal/access', { sessionId: native.id,
    signal: new AbortController().signal }, () => Promise.resolve(undefined))
  expect((await fixture.ctx.officeController.signOut()).ok).toBe(true)
  expect(authority?.aborted).toBe(false)
})
