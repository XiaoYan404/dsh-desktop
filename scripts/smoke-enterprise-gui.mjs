import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [executableInput, appInput, profileInput, reportInput] = process.argv.slice(2)
if (!executableInput || !appInput || !profileInput || !reportInput) throw new Error('Executable, application, profile and report paths are required')
const profile = resolve(profileInput)
const reportPath = resolve(reportInput)
await mkdir(dirname(reportPath), { recursive: true })
const server = createServer()
await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
const port = server.address().port
await new Promise(accept => server.close(accept))
const env = { ...process.env, NO_PROXY: 'localhost,127.0.0.1,::1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_USE_ENV_PROXY
const executable = resolve(executableInput)
const args = [...(appInput === '-' ? [] : [resolve(appInput)]), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`]
const child = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' })
let launchError
const exit = new Promise(accept => {
  child.once('error', error => { launchError = error; accept(null) })
  child.once('exit', code => accept(code))
})
async function waitForExit(milliseconds) {
  let timer
  try {
    return await Promise.race([exit, new Promise((accept, reject) => {
      timer = setTimeout(() => reject(new Error('The owned GUI did not stop')), milliseconds)
      timer.unref()
    })])
  } finally { clearTimeout(timer) }
}
const report = { startedUtc: new Date().toISOString(), processId: child.pid, passed: false,
  dataIsolated: true, originalGuiTouched: false, completeReleaseBuild: false }
const deadline = Date.now() + 390_000
let socket
const pending = new Map()
let sequence = 0
function call(method, params = {}) {
  const id = ++sequence
  const result = Promise.withResolvers()
  const timer = setTimeout(() => {
    pending.delete(id)
    result.reject(new Error(`Inspection command timed out: ${method}`))
  }, 15_000)
  pending.set(id, result)
  socket.send(JSON.stringify({ id, method, params }))
  return result.promise.finally(() => clearTimeout(timer))
}
try {
  while (Date.now() < deadline) {
    if (launchError) throw new Error('The owned GUI could not start')
    if (child.exitCode !== null) throw new Error('The GUI exited before readiness')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      const targets = await response.json()
      const target = targets.find(value => value.type === 'page' && value.webSocketDebuggerUrl)
      if (target) {
        socket = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((accept, reject) => { socket.addEventListener('open', accept, { once: true }); socket.addEventListener('error', reject, { once: true }) })
        socket.addEventListener('message', (event) => {
          const value = JSON.parse(event.data)
          if (value.id) { const receiver = pending.get(value.id); pending.delete(value.id);
            if (value.error) receiver?.reject(new Error(value.error.message)); else receiver?.resolve(value.result) }
        })
        socket.addEventListener('close', () => {
          for (const receiver of pending.values()) receiver.reject(new Error('The GUI inspection connection closed'))
          pending.clear()
        })
        break
      }
    } catch (error) { /* Chromium may not have opened its debugger endpoint yet. */ }
    await new Promise(accept => setTimeout(accept, 500))
  }
  if (!socket) throw new Error('The owned GUI did not expose its inspection endpoint')
  let observed
  while (Date.now() < deadline) {
    let value
    try {
      value = await call('Runtime.evaluate', { expression: `(() => {
      const text = document.body?.innerText ?? '';
      return { title: document.title, office: text.includes('工作台'), ai: text.includes('AI会话') || text.includes('AI 会话'),
        contacts: text.includes('通讯录'), bodyLength: text.length, startup: !!document.querySelector('progress'),
        servicePage: location.hostname === '127.0.0.1', port: Number(location.port),
        fatal: /Client application failed to start|应用启动失败/.test(text) };
    })()`, returnByValue: true })
    } catch (error) {
      // The owned window navigates from the local startup page to the service.
      if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(error.message)) throw error
      await new Promise(accept => setTimeout(accept, 250))
      continue
    }
    observed = value.result?.value
    report.observed = observed
    if (observed?.servicePage && observed.office && observed.ai && observed.contacts && !observed.fatal) break
    if (observed?.fatal) throw new Error('The application displayed a startup failure')
    await new Promise(accept => setTimeout(accept, 1000))
  }
  report.observed = observed
  if (!observed?.servicePage || !observed.office || !observed.ai || !observed.contacts) throw new Error('The office navigation did not become ready')
  if (observed.port < 49152 || observed.port > 65535) throw new Error('The GUI did not use the permitted high port range')
  const image = await call('Page.captureScreenshot', { format: 'png' })
  await writeFile(reportPath.replace(/\.json$/, '.png'), Buffer.from(image.data, 'base64'))
  report.screenshot = reportPath.replace(/\.json$/, '.png')
  report.guiReady = true
  await call('Runtime.evaluate', { expression: 'window.close()' }).catch((error) => { /* Window shutdown can close CDP before its acknowledgement. */ })
  const result = await waitForExit(90_000)
  report.exitCode = result
  const state = JSON.parse(await readFile(join(profile, 'runtime-control', 'gui-hot-dev', 'state.json'), 'utf8'))
  report.controllerStatus = state.Status
  report.passed = result === 0 && state.Status === 'stopped'
  if (!report.passed) throw new Error('The GUI controller did not confirm complete shutdown')
} catch (error) {
  report.error = error.message
  if (socket?.readyState === WebSocket.OPEN) {
    await call('Runtime.evaluate', { expression: 'window.close()' }).catch((failure) => { /* Preserve the primary failure if shutdown closes CDP. */ })
  }
  process.exitCode = 1
} finally {
  socket?.close()
  if (!report.passed && !launchError) {
    const runtime = appInput === '-' ? join(dirname(executable), 'resources', 'enterprise-development')
      : join(repository, 'development')
    const cleanup = spawn(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(runtime, 'deepseek-harness', 'scripts', 'gui-hot-development.ps1'),
        '-Stop', '-NoOpen', '-RuntimeRoot', join(profile, 'runtime-control'),
        '-NodeDirectory', join(runtime, '.local-run', 'node-v24.22.0-win-x64')],
      { windowsHide: true, env, stdio: 'ignore', timeout: 90_000 })
    report.cleanupControllerExit = await new Promise(accept => {
      cleanup.once('error', () => accept(null))
      cleanup.once('exit', accept)
    })
  }
  if (!launchError && child.exitCode === null && !child.signalCode) {
    await waitForExit(15_000).catch(error => { report.guiShutdownTimeout = true })
    if (child.exitCode === null && !child.signalCode) {
      // Only this runner's isolated GUI is eligible for forced cleanup.
      child.kill()
      report.forcedGuiCleanup = true
      await waitForExit(15_000).catch(error => { report.guiExitUnconfirmed = true })
    }
  }
  report.finishedUtc = new Date().toISOString()
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, guiReady: report.guiReady ?? false,
    error: report.error ?? null, controllerStatus: report.controllerStatus ?? null }))
}
