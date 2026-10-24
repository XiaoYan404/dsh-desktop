/** Two employee Hosts complete real central work review using Native files and persisted Office records. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import OfficeGateway from '@deepseek-ai/dsh-enterprise-office-gateway'
import type { OfficeItem, OfficeItemId, OfficeLoginResult, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const administrator = 'collaboration-admin' as OfficeMemberId
const creator = 'collaboration-lin' as OfficeMemberId
const assignee = 'collaboration-chen' as OfficeMemberId
const date = '2026-10-15'
const title = 'Two employee delivery and rework acceptance'
const firstReport = '# Operations report\n\nCompleted items: 3\nMissing: total amount\n'
const correctedReport = '# Operations report\n\nCompleted items: 3\nTotal amount: CNY 1200\n'
const firstReason = 'First report is attached for review'
const returnReason = 'Add the missing total amount and resubmit the corrected report'
const finalReason = 'Total amount and corrected attachment have been checked'
const acceptedReason = 'Reviewed the corrected amount and accepted the delivery'
const artifacts = join(REPO_ROOT, '.artifacts/enterprise-office/collaboration')

interface HttpReceipt {
  readonly actor: string
  readonly method: string
  readonly status: number
  readonly ok: boolean
}

type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string }
type OfficeMethod = Extract<keyof OfficeService, string>
type RpcValue<M extends OfficeMethod> = OfficeService[M] extends (...args: never[]) => infer R ? Awaited<R> : never

async function evidence(name: string, value: unknown) {
  await writeFile(join(artifacts, name), JSON.stringify(value, null, 2) + '\n')
}

async function central(root: string, password: string, port = 0) {
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'data') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-enterprise-office', config: {
      companyName: 'Collaboration acceptance company', timeZone: 'Asia/Shanghai', dshHome: root,
      members: [
        { id: administrator, name: 'Collaboration administrator', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
        { id: creator, name: 'Lin', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
        { id: assignee, name: 'Chen', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
      ],
    } },
  ]))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-enterprise-office', OfficeService],
    ['@deepseek-ai/dsh-enterprise-office-gateway', OfficeGateway],
  ])
  const internal = ctx.loader.internal
  if (!internal) throw new Error('Collaboration acceptance requires the Node Loader')
  ctx.loader.internal = new Proxy(internal, { get(target, key) {
    if (key === 'import') return async (name: string) => {
      if (!modules.has(name)) throw new Error('Unexpected collaboration fixture module')
      return modules.get(name)
    }
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
  } })
  try {
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    if (!ctx.get('office')) throw new Error('Central Office did not activate')
    await ctx.office.initializeIdentity(administrator, password)
    await ctx.loader.create({ name: '@deepseek-ai/dsh-enterprise-office-gateway', config: {
      host: '127.0.0.1', port, administratorId: administrator, loginRequestsPerMinute: 100,
    } })
    await ctx.loader.await()
    if (!ctx.get('officeGateway')) throw new Error('Central Office Gateway did not activate')
    return { ctx, address: ctx.officeGateway.address }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function login(address: string, memberId: OfficeMemberId, password: string, receipts: HttpReceipt[]) {
  const response = await fetch(new URL('/v1/login', address), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId, password }),
  })
  const body = await response.json() as Reply<OfficeLoginResult>
  receipts.push({ actor: memberId, method: 'login', status: response.status, ok: body.ok })
  if (response.status !== 200 || !body.ok) throw new Error('Collaboration HTTP sign-in failed')
  return body.value.token
}

async function rpc<M extends OfficeMethod>(address: string, token: string, actor: OfficeMemberId,
  method: M, args: readonly unknown[], receipts: HttpReceipt[]): Promise<RpcValue<M>> {
  const response = await fetch(new URL('/v1/rpc', address), { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, args }),
  })
  const body = await response.json() as Reply<RpcValue<M>>
  receipts.push({ actor, method, status: response.status, ok: body.ok })
  if (response.status !== 200 || !body.ok)
    throw new Error(`Collaboration HTTP ${method} failed with status ${response.status}`)
  return body.value
}

async function signIn(page: Page, memberId: OfficeMemberId, password: string) {
  const form = page.getByRole('region', { name: 'Sign in to your company', exact: true })
  await form.waitFor({ timeout: 30_000 })
  await form.getByLabel('Employee ID', { exact: true }).fill(memberId)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Profile', exact: true }).waitFor()
}

async function selectedSessionId(page: Page): Promise<SessionId> {
  const value = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
  if (!value) throw new Error('The employee browser has no selected Native Session')
  return value as SessionId
}

async function openTask(page: Page, id: OfficeItemId) {
  const detail = page.getByRole('dialog', { name: 'Work details', exact: true })
  if (await detail.isVisible()) {
    await detail.getByRole('heading', { name: title, exact: true }).waitFor()
    return detail
  }
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Workbench', exact: true }).click()
  if (await detail.isVisible()) {
    await detail.getByRole('heading', { name: title, exact: true }).waitFor()
    return detail
  }
  await page.getByRole('button', { name: 'Calendar', exact: true }).click()
  await page.getByLabel('Date', { exact: true }).fill(date)
  if (!await detail.isVisible()) await page.locator(`[data-office-item="${id}"]`).click()
  await detail.getByRole('heading', { name: title, exact: true }).waitFor()
  return detail
}

async function review(detail: Locator, action: 'Submit delivery' | 'Return delivery' | 'Confirm delivery', reason: string) {
  const region = detail.getByRole('region', { name: 'Delivery and review', exact: true })
  await region.getByRole('button', { name: action, exact: true }).click()
  const form = region.getByRole('form', { name: action, exact: true })
  await form.getByLabel('Explanation or reason', { exact: true }).fill(reason)
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  await region.getByText(reason, { exact: true }).waitFor()
}

function modelScript(): ReplayOverrideDoc {
  const path = '{{fromRequest:COLLABORATION_FILE=(.+?) END_COLLABORATION_FILE}}'
  return [firstReport, correctedReport].flatMap((content, round): ReplayEntry[] => [
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`collaboration-write-${round}`),
        name: 'write', arguments: JSON.stringify({ file_path: path, content }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`collaboration-present-${round}`),
        name: 'present', arguments: JSON.stringify({ files: [{ path, description: `Task delivery revision ${round + 1}` }] }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] },
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: `COLLABORATION_NATIVE_DELIVERY_${round + 1}` },
      { type: 'block-end', index: 0, block: { type: 'text', text: `COLLABORATION_NATIVE_DELIVERY_${round + 1}` } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ])
}

it('completes two authenticated employee Hosts from assignment through Native assistance, returned delivery and durable acceptance', async () => {
  await mkdir(artifacts, { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-collaboration-'))
  onTestFinished(async () => {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-collaboration-'))
      throw new Error('Unexpected collaboration temporary directory')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const password = `Collaboration-${randomUUID()}!`
  let server = await central(root, password)
  onTestFinished(() => server.ctx.fiber.dispose())
  const receipts: HttpReceipt[] = []
  onTestFinished(() => evidence('http-operations.json', receipts))
  const adminToken = await login(server.address, administrator, password, receipts)
  for (const memberId of [creator, assignee])
    await rpc(server.address, adminToken, administrator, 'setIdentityPassword', [memberId, password], receipts)
  const creatorToken = await login(server.address, creator, password, receipts)
  const assigneeToken = await login(server.address, assignee, password, receipts)
  const read = (actor: OfficeMemberId) => rpc(server.address, actor === creator ? creatorToken : assigneeToken,
    actor, 'view', [date], receipts)
  const folder = await rpc(server.address, adminToken, administrator, 'createDriveFolder',
    [{ space: 'shared', folderId: null, name: 'Collaboration deliverables' }], receipts)
  await rpc(server.address, adminToken, administrator, 'saveDrivePermissions', [{ id: folder.id, revision: folder.revision,
    defaultAccess: 'view', grants: [{ memberId: assignee, access: 'edit' }] }], receipts)
  const overlay = join(root, 'employee.patch.json')
  const override = join(root, 'model-override.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'enterprise-office', disabled: true },
    { id: 'ui-office', disabled: false, config: { principalId: '', gatewayUrl: server.address } },
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
  ]))
  await writeFile(override, JSON.stringify(modelScript()))
  const creatorHost = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => creatorHost.close())
  const assigneeHost = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay,
    replayFixture: join(root, 'override-only.jsonl'), replayOverride: override })
  onTestFinished(() => assigneeHost.close())
  const workspace = join(assigneeHost.workspaceCwd, 'workspace')
  await mkdir(workspace, { recursive: true })
  await assigneeHost.ctx.workspaceController.create({ path: workspace })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const creatorPage = await newEnglishPage(browser, 900)
  const assigneePage = await newEnglishPage(browser, 900)
  const creatorConsole = watchConsole(creatorPage)
  const assigneeConsole = watchConsole(assigneePage)
  let scenarioCompleted = false
  onTestFinished(async () => {
    if (scenarioCompleted) return
    await Promise.allSettled([
      creatorPage.screenshot({ path: join(artifacts, 'failure-creator.png'), fullPage: true }),
      assigneePage.screenshot({ path: join(artifacts, 'failure-assignee.png'), fullPage: true }),
    ])
  })
  await creatorPage.goto(creatorHost.authenticatedUrl, { waitUntil: 'load' })
  await assigneePage.goto(assigneeHost.authenticatedUrl, { waitUntil: 'load' })
  await signIn(creatorPage, creator, password)
  await signIn(assigneePage, assignee, password)
  expect(await creatorPage.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Lin')
  expect(await assigneePage.getByRole('button', { name: 'Profile', exact: true }).textContent()).toContain('Chen')
  expect(creatorHost.ctx.get('office')).toBeUndefined()
  expect(assigneeHost.ctx.get('office')).toBeUndefined()

  await creatorPage.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Contacts', exact: true }).click()
  await creatorPage.locator(`[data-office-member="${assignee}"]`).getByRole('button', { name: 'Assign task', exact: true }).click()
  const assignment = creatorPage.getByRole('dialog', { name: 'Assign task', exact: true })
  expect(await assignment.getByLabel('Assignee', { exact: true }).inputValue()).toBe(assignee)
  await assignment.getByLabel('Title', { exact: true }).fill(title)
  await assignment.getByLabel('Date', { exact: true }).fill(date)
  await assignment.getByRole('button', { name: 'Save', exact: true }).click()
  await assignment.waitFor({ state: 'hidden' })
  const created = (await read(creator)).items.find(item => item.title === title)
  if (!created) throw new Error('Assignment did not persist the task')
  expect(created).toMatchObject({ creatorId: creator, ownerId: assignee, status: 'pending' })
  const received = await read(assignee)
  expect(received.items).toContainEqual(created)
  expect(received.notifications.some(entry => entry.itemId === created.id && entry.kind === 'assigned')).toBe(true)
  await evidence('01-assigned.json', { item: created, recipientNotifications: received.notifications })

  let detail = await openTask(assigneePage, created.id)
  await detail.getByRole('button', { name: 'Accept task', exact: true }).click()
  await expect.poll(async () => (await read(assignee)).items.find(item => item.id === created.id)?.status).toBe('in_progress')
  await detail.getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  const context = assigneePage.getByRole('complementary', { name: 'Item context', exact: true })
  await context.getByText(title, { exact: true }).waitFor()
  const input = assigneePage.locator('[data-composer-input][contenteditable="true"]')
  await expect.poll(() => input.textContent()).toContain(created.id)
  const sessionId = await selectedSessionId(assigneePage)
  const agent = assigneeHost.ctx.agents.list().find(entry => entry.session.id === sessionId)
  if (!agent) throw new Error('Native item assistance did not create an Agent')
  const unsent = await readPersistedEvents(assigneeHost, sessionId)
  expect(unsent.filter(event => event.type === 'user/message')).toHaveLength(0)
  await evidence('native-assistance-opened.json', { sessionId,
    loadedSessionIds: assigneeHost.ctx.agents.list().map(entry => entry.session.id), unsentUserMessages: 0 })
  assigneeHost.ctx.permissionPresets.set(agent.session, 'danger-full-access')
  const source = join(workspace, 'operations-report.md')
  const sourcePrompt = `COLLABORATION_FILE=${source.replaceAll('\\', '/')} END_COLLABORATION_FILE`
  const draft = await input.textContent()
  const firstSettled = assigneeHost.whenTurnSettled()
  await input.fill(`${draft}\n\nCreate and present the report for this task. ${sourcePrompt}`)
  await input.press('Enter')
  expect(await firstSettled).toBe(sessionId)
  await assigneePage.getByText('COLLABORATION_NATIVE_DELIVERY_1', { exact: true }).waitFor()
  const firstBytes = await readFile(source)
  expect(firstBytes.toString('utf8')).toBe(firstReport)
  await writeFile(join(artifacts, 'native-report-v1.md'), firstBytes)

  const uploadAndLink = async (bytes: Buffer, name: string) => {
    const entry = await rpc(server.address, assigneeToken, assignee, 'uploadDriveFile', [{
      space: 'shared', folderId: folder.id, name, requestId: randomUUID(), mediaType: 'text/markdown',
      byteLength: bytes.length, dataBase64: bytes.toString('base64'),
    }], receipts)
    const info = await rpc(server.address, assigneeToken, assignee, 'driveFileInfo', [entry.id], receipts)
    expect(info.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const current = await openTask(assigneePage, created.id)
    await current.getByRole('button', { name: 'Manage work attachments', exact: true }).click()
    const form = assigneePage.getByRole('dialog', { name: 'Manage work attachments', exact: true })
    const remove = form.getByRole('button', { name: 'Remove reference 1', exact: true })
    if (await remove.count()) await remove.click()
    await form.getByRole('button', { name: 'Shared drive', exact: true }).click()
    await form.getByRole('button', { name: folder.name, exact: true }).click()
    await form.getByRole('button', { name: `Choose file ${name}`, exact: true }).click()
    await form.getByRole('group', { name: 'Linked materials · 1/20', exact: true }).waitFor()
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await form.waitFor({ state: 'hidden' })
    const saved = (await read(assignee)).items.find(item => item.id === created.id)
    expect(saved?.attachments).toEqual([{ id: info.id, versionId: info.versionId }])
    return info
  }
  const firstFile = await uploadAndLink(firstBytes, 'operations-report-v1.md')
  detail = await openTask(assigneePage, created.id)
  await review(detail, 'Submit delivery', firstReason)
  const firstSubmitted = (await read(creator)).items.find(item => item.id === created.id)
  expect(firstSubmitted?.deliveries?.map(entry => entry.kind)).toEqual(['submit'])
  expect(firstSubmitted?.status).toBe('in_progress')
  await evidence('02-first-submission.json', { item: firstSubmitted, file: firstFile, sessionId, helpOpenedWithoutSending: true })

  detail = await openTask(creatorPage, created.id)
  const firstDownload = creatorPage.waitForEvent('download')
  await detail.getByRole('region', { name: 'Linked materials', exact: true }).getByRole('button', { name: 'Download file', exact: true }).click()
  const firstSaved = await firstDownload
  const firstPath = await firstSaved.path()
  if (!firstPath) throw new Error('First reviewer download has no bytes')
  expect(await readFile(firstPath)).toEqual(firstBytes)
  await review(detail, 'Return delivery', returnReason)
  await creatorPage.screenshot({ path: join(artifacts, 'returned-delivery.png'), fullPage: true })
  const returned = (await read(assignee)).items.find(item => item.id === created.id)
  expect(returned?.status).toBe('in_progress')
  expect(returned?.deliveries?.map(entry => entry.kind)).toEqual(['submit', 'return'])
  await evidence('03-returned.json', { item: returned })

  detail = await openTask(assigneePage, created.id)
  await detail.getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
  await context.waitFor()
  expect(await selectedSessionId(assigneePage)).toBe(sessionId)
  expect(assigneeHost.ctx.agents.list().filter(entry => entry.session.id === sessionId)).toHaveLength(1)
  const secondSettled = assigneeHost.whenTurnSettled()
  await input.fill(`Revise the same task ${created.id}. Reviewer feedback: ${returnReason}. ${sourcePrompt}`)
  await input.press('Enter')
  expect(await secondSettled).toBe(sessionId)
  await assigneePage.getByText('COLLABORATION_NATIVE_DELIVERY_2', { exact: true }).waitFor()
  const correctedBytes = await readFile(source)
  expect(correctedBytes.toString('utf8')).toBe(correctedReport)
  await writeFile(join(artifacts, 'native-report-v2.md'), correctedBytes)
  const correctedFile = await uploadAndLink(correctedBytes, 'operations-report-v2.md')
  detail = await openTask(assigneePage, created.id)
  await review(detail, 'Submit delivery', finalReason)
  const correctedSubmitted = (await read(creator)).items.find(item => item.id === created.id)
  expect(correctedSubmitted?.deliveries?.map(entry => entry.kind)).toEqual(['submit', 'return', 'submit'])
  await evidence('04-resubmitted.json', { item: correctedSubmitted, file: correctedFile, sessionId })

  const message = await rpc(server.address, assigneeToken, assignee, 'sendMessageFiles', [{
    id: randomUUID(), recipientId: creator, text: `Corrected task ${created.id}: ${finalReason}`,
    files: [{ name: 'operations-report-v2.md', mediaType: 'text/markdown', byteLength: correctedBytes.length,
      dataBase64: correctedBytes.toString('base64') }],
  }], receipts)
  const attachment = message.attachments?.[0]
  if (!attachment) throw new Error('Corrected-report chat message did not retain its file')
  const chatFile = await rpc(server.address, creatorToken, creator, 'downloadChatFile', [{
    messageId: message.id, attachmentId: attachment.id,
  }], receipts)
  expect(Buffer.from(chatFile.dataBase64, 'base64')).toEqual(correctedBytes)
  detail = await openTask(creatorPage, created.id)
  const downloading = creatorPage.waitForEvent('download')
  await detail.getByRole('region', { name: 'Linked materials', exact: true }).getByRole('button', { name: 'Download file', exact: true }).click()
  const saved = await downloading
  expect(saved.suggestedFilename()).toBe('operations-report-v2.md')
  const downloadPath = await saved.path()
  if (!downloadPath) throw new Error('Corrected reviewer download has no bytes')
  expect(await readFile(downloadPath)).toEqual(correctedBytes)
  await review(detail, 'Confirm delivery', acceptedReason)
  const final = (await read(creator)).items.find(item => item.id === created.id)
  if (!final) throw new Error('Completed task is missing')
  expect(final.status).toBe('completed')
  expect(final.deliveries?.map(entry => ({ kind: entry.kind, actorId: entry.actorId, reason: entry.reason }))).toEqual([
    { kind: 'submit', actorId: assignee, reason: firstReason },
    { kind: 'return', actorId: creator, reason: returnReason },
    { kind: 'submit', actorId: assignee, reason: finalReason },
    { kind: 'accept', actorId: creator, reason: acceptedReason },
  ])
  await creatorPage.screenshot({ path: join(artifacts, 'accepted-delivery.png'), fullPage: true })

  const nativeEvents = await readPersistedEvents(assigneeHost, sessionId)
  const userMessages = nativeEvents.filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => event.type === 'user/message')
  expect(userMessages).toHaveLength(2)
  expect(JSON.stringify(userMessages[0])).toContain(created.id)
  expect(JSON.stringify(userMessages[0])).toContain(title)
  expect(JSON.stringify(userMessages[1])).toContain(returnReason)
  expect(nativeEvents.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['write', 'present', 'write', 'present'])
  expect(nativeEvents.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
  expect(nativeEvents.filter(event => event.type === 'deliverables/presented')).toHaveLength(2)
  await evidence('native-events.json', nativeEvents.filter(event => ['user/message', 'tool/call', 'tool/result', 'deliverables/presented', 'turn/start', 'turn/end'].includes(event.type)))
  const persistedOffice = await readFile(join(root, 'data/enterprise_office.json'), 'utf8')
  expect(persistedOffice).toContain(acceptedReason)
  expect(persistedOffice).toContain(correctedFile.versionId)
  const beforeRestart = await read(assignee)
  const ownNotices = beforeRestart.notifications.filter(entry => entry.itemId === created.id)
  expect(ownNotices.map(entry => entry.kind)).toEqual(expect.arrayContaining(['assigned', 'delivery_returned', 'delivery_accepted']))
  await evidence('05-accepted.json', { item: final, assigneeNotifications: ownNotices,
    chatMessage: message, file: correctedFile, nativeSessionId: sessionId })

  const port = Number(new URL(server.address).port)
  await server.ctx.fiber.dispose()
  server = await central(root, password, port)
  const creatorRestored = await read(creator)
  const assigneeRestored = await read(assignee)
  expect(creatorRestored.items.find(item => item.id === final.id)).toEqual(final)
  expect(assigneeRestored.items.find(item => item.id === final.id)).toEqual(final)
  expect(assigneeRestored.notifications.filter(entry => entry.itemId === final.id)).toEqual(ownNotices)
  const restoredChat = await rpc(server.address, creatorToken, creator, 'chat', [assignee, null], receipts)
  expect(restoredChat.messages).toContainEqual(message)
  const restoredFile = await rpc(server.address, creatorToken, creator, 'downloadDriveRange', [{
    id: correctedFile.id, versionId: correctedFile.versionId, offset: 0, byteLength: correctedFile.byteLength,
  }], receipts)
  expect(Buffer.from(restoredFile.dataBase64, 'base64')).toEqual(correctedBytes)
  const restoredChatFile = await rpc(server.address, creatorToken, creator, 'downloadChatFile', [{
    messageId: message.id, attachmentId: attachment.id,
  }], receipts)
  expect(Buffer.from(restoredChatFile.dataBase64, 'base64')).toEqual(correctedBytes)
  await reloadAndCheck(creatorPage, creatorConsole, final, sessionId, false)
  await reloadAndCheck(assigneePage, assigneeConsole, final, sessionId, true)
  expect(await readPersistedEvents(assigneeHost, sessionId)).toEqual(nativeEvents)
  expect(creatorConsole.pageErrors).toEqual([])
  expect(creatorConsole.warnings).toEqual([])
  expect(assigneeConsole.pageErrors).toEqual([])
  expect(assigneeConsole.warnings).toEqual([])
  await evidence('06-restarted.json', { item: creatorRestored.items.find(item => item.id === final.id),
    assigneeItem: assigneeRestored.items.find(item => item.id === final.id), notifications: ownNotices,
    chatMessageId: message.id, driveSha256: correctedFile.sha256, chatSha256: restoredChatFile.sha256,
    nativeSessionId: sessionId, nativeEventsUnchanged: true })
  await evidence('result.json', {
    passed: true,
    scenario: 'assignment -> accept -> Native assistance -> real file -> submit -> return -> same-session correction -> resubmit -> accept -> restart',
    employees: [creator, assignee], finalTask: final.id, finalStatus: final.status,
    deliveryKinds: final.deliveries?.map(entry => entry.kind),
    controlled: ['model inference only; two fixed report contents'],
    real: ['Chromium and two independent employee Hosts', 'central HTTP sign-in and Office RPC', 'Native write/present tools and Session persistence',
      'Drive file bytes and reviewed versions', 'review decisions, notices and chat attachment bytes', 'storage-json commits and central service restart'],
    limitations: ['Native-to-Drive transfer is a separate user upload',
      'Office delivery records retain Drive references and explanations; they do not store a Native deliverables event foreign key',
      'External model inference, schedule invitations and customer integration writeback are outside this scenario'],
  })
  scenarioCompleted = true
})

async function reloadAndCheck(page: Page, observed: ReturnType<typeof watchConsole>, final: OfficeItem,
  sessionId: SessionId, reopenAssistance: boolean) {
  const warningStart = observed.warnings.length
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: 'Profile', exact: true }).waitFor()
  const detail = await openTask(page, final.id)
  expect(await detail.getByLabel('Status', { exact: true }).inputValue()).toBe('completed')
  await detail.getByText(acceptedReason, { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, reopenAssistance ? 'restarted-assignee.png' : 'restarted-creator.png'), fullPage: true })
  if (reopenAssistance) {
    await detail.getByRole('button', { name: 'Ask Agent for help', exact: true }).click()
    await page.getByRole('complementary', { name: 'Item context', exact: true }).waitFor()
    expect(await selectedSessionId(page)).toBe(sessionId)
    await page.getByText('COLLABORATION_NATIVE_DELIVERY_2', { exact: true }).waitFor()
  }
  acknowledgeReloadConnectionLoss(observed, warningStart)
}
