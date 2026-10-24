/** Home file selections use real native upload receipts, tools, Session events and durable history. */
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { chromium, webkit, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-plan-mode'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  readPersistedEvents, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const content = 'HOME_UPLOAD_BYTES\n'
const reply = 'HOME_INPUT_ACCEPTED'
const argumentsJson = JSON.stringify({ file_path: '{{fromRequest:saved at "([^"]+)"}}' })
const replay: ReplayOverrideDoc = [
  { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('home-input-read'), name: 'read', arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 32, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] },
  { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: reply },
    { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
    { type: 'usage', usage: { inputTokens: 48, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] },
]

function userMessages(events: readonly SessionEvent[]) {
  return events.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

async function fixture(
  vision = false, withReply = true, extraOverlays: readonly string[] = [], script: ReplayOverrideDoc = replay, nativeActions = false,
  engine = chromium,
  fromNativeWorkspace = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-input-'))
  onTestFinished(async () => {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-input-')) throw new Error('Unexpected office-input fixture root')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const override = join(root, 'replay.json')
  const overlay = join(root, 'input.patch.json')
  await writeFile(override, JSON.stringify(script))
  await writeFile(overlay, JSON.stringify(vision ? [{ id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' } }] : []))
  const scaffold = await launchWebScaffold({
    profile: { packages: [] },
    ...(nativeActions ? { openInAppEnvironment: createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]) } : {}),
    ...(withReply ? { replayFixture: join(root, 'override-only.jsonl'), replayOverride: override } : {}),
    extraOverlayPath: [join(REPO_ROOT, 'enterprise-workbench.patch.yml'), overlay, ...extraOverlays],
  })
  onTestFinished(() => scaffold.close())
  const events: SessionEvent[] = []
  const stop = scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
  onTestFinished(() => { stop() })
  // Home-first scenarios register the real Host Workspace without first visiting a native input.
  // The shared-input case also covers the original native picker route explicitly.
  if (!fromNativeWorkspace) {
    const workspace = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(workspace, { recursive: true })
    await scaffold.ctx.workspaceController.create({ path: workspace })
  }
  const browser = await engine.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900, true)
  const console = watchConsole(page)
  const errorStacks: string[] = []
  page.on('pageerror', (error) => { errorStacks.push(error.stack ?? String(error)) })
  const rpcTrace: Array<{ kind: string; path: string; failure?: string }> = []
  page.on('pageerror', (error) => { rpcTrace.push({ kind: 'page-error', path: String(error) }) })
  page.on('console', (message) => {
    if (message.text().startsWith('[office-input-document]')) rpcTrace.push({ kind: message.text(), path: '' })
  })
  await page.addInitScript(() => {
    for (const kind of ['beforeunload', 'pagehide', 'pageshow'])
      window.addEventListener(kind, () => { globalThis.console.debug('[office-input-document]', kind) })
    const send = window.fetch
    let request = 0
    window.fetch = function (input, init) {
      const path = new URL(input instanceof Request ? input.url : input, location.href).pathname
      if (['/api/office/conversationLinks', '/api/office/conversationFiles', '/api/office/connections', '/api/skills/list'].includes(path)) {
        const id = ++request
        globalThis.console.debug('[office-input-document] rpc', JSON.stringify({ id, path, signal: !!init?.signal,
          aborted: init?.signal?.aborted, visibility: document.visibilityState }))
        init?.signal?.addEventListener('abort', () => {
          globalThis.console.debug('[office-input-document] abort', JSON.stringify({ id, path }))
        }, { once: true })
      }
      return send.call(this, input, init)
    }
  })
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/')) rpcTrace.push({ kind: 'request', path })
  })
  page.on('requestfailed', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/')) rpcTrace.push({ kind: 'failed', path, failure: request.failure()?.errorText ?? '' })
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) rpcTrace.push({ kind: 'navigation', path: new URL(frame.url()).pathname })
  })
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-home-input'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  if (fromNativeWorkspace) {
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
  return { scaffold, page, nav, console, errorStacks, rpcTrace, events }
}

// Host tests mirror this private browser record instead of importing a Client project into the Host program.
// Source: packages/client/ui-office/src/client/conversation-data.ts.
interface NavigationRecord {
  readonly formatVersion: 1
  readonly revision: number
  readonly data: {
    readonly entries: readonly { readonly principal: string; readonly sessionId: SessionId; readonly kind: 'ordinary' | 'item' }[]
    readonly ordinary: Readonly<Record<string, SessionId>>
  }
}

async function navigationRecord(page: Page): Promise<NavigationRecord> {
  return page.evaluate(() => new Promise<NavigationRecord>((resolveRecord, reject) => {
    const request = indexedDB.open('dsh.office.conversations.v2', 1)
    request.onupgradeneeded = () => {
      request.transaction?.abort()
      reject(new Error('Office navigation has not initialized'))
    }
    request.onerror = () => { reject(new Error('Navigation fixture could not open', { cause: request.error })) }
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('navigation', 'readonly')
      const read = transaction.objectStore('navigation').get('current')
      read.onsuccess = () => { database.close(); resolveRecord(read.result as NavigationRecord) }
      read.onerror = () => { database.close(); reject(new Error('Navigation fixture read failed', { cause: read.error })) }
    }
  }))
}

function homeCard(page: Page) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: 'AI chat', exact: true }) })
}

async function homeDraft(page: Page): Promise<string | null> {
  return homeCard(page).locator('textarea, [data-composer-input][contenteditable="true"]')
    .evaluate(node => node instanceof HTMLTextAreaElement ? node.value : node.textContent)
}

