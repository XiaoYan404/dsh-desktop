/** Keyless model replies exercise native discovery, approval, real HTTP business reads and durable model-visible tool results. */
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
import { acknowledgeReloadConnectionLoss, launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, writeComposerDraft } from './support.ts'

const actor = 'local' as OfficeMemberId
const owner = 'owner' as OfficeMemberId
const marker = 'ACTUAL_COMPANY_EMPLOYEE_QUERY_RESULT'
const reply = 'OFFICE_QUERY_TURN_FINISHED'
const provider = 'office-business-query-test'

class QueryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly readArgs: { system: string; action_id: string; connection_revision: number; adapter_revision: string }) {
    super()
  }
  override async listModels(name: string) { return [{ provider: name, id: 'query', name: 'Office query fixture' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const index = this.requests.length
    if (index <= 2) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`office-query-${index}`),
        name: index === 1 ? 'office_list_actions' : 'office_read_action',
        arguments: JSON.stringify(index === 1 ? { system: this.readArgs.system } : this.readArgs) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(selected: boolean, approval: 'manual' | 'automatic' = 'manual', fault = false) {
  const scaffold = await launchWebScaffold({ profile: { packages: [] },
    extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const origin = new URL(scaffold.baseUrl).origin
  const service = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-enterprise-office')!
  const tool = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'tool-office')!
  const ref = credentialRef('OFFICE_QUERY_' + randomUUID().replaceAll('-', '').toUpperCase())
  await scaffold.ctx.credentials.set(ref, 'native-query-private-secret')
  await scaffold.ctx.configEditor.edit(service, current => ({ ...current,
    connectorAllowedOrigins: [origin], connectorCredentials: { 'query-key': ref },
  }))
  await scaffold.ctx.configEditor.edit(tool, current => ({ ...current, readApproval: approval }))
  await scaffold.ctx.loader.await()
  if (!tool.fiber) throw new Error('Office query tools did not activate')
  await tool.fiber.await()
  expect(tool.fiber.state).toBe(2)
  const calls: { employee: string; authorization: string }[] = []
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'exact', path: '/test-native-office-query',
    handler(request, response) {
      expect(request.method).toBe('GET')
      calls.push({ employee: String(request.headers['x-office-employee']), authorization: String(request.headers.authorization) })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ summary: marker, entries: [{ label: 'Employee', value: request.headers['x-office-employee'] }] }))
    },
  }))
  scaffold.ctx.effect(() => scaffold.ctx.office.registerConnector({ id: 'native-query', actions: [
    { id: 'read-own', label: 'Read employee records', description: 'Current employee records', kind: 'read', allowedRoles: ['employee'] },
    { id: 'admin-report', label: 'Admin report', description: '', kind: 'read', allowedRoles: ['admin'] },
    { id: 'write-record', label: 'Write record', description: '', kind: 'write', allowedRoles: ['employee'] },
  ], async probe() { throw new Error('Native queries must not probe') }, async read(request) {
    if (fault) throw new Error(`Private adapter diagnostic: ${request.headers.authorization}`)
    const response = await fetch(new URL('test-native-office-query', request.baseUrl), { method: 'GET',
      headers: { ...request.headers, 'x-office-employee': request.member.id }, signal: request.signal, redirect: 'manual' })
    const data: unknown = await response.json()
    return { status: 'read', data: z.object({ summary: z.string(),
      entries: z.array(z.object({ label: z.string(), value: z.string() })) }).parse(data) }
  } }))
  const integration = await scaffold.ctx.office.importIntegration(owner, { requestId: randomUUID(), json: JSON.stringify({
    name: 'company-query', system: 'Company Query', version: '1', provider: 'Company', description: 'Employee system query',
    capabilities: ['Read employee records'],
  }) })
  const connection = { integrationId: integration.id, revision: 0, requestId: randomUUID(), adapterId: 'native-query',
    baseUrl: origin + '/', probePath: 'test-native-office-query', enabled: true,
    authentication: { kind: 'bearer' as const, credential: 'query-key' } }
  await scaffold.ctx.office.saveConnection(owner, connection)
  const directory = await scaffold.ctx.office.connectorActions(actor, integration.id)
  if (!directory.adapterRevision) throw new Error('Expected an active query provider')
  const adapter = new QueryAdapter({ system: integration.system, action_id: 'read-own', connection_revision: 1,
    adapter_revision: directory.adapterRevision })
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'query' })
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
  await writeComposerDraft(page, input, 'Query my own records in the associated Company Query system.')
  return { scaffold, page, console, input, conversationId, adapter, calls, connection, tool }
}

