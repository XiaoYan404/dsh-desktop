/** Real office time decisions cross the Host/Remote/browser path without model calls or status writes. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Locator } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeController } from '@deepseek-ai/dsh-client-ui-office'
import type { OfficeItem, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const title = 'renders server company-time overdue warnings, meeting phases and isolated review markers despite a different browser clock'
const actor = 'local' as OfficeMemberId
const artifacts = join(REPO_ROOT, '.artifacts', 'enterprise-office', 'calendar-time-browser')
const hostAnchor = Date.parse('2026-11-01T05:30:00Z')
const browserAnchor = Date.parse('2000-01-01T00:00:00Z')

async function badge(row: Locator, label: string): Promise<void> {
  const target = row.getByLabel(`Company time status: ${label}`, { exact: true })
  await target.waitFor({ state: 'visible', timeout: 10_000 })
  expect(await target.textContent()).toBe(label)
}

it(title, async () => {
  const started = performance.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => hostAnchor + Math.floor(performance.now() - started))
  onTestFinished(() => { clock.mockRestore() })
  await mkdir(artifacts, { recursive: true })
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: join(artifacts, 'office.patch.json') })
  onTestFinished(() => scaffold.close())
  let modelRequests = 0
  const stop = scaffold.ctx.on('llm/stream', (_request, next) => { modelRequests++; return next() }, { prepend: true })
  onTestFinished(() => { stop() })
  const office = scaffold.ctx.office
  const overdue = await office.createWork(actor, { kind: 'task', title: 'Server overdue task', date: '2026-11-01', time: '01:00', ownerId: actor })
  const future = await office.createWork(actor, { kind: 'todo', title: 'Server future to-do', date: '2026-11-01', time: '01:45', ownerId: actor })
  const untimed = await office.createWork(actor, { kind: 'todo', title: 'Whole company day', date: '2026-11-01', ownerId: actor })
  const completed = await office.createWork(actor, { kind: 'task', title: 'Closed completed work', date: '2026-10-31', ownerId: actor, status: 'completed' })
  const cancelled = await office.createWork(actor, { kind: 'todo', title: 'Closed cancelled work', date: '2026-10-31', ownerId: actor, status: 'cancelled' })
  const gap = await office.createWork(actor, { kind: 'task', title: 'Stored DST gap', date: '2026-03-08', time: '02:30', ownerId: actor })
  const overflow = await office.createWork(actor, { kind: 'todo', title: 'Stored upper date boundary', date: '9999-12-31', ownerId: actor })
  const ended = await office.createSchedule(actor, { title: 'Server ended meeting', date: '2026-11-01', startTime: '00:30', endTime: '01:00', inviteeIds: [] })
  const ongoing = await office.createSchedule(actor, { title: 'Server ongoing overlap meeting', date: '2026-11-01', startTime: '01:15', endTime: '01:45', inviteeIds: [] })
  const upcoming = await office.createSchedule(actor, { title: 'Server upcoming meeting', date: '2026-11-01', startTime: '02:15', endTime: '02:45', inviteeIds: [] })
  const items = [overdue, future, untimed, completed, cancelled, gap, overflow, ended, ongoing, upcoming]
  const storagePath = join(scaffold.workspaceCwd, '.dsh-storages', 'enterprise_office.json')
  const before = await readFile(storagePath)
  const controller = scaffold.ctx.get('officeController') as OfficeController
  const ready = await controller.view()
  if (!ready.ok) throw new Error(`Calendar preparation failed: ${ready.code}`)
  expect(ready.value.me.id).toBe(actor)
  expect(ready.value.timeZone).toBe('America/New_York')
  expect(ready.value.calendarTime?.items.map(item => item.itemId).sort()).toEqual(items.map(item => item.id).sort())
  const prepared = new Map(ready.value.calendarTime?.items.map(item => [item.itemId, item]))
  expect(prepared.get(overdue.id)).toMatchObject({ kind: 'work', overdue: true })
  for (const item of [future, untimed, completed, cancelled]) expect(prepared.get(item.id)).toMatchObject({ kind: 'work', overdue: false })
  for (const item of [gap, overflow]) expect(prepared.get(item.id)).toEqual({ itemId: item.id, kind: 'unresolved' })
  for (const [item, phase] of [[ended, 'ended'], [ongoing, 'ongoing'], [upcoming, 'upcoming']] as const)
    expect(prepared.get(item.id)).toMatchObject({ kind: 'schedule', phase })

  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  await page.clock.setFixedTime(browserAnchor)
  const console = watchConsole(page)
  onTestFailed(async () => {
    if (!page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png'), animations: 'disabled' })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const clientClock = await page.evaluate(() => ({ now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }))
  expect(clientClock).toEqual({ now: browserAnchor, timeZone: 'Asia/Shanghai' })
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  const main = page.getByRole('main')
  const row = (item: OfficeItem) => main.locator(`[data-office-item="${item.id}"]`)
  await nav.getByRole('button', { name: 'Work', exact: true }).click()
  await row(overdue).waitFor({ state: 'visible' })
  await badge(row(overdue), 'Overdue')
  for (const item of [future, untimed, completed, cancelled]) {
    await row(item).waitFor({ state: 'visible' })
    expect(await row(item).locator('[data-office-time]').count()).toBe(0)
  }
  for (const item of [gap, overflow]) await badge(row(item), 'Time needs review')
  expect(await main.getByRole('alert').count()).toBe(0)

  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'dark' ? '' : null)
    await row(overdue).scrollIntoViewIfNeeded()
    await badge(row(overdue), 'Overdue')
    await page.screenshot({ path: join(artifacts, `work-${theme}.png`), animations: 'disabled' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await row(overdue).click()
  const detail = page.getByRole('dialog', { name: 'Work details', exact: true })
  await badge(detail, 'Overdue')
  expect(await detail.locator('dd').filter({ hasText: 'America/New_York' }).count()).toBe(1)
  expect(await detail.getByRole('combobox', { name: 'Status', exact: true }).inputValue()).toBe('pending')
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  for (const item of [gap, overflow]) {
    await row(item).click()
    await badge(detail, 'Time needs review')
    await detail.getByRole('button', { name: 'Close', exact: true }).click()
  }
  await row(future).click()
  await detail.waitFor({ state: 'visible' })
  expect(await detail.locator('[data-office-time]').count()).toBe(0)
  await detail.getByRole('button', { name: 'Close', exact: true }).click()

  await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
  await main.getByRole('button', { name: 'Calendar', exact: true }).click()
  await expect.poll(() => main.getByLabel('Date', { exact: true }).inputValue()).toBe('2026-11-01')
  for (const [item, label] of [[ended, 'Ended'], [ongoing, 'In progress'], [upcoming, 'Not started']] as const) await badge(row(item), label)
  await row(ongoing).click()
  await badge(detail, 'In progress')
  expect(await detail.getByRole('combobox', { name: 'Status', exact: true }).inputValue()).toBe('pending')
  await page.screenshot({ path: join(artifacts, 'meeting-detail.png'), animations: 'disabled' })
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await page.screenshot({ path: join(artifacts, 'meeting-phases.png'), animations: 'disabled' })

  expect(await readFile(storagePath)).toEqual(before)
  for (const item of items) expect(office.getItem(actor, item.id).status).toBe(item.status)
  expect(modelRequests).toBe(0)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify({
    title, task: 'T088', companyTimeZone: ready.value.timeZone, serverCheckedAt: ready.value.calendarTime?.checkedAt,
    browser: clientClock, work: ['Overdue', 'future/untimed/closed: no warning', 'Time needs review'],
    meetings: ['Not started', 'In progress', 'Ended'], retainedStatuses: items.map(item => ({ title: item.title, status: item.status })),
    storageUnchanged: true, modelRequests, browserErrors: console.pageErrors, browserWarnings: console.warnings,
  }, null, 2) + '\n')
})
