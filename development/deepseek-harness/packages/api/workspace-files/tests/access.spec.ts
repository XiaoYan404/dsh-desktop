/** Session policy checks protect actual file content and queued metadata delivery. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let allowed: boolean
const denied = new Error('Session access denied')

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-access-')
  allowed = true
  const lifetime = new AbortController()
  harness.ctx.on('workspace-files/access', async (_request, next) => {
    await next()
    if (!allowed) throw denied
    return lifetime.signal
  })
  await writeFile(join(harness.workspace, 'private.txt'), 'PRIVATE_FILE_BYTES\n')
})

afterEach(async () => {
  await harness.dispose()
  vi.restoreAllMocks()
})

it('denies file reads before accessing the filesystem and preserves authorized bytes', async () => {
  const service = harness.endpoint()
  const inspected = vi.spyOn(harness.ctx.fs, 'lstat')
  allowed = false
  const calls = [
    service.read(harness.scope, 'private.txt', {}, signal()),
    service.readBytes(harness.scope, 'private.txt', {}, signal()),
    service.readBytes(harness.scope, 'private.txt', { range: { length: 3 } }, signal()),
    service.stat(harness.scope, 'private.txt', signal()),
    service.list(harness.scope, '.', signal()),
  ]
  expect(await Promise.allSettled(calls)).toEqual(calls.map(() => ({ status: 'rejected', reason: denied })))
  expect(inspected).not.toHaveBeenCalled()
  allowed = true
  expect((await service.read(harness.scope, 'private.txt', {}, signal())).text).toBe('PRIVATE_FILE_BYTES')
  expect(Buffer.from((await service.readBytes(harness.scope, 'private.txt', {}, signal())).data).toString('utf8'))
    .toBe('PRIVATE_FILE_BYTES\n')
})

it('withholds bytes when the session policy changes during the actual read', async () => {
  const service = harness.endpoint()
  const ready = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const read = harness.ctx.fs.readBytes.bind(harness.ctx.fs)
  vi.spyOn(harness.ctx.fs, 'readBytes').mockImplementation(async (...args) => {
    const result = await read(...args)
    ready.resolve(undefined)
    await release.promise
    return result
  })
  const pending = service.readBytes(harness.scope, 'private.txt', {}, signal())
  const checked = expect(pending).rejects.toBe(denied)
  try {
    await ready.promise
    allowed = false
    release.resolve(undefined)
    await checked
  } finally {
    release.resolve(undefined)
  }
})

it('checks every watch frame after the ready frame and closes the exact watcher on denial', async () => {
  const service = harness.endpoint()
  const unwatch = vi.fn(async () => {})
  vi.spyOn(harness.ctx.fs, 'watch').mockResolvedValue(unwatch)
  const controller = new AbortController()
  const iterator = service.changes(harness.scope, 'private.txt', controller.signal)[Symbol.asyncIterator]()
  try {
    expect(await iterator.next()).toMatchObject({ value: { kind: 'ready' } })
    const target = await harness.ctx.fs.resolve(join(harness.workspace, 'private.txt'))
    const next = iterator.next()
    const checked = expect(next).rejects.toBe(denied)
    allowed = false
    harness.ctx.emit('fs/observed', target, { kind: 'absent' }, undefined)
    await checked
    expect(unwatch).toHaveBeenCalledTimes(1)
  } finally {
    controller.abort()
    await iterator.return?.()
  }
})
