import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import { spawn } from 'node:child_process'
import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { randomInt } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

app.setName('Enterprise Office Agent Dev')
const selectedData = app.commandLine.getSwitchValue('user-data-dir')
app.setPath('userData', selectedData ? resolve(selectedData) : join(app.getPath('appData'), 'enterprise-office-agent-development'))
const languages = { zh: {
  title: '企业办公 Agent · 热开发版', start: '正在启动办公服务…',
  failure: '办公服务启动失败', stop: '办公服务尚未停止',
  detail: '请查看本应用用户目录中的运行日志。原始项目和数据已保留。',
  retry: '重试', stay: '保留窗口', application: '应用', edit: '编辑', view: '视图',
}, en: {
  title: 'Enterprise Office Agent · Development', start: 'Starting the office service…',
  failure: 'The office service could not start', stop: 'The office service is still running',
  detail: 'See this application’s user-directory logs. The original project and data are retained.',
  retry: 'Retry', stay: 'Keep window', application: 'Application', edit: 'Edit', view: 'View',
} }
let copy = languages.zh
let window
let closing = false
let stopped = false
let stopping
let starting
let origin
let publicEnvironment = {}
let phase = 'startup-page'
const root = app.isPackaged ? join(process.resourcesPath, 'enterprise-development')
  : join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'development')
const nodeDirectory = join(root, '.local-run', 'node-v24.22.0-win-x64')
const controller = join(root, 'deepseek-harness', 'scripts', 'gui-hot-development.ps1')
const stateRoot = join(app.getPath('userData'), 'runtime-control')
const urlPath = join(stateRoot, 'gui-hot-dev', 'GUI-hot-development.url')
const startupPath = join(dirname(fileURLToPath(import.meta.url)), 'startup.html')
const startupUrl = pathToFileURL(startupPath).href
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function execute(executable, args) {
  return new Promise((accept, reject) => {
    let output = ''
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...publicEnvironment } })
    const capture = value => { output = (output + value).slice(-64 * 1024) }
    child.stdout.setEncoding('utf8').on('data', capture)
    child.stderr.setEncoding('utf8').on('data', capture)
    child.once('error', reject)
    child.once('exit', (code) => {
      // Detached PowerShell descendants can inherit pipe handles after the
      // controller exits. Its exit and persisted state define completion.
      child.stdout.destroy()
      child.stderr.destroy()
      void (async () => {
        await mkdir(stateRoot, { recursive: true })
        await appendFile(join(stateRoot, 'launcher.log'), `[${new Date().toISOString()}] exit=${code}\n${output}\n`, { mode: 0o600 })
        if (code === 0) accept()
        else reject(new Error(`Controller exited with code ${code}`))
      })().catch(reject)
    })
  })
}

function control(stop = false, port) {
  return execute(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', controller,
    '-NoOpen', '-RuntimeRoot', stateRoot, '-NodeDirectory', nodeDirectory,
    '-ArtifactBackupManifest', join(stateRoot, 'baseline', 'artifact-backup.json'),
    ...(stop ? ['-Stop'] : ['-Port', String(port)])])
}

async function freePort() {
  // Chromium rejects well-known ports such as 6000 even if Windows allocates one.
  for (let attempt = 0; attempt < 3; attempt++) {
    const server = createServer()
    try {
      await new Promise((accept, reject) => {
        server.once('error', reject)
        server.listen(randomInt(49152, 65536), '127.0.0.1', accept)
      })
    } catch (error) {
      if (['EADDRINUSE', 'EACCES'].includes(error.code)) continue
      throw error
    }
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('No loopback endpoint was allocated')
    await new Promise((accept, reject) => { server.close(error => error ? reject(error) : accept()) })
    return address.port
  }
  throw new Error('No permitted loopback endpoint was available')
}