it.each([
  { image: false, withText: true }, { image: true, withText: true }, { image: false, withText: false },
])('submits a home file once with real stored bytes and native read execution (image=$image, text=$withText)', async ({ image, withText }) => {
  const { scaffold, page, nav, console, events } = await fixture(image)
  const prompt = page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true })
  const files = [{ name: 'office-home.txt', mimeType: 'text/plain', buffer: Buffer.from(content) }]
  if (image) files.push({ name: 'office-pixel.png', mimeType: 'image/png', buffer: await readFile(join(REPO_ROOT, 'snapshots', 'session', 'read-image', 'workspace', 'red.png')) })
  await page.getByLabel('Choose conversation attachments', { exact: true }).setInputFiles(files)
  await expect.poll(() => page.getByRole('list', { name: 'Unsent attachments', exact: true }).getByRole('listitem').count()).toBe(files.length)
  const text = withText ? 'Read the attached text file, then confirm the prepared input.' : ''
  await prompt.fill(text)
  await prompt.evaluate((element) => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Intentionally exercise a legacy IME event without isComposing.
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229, bubbles: true }))
  })
  expect(events.filter(event => event.type === 'user/message')).toEqual([])
  const settled = scaffold.whenTurnSettled()
  await prompt.evaluate((element) => {
    for (let index = 0; index < 2; index++) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  })
  const sessionId = await settled
  await page.getByText(reply, { exact: true }).waitFor({ timeout: 20_000 })
  const users = userMessages(events)
  expect(users).toHaveLength(1)
  const file = users[0]!.data.content.find(part => part.type === 'file')
  if (file?.type !== 'file') throw new Error('Native history has no admitted file')
  expect(file.attachment.name).toBe('office-home.txt')
  expect(file.attachment.attachmentId).toBe(`sha256:${createHash('sha256').update(content).digest('hex')}`)
  const path = scaffold.ctx.attachments.fileHostPath(file.attachment)
  if (!path) throw new Error('Native attachment store has no file path')
  expect(await readFile(path, 'utf8')).toBe(content)
  expect(users[0]!.data.content.filter(part => part.type === 'image')).toHaveLength(image ? 1 : 0)
  const result = events.find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Native read tool did not produce a result')
  expect(result.data.message.isError).toBe(false)
  expect(result.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('')).toContain('HOME_UPLOAD_BYTES')
  expect(userMessages(await readPersistedEvents(scaffold, sessionId))).toHaveLength(1)
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
  expect(await homeDraft(page)).toBe('')
  expect(await homeCard(page).getByText('office-home.txt', { exact: true }).count()).toBe(0)
  expect(await page.getByRole('list', { name: 'Unsent attachments', exact: true }).count()).toBe(0)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }].flatMap(browser =>
  (['pointer', 'keyboard'] as const).map(interaction => ({ ...browser, interaction }))),
)(
  '$name continues real RPC and keeps its draft after cancelling navigation ($interaction)', async ({ engine, interaction }) => {
    const { scaffold, page, events, console } = await fixture(false, false, [], replay, false, engine)
    const draft = 'Keep this draft after cancelling navigation'
    await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill(draft)
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    await expect.poll(() => input.textContent()).toBe(draft)
    await page.evaluate(() => {
      window.addEventListener('beforeunload', (event) => {
        event.preventDefault()
      }, { once: true })
    })
    const prompted = page.waitForEvent('dialog')
    await page.close({ runBeforeUnload: true })
    const dialog = await prompted
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss()
    expect(page.isClosed()).toBe(false)
    const profile = page.getByRole('button', { name: 'Profile', exact: true })
    if (interaction === 'pointer') await profile.click()
    else { await profile.focus(); await profile.press('Enter') }
    const form = page.getByRole('dialog', { name: 'Profile', exact: true })
    await form.getByLabel('Email', { exact: true }).fill('navigation-cancel@example.test')
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await form.waitFor({ state: 'hidden' })
    expect(scaffold.ctx.office.view('local' as OfficeMemberId).me.email).toBe('navigation-cancel@example.test')
    expect(await input.textContent()).toBe(draft)
    expect(userMessages(events)).toEqual([])
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  },
)

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }].flatMap(browser =>
  (['in-flight', 'fetch-start', 'beforeunload', 'pagehide'] as const).map(phase => ({ ...browser, phase }))))(
  '$name cancels previous document reads when reloading a native home input ($phase)', async ({ engine, phase }) => {
    const { scaffold, page, nav, events, console, errorStacks, rpcTrace } = await fixture(false, false, [], replay, false, engine)
    await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill('Document lifetime draft')
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    await expect.poll(() => input.textContent()).toBe('Document lifetime draft')
    await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
    const home = homeCard(page)
    const associations = home.getByRole('region', { name: 'Association details', exact: true })
    await expect.poll(() => associations.getByRole('button', { name: 'Link tools', exact: true }).isEnabled()).toBe(true)
    await expect.poll(() => associations.getByRole('button', { name: 'Refresh', exact: true }).isEnabled()).toBe(true)
    const warningStart = console.warnings.length
    let cleanup = () => {}
    try {
      if (phase === 'in-flight') {
        const original = scaffold.ctx.officeController.conversationLinks.bind(scaffold.ctx.officeController)
        const started = Promise.withResolvers<undefined>()
        const release = Promise.withResolvers<undefined>()
        const held = vi.spyOn(scaffold.ctx.officeController, 'conversationLinks').mockImplementationOnce(async (id) => {
          const value = await original(id)
          started.resolve(undefined)
          await release.promise
          return value
        })
        cleanup = () => { release.resolve(undefined); held.mockRestore() }
        await associations.getByRole('button', { name: 'Refresh', exact: true }).click()
        await started.promise
        await page.reload({ waitUntil: 'load' })
        release.resolve(undefined)
      } else if (phase === 'fetch-start') {
        await page.evaluate(() => {
          const fetch = window.fetch.bind(window)
          let reloading = false
          window.fetch = (input, init) => {
            const response = fetch(input, init)
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
            if (!reloading && new URL(url, location.href).pathname === '/api/office/conversationLinks') {
              reloading = true
              queueMicrotask(() => { location.reload() })
            }
            return response
          }
        })
        const loaded = page.waitForEvent('load')
        await associations.getByRole('button', { name: 'Refresh', exact: true }).click()
        await loaded
      } else {
        await associations.getByRole('button', { name: 'Refresh', exact: true }).evaluate((button, name) => {
          window.addEventListener(name, () => { if (button instanceof HTMLButtonElement) button.click() }, { once: true })
        }, phase)
        await page.reload({ waitUntil: 'load' })
      }
      await expect.poll(() => home.locator('[data-composer-input][contenteditable="true"]').textContent())
        .toBe('Document lifetime draft')
      acknowledgeReloadConnectionLoss(console, warningStart)
      if (console.pageErrors.length || console.warnings.length)
        throw new Error('Document reload console validation failed: ' + JSON.stringify({ ...console, errorStacks, rpcTrace }))
      expect(userMessages(events)).toEqual([])
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
    } finally { cleanup() }
  },
)

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }].flatMap(browser =>
  [false, true].map(fromNativeWorkspace => ({ ...browser, fromNativeWorkspace }))),
)(
  '$name shares the native ordinary draft and attachment with home and sends once through the same conversation (native=$fromNativeWorkspace)',
  async ({ name, engine, fromNativeWorkspace }) => {
    const { scaffold, page, nav, events, console } = await fixture(false, true, [], replay, false, engine, fromNativeWorkspace)
    const home = page.locator('section').filter({ has: page.getByRole('heading', { name: 'AI chat', exact: true }) })
    const initial = home.locator('textarea, [data-composer-input][contenteditable="true"]')
    await initial.waitFor()
    if (await initial.evaluate(node => node instanceof HTMLTextAreaElement)) await initial.fill('Prepare this ordinary input')
    else await writeComposerDraft(page, initial, 'Prepare this ordinary input')
    await home.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({
      name: 'home-shared.txt', mimeType: 'text/plain', buffer: Buffer.from(content),
    })
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
    const nativeInput = page.locator('[data-composer-input][contenteditable="true"]')
    await expect.poll(() => nativeInput.textContent()).toBe('Prepare this ordinary input')
    await writeComposerDraft(page, nativeInput, 'Continue this same ordinary conversation')
    await expect.poll(async () => (await navigationRecord(page)).data.ordinary.local).toBeDefined()
    const ordinaryId = (await navigationRecord(page)).data.ordinary.local
    await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
    const homeInput = home.locator('textarea, [data-composer-input][contenteditable="true"]')
    await expect.poll(() => homeInput.evaluate(node => node instanceof HTMLTextAreaElement ? node.value : node.textContent))
      .toBe('Continue this same ordinary conversation')
    await home.getByText('home-shared.txt', { exact: true }).waitFor()
    await home.getByRole('button', { name: 'Link integrations', exact: true }).waitFor()
    await home.getByRole('button', { name: 'Link tools', exact: true }).waitFor()
    const snapshot = await captureStableAria(page, 'section:has(h2:text-is("AI chat"))', scaffold.workspaceCwd)
    const actual = `../.local-run/enterprise-round76-home-native-${name}-${fromNativeWorkspace}.actual.md`
    await writeFile(join(REPO_ROOT, actual), snapshot + '\n')
    await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-home-input/shared.expected.md'), snapshot, webSnapshotMode())
    await writeComposerDraft(page, homeInput, 'Finish this same ordinary conversation')
    await home.getByRole('button', { name: 'Open conversation', exact: true }).click()
    await expect.poll(() => nativeInput.textContent()).toBe('Finish this same ordinary conversation')
    await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
    await expect.poll(() => homeDraft(page)).toBe('Finish this same ordinary conversation')
    const settled = scaffold.whenTurnSettled()
    await homeInput.press('Control+Enter')
    await settled
    await page.getByText(reply, { exact: true }).waitFor()
    expect((await navigationRecord(page)).data.ordinary.local).toBe(ordinaryId)
    const sent = userMessages(events)
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0])).toContain('Finish this same ordinary conversation')
    expect(JSON.stringify(sent[0])).toContain('home-shared.txt')
    const file = sent[0]!.data.content.find(part => part.type === 'file')
    if (file?.type !== 'file') throw new Error('Shared native input has no admitted file')
    expect(file.attachment.attachmentId).toBe(`sha256:${createHash('sha256').update(content).digest('hex')}`)
    const path = scaffold.ctx.attachments.fileHostPath(file.attachment)
    if (!path) throw new Error('Shared native input has no stored file path')
    expect(await readFile(path, 'utf8')).toBe(content)
    const result = events.find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Shared native input did not execute the read tool')
    expect(result.data.message.isError).toBe(false)
    expect(result.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('')).toContain('HOME_UPLOAD_BYTES')
    expect(userMessages(await readPersistedEvents(scaffold, ordinaryId!))).toHaveLength(1)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  },
)

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
  '$name preserves a native inline file reference through home edits, page switches and reload', async ({ engine }) => {
    const { scaffold, page, nav, events, console } = await fixture(false, false, [], replay, false, engine)
    await writeFile(join(scaffold.workspaceCwd, 'workspace', 'home-reference.txt'), 'HOME_REFERENCE_BYTES')
    await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill('Prepare an inline reference')
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    await writeComposerDraft(page, input, '@home-reference.txt')
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions', exact: true })
    await menu.getByRole('option', { name: 'home-reference.txt', exact: true }).click()
    await expect.poll(() => input.locator('[data-composer-chip]').count()).toBe(1)
    await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
    const home = homeCard(page).locator('[data-composer-input][contenteditable="true"]')
    await expect.poll(() => home.locator('[data-composer-chip]').count()).toBe(1)
    await home.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type(' Home note')
    await expect.poll(() => home.textContent()).toContain('Home note')
    expect(await home.locator('[data-composer-chip]').count()).toBe(1)
    const homeWarningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => home.textContent()).toContain('Home note')
    expect(await home.locator('[data-composer-chip]').count()).toBe(1)
    acknowledgeReloadConnectionLoss(console, homeWarningStart)
    await homeCard(page).getByRole('button', { name: 'Open conversation', exact: true }).click()
    await expect.poll(() => input.textContent()).toContain('Home note')
    expect(await input.locator('[data-composer-chip]').count()).toBe(1)
    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => home.textContent()).toContain('Home note')
    expect(await home.locator('[data-composer-chip]').count()).toBe(1)
    acknowledgeReloadConnectionLoss(console, warningStart)
    expect(userMessages(events)).toEqual([])
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  },
)

