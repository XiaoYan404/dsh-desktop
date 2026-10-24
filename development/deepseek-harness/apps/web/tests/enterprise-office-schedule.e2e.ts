/** Schedule overlap advice through real office records and the shipped workbench. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

it('advises on visible attendance overlaps while preserving private calendars, edits and explicit submission', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const actor = 'local' as OfficeMemberId
  const owner = 'owner' as OfficeMemberId
  const peer = 'schedule_peer' as OfficeMemberId
  const service = scaffold.ctx.office
  await service.saveMember(owner, { ...service.view(actor).me, id: peer, name: 'Schedule colleague' }, null)
  const date = '2026-10-20'
  const schedule = { date, startTime: '10:00', endTime: '11:00' }
  const own = await service.createSchedule(actor, { ...schedule, title: 'Own busy meeting', inviteeIds: [] })
  let shared = await service.createSchedule(owner, { ...schedule, title: 'Shared colleague meeting', inviteeIds: [actor, peer] })
  shared = await service.reply(actor, shared.id, shared.revision, 'declined')
  let declined = await service.createSchedule(owner, { ...schedule, title: 'Declined meeting', inviteeIds: [actor, peer] })
  declined = await service.reply(actor, declined.id, declined.revision, 'declined')
  declined = await service.reply(peer, declined.id, declined.revision, 'declined')
  const closed = await service.createSchedule(actor, { ...schedule, title: 'Closed meeting', inviteeIds: [peer] })
  await service.setStatus(actor, closed.id, closed.revision, 'cancelled')
  const hidden = await service.createSchedule(peer, { ...schedule, title: 'Hidden payroll review', inviteeIds: [] })
  expect(service.view(actor).items.some(item => item.id === hidden.id)).toBe(false)
  const before = service.view(actor).revision
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-schedule-overlaps'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'New event', exact: true }).first().click()
  let dialog = page.getByRole('dialog', { name: 'New event', exact: true })
  await dialog.getByLabel('Title', { exact: true }).fill('Deliberately overlapping event')
  await dialog.getByLabel('Date', { exact: true }).fill(date)
  await dialog.getByLabel('Start time', { exact: true }).fill('10:30')
  await dialog.getByLabel('End time', { exact: true }).fill('11:30')
  let check = dialog.getByRole('region', { name: 'Schedule time check', exact: true })
  await check.getByText('Own busy meeting · 10:00–11:00', { exact: true }).waitFor()
  expect(await check.getByText('Shared colleague meeting · 10:00–11:00', { exact: true }).count()).toBe(0)
  await dialog.getByRole('checkbox', { name: /Schedule colleague/ }).check()
  await check.getByText('Shared colleague meeting · 10:00–11:00', { exact: true }).waitFor()
  expect(await check.getByRole('listitem').count()).toBe(2)
  expect(await check.textContent()).not.toContain('Declined meeting')
  expect(await check.textContent()).not.toContain('Closed meeting')
  expect(await dialog.textContent()).not.toContain('Hidden payroll review')
  expect(await check.getByRole('listitem').filter({ hasText: 'Shared colleague meeting' }).textContent()).toContain('Schedule colleague')
  const overlapAria = await check.ariaSnapshot()
  await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
  await writeFile(join(REPO_ROOT, '.artifacts/enterprise-office/schedule-overlaps.aria.md'), `${overlapAria}\n`)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: theme === 'light' ? 1440 : 800, height: 720 })
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds?.y).toBeGreaterThanOrEqual(24)
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(696)
    await check.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(REPO_ROOT, `.artifacts/enterprise-office/schedule-overlaps-${theme}.png`), animations: 'disabled' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await dialog.getByRole('checkbox', { name: /Schedule colleague/ }).uncheck()
  expect(await check.getByRole('listitem').count()).toBe(1)
  await dialog.getByLabel('Start time', { exact: true }).fill('09:00')
  await dialog.getByLabel('End time', { exact: true }).fill('10:00')
  expect(await check.getByRole('listitem').count()).toBe(0)
  await dialog.getByLabel('Start time', { exact: true }).fill('10:30')
  await dialog.getByLabel('End time', { exact: true }).fill('11:30')
  await dialog.getByRole('checkbox', { name: /Schedule colleague/ }).check()
  await dialog.getByLabel('Date', { exact: true }).fill('2026-10-21')
  expect(await check.getByRole('listitem').count()).toBe(0)
  await dialog.getByLabel('Date', { exact: true }).fill(date)
  expect(await check.getByRole('listitem').count()).toBe(2)
  expect(service.view(actor).revision).toBe(before)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const created = service.view(actor).items.find(item => item.title === 'Deliberately overlapping event')!
  expect(created).toMatchObject({ time: '10:30', endTime: '11:30', date, revision: 1 })
  await page.getByRole('button', { name: 'Calendar', exact: true }).click()
  await page.getByLabel('Date', { exact: true }).fill(date)
  await page.locator(`[data-office-item="${created.id}"]`).click()
  await page.getByRole('dialog', { name: 'Work details', exact: true }).getByRole('button', { name: 'Edit event', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Edit event', exact: true })
  check = dialog.getByRole('region', { name: 'Schedule time check', exact: true })
  expect(await check.getByRole('listitem').count()).toBe(2)
  expect(await check.textContent()).not.toContain(created.title)
  shared = await service.setStatus(owner, shared.id, shared.revision, 'cancelled')
  await expect.poll(() => check.getByRole('listitem').count()).toBe(1)
  expect(await dialog.getByLabel('Title', { exact: true }).inputValue()).toBe(created.title)
  await dialog.getByLabel('Start time', { exact: true }).fill('11:00')
  await dialog.getByLabel('End time', { exact: true }).fill('12:00')
  expect(await check.getByRole('listitem').count()).toBe(0)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(service.getItem(actor, created.id)).toEqual(created)
  expect(service.getItem(actor, own.id)).toEqual(own)
  expect(service.getItem(owner, shared.id)).toEqual(shared)
  expect(service.getItem(owner, declined.id)).toEqual(declined)
  expect(service.getItem(peer, hidden.id)).toEqual(hidden)
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-schedule-overlaps/visible.expected.md'), overlapAria, webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
