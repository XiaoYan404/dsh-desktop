/** Real Electron office shell acceptance against the built Desktop Host and preload. */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication } from 'playwright'
import { expect, it } from 'vitest'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

async function version(path: string): Promise<string> {
  return (JSON.parse(await readFile(path, 'utf8')) as { version: string }).version
}

it.skipIf(!hasDisplay)('keeps native menus, settings, keyboard dispatch and office data through a Desktop restart', { retry: 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-desktop-'))
  const home = join(root, 'home')
  const userData = join(root, 'browser')
  let desktop: ElectronApplication | undefined
  let diagnostics = ''
  try {
    const executable: unknown = require('electron')
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable')
    const project = prepareDevelopmentProject({
      projectDir: join(root, 'project'),
      cliDir: join(repository, 'apps/cli'),
      hostDir: join(repository, 'apps/desktop-host'),
      dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'),
      release: {
        schemaVersion: 1,
        version: await version(join(repository, 'apps/desktop/package.json')),
        pnpmVersion: await version(join(repository, 'apps/desktop/node_modules/pnpm/package.json')),
        nodeVersion: execFileSync(executable, ['-p', 'process.versions.node'], {
          encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        }).trim(),
        hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      },
      target: process.platform === 'win32' ? 'win-x64' : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64',
    })
    await cp(join(repository, 'packages/skill/skill-office/assets'), join(root, 'runtime/office-skills'), { recursive: true })
    const nodeBin = join(root, 'runtime/primary-runtime/dependencies/node/bin')
    await mkdir(nodeBin, { recursive: true })
    await cp(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))
    const paths = resolveDesktopPaths(home)
    const manager = new DesktopProjectManager(paths, { dsh: project })
    await manager.applyRelease()
    await writeFile(join(paths.profile, 'cordis.patch.yml'),
      '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n'
      + await readFile(join(repository, 'enterprise-workbench.patch.yml'), 'utf8'))
    const settingsDirectory = join(userData, 'desktop')
    await mkdir(settingsDirectory, { recursive: true })
    const originalSettings = '{"updates":{"allowTestAuthPopupWindow":false},"retained":"existing preference"}\n'
    await writeFile(join(settingsDirectory, 'settings.json'), originalSettings)

    const launch = async () => {
      const env: Record<string, string> = {}
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE' && !/KEY|TOKEN|SECRET|PASSWORD/u.test(name)) env[name] = value
      }
      desktop = await _electron.launch({ executablePath: executable,
        args: [`--user-data-dir=${userData}`, join(repository, 'apps/desktop')],
        env: { ...env, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', DSH_CLIENT_VERSION: '1.2.3',
          DSH_DESKTOP_DSH_DIR: project, DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(root, 'runtime/primary-runtime'),
          DSH_DESKTOP_OPEN_DEVTOOLS: '0' },
        timeout: 30_000,
      })
      desktop.process().stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-12_000) })
      await expect.poll(() => desktop?.windows().some(page => new URL(page.url()).pathname.endsWith('/welcome.html')),
        { timeout: 30_000 }).toBe(true)
      const entry = desktop.windows().find(page => new URL(page.url()).pathname.endsWith('/welcome.html'))
      if (entry === undefined) throw new Error('Desktop welcome window did not open')
      await entry.locator('#api-key').click()
      await entry.locator('#skip-key').click()
      await expect.poll(() => desktop?.windows().some(page => page.url().startsWith('dsh-app://app/'))).toBe(true)
      const page = desktop.windows().find(candidate => candidate.url().startsWith('dsh-app://app/'))
      if (page === undefined) throw new Error('Desktop product window did not open')
      await page.getByRole('heading', { name: /^(工作台|Workbench)$/u }).waitFor({ timeout: 30_000 })
      return page
    }

    let page = await launch()
    expect(await page.locator('html').getAttribute('data-platform')).toBe(process.platform)
    const sandboxed = await desktop!.evaluate(({ BrowserWindow, app }) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('dsh-app://app/'))
      return app.getAppMetrics().find(metric => metric.pid === window?.webContents.getOSProcessId())?.sandboxed
    })
    if (process.platform === 'win32' || process.platform === 'darwin') expect(sandboxed).toBe(true)

    await page.getByRole('button', { name: /^(新建待办|New to-do)$/u }).first().click()
    let dialog = page.getByRole('dialog', { name: /^(新建待办|New to-do)$/u })
    await dialog.getByLabel(/^(标题|Title)$/u).fill('Desktop retained work')
    await dialog.getByRole('button', { name: /^(保存|Save)$/u }).click()
    await dialog.waitFor({ state: 'hidden' })

    await desktop!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('dsh-app://app/'))
      window?.show()
      window?.focus()
      window?.webContents.focus()
      window?.webContents.on('before-input-event', (_event, input) => {
        Reflect.set(window, 'officeAcceptanceInput', { code: input.code, control: input.control, type: input.type })
      })
    })
    await page.bringToFront()
    await expect.poll(() => desktop!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('dsh-app://app/'))
      return { focused: window?.isFocused(), contents: window?.webContents.isFocused() }
    })).toEqual({ focused: true, contents: true })
    await desktop!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('dsh-app://app/'))
      const modifiers: Array<'control' | 'meta'> = [process.platform === 'darwin' ? 'meta' : 'control']
      window?.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers })
      window?.webContents.sendInputEvent({ type: 'keyUp', keyCode: ',', modifiers })
    })
    dialog = page.getByRole('dialog', { name: /^(设置|Settings)$/u })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: /^(深色|Dark)$/u }).click()
    await expect.poll(() => desktop!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    await dialog.getByRole('button', { name: /^(编辑快捷键|Edit shortcuts)$/u }).click()
    await page.getByRole('dialog', { name: /^(快捷键|Keyboard shortcuts)$/u }).waitFor()
    await page.getByRole('button', { name: /^(关闭快捷键|Close keyboard shortcuts)$/u }).click()
    await page.getByRole('dialog', { name: /^(设置|Settings)$/u }).getByRole('button', { name: /^(关闭|Close)$/u }).click()

    if (process.platform === 'win32') {
      const user32 = (require('koffi') as typeof import('koffi')).load('user32.dll')
      const windowProcess = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t window, _Out_ uint32_t *processId)')
      const postKey = user32.func('bool __stdcall PostMessageW(uintptr_t window, uint32_t message, uintptr_t wparam, intptr_t lparam)')
      await desktop!.evaluate(({ Menu, app }) => {
        const build = Menu.buildFromTemplate.bind(Menu)
        Menu.buildFromTemplate = (template) => {
          const menu = build(template)
          menu.once('menu-will-show', () => { Reflect.set(app, 'officeAcceptanceMenu', menu) })
          menu.once('menu-will-close', () => { Reflect.set(menu, 'officeAcceptanceClosed', true) })
          return menu
        }
      })
      for (const [name, required] of [
        [/^(应用|Application)$/u, ['About DeepSeek Harness', 'Check for Updates…', 'Reload Page']],
        [/^(编辑|Edit)$/u, ['Undo', 'Copy', 'Paste']],
      ] as const) {
        await desktop!.evaluate(({ app }) => { Reflect.deleteProperty(app, 'officeAcceptanceMenu') })
        await page.getByRole('menubar').getByRole('menuitem', { name }).click()
        await expect.poll(() => desktop!.evaluate(({ Menu, app }) => Reflect.get(app, 'officeAcceptanceMenu') instanceof Menu)).toBe(true)
        const popup = await desktop!.evaluate(({ Menu, app, BrowserWindow }) => {
          const menu: unknown = Reflect.get(app, 'officeAcceptanceMenu')
          if (!(menu instanceof Menu)) throw new Error('Native popup was not built')
          const labels = menu.items.map(item => item.label)
          const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('dsh-app://app/'))
          if (owner === undefined) throw new Error('Native popup owner is unavailable')
          const handle = owner.getNativeWindowHandle()
          return { labels, pid: process.pid,
            handle: (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString() }
        })
        const ownerHandle = BigInt(popup.handle)
        const ownerProcess = [0]
        windowProcess(ownerHandle, ownerProcess)
        expect(ownerProcess[0]).toBe(popup.pid)
        // Deliver Escape only to this application's HWND, then await the native close and renderer acknowledgement.
        expect(postKey(ownerHandle, 0x100, 0x1b, 1)).toBe(true)
        expect(postKey(ownerHandle, 0x101, 0x1b, 0xC0000001)).toBe(true)
        await expect.poll(() => desktop!.evaluate(({ Menu, app }) => {
          const menu: unknown = Reflect.get(app, 'officeAcceptanceMenu')
          return menu instanceof Menu && Reflect.get(menu, 'officeAcceptanceClosed') === true
        })).toBe(true)
        await expect.poll(() => page.getByRole('menubar').getByRole('menuitem', { name }).getAttribute('aria-expanded')).toBe('false')
        // Labels follow the retained product locale rather than the operating system.
        const english = (await page.locator('html').getAttribute('lang'))?.startsWith('en')
        const localized = english ? required : required.map(label => ({
          'About DeepSeek Harness': '关于 DeepSeek Harness', 'Check for Updates…': '检查更新…',
          'Reload Page': '刷新页面', Undo: '撤销', Copy: '复制', Paste: '粘贴',
        })[label])
        expect(popup.labels).toEqual(expect.arrayContaining([...localized]))
      }
    }
    await mkdir(join(repository, '.artifacts/enterprise-office'), { recursive: true })
    await page.screenshot({ path: join(repository, '.artifacts/enterprise-office/desktop-native.png') })
    await desktop!.close()
    desktop = undefined
    expect(await readFile(join(settingsDirectory, 'settings.json'), 'utf8')).toBe(originalSettings)
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
    const originalBindings = JSON.stringify({ schemaVersion: 1, profiles: { [`desktop:${platform}`]: {
      'settings.open': { code: 'KeyS', modifiers: ['primary', 'alt'] }, 'employee.future-command': null,
    } } }) + '\n'
    await writeFile(join(userData, 'keybindings.json'), originalBindings)
    page = await launch()
    await page.getByRole('button').filter({ hasText: 'Desktop retained work' }).waitFor()
    await expect.poll(() => desktop!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    expect(await readFile(join(settingsDirectory, 'settings.json'), 'utf8')).toBe(originalSettings)
    await desktop!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('dsh-app://app/'))
      window?.focus()
      window?.webContents.focus()
      const modifiers: Array<'control' | 'meta' | 'alt'> = [process.platform === 'darwin' ? 'meta' : 'control', 'alt']
      window?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers })
      window?.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers })
    })
    await page.getByRole('dialog', { name: /^(设置|Settings)$/u }).waitFor()
    expect(await readFile(join(userData, 'keybindings.json'), 'utf8')).toBe(originalBindings)
  } catch (error) {
    let windows: object | undefined
    try {
      windows = await desktop?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => {
        const input: unknown = Reflect.get(window, 'officeAcceptanceInput')
        return { url: window.webContents.getURL(), focused: window.isFocused(), input }
      }))
    } catch (diagnosticError) {
      windows = { unavailable: String(diagnosticError) }
    }
    const report = `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(windows)}\n${diagnostics}`
    throw new Error(report.replace(/(token=)[^\s]+/gu, '$1[redacted]'))
  } finally {
    await desktop?.close()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.split(/[\\/]/u).at(-1)?.startsWith('dsh-office-desktop-')) {
      throw new Error('Desktop acceptance cleanup escaped its temporary directory')
    }
    await rm(root, { recursive: true, force: true })
  }
})