it('cancels preparation without sending or clearing retained home input, then retries it', async () => {
  const { scaffold, page, events, console } = await fixture()
  const prompt = page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true })
  await prompt.fill('Keep this input when preparation is cancelled.')
  await page.getByLabel('Choose conversation attachments', { exact: true }).setInputFiles({
    name: 'office-home.txt', mimeType: 'text/plain', buffer: Buffer.from(content),
  })
  const release = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const store = scaffold.ctx.attachments
  const save = store.saveFileStream.bind(store)
  let completed = 0
  const held = vi.spyOn(store, 'saveFileStream').mockImplementation(async (input) => {
    started.resolve(undefined)
    try {
      await release.promise
      return await save(input)
    } finally { completed++ }
  })
  try {
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await started.promise
    await page.getByRole('progressbar', { name: 'Preparing conversation and attachments', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    release.resolve(undefined)
    await expect.poll(() => completed).toBeGreaterThan(0)
    expect(await prompt.inputValue()).toBe('Keep this input when preparation is cancelled.')
    expect(await page.getByRole('list', { name: 'Unsent attachments', exact: true }).getByRole('listitem').count()).toBe(1)
    expect(await page.getByRole('progressbar', { name: 'Preparing conversation and attachments', exact: true }).count()).toBe(0)
    expect(userMessages(events)).toEqual([])
    held.mockRestore()
    const settled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await settled
    await page.getByText(reply, { exact: true }).waitFor({ timeout: 20_000 })
    expect(userMessages(events)).toHaveLength(1)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally {
    release.resolve(undefined)
    held.mockRestore()
  }
})

it('expands a prepared text and file into the original composer without submitting', async () => {
  const { scaffold, page, nav, events, console } = await fixture()
  const prompt = page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true })
  expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true)
  await prompt.fill('Review this draft before sending.')
  await page.getByLabel('Choose conversation attachments', { exact: true }).setInputFiles([
    { name: 'remove-this.txt', mimeType: 'text/plain', buffer: Buffer.from('removed selection') },
    { name: 'office-home.txt', mimeType: 'text/plain', buffer: Buffer.from(content) },
  ])
  await page.getByRole('button', { name: 'Remove attachment · remove-this.txt', exact: true }).click()
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await expect.poll(() => input.textContent()).toBe('Review this draft before sending.')
  await page.getByText('office-home.txt', { exact: true }).first().waitFor()
  expect(userMessages(events)).toEqual([])
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  await settled
  await page.getByText(reply, { exact: true }).waitFor({ timeout: 20_000 })
  expect(userMessages(events)).toHaveLength(1)
  expect(userMessages(events)[0]!.data.content.filter(part => part.type === 'file')).toHaveLength(1)
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
  expect(await homeDraft(page)).toBe('')
  expect(await page.getByRole('list', { name: 'Unsent attachments', exact: true }).count()).toBe(0)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('keeps failed uploads and text at home, then retries through the original native uploader', async () => {
  const { scaffold, page, events, console } = await fixture()
  const prompt = page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true })
  await prompt.fill('Retry the retained file after preparation fails.')
  await page.getByLabel('Choose conversation attachments', { exact: true }).setInputFiles({ name: 'office-home.txt', mimeType: 'text/plain', buffer: Buffer.from(content) })
  const failure = vi.spyOn(scaffold.ctx.attachments, 'saveFileStream').mockRejectedValue(new Error('Expected native upload storage failure'))
  onTestFinished(() => { failure.mockRestore() })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => failure.mock.calls.length).toBeGreaterThan(0)
  await page.getByRole('alert').filter({ hasText: 'Not sent.' }).waitFor({ timeout: 15_000 })
  expect(await prompt.inputValue()).toBe('Retry the retained file after preparation fails.')
  expect(await page.getByRole('list', { name: 'Unsent attachments', exact: true }).getByRole('listitem').count()).toBe(1)
  expect(userMessages(events)).toHaveLength(0)
  failure.mockRestore()
  const settled = scaffold.whenTurnSettled()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await settled
  await page.getByText(reply, { exact: true }).waitFor({ timeout: 20_000 })
  expect(userMessages(events)).toHaveLength(1)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('keeps distinct item conversations, draft files and filters, and restores each link after reload', async () => {
  const { scaffold, page, nav, events, console } = await fixture()
  const actor = 'local' as OfficeMemberId
  const date = scaffold.ctx.office.view(actor).day.date
  const first = await scaffold.ctx.office.createWork(actor, {
    kind: 'task', title: 'Independent item A', description: 'Actual first item material', ownerId: actor, date,
  })
  const second = await scaffold.ctx.office.createWork(actor, {
    kind: 'task', title: 'Independent item B', description: 'Actual second item material', ownerId: actor, date,
  })
  await nav.getByRole('button', { name: 'Work', exact: true }).click()
  await page.getByRole('button', { name: 'Assigned by me', exact: true }).click()
  const status = page.getByRole('main').getByLabel('Status', { exact: true })
  await status.selectOption('pending')
  const details = page.getByRole('dialog', { name: 'Work details', exact: true })
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  const card = page.getByRole('complementary', { name: 'Item context', exact: true })
  await page.locator(`[data-office-item="${first.id}"]`).click()
  await details.getByText('Internal office', { exact: false }).waitFor()
  await details.getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  await card.getByText(first.title, { exact: true }).waitFor()
  await expect.poll(() => input.textContent()).toContain('Actual first item material')
  expect(userMessages(events)).toEqual([])
  await writeComposerDraft(page, input, 'Draft only for item A')
  await page.locator('input[type="file"]').setInputFiles({ name: 'office-home.txt', mimeType: 'text/plain', buffer: Buffer.from(content) })
  await page.getByTitle('office-home.txt', { exact: true }).waitFor()
  const firstId = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  await card.getByRole('button', { name: 'Back to item', exact: true }).click()
  await details.waitFor()
  expect(await status.inputValue()).toBe('pending')
  expect(await page.getByRole('button', { name: 'Assigned by me', exact: true }).getAttribute('aria-pressed')).toBe('true')
  await details.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator(`[data-office-item="${second.id}"]`).click()
  await details.getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  await card.getByText(second.title, { exact: true }).waitFor()
  await expect.poll(() => input.textContent()).toContain('Actual second item material')
  expect(await page.getByRole('group', { name: 'Pending attachments', exact: true }).count()).toBe(0)
  await writeComposerDraft(page, input, 'Draft only for item B')
  const secondId = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  expect(firstId.sessionId).toBeTruthy()
  expect(secondId.sessionId).toBeTruthy()
  expect(firstId.sessionId).not.toBe(secondId.sessionId)
  await card.getByRole('button', { name: 'Back to item', exact: true }).click()
  await details.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator(`[data-office-item="${first.id}"]`).click()
  await details.getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  await expect.poll(() => input.textContent()).toBe('Draft only for item A')
  await page.getByTitle('office-home.txt', { exact: true }).waitFor()
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const admitted = await settled
  expect(admitted).toBe(firstId.sessionId)
  await page.getByText(reply, { exact: true }).waitFor({ timeout: 20_000 })
  expect(userMessages(events)).toHaveLength(1)
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'Work', exact: true }).click()
  await page.locator(`[data-office-item="${second.id}"]`).click()
  await details.getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  await expect.poll(() => input.textContent()).toBe('Draft only for item B')
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  expect(restored.sessionId).toBe(secondId.sessionId)
  await scaffold.ctx.office.setStatus(actor, second.id, second.revision, 'in_progress')
  await card.getByRole('status').waitFor()
  expect(await input.textContent()).toBe('Draft only for item B')
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(userMessages(await readPersistedEvents(scaffold, admitted))).toHaveLength(1)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('restores the ordinary return target and keeps each native text and file draft separate from item assistance', async () => {
  const { scaffold, page, nav, events, console } = await fixture(false, false)
  const actor = 'local' as OfficeMemberId
  const date = scaffold.ctx.office.view(actor).day.date
  const item = await scaffold.ctx.office.createWork(actor, {
    kind: 'task', title: 'Keep item input separate', description: 'Actual authorized item', ownerId: actor, date,
  })
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  const currentId = () => page.evaluate(() =>
    (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
  const prompt = page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true })
  await prompt.fill('Ordinary draft A')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect.poll(() => input.textContent()).toBe('Ordinary draft A')
  await page.locator('input[type="file"]').setInputFiles({ name: 'ordinary-a.txt', mimeType: 'text/plain', buffer: Buffer.from('File A stays in A') })
  await page.getByTitle('ordinary-a.txt', { exact: true }).waitFor()
  const firstId = await currentId()
  const history = page.getByRole('region', { name: 'Conversations', exact: true })
  await history.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect.poll(currentId).not.toBe(firstId)
  await writeComposerDraft(page, input, 'Ordinary draft B')
  await page.locator('input[type="file"]').setInputFiles({ name: 'ordinary-b.txt', mimeType: 'text/plain', buffer: Buffer.from('File B stays in B') })
  await page.getByTitle('ordinary-b.txt', { exact: true }).waitFor()
  const secondId = await currentId()
  await nav.getByRole('button', { name: 'Work', exact: true }).click()
  await page.locator(`[data-office-item="${item.id}"]`).click()
  await page.getByRole('dialog', { name: 'Work details', exact: true }).getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  await page.getByRole('complementary', { name: 'Item context', exact: true }).waitFor()
  await writeComposerDraft(page, input, 'Item-only draft')
  await page.locator('input[type="file"]').setInputFiles({ name: 'item-only.txt', mimeType: 'text/plain', buffer: Buffer.from('File C stays in item') })
  await page.getByTitle('item-only.txt', { exact: true }).waitFor()
  const itemId = await currentId()
  expect(new Set([firstId, secondId, itemId]).size).toBe(3)
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
  await expect.poll(() => homeDraft(page)).toBe('Ordinary draft B')
  await homeCard(page).getByTitle('ordinary-b.txt', { exact: true }).waitFor()
  expect(await homeCard(page).getByTitle('item-only.txt', { exact: true }).count()).toBe(0)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect.poll(currentId).toBe(secondId)
  await expect.poll(() => input.textContent()).toBe('Ordinary draft B')
  await page.getByTitle('ordinary-b.txt', { exact: true }).waitFor()
  expect(await page.getByTitle('item-only.txt', { exact: true }).count()).toBe(0)
  expect(await page.getByTitle('ordinary-a.txt', { exact: true }).count()).toBe(0)
  expect(await page.getByRole('complementary', { name: 'Item context', exact: true }).count()).toBe(0)
  await history.locator(`[data-office-session="${firstId}"]`).click()
  await expect.poll(() => input.textContent()).toBe('Ordinary draft A')
  await page.getByTitle('ordinary-a.txt', { exact: true }).waitFor()
  expect(await page.getByTitle('ordinary-b.txt', { exact: true }).count()).toBe(0)
  await nav.getByRole('button', { name: 'Work', exact: true }).click()
  await page.getByRole('dialog', { name: 'Work details', exact: true }).getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  await expect.poll(currentId).toBe(itemId)
  await expect.poll(() => input.textContent()).toBe('Item-only draft')
  await page.getByTitle('item-only.txt', { exact: true }).waitFor()
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await expect.poll(currentId).toBe(firstId)
  await expect.poll(() => input.textContent()).toBe('Ordinary draft A')
  await page.getByTitle('ordinary-a.txt', { exact: true }).waitFor()
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await expect.poll(currentId).toBe(firstId)
  await expect.poll(() => input.textContent()).toBe('Ordinary draft A')
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(userMessages(events)).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('preserves the ordinary return target when two windows record ordinary and item conversations', async () => {
  const { scaffold, page, events, console } = await fixture(false, false)
  const actor = 'local' as OfficeMemberId
  const item = await scaffold.ctx.office.createWork(actor, {
    kind: 'task', title: 'Other window item', description: 'Keep this item draft private to its input',
    ownerId: actor, date: scaffold.ctx.office.view(actor).day.date,
  })
  const second = await page.context().newPage()
  const secondConsole = watchConsole(second)
  await second.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const secondNav = second.getByRole('navigation', { name: 'Workbench', exact: true })
  await secondNav.getByRole('button', { name: 'Workbench', exact: true }).waitFor()

  await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill('Ordinary window draft')
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const firstInput = page.locator('[data-composer-input][contenteditable="true"]')
  await expect.poll(() => firstInput.textContent()).toBe('Ordinary window draft')
  const ordinaryId = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
  expect(ordinaryId).toBeTruthy()

  await secondNav.getByRole('button', { name: 'Work', exact: true }).click()
  await second.locator(`[data-office-item="${item.id}"]`).click()
  await second.getByRole('dialog', { name: 'Work details', exact: true })
    .getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  await second.getByRole('complementary', { name: 'Item context', exact: true }).waitFor()
  const secondInput = second.locator('[data-composer-input][contenteditable="true"]')
  await writeComposerDraft(second, secondInput, 'Other window item draft')
  const itemId = await second.evaluate(() =>
    (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
  expect(itemId).toBeTruthy()
  expect(itemId).not.toBe(ordinaryId)

  await secondNav.getByRole('button', { name: 'Workbench', exact: true }).click()
  await second.getByRole('button', { name: 'Open conversation', exact: true }).click()
  await expect.poll(() => secondInput.textContent()).toBe('Ordinary window draft')
  expect(await firstInput.textContent()).toBe('Ordinary window draft')

  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'AI chat', exact: true }).click()
  try { await expect.poll(() => firstInput.textContent()).toBe('Ordinary window draft') }
  catch (error) { await saveFailureShot(page, 'enterprise-office-two-window-reload'); throw error }
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(userMessages(events)).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  expect(secondConsole.pageErrors).toEqual([])
  expect(secondConsole.warnings).toEqual([])
})

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }].flatMap(browser =>
  (['employee', 'sessions', 'workspaces'] as const).flatMap(dependency =>
    [false, true].map(cancel => ({ ...browser, dependency, cancel })))),
)(
  '$name waits for $dependency before restoring the ordinary input after reload (cancel=$cancel)', async ({ engine, dependency, cancel }) => {
    const release = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const { scaffold, page, nav, events, console, errorStacks, rpcTrace } = await fixture(false, false, [], replay, false, engine)
    let hold = false
    const controller = scaffold.ctx.officeController
    const original = controller.view.bind(controller)
    const delayed = vi.spyOn(controller, 'view').mockImplementation(async (date) => {
      if (hold && dependency === 'employee') { started.resolve(undefined); await release.promise }
      return original(date)
    })
    const sessions = scaffold.ctx.sessionController
    const control = sessions.control.bind(sessions)
    const delayedSessions = vi.spyOn(sessions, 'control').mockImplementation(async function* (signal) {
      if (hold && dependency === 'sessions') { started.resolve(undefined); await release.promise }
      yield* control(signal)
    })
    // A refresh can obtain the same catalog through list before the control baseline arrives.
    const list = sessions.list.bind(sessions)
    const delayedList = vi.spyOn(sessions, 'list').mockImplementation(async (request, signal) => {
      if (hold && dependency === 'sessions') { started.resolve(undefined); await release.promise }
      return list(request, signal)
    })
    const workspaces = scaffold.ctx.workspaceController
    const follow = workspaces.follow.bind(workspaces)
    const delayedWorkspaces = vi.spyOn(workspaces, 'follow').mockImplementation(async function* (signal) {
      if (hold && dependency === 'workspaces') { started.resolve(undefined); await release.promise }
      yield* follow(signal)
    })
    onTestFinished(() => {
      release.resolve(undefined)
      delayed.mockRestore()
      delayedSessions.mockRestore()
      delayedList.mockRestore()
      delayedWorkspaces.mockRestore()
    })
    try {
      const actor = 'local' as OfficeMemberId
      const item = await scaffold.ctx.office.createWork(actor, {
        kind: 'task', title: 'Startup item', description: 'The item must not replace the ordinary return',
        ownerId: actor, date: scaffold.ctx.office.view(actor).day.date,
      })
      await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill('Startup ordinary draft')
      await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
      const input = page.locator('[data-composer-input][contenteditable="true"]')
      await expect.poll(() => input.textContent()).toBe('Startup ordinary draft')
      await nav.getByRole('button', { name: 'Work', exact: true }).click()
      await page.locator('[data-office-item="' + item.id + '"]').click()
      await page.getByRole('dialog', { name: 'Work details', exact: true })
        .getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
      await page.getByRole('complementary', { name: 'Item context', exact: true }).waitFor()
      await writeComposerDraft(page, input, 'Startup item draft')
      const previous = await navigationRecord(page)
      expect(previous.data.entries.some(entry => entry.kind === 'item')).toBe(true)
      await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
      hold = true
      const warningStart = console.warnings.length
      await page.reload({ waitUntil: 'load' })
      await started.promise
      if (dependency !== 'employee') {
        await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).waitFor()
      }
      const entry = nav.getByRole('button', { name: 'AI chat', exact: true })
      await entry.click()
      await expect.poll(() => entry.getAttribute('aria-busy')).toBe('true')
      expect((await navigationRecord(page)).data.ordinary.local).toBe(previous.data.ordinary.local)
      if (cancel) await nav.getByRole('button', { name: 'Work', exact: true }).click()
      release.resolve(undefined)
      try {
        if (cancel) {
          await page.getByRole('heading', { name: 'Work', exact: true }).waitFor()
          await page.locator('[data-office-item="' + item.id + '"]').waitFor()
          expect(await input.count()).toBe(0)
        } else await expect.poll(async () => await input.count() ? input.textContent() : null).toBe('Startup ordinary draft')
      }
      catch (error) { await saveFailureShot(page, 'enterprise-office-startup-view'); throw error }
      expect((await navigationRecord(page)).data.ordinary.local).toBe(previous.data.ordinary.local)
      acknowledgeReloadConnectionLoss(console, warningStart)
      if (console.pageErrors.length || console.warnings.length) {
        throw new Error('Startup console validation failed: ' + JSON.stringify({ ...console, errorStacks, rpcTrace }))
      }
      expect(userMessages(events)).toEqual([])
      expect(console.pageErrors).toEqual([])
      expect(console.warnings, JSON.stringify(console.warnings)).toEqual([])
    } finally {
      release.resolve(undefined)
    }
  },
)

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
  '$name preserves simultaneous office-window commits and restores both native drafts', async ({ engine }) => {
    const { scaffold, page, events, console } = await fixture(false, false, [], replay, false, engine)
    const second = await page.context().newPage()
    const secondConsole = watchConsole(second)
    await second.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const secondNav = second.getByRole('navigation', { name: 'Workbench', exact: true })
    await secondNav.getByRole('button', { name: 'Workbench', exact: true }).waitFor()
    const before = new Set((await navigationRecord(page)).data.entries.map(entry => entry.sessionId))
    await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill('Concurrent ordinary window A')
    await second.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill('Concurrent ordinary window B')
    // Hold the store's write lock until both independent windows have enqueued their own write transactions.
    // Continuously pending reads keep this fixture-owned transaction active without any timer-based ordering.
    await page.evaluate(() => new Promise<void>((resolveLock, reject) => {
      const request = indexedDB.open('dsh.office.conversations.v2', 1)
      request.onerror = () => { reject(new Error('Navigation race lock failed', { cause: request.error })) }
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('navigation', 'readwrite')
        transaction.oncomplete = () => { database.close() }
        transaction.onabort = () => { database.close() }
        const store = transaction.objectStore('navigation')
        const next = () => {
          const read = store.get('current')
          read.onsuccess = () => {
            resolveLock()
            if (localStorage.getItem('fixture.navigation.release') !== 'released') next()
          }
        }
        next()
      }
    }))
    for (const [window, name] of [[page, 'first'], [second, 'second']] as const) {
      await window.evaluate((name) => {
        // oxlint-disable-next-line typescript/unbound-method -- the wrapper preserves the database receiver
        const original = IDBDatabase.prototype.transaction
        IDBDatabase.prototype.transaction = function (this: IDBDatabase, stores, mode, options) {
          if (this.name === 'dsh.office.conversations.v2' && mode === 'readwrite') {
            IDBDatabase.prototype.transaction = original
            localStorage.setItem('fixture.navigation.queued.' + name, 'queued')
          }
          return original.call(this, stores, mode, options)
        }
      }, name)
    }
    try {
      await Promise.all([
        page.getByRole('button', { name: 'Open conversation', exact: true }).click(),
        second.getByRole('button', { name: 'Open conversation', exact: true }).click(),
      ])
      await expect.poll(() => page.evaluate(() =>
        ['first', 'second'].every(name => localStorage.getItem('fixture.navigation.queued.' + name) === 'queued'))).toBe(true)
    } finally {
      await page.evaluate(() => { localStorage.setItem('fixture.navigation.release', 'released') })
    }
    const firstInput = page.locator('[data-composer-input][contenteditable="true"]')
    const secondInput = second.locator('[data-composer-input][contenteditable="true"]')
    await expect.poll(() => firstInput.textContent()).toBe('Concurrent ordinary window A')
    await expect.poll(() => secondInput.textContent()).toBe('Concurrent ordinary window B')
    await expect.poll(async () => (await navigationRecord(page)).data.entries.filter(entry => !before.has(entry.sessionId)).length).toBe(2)
    const saved = await navigationRecord(page)
    const created = saved.data.entries.filter(entry => !before.has(entry.sessionId))
    expect(created.every(entry => entry.principal === 'local' && entry.kind === 'ordinary')).toBe(true)
    expect(new Set(created.map(entry => entry.sessionId)).size).toBe(2)
    expect(await secondInput.textContent()).toBe('Concurrent ordinary window B')

    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'AI chat', exact: true }).click()
    acknowledgeReloadConnectionLoss(console, warningStart)
    const history = page.getByRole('region', { name: 'Conversations', exact: true })
    if (!await history.isVisible()) {
      try { await page.getByRole('button', { name: 'Conversations', exact: true }).click() }
      catch (error) { await saveFailureShot(page, 'enterprise-office-atomic-reload'); throw error }
    }
    const restored = []
    for (const entry of created) {
      const choice = history.locator('[data-office-session="' + entry.sessionId + '"]')
      await choice.click()
      await expect.poll(() => choice.getAttribute('aria-current')).toBe('page')
      await expect.poll(() => firstInput.textContent()).toMatch(/^Concurrent ordinary window [AB]$/)
      restored.push(await firstInput.textContent())
    }
    expect(restored.sort()).toEqual(['Concurrent ordinary window A', 'Concurrent ordinary window B'])
    const savedIds = saved.data.entries.map(entry => entry.sessionId)
    expect((await navigationRecord(page)).data.entries.map(entry => entry.sessionId)).toEqual(savedIds)
    expect(userMessages(events)).toEqual([])
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
    expect(secondConsole.pageErrors).toEqual([])
    expect(secondConsole.warnings).toEqual([])
  },
)

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
  '$name leaves a failed navigation transaction uncommitted and recovers without replacing its native draft', async ({ engine }) => {
    const { page, events, console } = await fixture(false, false, [], replay, false, engine)
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    const prompt = page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true })
    await prompt.fill('Previously committed ordinary draft')
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
    await expect.poll(() => input.textContent()).toBe('Previously committed ordinary draft')
    await expect.poll(async () => (await navigationRecord(page)).data.entries.length).toBeGreaterThan(0)
    const before = await navigationRecord(page)
    const history = page.getByRole('region', { name: 'Conversations', exact: true })
    if (!await history.isVisible()) await page.getByRole('button', { name: 'Conversations', exact: true }).click()
    await page.evaluate(() => {
      // oxlint-disable-next-line typescript/unbound-method -- the wrapper calls this method with its original object-store receiver
      const original = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === 'navigation') {
          IDBObjectStore.prototype.put = original
          throw new DOMException('Navigation fixture quota', 'QuotaExceededError')
        }
        return original.call(this, value, key)
      }
    })
    await history.getByRole('button', { name: 'New conversation', exact: true }).click()
    await writeComposerDraft(page, input, 'Keep this uncommitted navigation draft')
    await expect.poll(() => input.textContent()).toBe('Keep this uncommitted navigation draft')
    await page.getByRole('alert').filter({ hasText: 'Conversation navigation is unavailable.' }).first().waitFor()
    expect(await navigationRecord(page)).toEqual(before)
    if (!await history.isVisible()) await page.getByRole('button', { name: 'Conversations', exact: true }).click()
    await history.getByRole('button', { name: 'Refresh conversations', exact: true }).click()
    await expect.poll(async () => (await navigationRecord(page)).revision).toBe(before.revision + 1)
    expect(await input.textContent()).toBe('Keep this uncommitted navigation draft')
    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'AI chat', exact: true }).click()
    await expect.poll(() => input.textContent()).toBe('Keep this uncommitted navigation draft')
    acknowledgeReloadConnectionLoss(console, warningStart)
    expect(userMessages(events)).toEqual([])
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  },
)

