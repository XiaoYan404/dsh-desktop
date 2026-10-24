/** A real Loader, HTTP bridge and isolated JSON stores exercise OA v1 admission and original-key recovery. */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { listenHttp } from '@deepseek-ai/dsh-host-webserver'
import { brandString } from '@deepseek-ai/dsh-brand'
import OfficeService, { executeOfficeRequest } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { OfficeConnectorInput, OfficeConnectorReadInput, OfficeConnectorWriteInput, OfficeMemberId,
  OfficeOaConfig } from '../src/types.ts'
import { officeConnectorExecutionDomain } from '../src/connector-executions.ts'
import { createOaAdapter } from '../src/oa.ts'

const administrator = brandString<OfficeMemberId>('admin')
const employee = brandString<OfficeMemberId>('lin')
const unmapped = brandString<OfficeMemberId>('wei')
const contexts: Context[] = []
const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const bridgeErrors: unknown[] = []
const oa: OfficeOaConfig = { members: { lin: 'oa-lin' }, actions: [
  { id: 'my-approvals', label: 'My approvals', description: 'Read this actor only.', kind: 'read', allowedRoles: ['employee'] },
  { id: 'material-requirements', label: 'Material requirements', description: 'Read configured requirements.',
    kind: 'read', allowedRoles: ['employee'] },
  { id: 'submit-request', label: 'Submit request', description: 'Accept a request; this does not approve it.',
    kind: 'write', allowedRoles: ['employee'], fields: [
      { name: 'title', label: 'Title', required: true, maxLength: 40 },
      { name: 'reason', label: 'Reason', required: false, maxLength: 4000 },
    ] },
] }
const seed: Config = { companyName: 'OA bridge test', timeZone: 'Asia/Shanghai', members: [
  { id: administrator, name: 'Admin', department: 'Office', jobTitle: 'Admin', role: 'admin' },
  { id: employee, name: 'Lin', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
  { id: unmapped, name: 'Wei', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
] }
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-oa-'))
  roots.push(root)
  return root
}
async function boot(overrides: Partial<Config> = {}, existingRoot?: string) {
  const root = existingRoot ?? await home()
  const ref = 'OA_TEST_' + randomUUID().replaceAll('-', '').toUpperCase()
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
  if (!internal) throw new Error('OA fixture requires the Node Loader')
  ctx.loader.internal = new Proxy(internal, { get(target, key) {
    if (key === 'import') return async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error('Unexpected OA fixture module')
      return modules.get(specifier)
    }
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('OA fixture did not activate')
  return { ctx, root, ref }
}

const accepted = { status: 'succeeded' as const, result: { summary: 'Submission accepted; approval is pending.',
  entries: [{ label: 'Request', value: 'OA-LOCAL-1' }] } }
const storedReceipt = z.object({ protocol: z.literal(1), actor: z.string(), action: z.string(), executionId: z.uuid(),
  fingerprint: z.string(), outcome: z.object({ status: z.literal('succeeded'), result: z.object({ summary: z.string(),
    entries: z.array(z.object({ label: z.string(), value: z.string() })) }) }) })
const submitBody = z.object({ protocol: z.literal(1), actor: z.string(), action: z.string(), executionId: z.uuid(),
  values: z.record(z.string(), z.string()) }).strict()
interface BridgeMode {
  health: unknown
  readStatus: number
  readRaw: string | null
  readEcho: Record<string, unknown>
  readHang: boolean
  submitStatus: number
  submitEcho: Record<string, unknown>
  loseAcknowledgement: boolean
  checkStatus: number
  checkEcho: Record<string, unknown>
}
async function bridge(existing?: { root: string; port: number }) {
  const root = existing?.root ?? await home()
  const path = join(root, 'bridge.json')
  if (!existing) await writeFile(path, '[]')
  const mode: BridgeMode = { health: { protocol: 1 }, readStatus: 200, readRaw: null, readEcho: {}, readHang: false,
    submitStatus: 200, submitEcho: {}, loseAcknowledgement: false, checkStatus: 200, checkEcho: {} }
  const calls: { method: string; path: string; actor: string; action: string; key: string; authorization: string; body: string }[] = []
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const call = { method: request.method ?? '', path: url.pathname, actor: decodeURIComponent(String(request.headers['x-oa-actor'] ?? '')),
      action: String(request.headers['x-oa-action'] ?? ''), key: String(request.headers['idempotency-key'] ?? ''),
      authorization: request.headers.authorization ?? '', body }
    calls.push(call)
    response.setHeader('content-type', 'application/json')
    const reply = (value: unknown) => { response.end(JSON.stringify(value)) }
    if (url.pathname === '/oa/v1/health') { reply(mode.health); return }
    const read = /^\/oa\/v1\/actions\/([^/]+)\/read$/.exec(url.pathname)
    if (read) {
      response.statusCode = mode.readStatus
      if (mode.readHang) { response.flushHeaders(); return }
      if (mode.readStatus === 302) response.setHeader('location', '/oa/private-redirect')
      if (mode.readRaw !== null) { response.end(mode.readRaw); return }
      reply({ protocol: 1, actor: call.actor, action: read[1], data: {
        summary: read[1] === 'material-requirements' ? 'Provide verified materials.' : 'Approvals observed now.',
        entries: [{ label: 'Status', value: 'Pending approval' }],
      }, ...mode.readEcho }); return
    }
    const retained = z.array(storedReceipt).parse(JSON.parse(await readFile(path, 'utf8')))
    if (request.method === 'POST' && url.pathname === '/oa/v1/actions/submit-request/submit') {
      response.statusCode = mode.submitStatus
      if (mode.submitStatus !== 200) { reply({ error: 'Private bridge diagnostic' }); return }
      const input = submitBody.parse(JSON.parse(body))
      if (input.actor !== call.actor || input.executionId !== call.key) throw new Error('OA request context did not match')
      const fingerprint = createHash('sha256').update(JSON.stringify({ ...input,
        values: Object.fromEntries(Object.entries(input.values).sort(([left], [right]) => left.localeCompare(right))) })).digest('hex')
      let receipt = retained.find(row => row.executionId === input.executionId)
      if (receipt && receipt.fingerprint !== fingerprint) { response.statusCode = 409; reply({ error: 'Conflict' }); return }
      if (!receipt) {
        receipt = { protocol: 1, actor: input.actor, action: input.action, executionId: input.executionId, fingerprint, outcome: accepted }
        await writeFile(path, JSON.stringify([...retained, receipt]))
      }
      if (mode.loseAcknowledgement) { response.destroy(); return }
      const { fingerprint: _fingerprint, ...echo } = receipt
      reply({ ...echo, ...mode.submitEcho }); return
    }
    const key = /^\/oa\/v1\/executions\/([^/]+)$/.exec(url.pathname)?.[1]
    const receipt = retained.find(row => row.executionId === key && row.actor === call.actor && row.action === call.action)
    response.statusCode = mode.checkStatus === 200 && !receipt ? 404 : mode.checkStatus
    if (!receipt) { reply({ error: 'Unavailable' }); return }
    const { fingerprint: _fingerprint, ...echo } = receipt
    reply({ ...echo, ...mode.checkEcho })
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => { bridgeErrors.push(error); response.destroy() })
  })
  servers.push(server)
  const port = await listenHttp(server, { host: '127.0.0.1', port: existing?.port ?? 0, maxAttempts: 1 })
  async function stop(): Promise<void> {
    server.closeAllConnections()
    await new Promise<void>((done, reject) => server.close((error) => { if (error) reject(error); else done() }))
  }
  return { root, path, port, origin: `http://127.0.0.1:${port}`, mode, calls, stop }
}
async function configured(system: Awaited<ReturnType<typeof bridge>>, overrides: Partial<Config> = {}) {
  const value = await boot({ oa, connectorAllowedOrigins: [system.origin], ...overrides })
  await value.ctx.credentials.set(credentialRef(value.ref), 'oa-private-test-token')
  const integration = await value.ctx.office.importIntegration(administrator, { requestId: randomUUID(), json: JSON.stringify({
    name: 'local-oa-bridge', system: 'OA bridge v1', version: '1.0.0', provider: 'Test bridge',
    description: 'Product-owned bridge test, not a customer OA.', capabilities: ['Query', 'Submit'],
  }) })
  const connection: OfficeConnectorInput = { integrationId: integration.id, revision: 0, requestId: randomUUID(),
    adapterId: 'oa-bridge-v1', baseUrl: system.origin + '/oa/', probePath: 'v1/health',
    authentication: { kind: 'bearer', credential: 'oa-key' }, enabled: true }
  await value.ctx.office.saveConnection(administrator, connection)
  const directory = await value.ctx.office.connectorActions(employee, integration.id)
  if (!directory.adapterRevision) throw new Error('OA declaration directory is unavailable')
  const read: OfficeConnectorReadInput = { integrationId: integration.id, actionId: 'my-approvals', connectionRevision: 1,
    adapterRevision: directory.adapterRevision }
  const write: OfficeConnectorWriteInput = { ...read, actionId: 'submit-request', requestId: randomUUID(),
    values: { title: 'Reviewed purchase', reason: 'Verified material summary' } }
  return { ...value, connection, directory, read, write }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((done, reject) => server.close((error) => { if (error) reject(error); else done() }))
  }
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-oa-'))
      throw new Error('Unexpected OA test directory')
    await rm(absolute, { recursive: true, force: true })
  }
  expect(bridgeErrors.splice(0)).toEqual([])
})

