/** Group 07 real browser acceptance; requires Agent 08's generated Host/Client integration first. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT } from './support.ts'
import { parseOfficeExperienceDocument } from '../../../packages/client/ui-office/src/experience/validation.ts'
import { experienceEn, experienceZh } from '../../../packages/client/ui-office/src/client/experience/locales.ts'

const round = process.env.DSH_07_ROUND ?? '1'
if (!/^[1-3]$/u.test(round)) throw new Error('Group 07 browser round must be 1..3')
const artifacts = join(REPO_ROOT, '.artifacts/parallel-handoff/07', `browser-r${round}`)

async function fixture() {
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'AI chat', exact: true }).click()
  await connectFreshWorkspace(page, scaffold.workspaceCwd, 'experience-07')
  await mkdir(artifacts, { recursive: true })
  return { scaffold, browser, page, console }
}

async function home(page: Page) {
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Workbench', exact: true }).click()
  await page.getByRole('region', { name: experienceEn.title }).waitFor()
}

async function settings(page: Page) {
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: experienceEn.appearance, exact: true }).click()
  await page.getByRole('textbox', { name: experienceEn.companyName }).waitFor()
}

async function nativeIdentity(page: Page): Promise<string> {
  return page.evaluate(() => {
    const value: unknown = JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}')
    if (!value || typeof value !== 'object' || !('sessionId' in value) || typeof value.sessionId !== 'string')
      throw new Error('No native Session selected')
    return value.sessionId
  })
}

it('07 opens six distinct native scene conversations and persists a selected assistant Preset without sending', async () => {
  const { page, scaffold, console } = await fixture()
  onTestFailed(() => page.screenshot({ path: join(artifacts, 'native-scenes-failure.png') }).then(() => {}))
  const identities: string[] = []
  for (const scene of ['sales', 'documents', 'presentations', 'knowledge', 'quotes', 'projects'] as const) {
    await home(page)
    await page.getByRole('region', { name: experienceEn.title }).getByRole('button', { name: new RegExp(`^${experienceEn[scene]}`) }).click()
    const dialog = page.getByRole('dialog', { name: experienceEn[scene], exact: true })
    await dialog.getByRole('button', { name: experienceEn.start, exact: true }).click()
    await expect.poll(async () => (await page.getByRole('dialog', { name: experienceEn[scene], exact: true }).count())).toBe(0)
    const id = await nativeIdentity(page)
    identities.push(id)
    await expect.poll(() => page.locator('[data-composer-input][contenteditable="true"]').textContent()).toContain(experienceEn[`${scene}Prompt`])
    expect(scaffold.ctx.sessions.get(SessionId(id))).toBeDefined()
  }
  expect(new Set(identities).size).toBe(6)
  await settings(page)
  const trigger = page.getByRole('button', { name: experienceEn.newAssistant, exact: true })
  await trigger.focus()
  await trigger.press('Enter')
  const dialog = page.getByRole('dialog', { name: experienceEn.newAssistant, exact: true })
  await dialog.getByRole('textbox', { name: experienceEn.name }).fill('Experience 07 documents')
  await dialog.getByRole('radio', { name: experienceEn.documents, exact: true }).check()
  await dialog.getByRole('textbox', { name: experienceEn.instructions }).fill('Use only authorized sources; confirm missing facts.')
  await dialog.getByRole('button', { name: experienceEn.save, exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await expect.poll(() => trigger.evaluate(element => element === document.activeElement)).toBe(true)
  const profile = scaffold.ctx.get('profileContext') as ProfileContext
  const raw = await readFile(join(profile.dir, 'office-experience.v1.json'), 'utf8')
  const saved = parseOfficeExperienceDocument(JSON.parse(raw)).accounts.flatMap(account => account.assistants)
    .find(assistant => assistant.name === 'Experience 07 documents')
  if (!saved) throw new Error('Saved assistant missing from actual profile file')
  await page.getByRole('article').filter({ hasText: saved.name }).getByRole('button', { name: experienceEn.start, exact: true }).click()
  const id = await nativeIdentity(page)
  expect(identities).not.toContain(id)
  const native = scaffold.ctx.sessions.get(SessionId(id))
  if (!native) throw new Error('Native assistant Session missing')
  expect(scaffold.ctx.sessionProjections.stateOf(native, 'agentPreset')).toBe(`office.assistant.${saved.id}`)
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await expect.poll(() => input.textContent()).toContain(saved.instructions)
  await page.screenshot({ path: join(artifacts, 'native-assistant.png'), fullPage: true })
  await writeFile(join(artifacts, 'native-scenes.json'), JSON.stringify({ distinctScenes: identities.length, assistantPresetSelected: true,
    configurationSha256: createHash('sha256').update(raw).digest('hex'), unsubmittedDraft: await input.textContent(),
    warnings: console.warnings, errors: console.pageErrors }, null, 2) + '\n')
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('07 persists office appearance and verifies two schemes, two window sizes, keyboard return and actual diagnostic download', async () => {
  const { page, browser, scaffold, console } = await fixture()
  onTestFailed(() => page.screenshot({ path: join(artifacts, 'appearance-failure.png') }).then(() => {}))
  const nativeDarkBefore = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
  await settings(page)
  const records: object[] = []
  for (const scheme of ['light', 'dark'] as const) {
    await page.getByRole('textbox', { name: experienceEn.companyName }).fill('Experience 07 Company')
    await page.getByRole('textbox', { name: experienceEn.monogram }).fill('E07')
    await page.getByRole('radio', { name: experienceEn[scheme], exact: true }).check()
    await page.getByRole('radio', { name: experienceEn.compact, exact: true }).check()
    await page.getByRole('radio', { name: experienceEn.violet, exact: true }).check()
    await page.getByRole('button', { name: experienceEn.save, exact: true }).click()
    await page.getByRole('status').filter({ hasText: experienceEn.saved }).waitFor()
    await page.keyboard.press('Escape')
    await home(page)
    for (const size of [{ width: 1040, height: 700 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size)
      const main = page.getByRole('main')
      await expect.poll(() => main.getAttribute('data-office-scheme')).toBe(scheme)
      const layout = await main.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }))
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
      const contrast = await page.getByRole('region', { name: experienceEn.title }).evaluate((element) => {
        const luminance = (color: string) => {
          const values = color.match(/[\d.]+/gu)?.slice(0, 3).map(Number)
          if (values?.length !== 3) throw new Error('Expected RGB theme colors')
          return values.reduce((sum, value, index) => {
            const channel = value / 255
            return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
              * [0.2126, 0.7152, 0.0722][index]!
          }, 0)
        }
        const background = luminance(getComputedStyle(element).backgroundColor)
        const ratio = (color: string) => {
          const ink = luminance(color)
          return (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05)
        }
        const hint = element.querySelector('p')
        if (!hint) throw new Error('Scene guidance is missing')
        return { primary: ratio(getComputedStyle(element).color), secondary: ratio(getComputedStyle(hint).color) }
      })
      expect(contrast.primary).toBeGreaterThanOrEqual(4.5)
      expect(contrast.secondary).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: join(artifacts, `${scheme}-${size.width}x${size.height}.png`), fullPage: true })
      records.push({ scheme, ...size, ...layout, contrast })
    }
    await settings(page)
  }
  await page.setViewportSize({ width: 420, height: 780 })
  await page.getByRole('textbox', { name: experienceEn.mobileUrl }).scrollIntoViewIfNeeded()
  await expect.poll(() => page.getByRole('textbox', { name: experienceEn.mobileUrl }).isVisible()).toBe(true)
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: experienceEn.diagnostics, exact: true }).click()
  const download = await downloaded
  const path = await download.path()
  if (!path) throw new Error('Diagnostic download did not materialize')
  const diagnostic: unknown = JSON.parse(await readFile(path, 'utf8'))
  expect(diagnostic).toMatchObject({ format: 'office-diagnostics.v1', phonePairing: false, desktopUpdateBridge: false })
  await download.saveAs(join(artifacts, 'diagnostics.json'))
  const profile = scaffold.ctx.get('profileContext') as ProfileContext
  const raw = await readFile(join(profile.dir, 'office-experience.v1.json'), 'utf8')
  const configuration = parseOfficeExperienceDocument(JSON.parse(raw))
  expect(configuration.accounts[0]?.appearance).toMatchObject({ companyName: 'Experience 07 Company', scheme: 'dark', density: 'compact', brand: 'violet' })
  await writeFile(join(artifacts, 'appearance-persisted.json'), raw)
  await page.reload({ waitUntil: 'load' })
  await home(page)
  await expect.poll(() => page.getByRole('main').getAttribute('data-office-scheme')).toBe('dark')
  expect(await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(nativeDarkBefore)
  const chinese = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1040, height: 700 }, timezoneId: 'Asia/Shanghai' })).newPage()
  const chineseConsole = watchConsole(chinese)
  await chinese.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await chinese.getByRole('navigation', { name: '工作台', exact: true }).getByRole('button', { name: '工作台', exact: true }).click()
  await chinese.getByRole('region', { name: experienceZh.title }).getByText(experienceZh.hint, { exact: true }).waitFor()
  await expect.poll(() => chinese.getByRole('main').getAttribute('data-office-scheme')).toBe('dark')
  await chinese.screenshot({ path: join(artifacts, 'zh-dark-1040x700.png'), fullPage: true })
  await writeFile(join(artifacts, 'appearance-matrix.json'), JSON.stringify({ records, narrowWindow: { width: 420, height: 780 },
    nativeThemePreserved: true, chineseLocaleVerified: true, warnings: [...console.warnings, ...chineseConsole.warnings],
    errors: [...console.pageErrors, ...chineseConsole.pageErrors] }, null, 2) + '\n')
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  expect(chineseConsole.pageErrors).toEqual([])
  expect(chineseConsole.warnings).toEqual([])
})