it.each([{ name: 'Chromium', engine: chromium }, { name: 'WebKit', engine: webkit }])(
  '$name imports legacy navigation once without rewriting its bytes or native draft', async ({ engine }) => {
    const { page, events, console } = await fixture(false, false, [], replay, false, engine)
    await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill('Legacy ordinary draft')
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]')
    await expect.poll(() => input.textContent()).toBe('Legacy ordinary draft')
    await expect.poll(async () => (await navigationRecord(page)).data.ordinary.local).toBeDefined()
    const previous = await navigationRecord(page)
    const legacy = JSON.stringify(previous.data, null, 2) + '\n'
    // This fixture owns a fresh browser context; removing only its new database models the pre-upgrade browser.
    await page.evaluate(async (raw) => {
      localStorage.setItem('dsh.office.conversations.v1', raw)
      await new Promise<void>((resolveDelete, reject) => {
        const deletion = indexedDB.deleteDatabase('dsh.office.conversations.v2')
        deletion.onsuccess = () => { resolveDelete() }
        deletion.onerror = () => { reject(new Error('Legacy fixture deletion failed', { cause: deletion.error })) }
        deletion.onblocked = () => { reject(new Error('Legacy fixture retained a database connection')) }
      })
    }, legacy)
    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await homeCard(page).locator('textarea, [data-composer-input][contenteditable="true"]').waitFor()
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'AI chat', exact: true }).click()
    await expect.poll(() => input.textContent()).toBe('Legacy ordinary draft')
    expect((await navigationRecord(page)).data).toEqual(previous.data)
    expect(await page.evaluate(() => localStorage.getItem('dsh.office.conversations.v1'))).toBe(legacy)
    await page.evaluate(() => { localStorage.setItem('dsh.office.conversations.v1', 'obsolete predecessor must not be reread') })
    await page.reload({ waitUntil: 'load' })
    await homeCard(page).locator('textarea, [data-composer-input][contenteditable="true"]').waitFor()
    await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'AI chat', exact: true }).click()
    await expect.poll(() => input.textContent()).toBe('Legacy ordinary draft')
    expect((await navigationRecord(page)).data).toEqual(previous.data)
    acknowledgeReloadConnectionLoss(console, warningStart)
    expect(userMessages(events)).toEqual([])
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  },
)