async function start() {
  phase = 'client-environment'
  await mkdir(stateRoot, { recursive: true })
  const record = JSON.parse(await readFile(join(root, 'deepseek-harness', '.dsh-build', 'client-build-environment.json'), 'utf8'))
  publicEnvironment = Object.fromEntries(Object.entries(record.environment).filter(([key, value]) =>
    ['DSH_CLIENT_COMMIT_HASH', 'DSH_CLIENT_GIT_DIRTY', 'DSH_CLIENT_VERSION'].includes(key) && typeof value === 'string'))
  phase = 'dependency-links'
  await execute(join(nodeDirectory, 'node.exe'), [join(root, 'link-enterprise-runtime.mjs'), root])
  phase = 'artifact-backup'
  await execute(join(nodeDirectory, 'node.exe'), [join(root, 'prepare-enterprise-baseline.mjs'),
    join(root, 'deepseek-harness'), join(stateRoot, 'baseline')])
  phase = 'service-start'
  await control(false, await freePort())
  phase = 'service-address'
  const shortcut = await readFile(urlPath, 'utf8')
  const value = /^URL=(.+)$/m.exec(shortcut)?.[1]?.trim()
  if (!value) throw new Error('The development service did not publish its local address')
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Unexpected service origin')
  origin = url.origin
  phase = 'office-page'
  await window.loadURL(url.href)
}

async function stop() {
  if (stopped) return
  stopping ??= (async () => {
    try { await starting } catch (error) { /* Startup reports its failure; cleanup must wait until allocation settles. */ }
    await control(true)
    stopped = true
  })().finally(() => { stopping = undefined })
  await stopping
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus() })
  app.on('before-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    if (closing) return
    closing = true
    void stop().then(() => { app.quit() }, async () => {
      closing = false
      const result = await dialog.showMessageBox(window, { type: 'error', title: copy.stop,
        message: copy.stop, detail: copy.detail, buttons: [copy.retry, copy.stay], defaultId: 0, cancelId: 1 })
      if (result.response === 0) app.quit()
    })
  })
  // Electron must finish evaluating its entry module before it can emit ready.
  void app.whenReady().then(async () => {
  copy = app.getLocale().toLowerCase().startsWith('zh') ? languages.zh : languages.en
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: copy.application, submenu: [{ role: 'quit' }] },
    { label: copy.edit, submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: copy.view, submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]))
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 440, minHeight: 640,
    icon: join(dirname(fileURLToPath(import.meta.url)), 'icon.png'),
    title: copy.title, backgroundColor: '#10141c', show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
  window.webContents.setWindowOpenHandler(({ url }) => {
    let target
    try { target = new URL(url) } catch (error) { return { action: 'deny' } }
    if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password && target.origin !== origin) {
      void shell.openExternal(target.href).catch((error) => { dialog.showErrorBox(copy.failure, copy.detail) })
    }
    if (target.origin === origin) return { action: 'allow', overrideBrowserWindowOptions: {
      parent: window, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    } }
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== startupUrl && new URL(url).origin !== origin) event.preventDefault()
  })
  window.webContents.on('did-create-window', (child) => {
    child.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault() })
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') { event.preventDefault(); window.webContents.toggleDevTools() }
  })
  window.webContents.session.setPermissionRequestHandler((contents, permission, accept, details) => {
    const sameDocument = contents === window?.webContents && origin !== undefined
      && details.requestingUrl?.startsWith(origin + '/')
    accept(Boolean(sameDocument && (permission === 'clipboard-sanitized-write'
      || permission === 'media' && details.mediaTypes?.every(type => type === 'audio'))))
  })
  window.on('closed', () => { window = undefined; app.quit() })
  window.on('close', (event) => { if (!stopped) { event.preventDefault(); app.quit() } })
  try {
    await window.loadFile(startupPath)
    if (window && !closing) { starting = start(); await starting }
  } catch (error) {
    await mkdir(stateRoot, { recursive: true })
    const reason = String(error.message).replace(/(?:https?|file):\/\/\S+/g, '[address]')
      .replace(/(token|password|secret)([=: ]+)\S+/gi, '$1$2[redacted]')
    await appendFile(join(stateRoot, 'launcher.log'), `[${new Date().toISOString()}] startup-failed phase=${phase} ${error.name} ${error.code ?? ''} ${reason}\n`, { mode: 0o600 })
    if (window && !closing) await dialog.showMessageBox(window, { type: 'error', title: copy.failure,
      message: copy.failure, detail: copy.detail })
    app.quit()
  }
  }).catch(() => {
    dialog.showErrorBox(copy.failure, copy.detail)
    app.quit()
  })
}
