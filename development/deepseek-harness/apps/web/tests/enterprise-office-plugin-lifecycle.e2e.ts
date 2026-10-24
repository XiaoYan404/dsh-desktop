/** Actual profile package and Loader lifecycle reached from company integrations; only pnpm is controlled. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { z } from 'zod'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const packageName = '@fixture/office-connector'
const owner = 'owner' as OfficeMemberId
const fixturePackage = join(REPO_ROOT, 'apps/web/tests/fixtures/plugins/office-connector-bundle')

async function setup(installed: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-plugin-lifecycle-'))
  onTestFinished(async () => {
    const actual = resolve(root)
    if (!actual.startsWith(resolve(tmpdir()) + sep) || !actual.includes('dsh-office-plugin-lifecycle-')) {
      throw new Error('Unexpected fixture cleanup root')
    }
    await rm(actual, { recursive: true, force: true })
  })
  const overlay = join(root, 'manager.patch.yml')
  await writeFile(overlay, `- id: plugin-manager\n  config: ${JSON.stringify({ pnpmCommand: process.execPath })}\n`)
  const scaffold = await launchWebScaffold({ extraOverlayPath: [join(REPO_ROOT, 'enterprise-workbench.patch.yml'), overlay],
    profile: { packages: installed ? [{ dir: fixturePackage }] : [] } })
  onTestFinished(() => scaffold.close())
  const profile = join(scaffold.harnessHome, 'profiles/scaffold')
  await writeFile(join(profile, 'config'), 'console.log("https://registry.npmjs.org/")\n')
  await writeFile(join(profile, '.office-version'), '0.0.1')
  await writeFile(join(profile, 'view'), `const fs = require('node:fs');
console.log(JSON.stringify({ name: ${JSON.stringify(packageName)}, version: fs.readFileSync('.office-version', 'utf8'),
  dsh: { bundle: { patch: './cordis.patch.yml' } } }));\n`)
  await writeFile(join(profile, 'add'), `const fs = require('node:fs'); const path = require('node:path');
const packageName = ${JSON.stringify(packageName)};
const target = path.resolve('node_modules', packageName);
if (!target.startsWith(path.resolve('node_modules') + path.sep)) throw new Error('Unexpected package destination');
fs.cpSync(${JSON.stringify(fixturePackage)}, target, { recursive: true });
const version = fs.readFileSync('.office-version', 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ ...manifest, version }));
const entry = path.join(target, 'index.js');
fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace("'0.0.1'", JSON.stringify(version)));
const profile = JSON.parse(fs.readFileSync('package.json', 'utf8'));
fs.writeFileSync('package.json', JSON.stringify({ ...profile, dependencies: { ...profile.dependencies, [packageName]: version } }));
console.log('Fixture package installed');\n`)
  await writeFile(join(profile, 'remove'), `const fs = require('node:fs'); const path = require('node:path');
const packageName = ${JSON.stringify(packageName)};
const target = path.resolve('node_modules', packageName);
if (!target.startsWith(path.resolve('node_modules') + path.sep)) throw new Error('Unexpected package removal');
fs.rmSync(target, { recursive: true, force: true });
const profile = JSON.parse(fs.readFileSync('package.json', 'utf8'));
delete profile.dependencies[packageName];
fs.writeFileSync('package.json', JSON.stringify(profile));
console.log('Fixture package removed');\n`)
  const controller = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-office')!
  const service = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-enterprise-office')!
  await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: owner,
    connectorPackages: { 'office-lifecycle': packageName } }))
  await scaffold.ctx.configEditor.edit(service, current => ({ ...current,
    connectorAllowedOrigins: [new URL(scaffold.baseUrl).origin] }))
  await scaffold.ctx.loader.await()
  const reads: string[] = []
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path: '/company-lifecycle/health', handler(request, response) {
    reads.push(request.method ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ summary: 'Actual company HTTP fields', entries: [{ label: 'Open work', value: '9' }] }))
  } }))
  const integration = await scaffold.ctx.office.importIntegration(owner, { requestId: randomUUID(), json: JSON.stringify({
    name: 'lifecycle-company-system', system: 'Lifecycle OA', version: '1.0.0', provider: 'Fixture company',
    description: 'A company system with independently managed adapter code', capabilities: ['Read company data'],
  }) })
  const connectionInput = { integrationId: integration.id, revision: 0, requestId: randomUUID(),
    adapterId: 'office-lifecycle', baseUrl: new URL('/company-lifecycle/', scaffold.baseUrl).href, probePath: 'health',
    authentication: { kind: 'none' as const }, enabled: true }
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(async () => {
    if (page.isClosed()) return
    const directory = join(REPO_ROOT, '.artifacts/enterprise-office')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'plugin-lifecycle-failure.txt'), await page.locator('body').innerText())
    await writeFile(join(directory, 'plugin-lifecycle-failure-state.json'),
      JSON.stringify(await scaffold.ctx.officeController.integrationPlugins(), null, 2))
    await page.screenshot({ path: join(directory, 'plugin-lifecycle-failure.png'), animations: 'disabled' })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  const openIntegrations = async () => {
    await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
    const region = page.getByRole('region', { name: 'Local integration plugins', exact: true })
    const refresh = region.getByRole('button', { name: 'Refresh plugin status', exact: true })
    if (await refresh.count()) await refresh.click()
    else await region.getByRole('button', { name: 'Inspect plugin status', exact: true }).click()
    await region.locator('[data-office-plugin="office-lifecycle"]').waitFor()
    return region.locator('[data-office-plugin="office-lifecycle"]')
  }
  const registered = async () => (await scaffold.ctx.office.connections(owner)).adapters.includes('office-lifecycle')
  return { scaffold, page, console, nav, openIntegrations, registered, reads, integration, profile, connectionInput }
}

it('connects company adapter lifecycle to actual profile enablement and Native management without changing saved connections', async () => {
  const { scaffold, page, console, openIntegrations, registered, reads, integration, connectionInput } = await setup(true)
  let card = await openIntegrations()
  await card.getByText('Installed · 0.0.1', { exact: true }).waitFor()
  await card.getByText('Not selected for enablement', { exact: true }).waitFor()
  expect(await registered()).toBe(false)
  await card.getByRole('button', { name: `Manage plugin package: ${packageName}`, exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  const toggle = panel.getByRole('switch', { name: `Enable ${packageName}`, exact: true })
  await toggle.waitFor()
  await toggle.click()
  await expect.poll(registered).toBe(true)
  const activeAfterEnable = await registered()
  await scaffold.ctx.office.saveConnection(owner, connectionInput)
  const original = (await scaffold.ctx.office.connections(owner)).entries[0]!
  card = await openIntegrations()
  await card.getByText('Selected for enablement', { exact: true }).waitFor()
  await card.getByText('Active 1 · Waiting or changing 0 · Failed 0 · 1 components', { exact: true }).waitFor()
  const integrationCard = page.locator(`[data-office-integration="${integration.id}"]`)
  await integrationCard.getByRole('button', { name: 'System details', exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'System details', exact: true })
  await detail.getByText('Connector code registered', { exact: false }).waitFor()
  await detail.getByRole('button', { name: 'View business actions', exact: true }).click()
  await detail.getByRole('button', { name: 'Query: Read company data v0.0.1', exact: true }).click()
  await detail.getByText('Actual company HTTP fields', { exact: true }).waitFor()
  expect(reads).toEqual(['GET'])
  await detail.getByRole('button', { name: 'Close system details', exact: true }).click()
  await detail.waitFor({ state: 'hidden' })
  await card.getByRole('button', { name: `Manage plugin package: ${packageName}`, exact: true }).click()
  await toggle.click()
  await expect.poll(registered).toBe(false)
  card = await openIntegrations()
  await card.getByText('Not selected for enablement', { exact: true }).waitFor()
  const disabled = (await scaffold.ctx.office.connections(owner)).entries[0]!
  expect(disabled.configuration).toEqual(original.configuration)
  expect(disabled.revision).toBe(original.revision)
  expect(disabled.status).toBe('adapter_unavailable')
  await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/office-plugin-lifecycle'), { recursive: true })
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-plugin-lifecycle/selection.expected.md'),
    JSON.stringify({ installed: true, activeAfterEnable, activeAfterDisable: await registered(),
      connectionRevision: disabled.revision, readiness: disabled.status, customerReads: reads }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('installs and upgrades a company adapter through the existing review, confirmation and uninstall flows', async () => {
  const { scaffold, page, console, openIntegrations, registered, integration, profile, connectionInput } = await setup(false)
  const warningStart = console.warnings.length
  const enableVersion = async (version: string) => {
    const card = await openIntegrations()
    await card.getByText('Not installed or package files are missing', { exact: true }).waitFor()
    await card.getByRole('button', { name: `Manage plugin package: ${packageName}`, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add plugin', exact: true })
    expect(await dialog.getByRole('textbox', { name: 'Package name or address', exact: true }).inputValue()).toBe(packageName)
    await dialog.getByRole('note').getByText('Install only plugins you trust:', { exact: false }).waitFor()
    if (version === '0.0.1') {
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      expect((await scaffold.ctx.pluginManager.listBundles()).some(bundle => bundle.name === packageName)).toBe(false)
      await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Integrations', exact: true }).click()
      const again = await openIntegrations()
      await again.getByRole('button', { name: `Manage plugin package: ${packageName}`, exact: true }).click()
    }
    await dialog.getByRole('button', { name: 'Install', exact: true }).click()
    try {
      await page.getByRole('dialog').getByRole('button', { name: 'Enable now', exact: true }).click()
    } catch (error) {
      const directory = join(REPO_ROOT, '.artifacts/enterprise-office')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'plugin-install-progress-failure.txt'), await page.locator('body').innerText())
      throw error
    }
    await expect.poll(registered).toBe(true)
    if (!(await scaffold.ctx.office.connections(owner)).entries.some(entry => entry.integrationId === integration.id)) {
      await scaffold.ctx.office.saveConnection(owner, connectionInput)
    }
    const directory = await scaffold.ctx.office.connectorActions(owner, integration.id)
    expect(directory.actions[0]?.label).toBe(`Read company data v${version}`)
    const current = await openIntegrations()
    await current.getByText(`Installed · ${version}`, { exact: true }).waitFor()
    await current.getByRole('button', { name: `Manage plugin package: ${packageName}`, exact: true }).click()
  }
  await enableVersion('0.0.1')
  const panel = page.locator('[data-plugin-panel]')
  const uninstall = panel.getByRole('button', { name: `Uninstall ${packageName}`, exact: true })
  await uninstall.click()
  const confirmation = page.getByRole('dialog', { name: `Uninstall "${packageName}"?`, exact: true })
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await registered()).toBe(true)
  await uninstall.click()
  await confirmation.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect.poll(registered).toBe(false)
  await expect.poll(async () => {
    const value: unknown = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    return z.object({ dependencies: z.record(z.string(), z.string()) }).parse(value).dependencies[packageName]
  }).toBeUndefined()
  await writeFile(join(profile, '.office-version'), '0.0.2')
  await enableVersion('0.0.2')
  const connection = (await scaffold.ctx.office.connections(owner)).entries[0]!
  expect(connection.revision).toBe(1)
  expect(connection.status).toBe('unverified')
  const current = (await scaffold.ctx.pluginManager.listBundles()).find(bundle => bundle.name === packageName)!
  expect(current.version).toBe('0.0.2')
  const card = await openIntegrations()
  await card.getByText('Installed · 0.0.2', { exact: true }).waitFor()
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-plugin-lifecycle/packages.expected.md'),
    await captureStableAria(page, '[data-office-plugin="office-lifecycle"]', scaffold.workspaceCwd), webSnapshotMode())
  await page.setViewportSize({ width: 900, height: 640 })
  await card.scrollIntoViewIfNeeded()
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
  await page.screenshot({ path: join(REPO_ROOT, '.artifacts/enterprise-office/integration-plugins-small.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(REPO_ROOT, '.artifacts/enterprise-office/integration-plugins-dark.png'), animations: 'disabled' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
