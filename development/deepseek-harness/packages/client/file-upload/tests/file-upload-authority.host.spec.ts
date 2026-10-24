/** Upload authority stays with its exact resolver contribution and service lifetime. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { expect, it, onTestFinished, vi } from 'vitest'
import FileUploads from '../src/index.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const file: FileAttachmentRef = { attachmentId: 'a'.repeat(64) as FileAttachmentRef['attachmentId'], name: 'test.txt', bytes: 1 }
  const save = vi.fn(async () => file)
  const stream = vi.fn(async (_request: { signal?: AbortSignal }) => file)
  ctx.provide('attachments', { admitEncodedFile: save, saveFileStream: stream, isAttachmentError: () => false } as never)
  ctx.provide('commands', { registerFileReceiptResolver: () => () => {} } as never)
  const removed = vi.fn()
  ctx.provide('connection', { fetch: { register: () => removed } } as never)
  const fiber = ctx.plugin(FileUploads)
  await fiber
  const session = ctx.sessions.create(SessionId('upload-authority'), { meta: { cwd: '/workspace' } })
  const agent = { id: session.id, session, status: 'idle', ctx } as Agent
  await ctx.agents.register(agent)
  return { ctx, fiber, uploads: ctx.fileUploads, agent, file, save, stream, removed }
}

it('keeps standalone Native uploads and denies registered live targets before storage or stream consumption', async () => {
  const { uploads, agent, save, file } = await fixture()
  expect(await uploads.upload(agent, { data: 'QQ==' }, new AbortController().signal)).toMatchObject({ file })
  const stop = uploads.registerAgentResolver(async () => {
    throw new RemoteError('session/not-found', 'Session not found', { sessionId: agent.id })
  })
  let consumed = false
  async function* body() { consumed = true; yield Uint8Array.of(65) }
  await expect(uploads.uploadStream({ sessionId: agent.id, data: body() })).rejects.toMatchObject({ code: 'session/not-found' })
  await expect(uploads.upload(agent, { data: 'QQ==' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'session/not-found' })
  expect(consumed).toBe(false)
  expect(save).toHaveBeenCalledTimes(1)
  stop()
})

it('withdraws an in-flight receipt with its resolver fiber and accepts a new contribution without reusing old authority', async () => {
  const { ctx, uploads, agent, save, file } = await fixture()
  const resolver = () => Promise.resolve(agent)
  let oldStop = () => {}
  const owner = ctx.plugin({ name: 'upload-authority-owner', apply(scope: Context) {
    scope.effect(() => { oldStop = uploads.registerAgentResolver(resolver); return oldStop })
  } })
  await owner
  const entered = Promise.withResolvers<undefined>()
  const complete = Promise.withResolvers<FileAttachmentRef>()
  save.mockImplementationOnce(() => { entered.resolve(undefined); return complete.promise })
  const pending = uploads.upload(agent, { data: 'QQ==' }, new AbortController().signal)
  const outcome = Promise.allSettled([pending])
  await entered.promise
  await owner.dispose()
  complete.resolve(file)
  expect(await outcome).toMatchObject([{ status: 'rejected', reason: { code: 'session/not-found' } }])
  await expect(uploads.upload(agent, { data: 'QQ==' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'session/not-found' })
  expect(save).toHaveBeenCalledTimes(1)
  const stop = uploads.registerAgentResolver(resolver)
  oldStop()
  const result = await uploads.upload(agent, { data: 'QQ==' }, new AbortController().signal)
  expect(uploads.resolve(agent, result.receiptId)).toEqual(file)
  expect(save).toHaveBeenCalledTimes(2)
  stop()
})

it('aborts active streaming storage when the upload plugin is withdrawn and publishes no late receipt', async () => {
  const { fiber, uploads, agent, stream, removed } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  let aborted = false
  stream.mockImplementationOnce(request => new Promise((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => {
      aborted = true
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }, { once: true })
    entered.resolve(undefined)
  }))
  async function* body() { yield Uint8Array.of(65) }
  const result = Promise.allSettled([uploads.uploadStream({ sessionId: agent.id, data: body() })])
  await entered.promise
  await fiber.dispose()
  expect((await result)[0]).toMatchObject({ status: 'rejected' })
  expect(aborted).toBe(true)
  expect(removed).toHaveBeenCalledOnce()
})