it('stays opt-in and refuses ambiguous actors, malformed declarations and undeclared configuration', async () => {
  const { ctx } = await boot()
  expect((await ctx.office.connections(administrator)).adapters).not.toContain('oa-bridge-v1')
  const limits = { actionMaxCount: 100, actionMaxBytes: 262144 }
  for (const input of [
    { ...oa, members: { lin: 'same', wei: 'same' } },
    { ...oa, members: { lin: 'bad\r\nactor' } },
    { ...oa, actions: [...oa.actions, oa.actions[0]!] },
    { ...oa, actions: [{ ...oa.actions[0]!, fields: [{ name: 'id', label: 'Id', required: true, maxLength: 20 }] }] },
    { ...oa, baseUrl: 'https://unapproved.invalid' },
  ]) expect(() => createOaAdapter(input, limits)).toThrow()
})

it('uses fixed private-context HTTP paths and persists actual reads, material requirements and reviewed acceptance', async () => {
  const system = await bridge()
  const { ctx, root, connection, directory, read, write } = await configured(system)
  expect(system.calls).toEqual([])
  expect(directory).toMatchObject({ readSupported: true, writeSupported: true })
  expect(await ctx.office.probeConnection(administrator, connection.integrationId, 1)).toMatchObject({ status: 'connected' })
  const sync = { ...read, requestId: randomUUID() }
  const first = await ctx.office.syncConnectorAction(employee, sync)
  expect(first).toMatchObject({ available: true, data: { summary: 'Approvals observed now.' } })
  expect(await ctx.office.syncConnectorAction(employee, sync)).toEqual(first)
  expect(await ctx.office.readConnectorAction(employee, { ...read, actionId: 'material-requirements' }))
    .toMatchObject({ status: 'read', data: { summary: 'Provide verified materials.' } })
  const receipt = await ctx.office.writeConnectorAction(employee, write)
  expect(receipt).toMatchObject({ status: 'succeeded', result: accepted.result })
  expect(receipt.id).not.toBe(write.requestId)
  expect(await ctx.office.writeConnectorAction(employee, write)).toEqual(receipt)
  expect(system.calls.map(call => [call.method, call.path])).toEqual([
    ['GET', '/oa/v1/health'], ['GET', '/oa/v1/actions/my-approvals/read'],
    ['GET', '/oa/v1/actions/material-requirements/read'], ['POST', '/oa/v1/actions/submit-request/submit'],
  ])
  const submitted = system.calls.at(-1)!
  expect(submitted).toMatchObject({ actor: 'oa-lin', key: receipt.id, authorization: 'Bearer oa-private-test-token' })
  expect(JSON.parse(submitted.body)).toEqual({ protocol: 1, actor: 'oa-lin', action: write.actionId,
    executionId: receipt.id, values: write.values })
  expect(await readFile(join(root, 'data', 'enterprise_office_connector_executions.json'), 'utf8')).not.toContain('oa-private-test-token')
  expect(JSON.stringify(await ctx.office.connections(employee))).not.toMatch(/oa-private-test-token|127\.0\.0\.1|oa-key/)
})

