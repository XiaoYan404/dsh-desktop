/** Real central office, employee Host credentials, generated Remotes and browser account controls. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import OfficeGateway from '@deepseek-ai/dsh-enterprise-office-gateway'
import type { OfficeConversationId, OfficeItemId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionControlFrame, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { OfficeController } from '@deepseek-ai/dsh-client-ui-office'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { acknowledgeReloadConnectionLoss, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const admin = 'admin' as OfficeMemberId
const lin = 'lin' as OfficeMemberId
const chen = 'chen' as OfficeMemberId
const password = 'Browser office password 2026!'
const replacement = 'Updated browser office password!'

async function central(root: string, port = 0, announcementRotationMs = 6000, scheduleAvailabilityEnabled = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'data') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(OfficeService, { companyName: 'Shared company', timeZone: 'Asia/Shanghai', dshHome: root,
    announcementRotationMs, scheduleAvailabilityEnabled, members: [
      { id: admin, name: 'Office administrator', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
      { id: lin, name: 'Lin', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
      { id: chen, name: 'Chen', department: 'Finance', jobTitle: 'Employee', role: 'employee' },
    ] })
  await ctx.office.initializeIdentity(admin, password)
  await ctx.plugin(OfficeGateway, { host: '127.0.0.1', port, administratorId: admin, loginRequestsPerMinute: 100 })
  return { ctx, address: ctx.officeGateway.address }
}

async function setup(announcementRotationMs = 6000, officeTools = false, scheduleAvailabilityEnabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-browser-'))
  onTestFinished(async () => {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-browser-')) throw new Error('Unexpected temporary root')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const server = await central(root, 0, announcementRotationMs, scheduleAvailabilityEnabled)
  const overlay = join(root, 'employee.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'enterprise-office', disabled: true },
    { id: 'ui-office', disabled: false, config: { principalId: '', gatewayUrl: server.address } },
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
    ...officeTools ? [{ id: 'tool-office', disabled: false }] : [],
  ]))
  return { root, server, overlay }
}

class HistoryAdapter extends LlmAdapter {
  calls = 0
  override async listModels(provider: string) { return [
    { provider, id: 'history', name: 'Native history fixture' },
    { provider, id: 'history-alternate', name: 'Alternate Native history fixture' },
  ] }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'History turn completed.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function adoptionFixture(cold: boolean) {
  const { server, overlay } = await setup(6000, true)
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const provider = 'office-adoption-test'
  const adapter = new HistoryAdapter()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'history' })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900, true)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  const id = SessionId(`ordinary-office-adoption-${randomUUID()}`)
  const conversationId = String(id) as OfficeConversationId
  const selection = await server.ctx.office.saveConversationLinks(lin, { conversationId, revision: 0,
    requestId: randomUUID(), kind: 'integrations', integrations: [] })
  const capture = await server.ctx.office.captureConversation(lin,
    { conversationId, revision: selection.revision, requestId: randomUUID() })
  expect(capture.selection.integrations).toEqual([])
  expect(capture.selection.tools).toEqual([])
  const handle = await scaffold.ctx.agents.create({ sessionId: id, meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider, model: 'history' }, setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) })
  onTestFinished(() => handle.dispose())
  const settled = scaffold.whenTurnSettled()
  handle.agent.send(createUserMessage({ content: [{ type: 'text', text: 'ORDINARY_OFFICE_PRIVATE_ADOPTION_PROMPT' }],
    source: { kind: 'user', preparedContexts: [{ text: 'Office conversation without selected systems or tools.',
      source: { kind: 'office', form: 'snapshot', sections: [], capture } }] } }), 'next-turn', true)
  expect(await settled).toBe(id)
  expect(adapter.calls).toBe(1)
  if (cold) await handle.dispose()
  const events = async () => {
    using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
    return [...observation.events]
  }
  const before = await events()
  const create = async (sessionId = id): Promise<unknown> => {
    const response = await scaffold.hostFetch('/api/session/create', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/create',
        payload: { args: { request: { sessionId, cwd: scaffold.workspaceCwd } } } }) })
    expect(response.ok).toBe(true)
    return response.json()
  }
  return { scaffold, page, console, id, adapter, events, before, create }
}

it('office terminal metadata and retained output streams reject a replacement employee without killing the owner shell', async () => {
  const { scaffold, page, console, id, events, before, adapter } = await adoptionFixture(false)
  const agent = scaffold.ctx.agents.get(id)
  if (!agent) throw new Error('Expected the original employee Agent')
  const subprocess = agent.ctx.get('subprocess')
  if (!subprocess) throw new Error('Expected the real terminal subprocess provider')
  const handles: SubprocessTerminalHandle[] = []
  const spawn = subprocess.spawnTerminal.bind(subprocess)
  const observed = vi.spyOn(subprocess, 'spawnTerminal').mockImplementation(async (spec) => {
    const handle = await spawn(spec)
    handles.push(handle)
    return handle
  })
  onTestFinished(() => { observed.mockRestore() })
  const request = async (method: string, args: object): Promise<unknown> => {
    const rpcId = randomUUID()
    const response = await scaffold.hostFetch(`/api/terminal/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId,
        method: `terminal/${method}`, payload: { args } }) })
    expect(response.ok).toBe(true)
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ rpcId })
    return envelope
  }
  const terminalId = randomUUID()
  const shells = z.object({ result: z.object({ ok: z.literal(true), value: z.array(z.object({
    path: z.string(), name: z.string(),
  })) }) }).parse(await request('shells', { agentId: id })).result.value
  const selected = process.platform === 'win32' ? shells.find(shell => /^(pwsh|powershell)(\.exe)?$/iu.test(basename(shell.path))) : shells[0]
  if (!selected) throw new Error('The execution provider did not advertise the required test shell')
  const created = await request('create', { agentId: id, request: { id: terminalId, cols: 90, rows: 28, shellPath: selected.path } })
  await writeFile(join(REPO_ROOT, '.artifacts/enterprise-office/terminal-browser/create-response.json'), JSON.stringify(created, null, 2))
  expect(created, JSON.stringify(created))
    .toMatchObject({ result: { ok: true, value: { id: terminalId, state: 'running', cwd: scaffold.workspaceCwd } } })
  expect(handles).toHaveLength(1)
  expect(await request('list', { sessionId: id })).toMatchObject({ result: { ok: true, value: [{ id: terminalId }] } })
  type ProbeWindow = Window & { officeTerminalProbe?: { socket: WebSocket; frames: unknown[] } }
  await page.evaluate(async () => {
    const endpoint = new URL('/api/remote.mux', window.location.href)
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(endpoint)
    const probe = { socket, frames: [] as unknown[] }
    ;(window as ProbeWindow).officeTerminalProbe = probe
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') throw new Error('Expected a text Remote stream frame')
      const frame: unknown = JSON.parse(event.data)
      probe.frames.push(frame)
    })
    await new Promise<void>((ready, failed) => {
      socket.addEventListener('open', () => { ready() }, { once: true })
      socket.addEventListener('error', () => { failed(new Error('The test Remote mux did not connect')) }, { once: true })
    })
  })
  const frames = async () => z.array(z.object({ type: z.enum(['item', 'end', 'error']), streamId: z.string(),
    value: z.unknown().optional(), error: z.unknown().optional() })).parse(await page.evaluate(() =>
    (window as ProbeWindow).officeTerminalProbe?.frames ?? []))
  const open = async (streamId: string, endpoint: string, args: object) => {
    await page.evaluate((message) => {
      const probe = (window as ProbeWindow).officeTerminalProbe
      if (!probe) throw new Error('Expected the test Remote mux')
      probe.socket.send(JSON.stringify(message))
    }, { type: 'open', streamId, endpoint, payload: { args } })
  }
  const snapshot = z.object({ type: z.literal('snapshot'), screen: z.string(), info: z.object({ id: z.literal(terminalId) }) })
  const refused = async (streamId: string) => (await frames()).some(frame => frame.type === 'error'
    && frame.streamId === streamId && z.object({ code: z.literal('session/not-found') }).safeParse(frame.error).success)
  await open('owner-output', 'terminal/follow', { agentId: id, id: terminalId, attachmentId: randomUUID() })
  await expect.poll(async () => (await frames()).some(frame => frame.type === 'item' && frame.streamId === 'owner-output'
    && snapshot.safeParse(frame.value).success)).toBe(true)
  await open('owner-hold', 'terminal/retain', { sessionId: id, id: terminalId })
  await expect.poll(frames).toContainEqual({ type: 'item', streamId: 'owner-hold', value: { type: 'retained' } })
  await signOut(page)
  await signIn(page, chen)
  expect(await request('list', { sessionId: id }))
    .toMatchObject({ result: { ok: false, error: { code: 'session/not-found' } } })
  await open('replacement-hold', 'terminal/retain', { sessionId: id, id: terminalId })
  await expect.poll(() => refused('replacement-hold')).toBe(true)
  const afterReplacement = (await frames()).length
  const privatePrefix = 'OFFICE_TERMINAL_PRIVATE_'
  const privateSuffix = 'OUTPUT_AFTER_ACCOUNT_REPLACEMENT'
  const privateOutput = privatePrefix + privateSuffix
  await handles[0]!.write(process.platform === 'win32' ? `Write-Output ('${privatePrefix}' + '${privateSuffix}')\r`
    : `printf '%s%s\\n' '${privatePrefix}' '${privateSuffix}'\n`)
  await expect.poll(() => refused('owner-output')).toBe(true)
  expect((await frames()).slice(afterReplacement).filter(frame => frame.streamId === 'owner-output' && frame.type === 'item')).toEqual([])
  expect((await frames()).filter(frame => frame.streamId === 'replacement-hold' && frame.type === 'item')).toEqual([])
  expect(scaffold.ctx.agents.get(id)).toBe(agent)
  expect(handles).toHaveLength(1)
  await signOut(page)
  expect(await request('list', { sessionId: id }))
    .toMatchObject({ result: { ok: false, error: { code: 'session/not-found' } } })
  await signIn(page, lin)
  expect(await request('list', { sessionId: id })).toMatchObject({ result: { ok: true,
    value: [{ id: terminalId, state: 'running' }] } })
  await open('restored-owner', 'terminal/follow', { agentId: id, id: terminalId, attachmentId: randomUUID() })
  await expect.poll(async () => (await frames()).some((frame) => {
    const parsed = snapshot.safeParse(frame.value)
    return frame.type === 'item' && frame.streamId === 'restored-owner' && parsed.success && parsed.data.screen.includes(privateOutput)
  })).toBe(true)
  await page.evaluate(() => { (window as ProbeWindow).officeTerminalProbe?.socket.close() })
  expect(await events()).toEqual(before)
  expect(adapter.calls).toBe(1)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('cold office workspace files withhold private metadata and bytes after account replacement', async () => {
  const { scaffold, page, id, events, before, adapter } = await adoptionFixture(true)
  const name = `private-office-file-${randomUUID()}.txt`
  const path = join(scaffold.workspaceCwd, name)
  const bytes = new Uint8Array([0, 128, 255, 13, 10, 35, 88])
  await writeFile(path, bytes)
  const textName = `private-office-text-${randomUUID()}.txt`
  await writeFile(join(scaffold.workspaceCwd, textName), 'PRIVATE_OFFICE_WORKSPACE_TEXT\n')
  const request = async (method: string, args: object = {}): Promise<{ envelope: unknown; data?: Uint8Array }> => {
    const rpcId = randomUUID()
    const response = await scaffold.hostFetch(`/api/workspaceFiles/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId,
        method: `workspaceFiles/${method}`, payload: { args: { workspaceFileScopeId: id, ...args } } }) })
    expect(response.ok).toBe(true)
    if (response.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const form = await response.formData()
      const metadata = form.get('metadata')
      if (typeof metadata !== 'string') throw new Error('Expected binary RPC metadata')
      const envelope: unknown = JSON.parse(metadata)
      const attachments = [...form.values()].filter(value => typeof value !== 'string')
      expect(attachments).toHaveLength(1)
      expect(envelope).toMatchObject({ rpcId })
      return { envelope, data: new Uint8Array(await attachments[0]!.arrayBuffer()) }
    }
    const envelope: unknown = await response.json()
    expect(envelope).toMatchObject({ rpcId })
    return { envelope }
  }
  expect(await request('readBytes', { path: name, options: {} }))
    .toMatchObject({ envelope: { result: { ok: true, value: { offset: 0, eof: true, bytes: bytes.length } } }, data: bytes })
  expect(await request('read', { path: textName, range: {} }))
    .toMatchObject({ envelope: { result: { ok: true, value: { text: 'PRIVATE_OFFICE_WORKSPACE_TEXT' } } } })
  expect(scaffold.ctx.agents.get(id)).toBeUndefined()
  await signOut(page)
  await signIn(page, chen)
  for (const [method, args] of [
    ['read', { path: textName, range: {} }],
    ['readBytes', { path: name, options: {} }],
    ['readBytes', { path: name, options: { range: { offset: 1, length: 2 } } }],
    ['stat', { path: name }],
    ['list', { path: '.' }],
  ] as const) {
    expect(await request(method, args)).toMatchObject({ envelope: { result: { ok: false, error: { code: 'session/not-found' } } } })
  }
  expect(scaffold.ctx.agents.get(id)).toBeUndefined()
  await signOut(page)
  expect(await request('stat', { path: name }))
    .toMatchObject({ envelope: { result: { ok: false, error: { code: 'session/not-found' } } } })
  await signIn(page, lin)
  const ready = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const read = scaffold.ctx.fs.readBytes.bind(scaffold.ctx.fs)
  const held = vi.spyOn(scaffold.ctx.fs, 'readBytes').mockImplementation(async (...args) => {
    const result = await read(...args)
    if (scaffold.ctx.fs.processPath(args[0]) === path) {
      ready.resolve(undefined)
      await release.promise
    }
    return result
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  const pending = request('readBytes', { path: name, options: {} })
  try {
    await ready.promise
    await signOut(page)
    await signIn(page, chen)
    release.resolve(undefined)
    expect(await pending).toMatchObject({ envelope: { result: { ok: false, error: { code: 'session/not-found' } } } })
  } finally {
    release.resolve(undefined)
    held.mockRestore()
  }
  await signOut(page)
  await signIn(page, lin)
  expect(await request('readBytes', { path: name, options: {} }))
    .toMatchObject({ envelope: { result: { ok: true } }, data: bytes })
  expect(await events()).toEqual(before)
  expect(scaffold.ctx.agents.get(id)).toBeUndefined()
  expect(adapter.calls).toBe(1)
})

it('workspace office mutations reject another employee before changing metadata or stopping activity', async () => {
  const { scaffold, page, id, events, before, adapter } = await adoptionFixture(false)
  const agent = scaffold.ctx.agents.get(id)
  if (!agent) throw new Error('Expected the original employee Agent')
  const held = new CancelHistoryAdapter()
  const model = vi.spyOn(adapter, 'stream').mockImplementationOnce(options => held.stream(options))
  const cancelled = vi.spyOn(agent, 'cancel')
  onTestFinished(() => { held.release.resolve(undefined); model.mockRestore(); cancelled.mockRestore() })
  const settled = scaffold.whenTurnSettled()
  agent.send(createUserMessage({ content: [{ type: 'text', text: 'Keep private work running during metadata authorization' }],
    source: { kind: 'user' } }), 'next-turn', true)
  await held.ready.promise
  const runningEvents = await events()
  expect(runningEvents.slice(0, before.length)).toEqual(before)
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  await workspace.attachSession(id)
  await scaffold.ctx.workspaceRegistry.pinSession(id)
  const stop = vi.fn()
  scaffold.ctx.on('workspace/session-stop', stop)
  const request = async (verb: string, value: object): Promise<unknown> => {
    const response = await scaffold.hostFetch(`/api/workspace/${verb}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request',
        rpcId: randomUUID(), method: `workspace/${verb}`, payload: { args: { request: value } } }) })
    expect(response.ok).toBe(true)
    return response.json()
  }
  await signOut(page)
  await signIn(page, chen)
  for (const verb of ['pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession', 'insertSessionBefore']) {
    expect(await request(verb, { sessionId: id, workspaceId: workspace.id, stopActivity: true }))
      .toMatchObject({ result: { ok: false, error: { code: 'session/not-found' } } })
  }
  expect(stop).not.toHaveBeenCalled()
  expect(cancelled).not.toHaveBeenCalled()
  expect(agent.status).toBe('running')
  expect(scaffold.ctx.workspaceRegistry.archivedSessionIds).not.toContain(id)
  expect(scaffold.ctx.workspaceRegistry.pinnedSessionIds).toContain(id)
  expect(workspace.sessionIds).toEqual([id])
  expect(await events()).toEqual(runningEvents)
  expect(adapter.calls).toBe(1)
  expect(await request('create', { path: workspace.path }))
    .toMatchObject({ result: { ok: true, value: { workspace: { sessionIds: [] } } } })
  const follow = new AbortController()
  const iterator = scaffold.ctx.workspaceController.follow(follow.signal)[Symbol.asyncIterator]()
  const baseline = await iterator.next()
  expect(baseline).toMatchObject({ value: { type: 'baseline', value: { pinnedSessionIds: [],
    items: [{ sessionIds: [] }] } } })
  follow.abort()
  await iterator.return?.()
  await signOut(page)
  await signIn(page, lin)
  expect(await request('pinSession', { sessionId: id })).toMatchObject({ result: { ok: true } })
  expect(scaffold.ctx.workspaceRegistry.pinnedSessionIds).toContain(id)
  expect(await request('archiveSession', { sessionId: id, stopActivity: true })).toMatchObject({ result: { ok: true } })
  expect(await settled).toBe(id)
  expect(cancelled).toHaveBeenCalledTimes(1)
  expect(stop).toHaveBeenCalledTimes(1)
})

it.each([false, true])('explicit office adoption rejects replacement for cold=%s without activating or modifying private history', async (cold) => {
  const { scaffold, page, console, id, adapter, events, before, create } = await adoptionFixture(cold)
  await signOut(page)
  await signIn(page, chen)
  const beforeAgent = scaffold.ctx.agents.get(id)
  expect(await create()).toMatchObject({ result: { ok: false, error: { code: 'session/not-found' } } })
  expect(scaffold.ctx.agents.get(id)).toBe(beforeAgent)
  expect(await events()).toEqual(before)
  expect(adapter.calls).toBe(1)
  const nativeId = SessionId(`native-create-control-${randomUUID()}`)
  expect(await create(nativeId)).toMatchObject({ result: { ok: true, value: { sessionId: nativeId } } })
  const nativeAgent = scaffold.ctx.agents.get(nativeId)
  expect(nativeAgent).toBeDefined()
  expect(await create(nativeId)).toMatchObject({ result: { ok: true, value: { sessionId: nativeId } } })
  expect(scaffold.ctx.agents.get(nativeId)).toBe(nativeAgent)
  await signOut(page)
  await signIn(page, lin)
  expect(await create()).toMatchObject({ result: { ok: true, value: { sessionId: id } } })
  expect(scaffold.ctx.agents.get(id)).toBeDefined()
  expect((await events()).slice(0, before.length)).toEqual(before)
  expect(adapter.calls).toBe(1)
  expect(await page.content()).not.toContain('ORDINARY_OFFICE_PRIVATE_ADOPTION_PROMPT')
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('explicit office adoption rechecks the employee after a held visibility review before cold activation', async () => {
  const { scaffold, page, console, id, adapter, events, before, create } = await adoptionFixture(true)
  const operation = new AsyncLocalStorage<boolean>()
  const ready = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let first = true
  const stop = scaffold.ctx.on('api-session/visible', async ({ candidates }, next) => {
    const hold = first && operation.getStore() === true && candidates.some(candidate => candidate.sessionId === id)
    if (hold) first = false
    const result = await next()
    if (hold) { ready.resolve(undefined); await release.promise }
    return result
  })
  const original = scaffold.ctx.sessionController.create.bind(scaffold.ctx.sessionController)
  const spy = vi.spyOn(scaffold.ctx.sessionController, 'create')
    .mockImplementationOnce(request => operation.run(true, () => original(request)))
  onTestFinished(() => { release.resolve(undefined); stop(); spy.mockRestore() })
  const pending = create()
  await ready.promise
  await signOut(page)
  await signIn(page, chen)
  release.resolve(undefined)
  expect(await pending).toMatchObject({ result: { ok: false, error: { code: 'session/not-found' } } })
  expect(scaffold.ctx.agents.get(id)).toBeUndefined()
  expect(await events()).toEqual(before)
  expect(adapter.calls).toBe(1)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

async function scopedUpload(scaffold: Awaited<ReturnType<typeof launchWebScaffold>>, id: SessionId,
  transport: 'binary' | 'encoded', bytes: Uint8Array): Promise<unknown> {
  const response = transport === 'binary'
    ? await scaffold.hostFetch('/api/session/uploadFileBinary?' + new URLSearchParams({ sessionId: id, name: 'private.txt' }).toString(),
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([Uint8Array.from(bytes).buffer]) })
    : await scaffold.hostFetch('/api/fileUploads/upload', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'fileUploads/upload',
        payload: { args: { agentId: id, request: { data: Buffer.from(bytes).toString('base64'), name: 'private.txt' } } } }) })
  expect(response.ok).toBe(true)
  const result: unknown = await response.json()
  return transport === 'binary' ? result : z.object({ result: z.unknown() }).parse(result).result
}

async function confirmedUpload(scaffold: Awaited<ReturnType<typeof launchWebScaffold>>, result: unknown, bytes: Uint8Array) {
  const value = z.object({ ok: z.literal(true), value: z.object({
    receiptId: z.uuid().transform(value => value as FileUploadValue['receiptId']),
    file: z.object({ attachmentId: z.string().transform(value => value as FileAttachmentRef['attachmentId']),
      name: z.string(), bytes: z.number().int().nonnegative() }),
  }) }).parse(result).value
  const chunks: Buffer[] = []
  for await (const chunk of scaffold.ctx.attachments.readFileStream(value.file)) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes))
  return value
}

it.each([false, true].flatMap(cold => (['binary', 'encoded'] as const).map(transport => ({ cold, transport }))))(
  'scoped office upload refuses another employee before storage ($transport, cold=$cold)', async ({ cold, transport }) => {
    const { scaffold, page, console, id, adapter, events, before } = await adoptionFixture(cold)
    await signOut(page)
    await signIn(page, chen)
    const streamed = vi.spyOn(scaffold.ctx.attachments, 'saveFileStream')
    const encoded = vi.spyOn(scaffold.ctx.attachments, 'admitEncodedFile')
    onTestFinished(() => { streamed.mockRestore(); encoded.mockRestore() })
    const beforeAgent = scaffold.ctx.agents.get(id)
    const bytes = Buffer.from('FOREIGN_UPLOAD_BYTES\n真实字节')
    expect(await scopedUpload(scaffold, id, transport, bytes)).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
    expect(streamed).not.toHaveBeenCalled()
    expect(encoded).not.toHaveBeenCalled()
    expect(scaffold.ctx.agents.get(id)).toBe(beforeAgent)
    expect(await events()).toEqual(before)
    expect(adapter.calls).toBe(1)
    await signOut(page)
    await signIn(page, lin)
    const value = await confirmedUpload(scaffold, await scopedUpload(scaffold, id, transport, bytes), bytes)
    const agent = scaffold.ctx.agents.get(id)
    if (!agent) throw new Error('Expected the authorized receiving Agent')
    expect(scaffold.ctx.fileUploads.resolve(agent, value.receiptId)).toEqual(value.file)
    expect((await events()).slice(0, before.length)).toEqual(before)
    expect(adapter.calls).toBe(1)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  },
)

it.each(['binary', 'encoded'] as const)('scoped office upload withholds a saved %s file after an employee replacement', async (transport) => {
  const { scaffold, page, console, id, adapter, events, before } = await adoptionFixture(false)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const hold = async (file: FileAttachmentRef) => { entered.resolve(undefined); await release.promise; return file }
  const raw = scaffold.ctx.attachments.saveFileStream.bind(scaffold.ctx.attachments)
  const encoded = scaffold.ctx.attachments.admitEncodedFile.bind(scaffold.ctx.attachments)
  const rawSpy = transport === 'binary' ? vi.spyOn(scaffold.ctx.attachments, 'saveFileStream')
    .mockImplementationOnce(async request => hold(await raw(request))) : undefined
  const encodedSpy = transport === 'encoded' ? vi.spyOn(scaffold.ctx.attachments, 'admitEncodedFile')
    .mockImplementationOnce(async request => hold(await encoded(request))) : undefined
  onTestFinished(() => { release.resolve(undefined); rawSpy?.mockRestore(); encodedSpy?.mockRestore() })
  const bytes = Buffer.from('ALREADY_SAVED_BUT_NOT_PUBLISHED\n')
  const pending = scopedUpload(scaffold, id, transport, bytes)
  await entered.promise
  await signOut(page)
  await signIn(page, chen)
  release.resolve(undefined)
  expect(await pending).toMatchObject({ ok: false, error: { code: 'session/not-found' } })
  expect(await events()).toEqual(before)
  expect(adapter.calls).toBe(1)
  await signOut(page)
  await signIn(page, lin)
  await confirmedUpload(scaffold, await scopedUpload(scaffold, id, transport, bytes), bytes)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

class CancelHistoryAdapter extends HistoryAdapter {
  readonly ready = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (!signal) throw new Error('The held Native call needs its real cancellation signal')
    this.calls++
    const aborted = Promise.withResolvers<undefined>()
    const stop = () => { aborted.resolve(undefined) }
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    this.ready.resolve(undefined)
    try {
      await Promise.race([this.release.promise, aborted.promise])
      signal.throwIfAborted()
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { signal.removeEventListener('abort', stop) }
  }
}

it.each([false, true])('checks cancellation of a held Native model call after account changes (owned=%s)', async (owned) => {
  const { server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const adapter = new CancelHistoryAdapter()
  onTestFinished(() => { adapter.release.resolve(undefined) })
  const provider = 'office-cancel-history-test'
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter), 'office.cancelHistoryFixture')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  const id = SessionId(`cancel-history-${randomUUID()}`)
  const conversationId = String(id) as OfficeConversationId
  const selection = await server.ctx.office.saveConversationFiles(lin,
    { conversationId, revision: 0, requestId: randomUUID(), files: [] })
  const capture = await server.ctx.office.captureConversationFiles(lin,
    { conversationId, revision: selection.revision, requestId: randomUUID() })
  const handle = await scaffold.ctx.agents.create({ sessionId: id, meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider, model: 'history' }, setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) })
  onTestFinished(() => handle.dispose())
  const cancel = vi.spyOn(handle.agent, 'cancel')
  handle.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Keep this model call pending' }], source: owned
    ? { kind: 'user', preparedContexts: [{ text: 'Reviewed company context.',
      source: { kind: 'office-files', form: 'snapshot', sections: [], capture } }] }
    : { kind: 'user' } }), 'next-turn', true)
  await adapter.ready.promise
  const queued = createUserMessage({ content: [{ type: 'text', text: 'Retain this parked follow-up' }], source: { kind: 'user' } })
  handle.agent.send(queued, 'next-turn', false)
  const checks: { phase: string; response: unknown }[] = []
  const stop = async (phase: string, denied: boolean): Promise<void> => {
    const calls = cancel.mock.calls.length
    const settled = !denied && handle.agent.status === 'running' ? scaffold.whenTurnSettled() : undefined
    const response = await scaffold.hostFetch('/api/session/cancel', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(),
        method: 'session/cancel', payload: { args: { request: { sessionId: id } } } }) })
    expect(response.ok).toBe(true)
    const result: unknown = await response.json()
    checks.push({ phase, response: result })
    expect(result).toMatchObject(denied ? { result: { ok: false, error: { code: 'session/not-found' } } }
      : { result: { ok: true, value: { accepted: true } } })
    expect(cancel.mock.calls.length - calls).toBe(denied ? 0 : 1)
    if (settled) expect(await settled).toBe(id)
    if (denied) expect(handle.agent.status).toBe('running')
    expect(handle.agent.inbox.nextTurn.map(message => message.id)).toContain(queued.id)
    expect(adapter.calls).toBe(1)
  }
  if (owned) {
    const requestScope = new AsyncLocalStorage<boolean>()
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const send = globalThis.fetch
    let hold = true
    const heldFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const wait = hold && requestScope.getStore() === true
        && url.origin === new URL(server.address).origin && url.pathname.endsWith('/v1/session')
      if (wait) hold = false
      const response = await send(input, init)
      if (wait) { ready.resolve(undefined); await release.promise }
      return response
    })
    const remoteCancel = scaffold.ctx.sessionController.cancel.bind(scaffold.ctx.sessionController)
    const heldCancel = vi.spyOn(scaffold.ctx.sessionController, 'cancel').mockImplementationOnce(request =>
      requestScope.run(true, () => remoteCancel(request)))
    onTestFinished(() => { release.resolve(undefined); heldCancel.mockRestore(); heldFetch.mockRestore(); requestScope.disable() })
    const pending = stop('identity-read-before-replacement', true)
    await Promise.race([ready.promise, pending.then(() => { throw new Error('Cancellation settled before its held identity response') })])
    await signOut(page)
    await signIn(page, chen)
    release.resolve(undefined)
    await pending
    heldCancel.mockRestore()
    heldFetch.mockRestore()
    requestScope.disable()
  } else {
    await signOut(page)
    await signIn(page, chen)
  }
  await stop('replacement', owned)
  await signOut(page)
  await stop('signed-out', owned)
  await signIn(page, lin)
  await stop('owner', false)
  using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
  expect(observation.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['aborted'])
  await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
  await writeFile(join(REPO_ROOT, `.artifacts/enterprise-office/round109-cancel-${owned}-${randomUUID()}.json`),
    JSON.stringify({ owned, checks }, null, 2))
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each([false, true].flatMap(owned => [false, true].map(cold => ({ owned, cold }))))(
  'checks office history readers after a real account switch (owned=$owned, cold=$cold)', async ({ owned, cold }) => {
    const { server, overlay } = await setup(6000, true)
    await server.ctx.office.setIdentityPassword(admin, lin, password)
    await server.ctx.office.setIdentityPassword(admin, chen, password)
    const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
    onTestFinished(() => scaffold.close())
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const page = await newEnglishPage(browser, 900)
    const console = watchConsole(page)
    const summaryFrames: string[] = []
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        const frame = typeof payload === 'string' ? payload : payload.toString('utf8')
        if (frame.includes('"api-session/added"')) summaryFrames.push(frame)
      })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await signIn(page, lin)
    const provider = 'office-history-test'
    const adapter = new HistoryAdapter()
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
    const id = SessionId(`office-history-${randomUUID()}`)
    const conversationId = String(id) as OfficeConversationId
    const summaryReady = Promise.withResolvers<undefined>()
    const summaryRelease = Promise.withResolvers<undefined>()
    let holdSummary = !cold
    const stopSummary = scaffold.ctx.on('api-remotes/emit', (payload, next) => {
      const summary = payload.args[0]
      if (holdSummary && payload.event === 'api-session/added' && summary !== null && typeof summary === 'object'
        && !Array.isArray(summary) && summary.sessionId === id) {
        holdSummary = false
        return (async () => {
          const admitted = await next()
          summaryReady.resolve(undefined)
          await summaryRelease.promise
          return admitted
        })()
      }
      return next()
    })
    onTestFinished(() => { summaryRelease.resolve(undefined); stopSummary() })
    const handle = await scaffold.ctx.agents.create({ sessionId: id, meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider, model: 'history' }, setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) })
    onTestFinished(() => handle.dispose())
    if (!cold) await summaryReady.promise
    const marker = owned ? 'LIN_OFFICE_HISTORY_PRIVATE' : 'UNASSOCIATED_NATIVE_HISTORY_CONTROL'
    const selection = await server.ctx.office.saveConversationFiles(lin,
      { conversationId, revision: 0, requestId: randomUUID(), files: [] })
    const capture = await server.ctx.office.captureConversationFiles(lin,
      { conversationId, revision: selection.revision, requestId: randomUUID() })
    const png = await readFile(join(REPO_ROOT, 'snapshots/session/read-image/workspace/red.png'))
    const [image] = await scaffold.ctx.attachments.saveImages([{ data: png, mediaType: 'image/png' }])
    if (!image) throw new Error('The real Native image was not admitted')
    const objectPath = scaffold.ctx.attachments.imageHostPath(image)
    if (!objectPath) throw new Error('The local image provider did not expose its owned object path')
    const imageBefore = await readFile(objectPath)
    const originalRequestId = randomUUID() as SessionRequestId
    const settled = scaffold.whenTurnSettled()
    handle.agent.send(createUserMessage({ content: [{ type: 'text', text: marker }, { type: 'image', attachment: image }], source: owned
      ? { kind: 'user', rpcId: originalRequestId, preparedContexts: [{ text: 'Reviewed company context.',
        source: { kind: 'office-files', form: 'snapshot', sections: [], capture } }] }
      : { kind: 'user', rpcId: originalRequestId } }), 'next-turn', true)
    expect(await settled).toBe(id)
    const throughSeq = handle.agent.session.seq - 1
    const request = { address: { kind: 'session' as const, sessionId: id }, throughSeq }
    const unary = async (endpoint: string, input: object): Promise<unknown> => {
      const response = await scaffold.hostFetch(`/api/session/${endpoint}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(),
          method: `session/${endpoint}`, payload: { args: { [endpoint === 'list' ? '_request' : 'request']: input } } }) })
      expect(response.ok).toBe(true)
      const value: unknown = await response.json()
      return value
    }
    const initial = await unary('page', request)
    expect(initial).toMatchObject({ result: { ok: true } })
    expect(JSON.stringify(initial)).toContain(marker)
    expect(await unary('attachment', { sessionId: id, attachmentId: image.attachmentId }))
      .toMatchObject({ result: { ok: true, value: { attachment: image, data: imageBefore.toString('base64') } } })
    expect(await unary('selectModel', { sessionId: id, provider, model: 'history-alternate' }))
      .toMatchObject({ result: { ok: true, value: { selected: { provider, model: 'history-alternate' } } } })
    expect(await unary('rename', { sessionId: id, title: 'Owner reviewed title' })).toMatchObject({ result: { ok: true } })
    const ownList = await unary('list', {})
    const ownSearch = await unary('search', { query: marker })
    expect(ownList).toMatchObject({ result: { ok: true } })
    expect(ownSearch).toMatchObject({ result: { ok: true } })
    expect(JSON.stringify(ownList)).toContain(id)
    expect(JSON.stringify(ownSearch)).toContain(marker)
    const liveSignal = new AbortController()
    const liveFollow = cold ? undefined
      : scaffold.ctx.sessionController.follow({ address: request.address }, liveSignal.signal)[Symbol.asyncIterator]()
    onTestFinished(async () => { liveSignal.abort(); await liveFollow?.return?.() })
    if (liveFollow) {
      const opening = await liveFollow.next()
      expect(opening.done).toBe(false)
      expect(JSON.stringify(opening.value)).toContain(marker)
    }
    const controlSignal = new AbortController()
    const control = cold ? undefined : scaffold.ctx.sessionController.control(controlSignal.signal)[Symbol.asyncIterator]()
    const sentinel = cold ? undefined : scaffold.ctx.sessions.create(SessionId(`native-control-${randomUUID()}`),
      { meta: { cwd: scaffold.workspaceCwd } })
    onTestFinished(async () => { controlSignal.abort(); await control?.return?.() })
    if (control) {
      const opening = await control.next()
      expect(opening.done).toBe(false)
      expect(JSON.stringify(opening.value)).toContain(id)
    }
    if (cold) {
      await handle.dispose()
      expect(scaffold.ctx.agents.get(id)).toBeUndefined()
    }
    const readReady = Promise.withResolvers<undefined>()
    const readRelease = Promise.withResolvers<undefined>()
    let hold = true
    const stopHolding = scaffold.ctx.on('api-session/page', async ({ request: reading }, next) => {
      const result = await next()
      if (hold && reading.address.kind === 'session' && reading.address.sessionId === id) {
        hold = false
        readReady.resolve(undefined)
        await readRelease.promise
      }
      return result
    })
    onTestFinished(() => { readRelease.resolve(undefined); stopHolding() })
    const pendingPage = unary('page', request)
    await readReady.promise
    stopHolding()
    const listReady = Promise.withResolvers<undefined>()
    const listRelease = Promise.withResolvers<undefined>()
    let holdList = true
    const stopList = scaffold.ctx.on('api-session/visible', async ({ candidates }, next) => {
      const result = await next()
      if (holdList && candidates.some(candidate => candidate.sessionId === id)) {
        holdList = false
        listReady.resolve(undefined)
        await listRelease.promise
      }
      return result
    })
    onTestFinished(() => { listRelease.resolve(undefined); stopList() })
    const pendingList = unary('list', {})
    await listReady.promise
    stopList()
    const searchReady = Promise.withResolvers<undefined>()
    const searchRelease = Promise.withResolvers<undefined>()
    const searchSessions = scaffold.ctx.sessionQuery.searchSessions.bind(scaffold.ctx.sessionQuery)
    let holdSearch = true
    const searchBarrier = vi.spyOn(scaffold.ctx.sessionQuery, 'searchSessions').mockImplementation(async (query, options) => {
      const result = await searchSessions(query, options)
      if (holdSearch && query.query === marker) {
        holdSearch = false
        searchReady.resolve(undefined)
        await searchRelease.promise
      }
      return result
    })
    onTestFinished(() => { searchRelease.resolve(undefined); searchBarrier.mockRestore() })
    const pendingSearch = unary('search', { query: marker })
    await searchReady.promise
    await signOut(page)
    const signedOut = await unary('page', request)
    const signedOutList = await unary('list', {})
    const signedOutSearch = await unary('search', { query: marker })
    await signIn(page, chen)
    let bufferedSummaryFrames: string[] = []
    if (!cold) {
      summaryFrames.length = 0
      summaryRelease.resolve(undefined)
      const barrier = scaffold.ctx.sessions.create(SessionId(`buffered-summary-${randomUUID()}`),
        { meta: { cwd: scaffold.workspaceCwd } })
      await expect.poll(() => summaryFrames.some(frame => frame.includes(barrier.id))).toBe(true)
      bufferedSummaryFrames = [...summaryFrames]
    }
    readRelease.resolve(undefined)
    listRelease.resolve(undefined)
    searchRelease.resolve(undefined)
    const latePage = await pendingPage
    const lateList = await pendingList
    const lateSearch = await pendingSearch
    searchBarrier.mockRestore()
    const history = await unary('page', request)
    const projections = await unary('projections', { sessionId: id })
    const list = await unary('list', {})
    const search = await unary('search', { query: marker })
    let controlOpening: SessionControlFrame | undefined
    const controlFrames: SessionControlFrame[] = []
    if (control) {
      const freshSignal = new AbortController()
      const fresh = scaffold.ctx.sessionController.control(freshSignal.signal)[Symbol.asyncIterator]()
      try {
        const opening = await fresh.next()
        if (opening.done) throw new Error('Expected a Native control baseline')
        controlOpening = opening.value
      } finally { freshSignal.abort(); await fresh.return?.() }
    }
    const signal = new AbortController()
    const stream = scaffold.ctx.sessionController.follow({ address: request.address }, signal.signal)[Symbol.asyncIterator]()
    let followed: unknown
    try {
      const opening = await stream.next()
      if (opening.done) throw new Error('Expected a Native history opening frame')
      followed = { result: { ok: true, value: opening.value } }
    }
    catch (error: unknown) {
      if (error === null || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') throw error
      followed = { result: { ok: false, error: { code: error.code } } }
    } finally { signal.abort(); await stream.return?.() }
    if (liveFollow) {
      const title = owned ? 'LIN_PRIVATE_LATE_HISTORY_FRAME' : 'NATIVE_LATE_HISTORY_CONTROL'
      handle.agent.session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
      if (owned) await expect(liveFollow.next()).rejects.toMatchObject({ code: 'session/not-found' })
      else {
        const frame = await liveFollow.next()
        expect(frame.done).toBe(false)
        expect(JSON.stringify(frame.value)).toContain(title)
      }
      liveSignal.abort()
      await liveFollow.return?.()
    }
    const imageChecks: { phase: string; response: unknown }[] = []
    const imageReadLog = async (): Promise<string> => {
      using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
      return JSON.stringify(observation.events)
    }
    const checkImage = async (phase: string): Promise<void> => {
      if (cold) expect(scaffold.ctx.agents.get(id)).toBeUndefined()
      const before = await imageReadLog()
      const response = await unary('attachment', { sessionId: id, attachmentId: image.attachmentId })
      imageChecks.push({ phase, response })
      expect(response).toMatchObject(owned ? { result: { ok: false, error: { code: 'session/not-found' } } }
        : { result: { ok: true, value: { attachment: image, data: imageBefore.toString('base64') } } })
      if (owned) expect(JSON.stringify(response)).not.toContain(imageBefore.toString('base64'))
      if (cold) expect(scaffold.ctx.agents.get(id)).toBeUndefined()
      expect(await imageReadLog()).toBe(before)
    }
    await checkImage('replacement')
    await signOut(page)
    await checkImage('signed-out')
    await signIn(page, lin)
    const imageReady = Promise.withResolvers<undefined>()
    const imageRelease = Promise.withResolvers<undefined>()
    let holdImage = true
    const readImage = scaffold.ctx.attachments.readImage.bind(scaffold.ctx.attachments)
    const heldImage = vi.spyOn(scaffold.ctx.attachments, 'readImage').mockImplementation(async (...args) => {
      const stored = await readImage(...args)
      if (holdImage && args[0].attachmentId === image.attachmentId) {
        holdImage = false
        imageReady.resolve(undefined)
        await imageRelease.promise
      }
      return stored
    })
    onTestFinished(() => { imageRelease.resolve(undefined); heldImage.mockRestore() })
    const beforePendingImage = await imageReadLog()
    const pendingImage = unary('attachment', { sessionId: id, attachmentId: image.attachmentId })
    await imageReady.promise
    await signOut(page)
    await signIn(page, chen)
    imageRelease.resolve(undefined)
    const lateImage = await pendingImage
    heldImage.mockRestore()
    imageChecks.push({ phase: 'read-before-replacement', response: lateImage })
    expect(lateImage).toMatchObject(owned ? { result: { ok: false, error: { code: 'session/not-found' } } }
      : { result: { ok: true, value: { attachment: image, data: imageBefore.toString('base64') } } })
    if (owned) expect(JSON.stringify(lateImage)).not.toContain(imageBefore.toString('base64'))
    if (cold) expect(scaffold.ctx.agents.get(id)).toBeUndefined()
    expect(await imageReadLog()).toBe(beforePendingImage)
    expect(await readFile(objectPath)).toEqual(imageBefore)
    const queueChecks: { phase: string; kind: string; response: unknown }[] = []
    if (!cold) {
      const queued = createUserMessage({ content: [{ type: 'text', text: 'Initial private queue input' }], source: { kind: 'user' } })
      handle.agent.send(queued, 'next-turn', false)
      await signOut(page)
      await signIn(page, lin)
      expect(await unary('updateQueue', { sessionId: id, itemId: queued.id,
        action: { kind: 'edit', content: [{ type: 'text', text: 'Owner reviewed queue input' }] } }))
        .toMatchObject({ result: { ok: true, value: { accepted: true } } })
      expect(handle.agent.inbox.nextTurn.find(entry => entry.id === queued.id)?.content)
        .toEqual([{ type: 'text', text: 'Owner reviewed queue input' }])
      await signOut(page)
      await signIn(page, chen)
      for (const phase of ['replacement', 'signed-out']) {
        if (phase === 'signed-out') await signOut(page)
        const item = phase === 'replacement' ? queued
          : createUserMessage({ content: [{ type: 'text', text: 'Second private queue input' }], source: { kind: 'user' } })
        if (phase === 'signed-out') handle.agent.send(item, 'next-turn', false)
        for (const kind of ['edit', 'steer', 'remove'] as const) {
          const before = await imageReadLog()
          const pending = [...handle.agent.inbox.nextTurn]
          const response = await unary('updateQueue', { sessionId: id, itemId: item.id,
            action: kind === 'edit' ? { kind, content: [{ type: 'text', text: 'Replacement queue content' }] } : { kind } })
          queueChecks.push({ phase, kind, response })
          expect(response).toMatchObject(owned ? { result: { ok: false, error: { code: 'session/not-found' } } }
            : kind === 'steer' ? { result: { ok: false, error: { code: 'session/steer-unavailable' } } }
              : { result: { ok: true, value: { accepted: true } } })
          if (owned) {
            expect(handle.agent.inbox.nextTurn).toEqual(pending)
            expect(await imageReadLog()).toBe(before)
          } else if (kind === 'edit') {
            expect(handle.agent.inbox.nextTurn.find(entry => entry.id === item.id)?.content)
              .toEqual([{ type: 'text', text: 'Replacement queue content' }])
          } else if (kind === 'remove') expect(handle.agent.inbox.nextTurn.some(entry => entry.id === item.id)).toBe(false)
        }
      }
      await signIn(page, chen)
    } else {
      for (const phase of ['replacement', 'signed-out']) {
        if (phase === 'signed-out') await signOut(page)
        for (const kind of ['edit', 'remove', 'steer'] as const) {
          if (owned) expect(scaffold.ctx.agents.get(id)).toBeUndefined()
          const before = await imageReadLog()
          const response = await unary('updateQueue', { sessionId: id, itemId: randomUUID(),
            action: kind === 'edit' ? { kind, content: [{ type: 'text', text: 'Unknown pending content' }] } : { kind } })
          queueChecks.push({ phase, kind, response })
          expect(response).toMatchObject({ result: { ok: false, error: { code: owned ? 'session/not-found' : 'session/queue-item-not-found' } } })
          if (owned) {
            expect(scaffold.ctx.agents.get(id)).toBeUndefined()
            expect(await imageReadLog()).toBe(before)
          }
        }
      }
      await signIn(page, chen)
    }
    const modelChecks: { phase: string; response: unknown }[] = []
    const defaultSaves = vi.spyOn(scaffold.ctx.agentDefaultModel, 'saveSelection')
    onTestFinished(() => { defaultSaves.mockRestore() })
    const checkModel = async (phase: string): Promise<void> => {
      if (cold && owned) expect(scaffold.ctx.agents.get(id)).toBeUndefined()
      const before = await imageReadLog()
      const saves = defaultSaves.mock.calls.length
      const response = await unary('selectModel', { sessionId: id, provider, model: 'history' })
      modelChecks.push({ phase, response })
      expect(response).toMatchObject(owned ? { result: { ok: false, error: { code: 'session/not-found' } } }
        : { result: { ok: true, value: { selected: { provider, model: 'history' } } } })
      if (owned) expect(await imageReadLog()).toBe(before)
      else {
        using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
        expect(observation.events.findLast(event => event.type === 'model/selection')?.data).toMatchObject({ provider, model: 'history' })
      }
      expect(defaultSaves.mock.calls.length).toBe(saves + (owned ? 0 : 1))
      if (cold && owned) expect(scaffold.ctx.agents.get(id)).toBeUndefined()
    }
    await checkModel('replacement')
    await signOut(page)
    await checkModel('signed-out')
    if (!cold) {
      await signIn(page, lin)
      const configured = Promise.withResolvers<undefined>()
      const releaseModel = Promise.withResolvers<undefined>()
      const configure = scaffold.ctx.llm.resolveCallConfig.bind(scaffold.ctx.llm)
      const heldModel = vi.spyOn(scaffold.ctx.llm, 'resolveCallConfig').mockImplementationOnce(async (...args) => {
        const value = await configure(...args)
        configured.resolve(undefined)
        await releaseModel.promise
        return value
      })
      onTestFinished(() => { releaseModel.resolve(undefined); heldModel.mockRestore() })
      const before = await imageReadLog()
      const saves = defaultSaves.mock.calls.length
      const pendingModel = unary('selectModel', { sessionId: id, provider, model: 'history-alternate' })
      await configured.promise
      await signOut(page)
      await signIn(page, chen)
      releaseModel.resolve(undefined)
      const response = await pendingModel
      heldModel.mockRestore()
      modelChecks.push({ phase: 'configured-before-replacement', response })
      expect(response).toMatchObject(owned ? { result: { ok: false, error: { code: 'session/not-found' } } }
        : { result: { ok: true, value: { selected: { provider, model: 'history-alternate' } } } })
      if (owned) expect(await imageReadLog()).toBe(before)
      expect(defaultSaves.mock.calls.length).toBe(saves + (owned ? 0 : 1))
    } else await signIn(page, chen)
    defaultSaves.mockRestore()
    const renameChecks: { phase: string; response: unknown; beforeSeq: number; afterSeq: number }[] = []
    const checkRename = async (phase: string): Promise<void> => {
      if (cold && owned) expect(scaffold.ctx.agents.get(id)).toBeUndefined()
      const readState = async () => {
        using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
        const titles = observation.events.filter(event => event.type === 'session/title')
        return { seq: observation.events.at(-1)?.seq ?? -1, titles: titles.length, title: titles.at(-1)?.data.title }
      }
      const before = await readState()
      const response = await unary('rename', { sessionId: id, title: `Changed title ${phase}` })
      const after = await readState()
      renameChecks.push({ phase, response, beforeSeq: before.seq, afterSeq: after.seq })
      expect(response).toMatchObject(owned ? { result: { ok: false, error: { code: 'session/not-found' } } }
        : { result: { ok: true } })
      if (owned) expect(after).toEqual(before)
      else {
        // A cold Native resume appends its own lifecycle event before the single requested title event.
        expect(after.titles).toBe(before.titles + 1)
        expect(after.title).toBe(`Changed title ${phase}`)
      }
      if (cold && owned) expect(scaffold.ctx.agents.get(id)).toBeUndefined()
    }
    await checkRename('replacement')
    await signOut(page)
    await checkRename('signed-out')
    await signIn(page, lin)
    const renameReady = Promise.withResolvers<undefined>()
    const renameRelease = Promise.withResolvers<undefined>()
    let holdRename = true
    let stopRename = () => {}
    const rename = scaffold.ctx.sessionController.rename.bind(scaffold.ctx.sessionController)
    const heldRename = vi.spyOn(scaffold.ctx.sessionController, 'rename').mockImplementationOnce(async (input) => {
      // Install inside this command's entry, so unrelated catalog/control reads cannot take its barrier.
      stopRename = scaffold.ctx.on('api-session/visible', async ({ candidates }, next) => {
        const wait = holdRename && candidates.length === 1 && candidates[0]?.sessionId === id
        if (wait) holdRename = false
        const result = await next()
        if (wait) { renameReady.resolve(undefined); await renameRelease.promise }
        return result
      })
      return rename(input)
    })
    onTestFinished(() => { renameRelease.resolve(undefined); stopRename(); heldRename.mockRestore() })
    const pendingRename = unary('rename', { sessionId: id, title: 'Title prepared before account replacement' })
    await renameReady.promise
    await signOut(page)
    await signIn(page, chen)
    renameRelease.resolve(undefined)
    expect(await pendingRename).toMatchObject(owned ? { result: { ok: false, error: { code: 'session/not-found' } } }
      : { result: { ok: true } })
    stopRename()
    heldRename.mockRestore()
    {
      using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
      expect(observation.events.some(event => event.type === 'session/title'
        && event.data.title === 'Title prepared before account replacement')).toBe(!owned)
    }
    await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
    const forkChecks: { phase: string; response: unknown }[] = []
    const created = vi.spyOn(scaffold.ctx.agents, 'create')
    const resumed = vi.spyOn(scaffold.ctx.agents, 'resume')
    onTestFinished(() => { created.mockRestore(); resumed.mockRestore() })
    onTestFailed(async () => {
      await writeFile(join(REPO_ROOT, `.artifacts/enterprise-office/round107-fork-failure-${owned}-${cold}.json`),
        JSON.stringify({ checks: forkChecks, sourceActive: Boolean(scaffold.ctx.agents.get(id)),
          resumed: resumed.mock.calls.map(([options]) => options.resumeSessionId) }, null, 2))
    })
    const recordFork = async (phase: string, response: unknown, denied: boolean, before: number): Promise<void> => {
      forkChecks.push({ phase, response })
      expect(response).toMatchObject(denied ? { result: { ok: false, error: { code: 'session/not-found' } } }
        : { result: { ok: true } })
      expect(created.mock.calls.length - before).toBe(denied ? 0 : 1)
      if (!denied) {
        const result = response as { result: { ok: true; value: { sessionId: SessionId } } }
        using child = await scaffold.ctx.sessionQuery.observeSession(result.result.value.sessionId,
          { projectionMode: 'none', stateKeys: ['officeRunOwnership'] })
        expect(child.header.parentSession).toBe(id)
        expect(child.header.isSeeded).toBe(true)
        expect(JSON.stringify(child.events)).toContain(marker)
        expect(child.states?.officeRunOwnership?.owner).toEqual(owned ? { memberId: lin, role: 'employee' } : null)
      }
      if (cold && owned) expect({ phase, sourceActive: Boolean(scaffold.ctx.agents.get(id)) })
        .toEqual({ phase, sourceActive: false })
    }
    const checkFork = async (phase: string): Promise<void> => {
      const before = created.mock.calls.length
      const response = await unary('fork', { sessionId: id, atSeq: throughSeq, allowMigration: false })
      await recordFork(phase, response, owned, before)
    }
    const sourceEvents = async () => {
      using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
      return JSON.stringify(observation.events)
    }
    const beforeForks = await sourceEvents()
    await checkFork('replacement')
    await signOut(page)
    await checkFork('signed-out')
    await signIn(page, lin)
    const beforeAllowed = created.mock.calls.length
    await recordFork('owner', await unary('fork', { sessionId: id, atSeq: throughSeq }), false, beforeAllowed)
    const forkReady = Promise.withResolvers<undefined>()
    const forkRelease = Promise.withResolvers<undefined>()
    const observe = scaffold.ctx.sessionQuery.observeSession.bind(scaffold.ctx.sessionQuery)
    let holdFork = true
    const heldFork = vi.spyOn(scaffold.ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => {
      const result = await observe(...args)
      // The fork's source read uses the full observation; office policies request projectionMode none.
      if (holdFork && args[0] === id && args[1] === undefined) {
        holdFork = false
        forkReady.resolve(undefined)
        await forkRelease.promise
      }
      return result
    })
    onTestFinished(() => { forkRelease.resolve(undefined); heldFork.mockRestore() })
    const beforeHeld = created.mock.calls.length
    const pendingFork = unary('fork', { sessionId: id, atSeq: throughSeq })
    await forkReady.promise
    await signOut(page)
    await signIn(page, chen)
    forkRelease.resolve(undefined)
    await recordFork('observed-before-replacement', await pendingFork, owned, beforeHeld)
    heldFork.mockRestore()
    expect(await sourceEvents()).toBe(beforeForks)
    await writeFile(join(REPO_ROOT, `.artifacts/enterprise-office/round107-forks-${owned}-${cold}-${randomUUID()}.json`),
      JSON.stringify({ owned, cold, checks: forkChecks }, null, 2))
    created.mockRestore()
    const promptChecks: { phase: string; response: unknown; recorded: boolean; callsBefore: number; callsAfter: number }[] = []
    const recordPrompt = async (phase: string, response: unknown, text: string, callsBefore: number): Promise<void> => {
      using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
      promptChecks.push({ phase, response, recorded: JSON.stringify(observation.events).includes(text),
        callsBefore, callsAfter: adapter.calls })
    }
    const checkNewPrompt = async (phase: string): Promise<void> => {
      if (cold && owned) expect(Boolean(scaffold.ctx.agents.get(id))).toBe(false)
      const text = `NEW_PROMPT_${phase}`
      const callsBefore = adapter.calls
      const settled = owned ? undefined : scaffold.whenTurnSettled()
      const response = await unary('prompt', { sessionId: id, requestId: randomUUID(), mode: 'queue',
        content: [{ type: 'text', text }] })
      if (settled) expect(await settled).toBe(id)
      await recordPrompt(phase, response, text, callsBefore)
      if (cold && owned) expect(Boolean(scaffold.ctx.agents.get(id))).toBe(false)
    }
    const priorPromptChecks: { phase: string; response: unknown }[] = []
    const checkPriorPrompt = async (phase: string): Promise<void> => {
      const denied = owned && phase !== 'owner'
      const before = await sourceEvents()
      const inputs = async () => {
        using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
        return JSON.stringify(observation.events.filter(event =>
          event.type === 'user/message' || event.type === 'agent/inbox/spliced'))
      }
      const beforeInputs = await inputs()
      const calls = adapter.calls
      if (cold && denied) expect(Boolean(scaffold.ctx.agents.get(id))).toBe(false)
      const response = await unary('prompt', { sessionId: id, requestId: originalRequestId, mode: 'queue',
        content: [{ type: 'text', text: `RETRIED_PRIVATE_PROMPT_${phase}` }] })
      priorPromptChecks.push({ phase, response })
      expect(response).toMatchObject(denied ? { result: { ok: false, error: { code: 'session/not-found' } } }
        : { result: { ok: true, value: { accepted: true } } })
      expect(adapter.calls).toBe(calls)
      expect(await inputs()).toBe(beforeInputs)
      if (denied) expect(await sourceEvents()).toBe(before)
      if (cold && denied) expect(Boolean(scaffold.ctx.agents.get(id))).toBe(false)
    }
    const checkPromptAdmission = async (): Promise<void> => {
      await checkNewPrompt('replacement')
      await checkPriorPrompt('replacement')
      await signOut(page)
      await checkNewPrompt('signed-out')
      await checkPriorPrompt('signed-out')
      await signIn(page, lin)
      await checkPriorPrompt('owner')
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const requestId = randomUUID()
      const text = 'NEW_PROMPT_PREPARED_BEFORE_ACCOUNT_REPLACEMENT'
      const remove = scaffold.ctx.on('api-session/prepare-context', async (payload, next) => {
        const result = await next()
        if (payload.sessionId === id && payload.requestId === requestId) {
          entered.resolve(undefined)
          await release.promise
        }
        return result
      })
      onTestFinished(() => { release.resolve(undefined); remove() })
      const pending = unary('prompt', { sessionId: id, requestId, mode: 'queue', content: [{ type: 'text', text }] })
      await entered.promise
      await signOut(page)
      await signIn(page, chen)
      const callsBefore = adapter.calls
      const settled = owned ? undefined : scaffold.whenTurnSettled()
      release.resolve(undefined)
      const response = await pending
      remove()
      if (settled) expect(await settled).toBe(id)
      await recordPrompt('prepared-before-replacement', response, text, callsBefore)
    }
    if (control && sentinel) {
      sentinel.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Native control barrier' }],
        source: { kind: 'user' } }), { surfaceOp: 'append' })
      for (;;) {
        const frame = await control.next()
        if (frame.done) throw new Error('Control ended before the Native barrier')
        controlFrames.push(frame.value)
        if (frame.value.type === 'projection' && frame.value.sessionId === sentinel.id) break
        if (controlFrames.length > 100) throw new Error('Control did not reach the Native barrier')
      }
      controlSignal.abort()
      await control.return?.()
      await checkPromptAdmission()
      summaryFrames.length = 0
      await handle.dispose()
      const summarySentinel = scaffold.ctx.sessions.create(SessionId(`native-summary-${randomUUID()}`),
        { meta: { cwd: scaffold.workspaceCwd } })
      await expect.poll(() => summaryFrames.some(frame => frame.includes(summarySentinel.id))).toBe(true)
    } else await checkPromptAdmission()
    await writeFile(join(REPO_ROOT, `.artifacts/enterprise-office/round94-readers-${owned}-${cold}-${randomUUID()}.json`),
      JSON.stringify({ owned, cold, signedOut, latePage, history, projections, followed,
        signedOutList, signedOutSearch, list, search, lateList, lateSearch, controlOpening, controlFrames,
        summaryFrames, bufferedSummaryFrames, promptChecks, priorPromptChecks, renameChecks,
        imageChecks, modelChecks, queueChecks }, null, 2))
    expect(priorPromptChecks).toHaveLength(3)
    expect(promptChecks).toHaveLength(3)
    for (const promptCheck of promptChecks) {
      expect(promptCheck.response).toMatchObject(owned ? { result: { ok: false, error: { code: 'session/not-found' } } }
        : { result: { ok: true } })
      expect(promptCheck.recorded).toBe(!owned)
      expect(promptCheck.callsAfter).toBe(promptCheck.callsBefore + (owned ? 0 : 1))
    }
    if (!cold) {
      for (const result of [controlOpening, controlFrames]) {
        if (owned) expect(JSON.stringify(result)).not.toContain(id)
        else expect(JSON.stringify(result)).toContain(id)
      }
      if (owned) expect(JSON.stringify(summaryFrames)).not.toContain(id)
      else expect(JSON.stringify(summaryFrames)).toContain(id)
      if (owned) expect(JSON.stringify(bufferedSummaryFrames)).not.toContain(id)
      else expect(JSON.stringify(bufferedSummaryFrames)).toContain(id)
    }
    for (const result of [signedOutList, signedOutSearch, list, search, lateList, lateSearch]) {
      expect(result).toMatchObject({ result: { ok: true } })
      if (owned) {
        expect(JSON.stringify(result)).not.toContain(id)
        expect(JSON.stringify(result)).not.toContain(marker)
      } else expect(JSON.stringify(result)).toContain(id)
    }
    for (const result of [signedOut, latePage, history, projections, followed]) {
      expect(result).toMatchObject(owned ? { result: { ok: false, error: { code: 'session/not-found' } } } : { result: { ok: true } })
      if (owned) expect(JSON.stringify(result)).not.toContain(marker)
    }
    if (!owned) expect(JSON.stringify(history)).toContain(marker)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  },
)

it.each(['normal', 'captured', 'before-native'] as const)('keeps an ordinary home prompt private without associations (%s)', async (mode) => {
  const switchAccount = mode !== 'normal'
  const { server, overlay } = await setup(6000, true)
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const provider = 'office-home-identity-test'
  const adapter = new HistoryAdapter()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'history' })
  const workspace = join(scaffold.workspaceCwd, 'ordinary-office-input')
  await mkdir(workspace, { recursive: true })
  await scaffold.ctx.workspaceController.create({ path: workspace })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900, true)
  const console = watchConsole(page)
  const captured = Promise.withResolvers<OfficeConversationId>()
  const release = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<unknown>()
  if (switchAccount) {
    const capture = scaffold.ctx.officeController.captureConversation.bind(scaffold.ctx.officeController)
    const heldCapture = mode === 'captured' ? vi.spyOn(scaffold.ctx.officeController, 'captureConversation').mockImplementationOnce(async (...args) => {
      const result = await capture(...args)
      if (!result.ok) throw new Error('The initial office identity was not captured')
      captured.resolve(result.value.selection.conversationId)
      await release.promise
      return result
    }) : undefined
    const nativePrompt = scaffold.ctx.sessionController.prompt.bind(scaffold.ctx.sessionController)
    const tracked = vi.spyOn(scaffold.ctx.sessionController, 'prompt').mockImplementationOnce(async (...args) => {
      if (mode === 'before-native') {
        captured.resolve(String(args[0].sessionId) as OfficeConversationId)
        await release.promise
      }
      try {
        const value = await nativePrompt(...args)
        finished.resolve(null)
        return value
      } catch (error: unknown) { finished.resolve(error); throw error }
    })
    onTestFinished(() => { release.resolve(undefined); heldCapture?.mockRestore(); tracked.mockRestore() })
  }
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  const marker = 'LIN_PRIVATE_FIRST_ORDINARY_HOME_PROMPT'
  const prompt = page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true })
  await prompt.fill(marker)
  const settled = switchAccount ? undefined : scaffold.whenTurnSettled()
  await prompt.press('Control+Enter')
  if (switchAccount) {
    const id = SessionId(String(await captured.promise))
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Workbench', exact: true }).click()
    await signOut(page)
    await signIn(page, chen)
    release.resolve(undefined)
    expect(await finished.promise).toMatchObject({ code: 'session/not-found' })
    expect(adapter.calls).toBe(0)
    using observation = await scaffold.ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
    expect(JSON.stringify(observation.events)).not.toContain(marker)
    expect(await page.getByText(marker, { exact: true }).count()).toBe(0)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
    return
  }
  if (!settled) throw new Error('The ordinary home turn was not tracked')
  const id = await settled
  await page.getByText('History turn completed.', { exact: true }).waitFor()
  expect(adapter.calls).toBe(1)
  let throughSeq: number
  let ownership: unknown
  {
    using observation = await scaffold.ctx.sessionQuery.observeSession(id,
      { projectionMode: 'none', stateKeys: ['officeRunOwnership'] })
    expect(JSON.stringify(observation.events)).toContain(marker)
    ownership = observation.states?.officeRunOwnership
    throughSeq = observation.events.at(-1)?.seq ?? -1
  }
  const read = async (): Promise<unknown> => {
    const response = await scaffold.hostFetch('/api/session/page', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/page', payload: { args: { request: {
        address: { kind: 'session', sessionId: id }, throughSeq } } } }) })
    expect(response.ok).toBe(true)
    return response.json()
  }
  const before = await read()
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Workbench', exact: true }).click()
  await signOut(page)
  const signedOut = await read()
  await signIn(page, chen)
  const replaced = await read()
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, `ordinary-home-${randomUUID()}.json`), JSON.stringify({ ownership, before, signedOut, replaced }, null, 2))
  expect(ownership).toMatchObject({ owner: { memberId: lin, role: 'employee' }, mixed: false, invalid: false })
  expect(JSON.stringify(before)).toContain(marker)
  for (const response of [signedOut, replaced]) {
    expect(response).toMatchObject({ result: { ok: false, error: { code: 'session/not-found' } } })
    expect(JSON.stringify(response)).not.toContain(marker)
  }
  expect(await page.getByText(marker, { exact: true }).count()).toBe(0)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('edits a central meeting with reviewed conflicts, recipient notifications and safe previous-reader refusal', async () => {
  const { root, server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const date = '2026-10-15'
  const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  const originalMeeting = await server.ctx.office.createSchedule(lin,
    { title: 'Reviewed meeting', date, startTime: '10:00', endTime: '11:00', inviteeIds: [chen] })
  const sender = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  const recipient = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => sender.close())
  onTestFinished(() => recipient.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const colleague = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  const peerConsole = watchConsole(colleague)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-schedule-edit'))
  const open = async (window: Page) => {
    await window.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Workbench', exact: true }).click()
    const meetingDate = server.ctx.office.getItem(lin, originalMeeting.id).date
    await window.getByRole('button', { name: 'Calendar', exact: true }).click()
    await window.getByLabel('Date', { exact: true }).fill(meetingDate)
    await window.locator(`[data-office-item="${originalMeeting.id}"]`).click()
    return window.getByRole('dialog', { name: 'Work details', exact: true })
  }
  await colleague.goto(recipient.authenticatedUrl, { waitUntil: 'load' })
  await signIn(colleague, chen)
  let detail = await open(colleague)
  expect(await detail.getByRole('button', { name: 'Edit event', exact: true }).count()).toBe(0)
  await detail.getByRole('button', { name: 'Accept invitation', exact: true }).click()
  await expect.poll(() => server.ctx.office.getItem(lin, originalMeeting.id).participants
    .find(participant => participant.memberId === chen)?.reply).toBe('accepted')
  const statePath = join(root, 'data', 'enterprise_office.json')
  const baseline = await readFile(statePath)
  const reviewed = server.ctx.office.getItem(lin, originalMeeting.id)
  const input = { title: reviewed.title, description: reviewed.description, date,
    startTime: '10:00', endTime: '11:00', location: reviewed.location }
  const denied = await recipient.hostFetch('/api/office/updateSchedule', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(),
      method: 'office/updateSchedule', payload: { args: { id: reviewed.id, revision: reviewed.revision, input } } }) })
  expect(await denied.json()).toMatchObject({ result: { ok: true, value: { ok: false, code: 'forbidden' } } })
  expect(await readFile(statePath)).toEqual(baseline)
  await page.goto(sender.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  detail = await open(page)
  await detail.getByRole('button', { name: 'Edit event', exact: true }).click()
  let form = page.getByRole('dialog', { name: 'Edit event', exact: true })
  await form.getByLabel('Title', { exact: true }).fill('Cancelled local edit')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  expect(await readFile(statePath)).toEqual(baseline)
  detail = await open(page)
  await detail.getByRole('button', { name: 'Edit event', exact: true }).click()
  form = page.getByRole('dialog', { name: 'Edit event', exact: true })
  await form.getByLabel('Title', { exact: true }).fill('Preserved draft after conflict')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const controller = sender.ctx.officeController
  const update = controller.updateSchedule.bind(controller)
  const held = vi.spyOn(controller, 'updateSchedule').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return update(...args)
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await entered.promise
  const concurrent = await server.ctx.office.updateSchedule(admin, reviewed.id, reviewed.revision,
    { ...input, location: 'Concurrent server room' })
  release.resolve(undefined)
  await form.getByRole('button', { name: 'Load latest event', exact: true }).waitFor()
  expect(await form.getByLabel('Title', { exact: true }).inputValue()).toBe('Preserved draft after conflict')
  expect(await form.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  expect(server.ctx.office.getItem(lin, reviewed.id)).toEqual(concurrent)
  const conflictAria = await form.ariaSnapshot()
  await writeFile(join(REPO_ROOT, '.artifacts/enterprise-office/schedule-edit-conflict.aria.md'), `${conflictAria}\n`)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: theme === 'light' ? 1440 : 800, height: 720 })
    const bounds = await form.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds?.y).toBeGreaterThanOrEqual(24)
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(696)
    const save = form.getByRole('button', { name: 'Save', exact: true })
    await save.scrollIntoViewIfNeeded()
    const saveBounds = await save.boundingBox()
    expect(saveBounds).not.toBeNull()
    expect(saveBounds?.y).toBeGreaterThanOrEqual(24)
    expect((saveBounds?.y ?? 0) + (saveBounds?.height ?? 0)).toBeLessThanOrEqual(696)
    await form.getByRole('heading', { name: 'Edit event', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(REPO_ROOT, `.artifacts/enterprise-office/schedule-edit-${theme}.png`), animations: 'disabled' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await form.getByRole('button', { name: 'Load latest event', exact: true }).click()
  expect(await form.getByLabel('Location', { exact: true }).inputValue()).toBe('Concurrent server room')
  expect(await form.getByLabel('Title', { exact: true }).inputValue()).toBe(reviewed.title)
  held.mockRestore()
  await form.getByLabel('Title', { exact: true }).fill('Changed meeting')
  await form.getByLabel('Date', { exact: true }).fill(nextDate)
  await form.getByLabel('Start time', { exact: true }).fill('14:00')
  await form.getByLabel('End time', { exact: true }).fill('13:00')
  expect(await form.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  await form.getByLabel('End time', { exact: true }).fill('15:00')
  await form.getByLabel('Location', { exact: true }).fill('Confirmed room')
  await form.getByLabel('Notes', { exact: true }).fill('Confirmed meeting notes')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  const changed = server.ctx.office.getItem(lin, reviewed.id)
  expect(changed).toMatchObject({ id: reviewed.id, creatorId: lin, ownerId: lin, date: nextDate, time: '14:00', endTime: '15:00',
    title: 'Changed meeting', location: 'Confirmed room', description: 'Confirmed meeting notes', revision: concurrent.revision + 1 })
  expect(changed.participants).toEqual([{ memberId: lin, reply: 'accepted' }, { memberId: chen, reply: 'pending' }])
  const warningStart = peerConsole.warnings.length
  await colleague.reload({ waitUntil: 'load' })
  await colleague.getByRole('navigation', { name: 'Workbench', exact: true }).waitFor()
  acknowledgeReloadConnectionLoss(peerConsole, warningStart)
  detail = await open(colleague)
  await detail.getByRole('heading', { name: 'Changed meeting', exact: true }).waitFor()
  expect(await detail.getByRole('button', { name: 'Edit event', exact: true }).count()).toBe(0)
  expect(await detail.getByRole('button', { name: 'Accept invitation', exact: true }).isEnabled()).toBe(true)
  const notices = server.ctx.office.view(chen).notifications.filter(entry => entry.kind === 'schedule_updated')
  expect(notices).toHaveLength(2)
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await colleague.getByRole('button', { name: 'Notifications', exact: true }).click()
  const inbox = colleague.getByRole('dialog', { name: 'Notifications', exact: true })
  await expect.poll(() => inbox.getByRole('button').filter({ hasText: 'Updated event details' }).count()).toBe(2)
  const runId = randomUUID()
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office')
  await mkdir(artifacts, { recursive: true })
  const before = join(artifacts, `schedule-${runId}-before.json`)
  const after = join(artifacts, `schedule-${runId}-after.json`)
  await writeFile(before, baseline)
  await writeFile(after, await readFile(statePath))
  const comparison = await new Promise<string>((resolveResult, reject) => {
    execFile(process.execPath, ['--experimental-import-meta-resolve',
      join(REPO_ROOT, 'apps/web/tests/fixtures/office-schedule-reader-compat.mjs'), before, after],
    { cwd: REPO_ROOT, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 }, (error, output, errors) => {
      if (error) reject(new Error(`Office reader comparison failed: ${errors}\n${output}`, { cause: error }))
      else resolveResult(output)
    })
  })
  const report: unknown = JSON.parse(comparison)
  expect(report).toMatchObject({ ok: true })
  await writeFile(join(artifacts, `schedule-${runId}-reader-comparison.json`), comparison)
  detail = await open(page)
  await detail.getByLabel('Status', { exact: true }).selectOption('cancelled')
  await expect.poll(() => server.ctx.office.getItem(lin, reviewed.id).status).toBe('cancelled')
  await expect.poll(() => detail.getByRole('button', { name: 'Edit event', exact: true }).isDisabled()).toBe(true)
  const final = server.ctx.office.getItem(lin, reviewed.id)
  const port = Number(new URL(server.address).port)
  await server.ctx.fiber.dispose()
  const restarted = await central(root, port)
  expect(restarted.ctx.office.getItem(lin, reviewed.id)).toEqual(final)
  const recovered = await recipient.hostFetch('/api/office/view', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'office/view', payload: { args: { date: nextDate } } }) })
  expect(await recovered.json()).toMatchObject({ result: { ok: true, value: { ok: true, value: { me: { id: chen },
    items: [expect.objectContaining({ id: reviewed.id, title: 'Changed meeting', status: 'cancelled' })] } } } })
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-schedule-edit/conflict.expected.md'), conflictAria, webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  expect(peerConsole.pageErrors).toEqual([])
  expect(peerConsole.warnings).toEqual([])
})

it.each(['keyboard and members', 'work and files'] as const)('resolves global search %s through generated Remote APIs', async (scope) => {
  const { server, overlay } = await setup()
  for (const id of [lin, chen]) await server.ctx.office.setIdentityPassword(admin, id, password)
  const date = '2026-10-15'
  const folder = await server.ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: 'Needle folder' })
  const bytes = Buffer.from('Search reads metadata without reading these bytes', 'utf8')
  const privateFile = await server.ctx.office.uploadDriveFile(lin, { space: 'private', folderId: folder.id,
    name: 'Needle private Lin.txt', requestId: randomUUID(), mediaType: 'text/plain', byteLength: bytes.length,
    dataBase64: bytes.toString('base64') })
  await server.ctx.office.uploadDriveFile(chen, { space: 'private', folderId: null,
    name: 'Needle private Chen.txt', requestId: randomUUID(), mediaType: 'text/plain', byteLength: bytes.length,
    dataBase64: bytes.toString('base64') })
  const sharedFile = await server.ctx.office.uploadDriveFile(admin, { space: 'shared', folderId: null,
    name: 'Needle shared.txt', requestId: randomUUID(), mediaType: 'text/plain', byteLength: bytes.length,
    dataBase64: bytes.toString('base64') })
  const parent = await server.ctx.office.createWork(lin, { kind: 'task', title: 'Needle task', date, ownerId: chen })
  await server.ctx.office.changeWorkLifecycle(lin, parent.id, parent.revision, { kind: 'archive', reason: 'Search retained work' })
  await server.ctx.office.createWork(admin, { kind: 'todo', title: 'Needle hidden task', date, ownerId: admin })
  const revision = server.ctx.office.view(lin).revision
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  const byteReads: string[] = []
  page.on('request', (request) => {
    if (/\/api\/office\/(downloadDriveFile|downloadDriveRange|driveFileInfo)$/.test(new URL(request.url()).pathname))
      byteReads.push(new URL(request.url()).pathname)
  })
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-global-search'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  const dialog = () => page.getByRole('dialog', { name: 'Global search', exact: true })
  const query = () => dialog().getByRole('combobox', { name: 'Search members, work, files, skills or pages', exact: true })
  const open = async () => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    await dialog().waitFor()
    await expect.poll(() => query().evaluate(element => document.activeElement === element)).toBe(true)
  }
  if (scope === 'keyboard and members') {
    await page.getByRole('button', { name: 'Global search', exact: true }).focus()
    await open()
    await query().press('Escape')
    await dialog().waitFor({ state: 'hidden' })
    await expect.poll(() => page.getByRole('button', { name: 'Global search', exact: true })
      .evaluate(element => document.activeElement === element)).toBe(true)
    await open()
    await query().fill('Contacts')
    await dialog().getByRole('option', { name: 'Pages · Contacts', exact: true }).waitFor()
    await expect.poll(() => dialog().getByRole('option', { name: 'Pages · Contacts', exact: true }).isEnabled()).toBe(true)
    await query().dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false })
    expect(await dialog().count()).toBe(1)
    await query().press('ArrowDown')
    await query().press('ArrowUp')
    await query().press('Enter')
    await dialog().waitFor({ state: 'hidden' })
    await page.getByRole('heading', { name: 'Contacts', exact: true }).waitFor()
    await open()
    await query().fill('Chen')
    await dialog().getByRole('option', { name: /Members · Chen/ }).click()
    const member = page.getByRole('dialog', { name: 'Member details', exact: true })
    await member.waitFor()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    expect(await dialog().count()).toBe(0)
    await member.getByRole('button', { name: 'Close', exact: true }).click()
    expect(byteReads).toEqual([])
    expect(server.ctx.office.view(lin).revision).toBe(revision)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
    return
  }
  await open()
  await query().fill('Needle')
  await dialog().getByRole('option', { name: /Needle private Lin.txt/ }).waitFor()
  expect(await dialog().getByRole('option', { name: /Needle private Chen.txt/ }).count()).toBe(0)
  expect(await dialog().getByRole('option', { name: /Needle hidden task/ }).count()).toBe(0)
  await dialog().getByRole('option', { name: /Work items · Needle task/ }).click()
  const details = page.getByRole('dialog', { name: 'Work details', exact: true })
  await details.getByRole('status').filter({ hasText: 'Archive' }).waitFor()
  await details.getByRole('button', { name: 'Close', exact: true }).click()
  await open()
  await query().fill(privateFile.name)
  await dialog().getByRole('option', { name: /Needle private Lin.txt/ }).click()
  await dialog().waitFor({ state: 'hidden' })
  const row = page.locator(`[data-drive-entry="${privateFile.id}"]`)
  await expect.poll(() => row.getAttribute('aria-selected')).toBe('true')
  await open()
  await query().fill(sharedFile.name)
  const shared = dialog().getByRole('option', { name: /Needle shared.txt/ })
  await shared.waitFor()
  await server.ctx.office.saveDrivePermissions(admin,
    { id: sharedFile.id, revision: sharedFile.revision, defaultAccess: 'deny', grants: [] })
  await shared.click()
  await dialog().getByRole('alert').filter({ hasText: 'This result is no longer available' }).waitFor()
  expect(await shared.count()).toBe(0)
  expect(byteReads).toEqual([])
  expect(server.ctx.office.view(lin).revision).toBe(revision)
  await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
  await page.screenshot({ path: join(REPO_ROOT, '.artifacts/enterprise-office/global-search.png'), animations: 'disabled' })
  expect(await scaffold.ctx.officeController.signOut()).toMatchObject({ ok: true })
  await page.getByRole('region', { name: 'Sign in to your company', exact: true }).waitFor()
  expect(await dialog().count()).toBe(0)
  await signIn(page, chen)
  await open()
  await query().fill('Needle private')
  await dialog().getByRole('option', { name: /Needle private Chen.txt/ }).waitFor()
  expect(await dialog().getByRole('option', { name: /Needle private Lin.txt/ }).count()).toBe(0)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['task', 'todo'] as const)('confirms %s archive, recycle-bin deletion and restoration across employee views', async (kind) => {
  const { root, server, overlay } = await setup()
  for (const id of [lin, chen]) await server.ctx.office.setIdentityPassword(admin, id, password)
  const date = '2026-10-15'
  const parent = await server.ctx.office.createWork(lin, { kind, title: `Lifecycle ${kind}`, date, ownerId: chen })
  const statePath = join(root, 'data/enterprise_office.json')
  const baseline = await readFile(statePath)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const peer = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => peer.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const peerPage = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  const peerConsole = watchConsole(peerPage)
  onTestFailed(() => saveFailureShot(page, `enterprise-office-work-lifecycle-${kind}`))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  await peerPage.goto(peer.authenticatedUrl, { waitUntil: 'load' })
  await signIn(peerPage, chen)
  const bucket = async (target: Page, name: 'Active work' | 'Archive' | 'Recycle bin') => {
    await target.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Work', exact: true }).click()
    await target.getByRole('button', { name: 'All accessible work', exact: true }).click()
    await target.getByRole('button', { name, exact: true }).click()
  }
  const row = (target: Page) => target.locator(`[data-office-item="${parent.id}"]`)
  const detail = () => page.getByRole('dialog', { name: 'Work details', exact: true })
  await bucket(page, 'Active work')
  await bucket(peerPage, 'Active work')
  await row(peerPage).waitFor()
  await row(page).click()
  await detail().getByRole('button', { name: 'Archive work item', exact: true }).click()
  let confirmation = detail().getByRole('form', { name: 'Archive work item', exact: true })
  await confirmation.getByLabel('Action explanation', { exact: true }).fill('Cancelled archive')
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(statePath)).toEqual(baseline)
  await detail().getByRole('button', { name: 'Archive work item', exact: true }).click()
  confirmation = detail().getByRole('form', { name: 'Archive work item', exact: true })
  await confirmation.getByLabel('Action explanation', { exact: true }).fill('Retained confirmation draft')
  const domain = server.ctx.storageDomain.get('enterprise_office')!
  const failed = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected browser lifecycle write failure'))
  onTestFinished(() => { failed.mockRestore() })
  const denied = page.waitForResponse('**/api/office/changeWorkLifecycle')
  await confirmation.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await denied
  await expect.poll(() => confirmation.getByRole('button', { name: 'Confirm action', exact: true }).isEnabled()).toBe(true)
  expect(await confirmation.getByLabel('Action explanation', { exact: true }).inputValue()).toBe('Retained confirmation draft')
  expect(await readFile(statePath)).toEqual(baseline)
  failed.mockRestore()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const controller = scaffold.ctx.officeController
  const original = controller.changeWorkLifecycle.bind(controller)
  const held = vi.spyOn(controller, 'changeWorkLifecycle').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return original(...args)
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  await confirmation.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await entered.promise
  const concurrent = await server.ctx.office.updateWork(lin, parent.id, parent.revision, { title: `Concurrent ${kind}`, date })
  release.resolve(undefined)
  await confirmation.getByRole('button', { name: 'Load latest work item', exact: true }).waitFor()
  expect(await confirmation.getByLabel('Action explanation', { exact: true }).inputValue()).toBe('Retained confirmation draft')
  expect(server.ctx.office.getItem(chen, parent.id)).toEqual(concurrent)
  await confirmation.getByRole('button', { name: 'Load latest work item', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await detail().waitFor({ state: 'hidden' })
  held.mockRestore()
  await row(peerPage).waitFor({ state: 'detached', timeout: 15_000 })
  await bucket(peerPage, 'Archive')
  await row(peerPage).click()
  const peerDetail = peerPage.getByRole('dialog', { name: 'Work details', exact: true })
  expect(await peerDetail.getByRole('button', { name: 'Restore work item', exact: true }).count()).toBe(0)
  expect(await peerDetail.getByLabel('Status', { exact: true }).isDisabled()).toBe(true)
  await peerDetail.getByRole('button', { name: 'Close', exact: true }).click()
  await bucket(page, 'Archive')
  await row(page).click()
  await detail().getByText('Retained confirmation draft', { exact: true }).waitFor()
  await detail().getByRole('button', { name: 'Delete work item', exact: true }).click()
  confirmation = detail().getByRole('form', { name: 'Delete work item', exact: true })
  await confirmation.getByLabel('Action explanation', { exact: true }).fill('Confirmed recycle-bin deletion')
  await confirmation.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await detail().waitFor({ state: 'hidden' })
  await bucket(page, 'Recycle bin')
  await row(page).click()
  await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
  await page.screenshot({ path: join(REPO_ROOT, `.artifacts/enterprise-office/work-lifecycle-${kind}.png`), animations: 'disabled' })
  await detail().getByRole('button', { name: 'Restore work item', exact: true }).click()
  confirmation = detail().getByRole('form', { name: 'Restore work item', exact: true })
  await confirmation.getByLabel('Action explanation', { exact: true }).fill('Restore the same work')
  await confirmation.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await detail().waitFor({ state: 'hidden' })
  await bucket(page, 'Active work')
  await row(page).waitFor()
  const restored = server.ctx.office.getItem(lin, parent.id)
  expect(restored).toMatchObject({ id: parent.id, kind, title: concurrent.title, ownerId: chen, status: parent.status })
  expect(restored.lifecycleActions?.map(entry => entry.kind)).toEqual(['archive', 'delete', 'restore'])
  expect(server.ctx.office.view(chen, date).day.items).toEqual([restored])
  if (kind === 'task') await compareTaskDeliveryReader(baseline, await readFile(statePath), 'lifecycle')
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  expect(peerConsole.pageErrors).toEqual([])
  expect(peerConsole.warnings).toEqual([])
})

