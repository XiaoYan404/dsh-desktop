/** Real Loader, private credential store and local HTTP systems exercise connection admission and outcomes. */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { listenHttp } from '@deepseek-ai/dsh-host-webserver'
import { brandString } from '@deepseek-ai/dsh-brand'
import OfficeService, { executeOfficeRequest } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { OfficeConnectorActionDeclaration, OfficeConnectorInput, OfficeConnectorReadInput,
  OfficeConversationId, OfficeMemberId } from '../src/types.ts'
import type { OfficeConnectorReadRequest, OfficeConnectorReadResult } from '../src/connector-http.ts'
import type { OfficeConnectorAdapter, OfficeConnectorWriteRequest, OfficeConnectorWriteResult } from '../src/connector-http.ts'
import type { OfficeConnectorWriteInput } from '../src/types.ts'
import { officeConnectorExecutionDomain } from '../src/connector-executions.ts'
import { OfficeConnectorRepository, resolveOfficeConnectorPolicy } from '../src/connectors.ts'
import { connectorReadResultSchema } from '../src/connector-actions.ts'
import type { OfficeConnectorSyncInput } from '../src/types.ts'
import { officeConnectorSyncDomain } from '../src/connector-syncs.ts'
import { createDingTalkAdapter } from '../src/dingtalk.ts'
import { createWeComAdapter } from '../src/wecom.ts'
import { officeWeComMessageDomain } from '../src/wecom-messages.ts'
import { officeDingTalkMessageDomain, OfficeDingTalkMessageRepository } from '../src/dingtalk-messages.ts'

const administrator = brandString<OfficeMemberId>('admin')
const employee = brandString<OfficeMemberId>('lin')
const contexts: Context[] = []
const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const seed: Config = { companyName: 'Connector test company', timeZone: 'Asia/Shanghai', members: [
  { id: administrator, name: 'Admin', department: 'Office', jobTitle: 'Admin', role: 'admin' },
  { id: employee, name: 'Lin', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
] }

async function system(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  const port = await listenHttp(server, { host: '127.0.0.1', port: 0, maxAttempts: 16 })
  return `http://127.0.0.1:${port}`
}

async function boot(overrides: Partial<Config> = {}, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-office-connector-'))
  if (!existingRoot) roots.push(root)
  const ref = 'OFFICE_TEST_' + randomUUID().replaceAll('-', '').toUpperCase()
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'data') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-credentials-local', config: { dshHome: root, watch: false } },
    { name: '@deepseek-ai/dsh-enterprise-office', config: { ...seed, dshHome: root,
      connectorCredentials: { 'oa-key': ref }, ...overrides } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
    ['@deepseek-ai/dsh-enterprise-office', OfficeService],
  ])
  const internal = ctx.loader.internal
  if (!internal) throw new Error('The connector fixture requires the Node Loader')
  ctx.loader.internal = new Proxy(internal, { get(target, key) {
    if (key === 'import') return async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error('Unexpected connector fixture module')
      return modules.get(specifier)
    }
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Office connector fixture did not activate')
  return { ctx, root, ref }
}

async function configuration(ctx: Context, origin: string): Promise<OfficeConnectorInput> {
  const integration = await ctx.office.importIntegration(administrator, { requestId: randomUUID(), json: JSON.stringify({
    name: 'company-oa', system: 'OA', version: '1.0.0', provider: 'Company', description: 'Office read adapter',
    capabilities: ['Query approvals'],
  }) })
  return { integrationId: integration.id, revision: 0, requestId: randomUUID(), adapterId: 'http-json',
    baseUrl: origin + '/api/', probePath: 'health', authentication: { kind: 'bearer', credential: 'oa-key' }, enabled: true }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((done, reject) => server.close((error) => {
      if (error) reject(error)
      else done()
    }))
  }
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-connector-'))
      throw new Error('Unexpected connector fixture directory')
    await rm(absolute, { recursive: true, force: true })
  }
})

describe('WeCom reviewed message submission', () => {
  const wecom: NonNullable<Config['wecom']> = { corpId: 'message-corp', agentId: 1000003,
    members: { lin: 'Lin-Work' }, actions: ['send_message'] }
  async function prepared(overrides: Partial<Config> = {}) {
    const calls: { method: string; path: string; query: Record<string, string>; body: unknown; authorization: string }[] = []
    const accepted: string[] = []
    const state: { mode: 'accepted' | 'lost' | 'denied' | 'limited' | 'invalid' | 'unlicensed' | 'malformed' | 'foreign' }
      = { mode: 'accepted' }
    const origin = await system((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://fixture')
        const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
        calls.push({ method: request.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams),
          body, authorization: request.headers.authorization ?? '' })
        response.setHeader('content-type', 'application/json')
        if (url.pathname.endsWith('/gettoken')) {
          response.end(JSON.stringify({ errcode: 0, access_token: 'wecom-message-private-token', expires_in: 7200 })); return
        }
        const parsed = z.object({ touser: z.literal('Lin-Work'), msgtype: z.literal('text'), agentid: z.literal(1000003),
          text: z.object({ content: z.string() }).strict(), enable_id_trans: z.literal(0), enable_duplicate_check: z.literal(0),
        }).strict().safeParse(body)
        if (request.method !== 'POST' || url.pathname !== '/api/cgi-bin/message/send' || !parsed.success) {
          response.writeHead(400); response.end('{}'); return
        }
        if (state.mode === 'denied' || state.mode === 'limited') {
          response.end(JSON.stringify({ errcode: state.mode === 'denied' ? 81013 : 45009, errmsg: 'PRIVATE_VENDOR_REASON' })); return
        }
        if (state.mode === 'invalid' || state.mode === 'unlicensed' || state.mode === 'foreign') {
          response.end(JSON.stringify({ errcode: 0, ...state.mode === 'unlicensed' ? { unlicenseduser: 'lin-work' }
            : { invaliduser: state.mode === 'invalid' ? 'lin-work' : 'foreign-user' } })); return
        }
        accepted.push(parsed.data.text.content)
        if (state.mode === 'lost') { response.destroy(); return }
        response.end(JSON.stringify(state.mode === 'malformed' ? { errcode: 0 } : { errcode: 0, msgid: `wecom-msg-${accepted.length}` }))
      })
    })
    const value = await boot({ wecom, connectorAllowedOrigins: [origin], ...overrides })
    await value.ctx.credentials.set(credentialRef(value.ref), 'wecom-message-corp-secret')
    const connection = { ...await configuration(value.ctx, origin), adapterId: 'wecom', probePath: 'cgi-bin/gettoken' }
    await value.ctx.office.saveConnection(administrator, connection)
    const directory = await value.ctx.office.connectorActions(employee, connection.integrationId)
    if (!directory.adapterRevision) throw new Error('WeCom message actions are unavailable')
    const input: OfficeConnectorWriteInput = { integrationId: connection.integrationId, connectionRevision: 1,
      adapterRevision: directory.adapterRevision, actionId: 'wecom-send-message', requestId: randomUUID(),
      values: { content: 'WECOM_PRIVATE_MESSAGE\nReview my daily work.' } }
    return { ...value, origin, calls, accepted, state, input }
  }

  it('sends only reviewed UTF-8-bounded self messages and recovers an outer receipt failure from the provider without another POST', async () => {
    const { ctx, root, calls, accepted, input } = await prepared()
    expect(await ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID(), values: { content: '界'.repeat(683) } }))
      .toMatchObject({ status: 'rejected', rejection: 'invalid_input' })
    await expect(ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID(), values: { content: '   ' } }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID(),
      values: { ...input.values, touser: '@all' } })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await ctx.office.writeConnectorAction(administrator, { ...input, requestId: randomUUID() }))
      .toMatchObject({ status: 'rejected', rejection: 'denied' })
    expect(calls).toEqual([])
    const first = await ctx.office.writeConnectorAction(employee, input)
    expect(first).toMatchObject({ status: 'succeeded', result: { summary: '企业微信已受理本人消息投递，不代表已送达',
      entries: [{ label: '消息标识', value: 'wecom-msg-1' }] } })
    expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(first)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/cgi-bin/gettoken', authorization: '',
      query: { corpid: wecom.corpId, corpsecret: 'wecom-message-corp-secret' } })
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/cgi-bin/message/send', authorization: '',
      query: { access_token: 'wecom-message-private-token' }, body: { touser: 'Lin-Work', agentid: wecom.agentId,
        msgtype: 'text', text: input.values, enable_id_trans: 0, enable_duplicate_check: 0 } })
    const executionDomain = ctx.storageDomain.get(officeConnectorExecutionDomain.name)!
    const set = executionDomain.global.set.bind(executionDomain.global)
    let writes = 0
    const spy = vi.spyOn(executionDomain.global, 'set').mockImplementation(async (value) => {
      if (++writes === 3) throw new Error('Outer WeCom receipt unavailable')
      await set(value)
    })
    const next = { ...input, requestId: randomUUID() }
    await expect(ctx.office.writeConnectorAction(employee, next)).rejects.toMatchObject({ code: 'execution_unknown' })
    spy.mockRestore()
    const original = (await ctx.office.connectorExecutions(employee)).find(row => row.requestId === next.requestId)
    if (!original) throw new Error('Original WeCom execution is missing')
    const checked = await ctx.office.checkConnectorExecution(employee, original.id)
    expect(checked).toMatchObject({ status: 'updated', receipt: { status: 'succeeded' } })
    expect(await ctx.office.writeConnectorAction(employee, next)).toEqual(checked.receipt)
    expect(calls).toHaveLength(3)
    expect(accepted).toEqual([input.values.content, input.values.content])
    const stored = await readFile(join(root, 'data/enterprise_office_wecom_messages.json'), 'utf8')
    for (const privateValue of ['WECOM_PRIVATE_MESSAGE', 'Lin-Work', 'wecom-message-corp-secret', 'wecom-message-private-token'])
      expect(stored).not.toContain(privateValue)
  })

  it('retains lost delivery acknowledgements across restart and refuses detached directory recovery without another request', async () => {
    const { ctx, root, ref, origin, calls, accepted, state, input } = await prepared()
    state.mode = 'lost'
    const first = await ctx.office.writeConnectorAction(employee, input)
    expect(first.status).toBe('unknown')
    expect(accepted).toEqual([input.values.content])
    await ctx.fiber.dispose()
    const restored = await boot({ wecom, connectorAllowedOrigins: [origin], connectorCredentials: { 'oa-key': ref } }, root)
    expect(await restored.ctx.office.writeConnectorAction(employee, input)).toEqual(first)
    expect(await restored.ctx.office.checkConnectorExecution(employee, first.id)).toMatchObject({ status: 'unknown', receipt: first })
    expect(calls).toHaveLength(2)
    await restored.ctx.fiber.dispose()
    const outbox = join(root, 'data/enterprise_office_wecom_messages.json')
    const bytes = await readFile(outbox)
    const main = join(root, 'data/enterprise_office.json')
    const document = z.looseObject({ global: z.unknown() }).parse(JSON.parse(await readFile(main, 'utf8')))
    const reset = JSON.stringify({ ...document, global: null })
    await writeFile(main, reset)
    await expect(boot({ wecom }, root)).rejects.toThrow()
    expect(await readFile(outbox)).toEqual(bytes)
    expect(await readFile(main, 'utf8')).toBe(reset)
  })

  it('admits no network after reservation failure or capacity and distinguishes explicit recipient failures from uncertain acknowledgements', async () => {
    const value = await prepared({ wecomMessageMaxEntries: 1 })
    const domain = value.ctx.storageDomain.get(officeWeComMessageDomain.name)!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('WeCom marker disk unavailable'))
    expect((await value.ctx.office.writeConnectorAction(employee, value.input)).status).toBe('unknown')
    expect(value.calls).toEqual([])
    expect(await value.ctx.office.writeConnectorAction(employee, { ...value.input, requestId: randomUUID(),
      values: { content: 'Second independently reviewed reminder' } }))
      .toMatchObject({ status: 'succeeded' })
    expect(await value.ctx.office.writeConnectorAction(employee, { ...value.input, requestId: randomUUID(),
      values: { content: 'Third reminder after capacity' } }))
      .toMatchObject({ status: 'rejected', rejection: 'not_accepted' })
    expect(value.calls).toHaveLength(2)
    const other = await prepared()
    for (const [mode, status, rejection] of [['denied', 'rejected', 'denied'], ['limited', 'rejected', 'rate_limited'],
      ['invalid', 'rejected', 'invalid_input'], ['unlicensed', 'rejected', 'denied'], ['foreign', 'unknown', undefined],
      ['malformed', 'unknown', undefined]] as const) {
      other.state.mode = mode
      const result = await other.ctx.office.writeConnectorAction(employee, { ...other.input, requestId: randomUUID(),
        values: { content: `Independently reviewed ${mode} reminder` } })
      expect(result).toMatchObject({ status })
      expect(result.rejection).toBe(rejection)
      expect(result.result).toBeUndefined()
    }
    expect(other.calls.filter(call => call.method === 'POST')).toHaveLength(6)
    expect(other.calls.filter(call => call.path.endsWith('/gettoken'))).toHaveLength(1)
  })
})

