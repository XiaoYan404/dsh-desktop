/** Real Electron fixture for account-scoped Platform storage across process restarts. */
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import { readFileSync } from 'node:fs'

const OBSERVE = `(() => {
  const button = document.querySelector('button')
  return button === null ? 'hidden' : 'visible'
})()`

const bounds = { x: 0, y: 0, width: 800, height: 600 }

/**
 * Read the notice state from the embedded document.
 * @param contents - embedded Platform page.
 * @returns `visible` while the dismissal control is rendered, otherwise `hidden`.
 */
async function observe(contents) {
  const value = await contents.executeJavaScript(OBSERVE, true)
  if (value !== 'visible' && value !== 'hidden') throw new Error(`unexpected notice state ${String(value)}`)
  return value
}

/**
 * @param owner - application window containing the embedded view.
 * @returns the current embedded Platform view.
 */
function platformView(owner) {
  const view = owner.contentView.children.find(child => typeof child.webContents?.executeJavaScript === 'function')
  if (view === undefined) throw new Error('embedded Platform view is missing')
  return view
}

/**
 * Click the notice's dismissal control and wait, bounded, until the notice leaves the DOM.
 * @param contents - embedded Platform page.
 */
async function dismissNotice(contents) {
  const clicked = await contents.executeJavaScript(
    `(() => { const button = document.querySelector('button'); if (button === null) return false; button.click(); return true })()`,
    true)
  if (clicked !== true) throw new Error('notice dismissal control is missing')
  if (await observe(contents) !== 'hidden') throw new Error('notice stayed visible after dismissal')
}