it('executes the native todo tool from the workbench and restores its plan without creating employee work items', async () => {
  const todos = [
    { content: 'Inspect the native automation plan', status: 'in_progress' },
    { content: 'Verify its durable recovery', status: 'pending' },
  ]
  const script: ReplayOverrideDoc = [
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-native-todos'), name: 'todo_write', arguments: JSON.stringify({ todos }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'NATIVE_TODO_PLAN_ACCEPTED' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ]
  const { scaffold, page, nav, events, console } = await fixture(false, true, [], script)
  const actor = 'local' as OfficeMemberId
  const before = scaffold.ctx.office.view(actor).items
  const settled = scaffold.whenTurnSettled()
  await page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true }).fill('Create the native Agent plan for this conversation.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const id = await settled
  await page.getByText('NATIVE_TODO_PLAN_ACCEPTED', { exact: true }).waitFor()
  expect(events.filter(event => event.type === 'todo/write')).toMatchObject([{ data: { todos } }])
  const panel = page.getByTestId('todo-panel')
  await panel.waitFor()
  const toggle = panel.locator('button[aria-expanded]').first()
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
  for (const todo of todos) await panel.getByText(todo.content, { exact: true }).waitFor()
  expect(await panel.locator('[data-status="in_progress"]').count()).toBe(1)
  expect(scaffold.ctx.office.view(actor).items).toEqual(before)
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await panel.waitFor()
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
  for (const todo of todos) await panel.getByText(todo.content, { exact: true }).waitFor()
  expect((await readPersistedEvents(scaffold, id)).filter(event => event.type === 'todo/write')).toMatchObject([{ data: { todos } }])
  expect(scaffold.ctx.office.view(actor).items).toEqual(before)
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(userMessages(events)).toHaveLength(1)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['approve', 'revise'] as const)('keeps native plan review pending across office navigation and records the %s decision', async (decision) => {
  const plan = '# Office automation plan\n\n- Keep employee tasks and Agent plans separate.\n- Verify the actual review decision.'
  const answer = decision === 'approve' ? 'NATIVE_PLAN_APPROVED' : 'NATIVE_PLAN_REVISION_REQUIRED'
  const script: ReplayOverrideDoc = [
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-native-plan-review'), name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: answer } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ]
  const { scaffold, page, nav, events, console } = await fixture(false, true, [], script)
  const actor = 'local' as OfficeMemberId
  const before = scaffold.ctx.office.view(actor).items
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await input.waitFor()
  const settled = scaffold.whenTurnSettled().then(
    id => ({ ok: true as const, id }), (error: unknown) => ({ ok: false as const, error }),
  )
  await input.fill('/plan Review this short office automation plan with me.')
  await input.press('Enter')
  const card = page.locator('[data-plan-review-key]')
  const preview = page.locator('[data-plan-preview]')
  await card.waitFor()
  await preview.getByRole('heading', { name: 'Office automation plan', exact: true }).waitFor()
  expect(events.some(event => event.type === 'turn/end')).toBe(false)
  await nav.getByRole('button', { name: 'Work', exact: true }).click()
  await page.getByRole('heading', { name: 'Work', exact: true }).waitFor()
  expect(events.some(event => event.type === 'turn/end')).toBe(false)
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await card.waitFor()
  await card.getByRole('button', { name: decision === 'approve' ? 'Approve' : 'Request changes', exact: true }).click()
  const turn = await settled
  if (!turn.ok) throw turn.error
  const id = turn.id
  if (decision === 'revise') {
    expect(await page.getByText(answer, { exact: true }).count()).toBe(0)
    expect(events.filter(event => event.type === 'request/header')).toHaveLength(1)
    await input.waitFor()
    const revised = scaffold.whenTurnSettled()
    await input.fill('Revise this plan to include a rollback step before I approve it.')
    await input.press('Enter')
    expect(await revised).toBe(id)
  }
  await page.getByText(answer, { exact: true }).waitFor()
  expect(events.filter(event => event.type === 'plan/mode').at(-1)?.data.active).toBe(decision !== 'approve')
  expect(await page.getByRole('button', { name: 'Plan mode on, press to turn off', exact: true }).count()).toBe(decision === 'approve' ? 0 : 1)
  const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === 'office-native-plan-review')
  expect(JSON.stringify(result)).toContain(decision === 'approve' ? 'Plan approved' : 'dismissed the plan review')
  expect(scaffold.ctx.office.view(actor).items).toEqual(before)
  const artifact = page.locator('[data-plan-card]')
  await artifact.waitFor()
  await artifact.click()
  await preview.getByRole('heading', { name: 'Office automation plan', exact: true }).waitFor()
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await page.getByText(answer, { exact: true }).waitFor()
  expect((await readPersistedEvents(scaffold, id)).filter(event => event.type === 'tool/result')).toHaveLength(1)
  expect(await page.locator('[data-plan-card]').count()).toBe(1)
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('runs two native Goal rounds from the office composer and durably completes the actual goal', async () => {
  const script: ReplayOverrideDoc = [
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'NATIVE_GOAL_ROUND_ONE' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-goal-read'), name: 'get_goal', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-goal-complete'), name: 'update_goal',
        arguments: JSON.stringify({ goal_id: '{{fromRequest:goal-[0-9a-f-]+}}', revision: 1, action: 'complete' }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'NATIVE_GOAL_COMPLETE' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ]
  const { scaffold, page, nav, events, console } = await fixture(false, true, [], script)
  const actor = 'local' as OfficeMemberId
  const before = scaffold.ctx.office.view(actor).items
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await input.waitFor()
  const firstRound = scaffold.whenTurnSettled()
  await input.fill('/goal Complete two separate rounds and verify the native goal is complete.')
  await input.press('Enter')
  const id = await firstRound
  await page.getByText('NATIVE_GOAL_COMPLETE', { exact: true }).waitFor()
  await expect.poll(() => events.filter(event => event.type === 'turn/end').length).toBe(2)
  expect(events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'goal' ? [event.data.source.round] : [])).toEqual([1, 2])
  const agent = scaffold.ctx.agents.get(id)
  if (!agent) throw new Error('Goal Agent is missing')
  expect(scaffold.ctx.goals.get(agent)).toMatchObject({ phase: 'complete', roundsStarted: 2 })
  expect(events.filter(event => event.type === 'tool/result')).toHaveLength(2)
  await scaffold.ctx.sessions.flush(agent.session)
  expect((await readPersistedEvents(scaffold, id)).filter(event => event.type === 'turn/end')).toHaveLength(2)
  expect(scaffold.ctx.office.view(actor).items).toEqual(before)
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await page.getByText('NATIVE_GOAL_COMPLETE', { exact: true }).waitFor()
  expect((await readPersistedEvents(scaffold, id)).filter(event => event.type === 'turn/end')).toHaveLength(2)
  expect(scaffold.ctx.office.view(actor).items).toEqual(before)
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('executes native file write, read and edit tools and restores the actual workspace preview', async () => {
  const name = 'native-office-preview.md'
  const path = '{{fromRequest:OFFICE_FILE=(.+?) END_OFFICE_FILE}}'
  const original = '# Original title\n\nActual native file contents.\n'
  const edited = original.replace('Original title', 'Edited title')
  const script: ReplayOverrideDoc = [
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-file-write'), name: 'write', arguments: JSON.stringify({ file_path: path, content: original }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-file-read'), name: 'read', arguments: JSON.stringify({ file_path: path }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-file-edit'), name: 'edit', arguments: JSON.stringify({ file_path: path, old_string: 'Original title', new_string: 'Edited title' }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'NATIVE_FILE_EDIT_COMPLETE' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ]
  const { scaffold, page, nav, events, console } = await fixture(false, true, [], script)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const agent = scaffold.ctx.agents.list()[0]
  if (!agent) throw new Error('File-operation Agent is missing')
  scaffold.ctx.permissionPresets.set(agent.session, 'danger-full-access')
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  const settled = scaffold.whenTurnSettled()
  await input.fill(`Create, read and edit OFFICE_FILE=${join(scaffold.workspaceCwd, 'workspace', name).replaceAll('\\', '/')} END_OFFICE_FILE using native file tools.`)
  await input.press('Enter')
  const id = await settled
  await page.getByText('NATIVE_FILE_EDIT_COMPLETE', { exact: true }).waitFor()
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['write', 'read', 'edit'])
  expect(events.filter(event => event.type === 'tool/result')).toHaveLength(3)
  expect(await readFile(join(scaffold.workspaceCwd, 'workspace', name), 'utf8')).toBe(edited)
  await page.locator('[data-dockkit-add-tab]:visible').first().click()
  await page.locator('[data-sidebar-right-guide]:visible').getByRole('button', { name: /^Workspace files/u }).click()
  await page.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
  const preview = page.locator('[data-textpreview-url]')
  await preview.getByRole('heading', { name: 'Edited title', exact: true }).waitFor()
  await page.setViewportSize({ width: 760, height: 720 })
  await preview.getByRole('heading', { name: 'Edited title', exact: true }).waitFor()
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await preview.getByRole('heading', { name: 'Edited title', exact: true }).waitFor()
  expect((await readPersistedEvents(scaffold, id)).filter(event => event.type === 'tool/result')).toHaveLength(3)
  expect(await readFile(join(scaffold.workspaceCwd, 'workspace', name), 'utf8')).toBe(edited)
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('Drive cleanup UI retains its exact failed confirmation, recovers a pending receipt and preserves a real Native delivery', async () => {
  const name = 'Native cleanup report.md'
  const original = '# Retained Native delivery\n\n原生交付物保持完整。\n'
  const path = '{{fromRequest:CLEANUP_FILE=(.+?) END_CLEANUP_FILE}}'
  const script: ReplayOverrideDoc = [
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('cleanup-native-write'),
        name: 'write', arguments: JSON.stringify({ file_path: path, content: original }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('cleanup-native-present'),
        name: 'present', arguments: JSON.stringify({ files: [{ path, description: 'Retained after Drive cleanup' }] }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'NATIVE_CLEANUP_READY' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ]
  const { scaffold, page, nav, events, console } = await fixture(false, true,
    [join(REPO_ROOT, 'apps/web/tests/present.overlay.yml')], script, true)
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const agent = scaffold.ctx.agents.list()[0]
  if (!agent) throw new Error('Native cleanup delivery Agent is missing')
  scaffold.ctx.permissionPresets.set(agent.session, 'danger-full-access')
  const source = join(scaffold.workspaceCwd, 'workspace', name)
  const settled = scaffold.whenTurnSettled()
  const composer = page.locator('[data-composer-input][contenteditable="true"]')
  await composer.fill(`Write and present CLEANUP_FILE=${source.replaceAll('\\', '/')} END_CLEANUP_FILE using native tools.`)
  await composer.press('Enter')
  const sessionId = await settled
  await page.getByText('NATIVE_CLEANUP_READY', { exact: true }).waitFor()
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['write', 'present'])
  expect(events.filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
  const nativeEvents = await readPersistedEvents(scaffold, sessionId)
  const bytes = await readFile(source)
  expect(bytes.toString('utf8')).toBe(original)
  const actor = 'local' as OfficeMemberId
  const file = await scaffold.ctx.office.uploadDriveFile(actor, { name, space: 'private', folderId: null,
    requestId: randomUUID(), mediaType: 'text/markdown', byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const info = await scaffold.ctx.office.driveFileInfo(actor, file.id)
  await scaffold.ctx.office.changeDriveLifecycle(actor, { id: file.id, revision: file.revision, action: 'trash' })
  const metadata = join(scaffold.workspaceCwd, '.dsh-storages', 'enterprise_office_drive.json')
  const before = await readFile(metadata)
  await nav.getByRole('button', { name: 'Drive', exact: true }).click()
  const drive = page.getByRole('region', { name: 'Drive', exact: true })
  await drive.getByRole('button', { name: 'Recycle bin', exact: true }).click()
  const trash = page.getByRole('dialog', { name: 'Recycle bin', exact: true })
  const openReview = () => trash.getByRole('button', { name: `Permanently clear: ${name}`, exact: true }).click()
  const purge = page.getByRole('dialog', { name: 'Permanently clear', exact: true })
  const accept = () => purge.getByRole('checkbox')
  await openReview()
  await accept().waitFor()
  expect(await purge.getByRole('button', { name: 'Confirm permanent cleanup', exact: true }).isEnabled()).toBe(false)
  await purge.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await readFile(metadata)).toEqual(before)
  expect(await readFile(source)).toEqual(bytes)
  await openReview()
  await accept().check()
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-drive-lifecycle/purge.expected.md'),
    await purge.ariaSnapshot(), webSnapshotMode())
  await finishCleanupAndCheckDelivery()

  async function finishCleanupAndCheckDelivery() {
    // Exercise actual object unlink failure with an owned empty directory at the opaque object coordinate.
    const object = join(scaffold.workspaceCwd, '.dsh-home', 'office/drive/v1/objects', `${info.versionId}.bin`)
    const backup = `${object}.owned-test-backup`
    await rename(object, backup)
    await mkdir(object)
    vi.spyOn(scaffold.ctx.storageDomain.get('enterprise_office_drive')!.global, 'set')
      .mockRejectedValueOnce(new Error('Cleanup approval storage failed'))
    await purge.getByRole('button', { name: 'Confirm permanent cleanup', exact: true }).click()
    await purge.getByRole('alert').waitFor()
    expect(await readFile(metadata)).toEqual(before)
    await purge.getByRole('button', { name: 'Retry the same cleanup confirmation', exact: true }).click()
    await purge.getByText('Cleanup is approved and pending. It still consumes quota and cannot be restored.', { exact: true }).waitFor()
    expect(await drive.getByLabel('Personal quota', { exact: true }).textContent()).toContain(`Used: ${bytes.length} B`)
    expect(await readFile(source)).toEqual(bytes)
    expect(await trash.getByRole('button', { name: `Restore: ${name}`, exact: true }).isEnabled()).toBe(false)
    await purge.getByRole('button', { name: 'Close', exact: true }).last().click()
    await trash.getByRole('button', { name: `Check cleanup status: ${name}`, exact: true }).click()
    await purge.getByRole('button', { name: 'Continue approved cleanup', exact: true }).waitFor()
    expect(await purge.getByRole('checkbox').count()).toBe(0)
    await rmdir(object)
    await rename(backup, object)
    await purge.getByRole('button', { name: 'Continue approved cleanup', exact: true }).click()
    await purge.getByText('Permanent cleanup completed. The corresponding byte quota has been released.', { exact: true }).waitFor()
    await expect.poll(() => drive.getByLabel('Personal quota', { exact: true }).textContent()).toContain('Used: 0 B')
    expect(scaffold.ctx.office.drivePurgeStatus(actor, file.id)).toMatchObject({ status: 'completed' })
    await expect(readFile(object)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(source)).toEqual(bytes)
    expect(await readPersistedEvents(scaffold, sessionId)).toEqual(nativeEvents)
    await purge.getByRole('button', { name: 'Close', exact: true }).last().click()
    await trash.getByRole('button', { name: 'Close', exact: true }).click()
    await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
    const card = page.locator('[data-presented-file]').filter({ hasText: name })
    const downloading = page.waitForEvent('download')
    await card.getByRole('button', { name: `Download ${name}`, exact: true }).click()
    const download = await downloading
    const downloaded = await download.path()
    if (!downloaded) throw new Error('Retained Native delivery has no browser download')
    expect(await readFile(downloaded)).toEqual(bytes)
    expect(await readPersistedEvents(scaffold, sessionId)).toEqual(nativeEvents)
    acknowledgeReloadConnectionLoss(console, warningStart)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  }
})

it('presents actual files, opens and downloads current sources and restores delivery history with retryable missing files', async () => {
  const name = "交付 (v1)'报告.md"
  const original = '# Delivered report\n\n原生工具生成的交付内容。\n'
  const changed = original.replace('Delivered report', 'Updated report')
  const path = '{{fromRequest:DELIVERY_FILE=(.+?) END_DELIVERY_FILE}}'
  const script: ReplayOverrideDoc = [
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-delivery-write'), name: 'write', arguments: JSON.stringify({ file_path: path, content: original }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('office-present'), name: 'present', arguments: JSON.stringify({ files: [{ path, description: 'Office delivery acceptance' }] }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'NATIVE_DELIVERY_COMPLETE' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ]
  const { scaffold, page, nav, events, console } = await fixture(false, true, [join(REPO_ROOT, 'apps/web/tests/present.overlay.yml')], script, true)
  const openLog = join(scaffold.workspaceCwd, 'delivery-application.jsonl')
  const application = join(scaffold.workspaceCwd, 'delivery-application.cjs')
  await writeFile(openLog, '')
  await writeFile(application, `const fs = require('node:fs');
const [action, target] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(openLog)}, JSON.stringify({action, path: fs.realpathSync(target), bytes: action === 'open' ? fs.readFileSync(target).toString('base64') : null}) + '\\n');
`)
  // Replace the desktop application with an owned real process; retain native route and path verification.
  const handoff = (path: string, action: 'open' | 'reveal', signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [application, action, path], { signal, windowsHide: true }, (error) => {
      if (error) reject(new Error('Owned delivery application failed', { cause: error }))
      else resolve()
    })
  })
  const controller = scaffold.ctx.sessionController
  const originals = new Map(['fileApplications', 'openPath', 'openFileApplication', 'revealPath'].map(key => [key, Reflect.get(controller, key)]))
  Reflect.set(controller, 'fileApplications', async () => [{ id: 'office-editor', name: 'Test Editor', default: true, icon: null }])
  Reflect.set(controller, 'openPath', (path: string, signal: AbortSignal) => handoff(path, 'open', signal))
  Reflect.set(controller, 'openFileApplication', (path: string, app: string, signal: AbortSignal) => {
    expect(app).toBe('office-editor')
    return handoff(path, 'open', signal)
  })
  Reflect.set(controller, 'revealPath', (path: string, signal: AbortSignal) => handoff(path, 'reveal', signal))
  scaffold.ctx.effect(() => () => { for (const [key, value] of originals) Reflect.set(controller, key, value) })
  const opened = async () => (await readFile(openLog, 'utf8')).split('\n').filter(Boolean).map(line =>
    JSON.parse(line) as { action: 'open' | 'reveal'; path: string; bytes: string | null })
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const agent = scaffold.ctx.agents.list()[0]
  if (!agent) throw new Error('Delivery Agent is missing')
  scaffold.ctx.permissionPresets.set(agent.session, 'danger-full-access')
  const source = join(scaffold.workspaceCwd, 'workspace', name)
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  const settled = scaffold.whenTurnSettled()
  await input.fill(`Write and present DELIVERY_FILE=${source.replaceAll('\\', '/')} END_DELIVERY_FILE using native tools.`)
  await input.press('Enter')
  const id = await settled
  await page.getByText('NATIVE_DELIVERY_COMPLETE', { exact: true }).waitFor()
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['write', 'present'])
  expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
  expect(events.filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
  const delivery = events.find(event => event.type === 'deliverables/presented')
  if (!delivery) throw new Error('Durable delivery event is missing')
  const anonymous = await fetch(new URL(`api/present.download?sessionId=${id}&seq=${delivery.seq}&index=0`, scaffold.authenticatedUrl))
  expect(anonymous.status).toBe(401)
  const card = page.locator('[data-presented-file]').filter({ hasText: name })
  await card.waitFor()
  await card.getByRole('button', { name: 'Open in Test Editor', exact: true }).click()
  await expect.poll(async () => (await opened()).length).toBe(1)
  expect((await opened())[0]).toEqual({ action: 'open', path: source, bytes: Buffer.from(original).toString('base64') })
  const downloadSource = async (contents: string) => {
    const downloading = page.waitForEvent('download')
    await card.getByRole('button', { name: `Download ${name}`, exact: true }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe(name)
    const downloaded = await download.path()
    if (!downloaded) throw new Error('Browser download has no stored bytes')
    expect(await readFile(downloaded, 'utf8')).toBe(contents)
    expect(await readFile(source, 'utf8')).toBe(contents)
  }
  await downloadSource(original)
  await card.getByRole('button', { name: /^Preview .+ in sidebar$/u }).click()
  const preview = page.locator('[data-textpreview-url]')
  await preview.getByRole('heading', { name: 'Delivered report', exact: true }).waitFor()
  await writeFile(source, changed)
  await downloadSource(changed)
  await card.getByRole('button', { name: 'Open in Test Editor', exact: true }).click()
  await expect.poll(async () => (await opened()).length).toBe(2)
  expect((await opened())[1]?.bytes).toBe(Buffer.from(changed).toString('base64'))
  await card.getByRole('button', { name: 'More ways to open', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Show file location', exact: true }).click()
  await expect.poll(async () => (await opened()).length).toBe(3)
  expect((await opened())[2]).toEqual({ action: 'reveal', path: source, bytes: null })
  const warningStart = console.warnings.length
  await nav.getByRole('button', { name: 'Workbench', exact: true }).click()
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await card.waitFor()
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'AI chat', exact: true }).click()
  await preview.getByRole('heading', { name: 'Updated report', exact: true }).waitFor()
  await downloadSource(changed)
  await card.getByRole('button', { name: 'Open in Test Editor', exact: true }).click()
  await expect.poll(async () => (await opened()).length).toBe(4)
  expect((await opened())[3]?.bytes).toBe(Buffer.from(changed).toString('base64'))
  await rm(source)
  await card.getByRole('button', { name: `Download ${name}`, exact: true }).click()
  await card.getByText('Download failed. The source may have been removed. Try again.', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'Open in Test Editor', exact: true }).click()
  await card.getByText('Could not open. Click to retry.', { exact: true }).waitFor()
  expect(await opened()).toHaveLength(4)
  await writeFile(source, changed)
  await downloadSource(changed)
  await page.setViewportSize({ width: 760, height: 720 })
  await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
  await card.getByRole('button', { name: `Download ${name}`, exact: true }).waitFor()
  await expect.poll(() => card.locator('[data-presented-description][role="status"]').count(), { timeout: 10_000 }).toBe(0)
  await page.mouse.move(500, 55)
  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'delivery-small.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 1680, height: 900 })
  await page.screenshot({ path: join(shots, 'delivery-light.png'), animations: 'disabled' })
  await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
  await page.screenshot({ path: join(shots, 'delivery-dark.png'), animations: 'disabled' })
  expect((await readPersistedEvents(scaffold, id)).filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('returns from calendar assistance to the original date and keeps context unsent', async () => {
  const { scaffold, page, events, console } = await fixture(false, false)
  const actor = 'local' as OfficeMemberId
  const date = '2026-10-23'
  const meeting = await scaffold.ctx.office.createSchedule(actor, {
    title: 'Calendar assistance return', description: 'Review the actual meeting context', date,
    startTime: '09:00', endTime: '10:00', inviteeIds: [],
  })
  await page.getByRole('button', { name: 'Calendar', exact: true }).click()
  const dateInput = page.getByRole('main').getByLabel('Date', { exact: true })
  await dateInput.fill(date)
  await page.locator(`[data-office-item="${meeting.id}"]`).click()
  const details = page.getByRole('dialog', { name: 'Work details', exact: true })
  await details.getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  const card = page.getByRole('complementary', { name: 'Item context', exact: true })
  await card.getByText(meeting.title, { exact: true }).waitFor()
  const input = page.locator('[data-composer-input][contenteditable="true"]')
  await expect.poll(() => input.textContent()).toContain('2026-10-23')
  expect(userMessages(events)).toEqual([])
  await card.getByRole('button', { name: 'Back to item', exact: true }).click()
  await details.waitFor()
  expect(await dateInput.inputValue()).toBe(date)
  expect(await details.getByRole('heading', { name: meeting.title, exact: true }).count()).toBe(1)
  await details.getByRole('button', { name: 'Close', exact: true }).click()
  expect(await dateInput.inputValue()).toBe(date)
  expect(userMessages(events)).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('creates, searches and switches real conversations while keeping profile, files and browser tabs available', async () => {
  const { scaffold, page, events, console } = await fixture(false, true, [join(REPO_ROOT, 'apps/web/tests/sidebar-browser.overlay.yml')])
  await writeFile(join(scaffold.workspaceCwd, 'workspace', 'sidebar-preservation.txt'), 'ORIGINAL_FILE_VIEWER_BYTES')
  const home = page.getByRole('textbox', { name: 'Tell the Agent what you want to get done', exact: true })
  await home.fill('Read this file in the first durable conversation.')
  await page.getByLabel('Choose conversation attachments', { exact: true }).setInputFiles({
    name: 'office-home.txt', mimeType: 'text/plain', buffer: Buffer.from(content),
  })
  const settled = scaffold.whenTurnSettled()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const firstId = await settled
  await page.getByText(reply, { exact: true }).waitFor({ timeout: 20_000 })
  const history = page.getByRole('region', { name: 'Conversations', exact: true })
  await history.waitFor()
  await history.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect.poll(async () => page.evaluate(() =>
    (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)).not.toBe(firstId)
  await history.getByRole('textbox', { name: 'Search conversations or workspaces', exact: true }).fill('no possible matching conversation')
  await history.getByText('No matching conversations', { exact: true }).waitFor()
  await history.getByRole('button', { name: 'Clear search', exact: true }).click()
  await history.locator(`[data-office-session="${firstId}"]`).click()
  await page.getByText(reply, { exact: true }).waitFor()
  expect(userMessages(events)).toHaveLength(1)
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  const profile = page.getByRole('dialog', { name: 'Profile', exact: true })
  await profile.getByLabel('Name', { exact: true }).fill('Conversation employee')
  await profile.getByLabel('Job title', { exact: true }).fill('Office operator')
  await profile.getByRole('button', { name: 'Save', exact: true }).click()
  await profile.waitFor({ state: 'hidden' })
  await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Office operator')
  expect(scaffold.ctx.office.view('local' as OfficeMemberId).me.role).toBe('employee')
  await page.locator('[data-dockkit-add-tab]').click()
  const guide = page.locator('[data-sidebar-right-guide]:visible')
  await guide.getByRole('button', { name: /^Workspace files/u }).click()
  await page.getByText('sidebar-preservation.txt', { exact: true }).waitFor()
  await page.locator('[data-dockkit-add-tab]').click()
  expect(await guide.getByRole('button', { name: /^New terminal/u }).isVisible()).toBe(true)
  await guide.getByRole('button', { name: /^Browser/u }).click()
  await page.getByRole('textbox', { name: 'Enter an HTTP(S) address', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Conversations', exact: true }).first().click()
  await history.waitFor()
  expect(await history.locator(`[data-office-session="${firstId}"]`).getAttribute('aria-current')).toBe('page')
  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'conversations-light.png'), fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
  await page.screenshot({ path: join(shots, 'conversations-dark.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 1040, height: 700 })
  await page.screenshot({ path: join(shots, 'conversations-small.png'), fullPage: true, animations: 'disabled' })
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
