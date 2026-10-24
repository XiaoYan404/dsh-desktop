/** Real browser and office persistence cover cancellation, private editing, export and conflict review. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

it('saves private customization versions and exports only a reviewed current version without external delivery', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const owner = 'owner' as OfficeMemberId
  const controller = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-office')!
  await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: owner }))
  await scaffold.ctx.loader.await()
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  await page.setViewportSize({ width: 900, height: 640 })
  const console = watchConsole(page)
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office')
  await mkdir(artifacts, { recursive: true })
  onTestFailed(async () => {
    if (!page.isClosed()) await page.screenshot({ path: join(artifacts, 'customization-failure.png'), animations: 'disabled' })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  const open = page.getByRole('button', { name: 'Request product company customization', exact: true })
  await open.click()
  const form = page.getByRole('dialog', { name: 'System and skill customization', exact: true })
  await form.getByRole('textbox', { name: 'System or skill name', exact: true }).fill('Private OA adapter')
  await form.getByRole('textbox', { name: 'Requirements', exact: true }).fill('Cancelled draft')
  await form.getByRole('button', { name: 'Close', exact: true }).click()
  expect((await scaffold.ctx.office.customizationRequests(owner, null)).entries).toEqual([])
  await open.click()
  await form.getByRole('textbox', { name: 'System or skill name', exact: true }).fill('Private OA adapter')
  await form.getByRole('textbox', { name: 'Contact person', exact: true }).fill('Office employee')
  await form.getByRole('textbox', { name: 'Requirements', exact: true }).fill('Keep existing approvals\n查询状态，安排会议。')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.getByText('Saved, not sent · Version 1', { exact: true }).waitFor()
  const id = (await scaffold.ctx.office.customizationRequests(owner, null)).entries[0]!.id
  const original = await scaffold.ctx.office.customizationRequest(owner, id)
  await form.getByRole('button', { name: 'Close', exact: true }).click()
  await nav.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByRole('button', { name: 'My customization requests', exact: true }).click()
  const list = page.getByRole('dialog', { name: 'My customization requests', exact: true })
  await list.getByText('Private OA adapter', { exact: true }).waitFor()
  await list.getByRole('button', { name: 'View and edit', exact: true }).click()
  await form.getByRole('textbox', { name: 'Requirements', exact: true }).fill('Retain all existing tools\n增加日程查询。')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.getByText('Saved, not sent · Version 2', { exact: true }).waitFor()
  const saved = await scaffold.ctx.office.customizationRequest(owner, id)
  expect(saved.revision).toBe(2)
  expect(saved.createdAt).toBe(original.createdAt)
  const downloaded = page.waitForEvent('download')
  await form.getByRole('button', { name: 'Export saved version', exact: true }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe(`customization-${id}-v2.json`)
  const path = await download.path()
  if (!path) throw new Error('Customization export did not create a file')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ format: 'office-customization-request', version: 1,
    delivery: 'not_sent', record: saved })
  await scaffold.ctx.office.saveCustomizationRequest(owner, { id, revision: 2, requestId: randomUUID(),
    target: saved.target, contact: saved.contact, requirements: 'Newer version from another window' })
  await form.getByRole('button', { name: 'Export saved version', exact: true }).click()
  await form.getByRole('button', { name: 'Load latest version', exact: true }).waitFor()
  expect(await form.getByRole('button', { name: 'Export saved version', exact: true }).isDisabled()).toBe(true)
  await form.getByRole('button', { name: 'Load latest version', exact: true }).click()
  await form.getByText('Saved, not sent · Version 3', { exact: true }).waitFor()
  expect(await form.getByRole('textbox', { name: 'Requirements', exact: true }).inputValue()).toBe('Newer version from another window')
  await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/office-customization'), { recursive: true })
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-customization/request.expected.md'),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
  await page.screenshot({ path: join(artifacts, 'customization-small.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(artifacts, 'customization-dark.png'), animations: 'disabled' })
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
