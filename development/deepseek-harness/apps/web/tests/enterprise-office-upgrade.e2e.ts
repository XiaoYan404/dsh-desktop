/** Public-profile recovery; DSH_HISTORY_BASELINE_BIN selects an independently built previous CLI. */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const currentBin = join(REPO_ROOT, 'apps/cli/lib/bin.js')
const previousBin = resolve(process.env.DSH_HISTORY_BASELINE_BIN ?? currentBin)
const originalPrompt = 'Create the earlier-version acceptance file and retain this image.'
const originalReply = 'OLDER_HARNESS_COMPLETE'
const restoredReply = 'CURRENT_HARNESS_RESTORED'
const fileContents = 'OLDER_HARNESS_BYTES\n旧程序创建的真实文件。\n'
const sessionId = 'enterprise-history-upgrade'
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Frame controlled model inference while retaining actual tool execution and persistence. */
function response(text: string, path?: string): string {
  return [
    { type: 'message_start', message: { id: 'history-upgrade', model: 'deepseek-v4-flash', usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: path === undefined ? { type: 'text', text: '' } : { type: 'tool_use', id: 'history-write', name: 'write', input: {} } },
    { type: 'content_block_delta', index: 0, delta: path === undefined ? { type: 'text_delta', text } : { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: path, content: fileContents }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: path === undefined ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

/** Inventory only owned durable files; skip installed packages and derived projection caches. */
async function files(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', '.profiles', 'session_projcache'].includes(entry.name)) continue
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await files(root, path))
    else result.push(path)
  }
  return result
}

/** Own one supported CLI Web process and redact its authentication URL from failures. */
class HistoryWeb {
  private readonly child: ChildProcess
  private readonly closed: Promise<void>
  readonly ready: Promise<string>
  private output = ''

  constructor(bin: string, workspace: string, env: NodeJS.ProcessEnv, patch: string) {
    const ready = Promise.withResolvers<string>()
    this.ready = ready.promise
    this.child = spawn(process.execPath, [bin, 'web', '--patch',
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      '--patch', patch, '--no-open', '--port', '0'], {
      cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => { ready.reject(new Error('History Web startup timed out\n' + this.logs())) }, 30_000)
    const receive = (chunk: Buffer): void => {
      this.output = (this.output + chunk.toString()).slice(-24_000)
      const url = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u.exec(this.output)?.[1]
      if (url !== undefined) { clearTimeout(timer); ready.resolve(url) }
    }
    this.child.stdout?.on('data', receive)
    this.child.stderr?.on('data', receive)
    this.child.once('error', (error) => { clearTimeout(timer); ready.reject(error) })
    this.closed = new Promise(done => this.child.once('close', (code, signal) => {
      clearTimeout(timer)
      ready.reject(new Error(`History Web closed (${code}, ${signal})\n${this.logs()}`))
      done()
    }))
  }

  logs(): string { return this.output.replace(/([?&]token=)[^\s]+/gu, '$1[redacted]') }

  async stop(): Promise<void> {
    const timer = setTimeout(() => { this.child.kill('SIGKILL') }, 15_000)
    try {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM')
      await this.closed
    } finally { clearTimeout(timer) }
  }
}

it('retains native history, images, workspace and profile settings through office upgrade and previous-profile reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-upgrade-'))
  const home = join(root, 'home')
  const workspace = join(root, '原有工作目录 with spaces')
  const alternate = join(root, 'different initialization directory')
  const nativeFile = join(workspace, '旧程序写入.txt')
  const png = await readFile(join(REPO_ROOT, 'snapshots/session/read-image/workspace/red.png'))
  const requests: { messages?: unknown[] }[] = []
  const failures: string[] = []
  const model = createServer((request, reply) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.once('end', () => {
      try {
        requests.push(JSON.parse(body) as { messages?: unknown[] })
        reply.writeHead(200, { 'content-type': 'text/event-stream' })
        reply.end(requests.length === 1 ? response('', nativeFile) : response(requests.length === 2 ? originalReply : restoredReply))
      } catch (error) {
        failures.push(String(error))
        reply.writeHead(500).end()
      }
    })
  })
  onTestFinished(async () => {
    if (model.listening) await new Promise<void>((done) => { model.close(() => { done() }); model.closeAllConnections() })
    const target = resolve(root)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('dsh-history-upgrade-')) throw new Error('Unexpected history fixture cleanup root')
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await Promise.all([mkdir(workspace), mkdir(alternate)])
  await new Promise<void>(done => model.listen(0, '127.0.0.1', done))
  const address = model.address()
  if (address === null || typeof address === 'string') throw new Error('History model fixture did not listen')
  const env = { ...process.env, NODE_OPTIONS: '', DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access', DSH_TOOLS_MODE: 'native',
    DSH_PRIMARY_RUNTIME: '', DEEPSEEK_API_KEY: 'keyless-history-fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}` }
  const persistence = { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } }
  const directory = { companyName: 'History upgrade company', timeZone: 'Asia/Shanghai', members: [
    { id: 'admin', name: 'Administrator', department: 'Office', jobTitle: 'Admin', role: 'admin' },
    { id: 'employee', name: 'Employee', department: 'Office', jobTitle: 'Employee', role: 'employee' },
  ] }
  const sdkPatch = join(root, 'sdk.json')
  await writeFile(sdkPatch, JSON.stringify([persistence]))
  const seed = new DeepSeekHarness({ dshBin: previousBin, dshHome: home, cwd: workspace, patches: [sdkPatch],
    provider: 'deepseek-official', model: 'deepseek-v4-flash', env, initializeTimeoutMs: 20_000, requestTimeoutMs: 30_000 })
  try {
    const result = await seed.session(sessionId).run([
      { type: 'text', text: originalPrompt }, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ])
    expect(result.finalResponse).toBe(originalReply)
    expect(result.events.some(event => event.type === 'tool/call')).toBe(true)
  } finally { await seed.close() }
  expect(await readFile(nativeFile, 'utf8')).toBe(fileContents)
  const nativePaths = await files(home)
  const sessionPath = nativePaths.find(path => path.endsWith(join(sessionId, 'session.v4.jsonl')))
  const imagePath = nativePaths.find(path => path.includes(join('attachments', 'v1', 'objects')))
  if (sessionPath === undefined || imagePath === undefined) throw new Error('Original Session or admitted image is missing')
  const originalLog = await readFile(join(home, sessionPath))
  const sdkProfile = join(home, 'profiles/sdk/cordis.patch.yml')
  const originalSdkProfile = await readFile(sdkProfile)
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const webPatch = join(root, 'web.json')

  const browse = async (phase: 'seed' | 'upgrade' | 'rollback'): Promise<void> => {
    await writeFile(webPatch, JSON.stringify([persistence, { id: 'ui-settings-models', config: { credentialOnboarding: false } },
      ...(phase === 'upgrade' ? [{ id: 'enterprise-office', disabled: false, config: directory },
        { id: 'ui-office', disabled: false, config: { principalId: 'employee' } }] : []),
    ]))
    const web = new HistoryWeb(phase === 'upgrade' ? currentBin : previousBin, workspace, env, webPatch)
    const page = await newEnglishPage(browser)
    try {
      await page.addLocatorHandler(page.getByRole('dialog', { name: 'Preview Notice', exact: true }), async (dialog) => {
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
      })
      await page.goto(await web.ready, { waitUntil: 'load' })
      await page.locator('[data-slot="root"]').waitFor({ state: 'attached' })
      if (phase === 'upgrade') {
        await page.getByRole('button', { name: 'New to-do', exact: true }).first().click()
        const dialog = page.getByRole('dialog', { name: 'New to-do', exact: true })
        await dialog.getByLabel('Title', { exact: true }).fill('升级验收待办')
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()
        await dialog.waitFor({ state: 'hidden' })
        await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
      }
      await page.getByRole('treeitem', { name: basename(workspace), exact: true }).waitFor()
      await page.locator('button[aria-label="Settings"][aria-haspopup="dialog"]').click()
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
      await dialog.getByRole('button', { name: 'General', exact: true }).click()
      const dark = dialog.getByRole('button', { name: 'Dark', exact: true })
      if (phase === 'seed') await dark.click()
      await expect.poll(() => dark.getAttribute('aria-pressed')).toBe('true')
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).not.toBeNull()
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      await panel.getByRole('button', { name: 'View Subagent', exact: true }).click()
      const depth = panel.getByLabel('Maximum recursion depth', { exact: true })
      const capacity = panel.getByLabel('Subagent parallelism limit', { exact: true })
      if (phase === 'seed') {
        await depth.fill('2')
        await capacity.fill('12')
        await panel.getByRole('button', { name: 'Save', exact: true }).click()
        await expect.poll(() => panel.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
      }
      expect(await depth.inputValue()).toBe('2')
      expect(await capacity.inputValue()).toBe('12')
      await page.locator(`[data-row-key="session:${sessionId}"]`).click()
      await page.getByText(originalReply, { exact: true }).waitFor()
      if (phase !== 'seed') await page.getByText(restoredReply, { exact: true }).waitFor()
      const image = page.getByRole('img', { name: 'Image', exact: true })
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
      const imageBytes = await image.evaluate(async (element: HTMLImageElement) =>
        Array.from(new Uint8Array(await (await fetch(element.src)).arrayBuffer())))
      expect(Buffer.from(imageBytes).equals(png)).toBe(true)
      expect(await readFile(nativeFile, 'utf8')).toBe(fileContents)
    } catch (error) {
      await saveFailureShot(page, 'enterprise-office-history-' + phase)
      throw new Error(`History phase ${phase}: ${String(error).replace(/([?&]token=)[^\s]+/gu, '$1[redacted]')}\n${web.logs()}`)
    } finally { await page.close(); await web.stop() }
  }

  await browse('seed')
  const webProfile = join(home, 'profiles/web/cordis.patch.yml')
  const originalWebProfile = await readFile(webProfile)
  await writeFile(sdkPatch, JSON.stringify([persistence, { insert: [{ id: 'enterprise-office',
    name: pathToFileURL(join(REPO_ROOT, 'packages/enterprise/office/lib/index.js')).href, config: directory }] }]))
  const upgraded = new DeepSeekHarness({ dshBin: currentBin, dshHome: home, cwd: alternate, patches: [sdkPatch],
    provider: 'deepseek-official', model: 'deepseek-v4-flash', env, initializeTimeoutMs: 20_000, requestTimeoutMs: 30_000 })
  try {
    const session = upgraded.session(sessionId)
    expect((await session.run('Continue the original conversation.')).finalResponse).toBe(restoredReply)
    expect(await session.getWorkingDirectory()).toBe(workspace)
  } finally { await upgraded.close() }
  const appended = await readFile(join(home, sessionPath))
  expect(appended.length).toBeGreaterThan(originalLog.length)
  expect(appended.subarray(0, originalLog.length).equals(originalLog)).toBe(true)
  expect(JSON.stringify(requests[2]?.messages)).toContain(originalPrompt)
  expect(JSON.stringify(requests[2]?.messages)).toContain(originalReply)
  expect(hash(await readFile(join(home, imagePath)))).toBe(hash(png))
  await browse('upgrade')
  const officePaths = (await files(home)).filter(path => basename(path).startsWith('enterprise_office'))
  expect(officePaths.length).toBeGreaterThan(0)
  const officeBefore = await Promise.all(officePaths.map(path => readFile(join(home, path))))
  expect(officeBefore.map(bytes => bytes.toString()).join('')).toContain('升级验收待办')
  await browse('rollback')
  const reopened = await readFile(join(home, sessionPath))
  expect(reopened.subarray(0, appended.length).equals(appended)).toBe(true)
  // Reopening can append the native resume seed after a process was terminated.
  const readEvents = reopened.subarray(appended.length).toString().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { type: string })
  expect(readEvents.every(event => event.type === 'session/end-seed')).toBe(true)
  expect(await Promise.all(officePaths.map(path => readFile(join(home, path))))).toEqual(officeBefore)
  expect((await readFile(sdkProfile)).equals(originalSdkProfile)).toBe(true)
  expect((await readFile(webProfile)).equals(originalWebProfile)).toBe(true)
  expect(hash(await readFile(join(home, imagePath)))).toBe(hash(png))
  expect(requests).toHaveLength(3)
  expect(failures).toEqual([])
}, 150_000)
