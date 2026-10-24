/** Private association editing through actual native inputs, current identities and durable office storage. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type { OfficeConversationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const actor = 'local' as OfficeMemberId
const owner = 'owner' as OfficeMemberId

async function fixture() {
  const scaffold = await launchWebScaffold({ extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const serviceEntry = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-enterprise-office')!
  const controller = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-office')!
  await scaffold.ctx.configEditor.edit(serviceEntry, current => ({ ...current,
    conversationToolDependencies: { 'template:minutes': ['company-oa', 'missing-archive'] },
  }))
  await scaffold.ctx.loader.await()
  const integrations = []
  for (const [name, system] of [['company-oa', 'Company OA'], ['company-crm', 'Company CRM']]) {
    integrations.push(await scaffold.ctx.office.importIntegration(owner, { requestId: randomUUID(), json: JSON.stringify({
      name, system, version: '1.0.0', provider: 'Company', description: `${system} office integration`, capabilities: ['Office lookup'],
    }) }))
  }
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  const messages: SessionEvent[] = []
  const stop = scaffold.ctx.on('session/event', (_session, event: SessionEvent) => {
    if (event.type === 'user/message' && event.data.source.kind === 'user') messages.push(event)
  })
  onTestFinished(() => { stop() })
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-associations'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  const region = page.getByRole('region', { name: 'Association details', exact: true })
  await expect.poll(() => region.getByRole('button', { name: 'Link integrations', exact: true }).isEnabled()).toBe(true)
  const current = async () => {
    const id = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
    if (!id) throw new Error('Native conversation was not selected')
    return id as OfficeConversationId
  }
  return { scaffold, serviceEntry, controller, page, nav, region, current, console, integrations, messages }
}

it('searches and saves multiple associations, resolves declared dependencies and explicitly unlinks a required integration', async () => {
  const { scaffold, page, region, current, console, integrations } = await fixture()
  await region.getByRole('button', { name: 'Link integrations', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Link integrations', exact: true })
  const search = dialog.getByRole('searchbox', { name: 'Search systems or tools', exact: true })
  await search.fill('CRM')
  expect(await dialog.getByRole('checkbox').count()).toBe(1)
  await dialog.getByRole('checkbox', { name: 'Company CRM', exact: true }).check()
  await search.fill('OA')
  await dialog.getByRole('checkbox', { name: 'Company OA', exact: true }).check()
  await dialog.getByRole('button', { name: 'Save associations', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const id = await current()
  expect((await scaffold.ctx.office.conversationLinks(actor, id)).selection.integrations).toHaveLength(2)
  await region.getByRole('button', { name: 'Unlink: Company OA', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Link integrations', exact: true })
  await dialog.getByRole('button', { name: 'Save associations', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await region.getByRole('button', { name: 'Link tools', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Link tools', exact: true })
  await dialog.getByRole('checkbox', { name: 'Meeting minutes', exact: true }).check()
  await dialog.getByText('Missing system registrations: missing-archive', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Save associations', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect((await scaffold.ctx.office.conversationLinks(actor, id)).selection.integrations).toContain(integrations[0]!.id)
  await region.getByRole('button', { name: 'Meeting minutes', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Association details', exact: true })
  await dialog.getByText('Company OA · Connection not configured', { exact: true }).waitFor()
  await dialog.getByLabel('Close', { exact: true }).click()
  await region.getByRole('button', { name: 'Unlink: Company OA', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Link integrations', exact: true })
  expect(await dialog.getByRole('checkbox', { name: 'Company OA', exact: true }).isChecked()).toBe(false)
  await dialog.getByRole('button', { name: 'Save associations', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await region.getByText('Required systems are not linked: Company OA', { exact: true }).waitFor()
  expect((await scaffold.ctx.office.conversationLinks(actor, id)).selection).toMatchObject({
    integrations: [integrations[1]!.id], tools: [{ kind: 'template', name: 'minutes' }], revision: 4,
  })
  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'associations-light.png'), fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
  await region.getByRole('button', { name: 'Link tools', exact: true }).click()
  await page.screenshot({ path: join(shots, 'associations-dark.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 1040, height: 700 })
  dialog = page.getByRole('dialog', { name: 'Link tools', exact: true })
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const bounds = await dialog.boundingBox()
  expect(bounds?.y).toBeGreaterThanOrEqual(24)
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(676)
  const saveBounds = await dialog.getByRole('button', { name: 'Save associations', exact: true }).boundingBox()
  expect(saveBounds?.y).toBeGreaterThanOrEqual(bounds?.y ?? 0)
  expect((saveBounds?.y ?? 0) + (saveBounds?.height ?? 0)).toBeLessThanOrEqual(676)
  await page.screenshot({ path: join(shots, 'associations-small.png'), fullPage: true, animations: 'disabled' })
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('retains an uncertain save for the original retry and requires explicit adoption of a competing selection', async () => {
  const { scaffold, page, region, current, console } = await fixture()
  const service = scaffold.ctx.office
  const original = service.saveConversationLinks.bind(service)
  const saved = vi.spyOn(service, 'saveConversationLinks').mockImplementationOnce(async (principal, input) => {
    await original(principal, input)
    throw new Error('Expected lost association acknowledgement')
  })
  onTestFinished(() => { saved.mockRestore() })
  await region.getByRole('button', { name: 'Link tools', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Link tools', exact: true })
  await dialog.getByRole('checkbox', { name: 'PDF processing', exact: true }).check()
  await dialog.getByRole('button', { name: 'Save associations', exact: true }).click()
  await dialog.getByText('Save is unconfirmed. Retry the original selection. Closing does not undo a possible commit.', { exact: true }).waitFor()
  expect(await dialog.getByRole('checkbox', { name: 'PDF processing', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('button', { name: 'Retry original selection', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect(saved).toHaveBeenCalledTimes(2)
  expect(saved.mock.calls[1]?.[1]).toEqual(saved.mock.calls[0]?.[1])
  const id = await current()
  expect((await service.conversationLinks(actor, id)).selection.revision).toBe(1)
  await region.getByRole('button', { name: 'Link tools', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Link tools', exact: true })
  await dialog.getByRole('checkbox', { name: 'Document writing', exact: true }).check()
  await service.saveConversationLinks(actor, { conversationId: id, kind: 'tools', revision: 1, requestId: randomUUID(),
    tools: [{ kind: 'template', name: 'reminder' }] })
  await dialog.getByText('Associations changed in another window. Load the latest choices before reviewing again.', { exact: true }).waitFor()
  expect(await dialog.getByRole('checkbox', { name: 'Document writing', exact: true }).isChecked()).toBe(true)
  expect(await dialog.getByRole('button', { name: 'Save associations', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('button', { name: 'Load latest associations', exact: true }).click()
  expect(await dialog.getByRole('checkbox', { name: 'Document writing', exact: true }).isChecked()).toBe(false)
  expect(await dialog.getByRole('checkbox', { name: 'Work reminders', exact: true }).isChecked()).toBe(true)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(console.pageErrors).toEqual([])
})

it('restores independent ordinary and item choices after navigation and a browser reload without sending a message', async () => {
  const { scaffold, page, nav, region, current, console, messages } = await fixture()
  const ordinary = await current()
  await region.getByRole('button', { name: 'Link integrations', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Link integrations', exact: true })
  await dialog.getByRole('checkbox', { name: 'Company CRM', exact: true }).check()
  await dialog.getByRole('button', { name: 'Save associations', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const item = await scaffold.ctx.office.createWork(actor, { kind: 'task', title: 'Association item', description: 'Separate choices',
    date: scaffold.ctx.office.view(actor).day.date, ownerId: actor })
  await nav.getByRole('button', { name: 'Work', exact: true }).click()
  await page.locator(`[data-office-item="${item.id}"]`).click()
  await page.getByRole('dialog', { name: 'Work details', exact: true })
    .getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  await page.getByRole('complementary', { name: 'Item context', exact: true }).waitFor()
  const linked = await current()
  expect(linked).not.toBe(ordinary)
  await region.getByRole('button', { name: 'Link tools', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Link tools', exact: true })
  await dialog.getByRole('checkbox', { name: 'PDF processing', exact: true }).check()
  await dialog.getByRole('button', { name: 'Save associations', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await expect.poll(current).toBe(ordinary)
  await region.getByRole('button', { name: 'Company CRM · Connection not configured', exact: true }).waitFor()
  expect(await region.getByRole('button', { name: 'PDF processing', exact: true }).count()).toBe(0)
  const warnings = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await expect.poll(current).toBe(ordinary)
  await region.getByRole('button', { name: 'Company CRM · Connection not configured', exact: true }).waitFor()
  expect((await scaffold.ctx.office.conversationLinks(actor, linked)).selection.tools).toEqual([{ kind: 'template', name: 'pdf' }])
  expect(messages).toEqual([])
  acknowledgeReloadConnectionLoss(console, warnings)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['role', 'account'] as const)('closes a private selection form and fences its late acknowledgement on %s replacement', async (change) => {
  const { scaffold, controller, page, nav, region, console } = await fixture()
  await region.getByRole('button', { name: 'Link tools', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Link tools', exact: true })
  await dialog.getByRole('checkbox', { name: 'PDF processing', exact: true }).check()
  const release = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const service = scaffold.ctx.office
  const original = service.saveConversationLinks.bind(service)
  const held = vi.spyOn(service, 'saveConversationLinks').mockImplementationOnce(async (principal, input) => {
    entered.resolve(undefined)
    await release.promise
    return original(principal, input)
  })
  onTestFinished(() => { release.resolve(undefined); held.mockRestore() })
  await dialog.getByRole('button', { name: 'Save associations', exact: true }).click()
  await entered.promise
  if (change === 'role') {
    const member = service.view(owner).members.find(value => value.id === actor)!
    await service.saveMember(owner, { ...member, role: 'admin' }, member)
  } else {
    await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: owner }))
  }
  const identity = service.view(change === 'role' ? actor : owner).me
  await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent(), { timeout: 10_000 }).toContain(identity.name)
  await dialog.waitFor({ state: 'hidden' })
  release.resolve(undefined)
  await expect.poll(() => held.mock.settledResults[0]?.type).toBe('fulfilled')
  if (change === 'account') {
    await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
    expect(await region.getByRole('button', { name: 'PDF processing', exact: true }).count()).toBe(0)
  }
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