describe('WeCom internal-app authentication and private profile', () => {
  const wecom: NonNullable<Config['wecom']> = { corpId: 'company-corp', agentId: 1000002,
    members: { lin: 'Lin-Work' }, actions: ['profile'] }
  async function prepared() {
    const calls: { method: string; path: string; query: Record<string, string>; authorization: string }[] = []
    let mode: 'valid' | 'invalid_token' | 'wrong_user' | 'limited' | 'redirect' | 'large' | 'invalid' | 'timeout' = 'valid'
    const origin = await system((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fixture')
      calls.push({ method: request.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams),
        authorization: request.headers.authorization ?? '' })
      response.setHeader('content-type', 'application/json')
      if (url.pathname.endsWith('/gettoken')) {
        response.end(JSON.stringify({ errcode: 0, access_token: 'private-wecom-token', expires_in: 7200 })); return
      }
      if (mode === 'invalid_token' || mode === 'limited') {
        response.end(JSON.stringify({ errcode: mode === 'invalid_token' ? 40014 : 45009, errmsg: 'PRIVATE_DIAGNOSTIC' })); return
      }
      if (mode === 'redirect') { response.writeHead(302, { location: origin + '/must-not-follow' }); response.end(); return }
      if (mode === 'large') { response.end(JSON.stringify({ padding: '界'.repeat(10000) })); return }
      if (mode === 'invalid') { response.end('{ invalid JSON'); return }
      if (mode === 'timeout') { response.write('{'); return }
      response.end(JSON.stringify({ errcode: 0, userid: mode === 'wrong_user' ? 'other-employee' : 'lin-work', name: 'Lin Work',
        position: 'Operations specialist', mobile: 'PRIVATE_PHONE', email: 'PRIVATE_EMAIL', department: [12345] }))
    })
    const value = await boot({ wecom, connectorAllowedOrigins: [origin], connectorTimeoutMs: 200, connectorMaxResponseBytes: 4096 })
    const connection = { ...await configuration(value.ctx, origin), adapterId: 'wecom', probePath: 'cgi-bin/gettoken' }
    await value.ctx.office.saveConnection(administrator, connection)
    await value.ctx.credentials.set(credentialRef(value.ref), 'private-corp-secret-one')
    const directory = await value.ctx.office.connectorActions(employee, connection.integrationId)
    if (!directory.adapterRevision) throw new Error('WeCom action directory is unavailable')
    const input = { integrationId: connection.integrationId, connectionRevision: 1,
      adapterRevision: directory.adapterRevision, actionId: 'wecom-profile' }
    return { ...value, calls, connection, input, changeMode: (value: typeof mode) => { mode = value } }
  }

  it('caches official tokens, follows credential rotation and explicit invalidation, and synchronizes only the mapped private profile', async () => {
    const { ctx, ref, root, calls, input, connection, changeMode } = await prepared()
    const read = await ctx.office.readConnectorAction(employee, input)
    expect(read).toMatchObject({ status: 'read', data: { summary: '企业微信本人资料', entries: [
      { label: '姓名', value: 'Lin Work' }, { label: '岗位', value: 'Operations specialist' },
    ] } })
    expect(calls).toEqual([
      { method: 'GET', path: '/api/cgi-bin/gettoken', query: { corpid: wecom.corpId, corpsecret: 'private-corp-secret-one' }, authorization: '' },
      { method: 'GET', path: '/api/cgi-bin/user/get', query: { access_token: 'private-wecom-token', userid: 'Lin-Work' }, authorization: '' },
    ])
    await ctx.office.readConnectorAction(employee, input)
    expect(calls).toHaveLength(3)
    expect((await ctx.office.probeConnection(administrator, connection.integrationId, 1)).status).toBe('connected')
    expect(calls).toHaveLength(4)
    await ctx.credentials.set(credentialRef(ref), 'private-corp-secret-two')
    await ctx.office.readConnectorAction(employee, input)
    expect(calls).toHaveLength(6)
    expect(calls[4]?.query.corpsecret).toBe('private-corp-secret-two')
    changeMode('invalid_token')
    expect((await ctx.office.readConnectorAction(employee, input)).status).toBe('unauthorized')
    expect(calls).toHaveLength(7)
    changeMode('valid')
    await ctx.office.readConnectorAction(employee, input)
    expect(calls).toHaveLength(9)
    expect((await ctx.office.readConnectorAction(administrator, input)).status).toBe('unauthorized')
    expect(calls).toHaveLength(9)
    const syncInput = { ...input, requestId: randomUUID() }
    const sync = await ctx.office.syncConnectorAction(employee, syncInput)
    expect(await ctx.office.syncConnectorAction(employee, syncInput)).toEqual(sync)
    expect(calls).toHaveLength(10)
    const stored = await readFile(join(root, 'data/enterprise_office_connector_syncs.json'), 'utf8')
    for (const secret of ['private-corp-secret', 'private-wecom-token', 'PRIVATE_PHONE', 'PRIVATE_EMAIL', 'Lin-Work', 'PRIVATE_DIAGNOSTIC']) {
      expect(stored).not.toContain(secret)
      expect(JSON.stringify([read, sync])).not.toContain(secret)
    }
  })

  it('expires the process cache and bounds identity mismatches, vendor errors, redirects, bodies and aborted reads without implicit retries', async () => {
    const { ctx, calls, input, changeMode } = await prepared()
    await ctx.office.readConnectorAction(employee, input)
    const at = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 7200000)
    await ctx.office.readConnectorAction(employee, input)
    expect(calls.filter(call => call.path.endsWith('/gettoken'))).toHaveLength(2)
    clock.mockRestore()
    for (const [mode, status] of [['wrong_user', 'invalid_response'], ['limited', 'rate_limited'], ['redirect', 'http_error'],
      ['large', 'invalid_response'], ['invalid', 'invalid_response'], ['timeout', 'timed_out']] as const) {
      changeMode(mode)
      const before = calls.length
      const result = await ctx.office.readConnectorAction(employee, input)
      expect(result.status).toBe(status)
      expect(result).not.toHaveProperty('data')
      expect(JSON.stringify(result)).not.toContain('PRIVATE_DIAGNOSTIC')
      expect(calls).toHaveLength(before + 1)
    }
    expect(calls.some(call => call.path.includes('must-not-follow'))).toBe(false)
  })

  it('rejects ambiguous recipient mappings, stays disabled by default and disposes registrations with their owning fiber', async () => {
    for (const members of [{ lin: 'Same', admin: 'same' }, { lin: '@ALL' }, { lin: 'lin|admin' }, { lin: '界'.repeat(22) }])
      expect(() => createWeComAdapter({ ...wecom, members })).toThrow()
    const { ctx } = await boot()
    expect((await ctx.office.connections(employee)).adapters).not.toContain('wecom')
    const handle = createWeComAdapter(wecom)
    const fiber = ctx.plugin({ name: 'wecom-lifecycle-fixture', inject: ['office'], apply(scope: Context) {
      scope.effect(() => { const stop = scope.office.registerConnector(handle.adapter); return () => { stop(); handle.close() } })
    } })
    await fiber
    expect((await ctx.office.connections(employee)).adapters).toContain('wecom')
    const fetch = vi.spyOn(globalThis, 'fetch')
    const lifetime = { signal: new AbortController().signal, maxResponseBytes: 4096 }
    expect(await handle.adapter.probe({ ...lifetime, url: 'https://qyapi.weixin.qq.com/unrelated', headers: {} }))
      .toEqual({ status: 'invalid_response' })
    expect(await handle.adapter.read!({ ...lifetime, actionId: 'wecom-profile', member: { id: administrator, role: 'admin' },
      baseUrl: 'https://qyapi.weixin.qq.com/', headers: { authorization: 'Bearer secret' }, maxEntries: 2 }))
      .toEqual({ status: 'unauthorized' })
    await fiber.dispose()
    expect((await ctx.office.connections(employee)).adapters).not.toContain('wecom')
    expect(await handle.adapter.probe({ ...lifetime, url: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
      headers: { authorization: 'Bearer secret' } })).toEqual({ status: 'timed_out' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('DingTalk private message provider outbox', () => {
  const actor = { id: employee, role: 'employee' as const }
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const binding = digest('approved app, current employee mapping and endpoint')
  const content = digest('Reviewed private message\nNever store this plaintext in the provider outbox')
  const executionId = () => brandString<import('../src/types.ts').OfficeConnectorExecutionId>(randomUUID())
  const confirmed: OfficeConnectorWriteResult & { readonly status: 'succeeded' } = { status: 'succeeded',
    result: { summary: 'Vendor accepted delivery', entries: [{ label: 'Process query key', value: 'provider-receipt-1' }] } }
  function repository(ctx: Context, limits = { maxEntries: 1000, maxBytes: 16777216 }) {
    const domain = ctx.storageDomain.get(officeDingTalkMessageDomain.name) as Domain<typeof officeDingTalkMessageDomain>
    const value = new OfficeDingTalkMessageRepository(domain, limits, (employee) => {
      if (ctx.office.view(employee.id).me.role !== employee.role) throw new Error('Employee role changed')
    })
    return { value, domain }
  }

  it('reserves one concurrent dispatch and restores exact private outcomes after restart without storing raw message inputs', async () => {
    const { ctx, root } = await boot()
    const { value } = repository(ctx)
    const id = executionId()
    const results = await Promise.all([value.reserve(actor, id, binding, content), value.reserve(actor, id, binding, content)])
    expect(results).toEqual([{ dispatch: true }, { dispatch: false, result: { status: 'unknown' } }])
    expect(await value.settle(actor, id, binding, content, confirmed)).toEqual(confirmed)
    expect(await value.reserve(actor, id, binding, content)).toEqual({ dispatch: false, result: confirmed })
    await expect(value.reserve(actor, id, binding, digest('different review'))).rejects.toMatchObject({ code: 'conflict' })
    await expect(value.lookup({ id: administrator, role: 'admin' }, id, binding)).rejects.toMatchObject({ code: 'not_found' })
    expect(await value.lookup(actor, id, digest('different app or recipient'))).toEqual({ status: 'unknown' })
    const path = join(root, 'data/enterprise_office_dingtalk_messages.json')
    const bytes = await readFile(path, 'utf8')
    expect(bytes).not.toContain('Never store this plaintext')
    expect(bytes).not.toContain('approved app')
    await value.close()
    await ctx.fiber.dispose()
    const restarted = await boot({}, root)
    const recovered = repository(restarted.ctx).value
    expect(await recovered.lookup(actor, id, binding, content)).toEqual(confirmed)
    expect(await recovered.reserve(actor, id, binding, content)).toEqual({ dispatch: false, result: confirmed })
    expect(await readFile(path, 'utf8')).toBe(bytes)
    await recovered.close()
  })

  it('keeps failed reservations unpublished and retains unknown after acknowledgement persistence fails', async () => {
    const { ctx, root } = await boot()
    const { value, domain } = repository(ctx)
    const first = executionId()
    await value.reserve(actor, first, binding, content)
    const path = join(root, 'data/enterprise_office_dingtalk_messages.json')
    const original = await readFile(path)
    const id = executionId()
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Outbox disk unavailable'))
    await expect(value.reserve(actor, id, binding, content)).rejects.toThrow('Outbox disk unavailable')
    expect(await value.lookup(actor, id, binding)).toBeNull()
    expect(await readFile(path)).toEqual(original)
    await value.reserve(actor, id, binding, content)
    const reserved = await readFile(path)
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Acknowledgement disk unavailable'))
    await expect(value.settle(actor, id, binding, content, confirmed)).rejects.toThrow('Acknowledgement disk unavailable')
    expect(await value.lookup(actor, id, binding)).toEqual({ status: 'unknown' })
    expect(await value.reserve(actor, id, binding, content)).toEqual({ dispatch: false, result: { status: 'unknown' } })
    expect(await readFile(path)).toEqual(reserved)
    await value.close()
  })

  it('refuses recovery without the original employee directory instead of replacing retained message reservations', async () => {
    const { ctx, root } = await boot()
    const { value } = repository(ctx)
    await value.reserve(actor, executionId(), binding, content)
    const outbox = join(root, 'data/enterprise_office_dingtalk_messages.json')
    const bytes = await readFile(outbox)
    await value.close()
    await ctx.fiber.dispose()
    const main = join(root, 'data/enterprise_office.json')
    const document = z.looseObject({ global: z.unknown() }).parse(JSON.parse(await readFile(main, 'utf8')))
    const reset = JSON.stringify({ ...document, global: null })
    await writeFile(main, reset)
    await expect(boot({}, root)).rejects.toThrow()
    expect(await readFile(outbox)).toEqual(bytes)
    expect(await readFile(main, 'utf8')).toBe(reset)
  })

  it('drains accepted reservation writes on close and withdraws late results after an actual role change', async () => {
    const { ctx } = await boot()
    const { value, domain } = repository(ctx)
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const set = domain.global.set.bind(domain.global)
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (input) => {
      entered.resolve(undefined)
      await released.promise
      await set(input)
    })
    const id = executionId()
    const reserved = value.reserve(actor, id, binding, content)
    await entered.promise
    const previous = ctx.office.view(employee).me
    await ctx.office.saveMember(administrator, { ...previous, role: 'manager' }, previous)
    const closed = value.close()
    released.resolve(undefined)
    await expect(reserved).rejects.toThrow('Employee role changed')
    await closed
    expect(domain.global.get().entries).toHaveLength(1)
    expect(domain.global.get().entries[0]?.result).toEqual({ status: 'unknown' })
    await expect(value.reserve(actor, id, binding, content)).rejects.toMatchObject({ code: 'closed' })
  })

  it('preserves retries at capacity and refuses oversized acknowledgement bytes without losing the reservation', async () => {
    const { ctx, root } = await boot()
    const { value } = repository(ctx, { maxEntries: 1, maxBytes: 1024 })
    const id = executionId()
    await value.reserve(actor, id, binding, content)
    const path = join(root, 'data/enterprise_office_dingtalk_messages.json')
    const bytes = await readFile(path)
    await expect(value.reserve(actor, executionId(), binding, content)).rejects.toMatchObject({ code: 'context_too_large' })
    await expect(value.settle(actor, id, binding, content, { status: 'succeeded',
      result: { summary: '界'.repeat(500), entries: [] } })).rejects.toMatchObject({ code: 'context_too_large' })
    expect(await readFile(path)).toEqual(bytes)
    expect(await value.reserve(actor, id, binding, content)).toEqual({ dispatch: false, result: { status: 'unknown' } })
    await value.settle(actor, id, binding, content, confirmed)
    expect(await value.reserve(actor, id, binding, content)).toEqual({ dispatch: false, result: confirmed })
    await value.close()
    await expect(value.lookup(actor, id, binding)).rejects.toMatchObject({ code: 'closed' })
  })
})

describe('DingTalk reviewed message submission', () => {
  const dingtalk: NonNullable<Config['dingtalk']> = { appKey: 'message-app-key', robotCode: 'company-robot',
    actions: ['send_message'], members: { lin: { unionId: 'union-lin', userId: 'staff-lin' } } }
  async function prepared(overrides: Partial<Config> = {}) {
    const calls: { method: string; path: string; body: string; token: string; authorization: string }[] = []
    const accepted: string[] = []
    const state = { mode: 'accepted' as 'accepted' | 'lost' | 'filtered' | 'limited' | 'invalid' | 'malformed' }
    const shape = z.object({ robotCode: z.literal('company-robot'), userIds: z.tuple([z.literal('staff-lin')]),
      msgKey: z.literal('sampleMarkdown'), msgParam: z.string() }).strict()
    const origin = await system((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (value: Buffer) => { chunks.push(value) })
      request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://fixture').pathname
        const body = Buffer.concat(chunks).toString('utf8')
        calls.push({ method: request.method ?? '', path, body, token: String(request.headers['x-acs-dingtalk-access-token'] ?? ''),
          authorization: request.headers.authorization ?? '' })
        response.setHeader('content-type', 'application/json')
        if (path.endsWith('/oauth2/accessToken')) {
          response.end(JSON.stringify({ accessToken: 'message-private-token', expireIn: 7200 })); return
        }
        if (request.method !== 'POST' || path !== '/api/v1.0/robot/oToMessages/batchSend') {
          response.writeHead(404); response.end('{}'); return
        }
        const parsed = shape.safeParse(JSON.parse(body))
        if (!parsed.success) { response.writeHead(400); response.end('{}'); return }
        if (state.mode === 'filtered') { response.end(JSON.stringify({ filteredStaffIdList: ['staff-lin'] })); return }
        if (state.mode === 'limited') { response.end(JSON.stringify({ flowControlledStaffIdList: ['staff-lin'] })); return }
        if (state.mode === 'invalid') { response.end(JSON.stringify({ invalidStaffIdList: ['staff-lin'] })); return }
        accepted.push(parsed.data.msgParam)
        if (state.mode === 'lost') { response.destroy(); return }
        response.end(JSON.stringify(state.mode === 'malformed' ? { privateDiagnostic: 'DO_NOT_PROJECT' }
          : { processQueryKey: `message-process-${accepted.length}`, privateDiagnostic: 'DO_NOT_PROJECT' }))
      })
    })
    const value = await boot({ dingtalk, connectorAllowedOrigins: [origin], ...overrides })
    await value.ctx.credentials.set(credentialRef(value.ref), 'message-app-secret')
    const connection = { ...await configuration(value.ctx, origin), adapterId: 'dingtalk', probePath: 'v1.0/oauth2/accessToken' }
    await value.ctx.office.saveConnection(administrator, connection)
    const directory = await value.ctx.office.connectorActions(employee, connection.integrationId)
    if (!directory.adapterRevision) throw new Error('Expected reviewed DingTalk message action')
    const input: OfficeConnectorWriteInput = { integrationId: connection.integrationId, connectionRevision: 1,
      adapterRevision: directory.adapterRevision, actionId: 'dingtalk-send-message', requestId: randomUUID(),
      values: { title: 'Reviewed private office reminder', text: 'MESSAGE_PRIVATE_TEXT\nReview the original workflow.' } }
    return { ...value, origin, calls, accepted, state, input }
  }

  it('submits only the configured employee through the official robot route and records acceptance without claiming delivery', async () => {
    const { ctx, root, calls, accepted, input } = await prepared()
    const first = await ctx.office.writeConnectorAction(employee, input)
    expect(first).toMatchObject({ status: 'succeeded', result: { summary: '钉钉已受理本人消息投递，不代表已送达',
      entries: [{ label: '投递查询标识', value: 'message-process-1' }] } })
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/v1.0/robot/oToMessages/batchSend',
      token: 'message-private-token', authorization: '' })
    expect(JSON.parse(accepted[0]!)).toEqual({ title: input.values.title, text: input.values.text })
    expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(first)
    expect(calls).toHaveLength(2)
    await expect(ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID(),
      values: { ...input.values, userIds: 'another-staff-member' } })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await ctx.office.writeConnectorAction(administrator, { ...input, requestId: randomUUID() }))
      .toMatchObject({ status: 'rejected', rejection: 'denied' })
    expect(calls).toHaveLength(2)
    const stored = await readFile(join(root, 'data/enterprise_office_dingtalk_messages.json'), 'utf8')
    for (const secret of ['MESSAGE_PRIVATE_TEXT', 'message-app-secret', 'message-private-token', 'staff-lin', 'company-robot'])
      expect(stored).not.toContain(secret)
    expect(JSON.stringify(first)).not.toContain('DO_NOT_PROJECT')
  })

  it('restores an uncertain robot submission after restart without authenticating or sending a duplicate message', async () => {
    const { ctx, root, ref, origin, calls, accepted, state, input } = await prepared()
    state.mode = 'lost'
    const first = await ctx.office.writeConnectorAction(employee, input)
    expect(first.status).toBe('unknown')
    await ctx.fiber.dispose()
    const restored = await boot({ dingtalk, connectorAllowedOrigins: [origin], connectorCredentials: { 'oa-key': ref } }, root)
    expect(await restored.ctx.office.writeConnectorAction(employee, input)).toEqual(first)
    expect(await restored.ctx.office.checkConnectorExecution(employee, first.id)).toMatchObject({ status: 'unknown', receipt: first })
    expect(calls).toHaveLength(2)
    expect(accepted).toHaveLength(1)
  })

  it('recovers a durable provider acknowledgement when the outer office receipt write fails without another robot request', async () => {
    const { ctx, calls, accepted, input } = await prepared()
    const domain = ctx.storageDomain.get(officeConnectorExecutionDomain.name)!
    const set = domain.global.set.bind(domain.global)
    let writes = 0
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      if (++writes === 3) throw new Error('Outer office acknowledgement unavailable')
      await set(value)
    })
    await expect(ctx.office.writeConnectorAction(employee, input)).rejects.toMatchObject({ code: 'execution_unknown' })
    const first = (await ctx.office.connectorExecutions(employee))[0]!
    expect(first.status).toBe('unknown')
    const checked = await ctx.office.checkConnectorExecution(employee, first.id)
    expect(checked).toMatchObject({ status: 'updated', receipt: { status: 'succeeded',
      result: { entries: [{ label: '投递查询标识', value: 'message-process-1' }] } } })
    expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(checked.receipt)
    expect(calls).toHaveLength(2)
    expect(accepted).toHaveLength(1)
  })

  it('blocks unsaved reservations and full outboxes before network activity and keeps actual staff rejections distinct', async () => {
    const value = await prepared({ dingtalkMessageMaxEntries: 1 })
    const domain = value.ctx.storageDomain.get(officeDingTalkMessageDomain.name)!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Message reservation unavailable'))
    expect(await value.ctx.office.writeConnectorAction(employee, value.input)).toMatchObject({ status: 'unknown' })
    expect(value.calls).toEqual([])
    const acceptedInput = { ...value.input, requestId: randomUUID(), values: { title: 'Second message', text: 'Accepted content' } }
    expect(await value.ctx.office.writeConnectorAction(employee, acceptedInput)).toMatchObject({ status: 'succeeded' })
    expect(await value.ctx.office.writeConnectorAction(employee, { ...value.input, requestId: randomUUID(),
      values: { title: 'Third message', text: 'Full outbox' } })).toMatchObject({ status: 'rejected', rejection: 'not_accepted' })
    expect(value.calls).toHaveLength(2)
    const other = await prepared()
    for (const [mode, status, rejection] of [['filtered', 'rejected', 'denied'], ['limited', 'rejected', 'rate_limited'],
      ['invalid', 'rejected', 'invalid_input'], ['malformed', 'unknown', undefined]] as const) {
      other.state.mode = mode
      const outcome = await other.ctx.office.writeConnectorAction(employee, { ...other.input, requestId: randomUUID(),
        values: { title: `Reply ${mode}`, text: 'Review actual vendor outcome' } })
      expect(outcome.status).toBe(status)
      expect(outcome.rejection).toBe(rejection)
      expect(outcome.result).toBeUndefined()
    }
  })
})