it('manages reviewed work attachments with cancellation, conflicts, private access and verified download', async () => {
  const { root, server, overlay } = await setup()
  for (const id of [lin, chen]) await server.ctx.office.setIdentityPassword(admin, id, password)
  const date = '2026-10-15'
  const bytes = Buffer.from('Actual attachment\0bytes\n办公资料', 'utf8')
  const privateFile = await server.ctx.office.uploadDriveFile(lin, { space: 'private', folderId: null,
    requestId: randomUUID(), name: 'Private task material.bin', mediaType: 'application/octet-stream',
    byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const sharedFile = await server.ctx.office.uploadDriveFile(admin, { space: 'shared', folderId: null,
    requestId: randomUUID(), name: 'Shared task material.bin', mediaType: 'application/octet-stream',
    byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const parent = await server.ctx.office.createWork(lin, { kind: 'task', title: 'Review task materials', date, ownerId: chen })
  const statePath = join(root, 'data/enterprise_office.json')
  const baseline = await readFile(statePath)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-work-attachments'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  const edit = async () => {
    const detail = await openCalendarItem(page, parent.id, date)
    await detail.getByRole('button', { name: 'Manage work attachments', exact: true }).click()
    return page.getByRole('dialog', { name: 'Manage work attachments', exact: true })
  }
  let form = await edit()
  await form.getByRole('button', { name: `Choose file ${privateFile.name}`, exact: true }).click()
  await form.getByRole('group', { name: 'Linked materials · 1/20', exact: true }).waitFor()
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(statePath)).toEqual(baseline)
  form = await edit()
  await form.getByRole('button', { name: `Choose file ${privateFile.name}`, exact: true }).click()
  await form.getByRole('group', { name: 'Linked materials · 1/20', exact: true }).waitFor()
  await server.ctx.office.updateWork(lin, parent.id, parent.revision, { title: 'Concurrent material review', date })
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.getByRole('button', { name: 'Load latest work item', exact: true }).waitFor()
  await form.getByRole('button', { name: 'Remove reference 1', exact: true }).waitFor()
  await form.getByRole('button', { name: 'Load latest work item', exact: true }).click()
  await form.getByRole('group', { name: 'Linked materials · 0/20', exact: true }).waitFor()
  await form.getByRole('button', { name: `Choose file ${privateFile.name}`, exact: true }).click()
  await form.getByRole('button', { name: 'Shared drive', exact: true }).click()
  await form.getByRole('button', { name: `Choose file ${sharedFile.name}`, exact: true }).click()
  await form.getByRole('group', { name: 'Linked materials · 2/20', exact: true }).waitFor()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  const linked = server.ctx.office.getItem(lin, parent.id)
  expect(linked.attachments?.map(file => file.id)).toEqual([privateFile.id, sharedFile.id])
  await compareTaskDeliveryReader(baseline, await readFile(statePath), 'attachments')
  await signOut(page)
  await signIn(page, chen)
  let detail = await openCalendarItem(page, parent.id, date)
  const materials = detail.getByRole('region', { name: 'Linked materials', exact: true })
  await materials.getByText('Attachment unavailable. Check Drive access and file version, then reselect it.', { exact: true }).waitFor()
  expect(await materials.getByText(privateFile.name, { exact: false }).count()).toBe(0)
  const download = page.waitForEvent('download')
  await materials.getByRole('button', { name: 'Download file', exact: true }).click()
  const saved = await download
  expect(saved.suggestedFilename()).toBe(sharedFile.name)
  expect(await readFile(await saved.path())).toEqual(bytes)
  await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
  await page.screenshot({ path: join(REPO_ROOT, '.artifacts/enterprise-office/work-attachments.png'), animations: 'disabled' })
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  form = await edit()
  await form.getByRole('button', { name: 'Remove reference 1', exact: true }).click()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  expect(server.ctx.office.getItem(chen, parent.id).attachments?.map(file => file.id)).toEqual([sharedFile.id])
  detail = await openCalendarItem(page, parent.id, date)
  await detail.getByRole('region', { name: 'Linked materials', exact: true }).getByRole('button', { name: 'Download file', exact: true }).waitFor()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['task', 'todo'] as const)('maintains a reviewed %s subtask list with cancel, conflicts, owner editing and readable notifications', async (kind) => {
  const { root, server, overlay } = await setup()
  for (const id of [lin, chen]) await server.ctx.office.setIdentityPassword(admin, id, password)
  const date = '2026-10-15'
  const parent = await server.ctx.office.createWork(lin, { kind, title: `Checklist ${kind}`, date, time: '16:00', ownerId: chen })
  const statePath = join(root, 'data/enterprise_office.json')
  const baseline = await readFile(statePath)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, `enterprise-office-subtasks-${kind}`))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  const details = () => openCalendarItem(page, parent.id, date)
  const edit = async () => {
    await (await details()).getByRole('button', { name: 'Manage subtasks', exact: true }).click()
    return page.getByRole('dialog', { name: 'Manage subtasks', exact: true })
  }
  let form = await edit()
  const row = (index: number) => form.getByRole('group', { name: `Subtask ${index}`, exact: true })
  await form.getByRole('button', { name: 'Add subtask', exact: true }).click()
  await row(1).getByLabel('Title', { exact: true }).fill('Cancelled checklist entry')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(statePath)).toEqual(baseline)
  form = await edit()
  await form.getByRole('button', { name: 'Add subtask', exact: true }).click()
  await row(1).getByLabel('Title', { exact: true }).fill('Collect figures')
  await row(1).getByRole('checkbox', { name: 'Completed', exact: true }).check()
  await form.getByRole('button', { name: 'Add subtask', exact: true }).click()
  await row(2).getByLabel('Title', { exact: true }).fill('Draft report')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  const added = server.ctx.office.getItem(lin, parent.id)
  expect(added.subtasks).toHaveLength(2)
  expect(added).toMatchObject({ id: parent.id, ownerId: chen, status: parent.status, date, time: '16:00' })
  await signOut(page)
  await signIn(page, chen)
  const detail = await details()
  await detail.getByRole('region', { name: 'Subtasks', exact: true }).getByText('Collect figures · Completed', { exact: true }).waitFor()
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  form = await edit()
  await row(1).getByLabel('Title', { exact: true }).fill('Preserved local subtask')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const controller = scaffold.ctx.officeController
  const original = controller.updateWorkSubtasks.bind(controller)
  const held = vi.spyOn(controller, 'updateWorkSubtasks').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return original(...args)
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await entered.promise
  const concurrent = await server.ctx.office.updateWorkSubtasks(admin, parent.id, added.revision,
    { subtasks: added.subtasks!.map(entry => ({ ...entry, title: entry.title === 'Draft report' ? 'Concurrent report' : entry.title })) })
  release.resolve(undefined)
  await form.getByRole('button', { name: 'Load latest work item', exact: true }).waitFor()
  expect(await row(1).getByLabel('Title', { exact: true }).inputValue()).toBe('Preserved local subtask')
  expect(await form.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  expect(server.ctx.office.getItem(chen, parent.id)).toEqual(concurrent)
  await form.getByRole('button', { name: 'Load latest work item', exact: true }).click()
  expect(await row(2).getByLabel('Title', { exact: true }).inputValue()).toBe('Concurrent report')
  held.mockRestore()
  await form.getByRole('button', { name: 'Remove subtask 2', exact: true }).click()
  await row(1).getByLabel('Title', { exact: true }).fill('Verified figures')
  await row(1).getByRole('checkbox', { name: 'Completed', exact: true }).uncheck()
  await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
  await page.screenshot({ path: join(REPO_ROOT, `.artifacts/enterprise-office/subtasks-${kind}.png`), animations: 'disabled' })
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  const final = server.ctx.office.getItem(chen, parent.id)
  expect(final.subtasks).toEqual([{ id: added.subtasks![0]!.id, title: 'Verified figures', completed: false }])
  const beforeSignOut = await readFile(statePath)
  form = await edit()
  await row(1).getByLabel('Title', { exact: true }).fill('Discarded identity draft')
  expect(await controller.signOut()).toMatchObject({ ok: true })
  await page.getByRole('region', { name: 'Sign in to your company', exact: true }).waitFor()
  await signIn(page, lin)
  expect(await page.getByRole('dialog', { name: 'Manage subtasks', exact: true }).count()).toBe(0)
  expect(await readFile(statePath)).toEqual(beforeSignOut)
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  const inbox = page.getByRole('dialog', { name: 'Notifications', exact: true })
  await inbox.getByRole('button').filter({ hasText: 'Updated the subtask list' }).first().waitFor()
  await inbox.getByRole('button', { name: 'Close', exact: true }).click()
  if (kind === 'task') {
    const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office')
    const runId = randomUUID()
    const before = join(artifacts, `subtasks-${runId}-before.json`)
    const after = join(artifacts, `subtasks-${runId}-after.json`)
    await writeFile(before, baseline)
    await writeFile(after, await readFile(statePath))
    const comparison = await new Promise<string>((resolveResult, reject) => {
      execFile(process.execPath, ['--experimental-import-meta-resolve',
        join(REPO_ROOT, 'apps/web/tests/fixtures/office-schedule-reader-compat.mjs'), before, after, 'subtasks'],
      { cwd: REPO_ROOT, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 }, (error, output, errors) => {
        if (error) reject(new Error(`Office subtask reader comparison failed: ${errors}\n${output}`, { cause: error }))
        else resolveResult(output)
      })
    })
    expect(JSON.parse(comparison)).toMatchObject({ ok: true })
    await writeFile(join(artifacts, `subtasks-${runId}-reader-comparison.json`), comparison)
  }
  const closed = await server.ctx.office.setStatus(lin, parent.id, final.revision, 'completed')
  expect(closed.subtasks).toEqual(final.subtasks)
  const closedDetail = await details()
  expect(await closedDetail.getByRole('button', { name: 'Manage subtasks', exact: true }).isDisabled()).toBe(true)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('submits a central task delivery while retaining cancelled and stale submission drafts', async () => {
  const { root, server, overlay } = await setup()
  for (const id of [lin, chen]) await server.ctx.office.setIdentityPassword(admin, id, password)
  const date = '2026-10-15'
  const parent = await server.ctx.office.createWork(lin,
    { kind: 'task', title: 'Reviewed delivery report', date, time: '16:00', ownerId: chen })
  const statePath = join(root, 'data/enterprise_office.json')
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-task-delivery'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, chen)
  const open = () => openCalendarItem(page, parent.id, date)
  const detail = await open()
  await detail.getByRole('button', { name: 'Accept task', exact: true }).click()
  await expect.poll(() => server.ctx.office.getItem(chen, parent.id).status).toBe('in_progress')
  const acceptedWork = server.ctx.office.getItem(chen, parent.id)
  const beforeCancel = await readFile(statePath)
  const delivery = () => detail.getByRole('region', { name: 'Delivery and review', exact: true })
  await delivery().getByRole('button', { name: 'Submit delivery', exact: true }).click()
  let form = delivery().getByRole('form', { name: 'Submit delivery', exact: true })
  await form.getByLabel('Explanation or reason', { exact: true }).fill('Cancelled explanation')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(statePath)).toEqual(beforeCancel)
  await delivery().getByRole('button', { name: 'Submit delivery', exact: true }).click()
  form = delivery().getByRole('form', { name: 'Submit delivery', exact: true })
  await form.getByLabel('Explanation or reason', { exact: true }).fill('First draft ready for review')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const controller = scaffold.ctx.officeController
  const original = controller.reviewTaskDelivery.bind(controller)
  const held = vi.spyOn(controller, 'reviewTaskDelivery').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return original(...args)
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await entered.promise
  await server.ctx.office.updateWork(admin, parent.id, acceptedWork.revision,
    { title: 'Concurrent reviewed report', date, time: '16:00' })
  release.resolve(undefined)
  await form.getByRole('button', { name: 'Load latest work item', exact: true }).waitFor()
  expect(await form.getByLabel('Explanation or reason', { exact: true }).inputValue()).toBe('First draft ready for review')
  expect(await form.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  await form.getByRole('button', { name: 'Load latest work item', exact: true }).click()
  held.mockRestore()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await delivery().getByText('Awaiting review by the creator or an administrator', { exact: true }).waitFor()
  const completion = detail.getByLabel('Status', { exact: true }).locator('option[value="completed"]')
  await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
  await writeFile(join(REPO_ROOT, '.artifacts/enterprise-office/delivery-completion-state.json'), JSON.stringify({
    option: await completion.evaluate(element => ({ disabled: (element as HTMLOptionElement).disabled,
      html: element.outerHTML, select: element.parentElement?.outerHTML })),
    item: server.ctx.office.getItem(chen, parent.id),
  }, null, 2))
  expect(await completion.evaluate(element => (element as HTMLOptionElement).disabled)).toBe(true)
  expect(server.ctx.office.getItem(chen, parent.id).deliveries?.at(-1)?.reason).toBe('First draft ready for review')
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('reviews an already submitted delivery through return, resubmission and confirmation in the browser', async () => {
  const { root, server, overlay } = await setup()
  for (const id of [lin, chen]) await server.ctx.office.setIdentityPassword(admin, id, password)
  const date = '2026-10-15'
  const parent = await server.ctx.office.createWork(lin,
    { kind: 'task', title: 'Submitted delivery review', date, ownerId: chen })
  const statePath = join(root, 'data/enterprise_office.json')
  const baseline = await readFile(statePath)
  const running = await server.ctx.office.decideTask(chen, parent.id, parent.revision, { kind: 'accept' })
  await server.ctx.office.reviewTaskDelivery(chen, parent.id, running.revision,
    { kind: 'submit', reason: 'First draft ready for review' })
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  await reviewSubmittedTaskInBrowser(page, parent.id, date)
  const final = server.ctx.office.getItem(lin, parent.id)
  expect(final.status).toBe('completed')
  expect(final.deliveries?.map(entry => entry.reason)).toEqual(['First draft ready for review', 'Add the missing totals',
    'Totals checked and corrected', 'Totals reviewed and approved'])
  await compareTaskDeliveryReader(baseline, await readFile(statePath))
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('checks opt-in member availability without private titles and discards obsolete or signed-out results', async () => {
  const { root, server, overlay } = await setup(6000, false, true)
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const date = '2026-10-15'
  const privateMeeting = await server.ctx.office.createSchedule(chen,
    { title: 'Confidential finance appointment', date, startTime: '10:00', endTime: '11:00', inviteeIds: [] })
  expect(() => server.ctx.office.getItem(lin, privateMeeting.id)).toThrow()
  const statePath = join(root, 'data/enterprise_office.json')
  const before = await readFile(statePath)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-availability'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  await page.getByRole('button', { name: 'Calendar', exact: true }).click()
  await page.getByLabel('Date', { exact: true }).fill(date)
  await page.getByRole('button', { name: 'New event', exact: true }).first().click()
  let form = page.getByRole('dialog', { name: 'New event', exact: true })
  await form.getByLabel('Date', { exact: true }).fill(date)
  await form.getByLabel('Start time', { exact: true }).fill('10:15')
  await form.getByLabel('End time', { exact: true }).fill('10:45')
  await form.getByRole('checkbox', { name: /^Chen/ }).check()
  let availability = form.getByRole('region', { name: 'Member availability', exact: true })
  const check = () => availability.getByRole('button', { name: 'Check member availability', exact: true }).click()
  await check()
  await availability.getByText('Chen · Busy', { exact: true }).waitFor()
  expect(await availability.getByText('Lin · No internal meeting', { exact: true }).count()).toBe(1)
  expect(await page.getByText(privateMeeting.title, { exact: true }).count()).toBe(0)
  const controller = scaffold.ctx.officeController
  const original = controller.scheduleAvailability.bind(controller)
  const denied = vi.spyOn(controller, 'scheduleAvailability').mockResolvedValueOnce({ ok: false, code: 'forbidden' })
  await check()
  await availability.getByText('Could not check availability. Try again.', { exact: true }).waitFor()
  expect(await availability.getByText('Chen · Busy', { exact: true }).count()).toBe(0)
  denied.mockRestore()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const held = vi.spyOn(controller, 'scheduleAvailability').mockImplementationOnce(async (input) => {
    const result = await original(input)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  await check()
  await entered.promise
  await form.getByLabel('Start time', { exact: true }).fill('11:00')
  await form.getByLabel('End time', { exact: true }).fill('11:45')
  await check()
  await availability.getByText('Chen · No internal meeting', { exact: true }).waitFor()
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/office/scheduleAvailability')
  release.resolve(undefined)
  await lateResponse
  await page.evaluate(() => new Promise<void>((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => { resolveFrame() }))
  }))
  expect(await availability.getByText('Chen · Busy', { exact: true }).count()).toBe(0)
  held.mockRestore()
  await form.getByRole('checkbox', { name: /^Chen/ }).uncheck()
  expect(await availability.getByRole('list').count()).toBe(0)
  await check()
  await availability.getByText('Lin · No internal meeting', { exact: true }).waitFor()
  expect(await availability.getByText(/^Chen/).count()).toBe(0)
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(statePath)).toEqual(before)
  const own = await server.ctx.office.createSchedule(lin,
    { title: 'Availability exclusion review', date, startTime: '10:15', endTime: '10:45', inviteeIds: [chen] })
  await page.locator(`[data-office-item="${own.id}"]`).click()
  await page.getByRole('dialog', { name: 'Work details', exact: true }).getByRole('button', { name: 'Edit event', exact: true }).click()
  form = page.getByRole('dialog', { name: 'Edit event', exact: true })
  availability = form.getByRole('region', { name: 'Member availability', exact: true })
  await check()
  await availability.getByText('Chen · Busy', { exact: true }).waitFor()
  expect(await availability.getByText('Lin · No internal meeting', { exact: true }).count()).toBe(1)
  const identityEntered = Promise.withResolvers<undefined>()
  const identityRelease = Promise.withResolvers<undefined>()
  const identityHeld = vi.spyOn(controller, 'scheduleAvailability').mockImplementationOnce(async (input) => {
    const result = await original(input)
    identityEntered.resolve(undefined)
    await identityRelease.promise
    return result
  })
  onTestFinished(() => { identityRelease.resolve(undefined); identityHeld.mockRestore() })
  await check()
  await identityEntered.promise
  expect(await controller.signOut()).toMatchObject({ ok: true })
  await page.getByRole('region', { name: 'Sign in to your company', exact: true }).waitFor()
  const identityResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/office/scheduleAvailability')
  identityRelease.resolve(undefined)
  await identityResponse
  await signIn(page, chen)
  expect(await page.getByRole('dialog', { name: 'Edit event', exact: true }).count()).toBe(0)
  expect(await page.getByRole('region', { name: 'Member availability', exact: true }).count()).toBe(0)
  expect(server.ctx.office.getItem(lin, own.id)).toEqual(own)
  identityHeld.mockRestore()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('edits central meeting members with reviewed drafts, private removal notices and persistent invitations', async () => {
  const { root, server, overlay } = await setup()
  const ding = 'ding' as OfficeMemberId
  await server.ctx.office.saveMember(admin, { id: ding, name: 'Ding', department: 'Operations', jobTitle: 'Employee',
    role: 'employee', active: true, email: '', phone: '' }, null)
  for (const id of [lin, chen, ding]) await server.ctx.office.setIdentityPassword(admin, id, password)
  const date = '2026-10-15'
  const input = { title: 'Original shared meeting', date, startTime: '10:00', endTime: '11:00', inviteeIds: [chen] }
  const created = await server.ctx.office.createSchedule(lin, input)
  const reviewed = await server.ctx.office.reply(chen, created.id, created.revision, 'accepted')
  const statePath = join(root, 'data/enterprise_office.json')
  const baseline = await readFile(statePath)
  const sender = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  const recipient = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => sender.close())
  onTestFinished(() => recipient.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const colleague = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  const peerConsole = watchConsole(colleague)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-schedule-members'))
  const open = async () => {
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Workbench', exact: true }).click()
    await page.getByRole('button', { name: 'Calendar', exact: true }).click()
    await page.getByLabel('Date', { exact: true }).fill(date)
    await page.locator(`[data-office-item="${created.id}"]`).click()
    await page.getByRole('dialog', { name: 'Work details', exact: true }).getByRole('button', { name: 'Edit event', exact: true }).click()
    return page.getByRole('dialog', { name: 'Edit event', exact: true })
  }
  await page.goto(sender.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  await colleague.goto(recipient.authenticatedUrl, { waitUntil: 'load' })
  await signIn(colleague, chen)
  let form = await open()
  expect(await form.getByRole('checkbox', { name: 'Lin', exact: true }).isDisabled()).toBe(true)
  await form.getByRole('checkbox', { name: 'Chen', exact: true }).uncheck()
  await form.getByRole('checkbox', { name: 'Ding', exact: true }).check()
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(statePath)).toEqual(baseline)
  form = await open()
  expect(await form.getByRole('checkbox', { name: 'Chen', exact: true }).isChecked()).toBe(true)
  expect(await form.getByRole('checkbox', { name: 'Ding', exact: true }).isChecked()).toBe(false)
  await form.getByRole('checkbox', { name: 'Chen', exact: true }).uncheck()
  await form.getByRole('checkbox', { name: 'Ding', exact: true }).check()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const controller = sender.ctx.officeController
  const update = controller.updateSchedule.bind(controller)
  const held = vi.spyOn(controller, 'updateSchedule').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined)
    await release.promise
    return update(...args)
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await entered.promise
  const concurrent = await server.ctx.office.updateSchedule(admin, created.id, reviewed.revision, { ...input, inviteeIds: [chen, admin] })
  release.resolve(undefined)
  await form.getByRole('button', { name: 'Load latest event', exact: true }).waitFor()
  expect(await form.getByRole('checkbox', { name: 'Chen', exact: true }).isChecked()).toBe(false)
  expect(await form.getByRole('checkbox', { name: 'Ding', exact: true }).isChecked()).toBe(true)
  expect(server.ctx.office.getItem(lin, created.id)).toEqual(concurrent)
  await form.getByRole('button', { name: 'Load latest event', exact: true }).click()
  expect(await form.getByRole('checkbox', { name: 'Chen', exact: true }).isChecked()).toBe(true)
  expect(await form.getByRole('checkbox', { name: 'Office administrator', exact: true }).isChecked()).toBe(true)
  expect(await form.getByRole('checkbox', { name: 'Ding', exact: true }).isChecked()).toBe(false)
  held.mockRestore()
  await form.getByRole('checkbox', { name: 'Chen', exact: true }).uncheck()
  await form.getByRole('checkbox', { name: 'Office administrator', exact: true }).uncheck()
  await form.getByRole('checkbox', { name: 'Ding', exact: true }).check()
  await form.getByLabel('Title', { exact: true }).fill('Private replacement meeting')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  const changed = server.ctx.office.getItem(lin, created.id)
  expect(changed.participants).toEqual([{ memberId: lin, reply: 'accepted' }, { memberId: ding, reply: 'pending' }])
  expect(() => server.ctx.office.getItem(chen, created.id)).toThrow()
  const former = server.ctx.office.view(chen)
  expect(JSON.stringify(former)).not.toContain(changed.title)
  const removed = former.notifications.find(notice => notice.kind === 'schedule_removed')!
  expect(removed.itemTitle).toBe(created.title)
  const warningStart = peerConsole.warnings.length
  await colleague.reload({ waitUntil: 'load' })
  await colleague.getByRole('navigation', { name: 'Workbench', exact: true }).waitFor()
  acknowledgeReloadConnectionLoss(peerConsole, warningStart)
  expect(await colleague.locator(`[data-office-item="${created.id}"]`).count()).toBe(0)
  await colleague.getByRole('button', { name: 'Notifications', exact: true }).click()
  let inbox = colleague.getByRole('dialog', { name: 'Notifications', exact: true })
  const removal = inbox.getByRole('button').filter({ hasText: 'Removed you from an event' })
  expect(await removal.innerText()).toContain(created.title)
  expect(await inbox.innerText()).not.toContain(changed.title)
  await removal.click()
  await expect.poll(() => server.ctx.office.view(chen).notifications.find(notice => notice.id === removed.id)?.read).toBe(true)
  expect(await colleague.getByRole('dialog', { name: 'Work details', exact: true }).count()).toBe(0)
  await inbox.getByRole('button', { name: 'Close', exact: true }).click()
  await signOut(colleague)
  await signIn(colleague, ding)
  await colleague.getByRole('button', { name: 'Notifications', exact: true }).click()
  inbox = colleague.getByRole('dialog', { name: 'Notifications', exact: true })
  await inbox.getByRole('button').filter({ hasText: 'Invited you to an event' }).click()
  const detail = colleague.getByRole('dialog', { name: 'Work details', exact: true })
  await detail.getByRole('heading', { name: changed.title, exact: true }).waitFor()
  await detail.getByRole('button', { name: 'Accept invitation', exact: true }).click()
  await expect.poll(() => server.ctx.office.getItem(ding, created.id).participants.find(member => member.memberId === ding)?.reply).toBe('accepted')
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office')
  await mkdir(artifacts, { recursive: true })
  const runId = randomUUID()
  const before = join(artifacts, `schedule-members-${runId}-before.json`)
  const after = join(artifacts, `schedule-members-${runId}-after.json`)
  await writeFile(before, baseline)
  await writeFile(after, await readFile(statePath))
  const comparison = await new Promise<string>((resolveResult, reject) => {
    execFile(process.execPath, ['--experimental-import-meta-resolve',
      join(REPO_ROOT, 'apps/web/tests/fixtures/office-schedule-reader-compat.mjs'), before, after, 'members'],
    { cwd: REPO_ROOT, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 }, (error, output, errors) => {
      if (error) reject(new Error(`Office membership reader comparison failed: ${errors}\n${output}`, { cause: error }))
      else resolveResult(output)
    })
  })
  expect(JSON.parse(comparison)).toMatchObject({ ok: true })
  await writeFile(join(artifacts, `schedule-members-${runId}-reader-comparison.json`), comparison)
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  form = await open()
  await form.getByRole('checkbox', { name: 'Ding', exact: true }).uncheck()
  expect(await controller.signOut()).toMatchObject({ ok: true })
  await page.getByRole('region', { name: 'Sign in to your company', exact: true }).waitFor()
  await signIn(page, chen)
  expect(await page.getByRole('dialog', { name: 'Edit event', exact: true }).count()).toBe(0)
  const final = server.ctx.office.getItem(ding, created.id)
  const port = Number(new URL(server.address).port)
  await server.ctx.fiber.dispose()
  const restarted = await central(root, port)
  expect(restarted.ctx.office.getItem(ding, created.id)).toEqual(final)
  expect(() => restarted.ctx.office.getItem(chen, created.id)).toThrow()
  expect(restarted.ctx.office.view(chen).notifications)
    .toContainEqual(expect.objectContaining({ id: removed.id, itemTitle: created.title, read: true }))
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  expect(peerConsole.pageErrors).toEqual([])
  expect(peerConsole.warnings).toEqual([])
})

it.each(['task', 'todo'] as const)('accepts, reviews and transfers central %s work with private former-owner notices and persistent reasons', async (kind) => {
  const { root, server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const task = await server.ctx.office.createWork(lin, { kind, title: 'Reviewed office task', date: '2026-10-20', ownerId: chen,
    ...(kind === 'todo' ? { time: '11:00' } : {}) })
  const transferLabel = kind === 'task' ? 'Transfer task' : 'Reassign to-do'
  const latestLabel = kind === 'task' ? 'Load latest task' : 'Load latest to-do'
  const historyLabel = kind === 'task' ? 'Task action history' : 'To-do assignment history'
  const path = join(root, 'data', 'enterprise_office.json')
  const baseline = await readFile(path)
  const sender = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  const recipient = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => sender.close())
  onTestFinished(() => recipient.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const colleague = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  const peerConsole = watchConsole(colleague)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-task-decisions'))
  const open = async (window: Page) => {
    await window.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Work', exact: true }).click()
    await window.getByRole('button', { name: 'All accessible work', exact: true }).click()
    await window.locator(`[data-office-item="${task.id}"]`).click()
    return window.getByRole('dialog', { name: 'Work details', exact: true })
  }
  await page.goto(sender.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  let detail = await open(page)
  expect(await detail.getByRole('button', { name: 'Accept task', exact: true }).count()).toBe(0)
  expect(await detail.getByRole('button', { name: 'Reject task', exact: true }).count()).toBe(0)
  const denied = await sender.hostFetch('/api/office/decideTask', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'office/decideTask',
      payload: { args: { id: task.id, revision: task.revision, input: { kind: 'accept' } } } }) })
  expect(await denied.json()).toMatchObject({ result: { ok: true, value: { ok: false, code: kind === 'task' ? 'forbidden' : 'invalid_input' } } })
  expect(await readFile(path)).toEqual(baseline)
  await detail.getByRole('button', { name: transferLabel, exact: true }).click()
  let form = detail.locator('form')
  await form.getByLabel('New assignee', { exact: true }).selectOption(lin)
  await form.getByLabel('Reason', { exact: true }).fill('Preserved transfer reason')
  await colleague.goto(recipient.authenticatedUrl, { waitUntil: 'load' })
  await signIn(colleague, chen)
  const peerDetail = await open(colleague)
  if (kind === 'task') await peerDetail.getByRole('button', { name: 'Accept task', exact: true }).click()
  else {
    expect(await peerDetail.getByRole('button', { name: 'Accept task', exact: true }).count()).toBe(0)
    expect(await peerDetail.getByRole('button', { name: 'Reject task', exact: true }).count()).toBe(0)
    await server.ctx.office.updateWork(chen, task.id, task.revision,
      { title: task.title, date: task.date, time: task.time, description: 'Reviewed to-do handoff' })
  }
  await expect.poll(() => server.ctx.office.getItem(lin, task.id).revision).toBe(task.revision + 1)
  expect(server.ctx.office.getItem(lin, task.id).status).toBe(kind === 'task' ? 'in_progress' : 'pending')
  await form.getByRole('button', { name: latestLabel, exact: true }).waitFor()
  expect(await form.getByLabel('Reason', { exact: true }).inputValue()).toBe('Preserved transfer reason')
  expect(await form.getByLabel('New assignee', { exact: true }).inputValue()).toBe(lin)
  expect(await form.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  const conflictAria = await form.ariaSnapshot()
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, `${kind}-decision-conflict.aria.md`), `${conflictAria}\n`)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: theme === 'light' ? 1440 : 800, height: 720 })
    const bounds = await detail.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds?.y).toBeGreaterThanOrEqual(24)
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(696)
    await form.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, `${kind}-decision-${theme}.png`), animations: 'disabled' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await form.getByRole('button', { name: latestLabel, exact: true }).click()
  expect(await form.getByLabel('Reason', { exact: true }).inputValue()).toBe('')
  expect(await form.getByLabel('New assignee', { exact: true }).inputValue()).toBe('')
  const accepted = server.ctx.office.getItem(lin, task.id)
  const acceptedBytes = await readFile(path)
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(path)).toEqual(acceptedBytes)
  await detail.getByRole('button', { name: transferLabel, exact: true }).click()
  form = detail.locator('form')
  expect(await form.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  await form.getByLabel('New assignee', { exact: true }).selectOption(lin)
  await form.getByLabel('Reason', { exact: true }).fill('Creator will add the missing source documents')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  const moved = server.ctx.office.getItem(lin, task.id)
  expect(moved).toMatchObject({ id: task.id, creatorId: lin, ownerId: lin, status: 'pending', revision: accepted.revision + 1 })
  if (kind === 'task') expect(moved.taskActions?.map(action => action.kind)).toEqual(['accept', 'transfer'])
  else {
    expect(moved.todoAssignments?.map(action => action.kind)).toEqual(['transfer'])
    expect(moved.time).toBe(task.time)
    expect(moved.date).toBe(task.date)
  }
  await peerDetail.waitFor({ state: 'hidden' })
  expect(await colleague.locator(`[data-office-item="${task.id}"]`).count()).toBe(0)
  await colleague.getByRole('button', { name: 'Notifications', exact: true }).click()
  const inbox = colleague.getByRole('dialog', { name: 'Notifications', exact: true })
  const notice = inbox.getByRole('button').filter({ hasText: kind === 'task' ? 'Transferred the task' : 'Reassigned the to-do' })
  await notice.getByText(task.title, { exact: true }).waitFor()
  await notice.click()
  expect(await colleague.getByRole('dialog', { name: 'Work details', exact: true }).count()).toBe(0)
  await inbox.getByRole('button', { name: 'Close', exact: true }).click()
  await detail.getByRole('button', { name: kind === 'task' ? 'Reject task' : transferLabel, exact: true }).click()
  form = detail.locator('form')
  expect(await form.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  if (kind === 'todo') await form.getByLabel('New assignee', { exact: true }).selectOption(chen)
  await form.getByLabel('Reason', { exact: true }).fill('Original source documents are unavailable')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  let final = server.ctx.office.getItem(lin, task.id)
  expect(final).toMatchObject({ id: task.id, ownerId: kind === 'task' ? lin : chen, creatorId: lin,
    status: kind === 'task' ? 'cancelled' : 'pending', revision: moved.revision + 1 })
  if (kind === 'task') expect(final.taskActions?.at(-1)).toMatchObject({ kind: 'reject', actorId: lin,
    reason: 'Original source documents are unavailable' })
  else {
    expect(final.todoAssignments?.at(-1)).toMatchObject({ kind: 'transfer', actorId: lin, fromOwnerId: lin, toOwnerId: chen,
      reason: 'Original source documents are unavailable' })
    await detail.getByLabel('Status', { exact: true }).selectOption('completed')
    await expect.poll(() => server.ctx.office.getItem(lin, task.id).status).toBe('completed')
    final = server.ctx.office.getItem(lin, task.id)
  }
  await detail.getByText('Original source documents are unavailable', { exact: true }).waitFor()
  if (kind === 'task') expect(await detail.getByRole('button', { name: 'Accept task', exact: true }).isDisabled()).toBe(true)
  expect(await detail.getByRole('button', { name: transferLabel, exact: true }).isDisabled()).toBe(true)
  const runId = randomUUID()
  const before = join(artifacts, `task-${runId}-before.json`)
  const after = join(artifacts, `task-${runId}-after.json`)
  await writeFile(before, baseline)
  await writeFile(after, await readFile(path))
  const comparison = await new Promise<string>((resolveResult, reject) => {
    execFile(process.execPath, ['--experimental-import-meta-resolve',
      join(REPO_ROOT, 'apps/web/tests/fixtures/office-schedule-reader-compat.mjs'), before, after, kind],
    { cwd: REPO_ROOT, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 }, (error, output, errors) => {
      if (error) reject(new Error(`Office task reader comparison failed: ${errors}\n${output}`, { cause: error }))
      else resolveResult(output)
    })
  })
  const report: unknown = JSON.parse(comparison)
  expect(report).toMatchObject({ ok: true })
  await writeFile(join(artifacts, `task-${runId}-reader-comparison.json`), comparison)
  const port = Number(new URL(server.address).port)
  await server.ctx.fiber.dispose()
  const restarted = await central(root, port)
  expect(restarted.ctx.office.getItem(lin, task.id)).toEqual(final)
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  detail = await open(page)
  await detail.getByText('Original source documents are unavailable', { exact: true }).waitFor()
  expect(await detail.getByRole('region', { name: historyLabel, exact: true }).getByRole('listitem').count()).toBe(kind === 'task' ? 3 : 2)
  await compareOrRefreshGolden(join(REPO_ROOT, kind === 'task' ? 'apps/web/tests/expected/office-task-decisions/conflict.expected.md'
    : 'apps/web/tests/expected/office-todo-assignment/conflict.expected.md'), conflictAria, webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  expect(peerConsole.pageErrors).toEqual([])
  expect(peerConsole.warnings).toEqual([])
})

it.each(['task', 'todo'] as const)('edits central %s content with preserved decisions, reviewed drafts and old-reader refusal', async (kind) => {
  const { root, server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const service = server.ctx.office
  const secret = await service.createWork(admin, { kind: 'todo', title: 'Unrelated private work', date: '2026-10-20', ownerId: admin })
  let work = await service.createWork(lin, { kind, title: 'Reviewed work content', date: '2026-10-20', time: '09:30', ownerId: chen })
  if (kind === 'task') work = await service.decideTask(chen, work.id, work.revision, { kind: 'accept' })
  const path = join(root, 'data', 'enterprise_office.json')
  const baseline = await readFile(path)
  const sender = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  const recipient = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => sender.close())
  onTestFinished(() => recipient.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const colleague = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  const peerConsole = watchConsole(colleague)
  const open = async (window: Page) => {
    await window.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Work', exact: true }).click()
    await window.getByRole('button', { name: 'All accessible work', exact: true }).click()
    await window.locator(`[data-office-item="${work.id}"]`).click()
    return window.getByRole('dialog', { name: 'Work details', exact: true })
  }
  await page.goto(sender.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  const denied = await sender.hostFetch('/api/office/updateWork', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'office/updateWork', payload: { args: {
      id: secret.id, revision: secret.revision, input: { title: 'Forbidden edit', date: '2026-10-21' } } } }) })
  expect(await denied.json()).toMatchObject({ result: { ok: true, value: { ok: false, code: 'not_found' } } })
  expect(await readFile(path)).toEqual(baseline)
  await colleague.goto(recipient.authenticatedUrl, { waitUntil: 'load' })
  await signIn(colleague, chen)
  let detail = await open(colleague)
  await detail.getByRole('button', { name: 'Edit work item', exact: true }).click()
  let editor = colleague.getByRole('dialog', { name: 'Edit work item', exact: true })
  await editor.getByLabel('Title', { exact: true }).fill('Cancelled work edit')
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(path)).toEqual(baseline)
  detail = await open(colleague)
  await detail.getByRole('button', { name: 'Edit work item', exact: true }).click()
  editor = colleague.getByRole('dialog', { name: 'Edit work item', exact: true })
  await editor.getByLabel('Title', { exact: true }).fill('Preserved content draft')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const controller = recipient.ctx.officeController
  const update = controller.updateWork.bind(controller)
  const held = vi.spyOn(controller, 'updateWork').mockImplementationOnce(async (...args) => {
    entered.resolve(undefined); await release.promise; return update(...args)
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await entered.promise
  const concurrent = await service.updateWork(admin, work.id, work.revision,
    { title: work.title, date: work.date, time: work.time, description: 'Concurrent office notes' })
  release.resolve(undefined)
  await editor.getByRole('button', { name: 'Load latest work item', exact: true }).waitFor()
  expect(await editor.getByLabel('Title', { exact: true }).inputValue()).toBe('Preserved content draft')
  expect(await editor.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  const conflictAria = await editor.ariaSnapshot()
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, `work-edit-${kind}-conflict.aria.md`), `${conflictAria}\n`)
  for (const theme of ['light', 'dark'] as const) {
    await colleague.emulateMedia({ colorScheme: theme })
    await colleague.setViewportSize({ width: theme === 'light' ? 1440 : 800, height: 720 })
    const bounds = await editor.boundingBox()
    expect(bounds?.y).toBeGreaterThanOrEqual(24)
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(696)
    const save = editor.getByRole('button', { name: 'Save', exact: true })
    await save.scrollIntoViewIfNeeded()
    const saveBounds = await save.boundingBox()
    expect(saveBounds?.y).toBeGreaterThanOrEqual(24)
    expect((saveBounds?.y ?? 0) + (saveBounds?.height ?? 0)).toBeLessThanOrEqual(696)
    await editor.getByRole('heading', { name: 'Edit work item', exact: true }).scrollIntoViewIfNeeded()
    await colleague.screenshot({ path: join(artifacts, `work-edit-${kind}-${theme}.png`), animations: 'disabled' })
  }
  await colleague.emulateMedia({ colorScheme: 'light' })
  await colleague.setViewportSize({ width: 1440, height: 900 })
  await editor.getByRole('button', { name: 'Load latest work item', exact: true }).click()
  expect(await editor.getByLabel('Notes', { exact: true }).inputValue()).toBe('Concurrent office notes')
  await editor.getByLabel('Title', { exact: true }).fill('Updated office work')
  await editor.getByLabel('Date', { exact: true }).fill('2026-10-21')
  await editor.getByLabel('Due time (optional)', { exact: true }).fill('15:30')
  await editor.getByLabel('Notes', { exact: true }).fill('Reviewed final work notes')
  held.mockRestore()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  let changed = service.getItem(lin, work.id)
  expect(changed).toMatchObject({ id: work.id, kind, ownerId: chen, creatorId: lin, status: work.status,
    revision: concurrent.revision + 1, date: '2026-10-21', time: '15:30', title: 'Updated office work', description: 'Reviewed final work notes' })
  expect(changed.taskActions).toEqual(work.taskActions)
  detail = await open(colleague)
  await detail.getByRole('button', { name: 'Edit work item', exact: true }).click()
  editor = colleague.getByRole('dialog', { name: 'Edit work item', exact: true })
  await editor.getByLabel('Due time (optional)', { exact: true }).fill('')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  changed = service.getItem(lin, work.id)
  expect(changed.time).toBeUndefined()
  expect(changed.taskActions).toEqual(work.taskActions)
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).waitFor()
  const creatorDetail = await open(page)
  await creatorDetail.getByRole('heading', { name: changed.title, exact: true }).waitFor()
  await creatorDetail.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  const notices = page.getByRole('dialog', { name: 'Notifications', exact: true })
  expect(await notices.getByRole('button').filter({ hasText: 'Updated work details' }).count()).toBe(3)
  await notices.getByRole('button', { name: 'Close', exact: true }).click()
  work = changed
  {
    detail = await open(colleague)
    await detail.getByRole('button', { name: 'Edit work item', exact: true }).click()
    editor = colleague.getByRole('dialog', { name: 'Edit work item', exact: true })
    await editor.getByLabel('Title', { exact: true }).fill('Private unsaved task draft')
    const moved = await service.decideTask(lin, work.id, work.revision, { kind: 'transfer', ownerId: admin, reason: 'Review privately' })
    await editor.waitFor({ state: 'hidden' })
    work = await service.decideTask(lin, work.id, moved.revision, { kind: 'transfer', ownerId: chen, reason: 'Return for execution' })
    await colleague.locator(`[data-office-item="${work.id}"]`).waitFor()
    expect(await colleague.getByRole('dialog', { name: 'Edit work item', exact: true }).count()).toBe(0)
  }
  detail = await open(colleague)
  await detail.getByRole('button', { name: 'Edit work item', exact: true }).click()
  editor = colleague.getByRole('dialog', { name: 'Edit work item', exact: true })
  await editor.getByLabel('Title', { exact: true }).fill('Draft retained after closure')
  const final = await service.setStatus(lin, work.id, work.revision, 'completed')
  await editor.getByText('Completed or cancelled work cannot be edited', { exact: true }).waitFor()
  expect(await editor.getByLabel('Title', { exact: true }).inputValue()).toBe('Draft retained after closure')
  expect(await editor.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  const runId = randomUUID()
  const before = join(artifacts, `work-${runId}-before.json`)
  const after = join(artifacts, `work-${runId}-after.json`)
  await writeFile(before, baseline)
  await writeFile(after, await readFile(path))
  const comparison = await new Promise<string>((resolveResult, reject) => {
    execFile(process.execPath, ['--experimental-import-meta-resolve',
      join(REPO_ROOT, 'apps/web/tests/fixtures/office-schedule-reader-compat.mjs'), before, after, 'work'],
    { cwd: REPO_ROOT, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 }, (error, output, errors) => {
      if (error) reject(new Error(`Office work reader comparison failed: ${errors}\n${output}`, { cause: error }))
      else resolveResult(output)
    })
  })
  const report: unknown = JSON.parse(comparison)
  expect(report).toMatchObject({ ok: true })
  await writeFile(join(artifacts, `work-${runId}-reader-comparison.json`), comparison)
  const port = Number(new URL(server.address).port)
  await server.ctx.fiber.dispose()
  const restarted = await central(root, port)
  expect(restarted.ctx.office.getItem(chen, work.id)).toEqual(final)
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-work-edits/conflict.expected.md'), conflictAria, webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  expect(peerConsole.pageErrors).toEqual([])
  expect(peerConsole.warnings).toEqual([])
})

it.each(['task', 'todo'] as const)('maintains central %s priorities without changing date order or decision history', async (kind) => {
  const { root, server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const service = server.ctx.office
  await service.createWork(lin, { kind, title: 'Earlier ordinary work', date: '2026-10-19', ownerId: chen })
  let work = await service.createWork(lin, { kind, title: 'Priority review', date: '2026-10-20', time: '09:30', ownerId: chen })
  if (kind === 'task') work = await service.decideTask(chen, work.id, work.revision, { kind: 'accept' })
  else {
    work = await service.decideTask(lin, work.id, work.revision, { kind: 'transfer', ownerId: lin, reason: 'Review ownership' })
    work = await service.decideTask(lin, work.id, work.revision, { kind: 'transfer', ownerId: chen, reason: 'Return for execution' })
  }
  const path = join(root, 'data', 'enterprise_office.json')
  const baseline = await readFile(path)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, chen)
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Work', exact: true }).click()
  const rows = page.locator('[data-office-item]')
  await page.locator(`[data-office-item="${work.id}"]`).waitFor()
  const order = await rows.evaluateAll(entries => entries.map(entry => entry.getAttribute('data-office-item')))
  const edit = async () => {
    await page.locator(`[data-office-item="${work.id}"]`).click()
    const detail = page.getByRole('dialog', { name: 'Work details', exact: true })
    await detail.getByRole('button', { name: 'Edit work item', exact: true }).click()
    return page.getByRole('dialog', { name: 'Edit work item', exact: true })
  }
  let editor = await edit()
  expect(await editor.getByLabel('Priority', { exact: true }).inputValue()).toBe('normal')
  expect(await editor.getByLabel('Priority', { exact: true }).getByRole('option').allTextContents()).toEqual(['Low', 'Normal', 'High', 'Urgent'])
  await editor.getByLabel('Priority', { exact: true }).selectOption('urgent')
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(path)).toEqual(baseline)
  editor = await edit()
  await editor.getByLabel('Priority', { exact: true }).selectOption('low')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  await page.locator(`[data-office-item="${work.id}"]`).getByLabel('Priority: Low', { exact: true }).waitFor()
  expect(await rows.evaluateAll(entries => entries.map(entry => entry.getAttribute('data-office-item')))).toEqual(order)
  const low = service.getItem(chen, work.id)
  expect(low).toMatchObject({ priority: 'low', date: work.date, time: work.time, status: work.status, ownerId: chen })
  expect(low.taskActions).toEqual(work.taskActions)
  expect(low.todoAssignments).toEqual(work.todoAssignments)
  editor = await edit()
  await editor.getByLabel('Priority', { exact: true }).selectOption('high')
  const urgent = await service.updateWork(admin, work.id, low.revision,
    { title: low.title, date: low.date, time: low.time, priority: 'urgent' })
  await editor.getByRole('button', { name: 'Load latest work item', exact: true }).waitFor()
  expect(await editor.getByLabel('Priority', { exact: true }).inputValue()).toBe('high')
  expect(await editor.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  await editor.getByRole('button', { name: 'Load latest work item', exact: true }).click()
  expect(await editor.getByLabel('Priority', { exact: true }).inputValue()).toBe('urgent')
  await editor.getByLabel('Priority', { exact: true }).selectOption('high')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  await page.locator(`[data-office-item="${work.id}"]`).getByLabel('Priority: High', { exact: true }).waitFor()
  expect(service.getItem(chen, work.id).revision).toBe(urgent.revision + 1)
  await page.locator(`[data-office-item="${work.id}"]`).click()
  let detail = page.getByRole('dialog', { name: 'Work details', exact: true })
  await detail.getByText('High', { exact: true }).waitFor()
  await detail.getByRole('button', { name: 'Edit work item', exact: true }).click()
  editor = page.getByRole('dialog', { name: 'Edit work item', exact: true })
  await editor.getByLabel('Priority', { exact: true }).selectOption('normal')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  const final = service.getItem(chen, work.id)
  expect(final.priority).toBeUndefined()
  expect(final.taskActions).toEqual(work.taskActions)
  expect(final.todoAssignments).toEqual(work.todoAssignments)
  expect(await rows.evaluateAll(entries => entries.map(entry => entry.getAttribute('data-office-item')))).toEqual(order)
  expect(await page.locator(`[data-office-item="${work.id}"]`).getByLabel(/^Priority:/).count()).toBe(0)
  await page.locator(`[data-office-item="${work.id}"]`).click()
  detail = page.getByRole('dialog', { name: 'Work details', exact: true })
  await detail.getByText('Normal', { exact: true }).waitFor()
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  const notices = page.getByRole('dialog', { name: 'Notifications', exact: true })
  expect(await notices.getByRole('button').filter({ hasText: 'Updated work priority' }).count()).toBe(1)
  expect(service.view(lin).notifications.filter(entry => entry.kind === 'work_prioritized')).toHaveLength(4)
  expect(service.audit(admin).filter(entry => entry.action === 'work_prioritized')).toHaveLength(4)
  await notices.getByRole('button', { name: 'Close', exact: true }).click()
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office')
  await mkdir(artifacts, { recursive: true })
  const runId = randomUUID()
  const before = join(artifacts, `priority-${kind}-${runId}-before.json`)
  const after = join(artifacts, `priority-${kind}-${runId}-after.json`)
  await writeFile(before, baseline)
  await writeFile(after, await readFile(path))
  const comparison = await new Promise<string>((resolveResult, reject) => {
    execFile(process.execPath, ['--experimental-import-meta-resolve',
      join(REPO_ROOT, 'apps/web/tests/fixtures/office-schedule-reader-compat.mjs'), before, after, 'priority'],
    { cwd: REPO_ROOT, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 }, (error, output, errors) => {
      if (error) reject(new Error(`Office priority reader comparison failed: ${errors}\n${output}`, { cause: error }))
      else resolveResult(output)
    })
  })
  const report: unknown = JSON.parse(comparison)
  expect(report).toMatchObject({ ok: true })
  await writeFile(join(artifacts, `priority-${kind}-${runId}-reader-comparison.json`), comparison)
  const port = Number(new URL(server.address).port)
  await server.ctx.fiber.dispose()
  const restarted = await central(root, port)
  expect(restarted.ctx.office.getItem(chen, work.id)).toEqual(final)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

async function reviewSubmittedTaskInBrowser(page: Page, id: OfficeItemId, date: string) {
  let detail = await openCalendarItem(page, id, date)
  const delivery = () => detail.getByRole('region', { name: 'Delivery and review', exact: true })
  await delivery().getByRole('button', { name: 'Return delivery', exact: true }).click()
  let form = delivery().getByRole('form', { name: 'Return delivery', exact: true })
  await form.getByLabel('Explanation or reason', { exact: true }).fill('Add the missing totals')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await delivery().getByText('Add the missing totals', { exact: true }).waitFor()
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await signOut(page)
  await signIn(page, chen)
  detail = await openCalendarItem(page, id, date)
  await delivery().getByRole('button', { name: 'Submit delivery', exact: true }).click()
  form = delivery().getByRole('form', { name: 'Submit delivery', exact: true })
  await form.getByLabel('Explanation or reason', { exact: true }).fill('Totals checked and corrected')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await signOut(page)
  await signIn(page, lin)
  detail = await openCalendarItem(page, id, date)
  await delivery().getByRole('button', { name: 'Confirm delivery', exact: true }).click()
  form = delivery().getByRole('form', { name: 'Confirm delivery', exact: true })
  await form.getByLabel('Explanation or reason', { exact: true }).fill('Totals reviewed and approved')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  return detail
}

async function compareTaskDeliveryReader(baseline: Uint8Array, changed: Uint8Array, feature = 'delivery') {
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office')
  await mkdir(artifacts, { recursive: true })
  const runId = randomUUID()
  const before = join(artifacts, `${feature}-${runId}-before.json`)
  const after = join(artifacts, `${feature}-${runId}-after.json`)
  await writeFile(before, baseline)
  await writeFile(after, changed)
  const comparison = await new Promise<string>((resolveResult, reject) => {
    execFile(process.execPath, ['--experimental-import-meta-resolve',
      join(REPO_ROOT, 'apps/web/tests/fixtures/office-schedule-reader-compat.mjs'), before, after, feature],
    { cwd: REPO_ROOT, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 }, (error, output, errors) => {
      if (error) reject(new Error(`Office ${feature} reader comparison failed: ${errors}\n${output}`, { cause: error }))
      else resolveResult(output)
    })
  })
  expect(JSON.parse(comparison)).toMatchObject({ ok: true })
  await writeFile(join(artifacts, `${feature}-${runId}-reader-comparison.json`), comparison)
}

async function openCalendarItem(page: Page, id: OfficeItemId, date: string) {
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Workbench', exact: true }).click()
  await page.getByRole('button', { name: 'Calendar', exact: true }).click()
  await page.getByLabel('Date', { exact: true }).fill(date)
  await page.locator(`[data-office-item="${id}"]`).click()
  return page.getByRole('dialog', { name: 'Work details', exact: true })
}

async function signIn(page: Page, id: string, secret = password) {
  const form = page.getByRole('region', { name: 'Sign in to your company', exact: true })
  await form.getByLabel('Employee ID', { exact: true }).fill(id)
  await form.getByLabel('Password', { exact: true }).fill(secret)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Profile', exact: true }).waitFor()
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account and security', exact: true }).click()
  await page.getByRole('dialog', { name: 'Account and security', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('region', { name: 'Sign in to your company', exact: true }).waitFor()
}

it('defers periodic identity and business reads until an admitted sign-in returns its confirmed result', async () => {
  const { server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.get('officeController') as OfficeController
  const original = controller.signIn.bind(controller)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const signing = vi.spyOn(controller, 'signIn').mockImplementationOnce(async (input) => {
    const result = await original(input)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  onTestFinished(() => { release.resolve(undefined); signing.mockRestore() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  const requests: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith('/office/connection') || path.endsWith('/office/view')) requests.push(path)
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const form = page.getByRole('region', { name: 'Sign in to your company', exact: true })
  await form.getByLabel('Employee ID', { exact: true }).fill(lin)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await entered.promise
  const before = [...requests]
  // Hold beyond one real refresh interval after the Host has stored its new session.
  await page.evaluate(() => new Promise<void>((done) => { setTimeout(done, 5500) }))
  expect(requests).toEqual(before)
  expect(await form.isVisible()).toBe(true)
  expect(await form.getByRole('button', { name: 'Sign in', exact: true }).isDisabled()).toBe(true)
  expect(await page.getByRole('button', { name: 'Profile', exact: true }).count()).toBe(0)
  release.resolve(undefined)
  await form.waitFor({ state: 'hidden' })
  await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Lin')
  expect(signing).toHaveBeenCalledOnce()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('delivers eight-MiB chat files between employee Hosts and fences private selections and a late download on sign-out', async () => {
  const { server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const sender = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => sender.close())
  const recipient = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => recipient.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const colleague = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  const peerConsole = watchConsole(colleague)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-chat-file-account'))
  await page.goto(sender.authenticatedUrl, { waitUntil: 'load' })
  await colleague.goto(recipient.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  await signIn(colleague, chen)
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Contacts', exact: true }).click()
  await page.locator('[data-office-member="chen"]').getByRole('button', { name: 'Message', exact: true }).click()
  const chat = page.getByRole('dialog', { name: 'Employee chat', exact: true })
  const picker = chat.getByLabel('Choose chat files', { exact: true })
  await expect.poll(() => picker.isEnabled()).toBe(true)
  const bytes = Buffer.alloc(8 * 1024 * 1024, 53)
  Buffer.from('集中办公真实字节\0\n').copy(bytes)
  await picker.setInputFiles({ name: '跨员工交付.bin', mimeType: 'application/octet-stream', buffer: bytes })
  await chat.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => chat.getByRole('list', { name: 'Files to send', exact: true }).count()).toBe(0)
  expect(server.ctx.office.chat(lin, chen).messages).toHaveLength(1)

  await colleague.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Contacts', exact: true }).click()
  await colleague.locator('[data-office-member="lin"]').getByRole('button', { name: 'Message', exact: true }).click()
  const peerChat = colleague.getByRole('dialog', { name: 'Employee chat', exact: true })
  const peerDownload = peerChat.getByRole('button', { name: 'Download attachment · 跨员工交付.bin', exact: true })
  await peerDownload.waitFor()
  const downloading = colleague.waitForEvent('download')
  await peerDownload.click()
  const saved = await downloading
  const path = await saved.path()
  if (!path) throw new Error('No recipient file download')
  expect(Buffer.compare(await readFile(path), bytes)).toBe(0)

  const hold = Promise.withResolvers<undefined>()
  onTestFinished(() => { hold.resolve(undefined) })
  const read = server.ctx.office.downloadChatFile.bind(server.ctx.office)
  const reads = vi.spyOn(server.ctx.office, 'downloadChatFile')
  onTestFinished(() =>{  reads.mockRestore() })
  reads.mockImplementationOnce(async (actor, coordinates) => {
    const result = await read(actor, coordinates)
    await hold.promise
    return result
  })
  const downloads: string[] = []
  page.on('download', (value) => { downloads.push(value.suggestedFilename()) })
  await chat.getByRole('button', { name: 'Download attachment · 跨员工交付.bin', exact: true }).click()
  await expect.poll(() => reads.mock.calls.length).toBe(1)
  await picker.setInputFiles({ name: 'Lin私有待发.txt', mimeType: 'text/plain', buffer: Buffer.from('尚未发送') })
  await chat.getByRole('group', { name: 'File draft', exact: true }).getByText('Files saved', { exact: true }).waitFor()
  await chat.getByRole('button', { name: 'Close', exact: true }).click()
  await signOut(page)
  await signIn(page, chen)
  await nav.getByRole('button', { name: 'Contacts', exact: true }).click()
  await page.locator('[data-office-member="lin"]').getByRole('button', { name: 'Message', exact: true }).click()
  expect(await chat.getByRole('list', { name: 'Files to send', exact: true }).count()).toBe(0)
  expect(await chat.textContent()).not.toContain('Lin私有待发.txt')
  hold.resolve(undefined)
  await expect.poll(() => chat.getByRole('button', { name: 'Download attachment · 跨员工交付.bin', exact: true }).isEnabled()).toBe(true)
  const newDownload = page.waitForEvent('download')
  await chat.getByRole('button', { name: 'Download attachment · 跨员工交付.bin', exact: true }).click()
  const newPath = await (await newDownload).path()
  if (!newPath) throw new Error('No newly authorized file download')
  expect(Buffer.compare(await readFile(newPath), bytes)).toBe(0)
  expect(downloads).toEqual(['跨员工交付.bin'])
  expect(reads.mock.calls.map(([actor]) => actor)).toEqual([lin, chen])
  await chat.getByRole('button', { name: 'Close', exact: true }).click()
  await signOut(page)
  await signIn(page, lin)
  await nav.getByRole('button', { name: 'Contacts', exact: true }).click()
  await page.locator('[data-office-member="chen"]').getByRole('button', { name: 'Message', exact: true }).click()
  await chat.getByRole('list', { name: 'Files to send', exact: true })
    .getByRole('button', { name: 'Remove file · Lin私有待发.txt', exact: true }).waitFor()
  expect(console.pageErrors).toEqual([])
  expect(peerConsole.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  expect(peerConsole.warnings).toEqual([])
})

it('fences an in-flight drive chunk across employee replacement and completes large transfers through the real gateway', async () => {
  const { server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const employee = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => employee.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-transfer-account'))
  const hold = Promise.withResolvers<undefined>()
  onTestFinished(() => { hold.resolve(undefined) })
  const append = server.ctx.office.appendDriveUpload.bind(server.ctx.office)
  const chunks = vi.spyOn(server.ctx.office, 'appendDriveUpload')
  onTestFinished(() =>{  chunks.mockRestore() })
  chunks.mockImplementationOnce(async (actor, input) => {
    const result = await append(actor, input)
    await hold.promise
    return result
  })
  await page.goto(employee.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Drive', exact: true }).click()
  const drive = page.getByRole('region', { name: 'Drive', exact: true })
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 19, 0x3a)
  bytes.write('central private content\0')
  await drive.getByText('This folder is empty', { exact: true }).waitFor()
  await drive.locator('input[type=file][aria-label="Upload file"]').setInputFiles({
    name: 'lin-private-inflight.bin', mimeType: 'application/octet-stream', buffer: bytes,
  })
  await page.getByRole('dialog', { name: 'Upload file', exact: true }).getByRole('button', { name: 'Upload file', exact: true }).click()
  await expect.poll(() => chunks.mock.calls.length).toBe(1)
  const ticketId = chunks.mock.calls[0]![1].uploadId
  await signOut(page)
  await signIn(page, chen)
  await nav.getByRole('button', { name: 'Drive', exact: true }).click()
  await drive.getByText('This folder is empty', { exact: true }).waitFor()
  hold.resolve(undefined)
  await drive.getByRole('button', { name: 'Refresh', exact: true }).click()
  expect(await drive.getByText('lin-private-inflight.bin', { exact: true }).count()).toBe(0)
  expect((await server.ctx.office.driveUploads(chen))).toEqual([])
  expect(chunks).toHaveBeenCalledTimes(1)
  await expect(server.ctx.office.getDriveUpload(chen, ticketId)).rejects.toMatchObject({ code: 'not_found' })
  await signOut(page)
  await signIn(page, lin)
  await nav.getByRole('button', { name: 'Drive', exact: true }).click()
  const transfer = drive.getByRole('region', { name: 'File transfers', exact: true })
  await transfer.getByText('Uploads to resume', { exact: true }).waitFor()
  await transfer.getByRole('button', { name: 'Cancel', exact: true }).click()
  await transfer.getByText('Cancelled', { exact: true }).waitFor()
  expect((await server.ctx.office.getDriveUpload(lin, ticketId)).status).toBe('cancelled')
  await transfer.getByRole('button', { name: 'Close', exact: true }).click()
  await drive.locator('input[type=file][aria-label="Upload file"]').setInputFiles({
    name: 'central-large-complete.bin', mimeType: 'application/octet-stream', buffer: bytes,
  })
  await page.getByRole('dialog', { name: 'Upload file', exact: true }).getByRole('button', { name: 'Upload file', exact: true }).click()
  await transfer.getByText('Upload complete', { exact: true }).waitFor()
  const entries = server.ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries
  expect(entries).toHaveLength(1)
  const downloaded = page.waitForEvent('download')
  await drive.locator(`[data-drive-entry="${entries[0]!.id}"]`).dblclick()
  const file = await (await downloaded).path()
  if (!file) throw new Error('Central download missing')
  expect(Buffer.compare(await readFile(file), bytes)).toBe(0)
  expect(chunks).toHaveBeenCalledTimes(11)
  expect(chunks.mock.calls.every(([actor]) => actor === lin)).toBe(true)
  expect(server.ctx.office.drive(chen, { space: 'private', folderId: null, search: '' }).entries).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('publishes scoped announcements, acknowledges only committed reads, pauses rotation and withdraws across employee Hosts', async () => {
  const { server, overlay } = await setup(1000)
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const administrator = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => administrator.close())
  const employee = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => employee.close())
  const outsider = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => outsider.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const author = await newEnglishPage(browser, 900)
  const page = await newEnglishPage(browser, 900)
  const other = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-announcements'))
  onTestFailed(() => saveFailureShot(author, 'enterprise-office-announcements-author'))
  await author.goto(administrator.authenticatedUrl, { waitUntil: 'load' })
  await signIn(author, admin)
  await page.goto(employee.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  await other.goto(outsider.authenticatedUrl, { waitUntil: 'load' })
  await signIn(other, chen)
  expect(await page.getByRole('button', { name: 'Manage announcements', exact: true }).count()).toBe(0)
  const card = page.getByRole('region', { name: 'Company announcements', exact: true })
  await card.getByText('No announcements', { exact: true }).waitFor()

  const publish = async (title: string, body: string, selected: boolean) => {
    await author.bringToFront()
    await author.getByRole('button', { name: 'Manage announcements', exact: true }).click()
    await author.getByRole('dialog', { name: 'Manage announcements', exact: true }).getByRole('button', { name: 'Publish announcement', exact: true }).click()
    const dialog = author.getByRole('dialog', { name: 'Publish announcement', exact: true })
    await dialog.getByLabel('Title', { exact: true }).fill(title)
    await dialog.getByLabel('Announcement text', { exact: true }).fill(body)
    if (selected) {
      await dialog.getByLabel('Delivery scope', { exact: true }).selectOption('members')
      expect(await dialog.getByRole('button', { name: 'Publish announcement', exact: true }).isDisabled()).toBe(true)
      await dialog.getByRole('checkbox', { name: 'Lin', exact: true }).check()
      const write = vi.spyOn(server.ctx.storageDomain.get('enterprise_office_announcements')!.global, 'set')
        .mockRejectedValueOnce(new Error('Expected publication storage failure'))
      onTestFinished(() => { write.mockRestore() })
      await dialog.getByRole('button', { name: 'Publish announcement', exact: true }).click()
      await author.getByText('Cannot reach the office service; try again', { exact: true }).waitFor()
      expect(await dialog.getByLabel('Title', { exact: true }).inputValue()).toBe(title)
      expect(await dialog.getByLabel('Announcement text', { exact: true }).inputValue()).toBe(body)
      expect(server.ctx.office.view(lin).announcements!.entries).toEqual([])
      write.mockRestore()
    }
    await dialog.getByRole('button', { name: 'Publish announcement', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await author.getByRole('dialog', { name: 'Manage announcements', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  }
  await publish('仅林可见的公告', '第一行\n<script>window.announcementLeak = true</script>', true)
  await page.bringToFront()
  const first = server.ctx.office.view(lin).announcements!.entries[0]!
  await card.locator(`[data-office-announcement="${first.id}"]`).waitFor({ timeout: 15_000 })
  await other.bringToFront()
  await other.getByRole('region', { name: 'Company announcements', exact: true }).getByText('No announcements', { exact: true }).waitFor()
  expect(await other.getByText('仅林可见的公告', { exact: true }).count()).toBe(0)
  await page.bringToFront()
  const domain = server.ctx.storageDomain.get('enterprise_office_announcements')!
  const failedRead = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected acknowledgement storage failure'))
  onTestFinished(() => { failedRead.mockRestore() })
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  let inbox = page.getByRole('dialog', { name: 'Notifications', exact: true })
  await inbox.getByRole('button', { name: 'Unread only', exact: true }).click()
  const notification = inbox.getByRole('button').filter({ hasText: '仅林可见的公告' })
  await notification.click()
  await page.getByText('Cannot reach the office service; try again', { exact: true }).waitFor()
  expect(server.ctx.office.view(lin).announcements!.entries[0]?.read).toBe(false)
  expect(await inbox.isVisible()).toBe(true)
  failedRead.mockRestore()
  await notification.click()
  let detail = page.getByRole('dialog', { name: 'Announcement details', exact: true })
  await detail.waitFor()
  expect(await detail.getByText('<script>window.announcementLeak = true</script>', { exact: false }).count()).toBe(1)
  expect(await page.evaluate(() => Reflect.has(window, 'announcementLeak'))).toBe(false)
  expect(server.ctx.office.view(lin).announcements!.entries[0]?.read).toBe(true)
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  const checkpoint = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await card.locator(`[data-office-announcement="${first.id}"]`).waitFor()
  acknowledgeReloadConnectionLoss(console, checkpoint)
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  inbox = page.getByRole('dialog', { name: 'Notifications', exact: true })
  await inbox.getByRole('button', { name: 'Unread only', exact: true }).click()
  await inbox.getByText('No unread notifications', { exact: true }).waitFor()
  await inbox.getByRole('button', { name: 'All notifications', exact: true }).click()
  expect(await inbox.getByRole('button').filter({ hasText: '仅林可见的公告' }).textContent()).toContain(' · Read')
  await inbox.getByRole('button', { name: 'Close', exact: true }).click()

  await publish('面向全体的新公告', 'All active employees at publication receive this notice.', false)
  await page.bringToFront()
  await expect.poll(() => card.getByRole('button', { name: 'Next announcement', exact: true }).isEnabled(), { timeout: 15_000 }).toBe(true)
  const current = () => card.locator('[data-office-announcement]').getAttribute('data-office-announcement')
  await card.hover()
  const paused = await current()
  await page.waitForTimeout(2100)
  expect(await current()).toBe(paused)
  await page.getByRole('button', { name: 'Notifications', exact: true }).focus()
  await page.mouse.move(0, 0)
  await expect.poll(current, { timeout: 4000 }).not.toBe(paused)
  await card.locator('[data-office-announcement]').focus()
  const focused = await current()
  await page.waitForTimeout(2100)
  expect(await current()).toBe(focused)
  await card.getByRole('button', { name: 'Pause rotation', exact: true }).click()
  await page.getByRole('button', { name: 'Notifications', exact: true }).focus()
  await page.mouse.move(0, 0)
  const stopped = await current()
  await page.waitForTimeout(2100)
  expect(await current()).toBe(stopped)
  await card.locator('[data-office-announcement]').focus()
  await page.keyboard.press('Enter')
  detail = page.getByRole('dialog', { name: 'Announcement details', exact: true })
  await detail.waitFor()
  await detail.getByRole('button', { name: 'Close', exact: true }).click()

  await card.getByRole('button', { name: 'Resume rotation', exact: true }).click()
  await page.getByRole('button', { name: 'Notifications', exact: true }).focus()
  await page.mouse.move(0, 0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => card.getByRole('button', { name: 'Pause rotation', exact: true }).isDisabled()).toBe(true)
  const motionPaused = await current()
  await page.waitForTimeout(2100)
  expect(await current()).toBe(motionPaused)
  await card.getByRole('button', { name: 'Next announcement', exact: true }).click()
  expect(await current()).not.toBe(motionPaused)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => card.getByRole('button', { name: 'Pause rotation', exact: true }).isEnabled()).toBe(true)
  await card.getByRole('button', { name: 'Pause rotation', exact: true }).click()
  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Notifications', exact: true }).focus()

  const shots = join(REPO_ROOT, '.artifacts/enterprise-office')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'announcements-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
  await page.screenshot({ path: join(shots, 'announcements-dark.png'), fullPage: true })
  await page.setViewportSize({ width: 1040, height: 700 })
  await page.getByRole('main').evaluate((element) => { element.scrollTop = 0 })
  const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox()
  expect(send).not.toBeNull()
  expect(send!.y + send!.height).toBeLessThanOrEqual(700)
  await page.screenshot({ path: join(shots, 'announcements-small.png'), fullPage: true })

  await author.bringToFront()
  await author.getByRole('button', { name: 'Manage announcements', exact: true }).click()
  await author.getByRole('dialog', { name: 'Manage announcements', exact: true }).getByRole('button').filter({ hasText: '仅林可见的公告' }).click()
  detail = author.getByRole('dialog', { name: 'Announcement details', exact: true })
  await detail.getByRole('button', { name: 'Withdraw announcement', exact: true }).click()
  await detail.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })
  await page.bringToFront()
  await expect.poll(() => server.ctx.office.view(lin).announcements?.entries.some(item => item.id === first.id)).toBe(false)
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  await expect.poll(() => page.getByRole('dialog', { name: 'Notifications', exact: true }).getByRole('button')
    .filter({ hasText: '仅林可见的公告' }).count(), { timeout: 15_000 }).toBe(0)
  expect(console.pageErrors).toEqual([])
})

it('configures formal hierarchy and positions through central sign-in while preserving employee authority and reviewed edits', async () => {
  const { server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  await page.setViewportSize({ width: 1440, height: 900 })
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-organization'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('region', { name: 'Sign in to your company', exact: true }).waitFor({ timeout: 30_000 })
  await signIn(page, admin)
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Team', exact: true }).click()
  let organization = page.getByRole('region', { name: 'Organization', exact: true })
  await organization.getByRole('button', { name: 'Set up organization', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Set up organization', exact: true })
  expect(await dialog.getByLabel('Company name', { exact: true }).inputValue()).toBe('Shared company')
  expect(await dialog.getByLabel('Office time zone', { exact: true }).getAttribute('readonly')).toBe('')
  await dialog.getByRole('button', { name: 'Review departments and positions', exact: true }).click()
  await page.bringToFront()
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
  expect(await dialog.getByRole('cell', { name: 'Operations', exact: true }).count()).toBe(1)
  expect(server.ctx.office.organization(admin).initialized).toBe(false)
  const peer = server.ctx.office.view(chen).me
  await server.ctx.office.updateProfile(chen, { name: 'Chen updated', department: peer.department, jobTitle: peer.jobTitle, email: peer.email, phone: peer.phone })
  await dialog.getByRole('button', { name: 'Load latest information', exact: true }).waitFor({ timeout: 15_000 })
  expect(await dialog.getByRole('button', { name: 'Create organization', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('button', { name: 'Load latest information', exact: true }).click()
  expect(await dialog.getByRole('cell', { name: 'Chen updated', exact: true }).count()).toBe(1)
  await dialog.getByRole('button', { name: 'Create organization', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect(server.ctx.office.organization(admin).initialized).toBe(true)

  const createDepartment = async (name: string, parentId = '') => {
    await organization.getByRole('button', { name: 'New department', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'New department', exact: true })
    await form.getByLabel('Department name', { exact: true }).fill(name)
    await form.getByLabel('Parent department', { exact: true }).selectOption(parentId)
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await form.waitFor({ state: 'hidden' })
    return server.ctx.office.organization(admin).units.find(unit => unit.name === name)!
  }
  const parent = await createDepartment('Product')
  let department = await createDepartment('Platform', parent.id)
  await organization.getByRole('button', { name: 'New position', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'New position', exact: true })
  await dialog.getByLabel('Position name', { exact: true }).fill('Engineer')
  await dialog.getByLabel('Department scope', { exact: true }).selectOption(department.id)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const position = server.ctx.office.organization(admin).positions.find(entry => entry.name === 'Engineer')!
  await page.locator('[data-office-member="lin"]').getByRole('button', { name: 'Department and position', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Department and position', exact: true })
  await dialog.getByLabel('Department', { exact: true }).selectOption(department.id)
  await dialog.getByLabel('Job title', { exact: true }).selectOption(position.id)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect(server.ctx.office.organization(admin).assignments.find(entry => entry.memberId === lin))
    .toMatchObject({ unitId: department.id, positionId: position.id })
  expect(server.ctx.office.view(lin).me.role).toBe('employee')

  await page.locator(`[data-office-unit="${department.id}"]`).getByRole('button', { name: 'Edit department', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Edit department', exact: true })
  await dialog.getByLabel('Department name', { exact: true }).fill('Local unsaved name')
  department = await server.ctx.office.saveOrganizationUnit(admin, { ...department, name: 'External department name' })
  await dialog.getByRole('button', { name: 'Load latest information', exact: true }).waitFor({ timeout: 15_000 })
  expect(await dialog.getByLabel('Department name', { exact: true }).inputValue()).toBe('Local unsaved name')
  expect(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('button', { name: 'Load latest information', exact: true }).click()
  expect(await dialog.getByLabel('Department name', { exact: true }).inputValue()).toBe('External department name')
  await dialog.getByLabel('Department name', { exact: true }).fill('Platform engineering')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  department = server.ctx.office.organization(admin).units.find(entry => entry.id === department.id)!

  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await page.getByRole('main').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: join(shots, 'organization-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
  await page.screenshot({ path: join(shots, 'organization-dark.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 600, height: 720 })
  const overflow = await page.getByRole('main').evaluate(element => element.scrollWidth > element.clientWidth)
  expect(overflow).toBe(false)
  await page.screenshot({ path: join(shots, 'organization-small.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 900 })

  await signOut(page)
  await signIn(page, lin)
  await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Engineer')
  await nav.getByRole('button', { name: 'Contacts', exact: true }).click()
  const tree = page.getByRole('navigation', { name: 'Organization', exact: true })
  await tree.getByRole('button', { name: /^Product / }).click()
  expect(await page.locator('[data-office-member]').count()).toBe(1)
  expect(await page.locator('[data-office-member="lin"]').textContent()).toContain('Engineer')
  expect(await page.getByRole('heading', { name: 'Platform engineering', exact: true }).count()).toBe(1)
  await page.locator('[data-office-member="lin"]').getByRole('button', { name: 'Member details · Lin', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Member details', exact: true })
  await dialog.getByText('Platform engineering', { exact: true }).waitFor()
  await dialog.getByText('Engineer', { exact: true }).waitFor()
  expect(await dialog.getByRole('textbox').count()).toBe(0)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Profile', exact: true })
  expect(await dialog.getByLabel('Department', { exact: true }).inputValue()).toBe('Platform engineering')
  expect(await dialog.getByLabel('Job title', { exact: true }).getAttribute('readonly')).toBe('')
  await dialog.getByLabel('Name', { exact: true }).fill('Lin updated')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect(server.ctx.office.view(lin).me).toMatchObject({ name: 'Lin updated', department: 'Operations', jobTitle: 'Employee', role: 'employee' })
  await nav.getByRole('button', { name: 'Team', exact: true }).click()
  expect(await page.getByRole('region', { name: 'Organization', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Department and position', exact: true }).count()).toBe(0)
  const beforeReload = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Engineer')
  acknowledgeReloadConnectionLoss(console, beforeReload)
  await signOut(page)
  await signIn(page, admin)
  await nav.getByRole('button', { name: 'Team', exact: true }).click()
  organization = page.getByRole('region', { name: 'Organization', exact: true })
  await page.locator('[data-office-member="lin"]').getByRole('button', { name: 'Department and position', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Department and position', exact: true })
  await dialog.getByRole('button', { name: 'Clear affiliation', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator(`[data-office-position="${position.id}"]`).getByRole('button', { name: 'Edit position', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Edit position', exact: true })
  await dialog.getByRole('checkbox', { name: 'Active', exact: true }).uncheck()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.locator(`[data-office-unit="${department.id}"]`).getByRole('button', { name: 'Edit department', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Edit department', exact: true })
  await dialog.getByRole('checkbox', { name: 'Active', exact: true }).uncheck()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect(server.ctx.office.organization(lin).units.some(entry => entry.id === department.id)).toBe(false)
  expect(server.ctx.office.organization(lin).positions.some(entry => entry.id === position.id)).toBe(false)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('signs in, provisions a colleague, restores credentials after restart and manages own password and sessions', async () => {
  const { root, server, overlay } = await setup()
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  expect(scaffold.ctx.get('office')).toBeUndefined()
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  await page.setViewportSize({ width: 1440, height: 900 })
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-login'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const login = page.getByRole('region', { name: 'Sign in to your company', exact: true })
  await login.waitFor({ timeout: 30_000 })
  await login.getByLabel('Employee ID', { exact: true }).fill(admin)
  await login.getByLabel('Password', { exact: true }).fill('A wrong test password')
  await login.getByRole('button', { name: 'Sign in', exact: true }).click()
  await login.getByText('The credentials are invalid or the account is inactive', { exact: true }).waitFor()
  await signIn(page, admin)
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Team', exact: true }).click()
  await page.locator(`[data-office-member="${lin}"]`).getByRole('button', { name: 'Set sign-in password', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Set sign-in password', exact: true })
  await dialog.getByText('Password sign-in is not enabled', { exact: true }).waitFor()
  await dialog.getByLabel('New password', { exact: true }).fill(password)
  await dialog.getByLabel('Confirm new password', { exact: true }).fill(replacement)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  expect(await dialog.getByLabel('Confirm new password', { exact: true }).evaluate((element: HTMLInputElement) => element.validity.customError)).toBe(true)
  // Editing only the first field must release the stale mismatch error.
  await dialog.getByLabel('New password', { exact: true }).fill(replacement)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
  await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill('The administrator’s private unsent prompt')
  await signOut(page)
  await signIn(page, lin, replacement)
  expect(await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).inputValue()).toBe('')
  expect(await page.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Lin')
  expect(await page.getByRole('button', { name: 'Set sign-in password', exact: true }).count()).toBe(0)
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Lin')
  acknowledgeReloadConnectionLoss(console, warningStart)
  const port = Number(new URL(server.address).port)
  await server.ctx.fiber.dispose()
  const restarted = await central(root, port)
  const restartWarnings = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Lin')
  acknowledgeReloadConnectionLoss(console, restartWarnings)
  const other = await restarted.ctx.office.login({ memberId: lin, password: replacement })
  await page.getByRole('button', { name: 'Account and security', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Account and security', exact: true })
  const sessions = dialog.getByRole('region', { name: 'Signed-in sessions', exact: true })
  await expect.poll(() => sessions.getByRole('listitem').count()).toBe(2)
  await sessions.getByRole('listitem').filter({ hasNotText: 'Current session' }).getByRole('button', { name: 'Sign out this session', exact: true }).click()
  await expect.poll(() => sessions.getByRole('listitem').count()).toBe(1)
  expect(() => restarted.ctx.office.authenticate(other.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  await dialog.getByLabel('Current password', { exact: true }).fill(replacement)
  await dialog.getByLabel('New password', { exact: true }).fill(password)
  await dialog.getByLabel('Confirm new password', { exact: true }).fill(password)
  await dialog.getByRole('button', { name: 'Change password', exact: true }).click()
  await login.waitFor()
  await signIn(page, lin, password)
  const stored = await page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }))
  expect(stored.includes(password)).toBe(false)
  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await page.getByRole('button', { name: 'Account and security', exact: true }).click()
  await page.screenshot({ path: join(shots, 'account-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
  await page.screenshot({ path: join(shots, 'account-dark.png'), fullPage: true })
  await page.setViewportSize({ width: 600, height: 720 })
  await page.screenshot({ path: join(shots, 'account-small.png'), fullPage: true })
  await page.getByRole('dialog', { name: 'Account and security', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await nav.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('delivers work and private chats between two independently authenticated employee Hosts', async () => {
  const { server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  await server.ctx.office.setIdentityPassword(admin, chen, password)
  const first = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => first.close())
  const second = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => second.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const colleague = await newEnglishPage(browser, 900)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-multiuser'))
  await page.goto(first.authenticatedUrl, { waitUntil: 'load' })
  await colleague.goto(second.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, lin)
  await signIn(colleague, chen)
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Contacts', exact: true }).click()
  const person = page.locator(`[data-office-member="${chen}"]`)
  await person.getByRole('button', { name: 'Assign task', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Assign task', exact: true })
  await form.getByLabel('Title', { exact: true }).fill('Cross-Host assignment')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await expect.poll(() => colleague.getByRole('button').filter({ hasText: 'Cross-Host assignment' }).count(), { timeout: 15_000 }).toBe(1)
  await person.getByRole('button', { name: 'Message', exact: true }).click()
  const chat = page.getByRole('dialog', { name: 'Employee chat', exact: true })
  const prompt = 'Message; Enter to send, Shift+Enter for a new line'
  const editor = chat.getByRole('textbox', { name: prompt, exact: true })
  await editor.fill('From Lin’s own Host')
  await editor.press('Enter')
  await colleague.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Contacts', exact: true }).click()
  await colleague.locator(`[data-office-member="${lin}"]`).getByRole('button', { name: 'Message', exact: true }).click()
  const reply = colleague.getByRole('dialog', { name: 'Employee chat', exact: true })
  await reply.getByLabel('Chat history', { exact: true }).getByText('From Lin’s own Host', { exact: true }).waitFor()
  await reply.getByRole('textbox', { name: prompt, exact: true }).fill('Received by Chen’s own Host')
  await reply.getByRole('textbox', { name: prompt, exact: true }).press('Enter')
  await expect.poll(() => chat.getByLabel('Chat history', { exact: true }).getByText('Received by Chen’s own Host', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
  const employee = server.ctx.office.view(chen).me
  const disabled = await server.ctx.office.saveMember(admin, { ...employee, active: false }, employee)
  await colleague.bringToFront()
  await expect.poll(() => colleague.getByRole('region', { name: 'Sign in to your company', exact: true }).isVisible(), { timeout: 15_000 }).toBe(true)
  await server.ctx.office.saveMember(admin, { ...disabled, active: true }, disabled)
  await colleague.reload({ waitUntil: 'load' })
  await colleague.getByRole('region', { name: 'Sign in to your company', exact: true }).waitFor()
  await signIn(colleague, chen)
  await chat.getByRole('button', { name: 'Close', exact: true }).click()
  await signOut(page)
  await expect.poll(() => colleague.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Chen')
  expect(first.ctx.get('office')).toBeUndefined()
  expect(second.ctx.get('office')).toBeUndefined()
})

it('shares an administrator-imported catalog across independent employee Hosts and a central restart', async () => {
  const { root, server, overlay } = await setup()
  await server.ctx.office.setIdentityPassword(admin, lin, password)
  const first = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => first.close())
  const second = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => second.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const employee = await newEnglishPage(browser, 900)
  const console = watchConsole(employee)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-shared-catalog'))
  await page.goto(first.authenticatedUrl, { waitUntil: 'load' })
  await employee.goto(second.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, admin)
  await signIn(employee, lin)
  const nav = (target: Page) => target.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav(page).getByRole('button', { name: 'Integrations', exact: true }).click()
  await nav(employee).getByRole('button', { name: 'Integrations', exact: true }).click()
  expect(await employee.getByRole('button', { name: 'Import plugin manifest', exact: true }).count()).toBe(0)
  await page.getByRole('button', { name: 'Import plugin manifest', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Import plugin manifest', exact: true })
  await dialog.getByLabel('Manifest content', { exact: true }).fill(JSON.stringify({ name: 'central-crm', system: 'Company CRM', version: '2.0', provider: 'Company vendor', description: 'Shared customer catalog', capabilities: ['Query customers'] }))
  await dialog.getByRole('button', { name: 'Confirm registration', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const record = server.ctx.office.view(lin).integrations!.entries[0]!
  await employee.bringToFront()
  const card = employee.locator(`[data-office-integration="${record.id}"]`)
  await expect.poll(() => card.isVisible(), { timeout: 15_000 }).toBe(true)
  expect(first.ctx.get('office')).toBeUndefined()
  expect(second.ctx.get('office')).toBeUndefined()
  const port = Number(new URL(server.address).port)
  await server.ctx.fiber.dispose()
  const restarted = await central(root, port)
  expect(restarted.ctx.office.view(lin).integrations?.entries).toEqual([record])
  const warningStart = console.warnings.length
  await employee.reload({ waitUntil: 'load' })
  await expect.poll(() => employee.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Lin')
  await nav(employee).getByRole('button', { name: 'Integrations', exact: true }).click()
  await card.waitFor()
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  await employee.getByRole('dialog', { name: 'System details', exact: true }).getByText('Query customers', { exact: true }).waitFor()
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
