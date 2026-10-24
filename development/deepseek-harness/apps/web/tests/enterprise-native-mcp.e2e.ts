/** Real MCP child-process requests and native Agent history coexist with the optional office shell. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type {} from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const tool = 'mcp__office_acceptance__add'
const reply = 'MCP_COMPATIBILITY_CONFIRMED'
const callId = ToolCallId('office-native-mcp-add')
const replay: ReplayOverrideDoc = [
  { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: tool, argumentsDelta: '{"a":2,"b":3}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: tool, arguments: '{"a":2,"b":3}' } },
    { type: 'usage', usage: { inputTokens: 32, outputTokens: 12 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] },
  { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: reply },
    { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
    { type: 'usage', usage: { inputTokens: 48, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] },
]

it.each(['native', 'office'] as const)('executes real MCP calls, disables and remounts the server under the %s shell', async (surface) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-enterprise-mcp-'))
  onTestFinished(async () => {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-enterprise-mcp-')) throw new Error('Unexpected MCP fixture root')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const packageDir = join(REPO_ROOT, 'packages', 'mcp', 'mcp-client')
  const override = join(root, 'replay.override.json')
  const overlay = join(root, 'mcp.patch.json')
  await writeFile(override, JSON.stringify(replay))
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'office-native-mcp', name: '@deepseek-ai/dsh-mcp-client', config: {
    serverName: 'office_acceptance', transport: 'stdio', command: process.execPath,
    args: [join(packageDir, 'tests', 'fixture-server.ts')], cwd: packageDir, env: {},
    toolCallTimeoutMs: 15_000, failOnStartupError: true,
  } }] }]))
  const scaffold = await launchWebScaffold({
    replayFixture: join(root, 'override-only.jsonl'), replayOverride: override,
    profile: { packages: [{ dir: packageDir }] },
    extraOverlayPath: [...(surface === 'office' ? [join(REPO_ROOT, 'enterprise-workbench.patch.yml')] : []), overlay],
  })
  onTestFinished(() => scaffold.close())
  const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'office-native-mcp')
  if (!entry) throw new Error('MCP loader entry is missing')
  await entry.fiber?.await()
  await expect.poll(() => scaffold.ctx.tools.get(tool), { timeout: 15_000 }).toBeDefined()
  const events: SessionEvent[] = []
  const stop = scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
  onTestFinished(() => { stop() })
  const actor = 'local' as OfficeMemberId
  const officeRecord = surface === 'office' ? await scaffold.ctx.office.createWork(actor, {
    kind: 'todo', title: 'Office data survives MCP lifecycle', date: scaffold.ctx.office.view(actor).day.date, ownerId: actor,
  }) : null
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, `enterprise-native-mcp-${surface}`))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  if (surface === 'office') await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const settled = scaffold.whenTurnSettled()
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
  await composer.fill('Use the connected MCP add tool to add two and three, then confirm completion.')
  await composer.press('Enter')
  const sessionId = await settled
  await page.getByText(reply, { exact: true }).waitFor({ timeout: 15_000 })
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual([tool])
  const result = events.find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('No actual MCP result reached the Session')
  expect(result.data.message.isError).not.toBe(true)
  expect(result.data.message.content).toEqual([{ type: 'text', text: '5' }])
  expect((await readPersistedEvents(scaffold, sessionId)).some(event => event.type === 'tool/result')).toBe(true)
  await scaffold.ctx.loader.update(entry.id, { disabled: true })
  await expect.poll(() => scaffold.ctx.tools.get(tool), { timeout: 15_000 }).toBeUndefined()
  expect(await page.getByText(reply, { exact: true }).count()).toBe(1)
  await scaffold.ctx.loader.update(entry.id, { disabled: false })
  await expect.poll(() => scaffold.ctx.tools.get(tool), { timeout: 15_000 }).toBeDefined()
  const remounted = await scaffold.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('office-native-mcp-remount'), name: tool, arguments: { a: 3, b: 4 },
  })
  expect(remounted.isError).not.toBe(true)
  expect(remounted.content).toEqual([{ type: 'text', text: '7' }])
  if (officeRecord) {
    expect(scaffold.ctx.office.getItem(actor, officeRecord.id)).toEqual(officeRecord)
    const rail = page.getByRole('navigation', { name: 'Workbench', exact: true })
    await rail.getByRole('button', { name: 'Workbench', exact: true }).click()
    await page.getByRole('button').filter({ hasText: officeRecord.title }).waitFor()
  }
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