async function run() {
  const separator = process.argv.indexOf('--')
  if (separator < 0) throw new Error('expected -- before Platform fixture arguments')
  const options = process.argv[separator + 1]
  if (options === undefined) throw new Error('expected Platform fixture options file')
  const { viewModule, userData, origin, phase, preload, legacyRoundTrip = false } = JSON.parse(readFileSync(options, 'utf8'))
  if (viewModule === undefined || userData === undefined || origin === undefined || phase === undefined || preload === undefined) {
    throw new Error('expected <built-platform-view.js> <userDataDir> <origin> <first|restart> <built-preload.cjs>')
  }
  if (!['first', 'restart', 'legacy-seed', 'legacy-read'].includes(phase)) throw new Error(`unknown phase ${phase}`)
  const base = new URL(origin).origin
  app.setPath('userData', userData)
  await app.whenReady()
  if (phase === 'legacy-seed' || phase === 'legacy-read') {
    const partition = 'persist:dsh-platform-' + createHash('sha256').update(JSON.stringify([base, 'first'])).digest('hex')
    const store = session.fromPartition(partition)
    const window = new BrowserWindow({ show: false, webPreferences: { session: store } })
    await window.loadURL(base)
    if (phase === 'legacy-seed') {
      if (await observe(window.webContents) !== 'visible') throw new Error('legacy preference fixture was already initialized')
      await dismissNotice(window.webContents)
      await window.webContents.executeJavaScript("localStorage.setItem('legacy-custom', '旧版自定义偏好')")
      await store.cookies.set({ url: base, name: 'legacy-auth', value: 'fixture-secret', expirationDate: Date.now() / 1000 + 3600 })
      await store.cookies.flushStore()
    } else {
      if (await window.webContents.executeJavaScript("localStorage.getItem('modern-custom')") !== '新版自定义偏好') {
        throw new Error('legacy partition cannot read the current view preference')
      }
      if (await window.webContents.executeJavaScript('document.cookie') !== '') throw new Error('legacy authentication survived cleanup')
    }
    if (await observe(window.webContents) !== 'hidden') throw new Error('legacy notice preference was lost')
    store.flushStorageData()
    const result = `${phase}=hidden`
    await new Promise((resolve, reject) => process.stdout.write(`PLATFORM_STORAGE_RESULT ${JSON.stringify([result])}\n`, error => error ? reject(error) : resolve()))
    window.destroy()
    app.quit()
    return
  }
  const { DesktopPlatformView, PLATFORM_IPC } = await import(pathToFileURL(viewModule).href)
  const owner = new BrowserWindow({ show: false, width: 900, height: 700 })
  const manager = new DesktopPlatformView(preload, () => 'en_US', process.platform === 'win32' ? 'win32' : 'darwin')
  ipcMain.on(PLATFORM_IPC.bootstrap, (event) => {
    try { event.returnValue = manager.bootstrap(event) }
    catch { event.returnValue = null }
  })
  const account = userId => ({ origin: base, token: 'fixture-secret', userId })
  const states = []
  const record = async name => {
    states.push(`${name}=${await observe(platformView(owner).webContents)}`)
  }

  manager.setSession(account('first'))
  await manager.open(owner, 'usage', bounds)
  await record(phase === 'first' ? 'first-open' : 'restart-first-open')
  if (legacyRoundTrip) {
    if (await platformView(owner).webContents.executeJavaScript("localStorage.getItem('legacy-custom')") !== '旧版自定义偏好') {
      throw new Error('current view cannot read the legacy account preference')
    }
    await platformView(owner).webContents.executeJavaScript("localStorage.setItem('modern-custom', '新版自定义偏好')")
  }
  if (phase === 'restart') {
    const cookies = await platformView(owner).webContents.executeJavaScript('document.cookie')
    if (cookies !== '') throw new Error('previous-process authentication survived startup')
  }
  if (phase === 'first') {
    await dismissNotice(platformView(owner).webContents)
    await record('first-got-it')
    await platformView(owner).webContents.executeJavaScript("document.cookie = 'fixture-auth=secret; SameSite=Lax'")
    await platformView(owner).webContents.executeJavaScript("window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = false })")
    const cacheSetup = await platformView(owner).webContents.executeJavaScript(`(async () => {
      try {
        const cache = await Promise.race([
          caches.open('fixture-auth'), new Promise((_, reject) => setTimeout(() => reject(new Error('CacheStorage.open timed out')), 3000)),
        ])
        await cache.put(new Request(new URL('/secret', location.href)), new Response('secret'))
        return null
      } catch(error) { return {name: error.name, message: error.message} }
    })()`)
    if (cacheSetup !== null) throw new Error(`Cache setup failed: ${JSON.stringify(cacheSetup)}`)
    await platformView(owner).webContents.executeJavaScript(`(async () => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('fixture-auth')
        request.onsuccess = () => { request.result.close(); resolve() }
        request.onerror = () => reject(request.error)
      })
    })()`)
    manager.close()
    await manager.open(owner, 'usage', bounds)
    await record('first-reopen')
    const cookies = await platformView(owner).webContents.executeJavaScript('document.cookie')
    if (cookies !== '') throw new Error('authentication cookies survived close')
    states.push('reopen-cookies=cleared')
    const stores = await platformView(owner).webContents.executeJavaScript('(async () => (await caches.keys()).length + (await indexedDB.databases()).length)()')
    if (stores !== 0) throw new Error('nonpreference stores survived close')
    manager.setSession(account('second'))
    await manager.open(owner, 'usage', bounds)
    await record('second-account')
    manager.setSession(account('first'))
    await manager.open(owner, 'usage', bounds)
    await record('back-to-first')
    manager.setSession(null)
    manager.setSession({ ...account('first'), token: 'new-grant' })
    await manager.open(owner, 'usage', bounds)
    await record('signed-in-again')
  }
  const persistedSession = platformView(owner).webContents.session
  manager.setSession(account(null))
  await manager.open(owner, 'usage', bounds)
  if (await observe(platformView(owner).webContents) !== 'visible') throw new Error('temporary session inherited preferences')
  await dismissNotice(platformView(owner).webContents)
  manager.close()
  await manager.open(owner, 'usage', bounds)
  if (await observe(platformView(owner).webContents) !== 'visible') throw new Error('temporary session retained preferences')
  await manager.dispose()
  if (phase === 'first') {
    // Seed residue left by an interrupted process after normal cleanup has completed.
    await persistedSession.cookies.set({ url: base, name: 'crash-auth', value: 'secret', expirationDate: Date.now() / 1000 + 3600 })
    await persistedSession.cookies.flushStore()
  }

  const lines = `${states.map(state => `state ${state}`).join('\n')}\nPLATFORM_STORAGE_RESULT ${JSON.stringify(states)}\n`
  await new Promise((resolve, reject) => process.stdout.write(lines, error => error ? reject(error) : resolve()))
  owner.destroy()
  app.quit()
}

run().catch(error => {
  const message = typeof error === 'object' && error !== null && typeof error.message === 'string'
    ? error.message : inspect(error, { depth: 4 })
  console.error(`PLATFORM_STORAGE_ERROR ${message}`)
  setImmediate(() => { app.exit(1) })
})
