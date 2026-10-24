// Keyless replay of a real two-round Goal run. Each autonomous round ends as
// its own turn, so the first answer must keep its IconActions when Goal opens
// round two and the final answer must own a second, distinct action row.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-goal'
import {
  assertFixtureInventory, captureExpandedTurnProcessAria, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const WINDOWS = process.platform === 'win32'
const SNAPSHOT_DIR = fileURLToPath(new URL(
  WINDOWS ? '../../../snapshots/web/goal-multi-turn-actions-windows' : '../../../snapshots/web/goal-multi-turn-actions',
  import.meta.url,
))
const FIXTURE = join(SNAPSHOT_DIR, WINDOWS ? 'session.v4.jsonl' : 'session.v3.jsonl')
const OVERRIDE = join(SNAPSHOT_DIR, 'replay.override.json')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const UI_EXPANDED_EXPECTED = join(SNAPSHOT_DIR, 'ui-expanded.expected.md')
const MODE = webSnapshotMode()

const PROMPT = '做两个turn，每个turn输出随机一个包的文件结构。注意你做完一个turn之后，直接输出内容，停止，我们的系统会帮你再开一个turn，你看着做一个类似的'
const COMMAND = `/goal ${PROMPT}`

const PACKAGE_FILES: Readonly<Record<string, string>> = {
  'packages/client/ui-conversation/README.md': '# UI conversation\n',
  'packages/client/ui-conversation/package.json': '{"name":"@deepseek-ai/dsh-client-ui-conversation"}\n',
  'packages/client/ui-conversation/src/client.ts': 'export {}\n',
  'packages/client/ui-chat/tests/chat-view.client.spec.tsx': 'export {}\n',
  'packages/context/session-reference/README.md': '# Session reference\n',
  'packages/context/session-reference/package.json': '{"name":"@deepseek-ai/dsh-session-reference"}\n',
  'packages/context/session-reference/src/index.ts': 'export {}\n',
  'packages/context/session-reference/src/uri.ts': 'export {}\n',
  'packages/context/session-reference/tests/session-reference.spec.ts': 'export {}\n',
  'packages/llm/token-meter/README.md': '# Token meter\n',
  'packages/llm/token-meter/package.json': '{"name":"@deepseek-ai/dsh-token-meter"}\n',
  'packages/llm/token-meter/src/index.ts': 'export {}\n',
  'packages/llm/token-meter/tests/token-meter.spec.ts': 'export {}\n',
  'packages/skill/skill-filesystem/README.md': '# Local skill provider\n',
  'packages/skill/skill-filesystem/package.json': '{"name":"@deepseek-ai/dsh-skill-filesystem"}\n',
  'packages/skill/skill-filesystem/src/index.ts': 'export {}\n',
  'packages/skill/skill-filesystem/src/invariant.ts': 'export {}\n',
  'packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts': 'export {}\n',
}

/** Materialize a stable package inventory inside the isolated session workspace. */
async function seedPackageInventory(workspaceRoot: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(PACKAGE_FILES)) {
    const path = join(workspaceRoot, 'workspace', relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
}

/** Await exactly the requested number of durable turn ends, then flush the session. */
function whenTurnsSettled(scaffold: WebScaffold, count: number, timeoutMs: number): Promise<SessionId> {
  return new Promise<SessionId>((resolve, reject) => {
    let completed = 0
    const timer = setTimeout(() => {
      off()
      reject(new Error(`only ${completed}/${count} Goal turns ended within ${timeoutMs}ms`))
    }, timeoutMs)
    const off = scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      completed += 1
      if (completed !== count) return
      clearTimeout(timer)
      off()
      scaffold.ctx.sessions.flush(session).then(() => { resolve(session.id) }, reject)
    })
  })
}

/** Goal-owned round numbers in durable user-message order. */
function goalRounds(events: readonly SessionEvent[]): number[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'goal'
    ? [event.data.source.round]
    : [])
}

/** Objective written by each durable Goal creation. */
function createdObjectives(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'goal/change' && event.data.operation === 'create'
    ? [event.data.goal.objective]
    : [])
}

/** Preserve the recorded Windows tool executions and explicit command failure. */
function windowsGoalResultBytes(events: readonly SessionEvent[]): Buffer[] {
  const steps = [1, 2].flatMap(turn => Array.from({ length: 6 }, (_, index) => [turn, index + 1]))
  expect(events.flatMap(event => event.type === 'step/start' ? [[event.data.turn, event.data.step]] : []))
    .toEqual(steps)
  expect(events.flatMap(event => event.type === 'step/end' ? [[event.data.turn, event.data.step]] : []))
    .toEqual(steps)
  expect(events.flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : []))
    .toEqual(['completed', 'completed'])
  const calls = events.filter(event => event.type === 'tool/call')
  expect(calls.map(event => event.data.name)).toEqual([
    'pwsh', 'get_goal', 'pwsh', 'pwsh', 'pwsh', 'pwsh', 'pwsh', 'pwsh', 'pwsh', 'get_goal', 'update_goal',
  ])
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(calls.length)
  for (const call of calls) {
    const paired = results.filter(event => event.data.message.toolCallId === call.data.callId)
    expect(paired).toHaveLength(1)
    expect(paired[0]!.data.error).toBeUndefined()
    expect(paired[0]!.data.message.isError).toBe(false)
  }
  const completed = events.findLast(event => event.type === 'goal/change' && event.data.operation === 'complete')
  if (completed?.type !== 'goal/change' || completed.data.operation === 'clear') {
    throw new Error('Windows Goal recording has no completion')
  }
  expect(completed.data.goal.phase).toBe('complete')
  expect(completed.data.goal.revision).toBe(2)
  expect(completed.data.roundsStarted).toBe(2)
  const outputs = calls.filter(event => event.data.name === 'pwsh').map((call) => {
    const result = results.find(event => event.data.message.toolCallId === call.data.callId)!
    expect(result.data.message.content).toHaveLength(1)
    const block = result.data.message.content[0]!
    if (block.type !== 'text') throw new Error('Windows Goal pwsh result must be text')
    return Buffer.from(block.text, 'utf8')
  })
  expect(outputs[2]).toEqual(Buffer.from(
    '1: packages/client/ui-conversation\r\n2: packages/context/session-reference\r\n'
    + '3: packages/llm/token-meter\r\n4: packages/skill/skill-filesystem\r\n---random pick---\r\n'
    + '[stderr]\nrandom selector unavailable in this fixture\r\n[exit code: 127]',
    'utf8',
  ))
  return outputs
}

