/** Real native approval and local HTTP POSTs retain authoritative or unknown customer outcomes in the model's own history. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { z } from 'zod'
import { expect, it, onTestFinished } from 'vitest'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { OfficeConversationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnectorReconcileRequest } from '@deepseek-ai/dsh-enterprise-office'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, writeComposerDraft } from './support.ts'

const actor = 'local' as OfficeMemberId
const owner = 'owner' as OfficeMemberId
const marker = 'ACTUAL_CUSTOMER_WRITE_RECEIPT'
const reply = 'OFFICE_WRITE_TURN_FINISHED'
const provider = 'office-business-write-test'
const values = [{ name: 'title', value: 'Employee purchase' }, { name: 'reason', value: 'Purchase requested by employee' }]
type Mode = 'success' | 'unknown' | 'fault' | 'repeat' | 'rejected'

class WriteAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly writeArgs: { system: string; action_id: string; connection_revision: number; adapter_revision: string },
    private readonly repeat: boolean) { super() }
  override async listModels(name: string) { return [{ provider: name, id: 'write', name: 'Office write fixture' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const index = this.requests.length
    if (index <= (this.repeat ? 3 : 2)) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`office-write-${index}`),
        name: index === 1 ? 'office_list_actions' : 'office_write_action',
        arguments: JSON.stringify(index === 1 ? { system: this.writeArgs.system } : { ...this.writeArgs, values }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function fixture(selected = true, approval?: 'manual' | 'automatic', mode: Mode = 'success',
  checking: 'success' | 'unknown' | 'rejected' | 'fault' | 'unavailable' = 'unavailable') {
  const scaffold = await launchWebScaffold({ profile: { packages: [] },
    extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const origin = new URL(scaffold.baseUrl).origin
  const service = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-enterprise-office')!
  const tool = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'tool-office')!
  const ref = credentialRef('OFFICE_WRITE_' + randomUUID().replaceAll('-', '').toUpperCase())
  await scaffold.ctx.credentials.set(ref, 'native-write-private-secret')
  await scaffold.ctx.configEditor.edit(service, current => ({ ...current,
    connectorAllowedOrigins: [origin], connectorCredentials: { 'write-key': ref },
  }))
  await scaffold.ctx.configEditor.edit(tool, current => ({ ...current, approval: 'automatic',
    readApproval: 'automatic', ...approval === undefined ? {} : { writeApproval: approval } }))
  await scaffold.ctx.loader.await()
  if (!tool.fiber) throw new Error('Office write tools did not activate')
  await tool.fiber.await()
  expect(tool.fiber.state).toBe(2)
  const calls: { employee: string; authorization: string; id: string; body: unknown }[] = []
  const checks: { employee: string; id: string }[] = []
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path: '/test-native-office-write-receipt',
    handler(request, response) {
      expect(request.method).toBe('GET')
      checks.push({ employee: String(request.headers['x-office-employee']), id: String(request.headers['idempotency-key']) })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(checking === 'unknown' ? { status: 'unknown' }
        : checking === 'rejected' ? { status: 'rejected', rejection: 'not_accepted' }
          : { status: 'succeeded', result: { summary: marker, entries: [{ label: 'Customer id', value: 'OA-42' }] } }))
    } }))
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path: '/test-native-office-write',
    handler(request, response) {
      expect(request.method).toBe('POST')
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        const data: unknown = JSON.parse(body)
        calls.push({ employee: String(request.headers['x-office-employee']), authorization: String(request.headers.authorization),
          id: String(request.headers['idempotency-key']), body: data })
        if (mode === 'rejected') {
          response.writeHead(422, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ accepted: false, reason: 'not_accepted' }))
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ summary: marker, entries: [{ label: 'Customer id', value: 'OA-42' }] }))
      })
    } }))
  scaffold.ctx.effect(() => scaffold.ctx.office.registerConnector({ id: 'native-write', actions: [
    { id: 'submit-request', label: 'Submit employee request', description: 'Submit this employee purchase', kind: 'write',
      allowedRoles: ['employee'], fields: [{ name: 'title', label: 'Title', required: true, maxLength: 120 },
        { name: 'reason', label: 'Reason', required: false, maxLength: 4000 }] },
    { id: 'admin-write', label: 'Admin write', description: '', kind: 'write', allowedRoles: ['admin'] },
  ], ...checking === 'unavailable' ? {} : { async reconcile(request: OfficeConnectorReconcileRequest) {
    const response = await fetch(new URL('test-native-office-write-receipt', request.baseUrl), { method: 'GET',
      headers: { ...request.headers, 'x-office-employee': request.member.id, 'idempotency-key': request.executionId },
      signal: request.signal, redirect: 'manual' })
    if (checking === 'fault') throw new Error(`Private checker diagnostic: ${request.headers.authorization}`)
    return z.discriminatedUnion('status', [
      z.object({ status: z.literal('succeeded'), result: z.object({ summary: z.string(),
        entries: z.array(z.object({ label: z.string(), value: z.string() })) }) }),
      z.object({ status: z.literal('unknown') }),
      z.object({ status: z.literal('rejected'), rejection: z.literal('not_accepted') }),
    ]).parse(await response.json())
  } }, async probe() { throw new Error('Business writes must not probe') }, async write(request) {
    const response = await fetch(new URL('test-native-office-write', request.baseUrl), { method: 'POST',
      headers: { ...request.headers, 'x-office-employee': request.member.id, 'idempotency-key': request.executionId },
      body: JSON.stringify(request.values), signal: request.signal, redirect: 'manual' })
    const data: unknown = await response.json()
    if (mode === 'rejected' && response.status === 422) return { status: 'rejected', rejection: 'not_accepted' }
    if (mode === 'fault') throw new Error(`Private adapter diagnostic: ${request.headers.authorization}`)
    if (mode === 'unknown' || mode === 'repeat') return { status: 'unknown' }
    return { status: 'succeeded', result: z.object({ summary: z.string(),
      entries: z.array(z.object({ label: z.string(), value: z.string() })) }).parse(data) }
  } }))
  const integration = await scaffold.ctx.office.importIntegration(owner, { requestId: randomUUID(), json: JSON.stringify({
    name: 'company-write', system: 'Company Write', version: '1', provider: 'Company', description: 'Employee system write',
    capabilities: ['Submit employee purchase'],
  }) })
  const connection = { integrationId: integration.id, revision: 0, requestId: randomUUID(), adapterId: 'native-write',
    baseUrl: origin + '/', probePath: 'test-native-office-write', enabled: true,
    authentication: { kind: 'bearer' as const, credential: 'write-key' } }
  await scaffold.ctx.office.saveConnection(owner, connection)
  const directory = await scaffold.ctx.office.connectorActions(actor, integration.id)
  if (!directory.adapterRevision) throw new Error('Expected an active write provider')
  const adapter = new WriteAdapter({ system: integration.system, action_id: 'submit-request', connection_revision: 1,
    adapter_revision: directory.adapterRevision }, mode === 'repeat')
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'write' })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  if (!current.sessionId) throw new Error('Expected a selected native conversation')
  const conversationId = current.sessionId as OfficeConversationId
  if (selected) await scaffold.ctx.office.saveConversationLinks(actor, { conversationId, revision: 0, requestId: randomUUID(),
    kind: 'integrations', integrations: [integration.id] })
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Submit the employee purchase using the associated Company Write system.')
  return { scaffold, page, console, input, conversationId, adapter, calls, checks, connection, tool }
}

it.each([true, false])('offers native business submission only for a submitted configured system: %s', async (selected) => {
  const { scaffold, page, console, input, conversationId, adapter, calls } = await fixture(selected, 'automatic')
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor()
  const names = adapter.requests[0]?.tools?.map(tool => tool.name) ?? []
  expect(names.includes('office_write_action')).toBe(selected)
  expect(names).toContain('write')
  expect(names).not.toContain('office_create_work')
  const events = await readPersistedEvents(scaffold, id)
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(2)
  expect(results[1]?.data.message.isError).toBe(!selected)
  expect(calls).toHaveLength(selected ? 1 : 0)
  if (selected) {
    const receipt = (await scaffold.ctx.office.connectorExecutions(actor))[0]!
    expect(receipt.status).toBe('succeeded')
    expect(calls[0]).toEqual({ employee: actor, authorization: 'Bearer native-write-private-secret', id: receipt.id,
      body: Object.fromEntries(values.map(field => [field.name, field.value])) })
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('max_length')
    expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('admin-write')
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain(marker)
    expect(JSON.stringify(events)).toContain(marker)
    expect(JSON.stringify(events)).not.toMatch(/native-write-private-secret|WRITE_TEST_SECRET|test-native-office-write/)
    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    await page.getByText(reply, { exact: true }).waitFor()
    acknowledgeReloadConnectionLoss(console, warningStart)
    expect(await readPersistedEvents(scaffold, id)).toEqual(events)
    expect(calls).toHaveLength(1)
  }
  const agent = scaffold.ctx.agents.get(SessionId(conversationId))
  if (!agent) throw new Error('Native write Agent disappeared')
  expect(scaffold.ctx.tools.get('office_write_action', agent)).toBeUndefined()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['allow', 'reject', 'revoke', 'connection', 'role', 'unload'] as const)('reviews exact business fields and rechecks authority: %s', async (action) => {
  const { scaffold, page, console, input, conversationId, adapter, calls, connection, tool } = await fixture()
  await input.press('Enter')
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor({ timeout: 20_000 })
  expect(adapter.requests).toHaveLength(2)
  expect(calls).toEqual([])
  const text = await panel.innerText()
  expect(text).toContain('Submit to company system')
  expect(text).toContain('System: "Company Write"\nRegistration: "company-write"\nAction: "submit-request"\nEmployee: "local"')
  expect(text).toContain('Connection version: 1\nProvider version: "')
  for (const field of values) expect(text).toContain(`Field "${field.name}": ${JSON.stringify(field.value)}`)
  if (action === 'allow') {
    const other = await scaffold.ctx.agents.create({ sessionId: SessionId(`write-other-${randomUUID()}`),
      meta: { cwd: scaffold.workspaceCwd }, setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) })
    onTestFinished(() => other.dispose())
    expect(scaffold.ctx.tools.get('office_write_action', other.agent)).toBeUndefined()
    expect(scaffold.ctx.tools.get('write', other.agent)).toBeDefined()
    const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
    await mkdir(shots, { recursive: true })
    await panel.screenshot({ path: join(shots, 'native-company-write-approval.png') })
  }
  if (action === 'revoke') await scaffold.ctx.office.saveConversationLinks(actor, { conversationId, revision: 1,
    requestId: randomUUID(), kind: 'integrations', integrations: [] })
  if (action === 'connection') await scaffold.ctx.office.saveConnection(owner, { ...connection, revision: 1,
    requestId: randomUUID(), probePath: 'changed-after-review' })
  if (action === 'role') {
    const member = scaffold.ctx.office.view(owner).members.find(row => row.id === actor)!
    await scaffold.ctx.office.saveMember(owner, { ...member, role: 'manager' }, member)
  }
  if (action === 'unload') {
    if (!tool.fiber) throw new Error('Native tool plugin disappeared')
    await tool.fiber.dispose()
  }
  const settled = scaffold.whenTurnSettled()
  await panel.getByRole('button', { name: action === 'reject' ? 'Reject' : 'Allow once', exact: true }).click()
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor()
  const events = await readPersistedEvents(scaffold, id)
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(2)
  expect(results[1]?.data.message.isError).toBe(action !== 'allow')
  expect(calls).toHaveLength(action === 'allow' ? 1 : 0)
  expect(JSON.stringify(adapter.requests[2]?.messages).includes(marker)).toBe(action === 'allow')
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['unknown', 'fault', 'repeat'] as const)('reports %s without inventing success, leaking diagnostics or submitting twice', async (mode) => {
  const { scaffold, page, console, input, adapter, calls } = await fixture(true, 'automatic', mode)
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor()
  expect(calls).toHaveLength(1)
  const receipts = await scaffold.ctx.office.connectorExecutions(actor)
  expect(receipts).toHaveLength(1)
  expect(receipts[0]?.status).toBe('unknown')
  const events = await readPersistedEvents(scaffold, id)
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(mode === 'repeat' ? 3 : 2)
  expect(results[1]?.data.message.isError).toBe(mode === 'fault')
  if (mode === 'fault') expect(results[1]?.data.error?.code).toBe('OFFICE_WRITE_UNKNOWN')
  else {
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain(receipts[0]!.id)
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('unknown')
  }
  if (mode === 'repeat') expect(results[2]?.data.message.isError).toBe(false)
  expect(JSON.stringify(events)).not.toContain(marker)
  expect(JSON.stringify(events)).not.toMatch(/native-write-private-secret|Private adapter diagnostic/)
  expect(JSON.stringify(adapter.requests)).not.toMatch(/native-write-private-secret|Private adapter diagnostic/)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('browses only own paginated receipts and opens bounded details without resubmitting a business operation', async () => {
  const { scaffold, page, console, connection, calls } = await fixture(true, 'automatic')
  const directory = await scaffold.ctx.office.connectorActions(actor, connection.integrationId)
  if (!directory.adapterRevision) throw new Error('Expected a current write provider')
  const base = { integrationId: connection.integrationId, connectionRevision: 1, adapterRevision: directory.adapterRevision }
  const foreign = await scaffold.ctx.office.writeConnectorAction(owner, { ...base, actionId: 'admin-write', requestId: randomUUID(), values: {} })
  const own = []
  for (let index = 0; index < 22; index++) own.push(await scaffold.ctx.office.writeConnectorAction(actor, {
    ...base, actionId: 'submit-request', requestId: randomUUID(), values: { title: `Purchase ${index}` },
  }))
  expect(calls).toHaveLength(23)
  const nav = page.getByRole('navigation', { name: 'Workbench', exact: true })
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  const card = page.locator(`[data-office-integration="${connection.integrationId}"]`)
  await card.getByRole('button', { name: 'System details', exact: true }).click()
  const system = page.getByRole('dialog', { name: 'System details', exact: true })
  await system.getByRole('button', { name: 'Execution records', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'Execution records', exact: true })
  await history.getByRole('button', { name: 'Load older records', exact: true }).waitFor()
  expect(await history.getByRole('button', { name: /^View execution:/ }).count()).toBe(20)
  expect(await history.getByText(foreign.id, { exact: false }).count()).toBe(0)
  expect(await history.getByText(marker, { exact: true }).count()).toBe(0)
  await history.getByRole('button', { name: 'Load older records', exact: true }).click()
  await history.getByRole('button', { name: `View execution: ${own[0]!.id}`, exact: true }).waitFor()
  expect(await history.getByRole('button', { name: /^View execution:/ }).count()).toBe(22)
  await history.getByRole('button', { name: `View execution: ${own[0]!.id}`, exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'Execution receipt details', exact: true })
  await detail.getByText(marker, { exact: true }).waitFor()
  expect(await detail.getByText(own[0]!.id, { exact: true }).count()).toBe(1)
  expect(await detail.getByRole('region', { name: 'Processing stages', exact: true }).getByRole('listitem').count()).toBe(3)
  expect(await detail.getByText('OA-42', { exact: true }).count()).toBe(1)
  await page.setViewportSize({ width: 900, height: 640 })
  const box = await detail.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(640)
  await detail.getByRole('button', { name: 'Back to execution records', exact: true }).click()
  await history.getByRole('button', { name: `View execution: ${own[0]!.id}`, exact: true }).waitFor()
  expect(calls).toHaveLength(23)
  const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
  await mkdir(shots, { recursive: true })
  await history.screenshot({ path: join(shots, 'employee-execution-history.png') })
  await history.getByRole('button', { name: 'Close execution records', exact: true }).click()
  await system.getByRole('button', { name: 'Close system details', exact: true }).click()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each([false, true])('shows an empty or explicitly unknown own history without offering business replay: %s', async (unknown) => {
  const { scaffold, page, console, connection, calls } = await fixture(true, 'automatic', unknown ? 'unknown' : 'success')
  const directory = await scaffold.ctx.office.connectorActions(actor, connection.integrationId)
  if (!directory.adapterRevision) throw new Error('Expected a current write provider')
  const receipt = unknown ? await scaffold.ctx.office.writeConnectorAction(actor, { integrationId: connection.integrationId,
    actionId: 'submit-request', connectionRevision: 1, adapterRevision: directory.adapterRevision,
    requestId: randomUUID(), values: { title: 'Unconfirmed purchase' } }) : null
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Integrations', exact: true }).click()
  await page.locator(`[data-office-integration="${connection.integrationId}"]`).getByRole('button', { name: 'System details', exact: true }).click()
  await page.getByRole('dialog', { name: 'System details', exact: true }).getByRole('button', { name: 'Execution records', exact: true }).click()
  const history = page.getByRole('dialog', { name: 'Execution records', exact: true })
  if (receipt) {
    await history.getByText('Outcome unknown', { exact: false }).waitFor()
    await history.getByRole('button', { name: `View execution: ${receipt.id}`, exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Execution receipt details', exact: true })
    await detail.getByText(receipt.id, { exact: true }).waitFor()
    expect(await detail.getByRole('heading', { name: 'Outcome unknown', exact: true }).count()).toBe(1)
    expect(await detail.getByRole('region', { name: 'Customer system receipt', exact: true }).count()).toBe(0)
    expect(await detail.getByText('The customer system may have processed this operation.', { exact: false }).count()).toBe(1)
  } else await history.getByText('You have no execution records for this system', { exact: true }).waitFor()
  expect(calls).toHaveLength(unknown ? 1 : 0)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

async function submissionFixture(mode: Mode = 'success') {
  const value = await fixture(true, 'automatic', mode)
  await value.page.getByRole('navigation', { name: 'Workbench', exact: true })
    .getByRole('button', { name: 'Integrations', exact: true }).click()
  await value.page.locator(`[data-office-integration="${value.connection.integrationId}"]`)
    .getByRole('button', { name: 'System details', exact: true }).click()
  const system = value.page.getByRole('dialog', { name: 'System details', exact: true })
  await system.getByRole('button', { name: 'View business actions', exact: true }).click()
  await system.getByRole('button', { name: 'Fill in business: Submit employee request', exact: true }).click()
  const form = value.page.getByRole('dialog', { name: 'Submit company business', exact: true })
  await form.getByRole('textbox', { name: 'Title', exact: true }).fill('Purchase reviewed in the workbench')
  await form.getByRole('textbox', { name: 'Reason', exact: true }).fill('Exact first line\nExact second line')
  return { ...value, form }
}

it.each(['success', 'unknown', 'fault', 'rejected'] as const)('submits a reviewed employee form and preserves the real %s outcome', async (mode) => {
  const { scaffold, page, form, calls, console } = await submissionFixture(mode)
  expect(calls).toEqual([])
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  const confirm = form.getByRole('button', { name: 'Confirm business submission', exact: true })
  await confirm.waitFor()
  expect(await form.getByText('Company Write', { exact: true }).count()).toBe(1)
  expect(await form.getByText('Submit employee request', { exact: true }).count()).toBe(1)
  expect(await form.locator('dd').allTextContents()).toEqual(['Purchase reviewed in the workbench', 'Exact first line\nExact second line'])
  expect(calls).toEqual([])
  if (mode === 'success') {
    await page.setViewportSize({ width: 900, height: 640 })
    const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
    await mkdir(shots, { recursive: true })
    await form.screenshot({ path: join(shots, 'employee-business-submission-review.png'), animations: 'disabled' })
  }
  await confirm.click()
  if (mode === 'fault') {
    await form.getByRole('button', { name: 'Retry original request', exact: true }).waitFor()
    expect(calls).toHaveLength(1)
    const original = (await scaffold.ctx.office.connectorExecutions(actor))[0]!
    expect(original.status).toBe('unknown')
    await form.getByRole('button', { name: 'Retry original request', exact: true }).click()
  }
  const receipt = form.getByRole('region', { name: 'Business submission receipt', exact: true })
  const label = mode === 'success' ? 'Succeeded' : mode === 'rejected' ? 'Definitively not accepted' : 'Outcome unknown'
  await receipt.getByRole('heading', { name: label, exact: true }).waitFor()
  expect(calls).toHaveLength(1)
  expect(calls[0]?.body).toEqual({ title: 'Purchase reviewed in the workbench', reason: 'Exact first line\nExact second line' })
  expect(await form.getByRole('button', { name: 'Confirm business submission', exact: true }).count()).toBe(0)
  if (mode === 'success') await receipt.getByText(marker, { exact: true }).waitFor()
  else expect(await receipt.getByText(marker, { exact: true }).count()).toBe(0)
  const retained = (await scaffold.ctx.office.connectorExecutions(actor))[0]!
  expect(retained.status).toBe(mode === 'success' ? 'succeeded' : mode === 'rejected' ? 'rejected' : 'unknown')
  expect(await receipt.getByText(retained.id, { exact: false }).count()).toBe(1)
  expect(await form.getByText('native-write-private-secret', { exact: false }).count()).toBe(0)
  await form.getByRole('button', { name: 'Execution records', exact: true }).click()
  await page.getByRole('dialog', { name: 'Execution records', exact: true })
    .getByRole('button', { name: `View execution: ${retained.id}`, exact: true }).waitFor()
  expect(calls).toHaveLength(1)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('closes a reviewed employee form without sending a business request', async () => {
  const { form, calls, console } = await submissionFixture()
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  await form.getByRole('button', { name: 'Back to editing', exact: true }).click()
  expect(await form.getByRole('textbox', { name: 'Title', exact: true }).inputValue()).toBe('Purchase reviewed in the workbench')
  await form.getByRole('button', { name: 'Close business submission', exact: true }).click()
  await form.waitFor({ state: 'hidden' })
  expect(calls).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('blocks a reviewed employee form when its current company connection changes', async () => {
  const { scaffold, form, calls, connection, console } = await submissionFixture()
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  await scaffold.ctx.office.saveConnection(owner, { ...connection, revision: 1, requestId: randomUUID(), enabled: false })
  await form.getByText('The reviewed connection or action changed.', { exact: false }).waitFor()
  expect(await form.getByRole('button', { name: 'Confirm business submission', exact: true }).isDisabled()).toBe(true)
  expect(calls).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('discards a reviewed employee form when the authenticated local account is replaced', async () => {
  const { scaffold, form, calls, console } = await submissionFixture()
  await form.getByRole('button', { name: 'Review submission', exact: true }).click()
  const controller = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-ui-office')!
  const warningStart = console.warnings.length
  await scaffold.ctx.configEditor.edit(controller, current => ({ ...current, principalId: 'owner' }))
  await scaffold.ctx.loader.await()
  await form.waitFor({ state: 'hidden' })
  acknowledgeReloadConnectionLoss(console, warningStart)
  expect(calls).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['success', 'unknown', 'rejected', 'fault', 'unavailable', 'connection'] as const)('checks an employee unknown receipt through a real read-only %s outcome', async (kind) => {
  const { scaffold, page, calls, checks, connection, console } = await fixture(true, 'automatic', 'unknown',
    kind === 'connection' ? 'success' : kind)
  const directory = await scaffold.ctx.office.connectorActions(actor, connection.integrationId)
  if (!directory.adapterRevision) throw new Error('Expected an active write provider')
  const original = await scaffold.ctx.office.writeConnectorAction(actor, { integrationId: connection.integrationId,
    actionId: 'submit-request', connectionRevision: 1, adapterRevision: directory.adapterRevision,
    requestId: randomUUID(), values: { title: 'Original unconfirmed request' } })
  expect(original.status).toBe('unknown')
  await page.getByRole('navigation', { name: 'Workbench', exact: true }).getByRole('button', { name: 'Integrations', exact: true }).click()
  await page.locator(`[data-office-integration="${connection.integrationId}"]`).getByRole('button', { name: 'System details', exact: true }).click()
  await page.getByRole('dialog', { name: 'System details', exact: true }).getByRole('button', { name: 'Execution records', exact: true }).click()
  await page.getByRole('dialog', { name: 'Execution records', exact: true })
    .getByRole('button', { name: `View execution: ${original.id}`, exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'Execution receipt details', exact: true })
  await detail.getByRole('heading', { name: 'Outcome unknown', exact: true }).waitFor()
  if (kind === 'connection') await scaffold.ctx.office.saveConnection(owner, { ...connection, revision: 1,
    requestId: randomUUID(), probePath: 'changed-before-outcome-check' })
  await detail.getByRole('button', { name: 'Check customer outcome', exact: true }).click()
  if (kind === 'success') {
    await detail.getByRole('heading', { name: 'Succeeded', exact: true }).waitFor()
    await detail.getByText(marker, { exact: true }).waitFor()
  } else if (kind === 'rejected') await detail.getByRole('heading', { name: 'Definitively not accepted', exact: true }).waitFor()
  else if (kind === 'fault') await detail.getByRole('alert').waitFor()
  else await detail.getByRole('status').waitFor()
  const stored = await scaffold.ctx.office.connectorExecutionDetail(actor, original.id)
  expect(stored.status).toBe(kind === 'success' ? 'succeeded' : kind === 'rejected' ? 'rejected' : 'unknown')
  expect(calls).toHaveLength(1)
  expect(checks).toEqual(kind === 'unavailable' || kind === 'connection' ? [] : [{ employee: actor, id: original.id }])
  expect(await detail.getByText('native-write-private-secret', { exact: false }).count()).toBe(0)
  expect(await detail.getByText('Private checker diagnostic', { exact: false }).count()).toBe(0)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