describe('DingTalk enterprise authentication and private reads', () => {
  it('keeps DingTalk disabled when no optional app configuration is supplied', async () => {
    const { ctx } = await boot()
    expect((await ctx.office.connections(employee)).adapters).not.toContain('dingtalk')
    expect(ctx.office.view(employee).me.id).toBe(employee)
  })
  const dingtalk = { appKey: 'company-app-key', actions: ['todos', 'calendar'] satisfies ('todos' | 'calendar')[],
    members: { lin: { unionId: 'union-lin', calendarId: 'calendar-lin' } }, calendarWindowHours: 48 }
  async function prepared() {
    const calls: { method: string; url: string; body: string; authorization: string; token: string }[] = []
    let mode: 'valid' | 'unauthorized' | 'limited' | 'redirect' | 'large' | 'invalid' | 'timeout' = 'valid'
    const origin = await system((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (value: Buffer) => { chunks.push(value) })
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://fixture')
        calls.push({ method: request.method ?? '', url: url.pathname + url.search, body: Buffer.concat(chunks).toString('utf8'),
          authorization: request.headers.authorization ?? '', token: String(request.headers['x-acs-dingtalk-access-token'] ?? '') })
        response.setHeader('content-type', 'application/json')
        if (url.pathname.endsWith('/oauth2/accessToken')) {
          response.end(JSON.stringify({ accessToken: 'private-dingtalk-token', expireIn: 7200 })); return
        }
        if (mode === 'unauthorized' || mode === 'limited') {
          response.statusCode = mode === 'unauthorized' ? 401 : 429
          response.end(JSON.stringify({ code: 'PRIVATE_VENDOR_DIAGNOSTIC', message: 'remote-sensitive-message' })); return
        }
        if (mode === 'redirect') { response.writeHead(302, { location: origin + '/must-not-follow' }); response.end(); return }
        if (mode === 'large') { response.end(JSON.stringify({ padding: '界'.repeat(100000) })); return }
        if (mode === 'invalid') { response.end('{ invalid response'); return }
        if (mode === 'timeout') { response.write('{'); return }
        response.end(JSON.stringify(url.pathname.includes('/todo/')
          ? { todoCards: [{ subject: 'Actual first task', isDone: false }, { subject: 'Second task', isDone: false }],
            nextToken: 'vendor-private-cursor', secretDiagnostic: 'NEVER_PROJECT_THIS' }
          : { events: [{ summary: 'Actual calendar review', start: { dateTime: '2026-10-18T10:00Z' },
            end: { dateTime: '2026-10-18T11:00Z' }, attendees: [{ name: 'PRIVATE_ATTENDEE' }] }] }))
      })
    })
    const value = await boot({ connectorAllowedOrigins: [origin], connectorTimeoutMs: 200,
      connectorReadMaxEntries: 1, dingtalk })
    const connection = { ...await configuration(value.ctx, origin), adapterId: 'dingtalk', probePath: 'v1.0/oauth2/accessToken' }
    await value.ctx.office.saveConnection(administrator, connection)
    const coordinates = async (actionId: string) => {
      const directory = await value.ctx.office.connectorActions(employee, connection.integrationId)
      if (!directory.adapterRevision) throw new Error('DingTalk action directory is unavailable')
      return { integrationId: connection.integrationId, connectionRevision: 1, adapterRevision: directory.adapterRevision, actionId }
    }
    return { ...value, calls, origin, connection, coordinates, changeMode: (value: typeof mode) => { mode = value } }
  }

  it('uses current private app credentials for official token/todo/calendar routes and retains only employee-safe sync fields', async () => {
    const { ctx, ref, calls, root, origin, connection, coordinates } = await prepared()
    expect((await ctx.office.connections(employee)).entries[0]?.status).toBe('credential_missing')
    expect(calls).toEqual([])
    await ctx.credentials.set(credentialRef(ref), 'app-secret-one')
    expect((await ctx.office.probeConnection(administrator, connection.integrationId, 1)).status).toBe('connected')
    const input = await coordinates('dingtalk-todos')
    const read = await ctx.office.readConnectorAction(employee, input)
    expect(read).toMatchObject({ status: 'read', data: { entries: [{ label: '1. Actual first task', value: '未完成' }] } })
    if (read.status !== 'read') throw new Error('Expected a successful DingTalk read')
    expect(read.data?.summary).toContain('还有更多结果')
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/v1.0/todo/users/union-lin/org/tasks/query',
      token: 'private-dingtalk-token', authorization: '', body: JSON.stringify({ isDone: false, todoType: 'TODO' }) })
    expect(calls.every(call => call.authorization === '')).toBe(true)
    await ctx.credentials.set(credentialRef(ref), 'app-secret-two')
    const calendarInput = await coordinates('dingtalk-calendar')
    const calendar = await ctx.office.readConnectorAction(employee, calendarInput)
    expect(calendar).toMatchObject({ status: 'read', data: { entries: [{ label: '1. Actual calendar review' }] } })
    const calendarCall = calls.at(-1)!
    const url = new URL(calendarCall.url, origin)
    expect(url.pathname).toBe('/api/v1.0/calendar/users/union-lin/calendars/calendar-lin/events')
    expect(url.searchParams.get('maxResults')).toBe('1')
    expect(Date.parse(url.searchParams.get('timeMax')!) - Date.parse(url.searchParams.get('timeMin')!)).toBe(48 * 3600000)
    expect(calls.at(-2)?.body).toBe(JSON.stringify({ appKey: dingtalk.appKey, appSecret: 'app-secret-two' }))
    const count = calls.length
    expect((await ctx.office.readConnectorAction(administrator, input)).status).toBe('unauthorized')
    expect(calls).toHaveLength(count)
    const syncInput = { ...input, requestId: randomUUID() }
    const sync = await ctx.office.syncConnectorAction(employee, syncInput)
    expect(await ctx.office.syncConnectorAction(employee, syncInput)).toEqual(sync)
    expect(calls).toHaveLength(count + 2)
    const stored = await readFile(join(root, 'data/enterprise_office_connector_syncs.json'), 'utf8')
    for (const secret of ['app-secret', 'private-dingtalk-token', 'vendor-private-cursor', 'NEVER_PROJECT_THIS', 'PRIVATE_ATTENDEE']) {
      expect(stored).not.toContain(secret)
      expect(JSON.stringify([read, calendar])).not.toContain(secret)
    }
    expect((await ctx.office.connectorSyncPage(administrator, { integrationId: connection.integrationId })).entries).toEqual([])
  })

  it('keeps authentication, rate limits, redirects, oversized bodies, invalid JSON and aborted reads out of business data', async () => {
    const { ctx, ref, calls, coordinates, changeMode } = await prepared()
    await ctx.credentials.set(credentialRef(ref), 'private-app-secret')
    const input = await coordinates('dingtalk-todos')
    for (const [mode, status] of [['unauthorized', 'unauthorized'], ['limited', 'rate_limited'], ['redirect', 'http_error'],
      ['large', 'invalid_response'], ['invalid', 'invalid_response'], ['timeout', 'timed_out']] as const) {
      changeMode(mode)
      const before = calls.length
      const result = await ctx.office.readConnectorAction(employee, input)
      expect(result.status).toBe(status)
      expect(result).not.toHaveProperty('data')
      expect(JSON.stringify(result)).not.toContain('remote-sensitive-message')
      expect(calls).toHaveLength(before + 2)
    }
    expect(calls.some(call => call.url.includes('must-not-follow'))).toBe(false)
  })

  it('rejects ambiguous identity mappings at configuration admission and never probes an unrelated location', async () => {
    expect(() => createDingTalkAdapter({ ...dingtalk, members: { lin: { unionId: 'same' }, admin: { unionId: 'same' } } })).toThrow()
    expect(() => createDingTalkAdapter({ ...dingtalk, members: { lin: { unionId: '..' } } })).toThrow()
    const adapter = createDingTalkAdapter(dingtalk)
    const fetch = vi.spyOn(globalThis, 'fetch')
    const lifetime = { signal: new AbortController().signal, maxResponseBytes: 4096 }
    expect(await adapter.probe({ ...lifetime, headers: { authorization: 'Bearer private-app-secret' },
      url: 'https://api.dingtalk.com/unrelated' })).toEqual({ status: 'invalid_response' })
    expect(await adapter.read!({ ...lifetime, headers: { authorization: 'Bearer private-app-secret' }, actionId: 'dingtalk-todos',
      member: { id: 'toString' as OfficeMemberId, role: 'employee' }, baseUrl: 'https://api.dingtalk.com/', maxEntries: 20 }))
      .toEqual({ status: 'unauthorized' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('DingTalk reviewed business writes', () => {
  const dingtalk: NonNullable<Config['dingtalk']> = { appKey: 'write-app-key', actions: ['create_todo'],
    members: { lin: { unionId: 'union-lin' } } }
  async function prepared(mode: 'todo' | 'calendar' | 'calendar_without_id' = 'todo') {
    const calls: { method: string; path: string; body: string; clientToken: string }[] = []
    const tasks = new Map<string, { id: string; creatorId: string; sourceId: string; subject: string }>()
    const events = new Map<string, { id: string; summary: string; start: { dateTime: string }; end: { dateTime: string } }>()
    const state = { loseAcknowledgement: false, authStatus: 200,
      lookup: 'valid' as 'valid' | 'absent' | 'wrong-owner' | 'wrong-source' }
    const fields = z.object({ subject: z.string(), description: z.string(), sourceId: z.uuid(),
      creatorId: z.literal('union-lin'), executorIds: z.tuple([z.literal('union-lin')]),
      isOnlyShowExecutor: z.literal(true), todoType: z.literal('TODO'), dueTime: z.number().optional() }).strict()
    const eventFields = z.object({ summary: z.string(), description: z.string(), isAllDay: z.literal(false), attendees: z.tuple([]),
      start: z.object({ dateTime: z.string() }), end: z.object({ dateTime: z.string() }) }).strict()
    const origin = await system((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (value: Buffer) => { chunks.push(value) })
      request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://fixture').pathname
        const body = Buffer.concat(chunks).toString('utf8')
        const clientToken = String(request.headers['x-client-token'] ?? '')
        calls.push({ method: request.method ?? '', path, body, clientToken })
        response.setHeader('content-type', 'application/json')
        if (path.endsWith('/oauth2/accessToken')) {
          response.statusCode = state.authStatus
          response.end(JSON.stringify(state.authStatus === 200 ? { accessToken: 'private-write-token', expireIn: 7200 }
            : { message: 'PRIVATE_AUTH_DIAGNOSTIC' })); return
        }
        if (request.method === 'POST' && path === '/api/v1.0/todo/users/union-lin/tasks') {
          const parsed = fields.safeParse(JSON.parse(body))
          if (!parsed.success) { response.writeHead(400); response.end('{}'); return }
          const record = { id: `remote-todo-${tasks.size + 1}`, creatorId: parsed.data.creatorId,
            sourceId: parsed.data.sourceId, subject: parsed.data.subject }
          tasks.set(record.sourceId, record)
          if (state.loseAcknowledgement) { response.destroy(); return }
          response.end(JSON.stringify(record)); return
        }
        if (request.method === 'POST' && path === '/api/v1.0/calendar/users/union-lin/calendars/calendar-lin/events') {
          const parsed = eventFields.safeParse(JSON.parse(body))
          if (!parsed.success || !z.uuid().safeParse(clientToken).success) { response.writeHead(400); response.end('{}'); return }
          const record = { id: `remote-event-${events.size + 1}`, summary: parsed.data.summary,
            start: parsed.data.start, end: parsed.data.end }
          events.set(clientToken, record)
          if (state.loseAcknowledgement) { response.destroy(); return }
          response.end(JSON.stringify(record)); return
        }
        const key = path.split('/sources/')[1]
        const task = key ? tasks.get(decodeURIComponent(key)) : undefined
        if (!task || state.lookup === 'absent') { response.writeHead(404); response.end('{}'); return }
        response.end(JSON.stringify({ ...task, ...state.lookup === 'wrong-owner' ? { creatorId: 'another-employee' } : {},
          ...state.lookup === 'wrong-source' ? { sourceId: randomUUID() } : {}, privateDiagnostic: 'PRIVATE_TASK_DIAGNOSTIC' }))
      })
    })
    const platformConfig: NonNullable<Config['dingtalk']> = mode === 'todo' ? dingtalk : { ...dingtalk,
      actions: ['create_todo', 'create_calendar'],
      members: { lin: { unionId: 'union-lin', ...mode === 'calendar' ? { calendarId: 'calendar-lin' } : {} } } }
    const value = await boot({ dingtalk: platformConfig, connectorAllowedOrigins: [origin] })
    await value.ctx.credentials.set(credentialRef(value.ref), 'write-app-secret')
    const connection = { ...await configuration(value.ctx, origin), adapterId: 'dingtalk', probePath: 'v1.0/oauth2/accessToken' }
    await value.ctx.office.saveConnection(administrator, connection)
    const directory = await value.ctx.office.connectorActions(employee, connection.integrationId)
    if (!directory.adapterRevision) throw new Error('Expected reviewed DingTalk write declarations')
    const input: OfficeConnectorWriteInput = { integrationId: connection.integrationId, connectionRevision: 1,
      adapterRevision: directory.adapterRevision, actionId: mode === 'todo' ? 'dingtalk-create-todo' : 'dingtalk-create-calendar',
      requestId: randomUUID(), values: mode === 'todo'
        ? { subject: 'Review company invoice', description: 'Keep original workflow\nCreate only for me.',
          due_time: '2026-11-01T09:00:00+08:00' }
        : { summary: 'Company review', description: 'Keep original agendas\nOnly my calendar.',
          start_time: '2026-11-01T09:00:00+08:00', end_time: '2026-11-01T10:00:00+08:00' } }
    return { ...value, origin, calls, tasks, events, state, input, connection }
  }

  it('creates only the reviewed employee todo with its server execution sourceId and never repeats an exact request', async () => {
    const { ctx, calls, tasks, input } = await prepared()
    expect(calls).toEqual([])
    const first = await ctx.office.writeConnectorAction(employee, input)
    expect(first).toMatchObject({ status: 'succeeded', result: { summary: '钉钉待办已确认创建' } })
    expect(tasks.get(first.id)).toMatchObject({ creatorId: 'union-lin', sourceId: first.id, subject: input.values.subject })
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ sourceId: first.id, creatorId: 'union-lin', executorIds: ['union-lin'],
      dueTime: Date.parse(input.values.due_time!), isOnlyShowExecutor: true })
    expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(first)
    await expect(ctx.office.writeConnectorAction(employee, { ...input, values: { ...input.values, subject: 'Changed review' } }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID(),
      values: { ...input.values, executorIds: 'someone-else' } })).rejects.toMatchObject({ code: 'invalid_input' })
    const denied = await ctx.office.writeConnectorAction(administrator, { ...input, requestId: randomUUID() })
    expect(denied).toMatchObject({ status: 'rejected', rejection: 'denied' })
    expect(calls).toHaveLength(2)
    await expect(ctx.office.connectorExecutionDetail(administrator, first.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('recovers a lost creation receipt after office restart using GET by the original sourceId without resubmission', async () => {
    const { ctx, root, ref, origin, calls, state, input } = await prepared()
    state.loseAcknowledgement = true
    const first = await ctx.office.writeConnectorAction(employee, input)
    expect(first.status).toBe('unknown')
    expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(first)
    expect(calls).toHaveLength(2)
    await ctx.fiber.dispose()
    const recovered = await boot({ dingtalk, connectorAllowedOrigins: [origin], connectorCredentials: { 'oa-key': ref } }, root)
    for (const lookup of ['absent', 'wrong-owner', 'wrong-source'] as const) {
      state.lookup = lookup
      const checked = await recovered.ctx.office.checkConnectorExecution(employee, first.id)
      expect(checked.receipt.status).toBe('unknown')
      expect(checked.receipt).not.toHaveProperty('result')
    }
    state.lookup = 'valid'
    const checked = await recovered.ctx.office.checkConnectorExecution(employee, first.id)
    expect(checked).toMatchObject({ status: 'updated', receipt: { id: first.id, status: 'succeeded' } })
    expect(checked.receipt.history.map(entry => entry.stage)).toEqual(['reserved', 'dispatched', 'unknown', 'succeeded'])
    expect(await recovered.ctx.office.writeConnectorAction(employee, input)).toEqual(checked.receipt)
    expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/tasks'))).toHaveLength(1)
    expect(calls.filter(call => call.method === 'GET').every(call => call.path.endsWith('/tasks/sources/' + first.id))).toBe(true)
    expect(JSON.stringify(checked)).not.toContain('PRIVATE_TASK_DIAGNOSTIC')
    expect(await recovered.ctx.office.checkConnectorExecution(employee, first.id)).toEqual(checked)
  })

  it('records invalid dates and failed authentication as unaccepted before any customer todo is sent', async () => {
    const { ctx, calls, tasks, state, input } = await prepared()
    const invalid = await ctx.office.writeConnectorAction(employee, { ...input, values: { ...input.values, due_time: 'next Friday' } })
    expect(invalid).toMatchObject({ status: 'rejected', rejection: 'invalid_input' })
    expect(calls).toEqual([])
    state.authStatus = 401
    const denied = await ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID() })
    expect(denied).toMatchObject({ status: 'rejected', rejection: 'unauthorized' })
    expect(calls).toHaveLength(1)
    expect(tasks.size).toBe(0)
    expect(JSON.stringify(denied)).not.toContain('PRIVATE_AUTH_DIAGNOSTIC')
    const writes = createDingTalkAdapter({ ...dingtalk, actions: ['todos'] })
    expect(writes).not.toHaveProperty('write')
    expect(writes).not.toHaveProperty('reconcile')
  })

  describe('DingTalk reviewed calendar writes', () => {
    it('uses the original execution client token and only the mapped calendar with no attendees', async () => {
      const { ctx, calls, events, input } = await prepared('calendar')
      const first = await ctx.office.writeConnectorAction(employee, input)
      expect(first).toMatchObject({ status: 'succeeded', result: { summary: '钉钉日程已确认创建' } })
      expect(events.get(first.id)).toMatchObject({ summary: input.values.summary })
      expect(calls[1]).toMatchObject({ method: 'POST',
        path: '/api/v1.0/calendar/users/union-lin/calendars/calendar-lin/events', clientToken: first.id })
      expect(JSON.parse(calls[1]!.body)).toMatchObject({ attendees: [], isAllDay: false,
        start: { dateTime: input.values.start_time }, end: { dateTime: input.values.end_time } })
      expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(first)
      await expect(ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID(),
        values: { ...input.values, calendarId: 'another-calendar' } })).rejects.toMatchObject({ code: 'invalid_input' })
      expect(calls).toHaveLength(2)
      expect(events.size).toBe(1)
    })

    it('rejects invalid time ranges and missing private calendar mappings before authentication or event creation', async () => {
      const { ctx, calls, input, events } = await prepared('calendar')
      const invalid = await ctx.office.writeConnectorAction(employee, { ...input,
        values: { ...input.values, end_time: input.values.start_time! } })
      expect(invalid).toMatchObject({ status: 'rejected', rejection: 'invalid_input' })
      expect(calls).toEqual([])
      expect(events.size).toBe(0)
      const unmapped = await prepared('calendar_without_id')
      expect(await unmapped.ctx.office.writeConnectorAction(employee, unmapped.input))
        .toMatchObject({ status: 'rejected', rejection: 'denied' })
      expect(unmapped.calls).toEqual([])
    })

    it('reports unavailable lookup after a lost event receipt without changing the original outcome or resending', async () => {
      const { ctx, calls, state, input, root, events } = await prepared('calendar')
      state.loseAcknowledgement = true
      const first = await ctx.office.writeConnectorAction(employee, input)
      expect(first.status).toBe('unknown')
      expect(events.size).toBe(1)
      const path = join(root, 'data/enterprise_office_connector_executions.json')
      const bytes = await readFile(path)
      expect(await ctx.office.checkConnectorExecution(employee, first.id)).toEqual({ status: 'unavailable', receipt: first })
      expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(first)
      expect(calls).toHaveLength(2)
      expect(await readFile(path)).toEqual(bytes)
    })
  })
})

