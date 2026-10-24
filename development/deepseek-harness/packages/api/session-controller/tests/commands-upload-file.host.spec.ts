import { Context } from '@deepseek-ai/cordis'
import type { Events } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, ImageAttachmentRef, SaveFileAttachment, SaveFileStreamAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createScope } from '@deepseek-ai/dsh-scope'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { PreparedPromptContext, SessionRequestId } from '../src/types.ts'
import { installPreparedPromptContexts } from '../src/prompt-context.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prepared-context-fixture': { kind: 'prepared-context-fixture'; form: 'notice'; summary: string }
  }
}

const preparedContext: PreparedPromptContext = { text: 'Frozen office context at explicit Send',
  source: { kind: 'prepared-context-fixture', form: 'notice', summary: 'Reviewed company requirements' } }

const SESSION = SessionId('upload-session')

async function uploadHarness(origin?: 'subagent'): Promise<{
  ctx: Context
  controller: SessionCommandController
  agents: ApiSessionAgentController
  uploads: FileUploads
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  saveFile: ReturnType<typeof vi.fn>
  saveFileStream: ReturnType<typeof vi.fn>
  saveImages: ReturnType<typeof vi.fn>
  disposeAgent: () => Promise<void>
  uploadRoute: (request: Request) => Promise<Response>
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SESSION, {
    meta: { cwd: '/workspace', ...(origin === undefined ? {} : { origin }) },
  })
  const inbox = createInboxStub()
  const followup = vi.fn()
  const agent = {
    id: session.id,
    session,
    inbox,
    status: 'idle',
    ctx: undefined,
    steer: vi.fn(),
    followup,
    cancel: vi.fn(),
  } as unknown as Agent
  ;(agent as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  const disposeAgent = await ctx.agents.register(agent)
  const saveFile = vi.fn((input: SaveFileAttachment): Promise<FileAttachmentRef> => Promise.resolve({
    attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`),
    name: input.name ?? 'file',
    bytes: input.data.byteLength,
  }))
  const saveFileStream = vi.fn(async (input: SaveFileStreamAttachment): Promise<FileAttachmentRef> => {
    let bytes = 0
    for await (const chunk of input.data) bytes += chunk.byteLength
    return {
      attachmentId: AttachmentId(`sha256:${'ef'.repeat(32)}`),
      name: input.name ?? 'file',
      bytes,
    }
  })
  const saveImages = vi.fn((): Promise<readonly ImageAttachmentRef[]> =>
    Promise.reject(new Error('fixture did not expect image persistence')))
  ctx.provide('attachments', Object.setPrototypeOf(
    { saveFile, saveFileStream, saveImages },
    AttachmentStore.prototype,
  ) as never)
  let uploadRoute: ((request: Request) => Promise<Response>) | undefined
  ctx.provide('connection', {
    fetch: {
      register: (route: { readonly fetch: (request: Request) => Promise<Response> }) => {
        uploadRoute = route.fetch
        return () => {}
      },
    },
  } as never)
  ctx.provide('llm', {
    listModels: async () => [{ id: 'fixture-model', name: 'Model' }],
    listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
    resolveModelInfo: () => Promise.resolve({ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }),
  } as never)
  const selection: ModelSelectionRef = {
    current: { provider: 'fixture', model: 'fixture-model' },
    assembled: undefined,
  }
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    selectionFor: () => selection,
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
  } as unknown as ApiSessionAgentController
  const uploads = new FileUploads(ctx)
  if (uploadRoute === undefined) throw new Error('file upload route was not registered')
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    agents,
    uploads,
    agent,
    followup,
    saveFile,
    saveFileStream,
    saveImages,
    disposeAgent,
    uploadRoute,
  }
}

function promptRequest(content: Parameters<SessionCommandController['prompt']>[0]['content']) {
  return {
    requestId: 'req-1' as SessionRequestId,
    sessionId: SESSION,
    mode: 'queue' as const,
    content,
  }
}

describe('Session file uploads', () => {
  it.each(['new', 'inbox-retry', 'history-retry'] as const)(
    'rejects a hidden %s before resolving the Agent or consuming attachments', async (kind) => {
      const { ctx, controller, agents, agent, uploads, followup, saveImages } = await uploadHarness()
      const receipt = await uploads.upload(agent, { data: 'AAAA', name: 'private.txt' }, new AbortController().signal)
      const request = promptRequest([{ type: 'file', receiptId: receipt.receiptId },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' }, { type: 'text', text: 'Private input' }])
      if (kind !== 'new') {
        const message = createUserMessage({ content: [{ type: 'text', text: 'Already admitted input' }],
          source: { kind: 'user', rpcId: request.requestId } })
        if (kind === 'inbox-retry') agent.inbox.append('next-turn', message)
        else agent.session.append('user/message', message, { surfaceOp: 'append' })
      }
      const before = agent.session.seq
      const resolve = vi.spyOn(agents, 'resolveAgent')
      const consume = vi.spyOn(uploads, 'resolve')
      const admit = vi.spyOn(ctx.attachments, 'admitPromptContent')
      ctx.on('api-session/visible', () => Promise.resolve([]))

      await expect(controller.prompt(request)).rejects.toMatchObject({ code: 'session/not-found' })
      expect(resolve).not.toHaveBeenCalled()
      expect(consume).not.toHaveBeenCalled()
      expect(admit).not.toHaveBeenCalled()
      expect(saveImages).not.toHaveBeenCalled()
      expect(followup).not.toHaveBeenCalled()
      expect(agent.session.seq).toBe(before)
      expect(uploads.resolve(agent, receipt.receiptId)).toEqual(receipt.file)
    },
  )

  it.each(['replacement', 'unload'] as const)('rejects a prompt after Agent resolution crosses %s', async (change) => {
    const { ctx, controller, agents, agent, followup } = await uploadHarness()
    let visible = true
    ctx.on('api-session/visible', (_payload, next) => visible ? next() : Promise.resolve([]))
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    vi.spyOn(agents, 'resolveAgent').mockImplementationOnce(async () => {
      ready.resolve(undefined)
      await release.promise
      return { agent }
    })
    const admit = vi.spyOn(ctx.attachments, 'admitPromptContent')
    const pending = controller.prompt(promptRequest([{ type: 'text', text: 'Not admitted yet' }]))
    await ready.promise
    if (change === 'unload') await ctx.fiber.dispose()
    else visible = false
    release.resolve(undefined)
    await expect(pending).rejects.toMatchObject(change === 'unload'
      ? { name: 'AbortError' } : { code: 'session/not-found' })
    expect(admit).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it('stops a prompt when its visibility provider cannot confirm access', async () => {
    const { ctx, controller, agents, followup } = await uploadHarness()
    const failure = new Error('Identity check is unavailable')
    const resolve = vi.spyOn(agents, 'resolveAgent')
    ctx.on('api-session/visible', () => Promise.reject(failure))
    await expect(controller.prompt(promptRequest([{ type: 'text', text: 'Keep this private' }]))).rejects.toBe(failure)
    expect(resolve).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it.each(['queue', 'model'] as const)('rechecks an image prompt after waiting for %s admission', async (stage) => {
    const { ctx, controller, agents, saveImages, followup } = await uploadHarness()
    let visible = true
    ctx.on('api-session/visible', (_payload, next) => visible ? next() : Promise.resolve([]))
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const hold = async () => { ready.resolve(undefined); await release.promise }
    if (stage === 'queue') agents.serializeImageAdmission = async <Value>(_agent: Agent, operation: () => Promise<Value>) => {
      await hold()
      return operation()
    }
    else {
      const resolve = ctx.llm.resolveModelInfo.bind(ctx.llm)
      vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementationOnce(async (...args) => {
        const model = await resolve(...args)
        await hold()
        return model
      })
    }
    const admit = vi.spyOn(ctx.attachments, 'admitPromptContent')
    const pending = controller.prompt(promptRequest([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]))
    await ready.promise
    visible = false
    release.resolve(undefined)
    await expect(pending).rejects.toMatchObject({ code: 'session/not-found' })
    expect(admit).not.toHaveBeenCalled()
    expect(saveImages).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it('does not enqueue a prompt after visibility changes during context preparation', async () => {
    const { ctx, controller, followup } = await uploadHarness()
    let visible = true
    ctx.on('api-session/visible', (_payload, next) => visible ? next() : Promise.resolve([]))
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    ctx.on('api-session/prepare-context', async (_payload, next) => {
      const previous = await next()
      ready.resolve(undefined)
      await release.promise
      return [...previous, preparedContext]
    })
    const pending = controller.prompt(promptRequest([{ type: 'text', text: 'Reviewed under the former account' }]))
    await ready.promise
    visible = false
    release.resolve(undefined)
    await expect(pending).rejects.toMatchObject({ code: 'session/not-found' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('waits for Host preparation and joins concurrent retries before admitting one original native message', async () => {
    const { ctx, controller, followup } = await uploadHarness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const preparing = vi.fn<Events['api-session/prepare-context']>(async (payload, next) => {
      const previous = await next()
      expect(payload.requestId).toBe('req-1')
      expect(payload.mode).toBe('queue')
      entered.resolve(undefined)
      await release.promise
      return [...previous, preparedContext]
    })
    ctx.on('api-session/prepare-context', preparing)
    const request = promptRequest([{ type: 'text', text: 'Original employee text' }])
    const first = controller.prompt(request)
    await entered.promise
    const retry = controller.prompt(request)
    expect(followup).not.toHaveBeenCalled()
    release.resolve(undefined)
    expect(await Promise.all([first, retry])).toEqual([{ accepted: true }, { accepted: true }])
    expect(preparing).toHaveBeenCalledOnce()
    expect(followup).toHaveBeenCalledOnce()
    expect(followup.mock.calls[0]?.[0]).toMatchObject({ content: request.content,
      source: { kind: 'user', rpcId: request.requestId, preparedContexts: [preparedContext] } })
  })

  it('prepends captured context at the model step while preserving the submitted user message and its RPC identity', async () => {
    const { ctx, controller, followup, agent } = await uploadHarness()
    installPreparedPromptContexts(ctx)
    let current = preparedContext
    ctx.on('api-session/prepare-context', async (_payload, next) => [...await next(), current])
    const request = promptRequest([{ type: 'text', text: 'Original employee request' }])
    await controller.prompt(request)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    current = { ...preparedContext, text: 'Later edited association' }
    const result = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [message], turn: 1, step: 1, signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
    expect(result).toMatchObject({ kind: 'enter', messages: [
      { role: 'user', content: [{ type: 'text', text: preparedContext.text }], source: preparedContext.source }, message,
    ] })
    expect(message.content).toEqual(request.content)
    expect(message.source).toMatchObject({ kind: 'user', rpcId: request.requestId })
  })

  it('keeps a rejected preparation out of the inbox and allows the same request to be prepared again', async () => {
    const { ctx, controller, followup } = await uploadHarness()
    let denied = true
    ctx.on('api-session/prepare-context', async (_payload, next) => {
      if (denied) throw new Error('Expected Host context refusal')
      return [...await next(), preparedContext]
    })
    const request = promptRequest([{ type: 'text', text: 'Keep this request for retry' }])
    await expect(controller.prompt(request)).rejects.toMatchObject({ code: 'session/agent-busy' })
    expect(followup).not.toHaveBeenCalled()
    denied = false
    expect(await controller.prompt(request)).toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('cancels pending preparation on native controller disposal without admitting a late provider response', async () => {
    const { ctx, controller, followup } = await uploadHarness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('api-session/prepare-context', async (_payload, next) => {
      entered.resolve(undefined)
      await release.promise
      return [...await next(), preparedContext]
    })
    const sending = controller.prompt(promptRequest([{ type: 'text', text: 'Cancelled private input' }]))
    const rejected = expect(sending).rejects.toMatchObject({ code: 'session/agent-busy' })
    await entered.promise
    await ctx.fiber.dispose()
    await rejected
    expect(followup).not.toHaveBeenCalled()
    release.resolve(undefined)
    await Promise.resolve()
    expect(followup).not.toHaveBeenCalled()
  })

  it('registers an HTTP route bound to the upload service', async () => {
    const { uploadRoute } = await uploadHarness()
    await expect(uploadRoute(new Request('http://host/upload')))
      .resolves.toMatchObject({ status: 405 })
  })

  it('stages one verbatim upload and preserves its order with an admitted image', async () => {
    const { ctx, controller, uploads, agent, followup, saveFile, saveImages } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA', name: 'notes.pdf' }, new AbortController().signal)
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(receipt.file.name).toBe('notes.pdf')
    expect(receipt.file.bytes).toBe(3)
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual(receipt.file)
    expect(uploads.resolve(agent, 'missing' as FileUploadReceiptId)).toBeUndefined()
    const commandHandler = vi.fn((_invocation: unknown) => ({ kind: 'success' as const }))
    ctx.commands.register({
      name: 'files', description: 'Use staged files', input: { hint: '<task>', attachments: true },
      handler: commandHandler,
    })
    await ctx.commands.execute(
      agent,
      '/files inspect',
      [{ type: 'file', receiptId: receipt.receiptId }],
      new AbortController().signal,
    )
    expect(commandHandler.mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ type: 'file', attachment: receipt.file }],
    })
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    }
    saveImages.mockResolvedValueOnce([image])
    await controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'text', text: 'read it' },
    ]))
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([
      { type: 'file', attachment: receipt.file },
      { type: 'image', attachment: image },
      { type: 'text', text: 'read it' },
    ])
  })

  it('stages a bounded byte stream and forwards cancellation to storage', async () => {
    const { controller, uploads, followup, saveFileStream } = await uploadHarness()
    const abort = new AbortController()
    const receipt = await uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1, 2)
        yield Uint8Array.of(3, 4, 5)
      })(),
      signal: abort.signal,
      name: 'huge.bin',
    })
    expect(saveFileStream).toHaveBeenCalledWith(expect.objectContaining({
      signal: abort.signal,
      name: 'huge.bin',
    }))
    expect(receipt.file).toMatchObject({ name: 'huge.bin', bytes: 5 })
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      { type: 'file', attachment: receipt.file },
    ])
  })

  it('keeps the stream name optional and maps storage failures through the same error vocabulary', async () => {
    const { uploads, saveFileStream } = await uploadHarness()
    const stream = (async function* (): AsyncIterable<Uint8Array> {})()
    await expect(uploads.uploadStream({ sessionId: SESSION, data: stream }))
      .resolves.toMatchObject({ file: { name: 'file', bytes: 0 } })
    expect(saveFileStream).toHaveBeenLastCalledWith({ data: stream })
    saveFileStream.mockRejectedValueOnce('disk offline')
    await expect(uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> { yield Uint8Array.of(1) })(),
    }))
      .rejects.toMatchObject({
        code: 'gateway/internal', message: 'failed to store file upload: disk offline',
      })
  })

  it('rejects a prompt citing a file that was never staged for the session', async () => {
    const { controller, followup, saveImages } = await uploadHarness()
    await expect(controller.prompt(promptRequest([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'file', receiptId: 'missing-receipt' as FileUploadReceiptId },
    ]))).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' } })
    expect(followup).not.toHaveBeenCalled()
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('publishes no receipt when its exact Agent is disposed during storage', async () => {
    const { uploads, agent, saveFile, disposeAgent } = await uploadHarness()
    const saved = Promise.withResolvers<FileAttachmentRef>()
    saveFile.mockReturnValueOnce(saved.promise)
    const uploading = uploads.upload(agent, { data: 'AAAA', name: 'late.bin' }, new AbortController().signal)
    await vi.waitFor(() => { expect(saveFile).toHaveBeenCalledOnce() })
    await disposeAgent()
    saved.resolve({
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), name: 'late.bin', bytes: 3,
    })
    await expect(uploading).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('resolves a cold ordinary Agent and releases the resolver registration', async () => {
    const { ctx, uploads, agent, disposeAgent } = await uploadHarness()
    await disposeAgent()
    const resolveAgent = vi.fn(async () => {
      await ctx.agents.register(agent)
      return agent
    })
    const disposeResolver = uploads.registerAgentResolver(resolveAgent)
    expect(() => { uploads.registerAgentResolver(resolveAgent) }).toThrow('already registered')
    await expect(uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> { yield Uint8Array.of(1) })(),
    })).resolves.toMatchObject({ file: { bytes: 1 } })
    expect(resolveAgent).toHaveBeenCalledWith(SESSION)
    disposeResolver()
    const replacement = vi.fn(async () => agent)
    const disposeReplacement = uploads.registerAgentResolver(replacement)
    disposeResolver()
    expect(() => { uploads.registerAgentResolver(replacement) }).toThrow('already registered')
    expect(disposeReplacement).toBeTypeOf('function')
    disposeReplacement()
  })

  it('rejects a cold upload when no Agent resolver is registered', async () => {
    const { uploads, disposeAgent } = await uploadHarness()
    await disposeAgent()
    await expect(uploads.uploadStream({
      sessionId: SESSION,
      data: (async function* (): AsyncIterable<Uint8Array> {})(),
    })).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects subagent uploads before storing bytes', async () => {
    const child = await uploadHarness('subagent')
    await expect(child.uploads.upload(
      child.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'subagent/attachment-invalid',
      details: { reason: 'SUBAGENT_FILE_UNSUPPORTED' },
    })
    expect(child.saveFile).not.toHaveBeenCalled()
  })

  it('isolates receipts by Session object even when Session ids match', async () => {
    const owner = await uploadHarness()
    const other = await uploadHarness()
    expect(other.agent.session.id).toBe(owner.agent.session.id)
    expect(other.agent.session).not.toBe(owner.agent.session)
    const receipt = await owner.uploads.upload(owner.agent, { data: 'AAAA' }, new AbortController().signal)
    const binding = owner.uploads.bindPrompt(owner.agent, [receipt.receiptId], 'owner-prompt')
    binding.commit()

    expect(owner.uploads.resolve(other.agent, receipt.receiptId)).toBeUndefined()
    expect(() => owner.uploads.bindPrompt(other.agent, [receipt.receiptId], 'other-prompt'))
      .toThrow(expect.objectContaining({ code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' } }))
    owner.uploads.retirePrompt(other.agent, 'owner-prompt')
    expect(owner.uploads.resolve(owner.agent, receipt.receiptId)).toEqual(receipt.file)
    owner.uploads.retirePrompt(owner.agent, 'owner-prompt')
    expect(owner.uploads.resolve(owner.agent, receipt.receiptId)).toBeUndefined()
  })

  it('retires accepted receipts after their rpcId becomes observable', async () => {
    const { controller, uploads, agent } = await uploadHarness()
    uploads.retirePrompt(agent, 'not-staged')
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual(receipt.file)
    uploads.retirePrompt(agent, 'other-request')
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual(receipt.file)
    uploads.retirePrompt(agent, 'req-1')
    expect(uploads.resolve(agent, receipt.receiptId)).toBeUndefined()
  })

  it('retires observed prompt receipts and drops staged state with the Session', async () => {
    const first = await uploadHarness()
    const observed = await first.uploads.upload(
      first.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )
    await first.controller.prompt(promptRequest([{ type: 'file', receiptId: observed.receiptId }]))
    first.ctx.emit('session/event', first.agent.session, {
      type: 'user/message',
      data: createUserMessage({
        content: [{ type: 'text', text: 'extension event' }],
        source: { kind: 'user', rpcId: 1 } as never,
      }),
    } as never)
    expect(first.uploads.resolve(first.agent, observed.receiptId)).toEqual(observed.file)
    first.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'observed' }],
      source: { kind: 'user', rpcId: 'req-1' as SessionRequestId },
    }), { surfaceOp: 'append' })
    expect(first.uploads.resolve(first.agent, observed.receiptId)).toBeUndefined()

    const second = await uploadHarness()
    const abandoned = await second.uploads.upload(
      second.agent,
      { data: 'AAAA' },
      new AbortController().signal,
    )
    second.ctx.emit('session/disposed', second.agent.session)
    expect(second.uploads.resolve(second.agent, abandoned.receiptId)).toBeUndefined()
  })

  it('deduplicates a retried rpcId already present in the Agent inbox', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    await controller.prompt(request)
    agent.inbox.append('next-turn', followup.mock.calls[0]?.[0] as UserMessage)
    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledOnce()
  })

  it('deduplicates a retried rpcId already present in the durable log', async () => {
    const { controller, agent, followup } = await uploadHarness()
    const request = promptRequest([{ type: 'text', text: 'once' }])
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unidentified' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'accepted' }],
      source: { kind: 'user', rpcId: request.requestId },
    }), { surfaceOp: 'append' })

    await expect(controller.prompt(request)).resolves.toEqual({ accepted: true })
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects when the Agent disappears during prompt admission', async () => {
    const { controller, saveImages, disposeAgent } = await uploadHarness()
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const prompting = controller.prompt(promptRequest([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    ]))
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    await disposeAgent()
    admitted.resolve([{
      attachmentId: AttachmentId('admitted-image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }])
    await expect(prompting).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects when a previously bound receipt retires during image admission', async () => {
    const { controller, uploads, agent, saveImages } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    const admitted = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    saveImages.mockReturnValueOnce(admitted.promise)
    const prompting = controller.prompt({
      ...promptRequest([
        { type: 'file', receiptId: receipt.receiptId },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ]),
      requestId: 'req-2' as SessionRequestId,
    })
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    uploads.retirePrompt(agent, 'req-1')
    admitted.resolve([{
      attachmentId: AttachmentId('admitted-image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }])
    await expect(prompting).rejects.toMatchObject({
      code: 'session/attachment-invalid', details: { reason: 'FILE_NOT_STAGED' },
    })
  })

  it('keeps the prior receipt binding when a later prompt attempt fails', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    followup.mockImplementationOnce(() => { throw new Error('busy') })
    await expect(controller.prompt({
      ...promptRequest([{ type: 'file', receiptId: receipt.receiptId }]),
      requestId: 'req-2' as SessionRequestId,
    })).rejects.toMatchObject({ code: 'session/agent-busy' })
    uploads.retirePrompt(agent, 'req-1')
    expect(uploads.resolve(agent, receipt.receiptId)).toBeUndefined()
  })

  it('restores an unbound receipt after prompt delivery fails', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    followup.mockImplementationOnce(() => { throw new Error('busy') })
    await expect(controller.prompt(promptRequest([
      { type: 'file', receiptId: receipt.receiptId },
    ]))).rejects.toMatchObject({ code: 'session/agent-busy' })
    uploads.retirePrompt(agent, 'req-1')
    expect(uploads.resolve(agent, receipt.receiptId)).toEqual(receipt.file)
  })

  it('retires a prompt-bound receipt when its queued occurrence is removed', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const receipt = await uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal)
    await controller.prompt(promptRequest([{ type: 'file', receiptId: receipt.receiptId }]))
    const queued = followup.mock.calls[0]?.[0] as UserMessage
    agent.inbox.append('next-turn', queued)
    expect(await controller.updateQueue({
      sessionId: SESSION,
      itemId: queued.id,
      action: { kind: 'remove' },
    })).toEqual({ accepted: true })
    expect(uploads.resolve(agent, receipt.receiptId)).toBeUndefined()
  })

  it('keeps separate names for identical bytes uploaded more than once', async () => {
    const { controller, uploads, agent, followup } = await uploadHarness()
    const first = await uploads.upload(agent, { data: 'AAAA', name: 'first.txt' }, new AbortController().signal)
    const second = await uploads.upload(agent, { data: 'AAAA', name: 'second.txt' }, new AbortController().signal)
    expect(first.file.attachmentId).toBe(second.file.attachmentId)
    expect(first.receiptId).not.toBe(second.receiptId)

    await controller.prompt(promptRequest([
      { type: 'file', receiptId: first.receiptId },
      { type: 'file', receiptId: second.receiptId },
    ]))

    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.content).toEqual([
      { type: 'file', attachment: first.file },
      { type: 'file', attachment: second.file },
    ])
  })

  it('maps a non-canonical payload to the wire attachment error', async () => {
    const { uploads, agent, saveFile } = await uploadHarness()
    await expect(uploads.upload(agent, { data: 'not base64!!' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'INVALID_FILE_BASE64' } })
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('maps an unexpected storage failure to the internal wire error', async () => {
    const { uploads, agent, saveFile } = await uploadHarness()
    saveFile.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(uploads.upload(agent, { data: 'AAAA' }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: 'failed to store file upload: Error: disk unavailable',
      })
  })
})
