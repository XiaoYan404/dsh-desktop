/** Central reminder delivery crosses actual Host timers, generated Remotes and the employee inbox. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-enterprise-office'
import type {} from '@deepseek-ai/dsh-schedule'
import type { OfficeController } from '@deepseek-ai/dsh-client-ui-office'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const actor = 'local' as OfficeMemberId
const title = 'delivers central reminders into the real inbox, persists reads and removes cancelled occurrences without Native schedule jobs'

it(title, async () => {
  let now = Date.parse('2026-10-19T02:00:00Z')
  const started = performance.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + Math.floor(performance.now() - started))
  onTestFinished(() => { clock.mockRestore() })
  const artifacts = join(REPO_ROOT, '.artifacts', 'enterprise-office', 'round159-reminders', 'browser')
  await mkdir(artifacts, { recursive: true })
  const overlay = join(artifacts, 'office.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'enterprise-office', disabled: false, config: { companyName: 'Reminder browser company', timeZone: 'Asia/Shanghai',
      members: [{ id: 'admin', name: 'Administrator', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
        { id: actor, name: 'Reminder employee', department: 'Operations', jobTitle: 'Employee', role: 'employee' }],
      reminders: { pollIntervalMs: 50, catchUpWindowMs: 3_600_000, maxEntries: 100, maxBytes: 1_048_576 } } },
    { id: 'ui-office', disabled: false, config: { principalId: actor } },
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
  ]))
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  let modelRequests = 0
  const stopModel = scaffold.ctx.on('llm/stream', (_request, next) => { modelRequests++; return next() }, { prepend: true })
  onTestFinished(() => { stopModel() })
  const office = scaffold.ctx.office
  const due = await office.createWork(actor, { kind: 'todo', title: 'Review the due contract', date: '2026-10-19', time: '09:59', ownerId: actor })
  const later = await office.createWork(actor, { kind: 'task', title: 'Review the next report', date: '2026-10-19', time: '10:01', ownerId: actor })
  const meeting = await office.createSchedule(actor, { title: 'Ongoing team planning', date: '2026-10-19',
    startTime: '09:55', endTime: '10:30', inviteeIds: [] })
  await expect.poll(() => office.view(actor).reminders?.entries.length).toBe(2)
  const businessPath = join(scaffold.workspaceCwd, '.dsh-storages', 'enterprise_office.json')
  const reminderPath = join(scaffold.workspaceCwd, '.dsh-storages', 'enterprise_office_reminders.json')
  const businessBeforeRead = await readFile(businessPath)
  expect(await scaffold.ctx.schedule.catalog()).toEqual([])
  const controller = scaffold.ctx.get('officeController') as OfficeController
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(async () => {
    if (!page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png'), animations: 'disabled' })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Calendar', exact: true }).click()
  const date = main.getByLabel('Date', { exact: true })
  await date.fill('2026-10-18')
  const notifications = main.getByRole('button', { name: 'Notifications', exact: true })
  await notifications.click()
  const inbox = page.getByRole('dialog', { name: 'Notifications', exact: true })
  const dueRow = inbox.getByRole('button').filter({ hasText: due.title }).filter({ hasText: 'Work is due' })
  const laterRow = inbox.getByRole('button').filter({ hasText: later.title }).filter({ hasText: 'Work is due' })
  const meetingRow = inbox.getByRole('button').filter({ hasText: meeting.title }).filter({ hasText: 'Meeting has started' })
  await dueRow.waitFor({ state: 'visible' })
  expect(await dueRow.textContent()).toContain('Work is due · Unread')
  expect(await meetingRow.textContent()).toContain('Meeting has started · Unread')
  expect(await laterRow.count()).toBe(0)
  expect(await inbox.getByText('Reminder employee', { exact: true }).count()).toBe(0)
  now += 2 * 60_000
  await laterRow.waitFor({ state: 'visible', timeout: 10_000 })
  expect(await date.inputValue()).toBe('2026-10-18')
  const originalReminder = office.view(actor).reminders?.entries.find(entry => entry.itemId === due.id)
  if (!originalReminder) throw new Error('Expected the actual delivered reminder')
  const reminderBeforeRead = await readFile(reminderPath)
  const acknowledge = vi.spyOn(controller, 'markReminderRead').mockResolvedValueOnce({ ok: false, code: 'closed' })
  onTestFinished(() => { acknowledge.mockRestore() })
  await dueRow.click()
  await page.getByText('The office service closed; reconnect to continue', { exact: true }).waitFor()
  expect(await page.getByRole('dialog', { name: 'Work details', exact: true }).count()).toBe(0)
  expect(office.view(actor).reminders?.entries.find(entry => entry.id === originalReminder.id)?.read).toBe(false)
  expect(await readFile(reminderPath)).toEqual(reminderBeforeRead)
  await dueRow.click()
  const detail = page.getByRole('dialog', { name: 'Work details', exact: true })
  await detail.waitFor({ state: 'visible' })
  expect(acknowledge.mock.calls.map(([id]) => id)).toEqual([originalReminder.id, originalReminder.id])
  expect(office.view(actor).reminders?.entries.find(entry => entry.id === originalReminder.id)?.read).toBe(true)
  expect(await readFile(reminderPath)).not.toEqual(reminderBeforeRead)
  expect(await readFile(businessPath)).toEqual(businessBeforeRead)
  await detail.getByRole('button', { name: 'Close', exact: true }).click()
  await page.reload({ waitUntil: 'load' })
  await notifications.click()
  await dueRow.waitFor({ state: 'visible' })
  expect(await dueRow.textContent()).toContain('Work is due · Read')
  await inbox.getByRole('button', { name: 'Unread only', exact: true }).click()
  expect(await dueRow.count()).toBe(0)
  await meetingRow.waitFor({ state: 'visible' })
  await laterRow.waitFor({ state: 'visible' })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.screenshot({ path: join(artifacts, `inbox-${theme}.png`), animations: 'disabled' })
  }
  await office.setStatus(actor, meeting.id, meeting.revision, 'cancelled')
  await meetingRow.waitFor({ state: 'detached' })
  await laterRow.waitFor({ state: 'visible' })
  const final = office.view(actor).reminders?.entries
  expect(final?.map(entry => entry.itemId).sort()).toEqual([due.id, later.id].sort())
  expect(final?.find(entry => entry.id === originalReminder.id)?.read).toBe(true)
  expect(await scaffold.ctx.schedule.catalog()).toEqual([])
  expect(modelRequests).toBe(0)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify({ title,
    task: 'T088', companyTimeZone: 'Asia/Shanghai', items: { due: due.id, later: later.id, meeting: meeting.id },
    originalReminderId: originalReminder.id, acknowledgementCalls: acknowledge.mock.calls.length,
    failedAcknowledgementRetainedBytes: true, businessBytesUnchangedByReads: true,
    selectedDatePreservedByDelivery: true, readSurvivedPageReload: true, cancelledOccurrenceHidden: true,
    nativeScheduleJobs: 0, modelRequests, browserErrors: console.pageErrors, browserWarnings: console.warnings,
  }, null, 2) + '\n')
})
