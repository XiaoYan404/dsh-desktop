/** Retained file authority survives request waits but never policy withdrawal. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { openWorkspace, signal } from './harness.ts'

it('withholds a pending read on policy withdrawal and admits only a registered replacement', async () => {
  const harness = await openWorkspace('dsh-file-authority-withdrawal-')
  onTestFinished(() => harness.dispose())
  const service = harness.endpoint()
  await writeFile(join(harness.workspace, 'private.bin'), new Uint8Array([0, 255, 127]))
  const lifetime = new AbortController()
  const revoked = new Error('File authority withdrawn')
  const remove = harness.ctx.on('workspace-files/access', async (_request, next) => {
    await next()
    return lifetime.signal
  })
  const ready = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = harness.ctx.fs.readBytes.bind(harness.ctx.fs)
  const held = vi.spyOn(harness.ctx.fs, 'readBytes').mockImplementationOnce(async (...args) => {
    const bytes = await original(...args)
    ready.resolve(undefined)
    await release.promise
    return bytes
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  const pending = service.readBytes(harness.scope, 'private.bin', {}, signal())
  const checked = expect(pending).rejects.toBe(revoked)
  await ready.promise
  lifetime.abort(revoked)
  remove()
  release.resolve(undefined)
  await checked
  await expect(service.readBytes(harness.scope, 'private.bin', {}, signal()))
    .rejects.toMatchObject({ code: 'workspace-file/access-unavailable' })
  const replacement = new AbortController()
  harness.ctx.on('workspace-files/access', async (_request, next) => {
    await next()
    return replacement.signal
  })
  expect([...(await service.readBytes(harness.scope, 'private.bin', {}, signal())).data]).toEqual([0, 255, 127])
})

it('retains the original read authority across a final policy check that renews its lifetime', async () => {
  const harness = await openWorkspace('dsh-file-final-authority-')
  onTestFinished(() => harness.dispose())
  const service = harness.endpoint()
  await writeFile(join(harness.workspace, 'private.bin'), new Uint8Array([1, 128, 255]))
  const registration = new AbortController()
  const original = new AbortController()
  let current = original.signal
  const ready = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined); registration.abort() })
  let checks = 0
  harness.ctx.on('workspace-files/access', async (_request, next) => {
    await next()
    if (++checks === 2) {
      ready.resolve(undefined)
      await release.promise
    }
    return AbortSignal.any([registration.signal, current])
  })
  const revoked = new Error('Original read authority was revoked during final admission')
  const pending = service.readBytes(harness.scope, 'private.bin', {}, signal())
  const checked = expect(pending).rejects.toBe(revoked)
  await ready.promise
  original.abort(revoked)
  current = new AbortController().signal
  release.resolve(undefined)
  await checked
  expect(checks).toBe(2)
})

it('closes a retained watch on authority withdrawal without another pull or filesystem notification', async () => {
  const harness = await openWorkspace('dsh-file-watch-authority-')
  onTestFinished(() => harness.dispose())
  const service = harness.endpoint()
  await writeFile(join(harness.workspace, 'private.txt'), 'private')
  const unwatch = vi.fn(async () => {})
  const watched = vi.spyOn(harness.ctx.fs, 'watch').mockResolvedValue(unwatch)
  onTestFinished(() => { watched.mockRestore() })
  const lifetime = new AbortController()
  const remove = harness.ctx.on('workspace-files/access', async (_request, next) => {
    await next()
    return lifetime.signal
  })
  const caller = new AbortController()
  const iterator = service.changes(harness.scope, 'private.txt', caller.signal)[Symbol.asyncIterator]()
  onTestFinished(async () => { caller.abort(); await iterator.return?.() })
  expect(await iterator.next()).toMatchObject({ value: { kind: 'ready' } })
  lifetime.abort(new Error('File authority withdrawn'))
  remove()
  await expect.poll(() => unwatch.mock.calls.length).toBe(1)
  await expect(iterator.next()).rejects.toThrow('File authority withdrawn')
})