describe('web e2e: Goal keeps one assistant action row per completed turn', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessionEvents: SessionEvent[]

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'goal-multi-turn-actions teardown failed')
  })

  /** Boot the real Web composition and connect a fresh package fixture workspace. */
  async function launch(): Promise<void> {
    sessionEvents = []
    scaffold = await launchWebScaffold(
      MODE === 'record' ? {} : {
        replayFixture: FIXTURE, replayOverride: OVERRIDE,
        // UI capture must not rewrite the independently CLI-recorded Session.
        ...WINDOWS ? { compareReplaySession: 'read-only' as const } : {},
      },
    )
    await seedPackageInventory(scaffold.workspaceCwd)
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }

  /** Submit the Goal command after arming the two-turn barrier. */
  async function runGoal(timeoutMs: number): Promise<SessionId> {
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = whenTurnsSettled(scaffold!, 2, timeoutMs)
    await input.fill(COMMAND)
    await input.press('Enter')
    return settled
  }

  it.skipIf(MODE !== 'record')('records the two-round Goal through the real model', async () => {
    await launch()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-multi-turn-actions-record'))
    const sessionId = await runGoal(360_000)
    await recordFixture(scaffold!, sessionId, FIXTURE)
  }, 380_000)

  it.skipIf(MODE === 'record')('keeps actions on both completed Goal turn tails', async () => {
    const fixtureEvents = parseSessionLog(await readFile(FIXTURE, 'utf8'))
    expect(createdObjectives(fixtureEvents)).toEqual([PROMPT])
    expect(goalRounds(fixtureEvents)).toEqual([1, 2])

    await launch()
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-multi-turn-actions'))
    await runGoal(120_000)

    expect(sessionEvents.flatMap(event => event.type === 'turn/end' ? [event.data.turn] : []))
      .toEqual([1, 2])
    expect(goalRounds(sessionEvents)).toEqual([1, 2])
    if (WINDOWS) {
      expect(sessionEvents.flatMap(event => event.type === 'tool/call' && event.data.name === 'pwsh'
        ? [event.data.arguments] : []))
        .toEqual(fixtureEvents.flatMap(event => event.type === 'tool/call' && event.data.name === 'pwsh'
          ? [event.data.arguments] : []))
      expect(windowsGoalResultBytes(sessionEvents)).toEqual(windowsGoalResultBytes(fixtureEvents))
    }
    expect(sessionEvents.flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial', 'series'])
    await expect.poll(() => page.locator('[data-turn-process]').count(), { timeout: 15_000 }).toBe(2)
    const trigger = page.locator('[data-turn-trigger]').first()
    const process = page.locator('[data-turn-process]').first()
    const originalFontSize = await page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size'))
    await process.click()
    try {
      for (const fontSize of [10, 14, 22]) {
        await scaffold!.ctx.settings.update('ui-theme', { fontSize })
        await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')))
          .toBe(`${String(fontSize)}px`)
        const group = page.locator('[data-process-activity]:visible').first()
        const groupFontSize = await group.evaluate(element => getComputedStyle(element).fontSize)
        expect(groupFontSize).toBe(`${String(fontSize)}px`)
        expect(await process.evaluate(element => getComputedStyle(element).fontSize)).toBe(groupFontSize)
        expect(await trigger.getByText('Continuing goal', { exact: true })
          .evaluate(element => getComputedStyle(element).fontSize)).toBe(groupFontSize)
        expect(await process.evaluate(element => element.getBoundingClientRect().top))
          .toBe(await trigger.evaluate(element => element.getBoundingClientRect().bottom) + 16)
        expect(await group.evaluate(element => element.getBoundingClientRect().top))
          .toBe(await process.evaluate(element => element.getBoundingClientRect().bottom) + 16)
      }
    } finally {
      await scaffold!.ctx.settings.update('ui-theme', { fontSize: Number.parseFloat(originalFontSize) })
      await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')))
        .toBe(originalFontSize)
      await process.click()
    }
    expect(await page.getByRole('button', { name: 'System prompt' }).count()).toBe(0)
    expect(await page.locator(
      '[data-chat-flow-kind="system-prompt"]',
    ).count()).toBe(0)
    const branchButtons = page.getByRole('button', { name: 'Branch into a new conversation' })
    await expect.poll(() => branchButtons.count(), { timeout: 15_000 }).toBe(2)
    expect(await branchButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-disabled'))))
      .toEqual([null, null])
    await branchButtons.last().focus()
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold!.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    const expanded = await captureExpandedTurnProcessAria(
      page,
      '[class*="centerCol"]',
      scaffold!.workspaceCwd,
    )
    await compareOrRefreshGolden(UI_EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 140_000)

  it.skipIf(MODE === 'record')('keeps a closed fixture inventory', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'replay.override.json', WINDOWS ? 'session.v4.jsonl' : 'session.v3.jsonl', 'ui.expected.md', 'ui-expanded.expected.md',
    ])
  })
})
