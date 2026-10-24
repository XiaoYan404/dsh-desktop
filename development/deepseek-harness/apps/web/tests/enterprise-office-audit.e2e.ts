/** Administrator audit filters, pagination and real NDJSON downloads run through generated Remotes and a central gateway. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import OfficeGateway from '@deepseek-ai/dsh-enterprise-office-gateway'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeController } from '@deepseek-ai/dsh-client-ui-office'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const admin = 'admin' as OfficeMemberId
const employee = 'lin' as OfficeMemberId
const backup = 'reviewer' as OfficeMemberId
const password = 'Audit browser password 2026!'

it('searches retained audit metadata, downloads every shown row and withdraws administrator results after sign-out and demotion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-audit-browser-'))
  onTestFinished(async () => {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-audit-browser-'))
      throw new Error('Unexpected audit browser cleanup root')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const server = new Context()
  onTestFinished(() => server.fiber.dispose())
  await server.plugin(Storage)
  await server.plugin(StorageJson, { root: join(root, 'data') })
  await server.plugin(StorageDomain, { backend: 'json' })
  await server.plugin(OfficeService, { companyName: 'Audit company', timeZone: 'Asia/Shanghai', dshHome: root, members: [
    { id: admin, name: 'Audit administrator', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
    { id: employee, name: 'Lin', department: 'Office', jobTitle: 'Employee', role: 'employee' },
    { id: backup, name: 'Second administrator', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
  ] })
  await server.office.initializeIdentity(admin, password)
  await server.office.setIdentityPassword(admin, employee, password)
  await server.office.setIdentityPassword(admin, backup, password)
  await server.plugin(OfficeGateway, { host: '127.0.0.1', port: 0, administratorId: admin, loginRequestsPerMinute: 100 })
  for (let index = 0; index < 25; index++)
    await server.office.createWork(admin, { kind: 'todo', title: `Private audit work ${index}`, date: '2026-10-19', ownerId: employee })
  const overlay = join(root, 'audit.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'enterprise-office', disabled: true },
    { id: 'ui-office', disabled: false, config: { principalId: '', gatewayUrl: server.officeGateway.address } },
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
  ]))
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.get('officeController') as OfficeController
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  await page.setViewportSize({ width: 1050, height: 800 })
  const console = watchConsole(page)
  const artifacts = resolve(REPO_ROOT, '../.local-run/enterprise-round144-audit-browser')
  await mkdir(artifacts, { recursive: true })
  onTestFailed(async () => {
    if (!page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png'), animations: 'disabled' })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, admin)
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  expect(await nav.locator(':scope > div').first().getByRole('button').count()).toBe(7)
  expect(await nav.getByRole('button', { name: 'Audit records', exact: true }).count()).toBe(0)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const actualPage = controller.auditPage.bind(controller)
  const delayed = vi.spyOn(controller, 'auditPage').mockImplementationOnce(async (query) => {
    const result = await actualPage(query)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  onTestFinished(() => { release.resolve(undefined); delayed.mockRestore() })
  await openAudit(page)
  const audit = page.getByRole('dialog', { name: 'Audit records', exact: true })
  await entered.promise
  await audit.getByRole('status', { name: 'Loading audit records', exact: true }).waitFor()
  await audit.getByRole('combobox', { name: 'Source', exact: true }).selectOption('business')
  await audit.getByLabel('Actor ID', { exact: true }).fill(admin)
  await audit.getByLabel('Action name', { exact: true }).fill('work_created')
  await audit.getByLabel('From (local time)', { exact: true }).fill('1990-01-01T00:00')
  await audit.getByLabel('Until (local time)', { exact: true }).fill('2090-01-01T00:00')
  await audit.getByRole('button', { name: 'Search records', exact: true }).click()
  await audit.getByText('Displayed / current matches: 20 / 25', { exact: true }).waitFor()
  release.resolve(undefined)
  delayed.mockRestore()
  const failure = vi.spyOn(controller, 'auditPage').mockResolvedValueOnce({ ok: false, code: 'closed' })
  await audit.getByRole('button', { name: 'Load more records', exact: true }).click()
  await audit.getByRole('alert').waitFor()
  expect(await audit.locator('tbody tr').count()).toBe(20)
  failure.mockRestore()
  await audit.getByRole('button', { name: 'Retry', exact: true }).click()
  await audit.getByText('Displayed / current matches: 25 / 25', { exact: true }).waitFor()
  const downloadEvent = page.waitForEvent('download')
  await audit.getByRole('button', { name: 'Download displayed records (NDJSON)', exact: true }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toBe('office-audit.ndjson')
  const downloadedPath = await download.path()
  if (!downloadedPath) throw new Error('Audit download did not create a file')
  const content = await readFile(downloadedPath, 'utf8')
  const records = content.trimEnd().split('\n').map((line): unknown => JSON.parse(line))
  expect(records).toEqual(server.office.auditPage(admin, { limit: 100, before: null,
    source: 'business', actorId: admin, action: 'work_created' }).entries)
  expect(content).not.toMatch(/Private audit work|tokenHash|digest|salt|password/)
  await audit.getByLabel('Target ID', { exact: true }).fill('no-audit-target')
  await audit.getByRole('button', { name: 'Search records', exact: true }).click()
  await audit.getByText('No matching audit records', { exact: true }).waitFor()
  const summary = [
    '# Administrator audit',
    `Sources: ${(await audit.getByRole('combobox', { name: 'Source', exact: true }).locator('option').allTextContents()).join(' | ')}`,
    `Filters: ${(await audit.locator('form label').evaluateAll(labels => labels.map(label => label.firstChild?.textContent ?? ''))).join(' | ')}`,
    `Empty: ${await audit.getByText('No matching audit records', { exact: true }).textContent()}`,
    `Download disabled: ${await audit.getByRole('button', { name: 'Download displayed records (NDJSON)', exact: true }).isDisabled()}`,
    `Load more visible: ${await audit.getByRole('button', { name: 'Load more records', exact: true }).isVisible()}`,
    `Primary navigation entries: ${await nav.locator(':scope > div').first().getByRole('button').count()}`,
    `Audit top-level navigation entries: ${await nav.getByRole('button', { name: 'Audit records', exact: true }).count()}`,
  ].join('\n')
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-audit/empty.expected.md'), summary, webSnapshotMode())
  await page.screenshot({ path: join(artifacts, 'light.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(artifacts, 'dark.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
  await audit.getByLabel('Target ID', { exact: true }).fill('')
  await audit.getByRole('button', { name: 'Search records', exact: true }).click()
  await audit.getByText('Displayed / current matches: 20 / 25', { exact: true }).waitFor()
  const exportEntered = Promise.withResolvers<undefined>()
  const exportRelease = Promise.withResolvers<undefined>()
  const actualExport = controller.auditExport.bind(controller)
  const slowExport = vi.spyOn(controller, 'auditExport').mockImplementationOnce(async (query) => {
    const result = await actualExport(query)
    exportEntered.resolve(undefined)
    await exportRelease.promise
    return result
  })
  onTestFinished(() => { exportRelease.resolve(undefined); slowExport.mockRestore() })
  const unexpectedDownloads: string[] = []
  page.on('download', item => unexpectedDownloads.push(item.suggestedFilename()))
  await audit.getByRole('button', { name: 'Download displayed records (NDJSON)', exact: true }).click()
  await exportEntered.promise
  await audit.getByRole('button', { name: 'Close', exact: true }).click()
  await signOut(page)
  exportRelease.resolve(undefined)
  slowExport.mockRestore()
  await signIn(page, employee)
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  const profile = page.getByRole('dialog', { name: 'Profile', exact: true })
  expect(await profile.getByRole('button', { name: 'Audit records', exact: true }).count()).toBe(0)
  await profile.getByRole('button', { name: 'Close', exact: true }).click()
  await signOut(page)
  await signIn(page, admin)
  await openAudit(page)
  await audit.getByRole('button', { name: 'Load more records', exact: true }).waitFor()
  const previous = server.office.view(admin).me
  await server.office.saveMember(backup, { ...previous, role: 'employee' }, previous)
  await audit.getByRole('button', { name: 'Load more records', exact: true }).click()
  await audit.waitFor({ state: 'hidden' })
  expect(await controller.auditExport({ limit: 1, before: null })).toEqual({ ok: false, code: 'forbidden' })
  expect(unexpectedDownloads).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

async function openAudit(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await page.getByRole('dialog', { name: 'Profile', exact: true }).getByRole('button', { name: 'Audit records', exact: true }).click()
}
async function signIn(page: Page, id: OfficeMemberId): Promise<void> {
  const form = page.getByRole('region', { name: 'Sign in to your company', exact: true })
  await form.getByLabel('Employee ID', { exact: true }).fill(id)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Profile', exact: true }).waitFor()
}
async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account and security', exact: true }).click()
  await page.getByRole('dialog', { name: 'Account and security', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('region', { name: 'Sign in to your company', exact: true }).waitFor()
}

it('filters authenticated request denials, exports their safe codes and denies non-administrators', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-audit-denial-'))
  onTestFinished(async () => {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-audit-denial-'))
      throw new Error('Unexpected audit-denial browser cleanup root')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const server = new Context()
  onTestFinished(() => server.fiber.dispose())
  await server.plugin(Storage)
  await server.plugin(StorageJson, { root: join(root, 'data') })
  await server.plugin(StorageDomain, { backend: 'json' })
  await server.plugin(OfficeService, { companyName: 'Denied-request audit company', timeZone: 'Asia/Shanghai', dshHome: root, members: [
    { id: admin, name: 'Audit administrator', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
    { id: employee, name: 'Lin', department: 'Office', jobTitle: 'Employee', role: 'employee' },
  ] })
  await server.office.initializeIdentity(admin, password)
  await server.office.setIdentityPassword(admin, employee, password)
  await server.plugin(OfficeGateway, { host: '127.0.0.1', port: 0, administratorId: admin, loginRequestsPerMinute: 100 })
  const overlay = join(root, 'audit-denial.patch.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'enterprise-office', disabled: true },
    { id: 'ui-office', disabled: false, config: { principalId: '', gatewayUrl: server.officeGateway.address } },
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
  ]))
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const controller = scaffold.ctx.get('officeController') as OfficeController
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  await page.setViewportSize({ width: 1050, height: 800 })
  const console = watchConsole(page)
  const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office/round156-audit-denials')
  await mkdir(artifacts, { recursive: true })
  onTestFailed(async () => {
    if (!page.isClosed()) await page.screenshot({ path: join(artifacts, 'failure.png'), animations: 'disabled' })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await signIn(page, employee)
  const previous = server.office.view(admin).me
  const bodyMarker = 'PRIVATE_REJECTED_MEMBER_BODY_R156'
  expect(await controller.saveMember({ ...previous, name: bodyMarker }, previous)).toEqual({ ok: false, code: 'forbidden' })
  expect(server.office.view(admin).me.name).toBe('Audit administrator')
  const query = { limit: 20, before: null, source: 'request_denial' as const, actorId: employee, action: 'saveMember' }
  expect(await controller.auditPage(query)).toEqual({ ok: false, code: 'forbidden' })
  expect(await controller.auditExport(query)).toEqual({ ok: false, code: 'forbidden' })
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  const profile = page.getByRole('dialog', { name: 'Profile', exact: true })
  expect(await profile.getByRole('button', { name: 'Audit records', exact: true }).count()).toBe(0)
  await profile.getByRole('button', { name: 'Close', exact: true }).click()
  await signOut(page)
  await signIn(page, admin)
  await openAudit(page)
  const audit = page.getByRole('dialog', { name: 'Audit records', exact: true })
  await audit.getByRole('combobox', { name: 'Source', exact: true }).selectOption('request_denial')
  await audit.getByLabel('Actor ID', { exact: true }).fill(employee)
  await audit.getByLabel('Action name', { exact: true }).fill('saveMember')
  await audit.getByRole('button', { name: 'Search records', exact: true }).click()
  await audit.getByText('Displayed / current matches: 1 / 1', { exact: true }).waitFor()
  await audit.getByRole('cell', { name: 'saveMember · Permission denied', exact: true }).waitFor()
  expect(await audit.getByRole('cell', { name: 'Request denials', exact: true }).count()).toBe(1)
  const downloadEvent = page.waitForEvent('download')
  await audit.getByRole('button', { name: 'Download displayed records (NDJSON)', exact: true }).click()
  const downloaded = await downloadEvent
  expect(downloaded.suggestedFilename()).toBe('office-audit.ndjson')
  const downloadedPath = await downloaded.path()
  if (!downloadedPath) throw new Error('Denial audit download did not create a file')
  const content = await readFile(downloadedPath, 'utf8')
  const records = content.trimEnd().split('\n').map((line): unknown => JSON.parse(line))
  expect(records).toEqual(server.office.auditPage(admin, { ...query, limit: 100 }).entries)
  expect(records).toEqual([expect.objectContaining({ source: 'request_denial', actorId: employee,
    targetId: admin, action: 'saveMember', denialCode: 'forbidden' })])
  for (const record of records) {
    if (record === null || typeof record !== 'object') throw new Error('Denial audit export contains an invalid row')
    expect(Object.keys(record).sort()).toEqual(['action', 'actorId', 'denialCode', 'revision', 'source', 'targetId', 'time'])
  }
  expect(content.includes(bodyMarker)).toBe(false)
  expect(content.includes(password)).toBe(false)
  expect(content).not.toMatch(/tokenHash|credential|authorization|digest|salt|password|requestBody|"name"/)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
