/** Actual submitted drive files pass native admission, approval, current ACL checks and durable tool results. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { chromium, webkit, type Page } from 'playwright'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createSystemMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { OfficeConversationId, OfficeDriveId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { acknowledgeReloadConnectionLoss, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents,
  watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, writeComposerDraft } from './support.ts'

const actor = 'local' as OfficeMemberId
const owner = 'owner' as OfficeMemberId
const marker = 'ACTUAL_SUBMITTED_FILE_BYTES_真实资料🙂'
const reply = 'OFFICE_FILE_TURN_FINISHED'
const provider = 'office-file-test'

class FileAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  operation?: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  beforeFirstRequest?: () => Promise<void>
  textResponse?: { prefix: string; suffix: string; between(): Promise<void>; closed(): void }
  constructor(private readonly fileId: string, private readonly admitted?: () => Promise<void>) { super() }
  override async listModels(name: string) { return [{ provider: name, id: 'files', name: 'Office file fixture' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.textResponse) {
      const response = this.textResponse
      try {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: response.prefix }
        await response.between()
        yield { type: 'text-delta', index: 0, text: response.suffix }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: response.prefix + response.suffix } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally { response.closed() }
      return
    }
    if (this.requests.length === 1) {
      await this.admitted?.()
      await this.beforeFirstRequest?.()
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('submitted-file-read'),
        name: this.operation?.name ?? 'office_read_file', arguments: JSON.stringify(this.operation?.arguments
          ?? { file_id: this.fileId, offset: 0, max_characters: 16384 }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(selected = true, approval: 'manual' | 'automatic' = 'manual', clearAfterAdmission = false,
  engine: 'chromium' | 'webkit' = 'chromium', reloadTool = true) {
  const scaffold = await launchWebScaffold({ profile: { packages: [] },
    extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const tool = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'tool-office')!
  if (reloadTool) {
    await scaffold.ctx.configEditor.edit(tool, current => ({ ...current, readApproval: approval }))
    await scaffold.ctx.loader.await()
    if (!tool.fiber) throw new Error('Office file tools did not activate')
    await tool.fiber.await()
    expect(tool.fiber.state).toBe(2)
  }
  const parent = await scaffold.ctx.office.createDriveFolder(owner, { space: 'shared', folderId: null, name: 'Submitted files' })
  const bytes = Buffer.from(marker)
  const file = await scaffold.ctx.office.uploadDriveFile(owner, { space: 'shared', folderId: parent.id,
    name: 'reviewed-company-file.txt', mediaType: 'text/plain', byteLength: bytes.length,
    dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await scaffold.ctx.office.driveFileInfo(actor, file.id)
  const browser = await (engine === 'webkit' ? webkit : chromium).launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  if (!current.sessionId) throw new Error('Expected a selected native file conversation')
  const conversationId = current.sessionId as OfficeConversationId
  if (selected) await scaffold.ctx.office.saveConversationFiles(actor, { conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const adapter = new FileAdapter(file.id, clearAfterAdmission ? async () => {
    await scaffold.ctx.office.saveConversationFiles(actor, { conversationId, revision: 1, requestId: randomUUID(), files: [] })
  } : undefined)
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'files' })
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Read the submitted company file and report its contents.')
  return { scaffold, tool, page, console, input, conversationId, adapter, file, info, parent }
}

function expectOfficeAuthorityStopped(events: readonly SessionEvent[]): void {
  const end = events.findLast(event => event.type === 'turn/end')
  expect(end?.data.reason.kind).toBe('error')
  if (end?.data.reason.kind !== 'error') throw new Error('Expected the Native office-authority refusal')
  expect(end.data.reason.error.message).toContain('Office account or authority changed.')
}

function legacyTurn(session: Session, message: UserMessage, turn = 1): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) session.append('system/message', { turn, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

const streamCases = [true, false].flatMap(selected => (['role', 'unload', 'stop'] as const).map(action => ({ selected, action })))
it.each(streamCases)('withholds revoked Native stream content (officeContext=$selected, action=$action)', async ({ selected, action }) => {
  const { scaffold, tool, page, input, conversationId, adapter, console } = await fixture(selected, 'automatic')
  const prefix = 'ALLOWED_BEFORE_IDENTITY_CHANGE'
  const suffix = 'PRIVATE_AFTER_IDENTITY_CHANGE'
  const nativeId = SessionId(conversationId)
  const closed = vi.fn()
  const publications: unknown[] = []
  scaffold.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent.id === nativeId) publications.push(frame)
  })
  adapter.textResponse = { prefix, suffix, closed, async between() {
    if (action === 'role') {
      const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
      await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
    } else if (action === 'unload') {
      if (!tool.fiber) throw new Error('Office stream plugin disappeared before unload')
      await tool.fiber.dispose()
    } else await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
  } }
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  expect(await settled).toBe(SessionId(conversationId))
  const events = await readPersistedEvents(scaffold, SessionId(conversationId))
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]?.signal?.aborted).toBe(action === 'stop')
  expect(closed).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(publications)).toContain(prefix)
  expect(JSON.stringify(events)).toContain(prefix)
  const visible = await page.locator('body').innerText()
  if (selected || action === 'stop') {
    expect(JSON.stringify(publications)).not.toContain(suffix)
    expect(JSON.stringify(events)).not.toContain(suffix)
    expect(visible).not.toContain(suffix)
    if (action === 'role') expectOfficeAuthorityStopped(events)
    else if (action === 'stop') expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
    else {
      const end = events.findLast(event => event.type === 'turn/end')
      expect(end?.data.reason.kind).toBe('error')
      if (end?.data.reason.kind !== 'error') throw new Error('Expected the withdrawn Office stream to fail')
      expect(end.data.reason.error.message).toContain('This operation was aborted')
    }
  } else {
    expect(JSON.stringify(publications)).toContain(suffix)
    expect(JSON.stringify(events)).toContain(suffix)
    expect(visible).toContain(suffix)
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  }
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

async function storedNative(scaffold: { readonly persistenceRoot: string }, id: SessionId) {
  for (const entry of await readdir(scaffold.persistenceRoot, { recursive: true })) {
    if (!/\.jsonl(?:\.zstd)?$/u.test(entry)) continue
    const path = join(scaffold.persistenceRoot, entry)
    const bytes = await readFile(path)
    const raw = entry.endsWith('.zstd') ? zstdDecompressSync(bytes) : bytes
    const header: unknown = JSON.parse(raw.subarray(0, raw.indexOf(10)).toString('utf8'))
    if (header !== null && typeof header === 'object' && 'id' in header && header.id === id) return { path, bytes, raw }
  }
  throw new Error('Native session did not reach its actual persistence file')
}

it.each([true, false])('checks native filesystem dispatch after an authority change (officeContext=%s)', async (selected) => {
  const { scaffold, page, input, conversationId, adapter, console } = await fixture(selected)
  const path = 'office-authority-guard.txt'
  adapter.operation = { name: 'write', arguments: { file_path: join(scaffold.workspaceCwd, path), content: 'A revoked office run must not write this file.' } }
  scaffold.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'write') {
      const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
      await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
    }
    return next()
  }, { prepend: true })
  await page.addLocatorHandler(page.locator('[data-approval-key]'), async (panel) => {
    await panel.getByRole('button', { name: 'Allow once', exact: true }).click()
  })
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  await settled
  const events = await readPersistedEvents(scaffold, SessionId(conversationId))
  const results = events.filter(event => event.type === 'tool/result')
  await writeFile(join(REPO_ROOT, `.artifacts/enterprise-office/round86-native-guard-${selected}-${randomUUID()}.json`), JSON.stringify(results, null, 2))
  if (selected) await expect(readFile(join(scaffold.workspaceCwd, path), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  else expect(await readFile(join(scaffold.workspaceCwd, path), 'utf8')).toBe(adapter.operation.arguments.content)
  expect(results).toHaveLength(1)
  expect(results[0]?.data.message.isError).toBe(selected)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('rechecks Native filesystem authority after the employee approves the waiting write', async () => {
  const { scaffold, page, input, conversationId, adapter, console } = await fixture()
  const path = join(scaffold.workspaceCwd, 'office-approved-guard.txt')
  adapter.operation = { name: 'write', arguments: { file_path: path, content: 'The approval does not replace office authority.' } }
  scaffold.ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    return exec.name === 'write' && decision.kind === 'allow'
      ? { kind: 'ask', reason: 'Confirm Native write for the authority test.' } : decision
  })
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor()
  const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
  await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
  await panel.getByRole('button', { name: 'Allow once', exact: true }).click()
  await settled
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  const events = await readPersistedEvents(scaffold, SessionId(conversationId))
  expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([true])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['role', 'unload'] as const)('withholds a real Native file body after %s during its result delivery', async (action) => {
  const { scaffold, tool, input, conversationId, adapter, console } = await fixture()
  const privateText = 'PRIVATE_NATIVE_BODY_MUST_NOT_BE_DISCLOSED'
  const path = join(scaffold.workspaceCwd, 'late-native-body.txt')
  await writeFile(path, privateText)
  adapter.operation = { name: 'read', arguments: { file_path: path } }
  const arrived = Promise.withResolvers<string>()
  const release = Promise.withResolvers<undefined>()
  scaffold.ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'read') { arrived.resolve(JSON.stringify(result)); await release.promise }
    return result
  })
  onTestFinished(() => { release.resolve(undefined) })
  const settled = scaffold.whenTurnSettled()
  try {
    await input.press('Enter')
    expect(await arrived.promise).toContain(privateText)
    if (action === 'role') {
      const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
      await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
    } else {
      if (!tool.fiber) throw new Error('Office plugin disappeared before unload')
      await tool.fiber.dispose()
    }
    release.resolve(undefined)
    await settled
    const events = await readPersistedEvents(scaffold, SessionId(conversationId))
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data.message.isError).toBe(true)
    expect(JSON.stringify(results)).not.toContain(privateText)
    expect(JSON.stringify(adapter.requests)).not.toContain(privateText)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally { release.resolve(undefined); await settled }
})

it.each([false, true])('inherits live office authority into a real child Agent (changed=%s)', async (changed) => {
  const { scaffold, input, conversationId, adapter, console } = await fixture(true, 'automatic')
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  await settled
  expect(adapter.requests).toHaveLength(2)
  const parent = scaffold.ctx.agents.get(SessionId(conversationId))
  if (!parent) throw new Error('Office parent Agent disappeared')
  const child = await scaffold.ctx.agents.create({ sessionId: SessionId(`office-owned-child-${randomUUID()}`),
    parentAgent: parent, meta: { cwd: scaffold.workspaceCwd }, agentOptions: { provider, model: 'files' },
    setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) })
  onTestFinished(() => child.dispose())
  if (changed) {
    const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
    await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
  }
  const childSettled = scaffold.whenTurnSettled()
  child.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Continue the delegated office work.' }], source: { kind: 'user' } }), 'next-turn', true)
  expect(await childSettled).toBe(child.agent.id)
  await child.agent.whenIdle()
  const childEvents = await readPersistedEvents(scaffold, child.agent.id)
  await writeFile(join(REPO_ROOT, `.artifacts/enterprise-office/round86-child-${changed}-${randomUUID()}.json`), JSON.stringify(childEvents, null, 2))
  expect(adapter.requests).toHaveLength(changed ? 2 : 3)
  if (changed) expectOfficeAuthorityStopped(childEvents)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each([true, false])('restores office identity restrictions after a tool plugin restart (selected=%s)', async (selected) => {
  const { scaffold, tool, input, conversationId, adapter, console } = await fixture(selected, 'automatic')
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  await settled
  expect(adapter.requests).toHaveLength(2)
  const agent = scaffold.ctx.agents.get(SessionId(conversationId))
  if (!agent || !tool.fiber) throw new Error('Native run or office plugin disappeared before restart')
  const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
  await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
  await tool.fiber.restart()
  const nextTurn = scaffold.whenTurnSettled()
  agent.send(createUserMessage({ content: [{ type: 'text', text: 'Continue without submitting another office context.' }],
    source: { kind: 'user' } }), 'next-turn', true)
  expect(await nextTurn).toBe(agent.id)
  expect(adapter.requests).toHaveLength(selected ? 2 : 3)
  if (selected) {
    const events = await readPersistedEvents(scaffold, agent.id)
    expectOfficeAuthorityStopped(events)
  }
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each([false, true])('restores office ownership from an actual cold Native session (changed=%s)', async (changed) => {
  const { scaffold, file, info, adapter, console } = await fixture(false, 'automatic')
  const id = SessionId(`office-cold-${randomUUID()}`)
  const conversationId = String(id) as OfficeConversationId
  const options = { agentOptions: { provider, model: 'files' },
    setup: (ctx: typeof scaffold.ctx) => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) }
  const owned = await scaffold.ctx.agents.create({ ...options, sessionId: id, meta: { cwd: scaffold.workspaceCwd } })
  onTestFinished(() => owned.dispose())
  const selection = await scaffold.ctx.office.saveConversationFiles(actor, { conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const capture = await scaffold.ctx.office.captureConversationFiles(actor,
    { conversationId, revision: selection.revision, requestId: randomUUID() })
  const settled = scaffold.whenTurnSettled()
  owned.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Read the submitted shared company file.' }],
    source: { kind: 'user', preparedContexts: [{ text: JSON.stringify(capture.selection.files),
      source: { kind: 'office-files', form: 'snapshot', sections: [], capture } }] } }), 'next-turn', true)
  expect(await settled).toBe(id)
  expect(adapter.requests).toHaveLength(2)
  await owned.dispose()
  expect(scaffold.ctx.agents.get(id)).toBeUndefined()
  const beforeEvents = await readPersistedEvents(scaffold, id)
  const stored = await storedNative(scaffold, id)
  if (changed) {
    const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
    await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
  }
  const resumed = await scaffold.ctx.agents.resume({ ...options, resumeSessionId: id })
  onTestFinished(() => resumed.dispose())
  const nextTurn = scaffold.whenTurnSettled()
  resumed.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Continue the restored Native conversation.' }],
    source: { kind: 'user' } }), 'next-turn', true)
  expect(await nextTurn).toBe(id)
  expect(adapter.requests).toHaveLength(changed ? 2 : 3)
  await resumed.dispose()
  const events = await readPersistedEvents(scaffold, id)
  expect(events.slice(0, beforeEvents.length)).toEqual(beforeEvents)
  if (changed) expectOfficeAuthorityStopped(events)
  const after = await readFile(stored.path)
  expect(after.subarray(0, stored.bytes.length)).toEqual(stored.bytes)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['missing-parent', 'missing-catalog', 'native-without-catalog'] as const)(
  'legacy evidence admission protects an uncatalogued child with %s', async (mode) => {
    const { scaffold, file, info, adapter, page, console } = await fixture(false, 'automatic')
    const parentId = SessionId(`unproven-parent-${randomUUID()}`)
    const childId = SessionId(`unproven-child-${randomUUID()}`)
    const parent = Session.create(parentId, [], { version: SESSION_FORMAT_VERSION, id: parentId, createdAt: Date.now(),
      cwd: scaffold.workspaceCwd, isSeeded: false })
    let source: UserMessage['source'] = { kind: 'user' }
    if (mode === 'missing-catalog') {
      const conversationId = String(parentId) as OfficeConversationId
      const selection = await scaffold.ctx.office.saveConversationFiles(actor, { conversationId, revision: 0, requestId: randomUUID(),
        files: [{ id: file.id, versionId: info.versionId }] })
      const capture = await scaffold.ctx.office.captureConversationFiles(actor,
        { conversationId, revision: selection.revision, requestId: randomUUID() })
      source = { kind: 'user', preparedContexts: [{ text: 'Original parent private context',
        source: { kind: 'office-files', form: 'snapshot', sections: [], capture } }] }
    }
    legacyTurn(parent, createUserMessage({ source, content: [{ type: 'text', text: 'Original parent task.' }] }))
    const child = Session.create(childId, [], { version: SESSION_FORMAT_VERSION, id: childId, createdAt: Date.now(),
      cwd: scaffold.workspaceCwd, parentSession: parentId, origin: 'subagent', delegationDepth: 1, isSeeded: false })
    legacyTurn(child, createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'UNPROVEN_CHILD_PRIVATE_HISTORY' }] }))
    for (const original of mode === 'missing-parent' ? [child] : [parent, child]) {
      const handle = await scaffold.ctx.sessionPersistence.create(original.header)
      try { await handle.append(original.snapshotEvents()) }
      finally { await handle.close() }
    }
    const childStored = await storedNative(scaffold, childId)
    const parentStored = mode === 'missing-parent' ? undefined : await storedNative(scaffold, parentId)
    const provenNative = mode === 'native-without-catalog'
    const candidates = [{ sessionId: childId }]
    const signal = new AbortController().signal
    expect(await scaffold.ctx.waterfall('api-session/visible', { candidates, signal }, () => Promise.resolve([childId])))
      .toEqual(provenNative ? [childId] : [])
    // Exercise a direct read as well as list filtering; no cold Agent is needed for either.
    const projections = scaffold.ctx.sessionController.projections({ sessionId: childId }, signal)
    if (provenNative) expect(await projections).toMatchObject({ kind: 'sequenced' })
    else await expect(projections).rejects.toMatchObject({ code: 'session/not-found' })
    expect(scaffold.ctx.agents.get(parentId)).toBeUndefined()
    expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
    expect(await readFile(childStored.path)).toEqual(childStored.bytes)
    const options = { resumeSessionId: childId, agentOptions: { provider, model: 'files' },
      setup: (ctx: typeof scaffold.ctx) => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) }
    const target = join(scaffold.workspaceCwd, 'unproven-child-write.txt')
    if (provenNative) {
      adapter.operation = { name: 'write', arguments: { file_path: target, content: 'PROVEN_NATIVE_CHILD\n' } }
      const owned = await scaffold.ctx.agents.resume(options)
      onTestFinished(() => owned.dispose())
      scaffold.ctx.permissionPresets.set(owned.agent.session, 'danger-full-access')
      const settled = scaffold.whenTurnSettled()
      owned.agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue my Native task.' }] }),
        'next-turn', true)
      expect(await settled).toBe(childId)
      expect(await readFile(target, 'utf8')).toBe('PROVEN_NATIVE_CHILD\n')
      expect(adapter.requests).toHaveLength(2)
      await owned.dispose()
    } else {
      await expect(scaffold.ctx.agents.resume(options)).rejects.toThrow('Restore the original parent Session')
      expect(adapter.requests).toEqual([])
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
      const events = await readPersistedEvents(scaffold, childId)
      expect(events.slice(0, child.snapshotEvents().length)).toEqual(child.snapshotEvents())
      expect(events.filter(event => event.type === 'office/run-inherited' || event.type === 'tool/call')).toEqual([])
    }
    const afterBytes = await readFile(childStored.path)
    expect(afterBytes.subarray(0, childStored.bytes.length)).toEqual(childStored.bytes)
    if (parentStored) expect(await readFile(parentStored.path)).toEqual(parentStored.bytes)
    expect(scaffold.ctx.agents.get(parentId)).toBeUndefined()
    expect(await page.content()).not.toContain('UNPROVEN_CHILD_PRIVATE_HISTORY')
    await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/office-legacy-child'), { recursive: true })
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/office-legacy-child/${mode}.expected.md`),
      JSON.stringify({ provenNative, modelRequests: adapter.requests.length, originalParentActivated: false,
        originalChildPrefixUnchanged: true, nativeWrite: provenNative ? await readFile(target, 'utf8') : null }, null, 2), webSnapshotMode())
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  },
)

it.each([false, true])('legacy catalog recovery keeps the original role without activating its cold parent (changed=%s)', async (changed) => {
  const { scaffold, file, info, adapter, console } = await fixture(false, 'automatic')
  const parentId = SessionId(`legacy-office-parent-${randomUUID()}`)
  const childId = SessionId(`legacy-office-child-${randomUUID()}`)
  const conversationId = String(parentId) as OfficeConversationId
  const options = { agentOptions: { provider, model: 'files' },
    setup: (ctx: typeof scaffold.ctx) => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) }
  const parent = await scaffold.ctx.agents.create({ ...options, sessionId: parentId, meta: { cwd: scaffold.workspaceCwd } })
  onTestFinished(() => parent.dispose())
  const selection = await scaffold.ctx.office.saveConversationFiles(actor, { conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const submitParent = async () => {
    const capture = await scaffold.ctx.office.captureConversationFiles(actor,
      { conversationId, revision: selection.revision, requestId: randomUUID() })
    const settled = scaffold.whenTurnSettled()
    parent.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Review the shared office file.' }],
      source: { kind: 'user', preparedContexts: [{ text: JSON.stringify(capture.selection.files),
        source: { kind: 'office-files', form: 'snapshot', sections: [], capture } }] } }), 'next-turn', true)
    expect(await settled).toBe(parentId)
  }
  await submitParent()
  const legacy = Session.create(childId, [], { version: SESSION_FORMAT_VERSION, id: childId, createdAt: Date.now(),
    cwd: scaffold.workspaceCwd, parentSession: parentId, origin: 'subagent', delegationDepth: 1, isSeeded: false })
  legacyTurn(legacy, createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Original delegated task before inheritance records existed.' }] }))
  const handle = await scaffold.ctx.sessionPersistence.create(legacy.header)
  try { await handle.append(legacy.snapshotEvents()) }
  finally { await handle.close() }
  parent.agent.session.append('subagent/catalog', { version: 0, childId, childCreatedAt: legacy.header.createdAt,
    mode: 'continuable', label: 'Legacy office child' })
  if (changed) {
    const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
    await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
    await submitParent()
  }
  await parent.dispose()
  expect(scaffold.ctx.agents.get(parentId)).toBeUndefined()
  expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
  const beforeEvents = await readPersistedEvents(scaffold, childId)
  expect(beforeEvents.filter(event => event.type === 'office/run-inherited')).toEqual([])
  const parentStored = await storedNative(scaffold, parentId)
  const childStored = await storedNative(scaffold, childId)
  const visible = () => scaffold.ctx.waterfall('api-session/visible',
    { candidates: [{ sessionId: childId }], signal: new AbortController().signal }, () => Promise.resolve([childId]))
  expect(await visible()).toEqual([childId])
  const controller = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'ui-office')
  if (!controller) throw new Error('Legacy child check requires the employee Host controller')
  const switchPrincipal = async (principalId: string) => {
    await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId }))
    await scaffold.ctx.loader.await()
    if (!controller.fiber) throw new Error('Employee Host controller did not restart')
    await controller.fiber.await()
  }
  await switchPrincipal('owner')
  expect(await visible()).toEqual([])
  expect(scaffold.ctx.agents.get(parentId)).toBeUndefined()
  expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
  expect(await readFile(parentStored.path)).toEqual(parentStored.bytes)
  expect(await readFile(childStored.path)).toEqual(childStored.bytes)
  await switchPrincipal('local')
  const requests = adapter.requests.length
  const resumed = await scaffold.ctx.agents.resume({ ...options, resumeSessionId: childId })
  onTestFinished(() => resumed.dispose())
  const turn = scaffold.whenTurnSettled()
  resumed.agent.send(createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Continue the original delegated task.' }] }), 'next-turn', true)
  expect(await turn).toBe(childId)
  expect(adapter.requests.length - requests).toBe(changed ? 0 : 1)
  await resumed.dispose()
  const after = await readPersistedEvents(scaffold, childId)
  expect(after.slice(0, beforeEvents.length)).toEqual(beforeEvents)
  const inherited = after.filter(event => event.type === 'office/run-inherited')
  expect(inherited).toHaveLength(1)
  expect(inherited[0]?.data).toMatchObject({ parentSession: parentId, owner: { memberId: actor, role: 'employee' } })
  if (changed) expectOfficeAuthorityStopped(after)
  const stored = await readFile(childStored.path)
  expect(stored.subarray(0, childStored.bytes.length)).toEqual(childStored.bytes)
  expect(await readFile(parentStored.path)).toEqual(parentStored.bytes)
  expect(scaffold.ctx.agents.get(parentId)).toBeUndefined()
  const summary = { originalRole: inherited[0]?.data.owner.role, modelRequests: adapter.requests.length - requests,
    stopReason: after.findLast(event => event.type === 'turn/end')?.data.reason.kind,
    parentStayedCold: scaffold.ctx.agents.get(parentId) === undefined, parentBytesUnchanged: true, childPrefixUnchanged: true }
  await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/office-legacy-child/${changed ? 'role-changed' : 'same-role'}.expected.md`),
    JSON.stringify(summary, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('legacy catalog recovery preserves original Native child execution after the parent later acquired office context', async () => {
  const { scaffold, file, info, adapter, console } = await fixture(false, 'automatic')
  const parentId = SessionId(`legacy-native-parent-${randomUUID()}`)
  const childId = SessionId(`legacy-native-child-${randomUUID()}`)
  const parent = Session.create(parentId, [], { version: SESSION_FORMAT_VERSION, id: parentId, createdAt: Date.now(),
    cwd: scaffold.workspaceCwd, isSeeded: false })
  legacyTurn(parent, createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Original Native parent.' }] }))
  const child = Session.create(childId, [], { version: SESSION_FORMAT_VERSION, id: childId, createdAt: Date.now(),
    cwd: scaffold.workspaceCwd, parentSession: parentId, origin: 'subagent', delegationDepth: 1, isSeeded: false })
  legacyTurn(child, createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Original unassociated Native task.' }] }))
  parent.append('subagent/catalog', { version: 0, childId, childCreatedAt: child.header.createdAt,
    mode: 'continuable', label: 'Original Native child' })
  const conversationId = String(parentId) as OfficeConversationId
  const selection = await scaffold.ctx.office.saveConversationFiles(actor, { conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const capture = await scaffold.ctx.office.captureConversationFiles(actor,
    { conversationId, revision: selection.revision, requestId: randomUUID() })
  legacyTurn(parent, createUserMessage({ source: { kind: 'user', preparedContexts: [{ text: 'Parent-only company context',
    source: { kind: 'office-files', form: 'snapshot', sections: [], capture } }] },
  content: [{ type: 'text', text: 'Later office association.' }] }), 2)
  for (const source of [parent, child]) {
    const handle = await scaffold.ctx.sessionPersistence.create(source.header)
    try { await handle.append(source.snapshotEvents()) }
    finally { await handle.close() }
  }
  const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
  await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
  const stored = await storedNative(scaffold, parentId)
  const target = join(scaffold.workspaceCwd, 'native-legacy-child.txt')
  const contents = 'NATIVE_CHILD_WRITE_PRESERVED\n'
  adapter.operation = { name: 'write', arguments: { file_path: target, content: contents } }
  const owned = await scaffold.ctx.agents.resume({ resumeSessionId: childId, agentOptions: { provider, model: 'files' },
    setup: (ctx: typeof scaffold.ctx) => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) })
  onTestFinished(() => owned.dispose())
  scaffold.ctx.permissionPresets.set(owned.agent.session, 'danger-full-access')
  const settled = scaffold.whenTurnSettled()
  owned.agent.send(createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Write the requested Native file.' }] }), 'next-turn', true)
  expect(await settled).toBe(childId)
  expect(await readFile(target, 'utf8')).toBe(contents)
  expect(adapter.requests).toHaveLength(2)
  expect(JSON.stringify(adapter.requests)).not.toContain('Parent-only company context')
  await owned.dispose()
  const events = await readPersistedEvents(scaffold, childId)
  expect(events.filter(event => event.type === 'office/run-inherited')).toEqual([])
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['write'])
  expect(await readFile(stored.path)).toEqual(stored.bytes)
  expect(scaffold.ctx.agents.get(parentId)).toBeUndefined()
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-legacy-child/native.expected.md'),
    JSON.stringify({ modelRequests: adapter.requests.length, nativeWrite: await readFile(target, 'utf8'),
      inheritedRecords: events.filter(event => event.type === 'office/run-inherited').length,
      parentStayedCold: true, parentBytesUnchanged: true }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each([false, true])('restores inherited office ownership without a live parent (changed=%s)', async (changed) => {
  const { scaffold, file, info, adapter, console } = await fixture(false, 'automatic')
  const parentId = SessionId(`office-parent-${randomUUID()}`)
  const childId = SessionId(`office-cold-child-${randomUUID()}`)
  const conversationId = String(parentId) as OfficeConversationId
  const options = { agentOptions: { provider, model: 'files' },
    setup: (ctx: typeof scaffold.ctx) => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) }
  const parent = await scaffold.ctx.agents.create({ ...options, sessionId: parentId, meta: { cwd: scaffold.workspaceCwd } })
  onTestFinished(() => parent.dispose())
  const selection = await scaffold.ctx.office.saveConversationFiles(actor, { conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const capture = await scaffold.ctx.office.captureConversationFiles(actor,
    { conversationId, revision: selection.revision, requestId: randomUUID() })
  const firstTurn = scaffold.whenTurnSettled()
  parent.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Read the reviewed shared company file.' }],
    source: { kind: 'user', preparedContexts: [{ text: JSON.stringify(capture.selection.files),
      source: { kind: 'office-files', form: 'snapshot', sections: [], capture } }] } }), 'next-turn', true)
  expect(await firstTurn).toBe(parentId)
  expect(adapter.requests).toHaveLength(2)
  const child = await scaffold.ctx.agents.create({ ...options, sessionId: childId, parentAgent: parent.agent,
    meta: { cwd: scaffold.workspaceCwd, parentSession: parentId, origin: 'subagent', delegationDepth: 1 } })
  onTestFinished(() => child.dispose())
  const childTurn = scaffold.whenTurnSettled()
  child.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Continue the delegated work.' }],
    source: { kind: 'user' } }), 'next-turn', true)
  expect(await childTurn).toBe(childId)
  expect(adapter.requests).toHaveLength(3)
  await child.dispose()
  await parent.dispose()
  expect(scaffold.ctx.agents.get(parentId)).toBeUndefined()
  expect(scaffold.ctx.agents.get(childId)).toBeUndefined()
  const beforeEvents = await readPersistedEvents(scaffold, childId)
  const submitted = beforeEvents.filter(event => event.type === 'user/message')
  expect(submitted.some(event => event.data.source.kind === 'user'
    && event.data.content.some(block => block.type === 'text' && block.text === 'Continue the delegated work.'))).toBe(true)
  expect(submitted.flatMap(event => event.data.source.kind === 'user' && 'preparedContexts' in event.data.source
    ? event.data.source.preparedContexts ?? [] : [])
    .filter(context => context.source.kind === 'office' || context.source.kind === 'office-files')).toEqual([])
  const inherited = beforeEvents.filter(event => event.type === 'office/run-inherited')
  expect(inherited).toHaveLength(1)
  expect(inherited[0]?.data).toEqual({ parentSession: parentId, owner: { memberId: actor, role: 'employee' }, mixed: false, invalid: false })
  expect(inherited[0]?.ignorable).toBeUndefined()
  expect(inherited[0]?.surfaceOp).toBeUndefined()
  const stored = await storedNative(scaffold, childId)
  const evidence = join(REPO_ROOT, `.artifacts/enterprise-office/round88-child-${changed}-${randomUUID()}.jsonl`)
  await writeFile(evidence, stored.raw)
  if (changed) {
    const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
    await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
  }
  const resumed = await scaffold.ctx.agents.resume({ ...options, resumeSessionId: childId })
  onTestFinished(() => resumed.dispose())
  const resumedTurn = scaffold.whenTurnSettled()
  resumed.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Continue without a parent process.' }],
    source: { kind: 'user' } }), 'next-turn', true)
  expect(await resumedTurn).toBe(childId)
  expect(adapter.requests).toHaveLength(changed ? 3 : 4)
  await resumed.dispose()
  const events = await readPersistedEvents(scaffold, childId)
  expect(events.slice(0, beforeEvents.length)).toEqual(beforeEvents)
  expect(events.filter(event => event.type === 'office/run-inherited')).toEqual(inherited)
  if (changed) expectOfficeAuthorityStopped(events)
  const after = await readFile(stored.path)
  expect(after.subarray(0, stored.bytes.length)).toEqual(stored.bytes)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('does not adopt a future queued role after reload and still runs its later explicit review', async () => {
  const { scaffold, tool, input, conversationId, adapter, console } = await fixture(true, 'automatic')
  const path = join(scaffold.workspaceCwd, 'queued-office-authority.txt')
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  adapter.operation = { name: 'write', arguments: { file_path: path, content: 'Future review must not authorize earlier work.' } }
  scaffold.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'write') { started.resolve(undefined); await release.promise }
    return next()
  }, { prepend: true })
  onTestFinished(() => { release.resolve(undefined) })
  const firstTurn = scaffold.whenTurnSettled()
  try {
    await input.press('Enter')
    await started.promise
    const agent = scaffold.ctx.agents.get(SessionId(conversationId))
    if (!agent || !tool.fiber) throw new Error('Native queued office run disappeared')
    const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
    await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
    const capture = await scaffold.ctx.office.captureConversationFiles(actor,
      { conversationId, revision: 1, requestId: randomUUID() })
    expect(capture.role).toBe('manager')
    const queued = createUserMessage({ content: [{ type: 'text', text: 'Explicitly reviewed work in the updated employee role.' }],
      source: { kind: 'user', preparedContexts: [{ text: JSON.stringify(capture.selection.files),
        source: { kind: 'office-files', form: 'snapshot', sections: [], capture } }] } })
    const committed = Promise.withResolvers<undefined>()
    const stop = scaffold.ctx.on('session/event', (session, event) => {
      if (session.id === agent.id && event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === queued.id)) committed.resolve(undefined)
    })
    onTestFinished(() => { stop() })
    agent.send(queued, 'next-turn', true)
    await committed.promise
    stop()
    await tool.fiber.restart()
    release.resolve(undefined)
    expect(await firstTurn).toBe(agent.id)
    await agent.whenIdle()
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const observed = await readPersistedEvents(scaffold, agent.id)
    await writeFile(join(REPO_ROOT, `.artifacts/enterprise-office/round87-queue-${randomUUID()}.json`),
      JSON.stringify({ events: observed, requests: adapter.requests.length,
        pending: agent.inbox.nextTurn.map(message => message.id) }, null, 2))
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([queued.id])
    const continued = scaffold.whenTurnSettled()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the queued reviewed work.' }], source: { kind: 'user' } }))
    expect(await continued).toBe(agent.id)
    expect(adapter.requests).toHaveLength(2)
    const events = await readPersistedEvents(scaffold, agent.id)
    const ends = events.filter(event => event.type === 'turn/end')
    expect(ends.map(event => event.data.reason.kind)).toEqual(['error', 'completed'])
    const previous = ends[0]
    if (previous?.data.reason.kind !== 'error') throw new Error('The earlier role was not refused')
    expect(previous.data.reason.error.message).toContain('Office account or authority changed.')
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally { release.resolve(undefined); await firstTurn }
})

async function chooseDriveFile(page: Page, parent: OfficeDriveId, file: OfficeDriveId, menu = false): Promise<void> {
  const drive = page.getByRole('region', { name: 'Drive', exact: true })
  await drive.getByRole('button', { name: 'Shared drive', exact: true }).first().click()
  await drive.locator(`[data-drive-entry="${parent}"]`).dblclick()
  const row = drive.locator(`[data-drive-entry="${file}"]`)
  await row.click({ button: menu ? 'right' : 'left' })
  if (menu) await page.getByRole('menuitem', { name: 'Use in AI chat', exact: true }).click()
  else await drive.getByRole('button', { name: 'Use in AI chat', exact: true }).click()
}

it('reads submitted files with the default manual policy without reloading the office tool plugin', async () => {
  const { scaffold, page, console, input, adapter, file } = await fixture(true, 'manual', false, 'chromium', false)
  await input.press('Enter')
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor({ timeout: 20000 })
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_file')
  expect(await panel.innerText()).toContain(file.name)
  const settled = scaffold.whenTurnSettled()
  await panel.getByRole('button', { name: 'Allow once', exact: true }).click()
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor()
  expect(JSON.stringify((await readPersistedEvents(scaffold, id)).filter(event => event.type === 'tool/result'))).toContain(marker)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['chromium', 'webkit'] as const)('%s prepares an unsent native input directly from Drive before any office conversation is selected', async (engine) => {
  const scaffold = await launchWebScaffold({ profile: { packages: [] },
    extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.workspaceController.create({ path: scaffold.workspaceCwd })
  const bytes = Buffer.from('COLD_DRIVE_REFERENCE')
  const file = await scaffold.ctx.office.uploadDriveFile(actor, { space: 'private', folderId: null, name: 'cold-reference.txt',
    mediaType: 'text/plain', byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const browser = await (engine === 'webkit' ? webkit : chromium).launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('heading', { name: 'Workbench', exact: true }).waitFor()
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Drive', exact: true }).click()
  const drive = page.getByRole('region', { name: 'Drive', exact: true })
  await drive.locator(`[data-drive-entry="${file.id}"]`).click()
  const writes = vi.spyOn(scaffold.ctx.office, 'saveConversationFiles')
  onTestFinished(() => { writes.mockRestore() })
  await drive.getByRole('button', { name: 'Use in AI chat', exact: true }).click()
  await page.getByRole('region', { name: 'Conversation files', exact: true }).getByText(file.name, { exact: true }).waitFor()
    .catch(async (error: unknown) => {
      const evidence = join(REPO_ROOT, '.artifacts', 'enterprise-office')
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `cold-file-${engine}.aria.md`), await page.locator('body').ariaSnapshot())
      await writeFile(join(evidence, `cold-file-${engine}.json`), JSON.stringify({ writes: writes.mock.calls,
        outcomes: writes.mock.settledResults, current: await page.evaluate(() => localStorage.getItem('dsh.sessions.current')),
        agents: scaffold.ctx.agents.list().map(agent => ({ id: agent.id, status: agent.status })),
        pageErrors: console.pageErrors, warnings: console.warnings }, null, 2))
      throw error
    })
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  expect(await input.textContent()).toBe('')
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  if (!current.sessionId) throw new Error('Drive preparation did not open its native input')
  const selection = await scaffold.ctx.office.conversationFiles(actor, current.sessionId as OfficeConversationId)
  expect(selection.files.map(row => row.id)).toEqual([file.id])
  expect((await readPersistedEvents(scaffold, SessionId(current.sessionId))).some(event => event.type === 'user/message')).toBe(false)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['chromium', 'webkit'] as const)('%s links real drive files through the UI, preserves native drafts and reads the reviewed file', async (engine) => {
  const { scaffold, page, console, input, conversationId, adapter, file, parent } = await fixture(false, 'automatic', false, engine)
  const draft = await input.textContent()
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: 'native-kept.txt',
    mimeType: 'text/plain', buffer: Buffer.from('EXISTING_NATIVE_ATTACHMENT') })
  await page.getByText('native-kept.txt', { exact: true }).first().waitFor()
  const files = page.getByRole('region', { name: 'Conversation files', exact: true })
  await expect.poll(() => files.getByRole('button', { name: 'Link files', exact: true }).isEnabled()).toBe(true)
  const emptyEvidence = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(emptyEvidence, { recursive: true })
  await writeFile(join(emptyEvidence, `empty-files-${engine}.aria.md`), await files.ariaSnapshot() + '\n')
  await files.getByRole('button', { name: 'Link files', exact: true }).click()
  await chooseDriveFile(page, parent.id, file.id)
  await files.getByText(file.name, { exact: true }).waitFor()
  expect(await input.textContent()).toBe(draft)
  expect(await page.getByText('native-kept.txt', { exact: true }).count()).toBeGreaterThan(0)
  expect(adapter.requests).toEqual([])
  expect((await readPersistedEvents(scaffold, SessionId(conversationId))).some(event => event.type === 'user/message')).toBe(false)
  const extra = Buffer.from('SECOND_REVIEWED_FILE')
  const second = await scaffold.ctx.office.uploadDriveFile(owner, { space: 'shared', folderId: parent.id, name: 'another-context.txt',
    mediaType: 'text/plain', byteLength: extra.length, dataBase64: extra.toString('base64'), requestId: randomUUID() })
  await files.getByRole('button', { name: 'Link files', exact: true }).click()
  await chooseDriveFile(page, parent.id, second.id, true)
  await files.getByText(second.name, { exact: true }).waitFor()
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
  const home = page.getByRole('heading', { name: 'AI chat', exact: true }).locator('xpath=../..')
  await home.getByRole('region', { name: 'Conversation files', exact: true }).getByText(file.name, { exact: true }).waitFor()
  expect(await home.locator('[data-composer-input]').textContent()).toBe(draft)
  await files.getByRole('button', { name: `Remove file "${second.name}"`, exact: true }).click()
  await expect.poll(async () => (await scaffold.ctx.office.conversationFiles(actor, conversationId)).files.map(row => row.id))
    .toEqual([file.id])
  await files.getByRole('button', { name: 'Clear files', exact: true }).click()
  await expect.poll(async () => (await scaffold.ctx.office.conversationFiles(actor, conversationId)).files).toEqual([])
  await files.getByRole('button', { name: 'Link files', exact: true }).click()
  await chooseDriveFile(page, parent.id, file.id)
  expect(await input.textContent()).toBe(draft)
  expect(await page.getByText('native-kept.txt', { exact: true }).count()).toBeGreaterThan(0)
  const evidence = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(evidence, { recursive: true })
  await files.screenshot({ path: join(evidence, `conversation-files-${engine}.png`) })
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor()
  const events = await readPersistedEvents(scaffold, id)
  expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
  expect(JSON.stringify(events)).toContain('native-kept.txt')
  expect(JSON.stringify(events.filter(event => event.type === 'tool/result'))).toContain(marker)
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain(marker)
  const warnings = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await files.getByText(file.name, { exact: true }).waitFor()
  expect(await readPersistedEvents(scaffold, id)).toEqual(events)
  acknowledgeReloadConnectionLoss(console, warnings)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('retries the exact reviewed file selection after an unknown UI acknowledgement', async () => {
  const { scaffold, page, console, conversationId, file, parent, input } = await fixture(false, 'automatic')
  const files = page.getByRole('region', { name: 'Conversation files', exact: true })
  await files.getByRole('button', { name: 'Link files', exact: true }).click()
  const original = scaffold.ctx.office.saveConversationFiles.bind(scaffold.ctx.office)
  const originalRead = scaffold.ctx.office.conversationFiles.bind(scaffold.ctx.office)
  const release = Promise.withResolvers<undefined>()
  let committed = false
  const saved = vi.spyOn(scaffold.ctx.office, 'saveConversationFiles').mockImplementationOnce(async (member, input) => {
    await original(member, input)
    committed = true
    throw new Error('Expected lost file acknowledgement')
  })
  const reading = vi.spyOn(scaffold.ctx.office, 'conversationFiles').mockImplementation(async (member, target) => {
    const value = await originalRead(member, target)
    if (committed && saved.mock.calls.length === 1) await release.promise
    return value
  })
  try {
    await chooseDriveFile(page, parent.id, file.id)
    const drive = page.getByRole('region', { name: 'Drive', exact: true })
    await drive.getByText('File save is not confirmed. Retry the original request or refresh to check.', { exact: true }).waitFor()
    await drive.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => saved.mock.calls.length).toBe(2)
    expect(saved.mock.calls[1]?.[1]).toEqual(saved.mock.calls[0]?.[1])
    release.resolve(undefined)
    await expect.poll(async () => (await originalRead(actor, conversationId)).revision).toBe(1)
    await drive.getByRole('button', { name: 'Return to conversation', exact: true }).click()
    await files.getByText(file.name, { exact: true }).waitFor()
    expect(await input.textContent()).toBe('Read the submitted company file and report its contents.')
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally { release.resolve(undefined); saved.mockRestore(); reading.mockRestore() }
})

it('keeps the current page and native draft when a pending file preparation loses its role', async () => {
  const { scaffold, page, console, conversationId, file, parent } = await fixture(false, 'automatic')
  const files = page.getByRole('region', { name: 'Conversation files', exact: true })
  await files.getByRole('button', { name: 'Link files', exact: true }).click()
  const original = scaffold.ctx.office.saveConversationFiles.bind(scaffold.ctx.office)
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const held = vi.spyOn(scaffold.ctx.office, 'saveConversationFiles').mockImplementationOnce(async (member, input) => {
    started.resolve(undefined)
    await release.promise
    return original(member, input)
  })
  try {
    await chooseDriveFile(page, parent.id, file.id)
    await started.promise
    const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
    await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
    await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent(), { timeout: 15000 }).toContain('Manager')
    release.resolve(undefined)
    await expect.poll(() => held.mock.settledResults[0]?.type).toBe('fulfilled')
    expect(await page.getByRole('region', { name: 'Drive', exact: true }).count()).toBe(1)
    expect((await readPersistedEvents(scaffold, SessionId(conversationId))).some(event => event.type === 'user/message')).toBe(false)
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'AI chat', exact: true }).click()
    expect(await page.locator('[data-composer-input][contenteditable="true"]').first().textContent())
      .toBe('Read the submitted company file and report its contents.')
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally { release.resolve(undefined); held.mockRestore() }
})

it.each([true, false])('reads only a submitted version and preserves its frozen context after later selection edits: %s', async (selected) => {
  const { scaffold, page, console, input, conversationId, adapter, file, info } = await fixture(selected, 'automatic', selected)
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor()
  expect(adapter.requests).toHaveLength(2)
  const names = adapter.requests[0]?.tools?.map(row => row.name) ?? []
  expect(names.includes('office_read_file')).toBe(selected)
  expect(names).toContain('write')
  const events = await readPersistedEvents(scaffold, id)
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(1)
  expect(results[0]?.data.message.isError).toBe(!selected)
  const users = events.filter(event => event.type === 'user/message')
  expect(JSON.stringify(users)).not.toContain(marker)
  if (selected) {
    expect(JSON.stringify(users)).toContain('office-files')
    expect(JSON.stringify(users)).toContain(info.versionId)
    expect(JSON.stringify(users)).toContain(info.sha256)
    expect(JSON.stringify(results)).toContain(marker)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain(marker)
    expect(JSON.stringify(results)).toContain(file.id)
    expect((await scaffold.ctx.office.conversationFiles(actor, conversationId)).files).toEqual([])
    const evidence = join(REPO_ROOT, '.artifacts', 'enterprise-office')
    await mkdir(evidence, { recursive: true })
    let exported = 0
    for (const path of await readdir(scaffold.persistenceRoot, { recursive: true })) {
      if (!/\.jsonl(?:\.zstd)?$/u.test(path)) continue
      const stored = await readFile(join(scaffold.persistenceRoot, path))
      const raw = path.endsWith('.zstd') ? zstdDecompressSync(stored) : stored
      if (!raw.includes(Buffer.from('"office-files"'))) continue
      await writeFile(join(evidence, 'submitted-file-session.jsonl'), raw)
      if (path.endsWith('.zstd')) await writeFile(join(evidence, 'submitted-file-session.jsonl.zstd'), stored)
      exported++
    }
    expect(exported).toBe(1)
    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    await page.getByText(reply, { exact: true }).waitFor()
    acknowledgeReloadConnectionLoss(console, warningStart)
    expect(await readPersistedEvents(scaffold, id)).toEqual(events)
    expect(adapter.requests).toHaveLength(2)
  } else expect(JSON.stringify(events)).not.toContain(marker)
  const agent = scaffold.ctx.agents.get(SessionId(conversationId))
  if (!agent) throw new Error('Original file Agent disappeared')
  expect(scaffold.ctx.tools.get('office_read_file', agent)).toBeUndefined()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['allow', 'reject', 'revoke', 'role', 'unload'] as const)('uses native file approval and current authority: %s', async (action) => {
  const { scaffold, tool, page, console, input, conversationId, adapter, file, info, parent } = await fixture()
  await input.press('Enter')
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor()
  const text = await panel.innerText()
  expect(text).toContain('Read submitted company file')
  expect(text).toContain(`File: "${file.name}"\nFile id: "${file.id}"\nVersion: "${info.versionId}"\nSHA-256: ${info.sha256}`)
  expect(text).toContain('Offset: 0\nCharacter budget: 16384\nEmployee: "local"')
  if (action === 'allow') {
    const other = await scaffold.ctx.agents.create({ sessionId: SessionId(`file-other-${randomUUID()}`),
      meta: { cwd: scaffold.workspaceCwd }, setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) })
    onTestFinished(() => other.dispose())
    expect(scaffold.ctx.tools.get('office_read_file', other.agent)).toBeUndefined()
    expect(scaffold.ctx.tools.get('write', other.agent)).toBeDefined()
  }
  if (action === 'revoke') await scaffold.ctx.office.saveDrivePermissions(owner, { id: parent.id, revision: parent.revision,
    defaultAccess: 'deny', grants: [] })
  if (action === 'role') {
    const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
    await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
  }
  if (action === 'unload') {
    if (!tool.fiber) throw new Error('File tool plugin disappeared')
    await tool.fiber.dispose()
  }
  const settled = scaffold.whenTurnSettled()
  await panel.getByRole('button', { name: action === 'reject' ? 'Reject' : 'Allow once', exact: true }).click()
  const id = await settled
  if (action === 'role') expect(adapter.requests).toHaveLength(1)
  else {
    await page.getByText(reply, { exact: true }).waitFor()
    expect(adapter.requests).toHaveLength(2)
  }
  const events = await readPersistedEvents(scaffold, id)
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(1)
  expect(results[0]?.data.message.isError).toBe(action !== 'allow')
  expect(JSON.stringify(results).includes(marker)).toBe(action === 'allow')
  expect(JSON.stringify(adapter.requests[1]?.messages ?? []).includes(marker)).toBe(action === 'allow')
  const agent = scaffold.ctx.agents.get(SessionId(conversationId))
  if (!agent) throw new Error('File approval Agent disappeared')
  expect(scaffold.ctx.tools.get('office_read_file', agent)).toBeUndefined()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('withholds a real late file body after stopping its native read', async () => {
  const { scaffold, page, console, input, conversationId, adapter } = await fixture(true, 'automatic')
  const original = scaffold.ctx.office.readConversationFile.bind(scaffold.ctx.office)
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const held = vi.spyOn(scaffold.ctx.office, 'readConversationFile').mockImplementationOnce(async (member, request) => {
    const body = await original(member, request)
    started.resolve(undefined)
    await release.promise
    return body
  })
  try {
    const settled = scaffold.whenTurnSettled()
    await input.press('Enter')
    await started.promise
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    release.resolve(undefined)
    const id = await settled
    const events = await readPersistedEvents(scaffold, id)
    expect(JSON.stringify(events)).not.toContain(marker)
    expect(adapter.requests).toHaveLength(1)
    const agent = scaffold.ctx.agents.get(SessionId(conversationId))
    if (!agent) throw new Error('Stopped file Agent disappeared')
    expect(scaffold.ctx.tools.get('office_read_file', agent)).toBeUndefined()
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally { release.resolve(undefined); held.mockRestore() }
})
