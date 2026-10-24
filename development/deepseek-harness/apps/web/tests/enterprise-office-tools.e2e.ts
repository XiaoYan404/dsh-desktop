/** Real native skill discovery and explicit draft preparation inside the employee workbench. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type { OfficeConversationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const skillName = 'office-browser-check'
const reply = 'OFFICE_TOOLS_REQUEST_ACCEPTED'
const replay: ReplayOverrideDoc = [{ kind: 'chunks', chunks: [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: reply },
  { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
  { type: 'usage', usage: { inputTokens: 40, outputTokens: 8 } },
  { type: 'finish', reason: { kind: 'stop' } },
] }]

async function fixture(connected = false, withReply = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-tools-'))
  onTestFinished(async () => {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-tools-')) {
      throw new Error('Unexpected office tools fixture directory')
    }
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const override = join(root, 'replay.json')
  await writeFile(override, JSON.stringify(replay))
  const scaffold = await launchWebScaffold({
    profile: { packages: [] },
    ...(withReply ? { replayFixture: join(root, 'override-only.jsonl'), replayOverride: override } : {}),
    extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml'),
  })
  onTestFinished(() => scaffold.close())
  const skillRoot = join(scaffold.workspaceCwd, 'workspace', '.agents', 'skills', skillName)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), [
    '---', `name: ${skillName}`, 'description: Real workspace skill for employee documents',
    'disable-model-invocation: true', '---', 'OFFICE_NATIVE_SKILL_INSTRUCTIONS: review the supplied employee material.', '',
  ].join('\n'))
  await writeFile(join(scaffold.workspaceCwd, 'workspace', 'reference.txt'), 'ACTUAL_OFFICE_REFERENCE_BYTES\n')
  const events: SessionEvent[] = []
  const stop = scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
  onTestFinished(() => { stop() })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-tools'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  if (connected) {
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }
  return { scaffold, browser, page, nav, console, events }
}

function userMessages(events: readonly SessionEvent[]) {
  return events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

it('searches the current Conversation skill catalog without preparing or sending the retained native draft', async () => {
  const { page, nav, console, events } = await fixture(true)
  const input = page.locator('[data-composer-input]').first()
  await writeComposerDraft(page, input, 'Retained draft before global search')
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByRole('article', { name: skillName, exact: true }).waitFor()
  const before = userMessages(events).length
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  const search = page.getByRole('dialog', { name: 'Global search', exact: true })
  await search.getByRole('combobox').fill(skillName)
  await search.getByRole('option', { name: new RegExp(`Skills · ${skillName}`) }).click()
  await search.waitFor({ state: 'hidden' })
  const details = page.getByRole('dialog', { name: skillName, exact: true })
  await details.getByText('Real workspace skill for employee documents', { exact: true }).waitFor()
  expect(await details.getByLabel('Requirements', { exact: true }).count()).toBe(0)
  await details.getByRole('button', { name: 'Close', exact: true }).last().click()
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await expect.poll(() => input.textContent()).toBe('Retained draft before global search')
  expect(userMessages(events)).toHaveLength(before)
  expect(events.some(event => event.type === 'turn/start')).toBe(false)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('opens a selected Conversation skill from home search after authorized metadata reads', async () => {
  const { page, nav, console, events } = await fixture(true)
  const input = page.locator('[data-composer-input]').first()
  await writeComposerDraft(page, input, 'Unsent draft retained by the native input owner')
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
  await page.getByRole('button', { name: 'Global search', exact: true }).click()
  const search = page.getByRole('dialog', { name: 'Global search', exact: true })
  await search.getByRole('combobox').fill(skillName)
  await search.getByRole('option', { name: new RegExp(`Skills · ${skillName}`) }).click()
  await search.waitFor({ state: 'hidden' })
  const details = page.getByRole('dialog', { name: skillName, exact: true })
  await details.getByText('Real workspace skill for employee documents', { exact: true }).waitFor()
  expect(await details.getByLabel('Requirements', { exact: true }).count()).toBe(0)
  await details.getByRole('button', { name: 'Close', exact: true }).last().click()
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await expect.poll(() => input.textContent()).toBe('Unsent draft retained by the native input owner')
  expect(userMessages(events)).toHaveLength(0)
  expect(events.some(event => event.type === 'turn/start')).toBe(false)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('discovers categories, task details and registered company systems while retaining native installation management', async () => {
  const { scaffold, page, nav, console, events } = await fixture()
  for (const [name, system] of [['company-dingtalk', 'DingTalk'], ['company-wecom', 'WeCom']]) {
    await scaffold.ctx.office.importIntegration('owner' as OfficeMemberId, { requestId: randomUUID(), json: JSON.stringify({
      name, system, version: '1.0.0', provider: 'Company', description: `${system} company messaging`, capabilities: ['Company messaging'],
    }) })
  }
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByRole('heading', { name: 'Tools and skills', exact: true }).waitFor()
  expect(await page.locator('[data-office-tool-kind="template"]').count()).toBe(7)
  expect(await page.locator('[data-office-tool-kind="skill"]').count()).toBe(0)
  await page.getByRole('button', { name: 'Company systems', exact: true }).click()
  const company = page.getByRole('article', { name: 'DingTalk', exact: true })
  await company.getByText('Connection not configured', { exact: true }).waitFor()
  expect(await company.getByRole('button', { name: 'Describe requirements', exact: true }).count()).toBe(0)
  await page.getByRole('button', { name: 'Documents and data', exact: true }).click()
  expect(await page.locator('[data-office-tool-kind="template"]').count()).toBe(4)
  await page.getByRole('searchbox', { name: 'Search skills, tasks or company systems', exact: true }).fill('pdf')
  const pdf = page.getByRole('article', { name: 'PDF processing', exact: true })
  expect(await page.locator('[data-office-tool-kind="template"]').count()).toBe(1)
  await pdf.getByRole('button', { name: 'View tool details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'PDF processing', exact: true })
  await dialog.getByText('This is a request template.', { exact: false }).waitFor()
  await dialog.getByRole('button', { name: 'Describe requirements', exact: true }).click()
  await dialog.getByLabel('Requirements', { exact: true }).fill('Extract the expense totals.')
  await dialog.getByRole('button', { name: 'Prepare in AI conversation', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  expect(await dialog.getByLabel('Requirements', { exact: true }).inputValue()).toBe('Extract the expense totals.')
  expect(userMessages(events)).toEqual([])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Add skills or plugins', exact: true }).click()
  await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor()
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByRole('button', { name: 'Choose AI conversation', exact: true }).click()
  await page.getByRole('textbox', { name: 'Choose workspace', exact: true }).waitFor()
  expect(userMessages(events)).toEqual([])
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByRole('button', { name: 'Add system tools', exact: true }).click()
  await page.getByRole('heading', { name: 'Company system plugins', exact: true }).waitFor()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('prepares a real user-only skill in the current native input, retaining reference chips and attachment bytes until explicit Send', async () => {
  const { scaffold, page, nav, console, events } = await fixture(true, true)
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Original employee draft @reference.txt')
  await page.getByRole('listbox', { name: 'Trigger suggestions', exact: true })
    .getByRole('option', { name: 'reference.txt', exact: true }).click()
  expect(await input.locator('[data-composer-chip]').count()).toBe(1)
  await page.locator('input[type="file"]').setInputFiles({
    name: 'employee-material.txt', mimeType: 'text/plain', buffer: Buffer.from('REAL_OFFICE_TOOL_ATTACHMENT\n'),
  })
  await page.getByTitle('employee-material.txt', { exact: true }).waitFor()
  const previous = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  const skill = page.getByRole('article', { name: skillName, exact: true })
  await skill.getByText('Explicit user invocation', { exact: true }).waitFor()
  await skill.getByRole('button', { name: 'Describe requirements', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: skillName, exact: true })
  await dialog.getByLabel('Requirements', { exact: true }).fill('Review the supplied employee material.')
  await dialog.getByRole('button', { name: 'Prepare in AI conversation', exact: true }).click()
  await expect.poll(async () => await dialog.isVisible() ? await dialog.ariaSnapshot() : 'closed', { timeout: 5000 }).toBe('closed')
  await expect.poll(() => input.textContent()).toContain(`/${skillName} Review the supplied employee material.`)
  expect(await input.textContent()).toContain('Original employee draft')
  expect(await input.locator('[data-composer-chip]').count()).toBe(1)
  await page.getByTitle('employee-material.txt', { exact: true }).waitFor()
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  expect(current.sessionId).toBe(previous.sessionId)
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByRole('article', { name: 'Meeting minutes', exact: true })
    .getByRole('button', { name: 'Describe requirements', exact: true }).click()
  const minutes = page.getByRole('dialog', { name: 'Meeting minutes', exact: true })
  await minutes.getByLabel('Requirements', { exact: true }).fill('Include the attached planning notes.')
  await minutes.getByRole('button', { name: 'Prepare in AI conversation', exact: true }).click()
  await minutes.waitFor({ state: 'hidden' })
  await expect.poll(() => input.textContent()).toContain('Include the attached planning notes.')
  expect(await input.textContent()).toContain(`/${skillName} Review the supplied employee material.`)
  expect(await input.locator('[data-composer-chip]').count()).toBe(1)
  await page.getByTitle('employee-material.txt', { exact: true }).waitFor()
  expect(userMessages(events)).toEqual([])
  const association = await scaffold.ctx.office.conversationLinks('local' as OfficeMemberId, String(current.sessionId) as OfficeConversationId)
  expect(association.selection.tools).toEqual([{ kind: 'skill', name: skillName }, { kind: 'template', name: 'minutes' }])
  const requests: GenerateOptions[] = []
  const observe = scaffold.ctx.on('llm/stream', (options, next) => {
    requests.push(options)
    return next()
  }, { prepend: true })
  onTestFinished(() => { observe() })
  const changeAfterCapture = scaffold.ctx.on('api-session/prepare-context', async (_payload, next) => {
    const captured = await next()
    await scaffold.ctx.office.saveConversationLinks('local' as OfficeMemberId, {
      conversationId: association.selection.conversationId, revision: association.selection.revision,
      requestId: randomUUID(), kind: 'tools', tools: [],
    })
    return captured
  }, { prepend: true })
  onTestFinished(() => { changeAfterCapture() })
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const id = await settled
  expect(id).toBe(previous.sessionId)
  await page.getByText(reply, { exact: true }).waitFor({ timeout: 20_000 })
  const saved = await readPersistedEvents(scaffold, id)
  const live = scaffold.ctx.sessions.get(id)
  if (!live) throw new Error('Submitted native Session is unavailable')
  await writeFile(join(REPO_ROOT, '.artifacts', 'enterprise-round56-prepared-session.json'), JSON.stringify({ header: live.header, events: saved }))
  expect(userMessages(saved)).toHaveLength(1)
  const contexts = saved.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'office' ? [event.data] : [])
  expect(contexts).toHaveLength(1)
  const source = contexts[0]?.source
  if (source?.kind !== 'office') throw new Error('Office context missing from native Session history')
  expect(source.capture).toMatchObject({ memberId: 'local', selection: association.selection })
  expect(userMessages(saved)[0]?.data.source).toMatchObject({ rpcId: source.capture.requestId })
  expect((await scaffold.ctx.office.conversationLinks('local' as OfficeMemberId, String(id) as OfficeConversationId))
    .selection.tools).toEqual([])
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]?.messages)).toContain('Selected skill and task-template references')
  expect(JSON.stringify(requests[0]?.messages)).toContain(`skill: ${skillName}`)
  expect(JSON.stringify(requests[0]?.messages)).toContain('template: minutes')
  expect(JSON.stringify(requests[0]?.messages)).toContain('OFFICE_NATIVE_SKILL_INSTRUCTIONS')
  await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
  const officeRow = page.locator('tr[data-kind="context"]').filter({ hasText: 'Selected company systems' })
  await officeRow.click()
  const contextDetails = page.getByRole('complementary', { name: 'Event details', exact: true })
  expect(await contextDetails.textContent()).toContain(`skill: ${skillName}`)
  expect(await contextDetails.textContent()).toContain('template: minutes')
  const file = userMessages(saved)[0]!.data.content.find(block => block.type === 'file')
  if (file?.type !== 'file') throw new Error('Native file attachment missing from persisted request')
  const path = scaffold.ctx.attachments.fileHostPath(file.attachment)
  if (!path) throw new Error('Native attachment bytes have no Host path')
  expect(await readFile(path, 'utf8')).toBe('REAL_OFFICE_TOOL_ATTACHMENT\n')
  const injected = saved.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n')
  expect(injected).toContain('OFFICE_NATIVE_SKILL_INSTRUCTIONS')
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
  await officeRow.click()
  expect(await contextDetails.textContent()).toContain('template: minutes')
  expect(userMessages(await readPersistedEvents(scaffold, id))).toHaveLength(1)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('retains discovery after a failed refresh and refuses a skill removed before draft adoption', async () => {
  const { scaffold, page, nav, console, events } = await fixture(true)
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  const skill = page.getByRole('article', { name: skillName, exact: true })
  await skill.waitFor()
  const failure = vi.spyOn(scaffold.ctx.sessionSkillCatalog, 'list').mockRejectedValueOnce(new Error('Expected catalog interruption'))
  onTestFinished(() => { failure.mockRestore() })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Conversation skills are unavailable.' }).waitFor()
  expect(await skill.count()).toBe(1)
  failure.mockResolvedValueOnce({ skills: [] })
  await skill.getByRole('button', { name: 'Describe requirements', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: skillName, exact: true })
  await dialog.getByLabel('Requirements', { exact: true }).fill('Keep this requirement after failure.')
  await dialog.getByRole('button', { name: 'Prepare in AI conversation', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: 'This skill is no longer available.' }).waitFor()
  expect(await dialog.ariaSnapshot()).toContain('textbox "Requirements"')
  expect(await dialog.getByLabel('Requirements', { exact: true }).inputValue()).toBe('Keep this requirement after failure.')
  expect(userMessages(events)).toEqual([])
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  failure.mockRestore()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await skill.waitFor()
  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'tools-light.png'), fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
  await page.screenshot({ path: join(shots, 'tools-dark.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 1040, height: 700 })
  await skill.getByRole('button', { name: 'Describe requirements', exact: true }).click()
  await page.getByRole('dialog', { name: skillName, exact: true }).getByLabel('Requirements', { exact: true }).fill('Small-window review')
  await page.screenshot({ path: join(shots, 'tools-small.png'), fullPage: true, animations: 'disabled' })
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('withdraws a pending skill preparation on account replacement before a late catalog response can fill its input', async () => {
  const { scaffold, page, nav, console, events } = await fixture(true)
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Old employee native draft')
  const previous = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  const skill = page.getByRole('article', { name: skillName, exact: true })
  await skill.getByRole('button', { name: 'Describe requirements', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: skillName, exact: true })
  await dialog.getByLabel('Requirements', { exact: true }).fill('Prior employee private requirement')
  const release = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const catalog = scaffold.ctx.sessionSkillCatalog
  const original = catalog.list.bind(catalog)
  const held = vi.spyOn(catalog, 'list').mockImplementation(async (request, signal) => {
    entered.resolve(undefined)
    await release.promise
    return original(request, signal)
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  await dialog.getByRole('button', { name: 'Prepare in AI conversation', exact: true }).click()
  await entered.promise
  const controller = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-office')!
  await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: 'owner' }))
  const name = scaffold.ctx.office.view('owner' as OfficeMemberId).me.name
  await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent(), { timeout: 10_000 }).toContain(name)
  await dialog.waitFor({ state: 'hidden' })
  release.resolve(undefined)
  held.mockRestore()
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  expect(await page.locator('[data-office-tool-kind="skill"]').count()).toBe(0)
  expect(await page.content()).not.toContain('Prior employee private requirement')
  await page.getByRole('article', { name: 'Work reminders', exact: true })
    .getByRole('button', { name: 'Describe requirements', exact: true }).click()
  const fresh = page.getByRole('dialog', { name: 'Work reminders', exact: true })
  await fresh.getByLabel('Requirements', { exact: true }).fill('New employee reminder requirements')
  await fresh.getByRole('button', { name: 'Prepare in AI conversation', exact: true }).click()
  await fresh.waitFor({ state: 'hidden' })
  await expect.poll(() => input.textContent()).toContain('New employee reminder requirements')
  expect(await input.textContent()).not.toContain('Old employee native draft')
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  expect(current.sessionId).not.toBe(previous.sessionId)
  const association = await scaffold.ctx.office.conversationLinks('owner' as OfficeMemberId, String(current.sessionId) as OfficeConversationId)
  expect(association.selection.tools).toEqual([{ kind: 'template', name: 'reminder' }])
  expect(userMessages(events)).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
