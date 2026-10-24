/** Delivery gestures share pending state, report failures, and cancel with the plugin. */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { PresentedOpenController } from '../src/client/present-open.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const id = SessionId('fork')
const url = 'api/present.open?sessionId=fork&seq=2&index=1'

it('hands off exact download bytes once, shares pending state, and expires successful feedback', async () => {
  vi.useFakeTimers()
  const reply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValue(reply.promise)
  vi.stubGlobal('fetch', fetcher)
  const save = vi.fn<(blob: Blob, name: string) => void>()
  const controller = new PresentedOpenController(save)
  const task = controller.download(id, 2, 1, '交付物.bin')
  await controller.download(id, 2, 1, 'duplicate.bin')
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0]?.[0]).toBe('api/present.download?sessionId=fork&seq=2&index=1')
  expect(controller.state.getSnapshot()[url]).toBe('downloading')
  reply.resolve(new Response(Uint8Array.of(0, 128, 255)))
  await task
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]?.[1]).toBe('交付物.bin')
  expect(new Uint8Array(await save.mock.calls[0]![0].arrayBuffer())).toEqual(Uint8Array.of(0, 128, 255))
  expect(controller.state.getSnapshot()[url]).toBe('downloaded')
  await vi.advanceTimersByTimeAsync(5200)
  expect(controller.state.getSnapshot()[url]).toBeUndefined()
  await controller.dispose()
})

it.each([404, 413, 500, 'network'] as const)('makes download failure %s retryable without saving an error response', async (failure) => {
  const fetcher = vi.fn()
  if (failure === 'network') fetcher.mockRejectedValueOnce(new Error('offline'))
  else fetcher.mockResolvedValueOnce(new Response('not file bytes', { status: failure }))
  fetcher.mockResolvedValue(new Response('actual source'))
  vi.stubGlobal('fetch', fetcher)
  const save = vi.fn()
  const controller = new PresentedOpenController(save)
  await controller.download(id, 2, 1, 'source.txt')
  expect(save).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot()[url]).toBe(failure === 413 ? 'downloadTooLarge' : 'downloadError')
  await controller.download(id, 2, 1, 'source.txt')
  expect(save).toHaveBeenCalledOnce()
  expect(controller.state.getSnapshot()[url]).toBe('downloaded')
  await controller.dispose()
})

it('does not hand late download bytes to the browser after disposal', async () => {
  const reply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValue(reply.promise)
  vi.stubGlobal('fetch', fetcher)
  const save = vi.fn()
  const controller = new PresentedOpenController(save)
  const task = controller.download(id, 2, 1, 'source.txt')
  const state = controller.state.getSnapshot()
  const disposal = controller.dispose()
  expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true)
  reply.resolve(new Response('late bytes'))
  await Promise.all([task, disposal])
  expect(save).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot()).toBe(state)
  await controller.download(id, 2, 1, 'new.txt')
  expect(fetcher).toHaveBeenCalledOnce()
})

it('discards an old connection download while allowing the replacement connection to save its own bytes', async () => {
  const oldReply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValueOnce(oldReply.promise).mockResolvedValue(new Response('new Host bytes'))
  vi.stubGlobal('fetch', fetcher)
  const save = vi.fn<(blob: Blob, name: string) => void>()
  const controller = new PresentedOpenController(save)
  const old = controller.download(id, 2, 1, 'old.txt')
  controller.resetHost()
  expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true)
  expect(controller.state.getSnapshot()[url]).toBeUndefined()
  await controller.download(id, 2, 1, 'new.txt')
  oldReply.resolve(new Response('old Host bytes'))
  await old
  expect(save).toHaveBeenCalledOnce()
  expect(await save.mock.calls[0]![0].text()).toBe('new Host bytes')
  expect(save.mock.calls[0]?.[1]).toBe('new.txt')
  expect(controller.state.getSnapshot()[url]).toBe('downloaded')
  await controller.dispose()
})