describe('Private company read synchronization', () => {
  const actions: readonly OfficeConnectorActionDeclaration[] = [{ id: 'read-self', label: 'Read my records',
    description: '', kind: 'read', allowedRoles: ['employee', 'manager'] }]
  async function read(request: OfficeConnectorReadRequest): Promise<OfficeConnectorReadResult> {
    try {
      const response = await fetch(new URL('records', request.baseUrl), { headers: { ...request.headers,
        'x-office-employee': request.member.id, 'x-office-role': request.member.role }, signal: request.signal, redirect: 'manual' })
      if (response.status === 401) return { status: 'unauthorized' }
      if (response.status === 429) return { status: 'rate_limited' }
      if (!response.ok) return { status: 'http_error' }
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > request.maxResponseBytes) return { status: 'invalid_response' }
      let data: unknown
      try { data = JSON.parse(text) }
      catch { return { status: 'invalid_response' } }
      const parsed = connectorReadResultSchema(request.maxEntries).safeParse({ status: 'read', data })
      return parsed.success ? parsed.data : { status: 'invalid_response' }
    } catch { return { status: request.signal.aborted ? 'timed_out' : 'unreachable' } }
  }
  async function prepared(origin: string, overrides: Partial<Config> = {}) {
    const value = await boot({ connectorAllowedOrigins: [origin], ...overrides })
    await value.ctx.credentials.set(credentialRef(value.ref), 'sync-private-secret')
    const register = () => value.ctx.office.registerConnector({ id: 'sync-http', actions,
      async probe() { throw new Error('Synchronization cannot implicitly probe') }, read })
    const stop = register()
    const connection = { ...await configuration(value.ctx, origin), adapterId: 'sync-http' }
    await value.ctx.office.saveConnection(administrator, connection)
    const directory = await value.ctx.office.connectorActions(employee, connection.integrationId)
    if (!directory.adapterRevision) throw new Error('Expected a registered synchronization reader')
    const input: OfficeConnectorSyncInput = { integrationId: connection.integrationId, actionId: 'read-self',
      connectionRevision: 1, adapterRevision: directory.adapterRevision, requestId: randomUUID() }
    return { ...value, input, connection, stop, register }
  }
  const reply = (response: ServerResponse, value = 'SYNC_VALUE_ONE') => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ summary: value, entries: [{ label: 'Status', value }] }))
  }

  it('persists actual HTTP fields, keeps exact retries immutable and contains failed storage without claiming success', async () => {
    const calls: { method: string | undefined; employee: string | string[] | undefined; authorization: string | undefined }[] = []
    let value = 'SYNC_VALUE_ONE'
    const origin = await system((request, response) => {
      calls.push({ method: request.method, employee: request.headers['x-office-employee'], authorization: request.headers.authorization })
      reply(response, value)
    })
    const { ctx, input, root } = await prepared(origin)
    const first = await ctx.office.syncConnectorAction(employee, input)
    expect(first).toMatchObject({ meId: employee, available: true, summary: { status: 'read' }, data: { summary: value } })
    value = 'SYNC_VALUE_TWO'
    expect(await ctx.office.syncConnectorAction(employee, input)).toEqual(first)
    expect(calls).toEqual([{ method: 'GET', employee, authorization: 'Bearer sync-private-secret' }])
    const page = await ctx.office.connectorSyncPage(employee, { integrationId: input.integrationId })
    expect(page.entries).toEqual([first.summary])
    expect(JSON.stringify(page)).not.toContain('SYNC_VALUE_ONE')
    expect((await ctx.office.connectorSyncPage(administrator, { integrationId: input.integrationId })).entries).toEqual([])
    await expect(ctx.office.connectorSyncDetail(administrator, first.summary.id)).rejects.toMatchObject({ code: 'not_found' })
    const path = join(root, 'data/enterprise_office_connector_syncs.json')
    const before = await readFile(path)
    const secondInput = { ...input, requestId: randomUUID() }
    vi.spyOn(ctx.storageDomain.get('enterprise_office_connector_syncs')!.global, 'set')
      .mockRejectedValueOnce(new Error('Synchronization storage unavailable'))
    await expect(ctx.office.syncConnectorAction(employee, secondInput)).rejects.toThrow('Synchronization storage unavailable')
    expect(await readFile(path)).toEqual(before)
    expect((await ctx.office.connectorSyncPage(employee, { integrationId: input.integrationId })).entries).toHaveLength(1)
    const second = await ctx.office.syncConnectorAction(employee, secondInput)
    expect(second.data?.summary).toBe(value)
    expect(await ctx.office.syncConnectorAction(employee, secondInput)).toEqual(second)
    expect(calls).toHaveLength(3)
    const stored = await readFile(path, 'utf8')
    expect(stored).not.toContain('sync-private-secret')
    expect(stored).not.toContain(origin)
    await expect(ctx.office.syncConnectorAction(employee, { ...input, actionId: 'changed-action' })).rejects.toMatchObject({ code: 'conflict' })
    expect(calls).toHaveLength(3)
  })

  it('records actual unauthorized, throttled, unreachable and malformed outcomes without stale successful fields', async () => {
    let mode = 'good'
    let requests = 0
    const origin = await system((request, response) => {
      requests++
      if (mode === 'unreachable') { request.socket.destroy(); return }
      if (mode === 'invalid_response') { response.end('invalid JSON'); return }
      if (mode === 'unauthorized') response.statusCode = 401
      if (mode === 'rate_limited') response.statusCode = 429
      if (mode === 'http_error') response.statusCode = 503
      reply(response)
    })
    const { ctx, input } = await prepared(origin)
    const good = await ctx.office.syncConnectorAction(employee, input)
    expect(good.data?.summary).toBe('SYNC_VALUE_ONE')
    for (const failure of ['unauthorized', 'rate_limited', 'unreachable', 'http_error']) {
      mode = failure
      const attempt = { ...input, requestId: randomUUID() }
      const result = await ctx.office.syncConnectorAction(employee, attempt)
      expect(result).toMatchObject({ summary: { status: failure }, data: null })
      mode = 'good'
      const count = requests
      expect(await ctx.office.syncConnectorAction(employee, attempt)).toEqual(result)
      expect(requests).toBe(count)
    }
    mode = 'invalid_response'
    const malformed = await ctx.office.syncConnectorAction(employee, { ...input, requestId: randomUUID() })
    expect(malformed).toMatchObject({ summary: { status: 'invalid_response' }, data: null })
    expect((await ctx.office.connectorSyncPage(employee, { integrationId: input.integrationId })).entries).toHaveLength(6)
  })

  it('retains private history across restart and withholds fields when role, declared access or the saved connection changes', async () => {
    let requests = 0
    const origin = await system((_request, response) => { requests++; reply(response) })
    const { ctx, root, ref, input, connection, stop } = await prepared(origin)
    const saved = await ctx.office.syncConnectorAction(employee, input)
    stop()
    expect(await ctx.office.connectorSyncDetail(employee, saved.summary.id)).toMatchObject({ available: false, data: null })
    await ctx.fiber.dispose()
    const resumed = await boot({ connectorAllowedOrigins: [origin], connectorCredentials: { 'oa-key': ref } }, root)
    resumed.ctx.office.registerConnector({ id: 'sync-http', actions, async probe() { return { status: 'connected' } }, read })
    expect(await resumed.ctx.office.syncConnectorAction(employee, input)).toEqual(saved)
    expect(requests).toBe(1)
    const original = resumed.ctx.office.view(administrator).members.find(member => member.id === employee)!
    await resumed.ctx.office.saveMember(administrator, { ...original, role: 'manager' }, original)
    expect(await resumed.ctx.office.connectorSyncDetail(employee, saved.summary.id)).toMatchObject({ available: false, data: null })
    const changed = resumed.ctx.office.view(administrator).members.find(member => member.id === employee)!
    await resumed.ctx.office.saveMember(administrator, { ...changed, role: 'employee' }, changed)
    expect((await resumed.ctx.office.connectorSyncDetail(employee, saved.summary.id)).data).toEqual(saved.data)
    await resumed.ctx.office.saveConnection(administrator, { ...connection, revision: 1, requestId: randomUUID(), enabled: false })
    expect(await resumed.ctx.office.connectorSyncDetail(employee, saved.summary.id)).toMatchObject({ available: false, data: null })
    expect(requests).toBe(1)
  })

  it('synchronization evidence rejects forged identities and enforces complete UTF-8 storage bounds without replacing history', async () => {
    let value = 'SYNC_VALUE_ONE'
    const origin = await system((_request, response) => { reply(response, value) })
    const { ctx, input, root } = await prepared(origin, { connectorSyncMaxBytes: 2048 })
    const password = 'Synchronization fixture password!'
    await ctx.office.initializeIdentity(administrator, password)
    await ctx.office.setIdentityPassword(administrator, employee, password)
    const session = await ctx.office.login({ memberId: employee, password })
    const adminSession = await ctx.office.login({ memberId: administrator, password })
    const result = await executeOfficeRequest(ctx.office, session.token, { method: 'syncConnectorAction', args: [input] })
    expect(result).toMatchObject({ meId: employee, summary: { status: 'read' } })
    const saved = (await ctx.office.connectorSyncPage(employee, { integrationId: input.integrationId })).entries[0]!
    await expect(executeOfficeRequest(ctx.office, session.token,
      { method: 'connectorSyncDetail', args: [saved.id], actorId: administrator })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(executeOfficeRequest(ctx.office, adminSession.token,
      { method: 'connectorSyncDetail', args: [saved.id] })).rejects.toMatchObject({ code: 'not_found' })
    await expect(executeOfficeRequest(ctx.office, session.token,
      { method: 'syncConnectorAction', args: [{ ...input, url: origin }] })).rejects.toMatchObject({ code: 'invalid_input' })
    const path = join(root, 'data/enterprise_office_connector_syncs.json')
    const before = await readFile(path)
    value = '界'.repeat(900)
    await expect(ctx.office.syncConnectorAction(employee, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await readFile(path)).toEqual(before)
    expect((await ctx.office.connectorSyncPage(employee, { integrationId: input.integrationId })).entries).toHaveLength(1)
  })

  it('synchronization durable recovery refuses corrupted evidence and a missing original catalog without replacing saved bytes', async () => {
    const origin = await system((_request, response) => { reply(response) })
    const { ctx, root, ref, input } = await prepared(origin)
    const saved = await ctx.office.syncConnectorAction(employee, input)
    const domain = ctx.storageDomain.get('enterprise_office_connector_syncs')!
    const data = officeConnectorSyncDomain.global.schema.parse(domain.global.get())
    const path = join(root, 'data/enterprise_office_connector_syncs.json')
    const original = await readFile(path)
    await ctx.fiber.dispose()
    const first = data.entries[0]
    if (!first) throw new Error('Expected a saved synchronization fingerprint')
    const corrupted = Buffer.from(original.toString('utf8').replace(first.fingerprint, '0'.repeat(64)))
    expect(corrupted).not.toEqual(original)
    expect(officeConnectorSyncDomain.global.schema.safeParse({ entries: data.entries.map(entry =>
      ({ ...entry, fingerprint: '0'.repeat(64) })) }).success).toBe(false)
    await writeFile(path, corrupted)
    await expect(boot({ connectorAllowedOrigins: [origin], connectorCredentials: { 'oa-key': ref } }, root)).rejects.toThrow()
    expect(await readFile(path)).toEqual(corrupted)
    await writeFile(path, original)
    const catalog = join(root, 'data/enterprise_office_integrations.json')
    const connections = join(root, 'data/enterprise_office_connectors.json')
    const catalogBytes = await readFile(catalog)
    const connectionBytes = await readFile(connections)
    await rm(connections)
    await expect(boot({ connectorAllowedOrigins: [origin], connectorCredentials: { 'oa-key': ref } }, root)).rejects.toThrow()
    expect(await readFile(path)).toEqual(original)
    await writeFile(connections, connectionBytes)
    await rm(catalog)
    await rm(connections)
    await expect(boot({ connectorAllowedOrigins: [origin], connectorCredentials: { 'oa-key': ref } }, root)).rejects.toThrow()
    expect(await readFile(path)).toEqual(original)
    await writeFile(catalog, catalogBytes)
    await writeFile(connections, connectionBytes)
    const resumed = await boot({ connectorAllowedOrigins: [origin], connectorCredentials: { 'oa-key': ref } }, root)
    expect((await resumed.ctx.office.connectorSyncPage(employee, { integrationId: input.integrationId })).entries).toEqual([saved.summary])
  })

  it('keeps older-page anchors stable, rejects foreign anchors and enforces admission capacity before customer requests', async () => {
    let requests = 0
    const origin = await system((_request, response) => { requests++; reply(response) })
    const { ctx, input } = await prepared(origin, { connectorSyncMaxEntries: 23 })
    for (let index = 0; index < 22; index++) await ctx.office.syncConnectorAction(employee, { ...input, requestId: randomUUID() })
    const first = await ctx.office.connectorSyncPage(employee, { integrationId: input.integrationId })
    expect(first.entries).toHaveLength(20)
    if (!first.next) throw new Error('Expected an older synchronization anchor')
    const newer = await ctx.office.syncConnectorAction(employee, input)
    const second = await ctx.office.connectorSyncPage(employee, { integrationId: input.integrationId, before: first.next })
    expect(second.entries).toHaveLength(2)
    expect(second.next).toBeNull()
    expect(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size).toBe(22)
    await expect(ctx.office.connectorSyncPage(administrator,
      { integrationId: input.integrationId, before: first.next })).rejects.toMatchObject({ code: 'not_found' })
    const count = requests
    await expect(ctx.office.syncConnectorAction(employee, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
    expect(await ctx.office.syncConnectorAction(employee, input)).toEqual(newer)
    expect(requests).toBe(count)
  })
})

describe('Durable company business writes', () => {
  const actions: readonly OfficeConnectorActionDeclaration[] = [
    { id: 'submit-request', label: 'Submit request', description: '', kind: 'write', allowedRoles: ['employee'],
      fields: [{ name: 'title', label: 'Title', required: true, maxLength: 120 },
        { name: 'reason', label: 'Reason', required: false, maxLength: 4000 }] },
    { id: 'admin-write', label: 'Admin write', description: '', kind: 'write', allowedRoles: ['admin'] },
    { id: 'read-self', label: 'Read', description: '', kind: 'read', allowedRoles: ['employee'] },
  ]
  async function prepared(write: (request: OfficeConnectorWriteRequest) => Promise<OfficeConnectorWriteResult>,
    overrides: Partial<Config> = {}, address?: string, reconcile?: OfficeConnectorAdapter['reconcile']) {
    const origin = address ?? await system((_request, response) => { response.end('{}') })
    const value = await boot({ connectorAllowedOrigins: [origin], ...overrides })
    await value.ctx.credentials.set(credentialRef(value.ref), 'write-fixture-private-secret')
    const stop = value.ctx.office.registerConnector({ id: 'business-write', actions,
      probe: async () => ({ status: 'connected' }), write, ...reconcile ? { reconcile } : {} })
    const connection = { ...await configuration(value.ctx, origin), adapterId: 'business-write' }
    await value.ctx.office.saveConnection(administrator, connection)
    const directory = await value.ctx.office.connectorActions(employee, connection.integrationId)
    if (!directory.adapterRevision) throw new Error('Expected an active write provider')
    const input: OfficeConnectorWriteInput = { integrationId: connection.integrationId, actionId: 'submit-request',
      connectionRevision: 1, adapterRevision: directory.adapterRevision, requestId: randomUUID(),
      values: { title: 'Employee purchase', reason: 'Approved reason' } }
    const domain = value.ctx.storageDomain.get(officeConnectorExecutionDomain.name) as Domain<typeof officeConnectorExecutionDomain>
    return { ...value, stop, connection, directory, input, domain }
  }
  const success: OfficeConnectorWriteResult = { status: 'succeeded', result: {
    summary: 'Request accepted', entries: [{ label: 'External id', value: 'OA-42' }],
  } }

  it('reconciles a real committed HTTP operation by its original key, current employee and rotated credentials without another POST', async () => {
    const committed = new Set<string>()
    const calls: { method: string | undefined; key: string; authorization: string; employee: string }[] = []
    const origin = await system((request, response) => {
      const key = String(request.headers['idempotency-key'])
      calls.push({ method: request.method, key, authorization: String(request.headers.authorization),
        employee: String(request.headers['x-office-employee']) })
      request.resume()
      request.on('end', () => {
        if (request.method === 'POST') committed.add(key)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(committed.has(key) ? success : { status: 'unknown' }))
      })
    })
    const write = vi.fn(async (request: OfficeConnectorWriteRequest): Promise<OfficeConnectorWriteResult> => {
      await fetch(new URL('requests', request.baseUrl), { method: 'POST', headers: {
        ...request.headers, 'idempotency-key': request.executionId, 'x-office-employee': request.member.id,
      }, body: JSON.stringify(request.values), signal: request.signal, redirect: 'manual' })
      return { status: 'unknown' }
    })
    const reconcile = vi.fn<NonNullable<OfficeConnectorAdapter['reconcile']>>(async (request) => {
      expect(Object.hasOwn(request, 'values')).toBe(false)
      const response = await fetch(new URL('receipt', request.baseUrl), { method: 'GET', headers: {
        ...request.headers, 'idempotency-key': request.executionId, 'x-office-employee': request.member.id,
      }, signal: request.signal, redirect: 'manual' })
      return await response.json() as OfficeConnectorWriteResult
    })
    const { ctx, input, ref, root } = await prepared(write, {}, origin, reconcile)
    const original = await ctx.office.writeConnectorAction(employee, input)
    expect(original.status).toBe('unknown')
    await ctx.credentials.set(credentialRef(ref), 'reconcile-rotated-private-secret')
    const checked = await ctx.office.checkConnectorExecution(employee, original.id)
    expect(checked).toMatchObject({ status: 'updated', receipt: { id: original.id, requestId: input.requestId,
      status: 'succeeded', revision: 4 } })
    expect(checked.receipt.history.map(entry => entry.stage)).toEqual(['reserved', 'dispatched', 'unknown', 'succeeded'])
    expect(calls).toEqual([
      { method: 'POST', key: original.id, employee, authorization: 'Bearer write-fixture-private-secret' },
      { method: 'GET', key: original.id, employee, authorization: 'Bearer reconcile-rotated-private-secret' },
    ])
    expect(await ctx.office.checkConnectorExecution(employee, original.id)).toEqual(checked)
    expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(checked.receipt)
    expect(write).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(await readFile(join(root, 'data', 'enterprise_office_connector_executions.json'), 'utf8')).not.toContain('private-secret')
  })

  it('does not invent absence when a checker is missing or a saved connection changed', async () => {
    const write = vi.fn(async (): Promise<OfficeConnectorWriteResult> => ({ status: 'unknown' }))
    const { ctx, input, connection } = await prepared(write)
    const original = await ctx.office.writeConnectorAction(employee, input)
    expect(await ctx.office.checkConnectorExecution(employee, original.id)).toEqual({ status: 'unavailable', receipt: original })
    await expect(ctx.office.checkConnectorExecution(administrator, original.id)).rejects.toMatchObject({ code: 'not_found' })
    await ctx.office.saveConnection(administrator, { ...connection, revision: 1, requestId: randomUUID(), probePath: 'changed' })
    expect(await ctx.office.checkConnectorExecution(employee, original.id)).toEqual({ status: 'connection_changed', receipt: original })
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('cold-restores the original operation and reconciles with a fresh trusted registration without another write', async () => {
    const write = vi.fn(async (): Promise<OfficeConnectorWriteResult> => ({ status: 'unknown' }))
    const reconcile = vi.fn(async () => success)
    const { ctx, root, input, connection } = await prepared(write, {}, undefined, reconcile)
    const original = await ctx.office.writeConnectorAction(employee, input)
    await ctx.fiber.dispose()
    const restored = await boot({ connectorAllowedOrigins: [new URL(connection.baseUrl).origin] }, root)
    await restored.ctx.credentials.set(credentialRef(restored.ref), 'restored-check-private-secret')
    restored.ctx.office.registerConnector({ id: 'business-write', actions, write, reconcile, probe: async () => ({ status: 'connected' }) })
    expect(await restored.ctx.office.checkConnectorExecution(employee, original.id)).toMatchObject({ status: 'updated',
      receipt: { id: original.id, status: 'succeeded' } })
    expect(write).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it.each(['unknown', 'throw', 'malformed', 'oversized'] as const)('keeps %s checks unknown without changing the operation or dispatching it again', async (mode) => {
    const write = vi.fn(async (): Promise<OfficeConnectorWriteResult> => ({ status: 'unknown' }))
    const reconcile = vi.fn(async (): Promise<OfficeConnectorWriteResult> => {
      if (mode === 'throw') throw new Error('Private checker diagnostic write-fixture-private-secret')
      if (mode === 'unknown') return { status: 'unknown' }
      if (mode === 'malformed') return { status: 'succeeded', result: { summary: 'Claimed result', entries: [], secret: 'private' } } as OfficeConnectorWriteResult
      return { status: 'succeeded', result: { summary: '文'.repeat(600), entries: [] } }
    })
    const { ctx, input } = await prepared(write, { connectorWriteMaxResultBytes: 1024 }, undefined, reconcile)
    const original = await ctx.office.writeConnectorAction(employee, input)
    if (mode === 'unknown') expect(await ctx.office.checkConnectorExecution(employee, original.id)).toEqual({ status: 'unknown', receipt: original })
    else await expect(ctx.office.checkConnectorExecution(employee, original.id)).rejects.toMatchObject({ code: 'execution_unknown' })
    expect(await ctx.office.connectorExecutionDetail(employee, original.id)).toEqual(original)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not publish an uncommitted reconciliation and recovers by checking without another business dispatch', async () => {
    const write = vi.fn(async (): Promise<OfficeConnectorWriteResult> => ({ status: 'unknown' }))
    const reconcile = vi.fn(async () => success)
    const { ctx, input, domain } = await prepared(write, {}, undefined, reconcile)
    const original = await ctx.office.writeConnectorAction(employee, input)
    const fault = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Injected outcome commit failure'))
    await expect(ctx.office.checkConnectorExecution(employee, original.id)).rejects.toMatchObject({ code: 'execution_unknown' })
    fault.mockRestore()
    expect(await ctx.office.connectorExecutionDetail(employee, original.id)).toEqual(original)
    expect((await ctx.office.checkConnectorExecution(employee, original.id)).receipt.status).toBe('succeeded')
    expect(write).toHaveBeenCalledTimes(1)
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it('rejects a lost current role before checking a previously authorized employee operation', async () => {
    const reconcile = vi.fn(async () => success)
    const { ctx, input } = await prepared(async () => ({ status: 'unknown' }), {}, undefined, reconcile)
    const original = await ctx.office.writeConnectorAction(employee, input)
    const member = ctx.office.view(employee).me
    await ctx.office.saveMember(administrator, { ...member, role: 'manager' }, member)
    await expect(ctx.office.checkConnectorExecution(employee, original.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(reconcile).not.toHaveBeenCalled()
    expect((await ctx.office.connectorExecutionDetail(employee, original.id)).status).toBe('unknown')
  })

  it.each(['timeout', 'unload', 'close'] as const)('settles cooperative %s checks without inventing a result or replaying the business write', async (kind) => {
    const entered = Promise.withResolvers<undefined>()
    let stopped = false
    const write = vi.fn(async (): Promise<OfficeConnectorWriteResult> => ({ status: 'unknown' }))
    const { ctx, root, input, stop } = await prepared(write, { connectorTimeoutMs: 100 }, undefined, async ({ signal }) => {
      entered.resolve(undefined)
      await new Promise<void>((done) => { signal.addEventListener('abort', () => { stopped = true; done() }, { once: true }) })
      return success
    })
    const original = await ctx.office.writeConnectorAction(employee, input)
    const pending = ctx.office.checkConnectorExecution(employee, original.id)
    await entered.promise
    if (kind === 'unload') stop()
    if (kind === 'close') {
      const rejection = expect(pending).rejects.toMatchObject({ code: 'closed' })
      await ctx.fiber.dispose()
      await rejection
    } else expect(await pending).toMatchObject({ status: 'unknown', receipt: { id: original.id, status: 'unknown' } })
    expect(stopped).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    const disk = await readFile(join(root, 'data', 'enterprise_office_connector_executions.json'), 'utf8')
    expect(disk).toContain('unknown')
    expect(disk).not.toContain('OA-42')
  })

  it('reauthenticates the original checking session before storing or disclosing a late authoritative result', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const reconcile = vi.fn(async () => { entered.resolve(undefined); await release.promise; return success })
    const { ctx, input } = await prepared(async () => ({ status: 'unknown' }), {}, undefined, reconcile)
    const original = await ctx.office.writeConnectorAction(employee, input)
    const password = 'Outcome check test password!'
    await ctx.office.initializeIdentity(administrator, password)
    await ctx.office.setIdentityPassword(administrator, employee, password)
    const signed = await ctx.office.login({ memberId: employee, password })
    await expect(executeOfficeRequest(ctx.office, signed.token, { method: 'checkConnectorExecution', args: [original.id, administrator] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    const pending = executeOfficeRequest(ctx.office, signed.token, { method: 'checkConnectorExecution', args: [original.id] })
    try {
      await entered.promise
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 60 * 60 * 1000)
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'unauthenticated' })
    } finally { release.resolve(undefined); await pending.catch(() => {}); vi.restoreAllMocks() }
    expect(await ctx.office.connectorExecutionDetail(employee, original.id)).toEqual(original)
  })

  it('persists dispatch before a real HTTP POST, sends server identity and fresh credentials, and exact retries never send again', async () => {
    const received: { method: string | undefined; authorization: string | undefined; id: string | undefined; body: string }[] = []
    const origin = await system((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        received.push({ method: request.method, authorization: request.headers.authorization,
          id: typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : undefined, body })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(success))
      })
    })
    let root = ''
    const write = vi.fn(async (request: OfficeConnectorWriteRequest): Promise<OfficeConnectorWriteResult> => {
      const disk: unknown = JSON.parse(await readFile(join(root, 'data', 'enterprise_office_connector_executions.json'), 'utf8'))
      expect(JSON.stringify(disk)).toContain('dispatched')
      const response = await fetch(new URL('requests', request.baseUrl), { method: 'POST', signal: request.signal,
        redirect: 'manual', headers: { ...request.headers, 'idempotency-key': request.executionId, 'content-type': 'application/json' },
        body: JSON.stringify({ member: request.member, values: request.values }) })
      return await response.json() as OfficeConnectorWriteResult
    })
    const value = await prepared(write, {}, origin)
    root = value.root
    expect(value.directory.writeSupported).toBe(true)
    await value.ctx.credentials.set(credentialRef(value.ref), 'rotated-write-private-secret')
    const receipt = await value.ctx.office.writeConnectorAction(employee, value.input)
    expect(receipt).toMatchObject({ status: 'succeeded', revision: 3, result: success.status === 'succeeded' ? success.result : undefined })
    expect(received).toEqual([{ method: 'POST', authorization: 'Bearer rotated-write-private-secret', id: receipt.id,
      body: JSON.stringify({ member: { id: employee, role: 'employee' }, values: value.input.values }) }])
    expect(receipt.id).not.toBe(value.input.requestId)
    expect(JSON.stringify(receipt)).not.toMatch(/private-secret|Approved reason|"values"/)
    await value.ctx.office.saveConnection(administrator, { ...value.connection, revision: 1, requestId: randomUUID(), enabled: false })
    value.stop()
    expect(await value.ctx.office.writeConnectorAction(employee, value.input)).toEqual(receipt)
    expect(write).toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(1)
  })

  it.each(['unknown', 'throw', 'malformed', 'oversized'] as const)('does not replay %s results with either the same or a new retry UUID', async (mode) => {
    const failure = new Error('private upstream diagnostic write-fixture-private-secret')
    const write = vi.fn(async (): Promise<OfficeConnectorWriteResult> => {
      if (mode === 'throw') throw failure
      if (mode === 'unknown') return { status: 'unknown' }
      if (mode === 'malformed') return { status: 'succeeded', result: { summary: 'Accepted', entries: [], diagnostic: 'private' } } as OfficeConnectorWriteResult
      return { status: 'succeeded', result: { summary: '文'.repeat(600), entries: [] } }
    })
    const { ctx, root, input } = await prepared(write, { connectorWriteMaxResultBytes: 1024 })
    if (mode === 'unknown') expect(await ctx.office.writeConnectorAction(employee, input)).toMatchObject({ status: 'unknown' })
    else await expect(ctx.office.writeConnectorAction(employee, input)).rejects.toMatchObject({ code: 'execution_unknown' })
    const receipts = await ctx.office.connectorExecutions(employee)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ status: 'unknown' })
    expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(receipts[0])
    expect(await ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID(), adapterRevision: randomUUID(),
      values: { reason: input.values.reason!, title: input.values.title! } })).toEqual(receipts[0])
    expect(write).toHaveBeenCalledTimes(1)
    expect(await ctx.office.connectorExecutions(administrator)).toEqual([])
    expect(await readFile(join(root, 'data', 'enterprise_office_connector_executions.json'), 'utf8')).not.toMatch(/private upstream|private-secret/)
  })

  it('records authoritative nonacceptance without inventing success or retrying it', async () => {
    const write = vi.fn(async (): Promise<OfficeConnectorWriteResult> => ({ status: 'rejected', rejection: 'denied' }))
    const { ctx, input } = await prepared(write)
    const receipt = await ctx.office.writeConnectorAction(employee, input)
    expect(receipt).toMatchObject({ status: 'rejected', rejection: 'denied' })
    expect(await ctx.office.writeConnectorAction(employee, input)).toEqual(receipt)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it.each(['reserve', 'dispatch', 'finish'] as const)('preserves conservative evidence after %s storage fails', async (phase) => {
    const write = vi.fn(async () => success)
    const { ctx, input, domain } = await prepared(write)
    const original = domain.global.set.bind(domain.global)
    let count = 0
    const failAt = phase === 'reserve' ? 1 : phase === 'dispatch' ? 2 : 3
    const fault = vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      if (++count === failAt) throw new Error('Injected execution commit failure')
      return original(value)
    })
    await expect(ctx.office.writeConnectorAction(employee, input)).rejects.toThrow()
    fault.mockRestore()
    const receipts = await ctx.office.connectorExecutions(employee)
    expect(receipts.map(entry => entry.status)).toEqual(phase === 'reserve' ? [] : [phase === 'dispatch' ? 'reserved' : 'unknown'])
    expect(write).toHaveBeenCalledTimes(phase === 'finish' ? 1 : 0)
    const retry = await ctx.office.writeConnectorAction(employee, input)
    expect(retry.status).toBe(phase === 'finish' ? 'unknown' : 'succeeded')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it.each(['role', 'action', 'version', 'fields', 'required', 'length', 'capture'] as const)('rejects invalid %s before reservation and network dispatch', async (mode) => {
    const write = vi.fn(async () => success)
    const { ctx, input } = await prepared(write)
    const invalid = { ...input,
      ...mode === 'action' ? { actionId: 'read-self' } : {},
      ...mode === 'version' ? { adapterRevision: randomUUID() } : {},
      ...mode === 'fields' ? { values: { ...input.values, employee_id: 'admin' } } : {},
      ...mode === 'required' ? { values: { title: '  ' } } : {},
      ...mode === 'length' ? { values: { title: 'x'.repeat(121) } } : {},
      ...mode === 'capture' ? { captureId: randomUUID() } : {},
    }
    await expect(ctx.office.writeConnectorAction(mode === 'role' ? administrator : employee,
      invalid as OfficeConnectorWriteInput)).rejects.toHaveProperty('code')
    expect(await ctx.office.connectorExecutions(employee)).toEqual([])
    expect(write).not.toHaveBeenCalled()
  })

  it('cold-restores a committed-but-unconfirmed HTTP write without replaying it after provider restart', async () => {
    let committed = 0
    const origin = await system((request, response) => { request.resume(); request.on('end', () => {
      committed++; response.end('{}')
    }) })
    const write = vi.fn(async (request: OfficeConnectorWriteRequest): Promise<OfficeConnectorWriteResult> => {
      await fetch(new URL('requests', request.baseUrl), { method: 'POST', signal: request.signal, body: '{}' })
      return { status: 'unknown' }
    })
    const { ctx, root, input } = await prepared(write, {}, origin)
    const receipt = await ctx.office.writeConnectorAction(employee, input)
    await ctx.fiber.dispose()
    const restored = await boot({ connectorAllowedOrigins: [origin] }, root)
    restored.ctx.office.registerConnector({ id: 'business-write', actions, probe: async () => ({ status: 'connected' }), write })
    expect(await restored.ctx.office.writeConnectorAction(employee, input)).toEqual(receipt)
    expect(await restored.ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID(),
      adapterRevision: randomUUID(), connectionRevision: 2 })).toEqual(receipt)
    expect(write).toHaveBeenCalledTimes(1)
    expect(committed).toBe(1)
  })

  it('rechecks session authority after admission, retaining the actual result without disclosing it to an expired token', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const write = vi.fn(async () => { entered.resolve(undefined); await release.promise; return success })
    const { ctx, input } = await prepared(write)
    const password = 'Business write test password!'
    await ctx.office.initializeIdentity(administrator, password)
    await ctx.office.setIdentityPassword(administrator, employee, password)
    const signed = await ctx.office.login({ memberId: employee, password })
    for (const extra of [{ actorId: administrator }, { role: 'admin' }, { baseUrl: 'https://unapproved.invalid' }]) {
      await expect(executeOfficeRequest(ctx.office, signed.token, { method: 'writeConnectorAction', args: [{ ...input, ...extra }] }))
        .rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(write).not.toHaveBeenCalled()
    const pending = executeOfficeRequest(ctx.office, signed.token, { method: 'writeConnectorAction', args: [input] })
    try {
      await entered.promise
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 60 * 60 * 1000)
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'unauthenticated' })
    } finally { release.resolve(undefined); await pending.catch(() => {}); vi.restoreAllMocks() }
    expect((await ctx.office.connectorExecutions(employee))[0]?.status).toBe('succeeded')
    expect((await ctx.office.writeConnectorAction(employee, input)).status).toBe('succeeded')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it.each(['unload', 'close'] as const)('aborts on %s, waits for the adapter and durably preserves unknown evidence', async (mode) => {
    const entered = Promise.withResolvers<undefined>()
    let settled = false
    const { ctx, root, input, stop } = await prepared(async ({ signal }) => {
      entered.resolve(undefined)
      await new Promise<void>((done) => { signal.addEventListener('abort', () => { done() }, { once: true }) })
      settled = true
      return success
    })
    const pending = ctx.office.writeConnectorAction(employee, input)
    await entered.promise
    if (mode === 'unload') {
      stop()
      expect((await pending).status).toBe('unknown')
    } else {
      const rejection = expect(pending).rejects.toMatchObject({ code: 'closed' })
      await ctx.fiber.dispose()
      await rejection
    }
    expect(settled).toBe(true)
    const saved = await readFile(join(root, 'data', 'enterprise_office_connector_executions.json'), 'utf8')
    expect(saved).toContain('unknown')
    expect(saved).not.toContain('OA-42')
  })

  it('does not enter a replacement writer after asynchronous directory admission', async () => {
    const write = vi.fn(async () => success)
    const replacement = vi.fn(async () => success)
    const { ctx, input, stop, directory } = await prepared(write)
    vi.spyOn(OfficeConnectorRepository.prototype, 'actions').mockImplementationOnce(async () => {
      stop()
      ctx.office.registerConnector({ id: 'business-write', actions, probe: async () => ({ status: 'connected' }), write: replacement })
      return directory
    })
    await expect(ctx.office.writeConnectorAction(employee, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(await ctx.office.connectorExecutions(employee)).toEqual([])
    expect(write).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  })

  it('does not invoke an unloaded provider after the dispatch commit and leaves conservative evidence', async () => {
    const write = vi.fn(async () => success)
    const { ctx, input, domain, stop } = await prepared(write)
    const original = domain.global.set.bind(domain.global)
    let writes = 0
    vi.spyOn(domain.global, 'set').mockImplementation(async (value) => {
      await original(value)
      if (++writes === 2) stop()
    })
    await expect(ctx.office.writeConnectorAction(employee, input)).rejects.toMatchObject({ code: 'execution_unknown' })
    expect((await ctx.office.connectorExecutions(employee))[0]?.status).toBe('unknown')
    expect(write).not.toHaveBeenCalled()
  })

  it('records timeout after an actual external commit as unknown and never sends the operation again', async () => {
    let committed = 0
    const origin = await system((request, response) => {
      request.resume()
      request.on('end', () => { committed++; response.writeHead(200); response.write('{') })
    })
    let settled = false
    const write = vi.fn(async (request: OfficeConnectorWriteRequest): Promise<OfficeConnectorWriteResult> => {
      try {
        const response = await fetch(new URL('requests', request.baseUrl), { method: 'POST', signal: request.signal, body: '{}' })
        return await response.json() as OfficeConnectorWriteResult
      } finally { settled = true }
    })
    const { ctx, input } = await prepared(write, { connectorTimeoutMs: 100 }, origin)
    const receipt = await ctx.office.writeConnectorAction(employee, input)
    expect(receipt.status).toBe('unknown')
    expect(settled).toBe(true)
    expect(committed).toBe(1)
    expect(await ctx.office.writeConnectorAction(employee, { ...input, requestId: randomUUID() })).toEqual(receipt)
    expect(committed).toBe(1)
  })
})

describe('Authorized company business reads', () => {
  const actions: readonly OfficeConnectorActionDeclaration[] = [
    { id: 'read-self', label: 'My records', description: '', kind: 'read', allowedRoles: ['employee'] },
    { id: 'admin-report', label: 'Company report', description: '', kind: 'read', allowedRoles: ['admin'] },
    { id: 'write-record', label: 'Write record', description: '', kind: 'write', allowedRoles: ['employee'] },
  ]
  async function prepared(read: (request: OfficeConnectorReadRequest) => Promise<OfficeConnectorReadResult>,
    overrides: Partial<Config> = {}, address?: string) {
    const origin = address ?? await system((_request, response) => { response.end('{}') })
    const value = await boot({ connectorAllowedOrigins: [origin], ...overrides })
    await value.ctx.credentials.set(credentialRef(value.ref), 'read-fixture-private-secret')
    const probe = vi.fn(async () => ({ status: 'connected' as const }))
    const stop = value.ctx.office.registerConnector({ id: 'business-read', actions, probe, read })
    const connection = { ...await configuration(value.ctx, origin), adapterId: 'business-read' }
    await value.ctx.office.saveConnection(administrator, connection)
    const directory = await value.ctx.office.connectorActions(employee, connection.integrationId)
    if (!directory.adapterRevision) throw new Error('Expected an active read provider')
    const input: OfficeConnectorReadInput = { integrationId: connection.integrationId, actionId: 'read-self',
      connectionRevision: 1, adapterRevision: directory.adapterRevision }
    return { ...value, probe, stop, connection, input, directory }
  }

  it('queries a real GET system with the current employee and rotated server-only credentials', async () => {
    const observed: { path: string | undefined; authorization: string | undefined }[] = []
    const origin = await system((request, response) => {
      expect(request.method).toBe('GET')
      observed.push({ path: request.url, authorization: request.headers.authorization })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ summary: 'Current authorized records', entries: [{ label: 'Pending', value: '3' }] }))
    })
    const read = vi.fn(async (request: OfficeConnectorReadRequest): Promise<OfficeConnectorReadResult> => {
      const response = await fetch(new URL('records/' + encodeURIComponent(request.member.id), request.baseUrl), {
        method: 'GET', headers: request.headers, signal: request.signal, redirect: 'manual',
      })
      const data: unknown = await response.json()
      return connectorReadResultSchema(request.maxEntries).parse({ status: 'read', data })
    })
    const { ctx, root, ref, input, directory, probe } = await prepared(read, {}, origin)
    expect(directory.readSupported).toBe(true)
    const before = await readFile(join(root, 'data', 'enterprise_office_connectors.json'))
    const first = await ctx.office.readConnectorAction(employee, input)
    expect(first).toMatchObject({ ...input, status: 'read', data: { summary: 'Current authorized records',
      entries: [{ label: 'Pending', value: '3' }] } })
    await ctx.credentials.set(credentialRef(ref), 'rotated-read-fixture-secret')
    await ctx.office.readConnectorAction(employee, input)
    expect(observed).toEqual([
      { path: '/api/records/lin', authorization: 'Bearer read-fixture-private-secret' },
      { path: '/api/records/lin', authorization: 'Bearer rotated-read-fixture-secret' },
    ])
    expect(read.mock.calls[0]?.[0].member).toEqual({ id: employee, role: 'employee' })
    expect(JSON.stringify(first)).not.toMatch(/fixture.*secret|authorization|baseUrl|allowedRoles/)
    expect(await readFile(join(root, 'data', 'enterprise_office_connectors.json'))).toEqual(before)
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects undeclared, write, disallowed-role and stale requests before calling the read adapter', async () => {
    const read = vi.fn(async () => ({ status: 'read' as const, data: { summary: 'Allowed', entries: [] } }))
    const { ctx, input, connection } = await prepared(read)
    for (const actionId of ['missing', 'write-record', 'admin-report']) {
      await expect(ctx.office.readConnectorAction(employee, { ...input, actionId })).rejects.toMatchObject({ code: 'forbidden' })
    }
    await expect(ctx.office.readConnectorAction(administrator, input)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.readConnectorAction(employee, { ...input, adapterRevision: randomUUID() }))
      .rejects.toMatchObject({ code: 'conflict' })
    await ctx.office.saveConnection(administrator, { ...connection, revision: 1, requestId: randomUUID(), probePath: 'new-health' })
    await expect(ctx.office.readConnectorAction(employee, input)).rejects.toMatchObject({ code: 'conflict' })
    await ctx.office.saveConnection(administrator, { ...connection, revision: 2, requestId: randomUUID(), enabled: false })
    await expect(ctx.office.readConnectorAction(employee, { ...input, connectionRevision: 3 }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(read).not.toHaveBeenCalled()
  })

  it('discovers and queries only an owned current conversation capture, without an administrator bypass', async () => {
    const read = vi.fn(async () => ({ status: 'read' as const, data: { summary: 'Authorized native result', entries: [] } }))
    const { ctx, input } = await prepared(read)
    const conversationId = 'captured-system-query' as OfficeConversationId
    await ctx.office.saveConversationLinks(employee, { conversationId, revision: 0, requestId: randomUUID(),
      kind: 'integrations', integrations: [input.integrationId] })
    const capture = await ctx.office.captureConversation(employee, { conversationId, revision: 1, requestId: 'native-query-1' })
    const discovery = { captureId: capture.id, integrationId: input.integrationId }
    expect(await ctx.office.conversationConnectorActions(employee, discovery)).toMatchObject({
      connectionRevision: 1, adapterRevision: input.adapterRevision, readSupported: true,
    })
    const native = { ...input, captureId: capture.id }
    expect(await ctx.office.readConnectorActionFromConversation(employee, native)).toMatchObject({ status: 'read',
      data: { summary: 'Authorized native result' } })
    expect(read).toHaveBeenCalledOnce()
    await expect(ctx.office.conversationConnectorActions(administrator, discovery)).rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.readConnectorActionFromConversation(administrator, native)).rejects.toMatchObject({ code: 'not_found' })
    await ctx.office.saveConversationLinks(employee, { conversationId, revision: 1, requestId: randomUUID(),
      kind: 'integrations', integrations: [] })
    await expect(ctx.office.conversationConnectorActions(employee, discovery)).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.readConnectorActionFromConversation(employee, native)).rejects.toMatchObject({ code: 'conflict' })
    expect(read).toHaveBeenCalledOnce()
  })

  it('refuses an unselected or changed captured connection and a changed current role before native reads', async () => {
    const read = vi.fn(async () => ({ status: 'read' as const, data: { summary: 'Not reached', entries: [] } }))
    const { ctx, input, connection } = await prepared(read)
    const conversationId = 'captured-system-versions' as OfficeConversationId
    const empty = await ctx.office.captureConversation(employee, { conversationId, revision: 0, requestId: 'unselected' })
    await expect(ctx.office.conversationConnectorActions(employee, { captureId: empty.id, integrationId: input.integrationId }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await ctx.office.saveConversationLinks(employee, { conversationId, revision: 0, requestId: randomUUID(),
      kind: 'integrations', integrations: [input.integrationId] })
    const capture = await ctx.office.captureConversation(employee, { conversationId, revision: 1, requestId: 'selected' })
    await ctx.office.saveConnection(administrator, { ...connection, revision: 1, requestId: randomUUID(), probePath: 'changed-health' })
    await expect(ctx.office.conversationConnectorActions(employee, { captureId: capture.id, integrationId: input.integrationId }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.readConnectorActionFromConversation(employee, { ...input, connectionRevision: 2, captureId: capture.id }))
      .rejects.toMatchObject({ code: 'conflict' })
    const member = ctx.office.view(administrator).members.find(row => row.id === employee)!
    await ctx.office.saveMember(administrator, { ...member, role: 'manager' }, member)
    await expect(ctx.office.conversationConnectorActions(employee, { captureId: capture.id, integrationId: input.integrationId }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.readConnectorActionFromConversation(employee, { ...input, captureId: capture.id }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects forged wire arguments and expires the originating session before disclosing a late result', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const read = vi.fn(async () => { entered.resolve(undefined); await release.promise
      return { status: 'read' as const, data: { summary: 'Private result', entries: [] } } })
    const { ctx, input } = await prepared(read)
    await ctx.office.initializeIdentity(administrator, 'Business read test password!')
    await ctx.office.setIdentityPassword(administrator, employee, 'Business read test password!')
    const signed = await ctx.office.login({ memberId: employee, password: 'Business read test password!' })
    for (const extra of [{ role: 'admin' }, { actorId: administrator }, { baseUrl: 'https://unapproved.invalid' }]) {
      await expect(executeOfficeRequest(ctx.office, signed.token, { method: 'readConnectorAction', args: [{ ...input, ...extra }] }))
        .rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(read).not.toHaveBeenCalled()
    const pending = executeOfficeRequest(ctx.office, signed.token, { method: 'readConnectorAction', args: [input] })
    try {
      await entered.promise
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 60 * 60 * 1000)
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ code: 'unauthenticated' })
    } finally { release.resolve(undefined); await pending.catch(() => {}); vi.restoreAllMocks() }
  })

  it('discards a provider result after unload and observes its abort before settlement', async () => {
    const entered = Promise.withResolvers<undefined>()
    let aborted = false
    const { ctx, input, stop } = await prepared(async ({ signal }) => {
      entered.resolve(undefined)
      await new Promise<void>((done) => { signal.addEventListener('abort', () => { aborted = true; done() }, { once: true }) })
      return { status: 'read', data: { summary: 'Late private result', entries: [] } }
    })
    const pending = ctx.office.readConnectorAction(employee, input)
    await entered.promise
    stop()
    await expect(pending).rejects.toMatchObject({ code: 'conflict' })
    expect(aborted).toBe(true)
  })

  it('rejects a replacement installed after directory resolution and before read admission', async () => {
    const read = vi.fn(async () => ({ status: 'read' as const, data: { summary: 'Original provider', entries: [] } }))
    const replacement = vi.fn(async () => ({ status: 'read' as const, data: { summary: 'Replacement provider', entries: [] } }))
    const { ctx, input, stop, probe, directory } = await prepared(read)
    vi.spyOn(OfficeConnectorRepository.prototype, 'actions').mockImplementationOnce(async () => {
      stop()
      ctx.office.registerConnector({ id: 'business-read', actions, probe, read: replacement })
      return directory
    })
    await expect(ctx.office.readConnectorAction(employee, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(read).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('reports a cooperative deadline after an aborted adapter %s', async (settlement) => {
    const { ctx, input } = await prepared(async ({ signal }) => {
      await new Promise<void>((done) => { signal.addEventListener('abort', () => { done() }, { once: true }) })
      if (settlement === 'reject') throw new DOMException('Private remote diagnostic', 'AbortError')
      return { status: 'read', data: { summary: 'Too late', entries: [] } }
    }, { connectorTimeoutMs: 100 })
    expect(await ctx.office.readConnectorAction(employee, input)).toMatchObject({ status: 'timed_out' })
  })

  it('drains an aborted read before office shutdown completes and never discloses its result', async () => {
    const entered = Promise.withResolvers<undefined>()
    let settled = false
    const { ctx, input } = await prepared(async ({ signal }) => {
      entered.resolve(undefined)
      await new Promise<void>((done) => { signal.addEventListener('abort', () => { done() }, { once: true }) })
      settled = true
      return { status: 'read', data: { summary: 'Late result', entries: [] } }
    })
    const pending = ctx.office.readConnectorAction(employee, input)
    await entered.promise
    const rejection = expect(pending).rejects.toMatchObject({ code: 'closed' })
    await ctx.fiber.dispose()
    await rejection
    expect(settled).toBe(true)
  })

  it.each(['count', 'bytes', 'shape', 'failure-data'] as const)('rejects an invalid %s result without retaining its fields', async (kind) => {
    const data = { summary: kind === 'bytes' ? '文'.repeat(400) : 'Private result',
      entries: [{ label: 'One', value: 'A' }, { label: 'Two', value: 'B' }] }
    const output = kind === 'shape' ? { status: 'read', data: { ...data, secret: 'must-not-cross' } }
      : kind === 'failure-data' ? { status: 'unauthorized', data } : { status: 'read', data }
    const { ctx, input } = await prepared(async () => output as OfficeConnectorReadResult,
      { connectorReadMaxEntries: kind === 'count' ? 1 : 100, connectorReadMaxBytes: 1024 })
    const receipt = await ctx.office.readConnectorAction(employee, input)
    expect(receipt).toEqual({ ...input, checkedAt: receipt.checkedAt, status: 'invalid_response' })
    expect(Number.isSafeInteger(receipt.checkedAt)).toBe(true)
  })
})

describe('Company connection configuration and private probing', () => {
  it('keeps manifests unconnected and resolves rotated credentials for actual bounded GET requests', async () => {
    const received: string[] = []
    const origin = await system((request, response) => {
      received.push(request.headers.authorization ?? '')
      expect(request.method).toBe('GET')
      expect(request.url).toBe('/api/health')
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ secretEcho: request.headers.authorization }))
    })
    const { ctx, root, ref } = await boot({ connectorAllowedOrigins: [origin] })
    const input = await configuration(ctx, origin)
    expect((await ctx.office.connections(administrator)).entries).toEqual([])
    const saved = await ctx.office.saveConnection(administrator, input)
    expect(saved.status).toBe('credential_missing')
    expect(received).toEqual([])
    await ctx.credentials.set(credentialRef(ref), 'fixture-secret-one')
    const view = await ctx.office.connections(administrator)
    expect(view.entries[0]?.status).toBe('unverified')
    expect(view.credentialAliases).toEqual(['oa-key'])
    const first = await ctx.office.probeConnection(administrator, input.integrationId, saved.revision)
    expect(first).toMatchObject({ status: 'connected', httpStatus: 200, revision: 1 })
    await ctx.credentials.set(credentialRef(ref), 'fixture-secret-two')
    expect((await ctx.office.probeConnection(administrator, input.integrationId, saved.revision)).status).toBe('connected')
    expect(received).toEqual(['Bearer fixture-secret-one', 'Bearer fixture-secret-two'])
    const employeeView = await ctx.office.connections(employee)
    expect(employeeView.entries[0]).not.toHaveProperty('configuration')
    expect(employeeView).not.toHaveProperty('allowedOrigins')
    expect(employeeView).not.toHaveProperty('credentialAliases')
    const publicData = JSON.stringify({ view, employeeView, first })
    expect(publicData).not.toContain('fixture-secret')
    expect(publicData).not.toContain(ref)
    const disk = await readFile(join(root, 'data', 'enterprise_office_connectors.json'), 'utf8')
    expect(disk).not.toContain('fixture-secret')
    expect(disk).not.toContain(ref)
    expect((await ctx.office.connections(administrator)).entries[0]?.status).toBe('unverified')
  })

  it('admits only administrator-owned versioned operations through the explicit office RPC list', async () => {
    const origin = await system(() => { throw new Error('Denied operation reached the system') })
    const { ctx } = await boot({ connectorAllowedOrigins: [origin] })
    const input = await configuration(ctx, origin)
    const password = 'Connector fixture password 2026!'
    await ctx.office.initializeIdentity(administrator, password)
    await ctx.office.setIdentityPassword(administrator, employee, password)
    const adminLogin = await ctx.office.login({ memberId: administrator, password })
    const employeeLogin = await ctx.office.login({ memberId: employee, password })
    await expect(executeOfficeRequest(ctx.office, employeeLogin.token, { method: 'saveConnection', args: [input] }))
      .rejects.toMatchObject({ code: 'forbidden' })
    const saved = await executeOfficeRequest(ctx.office, adminLogin.token, { method: 'saveConnection', args: [input] })
    expect(saved).toMatchObject({ revision: 1 })
    await expect(executeOfficeRequest(ctx.office, employeeLogin.token, { method: 'probeConnection', args: [input.integrationId, 1] }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(executeOfficeRequest(ctx.office, adminLogin.token, { method: 'probeConnection', args: [origin, 1] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(executeOfficeRequest(ctx.office, adminLogin.token, {
      method: 'saveConnection', args: [{ ...input, secret: 'inline' }],
    }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await ctx.office.saveMember(administrator, { ...ctx.office.view(employee).me, active: false })
    await expect(ctx.office.connections(employee)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('preserves exact retries, competing revisions, original bytes and configuration after restart', async () => {
    const origin = 'https://office.example.invalid'
    const { ctx, root } = await boot({ connectorAllowedOrigins: [origin] })
    const input = await configuration(ctx, origin)
    const names = ['enterprise_office.json', 'enterprise_office_integrations.json']
    const original = await Promise.all(names.map(name => readFile(join(root, 'data', name))))
    const saved = await ctx.office.saveConnection(administrator, input)
    expect(await ctx.office.saveConnection(administrator, input)).toEqual(saved)
    await expect(ctx.office.saveConnection(administrator, { ...input, probePath: 'different' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.saveConnection(administrator, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.probeConnection(administrator, input.integrationId, 9)).rejects.toMatchObject({ code: 'conflict' })
    const changed = await ctx.office.saveConnection(administrator, { ...input, revision: 1, requestId: randomUUID(), enabled: false })
    expect(changed).toMatchObject({ revision: 2, status: 'disabled' })
    expect(await Promise.all(names.map(name => readFile(join(root, 'data', name))))).toEqual(original)
    await ctx.fiber.dispose()
    const restarted = await boot({ connectorAllowedOrigins: [origin] }, root)
    expect((await restarted.ctx.office.connections(administrator)).entries).toEqual([changed])
  })

  it('rejects unapproved origins, arbitrary credential references and escaping or credential-bearing URLs before a request', async () => {
    const { ctx } = await boot({ connectorAllowedOrigins: ['https://office.example.invalid'] })
    const input = await configuration(ctx, 'https://office.example.invalid')
    for (const value of [
      { ...input, baseUrl: 'https://other.example.invalid' },
      { ...input, baseUrl: 'https://user:secret@office.example.invalid/' },
      { ...input, baseUrl: 'https://office.example.invalid/?key=secret' },
      { ...input, probePath: '../escape' }, { ...input, probePath: '%2e%2e/escape' },
      { ...input, probePath: '//other.example.invalid/' },
      { ...input, authentication: { kind: 'bearer', credential: 'DEEPSEEK_API_KEY' } },
      { ...input, authentication: { kind: 'bearer', credential: 'unapproved' } },
      { ...input, authentication: { kind: 'header', credential: 'oa-key', header: 'host' } },
      { ...input, adapterId: 'not-installed' },
    ] as const) await expect(ctx.office.saveConnection(administrator, value)).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await ctx.office.connections(administrator)).entries).toEqual([])
  })

  it.each([
    [401, '{}', 'unauthorized'], [403, '{}', 'unauthorized'], [429, '{}', 'rate_limited'],
    [500, '{}', 'http_error'], [200, '<html>sign in</html>', 'invalid_response'],
    [200, JSON.stringify('x'.repeat(63)), 'invalid_response'], [200, JSON.stringify('x'.repeat(62)), 'connected'],
    [200, JSON.stringify('汉'.repeat(21)), 'invalid_response'], [200, Buffer.from([0x22, 0xff, 0x22]), 'invalid_response'],
  ] as const)('reports HTTP %s without accepting an unusable response (%s)', async (status, body, expected) => {
    const origin = await system((_request, response) => { response.writeHead(status); response.end(body) })
    const { ctx } = await boot({ connectorAllowedOrigins: [origin], connectorMaxResponseBytes: 64 })
    const input = { ...await configuration(ctx, origin), authentication: { kind: 'none' as const } }
    const saved = await ctx.office.saveConnection(administrator, input)
    expect(await ctx.office.probeConnection(administrator, input.integrationId, saved.revision))
      .toMatchObject({ status: expected, httpStatus: status })
  })

  it('bounds delayed response bodies and never follows a credential-bearing redirect', async () => {
    let redirected = 0
    const destination = await system((_request, response) => { redirected++; response.end('{}') })
    const origin = await system((request, response) => {
      if (request.url?.endsWith('redirect')) { response.writeHead(302, { Location: destination }); response.end() }
      else { response.writeHead(200); response.write('{') }
    })
    const { ctx, ref } = await boot({ connectorAllowedOrigins: [origin, destination], connectorTimeoutMs: 100 })
    await ctx.credentials.set(credentialRef(ref), 'private-redirect-secret')
    const input = await configuration(ctx, origin)
    const saved = await ctx.office.saveConnection(administrator, input)
    expect((await ctx.office.probeConnection(administrator, input.integrationId, saved.revision)).status).toBe('timed_out')
    const changed = await ctx.office.saveConnection(administrator, { ...input, revision: 1, requestId: randomUUID(), probePath: 'redirect' })
    expect(await ctx.office.probeConnection(administrator, input.integrationId, changed.revision))
      .toMatchObject({ status: 'http_error', httpStatus: 302 })
    expect(redirected).toBe(0)
  })

  it('keeps failed storage unpublished and permits disabling after deployment policy is removed', async () => {
    const origin = 'https://office.example.invalid'
    const { ctx, root } = await boot({ connectorAllowedOrigins: [origin] })
    const input = await configuration(ctx, origin)
    const observed = vi.fn()
    ctx.on('office/integrations-changed', observed)
    const domain = ctx.storageDomain.get('enterprise_office_connectors')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Connection storage unavailable'))
    await expect(ctx.office.saveConnection(administrator, input)).rejects.toThrow('Connection storage unavailable')
    expect(observed).not.toHaveBeenCalled()
    expect((await ctx.office.connections(administrator)).entries).toEqual([])
    await ctx.office.saveConnection(administrator, input)
    expect(observed).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
    const restarted = await boot({}, root)
    expect((await restarted.ctx.office.connections(administrator)).entries[0]?.status).toBe('policy_blocked')
    expect((await restarted.ctx.office.probeConnection(administrator, input.integrationId, 1)).status).toBe('policy_blocked')
    expect(await restarted.ctx.office.saveConnection(administrator, { ...input, revision: 1, requestId: randomUUID(), enabled: false }))
      .toMatchObject({ status: 'disabled', revision: 2 })
  })

  it('removes a plugin adapter with its fiber and aborts an outstanding check before unload settles', async () => {
    const origin = 'https://office.example.invalid'
    const { ctx } = await boot({ connectorAllowedOrigins: [origin] })
    const entered = Promise.withResolvers<undefined>()
    const stopped = vi.fn()
    const fiber = ctx.plugin({ inject: ['office'], apply(context: Context) {
      context.effect(() => context.office.registerConnector({ id: 'company-custom', async probe({ signal }) {
        entered.resolve(undefined)
        await new Promise<void>((done) => { signal.addEventListener('abort', () => { stopped(); done() }, { once: true }) })
        return { status: 'timed_out' }
      } }))
    } })
    await fiber
    const input = { ...await configuration(ctx, origin), adapterId: 'company-custom', authentication: { kind: 'none' as const } }
    await ctx.office.saveConnection(administrator, input)
    const checking = ctx.office.probeConnection(administrator, input.integrationId, 1)
    await entered.promise
    await fiber.dispose()
    expect((await checking).status).toBe('adapter_unavailable')
    expect(stopped).toHaveBeenCalledOnce()
    expect((await ctx.office.connections(administrator)).entries[0]?.status).toBe('adapter_unavailable')
  })

  it('uses a custom authentication header and contains unavailable credential providers without revealing their errors', async () => {
    let received: string | string[] | undefined
    const origin = await system((request, response) => { received = request.headers['x-oa-key']; response.end('{}') })
    const { ctx, ref } = await boot({ connectorAllowedOrigins: [origin] })
    const input = { ...await configuration(ctx, origin),
      authentication: { kind: 'header' as const, credential: 'oa-key', header: 'X-OA-Key' } }
    await ctx.credentials.set(credentialRef(ref), 'fixture-private-header')
    const saved = await ctx.office.saveConnection(administrator, input)
    expect((await ctx.office.probeConnection(administrator, input.integrationId, 1)).status).toBe('connected')
    expect(received).toBe('fixture-private-header')
    vi.spyOn(ctx.credentials, 'resolve').mockRejectedValueOnce(new Error('private-provider-diagnostic'))
    const failed = await ctx.office.probeConnection(administrator, input.integrationId, 1)
    expect(failed.status).toBe('credential_unavailable')
    expect(JSON.stringify(failed)).not.toContain('private-provider-diagnostic')
    vi.spyOn(ctx.credentials, 'describe').mockRejectedValueOnce(new Error('private-provider-diagnostic'))
    expect((await ctx.office.connections(administrator)).entries[0]?.status).toBe('credential_unavailable')
    expect(saved.configuration?.authentication).toMatchObject({ header: 'x-oa-key' })
  })

  it('aborts a real response body and reaches quiescence when the whole Host closes', async () => {
    const entered = Promise.withResolvers<undefined>()
    const stopped = Promise.withResolvers<undefined>()
    const origin = await system((_request, response) => {
      response.on('close', () => { stopped.resolve(undefined) })
      response.writeHead(200); response.write('{')
      entered.resolve(undefined)
    })
    const { ctx } = await boot({ connectorAllowedOrigins: [origin] })
    const input = { ...await configuration(ctx, origin), authentication: { kind: 'none' as const } }
    await ctx.office.saveConnection(administrator, input)
    const service = ctx.office
    const checking = service.probeConnection(administrator, input.integrationId, 1)
    const outcome = expect(checking).rejects.toMatchObject({ code: 'closed' })
    await entered.promise
    await ctx.fiber.dispose()
    await outcome
    await stopped.promise
    expect(ctx.get('office')).toBeUndefined()
    await expect(service.connections(employee)).rejects.toMatchObject({ code: 'closed' })
  })

  it('drains an admitted configuration commit before closing storage and preserves it on restart', async () => {
    const origin = 'https://office.example.invalid'
    const { ctx, root } = await boot({ connectorAllowedOrigins: [origin] })
    const input = await configuration(ctx, origin)
    const domain = ctx.storageDomain.get('enterprise_office_connectors')!
    const write = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
      entered.resolve(undefined); await release.promise; await write(value)
    })
    const service = ctx.office
    const saving = service.saveConnection(administrator, input)
    await entered.promise
    const closing = ctx.fiber.dispose()
    try { await expect(service.saveConnection(administrator, input)).rejects.toMatchObject({ code: 'closed' }) }
    finally { release.resolve(undefined) }
    const saved = await saving
    await closing
    const restarted = await boot({ connectorAllowedOrigins: [origin] }, root)
    expect((await restarted.ctx.office.connections(administrator)).entries).toEqual([saved])
  })

  it('rechecks administrator authority after a queued demotion before sending any outbound request', async () => {
    let hits = 0
    const origin = await system((_request, response) => { hits++; response.end('{}') })
    const { ctx } = await boot({ connectorAllowedOrigins: [origin] })
    const actor = ctx.office.view(administrator).me
    await ctx.office.saveMember(administrator, { ...actor, id: brandString<OfficeMemberId>('second_admin') }, null)
    const input = { ...await configuration(ctx, origin), authentication: { kind: 'none' as const } }
    const domain = ctx.storageDomain.get('enterprise_office_connectors')!
    const write = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
      entered.resolve(undefined); await release.promise; await write(value)
    })
    const saving = ctx.office.saveConnection(administrator, input)
    await entered.promise
    const demoting = ctx.office.saveMember(administrator, { ...actor, role: 'employee' }, actor)
    const checking = ctx.office.probeConnection(administrator, input.integrationId, 1)
    const rejected = expect(checking).rejects.toMatchObject({ code: 'forbidden' })
    release.resolve(undefined)
    await saving; await demoting; await rejected
    expect(hits).toBe(0)
  })

  it.each(['missing-catalog', 'corrupt-connections'] as const)('refuses %s without replacing retained connection data', async (mode) => {
    const origin = 'https://office.example.invalid'
    const { ctx, root } = await boot({ connectorAllowedOrigins: [origin] })
    const input = await configuration(ctx, origin)
    await ctx.office.saveConnection(administrator, input)
    await ctx.fiber.dispose()
    const path = join(root, 'data', 'enterprise_office_connectors.json')
    if (mode === 'missing-catalog') await rm(join(root, 'data', 'enterprise_office_integrations.json'))
    else await writeFile(path, '{ invalid saved connections')
    const retained = await readFile(path)
    await expect(boot({ connectorAllowedOrigins: [origin] }, root)).rejects.toThrow('Office connector fixture did not activate')
    expect(await readFile(path)).toEqual(retained)
  })

  it('rejects malformed deployment policy during resolution', () => {
    const policy = { allowedOrigins: [], credentials: {}, timeoutMs: 5000, maxResponseBytes: 65536 }
    for (const value of [
      { ...policy, allowedOrigins: ['https://office.example.invalid/'] },
      { ...policy, allowedOrigins: ['https://a.invalid', 'https://a.invalid'] },
      { ...policy, credentials: { oa: 'not a reference' } }, { ...policy, timeoutMs: 0 }, { ...policy, maxResponseBytes: 0 },
    ]) expect(() => resolveOfficeConnectorPolicy(value)).toThrow()
  })
})

describe('Role-admitted connector action declarations', () => {
  const manager = brandString<OfficeMemberId>('manager')
  const actions: readonly OfficeConnectorActionDeclaration[] = [
    { id: 'read-self', label: 'Read my requests', description: 'Company action declaration', kind: 'read',
      allowedRoles: ['employee', 'manager'] },
    { id: 'approve-team', label: 'Review team requests', description: 'Manager declaration', kind: 'write', allowedRoles: ['manager'] },
    { id: 'admin-report', label: 'Company report', description: 'Administrator declaration', kind: 'read', allowedRoles: ['admin'] },
  ]

  it('uses current exact roles and public metadata without probing, executing or exposing configuration', async () => {
    let probes = 0
    const origin = await system((_request, response) => { probes++; response.end('{}') })
    const { ctx } = await boot({ connectorAllowedOrigins: [origin], members: [...seed.members,
      { id: manager, name: 'Manager', department: 'Operations', jobTitle: 'Manager', role: 'manager' }] })
    const input = await configuration(ctx, origin)
    expect(await ctx.office.connectorActions(employee, input.integrationId)).toMatchObject({
      status: 'unconfigured', connectionRevision: 0, adapterRevision: null, actions: [],
    })
    const stop = ctx.office.registerConnector({ id: 'business-actions', actions,
      async probe() { probes++; return { status: 'connected' } } })
    await ctx.office.saveConnection(administrator, { ...input, adapterId: 'business-actions', authentication: { kind: 'none' } })
    const visible = await ctx.office.connectorActions(employee, input.integrationId)
    expect(visible).toMatchObject({ status: 'unverified', connectionRevision: 1,
      actions: [{ id: 'read-self', label: 'Read my requests', kind: 'read' }] })
    expect(visible.adapterRevision).toMatch(/^[a-f0-9-]{36}$/)
    expect((await ctx.office.connectorActions(manager, input.integrationId)).actions.map(action => action.id))
      .toEqual(['read-self', 'approve-team'])
    expect((await ctx.office.connectorActions(administrator, input.integrationId)).actions.map(action => action.id))
      .toEqual(['admin-report'])
    expect(JSON.stringify(visible)).not.toContain('allowedRoles')
    expect(JSON.stringify(visible)).not.toContain(origin)
    expect(JSON.stringify(visible)).not.toContain('authentication')
    expect(probes).toBe(0)
    stop()
  })

  it('freezes declaration ownership, changes the registration coordinate on replacement and preserves disk bytes', async () => {
    const origin = await system((_request, response) => { response.end('{}') })
    const { ctx, root } = await boot({ connectorAllowedOrigins: [origin] })
    const declaration: { id: string; label: string; description: string; kind: 'read'; allowedRoles: Array<'employee' | 'admin'> } = {
      id: 'private-read', label: 'Original label', description: 'Public declaration', kind: 'read', allowedRoles: ['employee'],
    }
    const implementation = { id: 'immutable-actions', actions: [declaration],
      probe: async () => ({ status: 'connected' as const }) }
    const stop = ctx.office.registerConnector(implementation)
    const input = await configuration(ctx, origin)
    await ctx.office.saveConnection(administrator, { ...input, adapterId: implementation.id, authentication: { kind: 'none' } })
    const path = join(root, 'data', 'enterprise_office_connectors.json')
    const retained = await readFile(path)
    const before = await ctx.office.connectorActions(employee, input.integrationId)
    declaration.label = 'Changed outside registration'
    declaration.allowedRoles.push('admin')
    implementation.actions.length = 0
    expect((await ctx.office.connectorActions(employee, input.integrationId)).actions[0]?.label).toBe('Original label')
    expect((await ctx.office.connectorActions(administrator, input.integrationId)).actions).toEqual([])
    stop()
    expect(await ctx.office.connectorActions(employee, input.integrationId)).toMatchObject({
      status: 'adapter_unavailable', adapterRevision: null, actions: [],
    })
    ctx.office.registerConnector({ ...implementation, actions })
    const replaced = await ctx.office.connectorActions(employee, input.integrationId)
    expect(replaced.adapterRevision).not.toBe(before.adapterRevision)
    expect(replaced.connectionRevision).toBe(before.connectionRevision)
    expect(await readFile(path)).toEqual(retained)
  })

  it('rejects malformed declarations atomically and retains legacy probe-only registrations', async () => {
    const { ctx } = await boot()
    const valid = actions[0]!
    for (const invalid of [
      [{ ...valid, allowedRoles: [] }], [{ ...valid, allowedRoles: ['employee', 'employee'] }],
      [{ ...valid, allowedRoles: ['unknown'] }], [valid, valid], [{ ...valid, secret: 'must-not-be-published' }],
    ]) {
      expect(() => ctx.office.registerConnector({ id: 'reusable-actions', actions: invalid as readonly OfficeConnectorActionDeclaration[],
        async probe() { return { status: 'connected' } } })).toThrow('Invalid connector action declarations')
      expect((await ctx.office.connections(administrator)).adapters).not.toContain('reusable-actions')
    }
    ctx.office.registerConnector({ id: 'reusable-actions', actions, async probe() { return { status: 'connected' } } })
    ctx.office.registerConnector({ id: 'legacy-probe', async probe() { return { status: 'connected' } } })
    expect((await ctx.office.connections(employee)).adapters).toContain('legacy-probe')
  })

  it('bounds declaration count and complete UTF-8 metadata before reserving an adapter id', async () => {
    const { ctx } = await boot({ connectorActionMaxCount: 1, connectorActionMaxBytes: 1024 })
    const probe = async () => ({ status: 'connected' as const })
    expect(() => ctx.office.registerConnector({ id: 'bounded-actions', actions, probe })).toThrow('Invalid connector action declarations')
    const oversized = { ...actions[0]!, description: '文'.repeat(400) }
    expect(JSON.stringify(oversized).length).toBeLessThan(1024)
    expect(() => ctx.office.registerConnector({ id: 'bounded-actions', actions: [oversized], probe }))
      .toThrow('Connector action directory exceeds its configured byte limit')
    ctx.office.registerConnector({ id: 'bounded-actions', actions: [actions[0]!], probe })
    expect((await ctx.office.connections(employee)).adapters).toContain('bounded-actions')
  })

  it('keeps saved connections while requiring fresh process-local action registrations after restart', async () => {
    const origin = await system((_request, response) => { response.end('{}') })
    const { ctx, root } = await boot({ connectorAllowedOrigins: [origin] })
    ctx.office.registerConnector({ id: 'restart-actions', actions, async probe() { return { status: 'connected' } } })
    const input = await configuration(ctx, origin)
    await ctx.office.saveConnection(administrator, { ...input, adapterId: 'restart-actions', authentication: { kind: 'none' } })
    const previous = await ctx.office.connectorActions(employee, input.integrationId)
    await ctx.fiber.dispose()
    const restored = await boot({ connectorAllowedOrigins: [origin] }, root)
    expect(await restored.ctx.office.connectorActions(employee, input.integrationId)).toMatchObject({
      connectionRevision: 1, status: 'adapter_unavailable', adapterRevision: null, actions: [],
    })
    restored.ctx.office.registerConnector({ id: 'restart-actions', actions, async probe() { return { status: 'connected' } } })
    const current = await restored.ctx.office.connectorActions(employee, input.integrationId)
    expect(current.actions).toEqual(previous.actions)
    expect(current.adapterRevision).not.toBe(previous.adapterRevision)
  })

  it('rejects a directory read when its adapter unloads while credential presence is pending', async () => {
    const origin = await system((_request, response) => { response.end('{}') })
    const { ctx, ref } = await boot({ connectorAllowedOrigins: [origin] })
    await ctx.credentials.set(credentialRef(ref), 'action-directory-fixture-secret')
    const stop = ctx.office.registerConnector({ id: 'pending-actions', actions, async probe() { return { status: 'connected' } } })
    const input = await configuration(ctx, origin)
    await ctx.office.saveConnection(administrator, { ...input, adapterId: 'pending-actions' })
    const released = Promise.withResolvers<undefined>()
    const original = ctx.credentials.describe.bind(ctx.credentials)
    const held = vi.spyOn(ctx.credentials, 'describe').mockImplementation(async (reference) => {
      const result = await original(reference)
      await released.promise
      return result
    })
    const reading = ctx.office.connectorActions(employee, input.integrationId)
    try {
      await vi.waitFor(() => { expect(held).toHaveBeenCalledOnce() })
      stop()
      released.resolve(undefined)
      await expect(reading).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      released.resolve(undefined)
      await reading.catch(() => {})
    }
  })
})