it('keeps unexpected credential-bearing adapter diagnostics out of native model input and persisted tool results', async () => {
  const { scaffold, page, console, input, adapter, calls } = await fixture(true, 'automatic', true)
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor()
  expect(adapter.requests).toHaveLength(3)
  const events = await readPersistedEvents(scaffold, id)
  const results = events.filter(event => event.type === 'tool/result')
  expect(results[1]?.data.message.isError).toBe(true)
  expect(JSON.stringify(events)).not.toContain('native-query-private-secret')
  expect(JSON.stringify(adapter.requests[2]?.messages)).not.toContain('native-query-private-secret')
  expect(results[1]?.data.error?.code).toBe('OFFICE_SERVICE_UNAVAILABLE')
  expect(calls).toEqual([])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each([true, false])('offers native company queries only for a submitted configured association: %s', async (selected) => {
  const { scaffold, page, console, input, conversationId, adapter, calls } = await fixture(selected, 'automatic')
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const id = await settled
  await page.getByText(reply, { exact: true }).waitFor()
  expect(adapter.requests).toHaveLength(3)
  const names = adapter.requests[0]?.tools?.map(tool => tool.name) ?? []
  expect(names.includes('office_list_actions')).toBe(selected)
  expect(names.includes('office_read_action')).toBe(selected)
  expect(names).not.toContain('office_create_work')
  expect(names).toContain('write')
  const events = await readPersistedEvents(scaffold, id)
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(2)
  for (const result of results) expect(result.data.message.isError).toBe(!selected)
  if (selected) {
    expect(calls).toEqual([{ employee: actor, authorization: 'Bearer native-query-private-secret' }])
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('read-own')
    expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('admin-report')
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain(marker)
    expect(JSON.stringify(events)).toContain(marker)
    expect(JSON.stringify(events)).not.toMatch(/native-query-private-secret|query-key|test-native-office-query/)
    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
    await page.getByText(reply, { exact: true }).waitFor()
    acknowledgeReloadConnectionLoss(console, warningStart)
    expect(await readPersistedEvents(scaffold, id)).toEqual(events)
    expect(adapter.requests).toHaveLength(3)
  } else expect(calls).toEqual([])
  const agent = scaffold.ctx.agents.get(SessionId(conversationId))
  if (!agent) throw new Error('Native query Agent disappeared')
  expect(scaffold.ctx.tools.get('office_list_actions', agent)).toBeUndefined()
  expect(scaffold.ctx.tools.get('office_read_action', agent)).toBeUndefined()
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['allow', 'reject', 'revoke', 'connection', 'role', 'unload'] as const)('reviews native company reads and rechecks authority: %s', async (action) => {
  const { scaffold, page, console, input, conversationId, adapter, calls, connection, tool } = await fixture(true)
  await input.press('Enter')
  const panel = page.locator('[data-approval-key]')
  await panel.waitFor({ timeout: 20_000 })
  expect(adapter.requests).toHaveLength(2)
  expect(calls).toEqual([])
  const text = await panel.innerText()
  expect(text).toContain('Read company system records')
  expect(text).toContain('System: "Company Query"\nRegistration: "company-query"\nAction: "read-own"\nEmployee: "local"')
  expect(text).toContain('Connection version: 1\nProvider version: "')
  if (action === 'allow') {
    const other = await scaffold.ctx.agents.create({ sessionId: SessionId(`query-other-${randomUUID()}`),
      meta: { cwd: scaffold.workspaceCwd }, setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined) })
    onTestFinished(() => other.dispose())
    expect(scaffold.ctx.tools.get('office_read_action', other.agent)).toBeUndefined()
    expect(scaffold.ctx.tools.get('write', other.agent)).toBeDefined()
    const shots = join(REPO_ROOT, '.artifacts', 'enterprise-office')
    await mkdir(shots, { recursive: true })
    await panel.screenshot({ path: join(shots, 'native-company-query-approval.png') })
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