it('coalesces concurrent card and mention gestures, then allows another open', async () => {
  const reply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValue(reply.promise)
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const first = controller.open(id, 2, 1)
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledWith(url, { method: 'POST', signal: expect.any(AbortSignal) as AbortSignal })
  expect(controller.state.getSnapshot()[url]).toBe('opening')
  reply.resolve(new Response(null, { status: 204 }))
  await first
  expect(controller.state.getSnapshot()[url]).toBe('opened')
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledTimes(2)
  await controller.dispose()
})

it('opens changed files through their own coordinates', async () => {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  await controller.openChanged(id, 9, 1)
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['api/changes.open?sessionId=fork&seq=9&index=1'])
  expect(controller.state.getSnapshot()['api/changes.open?sessionId=fork&seq=9&index=1']).toBe('opened')
  fetcher.mockResolvedValueOnce(new Response(null, { status: 422 }))
  await controller.openChanged(id, 9, 1)
  expect(controller.state.getSnapshot()['api/changes.open?sessionId=fork&seq=9&index=1']).toBe('nativeUnavailable')
  await controller.dispose()
})

it.each(['http', 'network'])('publishes retryable %s failures', async (failure) => {
  const fetcher = vi.fn()
  if (failure === 'http') fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }))
  else fetcher.mockRejectedValueOnce(new Error('offline'))
  fetcher.mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  await controller.open(id, 2, 1)
  expect(controller.state.getSnapshot()[url]).toBe('error')
  await controller.open(id, 2, 1)
  expect(controller.state.getSnapshot()[url]).toBe('opened')
  await controller.dispose()
})

it('awaits cancellation and prevents late state publication or new requests after disposal', async () => {
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<Response>()
  const fetcher = vi.fn((_url: string, { signal }: RequestInit) => {
    signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    return release.promise
  })
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const open = controller.open(id, 2, 1)
  const state = controller.state.getSnapshot()
  let disposed = false
  const disposal = controller.dispose().then(() => { disposed = true })
  await aborted.promise
  expect(disposed).toBe(false)
  release.resolve(new Response(null, { status: 204 }))
  await Promise.all([open, disposal])
  expect(controller.state.getSnapshot()).toBe(state)
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledOnce()
})


it('shares pending state across open and reveal and retries the selected action', async () => {
  const reply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValueOnce(reply.promise).mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const revealing = controller.open(id, 2, 1, 'reveal')
  await controller.open(id, 2, 1)
  expect(controller.state.getSnapshot()[url]).toBe('revealing')
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0]?.[0]).toBe(`${url}&action=reveal`)
  reply.resolve(new Response(null, { status: 500 }))
  await revealing
  expect(controller.state.getSnapshot()[url]).toBe('revealError')
  await controller.open(id, 2, 1, 'reveal')
  expect(controller.state.getSnapshot()[url]).toBe('revealed')
  await controller.dispose()
})

it.each([null, {}, { name: 'host', available: 'yes', fileManager: 'finder' },
  { name: 'host', available: true, fileManager: 'unknown' }, 'invalid json', 'http', 'network',
])('makes invalid Host metadata retryable: %j', async (value) => {
  const host = { name: 'linux-host', available: true, fileManager: 'directory' }
  const fetcher = vi.fn()
  if (value === 'network') fetcher.mockRejectedValueOnce(new Error('offline'))
  else if (value === 'http') fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }))
  else if (value === 'invalid json') fetcher.mockResolvedValueOnce(new Response('bad JSON'))
  else fetcher.mockResolvedValueOnce(Response.json(value))
  fetcher.mockResolvedValueOnce(Response.json(host))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  await controller.loadHost()
  expect(controller.host.getSnapshot()).toBe('error')
  await controller.loadHost()
  expect(controller.host.getSnapshot()).toEqual(host)
  await controller.dispose()
  await controller.loadHost()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('coalesces metadata reads and suppresses their publication after disposal', async () => {
  const reply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValue(reply.promise)
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const first = controller.loadHost()
  const second = controller.loadHost()
  expect(fetcher).toHaveBeenCalledOnce()
  const disposal = controller.dispose()
  expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true)
  reply.resolve(Response.json({ name: 'host', available: false, fileManager: null }))
  await Promise.all([first, second, disposal])
  expect(controller.host.getSnapshot()).toBeNull()
})


