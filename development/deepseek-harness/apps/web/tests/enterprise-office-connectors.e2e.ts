/** Company connection forms through built clients, real office storage and actual HTTP probes. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { z } from 'zod'
import { expect, it, onTestFinished, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { OfficeConnectorInput, OfficeDingTalkConfig, OfficeMemberId, OfficeWeComConfig } from '@deepseek-ai/dsh-enterprise-office/types'
import { acknowledgeReloadConnectionLoss, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const owner = 'owner' as OfficeMemberId

async function fixture(dingtalk?: OfficeDingTalkConfig, wecom?: OfficeWeComConfig) {
  const scaffold = await launchWebScaffold({ extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const origin = new URL(scaffold.baseUrl).origin
  const serviceEntry = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-enterprise-office')!
  const controller = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-office')!
  const ref = credentialRef('OFFICE_BROWSER_' + randomUUID().replaceAll('-', '').toUpperCase())
  await scaffold.ctx.credentials.set(ref, 'browser-fixture-private-secret')
  await scaffold.ctx.configEditor.edit(serviceEntry, current => ({ ...current,
    connectorAllowedOrigins: [origin], connectorCredentials: { 'company-oa-key': ref }, connectorTimeoutMs: 200,
    ...dingtalk === undefined ? {} : { dingtalk },
    ...wecom === undefined ? {} : { wecom },
  }))
  await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: owner }))
  await scaffold.ctx.loader.await()
  const system = { status: 200, body: JSON.stringify({ privateEcho: 'browser-fixture-private-secret' }), headers: [] as string[] }
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path: '/test-office-api/health',
    handler(request, response) {
      system.headers.push(request.headers.authorization ?? '')
      response.writeHead(system.status, { 'Content-Type': 'application/json' })
      response.end(system.body)
    },
  }))
  const integration = await scaffold.ctx.office.importIntegration(owner, { requestId: randomUUID(), json: JSON.stringify({
    name: 'office-browser-system', system: 'Company OA', version: '1.0.0', provider: 'Company',
    description: 'Configured company system', capabilities: ['Query office work'],
  }) })
  const input: OfficeConnectorInput = { integrationId: integration.id, revision: 0, requestId: randomUUID(), adapterId: 'http-json',
    baseUrl: origin + '/test-office-api/', probePath: 'health', authentication: { kind: 'bearer', credential: 'company-oa-key' },
    enabled: true }
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  const card = page.locator(`[data-office-integration="${integration.id}"]`)
  await card.getByRole('button', { name: 'Configure connection', exact: true }).waitFor()
  return { scaffold, serviceEntry, controller, browser, page, console, nav, card, input, system }
}

async function dingtalkWriteFixture(lostAcknowledgement: boolean, kind: 'todo' | 'calendar' | 'message' = 'todo') {
  const value = await fixture({ appKey: 'browser-app-key', robotCode: 'browser-company-robot', actions: kind === 'todo' ? ['create_todo']
    : kind === 'calendar' ? ['create_todo', 'create_calendar'] : ['send_message'],
  members: { owner: { unionId: 'union-owner', calendarId: 'calendar-owner', userId: 'staff-owner' } } })
  const { scaffold, input, page, card } = value
  const remote: {
    calls: string[]
    task: { id: string; sourceId: string; creatorId: string; subject: string } | null
    event: { id: string; summary: string; start: { dateTime: string }; end: { dateTime: string } } | null
    message: { processQueryKey: string } | null
    clientToken: string
  } = { calls: [], task: null, event: null, message: null, clientToken: '' }
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path: '/test-office-api/v1.0/oauth2/accessToken',
    handler(_request, response) {
      remote.calls.push('POST token')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ accessToken: 'private-todo-browser-token', expireIn: 7200 }))
    } }))
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path: '/test-office-api/v1.0/todo/users/union-owner/tasks',
    handler(request, response) {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        remote.calls.push('POST todo')
        const parsed = z.object({ sourceId: z.uuid(), creatorId: z.literal('union-owner'), subject: z.string() })
          .safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!parsed.success) { response.writeHead(400); response.end('{}'); return }
        remote.task = { id: 'browser-todo-1', ...parsed.data }
        if (lostAcknowledgement) { response.destroy(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(remote.task))
      })
    } }))
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact',
    path: '/test-office-api/v1.0/calendar/users/union-owner/calendars/calendar-owner/events',
    handler(request, response) {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        remote.calls.push('POST calendar')
        const parsed = z.object({ summary: z.string(), attendees: z.tuple([]),
          start: z.object({ dateTime: z.string() }), end: z.object({ dateTime: z.string() }) })
          .safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!parsed.success) { response.writeHead(400); response.end('{}'); return }
        remote.event = { id: 'browser-calendar-1', summary: parsed.data.summary, start: parsed.data.start, end: parsed.data.end }
        remote.clientToken = String(request.headers['x-client-token'] ?? '')
        if (lostAcknowledgement) { response.destroy(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(remote.event))
      })
    } }))
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path: '/test-office-api/v1.0/robot/oToMessages/batchSend',
    handler(request, response) {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        remote.calls.push('POST message')
        const parsed = z.object({ robotCode: z.literal('browser-company-robot'), userIds: z.tuple([z.literal('staff-owner')]),
          msgKey: z.literal('sampleMarkdown'), msgParam: z.string() }).strict()
          .safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!parsed.success) { response.writeHead(400); response.end('{}'); return }
        remote.message = { processQueryKey: 'browser-message-process-1' }
        if (lostAcknowledgement) { response.destroy(); return }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(remote.message))
      })
    } }))
  await scaffold.ctx.office.saveConnection(owner, { ...input, adapterId: 'dingtalk', probePath: 'v1.0/oauth2/accessToken' })
  await page.getByRole('button', { name: 'Refresh connection status', exact: true }).click()
  await card.getByText('Connection configured', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'System details', exact: true })
  await details.getByRole('button', { name: 'View business actions', exact: true }).click()
  const openForm = async () => {
    await details.getByRole('button', { name: kind === 'todo' ? 'Fill in business: 创建我的钉钉待办'
      : kind === 'calendar' ? 'Fill in business: 创建我的钉钉日程' : 'Fill in business: 提交本人的钉钉工作提示', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Submit company business', exact: true })
    if (kind === 'todo') {
      await form.getByRole('textbox', { name: '待办标题', exact: true }).fill('Reviewed DingTalk todo')
      await form.getByRole('textbox', { name: '待办说明', exact: true }).fill('Preserve existing approvals\nOnly for myself')
      await form.getByRole('textbox', { name: '截止时间（ISO 8601，可空）', exact: true }).fill('2026-11-01T09:00:00+08:00')
    } else if (kind === 'calendar') {
      await form.getByRole('textbox', { name: '日程标题', exact: true }).fill('Reviewed DingTalk calendar event')
      await form.getByRole('textbox', { name: '日程说明', exact: true }).fill('Only my configured calendar')
      await form.getByRole('textbox', { name: '开始时间（ISO 8601，含时区）', exact: true }).fill('2026-11-01T09:00:00+08:00')
      await form.getByRole('textbox', { name: '结束时间（ISO 8601，含时区）', exact: true }).fill('2026-11-01T10:00:00+08:00')
    } else {
      await form.getByRole('textbox', { name: '工作提示标题', exact: true }).fill('Reviewed private work prompt')
      await form.getByRole('textbox', { name: '工作提示内容', exact: true }).fill('MESSAGE_BROWSER_PRIVATE_TEXT\nKeep the original workflow')
    }
    return form
  }
  return { ...value, remote, openForm }
}

it.each([false, true])('creates a reviewed DingTalk todo and handles lost acknowledgement=%s without a second business POST', async (lost) => {
  const { scaffold, page, console, remote, openForm, input } = await dingtalkWriteFixture(lost)
  let form = await openForm()
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  expect(remote.calls).toEqual([])
  await form.getByRole('button', { name: 'Close business submission', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  expect(remote.calls).toEqual([])
  form = await openForm()
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  expect(remote.calls).toEqual([])
  await form.getByRole('button', { name: 'Confirm business submission', exact: true }).click()
  const receipt = form.getByRole('region', { name: 'Business submission receipt', exact: true })
  await receipt.getByRole('heading', { name: lost ? 'Outcome unknown' : 'Succeeded', exact: true }).waitFor()
  const saved = (await scaffold.ctx.office.connectorExecutions(owner))[0]!
  const task = remote.task
  if (!task) throw new Error('The reviewed DingTalk todo was not created')
  expect(task.sourceId).toBe(saved.id)
  expect(task.creatorId).toBe('union-owner')
  expect(remote.calls).toEqual(['POST token', 'POST todo'])
  if (lost) {
    scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact',
      path: '/test-office-api/v1.0/todo/users/union-owner/tasks/sources/' + saved.id,
      handler(_request, response) {
        remote.calls.push('GET original todo')
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(task))
      } }))
    await form.getByRole('button', { name: 'Execution records', exact: true }).click()
    const history = page.getByRole('dialog', { name: 'Execution records', exact: true })
    await history.getByRole('button', { name: `View execution: ${saved.id}`, exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Execution receipt details', exact: true })
    await detail.getByRole('button', { name: 'Check customer outcome', exact: true }).click()
    await detail.getByRole('heading', { name: 'Succeeded', exact: true }).waitFor()
    expect(remote.calls).toEqual(['POST token', 'POST todo', 'POST token', 'GET original todo'])
  }
  const final = await scaffold.ctx.office.connectorExecutionDetail(owner, saved.id)
  expect(final.status).toBe('succeeded')
  expect((await scaffold.ctx.office.connectorExecutionPage(owner, { integrationId: input.integrationId })).entries).toHaveLength(1)
  expect(await page.content()).not.toContain('private-todo-browser-token')
  await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/office-dingtalk'), { recursive: true })
  await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/office-dingtalk/${lost ? 'recovered' : 'created'}.expected.md`),
    JSON.stringify({ reviewed: true, firstOutcome: saved.status, finalOutcome: final.status,
      originalSourceMatched: task.sourceId === saved.id, result: final.result, customerCalls: remote.calls }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each([false, true])('creates a reviewed DingTalk calendar event and discloses unavailable lookup after lost acknowledgement=%s', async (lost) => {
  const { scaffold, page, console, remote, openForm } = await dingtalkWriteFixture(lost, 'calendar')
  let form = await openForm()
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  expect(remote.calls).toEqual([])
  await form.getByRole('button', { name: 'Close business submission', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  form = await openForm()
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  expect(remote.calls).toEqual([])
  await form.getByRole('button', { name: 'Confirm business submission', exact: true }).click()
  await form.getByRole('region', { name: 'Business submission receipt', exact: true })
    .getByRole('heading', { name: lost ? 'Outcome unknown' : 'Succeeded', exact: true }).waitFor()
  const original = (await scaffold.ctx.office.connectorExecutions(owner))[0]!
  expect(remote.clientToken).toBe(original.id)
  expect(remote.event?.summary).toBe('Reviewed DingTalk calendar event')
  expect(remote.calls).toEqual(['POST token', 'POST calendar'])
  if (lost) {
    await form.getByRole('button', { name: 'Execution records', exact: true }).click()
    const history = page.getByRole('dialog', { name: 'Execution records', exact: true })
    await history.getByRole('button', { name: `View execution: ${original.id}`, exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Execution receipt details', exact: true })
    await detail.getByRole('button', { name: 'Check customer outcome', exact: true }).click()
    await detail.getByText('This plugin or connection has no available outcome checker. Contact its provider and keep the execution id.',
      { exact: true }).waitFor()
    expect(await detail.getByRole('heading', { name: 'Outcome unknown', exact: true }).count()).toBe(1)
  }
  expect(remote.calls).toEqual(['POST token', 'POST calendar'])
  const final = await scaffold.ctx.office.connectorExecutionDetail(owner, original.id)
  expect(final).toEqual(original)
  expect(await page.content()).not.toContain('private-todo-browser-token')
  await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/office-dingtalk'), { recursive: true })
  await compareOrRefreshGolden(join(REPO_ROOT,
    `apps/web/tests/expected/office-dingtalk/calendar-${lost ? 'unknown' : 'created'}.expected.md`),
  JSON.stringify({ reviewed: true, outcome: final.status, sameClientToken: remote.clientToken === original.id,
    result: final.result ?? null, unsupportedLookupPreservesUnknown: lost, customerCalls: remote.calls }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['accepted', 'lost-vendor', 'lost-office'] as const)('submits a reviewed DingTalk work prompt with %s acknowledgement safely', async (mode) => {
  const { scaffold, page, console, remote, openForm } = await dingtalkWriteFixture(mode === 'lost-vendor', 'message')
  let form = await openForm()
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  expect(remote.calls).toEqual([])
  await form.getByRole('button', { name: 'Close business submission', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  expect(remote.calls).toEqual([])
  form = await openForm()
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  expect(remote.calls).toEqual([])
  if (mode === 'accepted') {
    await page.setViewportSize({ width: 900, height: 640 })
    const path = join(REPO_ROOT, '.artifacts/enterprise-office')
    await mkdir(path, { recursive: true })
    await page.screenshot({ path: join(path, 'dingtalk-message-review-small.png'), animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: join(path, 'dingtalk-message-review-dark.png'), animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
  }
  if (mode === 'lost-office') {
    const domain = scaffold.ctx.storageDomain.get('enterprise_office_connector_executions')!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    const spy = vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      if (++writes === 3) throw new Error('Outer message receipt persistence unavailable')
      await set(value)
    })
    onTestFinished(() => { spy.mockRestore() })
  }
  await form.getByRole('button', { name: 'Confirm business submission', exact: true }).click()
  if (mode === 'lost-office') await form.getByRole('button', { name: 'Retry original request', exact: true }).click()
  const receipt = form.getByRole('region', { name: 'Business submission receipt', exact: true })
  await receipt.getByRole('heading', { name: mode === 'accepted' ? 'Succeeded' : 'Outcome unknown', exact: true }).waitFor()
  const original = (await scaffold.ctx.office.connectorExecutions(owner))[0]!
  expect(remote.calls).toEqual(['POST token', 'POST message'])
  expect(remote.message?.processQueryKey).toBe('browser-message-process-1')
  if (mode !== 'accepted') {
    await form.getByRole('button', { name: 'Execution records', exact: true }).click()
    const history = page.getByRole('dialog', { name: 'Execution records', exact: true })
    await history.getByRole('button', { name: `View execution: ${original.id}`, exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Execution receipt details', exact: true })
    await detail.getByRole('button', { name: 'Check customer outcome', exact: true }).click()
    if (mode === 'lost-office') await detail.getByRole('heading', { name: 'Succeeded', exact: true }).waitFor()
    else await detail.getByText('The customer system has no definitive result yet. The operation remains unknown and was not resubmitted.',
      { exact: true }).waitFor()
  }
  const final = await scaffold.ctx.office.connectorExecutionDetail(owner, original.id)
  expect(final.status).toBe(mode === 'lost-vendor' ? 'unknown' : 'succeeded')
  expect(remote.calls).toEqual(['POST token', 'POST message'])
  expect(await page.content()).not.toContain('private-todo-browser-token')
  await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/office-dingtalk'), { recursive: true })
  await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/office-dingtalk/message-${mode}.expected.md`),
    JSON.stringify({ reviewed: true, firstOutcome: original.status, finalOutcome: final.status,
      result: final.result ?? null, customerCalls: remote.calls }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['accepted', 'lost-vendor', 'lost-office'] as const)('submits a reviewed WeCom self message with %s acknowledgement safely', async (mode) => {
  const { scaffold, page, console, input, card } = await fixture(undefined, { corpId: 'browser-corp', agentId: 1000002,
    members: { owner: 'Owner-Work' }, actions: ['send_message'] })
  const calls: string[] = []
  for (const kind of ['gettoken', 'message/send']) scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact',
    path: '/test-office-api/cgi-bin/' + kind, handler(request, response) {
      const url = new URL(request.url ?? '/', scaffold.baseUrl)
      expect(request.headers.authorization).toBeUndefined()
      calls.push(`${request.method ?? ''} ${kind}`)
      response.setHeader('Content-Type', 'application/json')
      if (kind === 'gettoken') {
        expect(request.method).toBe('GET')
        expect(Object.fromEntries(url.searchParams)).toEqual({ corpid: 'browser-corp', corpsecret: 'browser-fixture-private-secret' })
        response.end(JSON.stringify({ errcode: 0, access_token: 'wecom-browser-private-token', expires_in: 7200 })); return
      }
      expect(request.method).toBe('POST')
      expect(Object.fromEntries(url.searchParams)).toEqual({ access_token: 'wecom-browser-private-token' })
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ touser: 'Owner-Work', msgtype: 'text', agentid: 1000002,
          text: { content: 'WECOM_BROWSER_PRIVATE_MESSAGE\n审核后提醒我处理日常工作。' }, enable_id_trans: 0, enable_duplicate_check: 0 })
        if (mode === 'lost-vendor') { response.destroy(); return }
        response.end(JSON.stringify({ errcode: 0, msgid: 'browser-wecom-message-1' }))
      })
    } }))
  await scaffold.ctx.office.saveConnection(owner, { ...input, adapterId: 'wecom', probePath: 'cgi-bin/gettoken' })
  await page.getByRole('button', { name: 'Refresh connection status', exact: true }).click()
  await card.getByText('Connection configured', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'System details', exact: true })
  await details.getByRole('button', { name: 'View business actions', exact: true }).click()
  const openForm = async () => {
    await details.getByRole('button', { name: 'Fill in business: 提交本人的企业微信工作提示', exact: true }).click()
    const form = page.getByRole('dialog', { name: 'Submit company business', exact: true })
    await form.getByRole('textbox', { name: '消息内容（最多 2048 UTF-8 字节）', exact: true })
      .fill('WECOM_BROWSER_PRIVATE_MESSAGE\n审核后提醒我处理日常工作。')
    await form.getByRole('button', { name: 'Review submission', exact: true }).click()
    return form
  }
  let form = await openForm()
  expect(calls).toEqual([])
  await form.getByRole('button', { name: 'Close business submission', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  expect(calls).toEqual([])
  form = await openForm()
  if (mode === 'accepted') {
    await page.setViewportSize({ width: 900, height: 640 })
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts/enterprise-office/wecom-message-review-small.png'), animations: 'disabled' })
  }
  if (mode === 'lost-office') {
    const domain = scaffold.ctx.storageDomain.get('enterprise_office_connector_executions')!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    const spy = vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      if (++writes === 3) throw new Error('WeCom outer receipt unavailable')
      await set(value)
    })
    onTestFinished(() => { spy.mockRestore() })
  }
  await form.getByRole('button', { name: 'Confirm business submission', exact: true }).click()
  if (mode === 'lost-office') await form.getByRole('button', { name: 'Retry original request', exact: true }).click()
  await form.getByRole('region', { name: 'Business submission receipt', exact: true })
    .getByRole('heading', { name: mode === 'accepted' ? 'Succeeded' : 'Outcome unknown', exact: true }).waitFor()
  const original = (await scaffold.ctx.office.connectorExecutions(owner))[0]!
  if (mode !== 'accepted') {
    await form.getByRole('button', { name: 'Execution records', exact: true }).click()
    const history = page.getByRole('dialog', { name: 'Execution records', exact: true })
    await history.getByRole('button', { name: `View execution: ${original.id}`, exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Execution receipt details', exact: true })
    await detail.getByRole('button', { name: 'Check customer outcome', exact: true }).click()
    if (mode === 'lost-office') await detail.getByRole('heading', { name: 'Succeeded', exact: true }).waitFor()
    else await detail.getByText('The customer system has no definitive result yet. The operation remains unknown and was not resubmitted.',
      { exact: true }).waitFor()
  }
  const final = await scaffold.ctx.office.connectorExecutionDetail(owner, original.id)
  expect(final.status).toBe(mode === 'lost-vendor' ? 'unknown' : 'succeeded')
  expect(calls).toEqual(['GET gettoken', 'POST message/send'])
  for (const secret of ['wecom-browser-private-token', 'browser-fixture-private-secret', 'Owner-Work'])
    expect(await page.content()).not.toContain(secret)
  await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/office-wecom'), { recursive: true })
  await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/office-wecom/message-${mode}.expected.md`),
    JSON.stringify({ reviewed: true, firstOutcome: original.status, finalOutcome: final.status,
      result: final.result ?? null, customerCalls: calls }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('configures WeCom enterprise authentication and privately queries the mapped employee through built controls with token reuse', async () => {
  const { scaffold, page, console, card, input } = await fixture(undefined, { corpId: 'browser-corp', agentId: 1000002,
    members: { owner: 'Owner-Work' }, actions: ['profile'] })
  const calls: string[] = []
  const direct: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/test-office-api/')) direct.push(request.method()) })
  for (const kind of ['gettoken', 'user/get']) scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact',
    path: '/test-office-api/cgi-bin/' + kind, handler(request, response) {
      const url = new URL(request.url ?? '/', scaffold.baseUrl)
      expect(request.method).toBe('GET')
      expect(request.headers.authorization).toBeUndefined()
      expect(Object.fromEntries(url.searchParams)).toEqual(kind === 'gettoken'
        ? { corpid: 'browser-corp', corpsecret: 'browser-fixture-private-secret' }
        : { access_token: 'private-browser-wecom-token', userid: 'Owner-Work' })
      calls.push(`GET ${kind}`)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(kind === 'gettoken' ? { errcode: 0, access_token: 'private-browser-wecom-token', expires_in: 7200 }
        : { errcode: 0, userid: 'owner-work', name: 'Browser Employee', position: 'Operations', mobile: 'PRIVATE_WECOM_PHONE' }))
    } }))
  await card.getByRole('button', { name: 'Configure connection', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Configure connection', exact: true })
  await form.getByRole('button', { name: 'Connection adapter', exact: true }).click()
  await page.getByRole('menuitem', { name: 'wecom', exact: true }).click()
  await form.getByLabel('System base URL', { exact: true }).fill(input.baseUrl)
  await form.getByLabel('Check path', { exact: true }).fill('cgi-bin/gettoken')
  await form.getByRole('button', { name: 'Authentication', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Bearer Token', exact: true }).click()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  expect(calls).toEqual([])
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'System details', exact: true })
  await details.getByRole('button', { name: 'Check connection', exact: true }).click()
  await details.getByText('This connection check succeeded', { exact: true }).waitFor()
  await details.getByRole('button', { name: 'View business actions', exact: true }).click()
  const query = details.getByRole('button', { name: 'Query: 查询我的企业微信资料', exact: true })
  await query.click()
  const result = details.getByRole('region', { name: 'Query result', exact: true })
  await result.getByText('Browser Employee', { exact: true }).waitFor()
  await query.click()
  await expect.poll(() => calls.length).toBe(3)
  expect(calls).toEqual(['GET gettoken', 'GET user/get', 'GET user/get'])
  expect(direct).toEqual([])
  for (const secret of ['browser-fixture-private-secret', 'private-browser-wecom-token', 'PRIVATE_WECOM_PHONE', 'Owner-Work'])
    expect(await page.content()).not.toContain(secret)
  await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/office-wecom'), { recursive: true })
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-wecom/profile.expected.md'),
    JSON.stringify({ configuredAdapter: (await scaffold.ctx.office.connections(owner)).entries[0]?.adapterId,
      name: await result.getByText('Browser Employee', { exact: true }).innerText(),
      position: await result.getByText('Operations', { exact: true }).innerText(), customerRequests: calls, directBrowserRequests: direct }, null, 2),
    webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('configures DingTalk enterprise authentication and queries only the configured employee through built connection controls', async () => {
  const { scaffold, page, console, card, input } = await fixture({ appKey: 'browser-app-key',
    members: { owner: { unionId: 'union-owner', calendarId: 'calendar-owner' } }, actions: ['todos', 'calendar'] })
  const calls: string[] = []
  const direct: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/test-office-api/')) direct.push(request.method()) })
  for (const kind of ['token', 'todos', 'calendar'] as const) {
    const path = kind === 'token' ? '/test-office-api/v1.0/oauth2/accessToken'
      : kind === 'todos' ? '/test-office-api/v1.0/todo/users/union-owner/org/tasks/query'
        : '/test-office-api/v1.0/calendar/users/union-owner/calendars/calendar-owner/events'
    scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path, handler(request, response) {
      calls.push(`${request.method ?? ''} ${kind}`)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(kind === 'token' ? { accessToken: 'private-browser-dingtalk-token', expireIn: 7200 }
        : kind === 'todos' ? { todoCards: [{ subject: 'Browser DingTalk task', isDone: false }] }
          : { events: [{ summary: 'Browser DingTalk meeting', start: { dateTime: '2026-10-18T10:00Z' },
            end: { dateTime: '2026-10-18T11:00Z' } }] }))
    } }))
  }
  await card.getByRole('button', { name: 'Configure connection', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Configure connection', exact: true })
  await form.getByRole('button', { name: 'Connection adapter', exact: true }).click()
  await page.getByRole('menuitem', { name: 'dingtalk', exact: true }).click()
  await form.getByLabel('System base URL', { exact: true }).fill(input.baseUrl)
  await form.getByLabel('Check path', { exact: true }).fill('v1.0/oauth2/accessToken')
  await form.getByRole('button', { name: 'Authentication', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Bearer Token', exact: true }).click()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  expect(calls).toEqual([])
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'System details', exact: true })
  await details.getByRole('button', { name: 'Check connection', exact: true }).click()
  await details.getByText('This connection check succeeded', { exact: true }).waitFor()
  await details.getByRole('button', { name: 'View business actions', exact: true }).click()
  await details.getByRole('button', { name: 'Query: 查询我的钉钉待办', exact: true }).click()
  await details.getByText('1. Browser DingTalk task', { exact: true }).waitFor()
  await details.getByRole('button', { name: 'Query: 查询我的钉钉日历', exact: true }).click()
  await details.getByText('1. Browser DingTalk meeting', { exact: true }).waitFor()
  expect(calls).toEqual(['POST token', 'POST token', 'POST todos', 'POST token', 'GET calendar'])
  expect(direct).toEqual([])
  const markup = await page.content()
  expect(markup).not.toContain('private-browser-dingtalk-token')
  expect(markup).not.toContain('browser-fixture-private-secret')
  expect((await scaffold.ctx.office.connections(owner)).entries[0]).toMatchObject({ revision: 1, adapterId: 'dingtalk' })
  await mkdir(join(REPO_ROOT, 'apps/web/tests/expected/office-dingtalk'), { recursive: true })
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-dingtalk/reads.expected.md'),
    JSON.stringify({ configuredAdapter: 'dingtalk', credentialVisibleInPage: false, employee: 'union-owner',
      result: await details.getByRole('region', { name: 'Query result', exact: true }).getByText('1. Browser DingTalk meeting').innerText(),
      customerRequests: calls, directBrowserRequests: direct }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('synchronizes reviewed company reads through real Remote codecs and returns private durable history beside the integration page', async () => {
  const { scaffold, input, system, card, page, console } = await fixture()
  system.body = JSON.stringify({ summary: 'Retained synced data', entries: [{ label: 'Open work', value: '7' }] })
  scaffold.ctx.office.registerConnector({ id: 'sync-browser', actions: [
    { id: 'read-self', label: 'Read my work', description: '', kind: 'read', allowedRoles: ['admin'] },
  ], async probe() { throw new Error('Synchronization must not probe') }, async read(request) {
    const response = await fetch(new URL('health', request.baseUrl), { headers: request.headers, signal: request.signal, redirect: 'manual' })
    if (response.status === 401) return { status: 'unauthorized' }
    if (response.status === 429) return { status: 'rate_limited' }
    const data: unknown = await response.json()
    const parsed = z.object({ summary: z.string(), entries: z.array(z.object({ label: z.string(), value: z.string() })) }).safeParse(data)
    return parsed.success ? { status: 'read', data: parsed.data } : { status: 'invalid_response' }
  } })
  await scaffold.ctx.office.saveConnection(owner, { ...input, adapterId: 'sync-browser' })
  const directory = await scaffold.ctx.office.connectorActions(owner, input.integrationId)
  if (!directory.adapterRevision) throw new Error('Expected an active synchronization provider')
  const request = { integrationId: input.integrationId, actionId: 'read-self', connectionRevision: 1,
    adapterRevision: directory.adapterRevision, requestId: randomUUID() }
  const call = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    const response = await scaffold.hostFetch(`/api/office/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: `office/${method}`, payload: { args } }) })
    expect(response.status).toBe(200)
    return response.json()
  }
  expect(await call('syncConnectorAction', { input: request })).toMatchObject({ result: { ok: true, value: { ok: true,
    value: { meId: owner, available: true, summary: { status: 'read' }, data: { summary: 'Retained synced data' } } } } })
  expect(system.headers).toHaveLength(1)
  const saved = (await scaffold.ctx.office.connectorSyncPage(owner, { integrationId: input.integrationId })).entries[0]!
  expect(await call('syncConnectorAction', { input: request })).toMatchObject({ result: { ok: true, value: { ok: true,
    value: { summary: { id: saved.id } } } } })
  const listed = await call('connectorSyncPage', { query: { integrationId: input.integrationId } })
  expect(listed).toMatchObject({ result: { ok: true, value: { ok: true, value: { entries: [{ id: saved.id }] } } } })
  expect(JSON.stringify(listed)).not.toContain('Retained synced data')
  expect(await call('connectorSyncDetail', { id: saved.id })).toMatchObject({ result: { ok: true, value: { ok: true,
    value: { available: true, data: { entries: [{ label: 'Open work', value: '7' }] } } } } })
  expect(system.headers).toHaveLength(1)
  system.status = 401
  expect(await call('syncConnectorAction', { input: { ...request, requestId: randomUUID() } })).toMatchObject({ result: { ok: true,
    value: { ok: true, value: { summary: { status: 'unauthorized' }, data: null } } } })
  await page.getByRole('button', { name: 'Refresh connection status', exact: true }).click()
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'System details', exact: true })
  await details.getByRole('button', { name: 'View business actions', exact: true }).click()
  await details.getByText('Read my work', { exact: true }).waitFor()
  const records = await scaffold.ctx.office.connectorSyncPage(owner, { integrationId: input.integrationId })
  const original = await scaffold.ctx.office.connectorSyncDetail(owner, saved.id)
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-connector-sync/protocol.expected.md'),
    JSON.stringify({ employee: records.meId, outcomes: records.entries.map(entry => entry.status),
      metadataOnly: !JSON.stringify(listed).includes('Retained synced data'),
      originalData: original.data, customerReads: system.headers.length }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

async function synchronizationFixture() {
  const value = await fixture()
  const { scaffold, system, input, page, card } = value
  system.body = JSON.stringify({ summary: '<script>Historical work</script>', entries: [{ label: 'Open work', value: '7' }] })
  scaffold.ctx.effect(() => scaffold.ctx.office.registerConnector({ id: 'sync-ui', actions: [
    { id: 'read-self', label: 'Read my work', description: '', kind: 'read', allowedRoles: ['admin', 'employee'] },
  ], async probe() { throw new Error('A saved sync must not probe') }, async read(request) {
    const response = await fetch(new URL('health', request.baseUrl), { headers: request.headers, signal: request.signal })
    if (response.status === 401) { await response.body?.cancel(); return { status: 'unauthorized' } }
    const data: unknown = await response.json()
    return { status: 'read', data: z.object({ summary: z.string(),
      entries: z.array(z.object({ label: z.string(), value: z.string() })) }).parse(data) }
  } }))
  const configuration = { ...input, adapterId: 'sync-ui' }
  await scaffold.ctx.office.saveConnection(owner, configuration)
  await page.getByRole('button', { name: 'Refresh connection status', exact: true }).click()
  await card.getByText('Connection configured', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'System details', exact: true })
  await details.getByRole('button', { name: 'View business actions', exact: true }).click()
  const synchronize = details.getByRole('button', { name: 'Synchronize: Read my work', exact: true })
  await synchronize.waitFor()
  return { ...value, details, synchronize, configuration }
}

it('reviews synchronized reads in the built UI and recovers storage failures and lost acknowledgements with exact original retries', async () => {
  const { scaffold, page, console, input, system, synchronize, details } = await synchronizationFixture()
  const service = scaffold.ctx.office
  const sync = vi.spyOn(service, 'syncConnectorAction')
  onTestFinished(() => { sync.mockRestore() })
  const dialog = page.getByRole('dialog', { name: 'Review synchronization', exact: true })
  await synchronize.click()
  await dialog.getByRole('button', { name: 'Read and save', exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Close synchronization window', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect(system.headers).toEqual([])
  expect((await service.connectorSyncPage(owner, { integrationId: input.integrationId })).entries).toEqual([])

  const write = vi.spyOn(scaffold.ctx.storageDomain.get('enterprise_office_connector_syncs')!.global, 'set')
    .mockRejectedValueOnce(new Error('Expected synchronization publication failure'))
  onTestFinished(() => { write.mockRestore() })
  await synchronize.click()
  await dialog.getByRole('button', { name: 'Read and save', exact: true }).click()
  await dialog.getByRole('button', { name: 'Retry original request', exact: true }).waitFor()
  expect(system.headers).toHaveLength(1)
  expect((await service.connectorSyncPage(owner, { integrationId: input.integrationId })).entries).toEqual([])
  await dialog.getByRole('button', { name: 'Retry original request', exact: true }).click()
  await dialog.getByText('Synchronization saved', { exact: true }).waitFor()
  expect(sync.mock.calls[0]?.[1]).toEqual(sync.mock.calls[1]?.[1])
  expect(system.headers).toHaveLength(2)
  expect(await dialog.getByText('<script>Historical work</script>', { exact: true }).count()).toBe(1)
  expect(await dialog.locator('script').count()).toBe(0)
  await dialog.getByRole('button', { name: 'Close synchronization window', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })

  sync.mockRestore()
  const actual = service.syncConnectorAction.bind(service)
  const lost = vi.spyOn(service, 'syncConnectorAction').mockImplementationOnce(async (actor, value) => {
    await actual(actor, value)
    throw new Error('Expected synchronization acknowledgement loss')
  })
  onTestFinished(() => { lost.mockRestore() })
  await synchronize.click()
  await dialog.getByRole('button', { name: 'Read and save', exact: true }).click()
  await dialog.getByRole('button', { name: 'Retry original request', exact: true }).waitFor()
  expect((await service.connectorSyncPage(owner, { integrationId: input.integrationId })).entries).toHaveLength(2)
  expect(system.headers).toHaveLength(3)
  await dialog.getByRole('button', { name: 'Retry original request', exact: true }).click()
  await dialog.getByText('Synchronization saved', { exact: true }).waitFor()
  expect(lost.mock.calls[0]?.[1]).toEqual(lost.mock.calls[1]?.[1])
  expect(system.headers).toHaveLength(3)
  await dialog.getByRole('button', { name: 'Close synchronization window', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })

  system.status = 401
  await synchronize.click()
  await dialog.getByRole('button', { name: 'Read and save', exact: true }).click()
  await dialog.getByText('This synchronization failed. No business data was saved.', { exact: true }).waitFor()
  expect(await dialog.getByText('<script>Historical work</script>', { exact: true }).count()).toBe(0)
  expect(lost.mock.calls[2]?.[1].requestId).not.toBe(lost.mock.calls[1]?.[1].requestId)
  await dialog.getByRole('button', { name: 'Synchronization history', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'Synchronization history', exact: true })
  await history.getByRole('button', { name: 'View synchronization record:', exact: false }).first().waitFor()
  const records = await service.connectorSyncPage(owner, { integrationId: input.integrationId })
  expect(records.entries.map(entry => entry.status)).toEqual(['unauthorized', 'read', 'read'])
  await history.getByRole('button', { name: `View synchronization record: ${records.entries[1]!.id}`, exact: true }).click()
  const saved = page.getByRole('dialog', { name: 'Synchronization details', exact: true })
  await saved.getByText('<script>Historical work</script>', { exact: true }).waitFor()
  await saved.getByText('This is a historical snapshot at the displayed time, rather than current business system data.',
    { exact: true }).waitFor()
  expect(system.headers).toHaveLength(4)
  expect(await page.content()).not.toContain('browser-fixture-private-secret')
  await page.setViewportSize({ width: 900, height: 640 })
  const bounds = await saved.boundingBox()
  if (!bounds) throw new Error('Synchronization details are missing')
  expect(bounds.y).toBeGreaterThanOrEqual(24)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(616)
  expect(await saved.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await mkdir(join(REPO_ROOT, '.artifacts/enterprise-office'), { recursive: true })
  await page.screenshot({ path: join(REPO_ROOT, '.artifacts/enterprise-office/connector-sync-small.png'), animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(REPO_ROOT, '.artifacts/enterprise-office/connector-sync-dark.png'), animations: 'disabled' })
  await saved.getByRole('button', { name: 'Close synchronization window', exact: true }).click()
  await details.getByRole('button', { name: 'Close system details', exact: true }).click()
  await details.waitFor({ state: 'hidden' })
  const warnings = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Integrations', exact: true }).click()
  await page.locator(`[data-office-integration="${input.integrationId}"]`).getByRole('button', { name: 'System details', exact: true }).click()
  const restored = page.getByRole('dialog', { name: 'System details', exact: true })
  await restored.getByRole('button', { name: 'Synchronization history', exact: true }).click()
  await history.getByRole('button', { name: `View synchronization record: ${records.entries[1]!.id}`, exact: true }).click()
  await saved.getByText('<script>Historical work</script>', { exact: true }).waitFor()
  expect(system.headers).toHaveLength(4)
  acknowledgeReloadConnectionLoss(console, warnings)
  await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/office-connector-sync/ui.expected.md'),
    JSON.stringify({ outcomes: records.entries.map(entry => entry.status), customerReads: system.headers.length,
      data: (await service.connectorSyncDetail(owner, records.entries[1]!.id)).data,
      retryPreserved: lost.mock.calls[0]?.[1].requestId === lost.mock.calls[1]?.[1].requestId }, null, 2), webSnapshotMode())
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('withholds synchronization snapshots after a connection change and keeps another employee history empty in the built UI', async () => {
  const { scaffold, page, console, input, system, synchronize, configuration, controller, nav } = await synchronizationFixture()
  await synchronize.click()
  const review = page.getByRole('dialog', { name: 'Review synchronization', exact: true })
  await review.getByRole('button', { name: 'Read and save', exact: true }).click()
  await review.getByText('<script>Historical work</script>', { exact: true }).waitFor()
  await scaffold.ctx.office.saveConnection(owner, { ...configuration, revision: 1, requestId: randomUUID(), enabled: false })
  await review.getByText('Your permissions or connection changed. The data in this record is currently unavailable.', { exact: true }).waitFor()
  expect(await review.getByText('<script>Historical work</script>', { exact: true }).count()).toBe(0)
  await review.getByRole('button', { name: 'Synchronization history', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'Synchronization history', exact: true })
  const record = (await scaffold.ctx.office.connectorSyncPage(owner, { integrationId: input.integrationId })).entries[0]!
  await history.getByRole('button', { name: `View synchronization record: ${record.id}`, exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'Synchronization details', exact: true })
  await detail.getByText('Your permissions or connection changed. The data in this record is currently unavailable.', { exact: true }).waitFor()
  expect(await detail.getByText('<script>Historical work</script>', { exact: true }).count()).toBe(0)
  const warningStart = console.warnings.length
  await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: 'local' }))
  await scaffold.ctx.loader.await()
  await page.getByRole('button', { name: 'Import plugin manifest', exact: true }).waitFor({ state: 'hidden' })
  await detail.waitFor({ state: 'hidden' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  const card = page.locator(`[data-office-integration="${input.integrationId}"]`)
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  await page.getByRole('dialog', { name: 'System details', exact: true })
    .getByRole('button', { name: 'Synchronization history', exact: true }).click()
  await history.getByText('No synchronization records', { exact: true }).waitFor()
  expect(await page.getByText('<script>Historical work</script>', { exact: true }).count()).toBe(0)
  expect(system.headers).toHaveLength(1)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('queries a real system from employee details, renders plain-text fields and clears old data on authentication failure', async () => {
  const { scaffold, controller, page, console, nav, card, input, system } = await fixture()
  const seen: OfficeMemberId[] = []
  const longValue = '文'.repeat(2000)
  system.body = JSON.stringify({ summary: '<script>business field</script>', entries: [
    { label: 'Pending requests', value: '3' }, { label: 'Long record', value: longValue },
  ] })
  scaffold.ctx.effect(() => scaffold.ctx.office.registerConnector({ id: 'browser-business-read', actions: [
    { id: 'read-own', label: 'My business records', description: 'Query current employee records', kind: 'read',
      allowedRoles: ['employee'] },
    { id: 'write-record', label: 'Write business records', description: '', kind: 'write', allowedRoles: ['employee'] },
  ], async probe() { throw new Error('A business query must not probe') }, async read(request) {
    seen.push(request.member.id)
    const response = await fetch(new URL('health', request.baseUrl), { method: 'GET', headers: request.headers,
      signal: request.signal, redirect: 'manual' })
    if (response.status === 401) { await response.body?.cancel(); return { status: 'unauthorized' } }
    const data: unknown = await response.json()
    return { status: 'read', data: z.object({ summary: z.string(),
      entries: z.array(z.object({ label: z.string(), value: z.string() })) }).parse(data) }
  } }))
  await scaffold.ctx.office.saveConnection(owner, { ...input, adapterId: 'browser-business-read' })
  const warningStart = console.warnings.length
  await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: 'local' }))
  await scaffold.ctx.loader.await()
  await page.getByRole('button', { name: 'Import plugin manifest', exact: true }).waitFor({ state: 'hidden' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh connection status', exact: true }).click()
  await card.getByText('Connection configured', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'System details', exact: true })
  const catalogue = dialog.getByRole('region', { name: 'Business actions', exact: true })
  await catalogue.getByRole('button', { name: 'View business actions', exact: true }).click()
  const query = catalogue.getByRole('button', { name: 'Query: My business records', exact: true })
  await query.waitFor()
  expect(seen).toEqual([])
  expect(await catalogue.getByRole('button', { name: 'Query: Write business records', exact: true }).count()).toBe(0)
  await query.click()
  const result = catalogue.getByRole('region', { name: 'Query result', exact: true })
  await result.getByText('Query succeeded', { exact: false }).waitFor()
  expect(await result.getByText('<script>business field</script>', { exact: true }).count()).toBe(1)
  expect(await result.getByText('3', { exact: true }).count()).toBe(1)
  expect(await result.getByText(longValue, { exact: true }).count()).toBe(1)
  expect(await result.locator('script').count()).toBe(0)
  expect(await result.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await result.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(seen).toEqual(['local'])
  expect(system.headers).toEqual(['Bearer browser-fixture-private-secret'])
  expect(await page.content()).not.toContain('browser-fixture-private-secret')
  await page.setViewportSize({ width: 900, height: 640 })
  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await result.scrollIntoViewIfNeeded()
  const bounds = await dialog.boundingBox()
  if (!bounds) throw new Error('System details disappeared')
  expect(bounds.y).toBeGreaterThanOrEqual(24)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(616)
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const close = dialog.getByRole('button', { name: 'Close system details', exact: true })
  const closeBounds = await close.boundingBox()
  if (!closeBounds) throw new Error('System details close action is unavailable')
  expect(closeBounds.y).toBeGreaterThanOrEqual(24)
  expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(616)
  await page.screenshot({ path: join(shots, 'connector-query-small.png'), fullPage: true, animations: 'disabled' })
  system.status = 401
  await query.click()
  await result.getByText('The system rejected authentication. Check credentials and permissions.', { exact: false }).waitFor()
  expect(await result.getByText(longValue, { exact: true }).count()).toBe(0)
  expect(await result.getByText('3', { exact: true }).count()).toBe(0)
  expect(seen).toEqual(['local', 'local'])
  await close.click()
  await dialog.waitFor({ state: 'hidden' })
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['admin', 'employee'] as const)('shows only declared %s actions in actual system details and refreshes after provider removal', async (role) => {
  const { scaffold, controller, page, console, nav, card, input, system } = await fixture()
  const probe = vi.fn(async () => ({ status: 'connected' as const }))
  const unregister = scaffold.ctx.office.registerConnector({ id: 'browser-actions', probe, actions: [
    { id: 'employee-records', label: 'My office records', description: 'Declared employee query', kind: 'read',
      allowedRoles: ['employee'] },
    { id: 'admin-update', label: 'Update company records', description: 'Declared administrator write', kind: 'write',
      allowedRoles: ['admin'] },
  ] })
  onTestFinished(unregister)
  await scaffold.ctx.office.saveConnection(owner, { ...input, adapterId: 'browser-actions', authentication: { kind: 'none' } })
  const warningStart = console.warnings.length
  if (role === 'employee') {
    await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: 'local' }))
    await scaffold.ctx.loader.await()
    await page.getByRole('button', { name: 'Import plugin manifest', exact: true }).waitFor({ state: 'hidden' })
    acknowledgeReloadConnectionLoss(console, warningStart)
  }
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh connection status', exact: true }).click()
  await card.getByText('Connection configured', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'System details', exact: true })
  const catalogue = dialog.getByRole('region', { name: 'Business actions', exact: true })
  expect(await catalogue.getByText(/My office records|Update company records/).count()).toBe(0)
  await catalogue.getByRole('button', { name: 'View business actions', exact: true }).click()
  const label = role === 'admin' ? 'Update company records' : 'My office records'
  const hidden = role === 'admin' ? 'My office records' : 'Update company records'
  await catalogue.getByText(label, { exact: true }).waitFor()
  expect(await catalogue.getByText(hidden, { exact: true }).count()).toBe(0)
  expect(await catalogue.getByRole('button').allTextContents()).toEqual(['Refresh business actions'])
  expect(await catalogue.innerText()).toContain(role === 'admin' ? 'Write' : 'Read')
  expect(probe).not.toHaveBeenCalled()
  expect(system.headers).toEqual([])
  expect(await page.content()).not.toContain('browser-fixture-private-secret')
  if (role === 'employee') {
    expect(await dialog.innerText()).not.toContain(input.baseUrl)
    const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: join(shots, 'connector-actions-employee.png'), fullPage: true, animations: 'disabled' })
  }
  unregister()
  await catalogue.getByRole('button', { name: 'Refresh business actions', exact: true }).click()
  await catalogue.getByText('Connection adapter unavailable. Contact an administrator.', { exact: true }).waitFor()
  expect(await catalogue.getByText(label, { exact: true }).count()).toBe(0)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('saves and checks a real company system without exposing private credentials or response content', async () => {
  const { scaffold, page, console, card, input, system } = await fixture()
  const directRequests: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/test-office-api/health') directRequests.push(request.method()) })
  await card.getByRole('button', { name: 'Configure connection', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Configure connection', exact: true })
  await dialog.getByLabel('System base URL', { exact: true }).fill(input.baseUrl)
  await dialog.getByRole('button', { name: 'Authentication', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Bearer Token', exact: true }).click()
  expect(await dialog.getByRole('button', { name: 'Server credential', exact: true }).innerText()).toBe('company-oa-key')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await card.getByText('Connection configured', { exact: true }).waitFor()
  expect(system.headers).toEqual([])
  expect((await scaffold.ctx.office.connections(owner)).entries[0]?.revision).toBe(1)
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'System details', exact: true })
  await dialog.getByRole('button', { name: 'Check connection', exact: true }).click()
  await dialog.getByText('This connection check succeeded', { exact: true }).waitFor()
  expect(system.headers).toEqual(['Bearer browser-fixture-private-secret'])
  expect(directRequests).toEqual([])
  expect(await page.content()).not.toContain('browser-fixture-private-secret')
  system.status = 401
  await dialog.getByRole('button', { name: 'Check connection', exact: true }).click()
  await dialog.getByText('The system rejected authentication. Check credentials and permissions.', { exact: true }).waitFor()
  system.status = 429
  await dialog.getByRole('button', { name: 'Check connection', exact: true }).click()
  await dialog.getByText('The system is rate limiting requests. Check again later.', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByText('Connection configuration saved; connectivity still needs checking', { exact: true }).waitFor({ state: 'hidden' })
  await card.getByRole('button', { name: 'Configure connection', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Configure connection', exact: true })
  expect(await dialog.getByLabel('System base URL', { exact: true }).inputValue()).toBe(input.baseUrl)
  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'connections-light.png'), fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
  await page.screenshot({ path: join(shots, 'connections-dark.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 1040, height: 700 })
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: join(shots, 'connections-small.png'), fullPage: true, animations: 'disabled' })
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('retains unknown save retries and reloads a competing configuration only after an explicit choice', async () => {
  const { scaffold, page, console, card, input } = await fixture()
  const service = scaffold.ctx.office
  const original = service.saveConnection.bind(service)
  const saved = vi.spyOn(service, 'saveConnection').mockImplementationOnce(async (actor, value) => {
    await original(actor, value)
    throw new Error('Expected lost connection save acknowledgement')
  })
  onTestFinished(() => { saved.mockRestore() })
  await card.getByRole('button', { name: 'Configure connection', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Configure connection', exact: true })
  await dialog.getByLabel('System base URL', { exact: true }).fill(input.baseUrl)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.getByText('Save outcome is unknown. Retry the original values, or close and read again; closing does not undo a possible save.',
    { exact: true }).waitFor()
  expect(await dialog.getByLabel('System base URL', { exact: true }).isDisabled()).toBe(true)
  await card.getByText('Connection configured', { exact: true }).waitFor()
  expect(await dialog.getByLabel('System base URL', { exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect(saved).toHaveBeenCalledTimes(2)
  expect(saved.mock.calls[0]?.[1]).toEqual(saved.mock.calls[1]?.[1])
  expect((await service.connections(owner)).revision).toBe(1)
  await card.getByRole('button', { name: 'Configure connection', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Configure connection', exact: true })
  await dialog.getByLabel('Check path', { exact: true }).fill('my-unsaved-change')
  const current = (await service.connections(owner)).entries[0]!
  await service.saveConnection(owner, { ...input, authentication: { kind: 'none' }, revision: current.revision,
    requestId: randomUUID(), probePath: 'changed-elsewhere' })
  await dialog.getByText('Another window updated this connection. Load the latest configuration before editing again.', { exact: true }).waitFor()
  expect(await dialog.getByLabel('Check path', { exact: true }).inputValue()).toBe('my-unsaved-change')
  expect(await dialog.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('button', { name: 'Load latest configuration', exact: true }).click()
  await expect.poll(() => dialog.getByLabel('Check path', { exact: true }).inputValue()).toBe('changed-elsewhere')
  await dialog.getByLabel('Check path', { exact: true }).fill('health')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  expect((await service.connections(owner)).entries[0]).toMatchObject({ revision: 3, configuration: { probePath: 'health' } })
  expect(console.pageErrors).toEqual([])
})

it('allows an administrator to disable a retained connection after its deployment origin and credential alias are removed', async () => {
  const { scaffold, serviceEntry, page, console, nav, card, input, system } = await fixture()
  await scaffold.ctx.office.saveConnection(owner, input)
  await scaffold.ctx.configEditor.edit(serviceEntry, current => ({ ...current,
    connectorAllowedOrigins: [], connectorCredentials: {},
  }))
  await scaffold.ctx.loader.await()
  const warningStart = console.warnings.length
  await page.reload({ waitUntil: 'load' })
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  await card.getByText('Address or credential is not approved. Contact an administrator.', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'Configure connection', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Configure connection', exact: true })
  await dialog.getByRole('checkbox', { name: 'Enable this connection', exact: true }).uncheck()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await card.getByText('Connection disabled', { exact: true }).waitFor()
  expect((await scaffold.ctx.office.connections(owner)).entries[0]).toMatchObject({ revision: 2, status: 'disabled' })
  expect(system.headers).toEqual([])
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['role', 'account'] as const)('clears private connection controls and fences a late probe after %s changes', async (change) => {
  const { scaffold, controller, page, console, nav, card, input } = await fixture()
  const service = scaffold.ctx.office
  await service.saveConnection(owner, input)
  const member = service.view(owner).me
  await service.saveMember(owner, { ...member, id: 'second_admin' as OfficeMemberId, name: 'Second admin' }, null)
  await page.getByRole('button', { name: 'Refresh connection status', exact: true }).click()
  await card.getByText('Connection configured', { exact: true }).waitFor()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = service.probeConnection.bind(service)
  const checking = vi.spyOn(service, 'probeConnection').mockImplementationOnce(async (...args) => {
    const result = await original(...args)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  onTestFinished(() => { release.resolve(undefined); checking.mockRestore() })
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'System details', exact: true })
  await dialog.getByRole('button', { name: 'Check connection', exact: true }).click()
  await entered.promise
  const warningStart = console.warnings.length
  if (change === 'role') await service.saveMember(owner, { ...member, role: 'employee' }, member)
  else {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: 'local' }))
    await scaffold.ctx.loader.await()
    await expect.poll(() => page.getByRole('button', { name: 'Profile', exact: true }).textContent(), { timeout: 10000 })
      .toContain('本机用户')
  }
  await page.getByRole('button', { name: 'Import plugin manifest', exact: true }).waitFor({ state: 'hidden' })
  await dialog.waitFor({ state: 'hidden' })
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'System details', exact: true })
  await dialog.getByText('Connection configured', { exact: true }).waitFor()
  release.resolve(undefined)
  await expect.poll(() => checking.mock.settledResults[0]?.type).toBe('fulfilled')
  expect(await dialog.getByRole('button', { name: 'Check connection', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Configure connection', exact: true }).count()).toBe(0)
  expect(await dialog.getByText('This connection check succeeded', { exact: true }).count()).toBe(0)
  expect(await page.locator('body').innerText()).not.toContain(input.baseUrl)
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
