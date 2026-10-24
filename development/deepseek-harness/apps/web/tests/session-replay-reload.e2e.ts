/** Recorded-session recovery through Chromium and WebKit's native JSON validation. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureExpandedTurnProcessAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, selectedSessionFixture, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'
import { dirname, join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

// The Windows case pins real pwsh results and its own platform context; POSIX recordings remain immutable.
const SCENARIO = process.platform === 'win32' ? 'fresh-round-trip-windows' : 'fresh-round-trip'
const FIXTURE = fileURLToPath(new URL(`../../../snapshots/web/${SCENARIO}/session.v4.jsonl`, import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL(`../../../snapshots/web/${SCENARIO}/ui-expanded.expected.md`, import.meta.url))
const OFFICE_EXPECTED_DIR = fileURLToPath(new URL('./expected/office-session-replay-reload', import.meta.url))
const OFFICE_UI_EXPECTED = join(OFFICE_EXPECTED_DIR, process.platform === 'win32' ? 'windows.expected.md' : 'posix.expected.md')
const COMPARISON_MODE = process.platform === 'win32' ? webSnapshotMode() : 'replay'

describe.skipIf(webSnapshotMode() === 'record')('web session replay', () => {
  it('keeps office interface expectations separate from the shared native recording', async () => {
    await assertFixtureInventory(OFFICE_EXPECTED_DIR, ['windows.expected.md', 'posix.expected.md'])
  })

  it.skipIf(process.platform !== 'win32')('keeps the owned Windows fixture inventory scrubbed and closed', async () => {
    await assertFixtureInventory(dirname(FIXTURE), [
      'session.v4.jsonl', 'ui-expanded.expected.md', 'system-prompt.expected.md', 'tool-schemas.expected.json',
    ])
  })

  it.each([
    { name: 'Chromium', engine: chromium, surface: 'native' },
    { name: 'WebKit', engine: webkit, surface: 'native' },
    { name: 'Chromium', engine: chromium, surface: 'office' },
    { name: 'WebKit', engine: webkit, surface: 'office' },
  ])(
    '$name ($surface) restores an active stream, a completed turn, and a reopened session', async ({ engine, surface }) => {
      const uiExpected = surface === 'office' ? OFFICE_UI_EXPECTED : UI_EXPECTED
      const scaffold = await launchWebScaffold({
        replayFixture: FIXTURE, compareReplaySession: process.platform === 'win32' ? true : 'read-only',
        ...(surface === 'office' ? { extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') } : {}),
      })
      onTestFinished(() => scaffold.close())
      const events: SessionEvent[] = []
      const stopEvents = scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
      onTestFinished(() => { stopEvents() })
      const release = Promise.withResolvers<undefined>()
      const reached = Promise.withResolvers<string>()
      let paused = false
      // Hold the recorded stream until the reloaded page has received its active baseline.
      const dispose = scaffold.ctx.on('llm/stream', async function* (_options, next) {
        for await (const chunk of next()) {
          yield chunk
          if (!paused && chunk.type === 'text-delta' && chunk.text.trim()) {
            paused = true
            reached.resolve(chunk.text.trim())
            await release.promise
          }
        }
      }, { prepend: true })
      onTestFinished(() => { release.resolve(undefined); dispose() })
      const browser = await engine.launch()
      onTestFinished(() => browser.close())
      const page = await newEnglishPage(browser)
      onTestFailed(() => saveFailureShot(page, `session-replay-reload-${engine.name()}-${surface}`))
      const tripwire = watchConsole(page)
      const openConversation = async () => {
        if (surface !== 'office') return
        await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
        expect(await page.getByRole('navigation', { name: 'Workbench', exact: true }).count()).toBe(1)
      }
      await page.goto(scaffold.authenticatedUrl)
      await openConversation()
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      const prompts = fixtureUserPrompts(await readFile(await selectedSessionFixture(FIXTURE), 'utf8'))
      expect(prompts).toHaveLength(1)
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      await input.fill(prompts[0]!)
      await input.press('Enter')
      const partial = await reached.promise
      const settled = scaffold.whenTurnSettled()
      try {
        const streaming = page.locator('[data-streaming="true"]').getByText(partial, { exact: true })
        await streaming.waitFor({ timeout: 15_000 })
        const warningStart = tripwire.warnings.length
        await page.reload()
        await openConversation()
        await streaming.waitFor({ timeout: 15_000 })
        acknowledgeReloadConnectionLoss(tripwire, warningStart)
        expect(tripwire.pageErrors).toEqual([])
      } finally {
        release.resolve(undefined)
        await settled
      }
      const calls = events.filter(event => event.type === 'tool/call')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.data.name).toBe(process.platform === 'win32' ? 'pwsh' : 'bash')
      const result = events.find(event => event.type === 'tool/result')
      if (result?.type !== 'tool/result') throw new Error('The actual shell produced no persisted result')
      expect(result.data.error).toBeUndefined()
      expect(result.data.message.isError).not.toBe(true)
      expect(result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')).toContain('WEB_E2E_OK')
      await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
      const warningStart = tripwire.warnings.length
      await page.reload()
      await openConversation()
      await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await compareOrRefreshGolden(uiExpected,
        await captureExpandedTurnProcessAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), COMPARISON_MODE)

      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      await page.getByText('Into the Unknown', { exact: true }).waitFor()
      await page.getByRole('treeitem').filter({ has: page.getByText(`Use the ${process.platform === 'win32' ? 'pwsh' : 'bash'} tool to`, { exact: true }) }).click()
      await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
      await compareOrRefreshGolden(uiExpected,
        await captureExpandedTurnProcessAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), COMPARISON_MODE)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    },
  )
})