it('restores committed but unacknowledged submissions across both store owners and only GETs the original server key', async () => {
  const system = await bridge()
  system.mode.loseAcknowledgement = true
  const { ctx, root, write } = await configured(system)
  const original = await ctx.office.writeConnectorAction(employee, write)
  expect(original.status).toBe('unknown')
  expect(await ctx.office.writeConnectorAction(employee, { ...write, requestId: randomUUID() })).toEqual(original)
  expect(system.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  await ctx.fiber.dispose()
  await system.stop()
  const restarted = await bridge({ root: system.root, port: system.port })
  const resumed = await boot({ oa, connectorAllowedOrigins: [restarted.origin] }, root)
  await resumed.ctx.credentials.set(credentialRef(resumed.ref), 'oa-rotated-test-token')
  expect(await resumed.ctx.office.writeConnectorAction(employee, write)).toEqual(original)
  expect(restarted.calls).toEqual([])
  const checked = await resumed.ctx.office.checkConnectorExecution(employee, original.id)
  expect(checked).toMatchObject({ status: 'updated', receipt: { id: original.id, requestId: write.requestId,
    status: 'succeeded', result: accepted.result } })
  expect(restarted.calls).toEqual([{ method: 'GET', path: `/oa/v1/executions/${original.id}`, actor: 'oa-lin',
    action: 'submit-request', key: '', authorization: 'Bearer oa-rotated-test-token', body: '' }])
  expect(await resumed.ctx.office.checkConnectorExecution(employee, original.id)).toEqual(checked)
  expect(restarted.calls).toHaveLength(1)
  expect(await resumed.ctx.office.connectorExecutions(administrator)).toEqual([])
})

it('rejects wrong actor, action, execution key, protocol and additional result properties before confirming an outcome', async () => {
  const system = await bridge()
  const { ctx, read, write } = await configured(system)
  for (const echo of [{ actor: 'another-actor' }, { action: 'another-action' }, { protocol: 2 }, { diagnostic: 'private' }]) {
    system.mode.readEcho = echo
    expect(await ctx.office.readConnectorAction(employee, read)).toMatchObject({ status: 'invalid_response' })
  }
  for (const [index, echo] of [{ actor: 'another-actor' }, { action: 'another-action' }, { executionId: randomUUID() },
    { protocol: 2 }, { diagnostic: 'private' }].entries()) {
    system.mode.submitEcho = echo
    const receipt = await ctx.office.writeConnectorAction(employee, { ...write, requestId: randomUUID(), values: { title: `Echo ${index}` } })
    expect(receipt.status).toBe('unknown')
    system.mode.checkEcho = echo
    expect(await ctx.office.checkConnectorExecution(employee, receipt.id)).toMatchObject({ status: 'unknown' })
    system.mode.checkEcho = {}
    expect(await ctx.office.checkConnectorExecution(employee, receipt.id)).toMatchObject({ status: 'updated', receipt: { status: 'succeeded' } })
  }
})

it('keeps read failures explicit and every uncertain business HTTP outcome unknown without retries or redirects', async () => {
  const system = await bridge()
  const { ctx, read, write } = await configured(system, { connectorTimeoutMs: 200, connectorMaxResponseBytes: 1024 })
  for (const [status, expected] of [[401, 'unauthorized'], [429, 'rate_limited'], [302, 'http_error']] as const) {
    system.mode.readStatus = status
    expect(await ctx.office.readConnectorAction(employee, read)).toMatchObject({ status: expected })
  }
  system.mode.readStatus = 200
  for (const raw of ['{', JSON.stringify({ protocol: 1, body: '文'.repeat(1024) })]) {
    system.mode.readRaw = raw
    expect(await ctx.office.readConnectorAction(employee, read)).toMatchObject({ status: 'invalid_response' })
  }
  system.mode.readRaw = null
  system.mode.readHang = true
  expect(await ctx.office.readConnectorAction(employee, read)).toMatchObject({ status: 'timed_out' })
  system.mode.readHang = false
  for (const status of [401, 429, 302]) {
    system.mode.submitStatus = status
    const receipt = await ctx.office.writeConnectorAction(employee, { ...write, requestId: randomUUID(), values: { title: `HTTP ${status}` } })
    expect(receipt.status).toBe('unknown')
    expect(await ctx.office.checkConnectorExecution(employee, receipt.id)).toMatchObject({ status: 'unknown' })
  }
  expect(system.calls.some(call => call.path.includes('private-redirect'))).toBe(false)
  expect(system.calls.filter(call => call.method === 'POST')).toHaveLength(3)
})

it('blocks unmapped employees, wrong roles, forged wire authority and undeclared fields without a bridge request', async () => {
  const system = await bridge()
  const { ctx, read, write } = await configured(system)
  expect(await ctx.office.readConnectorAction(unmapped, read)).toMatchObject({ status: 'unauthorized' })
  expect(await ctx.office.writeConnectorAction(unmapped, write)).toMatchObject({ status: 'rejected', rejection: 'denied' })
  await expect(ctx.office.readConnectorAction(administrator, read)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(ctx.office.writeConnectorAction(employee, { ...write, values: { title: 'Reviewed', actor: 'admin' } }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  await expect(ctx.office.writeConnectorAction(employee, { ...write, values: { title: 'x'.repeat(41) } }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  await ctx.office.initializeIdentity(administrator, 'OA bridge test password!')
  await ctx.office.setIdentityPassword(administrator, employee, 'OA bridge test password!')
  const signed = await ctx.office.login({ memberId: employee, password: 'OA bridge test password!' })
  for (const extra of [{ actor: 'oa-admin' }, { baseUrl: 'https://unapproved.invalid' }, { headers: {} }]) {
    await expect(executeOfficeRequest(ctx.office, signed.token, { method: 'writeConnectorAction', args: [{ ...write, ...extra }] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  }
  expect(system.calls).toEqual([])
})

it('sends nothing before a durable reservation and recovers failed outer result persistence by reading the retained bridge key', async () => {
  const system = await bridge()
  const { ctx, write } = await configured(system)
  const owner = ctx.storageDomain.get(officeConnectorExecutionDomain.name)
  if (!owner) throw new Error('OA execution domain is unavailable')
  const save = owner.global.set.bind(owner.global)
  const failure = vi.spyOn(owner.global, 'set').mockRejectedValueOnce(new Error('OA reservation test failure'))
  await expect(ctx.office.writeConnectorAction(employee, write)).rejects.toThrow('OA reservation test failure')
  expect(system.calls).toEqual([])
  failure.mockRestore()
  let saves = 0
  vi.spyOn(owner.global, 'set').mockImplementation(async (next) => {
    if (++saves === 3) throw new Error('OA result test failure')
    await save(next)
  })
  await expect(ctx.office.writeConnectorAction(employee, write)).rejects.toMatchObject({ code: 'execution_unknown' })
  const original = (await ctx.office.connectorExecutions(employee))[0]!
  expect(original.status).toBe('unknown')
  expect(await ctx.office.writeConnectorAction(employee, write)).toEqual(original)
  expect(await ctx.office.checkConnectorExecution(employee, original.id)).toMatchObject({ status: 'updated', receipt: { status: 'succeeded' } })
  expect(system.calls.map(call => call.method)).toEqual(['POST', 'GET'])
})