it('invalidates cached desktop metadata without eagerly fetching an unused Host', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ name: 'old', available: false, fileManager: null }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  await controller.loadHost()
  controller.resetHost()
  expect(controller.host.getSnapshot()).toBeNull()
  expect(fetcher).toHaveBeenCalledOnce()
  fetcher.mockResolvedValue(Response.json({ name: 'new', available: true, fileManager: 'finder' }))
  await controller.loadHost()
  expect(controller.host.getSnapshot()).toMatchObject({ name: 'new', available: true })
  await controller.dispose()
})

it('discards a replaced Host response and keeps the new metadata request coalesced', async () => {
  const oldReply = Promise.withResolvers<Response>()
  const newReply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValueOnce(oldReply.promise).mockReturnValue(newReply.promise)
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const oldLoad = controller.loadHost()
  controller.resetHost()
  expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true)
  const newLoad = controller.loadHost()
  oldReply.resolve(Response.json({ name: 'old', available: false, fileManager: null }))
  await oldLoad
  expect(controller.host.getSnapshot()).toBeNull()
  const coalesced = controller.loadHost()
  expect(fetcher).toHaveBeenCalledTimes(2)
  newReply.resolve(Response.json({ name: 'new', available: true, fileManager: 'finder' }))
  await Promise.all([newLoad, coalesced])
  expect(controller.host.getSnapshot()).toMatchObject({ name: 'new' })
  await controller.dispose()
})


it.each(['open', 'reveal'] as const)('reports an unavailable Host path for %s while retaining the declaration', async (action) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 422 })))
  const controller = new PresentedOpenController()
  await controller.open(id, 2, 1, action)
  expect(controller.state.getSnapshot()[url]).toBe('nativeUnavailable')
  await controller.dispose()
})


it('encodes an explicit application identifier without changing the file coordinates', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  expect(await controller.open(id, 2, 1, 'open', '/Apps/A&B.app')).toBeNull()
  expect(fetcher).toHaveBeenCalledWith(`${url}&application=%2FApps%2FA%26B.app`, { method: 'POST', signal: expect.any(AbortSignal) as AbortSignal })
  await controller.dispose()
})


it.each(['open', 'reveal'] as const)('expires successful %s feedback after five seconds and its fade', async (action) => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  const controller = new PresentedOpenController()
  await controller.open(id, 2, 1, action)
  await vi.advanceTimersByTimeAsync(5000)
  expect(controller.state.getSnapshot()[url]).toBe(action === 'open' ? 'opened' : 'revealed')
  await vi.advanceTimersByTimeAsync(200)
  expect(controller.state.getSnapshot()[url]).toBeUndefined()
  await controller.dispose()
})

it('cancels an earlier success expiry when the next action fails', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  await controller.open(id, 2, 1)
  await vi.advanceTimersByTimeAsync(4000)
  await controller.open(id, 2, 1)
  await vi.advanceTimersByTimeAsync(6000)
  expect(controller.state.getSnapshot()[url]).toBe('error')
  await controller.dispose()
})

it('cancels success expiry when its controller is disposed', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  const controller = new PresentedOpenController()
  await controller.open(id, 2, 1)
  const state = controller.state.getSnapshot()
  await controller.dispose()
  await vi.advanceTimersByTimeAsync(6000)
  expect(controller.state.getSnapshot()).toBe(state)
})


it('owns the expiry before notifying subscribers that can dispose the controller', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  const controller = new PresentedOpenController()
  let disposal: Promise<void> | undefined
  const release = controller.state.subscribe(() => {
    if (controller.state.getSnapshot()[url] === 'opened') disposal = controller.dispose()
  })
  await controller.open(id, 2, 1)
  await disposal
  const state = controller.state.getSnapshot()
  await vi.advanceTimersByTimeAsync(6000)
  expect(controller.state.getSnapshot()).toBe(state)
  release()
})
