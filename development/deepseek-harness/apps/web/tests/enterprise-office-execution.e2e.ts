/** Keyless model replies drive the real native tool, office authority, durable business commit and work page. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { OfficeConversationCaptureId, OfficeConversationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, connectFreshWorkspaceZh, newEnglishPage, REPO_ROOT, writeComposerDraft } from './support.ts'

const title = 'NATIVE_OFFICE_INTERNAL_WORK'
const reply = 'OFFICE_WORK_CALL_FINISHED'
const actor = 'local' as OfficeMemberId
const defaultWork = { kind: 'todo', title, date: '2026-10-17' }
const script = (work: unknown): ReplayOverrideDoc => [
  { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-actual-call'), name: 'office_create_work',
      arguments: JSON.stringify(work) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] },
  { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: reply },
    { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] },
]

async function fixture(
  selected: boolean, approval: 'automatic' | 'manual' = 'automatic', work: unknown = defaultWork, locale: 'en' | 'zh' = 'en',
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-execution-'))
  onTestFinished(async () => {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-execution-')) {
      throw new Error('Unexpected office execution fixture directory')
    }
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const override = join(root, 'replay.json')
  const overlay = join(root, 'office.patch.yml')
  await writeFile(override, JSON.stringify(script(work)))
  await writeFile(overlay, await readFile(join(REPO_ROOT, 'enterprise-workbench.patch.yml'), 'utf8')
    + `\n- id: tool-office\n  config:\n    approval: ${approval}\n`)
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay,
    replayFixture: join(root, 'override-only.jsonl'), replayOverride: override })
  onTestFinished(() => scaffold.close())
  const officeTool = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'tool-office')
  if (!officeTool?.fiber) throw new Error('Native office-tool plugin did not load')
  await officeTool.fiber.await()
  expect(officeTool.fiber.state).toBe(2)
  const requests: GenerateOptions[] = []
  const inputs: boolean[] = []
  const stopInputs = scaffold.ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind !== 'reject') inputs.push(Boolean(scaffold.ctx.tools.get('office_create_work', agent)))
    return decision
  }, { prepend: true })
  onTestFinished(() => { stopInputs() })
  const stop = scaffold.ctx.on('llm/stream', (request, next) => { requests.push(request); return next() }, { prepend: true })
  onTestFinished(() => { stop() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = locale === 'en' ? await newEnglishPage(browser)
    : await browser.newPage({ viewport: { width: 900, height: 640 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: locale === 'en' ? 'Native workspace' : '原生工作区', exact: true }).click()
  if (locale === 'en') await connectFreshWorkspace(page, scaffold.workspaceCwd)
  else await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  if (!current.sessionId) throw new Error('Native conversation was not selected')
  if (selected) await scaffold.ctx.office.saveConversationLinks(actor, { conversationId: current.sessionId as OfficeConversationId,
    revision: 0, requestId: randomUUID(), kind: 'tools', tools: [{ kind: 'template', name: 'reminder' }] })
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Create internal office work and show its details for my review.')
  return { scaffold, page, requests, console, input, inputs, officeTool: officeTool.fiber,
    conversationId: current.sessionId as OfficeConversationId }
}

it.each([true, false])('offers and executes the office work tool only for a submitted selected reminder: %s', async (selected) => {
  const { scaffold, page, requests, console, input, inputs } = await fixture(selected)
  const before = scaffold.ctx.office.view(actor).items.length
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor({ timeout: 20_000 })
  expect(requests).toHaveLength(2)
  const names = requests[0]?.tools?.map(tool => tool.name) ?? []
  expect(names.includes('office_create_work')).toBe(selected)
  expect(inputs).toEqual([selected, selected])
  expect(names).toContain('write')
  const saved = await readPersistedEvents(scaffold, id)
  const result = saved.find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Native tool result was not recorded')
  expect(result.data.message.isError).toBe(!selected)
  expect(scaffold.ctx.office.view(actor).items).toHaveLength(before + (selected ? 1 : 0))
  if (selected) {
    const item = scaffold.ctx.office.view(actor).items.find(row => row.title === title)
    if (!item) throw new Error('Native tool did not create its actual office item')
    expect(item).toMatchObject({ creatorId: actor, ownerId: actor, kind: 'todo', status: 'pending' })
    expect(JSON.stringify(result.data)).toContain(item.id)
    const text = result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    const receipt = JSON.parse(text) as { request_id: string; capture_id: OfficeConversationCaptureId }
    const retry = await scaffold.ctx.officeController.createWorkFromConversation({ requestId: receipt.request_id,
      captureId: receipt.capture_id, work: { kind: 'todo', title, date: '2026-10-17', ownerId: actor } })
    expect(retry).toMatchObject({ ok: true, value: { item: { id: item.id } } })
    expect(scaffold.ctx.office.view(actor).items).toHaveLength(before + 1)
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Work', exact: true }).click()
    const row = page.locator(`[data-office-item="${item.id}"]`)
    await row.waitFor().catch(async (error: unknown) => {
      const evidence = join(REPO_ROOT, '.artifacts/enterprise-office')
      await mkdir(evidence, { recursive: true })
      const prefix = `round90-work-view-${randomUUID()}`
      await writeFile(join(evidence, `${prefix}.aria.md`), await page.locator('body').ariaSnapshot())
      await writeFile(join(evidence, `${prefix}.json`), JSON.stringify({ item,
        view: scaffold.ctx.office.view(actor), urlPath: new URL(page.url()).pathname,
        navigation: await page.getByRole('navigation', { name: 'Workbench', exact: true }).innerText() }, null, 2))
      throw error
    })
    expect(await row.textContent()).toContain(title)
    const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: join(shots, 'native-work-created.png'), fullPage: true })
    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    // The employee shell starts on Home; verify the persisted item in its Work page.
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Work', exact: true }).click()
    await page.locator(`[data-office-item="${item.id}"]`).waitFor().catch(async (error: unknown) => {
      const evidence = join(REPO_ROOT, '.artifacts/enterprise-office')
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `round90-work-reloaded-${randomUUID()}.aria.md`), await page.locator('body').ariaSnapshot())
      throw error
    })
    acknowledgeReloadConnectionLoss(console, warningStart)
    expect(await readPersistedEvents(scaffold, id)).toEqual(saved)
    expect(scaffold.ctx.office.view(actor).items).toHaveLength(before + 1)
    expect(requests).toHaveLength(2)
  }
  const agent = scaffold.ctx.agents.get(id)
  if (!agent) throw new Error('Native Agent disappeared after tool execution')
  expect(scaffold.ctx.tools.get('office_create_work', agent)).toBeUndefined()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['allow', 'reject', 'revoke', 'unload'] as const)('uses native approval and rechecks office authority: %s', async (action) => {
  const { scaffold, page, requests, console, input, conversationId, officeTool } = await fixture(true, 'manual')
  const before = scaffold.ctx.office.view(actor).items.length
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor({ timeout: 20_000 })
  expect(scaffold.ctx.office.view(actor).items).toHaveLength(before)
  expect(requests[0]?.tools?.some(tool => tool.name === 'office_create_work')).toBe(true)
  const text = await panel.innerText()
  expect(text).toContain('Create internal office to-do')
  expect(text).toContain(`Title: ${JSON.stringify(title)}`)
  expect(text).toContain('Date: "2026-10-17"\nTime: Not specified\nOwner: "local" (submitting employee)\nDescription: ""')
  if (action === 'allow') {
    const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
    await mkdir(shots, { recursive: true })
    await panel.screenshot({ path: join(shots, 'native-work-approval.png') })
    const other = await scaffold.ctx.agents.create({ sessionId: SessionId(`office-other-${randomUUID()}`),
      meta: { cwd: scaffold.workspaceCwd },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined) })
    onTestFinished(() => other.dispose())
    expect(scaffold.ctx.tools.get('office_create_work', other.agent)).toBeUndefined()
    expect(scaffold.ctx.tools.get('write', other.agent)).toBeDefined()
    const callingAgent = scaffold.ctx.agents.get(SessionId(conversationId))
    if (!callingAgent) throw new Error('Calling Agent disappeared while awaiting approval')
    expect(scaffold.ctx.tools.get('office_create_work', callingAgent)).toBeDefined()
  }
  if (action === 'revoke') {
    const choices = (await scaffold.ctx.office.conversationLinks(actor, conversationId)).selection
    await scaffold.ctx.office.saveConversationLinks(actor, { conversationId, revision: choices.revision,
      requestId: randomUUID(), kind: 'tools', tools: [] })
  }
  if (action === 'unload') await officeTool.dispose()
  await panel.getByRole('button', { name: action === 'reject' ? 'Reject' : 'Allow once', exact: true }).click()
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor()
  const events = await readPersistedEvents(scaffold, id)
  const result = events.find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Approved native invocation did not record a tool result')
  expect(result.data.message.isError).toBe(action !== 'allow')
  if (action === 'revoke') expect(result.data.error?.code).toBe('OFFICE_WORK_DENIED')
  expect(scaffold.ctx.office.view(actor).items).toHaveLength(before + (action === 'allow' ? 1 : 0))
  expect(events.filter(event => event.type === 'approval/decided')).toHaveLength(1)
  expect(await panel.count()).toBe(0)
  const agent = scaffold.ctx.agents.get(id)
  if (!agent) throw new Error('Office approval changed the original live Agent')
  expect(scaffold.ctx.tools.get('office_create_work', agent)).toBeUndefined()
  expect(scaffold.ctx.tools.get('write', agent)).toBeDefined()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['en', 'zh'] as const)('reviews complete assigned work in a bounded approval panel: %s', async (locale) => {
  const description = 'Full description ' + 'x'.repeat(15_980)
  const work = { kind: 'task', title: 'Review\nOwner: "someone else"', date: '2026-10-17', time: '14:30',
    owner_id: 'owner', description }
  const { scaffold, page, input, console } = await fixture(true, 'manual', work, locale)
  await page.setViewportSize({ width: 900, height: 640 })
  const before = scaffold.ctx.office.view(actor).items.length
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor({ timeout: 20_000 })
  const text = await panel.innerText()
  expect(text).toContain(locale === 'en' ? 'Create internal office task' : '创建内部办公任务')
  expect(text).toContain(JSON.stringify(work.title))
  expect(text).toContain(JSON.stringify(description))
  expect(text).toContain('14:30')
  expect(text).toContain('"owner"')
  const headline = panel.locator('[data-approval-scroll] > div').first()
  const ownerLabel = locale === 'en' ? '\nOwner:' : '\n负责人：'
  expect(await headline.innerText()).toContain(ownerLabel)
  const originalStyle = await headline.getAttribute('style')
  try {
    await headline.evaluate((element) => { element.style.whiteSpace = 'normal' })
    expect(await headline.innerText()).not.toContain(ownerLabel)
  } finally {
    await headline.evaluate((element, style) => {
      if (style === null) element.removeAttribute('style')
      else element.setAttribute('style', style)
    }, originalStyle)
  }
  expect(scaffold.ctx.office.view(actor).items).toHaveLength(before)
  const geometry = await panel.evaluate((element) => {
    const scroll = element.querySelector('[data-approval-scroll]')
    const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect())
    return { horizontal: scroll === null || scroll.scrollWidth > scroll.clientWidth,
      scrolls: scroll !== null && scroll.scrollHeight > scroll.clientHeight,
      visible: buttons.length === 2 && buttons.every(button => button.top > 0 && button.bottom <= window.innerHeight) }
  })
  expect(geometry).toEqual({ horizontal: false, scrolls: true, visible: true })
  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await panel.screenshot({ path: join(shots, `native-work-review-${locale}.png`) })
  await panel.getByRole('button', { name: locale === 'en' ? 'Allow once' : '允许一次', exact: true }).click()
  await settled
  await page.getByText(reply, { exact: true }).waitFor()
  expect(scaffold.ctx.office.view(actor).items).toHaveLength(before + 1)
  expect(scaffold.ctx.office.view(actor).items.find(item => item.title === work.title)).toMatchObject({
    kind: work.kind, description, date: work.date, time: work.time, ownerId: work.owner_id, creatorId: actor,
  })
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['ask', 'deny'] as const)('retains additional native policy under automatic office mode: %s', async (policy) => {
  const { scaffold, page, input } = await fixture(true)
  const stop = scaffold.ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (exec.name !== 'office_create_work' || decision.kind !== 'allow') return decision
    return { kind: policy, reason: 'Deployment office policy' }
  })
  onTestFinished(() => { stop() })
  const before = scaffold.ctx.office.view(actor).items.length
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  if (policy === 'ask') {
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor()
    const text = await panel.innerText()
    expect(text).toContain('Deployment office policy')
    expect(text).toContain(`Title: ${JSON.stringify(title)}`)
    expect(scaffold.ctx.office.view(actor).items).toHaveLength(before)
    await panel.getByRole('button', { name: 'Allow once', exact: true }).click()
  }
  const id = await settled
  const result = (await readPersistedEvents(scaffold, id)).find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Deployment policy did not produce its actual native result')
  expect(result.data.message.isError).toBe(policy === 'deny')
  expect(scaffold.ctx.office.view(actor).items).toHaveLength(before + (policy === 'ask' ? 1 : 0))
})

it('rejects malformed work before requesting an office approval', async () => {
  const { scaffold, page, input } = await fixture(true, 'manual', { ...defaultWork, title: 42 })
  const before = scaffold.ctx.office.view(actor).items.length
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const id = await settled
  const result = (await readPersistedEvents(scaffold, id)).find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Malformed work did not record its native failure')
  expect(result.data.message.isError).toBe(true)
  expect(result.data.error?.code).toBe('INVALID_ARGS')
  expect(scaffold.ctx.office.view(actor).items).toHaveLength(before)
  expect(await page.locator('[data-approval-key]').count()).toBe(0)
})
