/** Real listener, real Loader and real JSON commits exercise the shared office boundary. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Server as TcpServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService, { executeOfficeRequest } from '@deepseek-ai/dsh-enterprise-office'
import type { Config as OfficeConfig } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeConversationId, OfficeConversationLinksInput, OfficeLoginResult,
  OfficeMemberId, OfficeSessionInfo } from '@deepseek-ai/dsh-enterprise-office/types'
import OfficeGateway from '../src/index.ts'
import type { Config as GatewayConfig } from '../src/index.ts'

const administrator = 'admin' as OfficeMemberId
const employee = 'lin' as OfficeMemberId
const peer = 'chen' as OfficeMemberId
const password = 'Gateway test password 2026!'
const replacement = 'A replacement gateway password!'
const contexts: Context[] = []
const roots: string[] = []
type RpcValue<M extends string> = M extends keyof OfficeService
  ? OfficeService[M] extends (...args: never[]) => infer R ? Awaited<R> : never
  : never

async function boot(limit = 100, gatewayConfig: Partial<GatewayConfig> = {}, officeConfig: Partial<OfficeConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-gateway-'))
  roots.push(root)
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'data') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-enterprise-office', config: { companyName: 'HTTP office', timeZone: 'Asia/Shanghai', dshHome: root, members: [
      { id: administrator, name: 'Admin', department: 'Office', jobTitle: 'Admin', role: 'admin' },
      { id: employee, name: 'Lin', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
      { id: peer, name: 'Chen', department: 'Finance', jobTitle: 'Employee', role: 'employee' },
    ], ...officeConfig } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-enterprise-office', OfficeService],
    ['@deepseek-ai/dsh-enterprise-office-gateway', OfficeGateway],
  ])
  const internal = ctx.loader.internal
  if (!internal) throw new Error('The HTTP composition requires the Node Loader')
  ctx.loader.internal = new Proxy(internal, { get(target, key) {
    if (key === 'import') return async (name: string) => { if (!modules.has(name)) throw new Error('Unexpected fixture module'); return modules.get(name) }
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  await ctx.office.initializeIdentity(administrator, password)
  await ctx.office.setIdentityPassword(administrator, employee, password)
  await ctx.office.setIdentityPassword(administrator, peer, password)
  const entryId = await ctx.loader.create({ name: '@deepseek-ai/dsh-enterprise-office-gateway', config: {
    host: '127.0.0.1', port: 0, administratorId: administrator, loginRequestsPerMinute: limit, ...gatewayConfig,
  } })
  await ctx.loader.await()
  const entry = [...ctx.loader.entries()].find(row => row.id === entryId)!
  if (!ctx.get('officeGateway')) throw new Error('Office gateway did not activate')
  const address = ctx.officeGateway.address
  async function request(path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) {
    return fetch(address + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  async function signIn(memberId: OfficeMemberId = employee, secret = password): Promise<OfficeLoginResult> {
    const response = await request('/v1/login', { memberId, password: secret })
    expect(response.status).toBe(200)
    return (await response.json() as { value: OfficeLoginResult }).value
  }
  async function rpc<M extends string>(token: string, method: M, args: unknown[]) {
    const response = await request('/v1/rpc', { method, args }, token)
    return { status: response.status, body: await response.json() as { value: RpcValue<M> } }
  }
  return { ctx, root, entry, address, request, signIn, rpc }
}

it('authenticates action-directory reads and rejects caller-selected roles, actors and network arguments', async () => {
  const { ctx, signIn, rpc, request } = await boot(100, {}, { connectorAllowedOrigins: ['https://actions.company.invalid'] })
  const probe = vi.fn(async () => ({ status: 'connected' as const }))
  ctx.effect(() => ctx.office.registerConnector({ id: 'company-actions', probe, actions: [
    { id: 'read-self', label: 'Own records', description: '', kind: 'read', allowedRoles: ['employee'] },
    { id: 'admin-report', label: 'Company report', description: '', kind: 'read', allowedRoles: ['admin'] },
  ], async read({ member }) {
    return { status: 'read', data: { summary: 'Business records', entries: [{ label: 'Employee', value: member.id }] } }
  } }))
  const integration = await ctx.office.importIntegration(administrator, { requestId: randomUUID(), json: JSON.stringify({
    name: 'http-actions', system: 'Company actions', version: '1', provider: 'Company', description: 'Action metadata',
    capabilities: ['Query records'],
  }) })
  await ctx.office.saveConnection(administrator, { integrationId: integration.id, revision: 0, requestId: randomUUID(),
    adapterId: 'company-actions', baseUrl: 'https://actions.company.invalid/api/', probePath: 'health',
    authentication: { kind: 'none' }, enabled: true })
  const signed = await signIn()
  const own = await rpc(signed.token, 'connectorActions', [integration.id])
  expect(own.status).toBe(200)
  expect(own.body.value.actions.map(row => row.id)).toEqual(['read-self'])
  if (!own.body.value.adapterRevision) throw new Error('Expected a current read provider')
  const input = { integrationId: integration.id, actionId: 'read-self', connectionRevision: 1,
    adapterRevision: own.body.value.adapterRevision }
  const queried = await rpc(signed.token, 'readConnectorAction', [input])
  expect(queried.status).toBe(200)
  expect(queried.body.value).toMatchObject({ status: 'read', data: { entries: [{ label: 'Employee', value: employee }] } })
  for (const extra of [{ actorId: administrator }, { role: 'admin' }, { baseUrl: 'https://unapproved.invalid' }]) {
    expect((await rpc(signed.token, 'readConnectorAction', [{ ...input, ...extra }])).status).toBe(400)
  }
  expect((await rpc(signed.token, 'readConnectorAction', [{ ...input, actionId: 'admin-report' }])).status).toBe(403)
  for (const body of [
    { method: 'connectorActions', args: [integration.id], actorId: administrator },
    { method: 'connectorActions', args: [integration.id], role: 'admin' },
    { method: 'connectorActions', args: [{ integrationId: integration.id, role: 'admin' }] },
    { method: 'connectorActions', args: [integration.id, 'https://actions.company.invalid'] },
  ]) {
    const denied = await request('/v1/rpc', body, signed.token)
    expect(denied.status).toBe(400)
    await expect(denied.json()).resolves.toEqual({ ok: false, code: 'invalid_input' })
  }
  expect((await rpc(signed.token, 'connectorActions', [randomUUID()])).status).toBe(404)
  expect((await request('/v1/rpc', { method: 'connectorActions', args: [integration.id] })).status).toBe(401)
  await request('/v1/logout', {}, signed.token)
  expect((await rpc(signed.token, 'readConnectorAction', [input])).status).toBe(401)
  expect(probe).not.toHaveBeenCalled()
})

it('serves submitted file windows through real HTTP with private ownership and fresh ancestor authorization', async () => {
  const { ctx, signIn, rpc } = await boot()
  const signed = await signIn()
  const coworker = await signIn(peer)
  const admin = await signIn(administrator)
  const folder = await ctx.office.createDriveFolder(administrator, { space: 'shared', folderId: null, name: 'HTTP submitted files' })
  const bytes = Buffer.from('Actual HTTP submitted file bytes')
  const file = await ctx.office.uploadDriveFile(administrator, { space: 'shared', folderId: folder.id, name: 'http-file.txt',
    mediaType: 'text/plain', byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await ctx.office.driveFileInfo(employee, file.id)
  const conversationId = 'http-file-conversation' as OfficeConversationId
  const input = { conversationId, revision: 0, requestId: randomUUID(), files: [{ id: file.id, versionId: info.versionId }] }
  const saved = await rpc(signed.token, 'saveConversationFiles', [input])
  expect(saved.status).toBe(200)
  expect(saved.body.value.files[0]).toMatchObject({ id: file.id, name: file.name, sha256: info.sha256 })
  expect((await rpc(coworker.token, 'conversationFiles', [conversationId])).body.value.files).toEqual([])
  const preparation = { conversationId, revision: saved.body.value.revision, requestId: 'http-file-input' }
  const captured = await rpc(signed.token, 'captureConversationFiles', [preparation])
  expect(captured.status).toBe(200)
  const read = { captureId: captured.body.value.id, fileId: file.id, offset: 0, maxCharacters: 16384 }
  const content = await rpc(signed.token, 'readConversationFile', [read])
  expect(content.status).toBe(200)
  expect(content.body.value).toMatchObject({ text: bytes.toString('utf8'), nextOffset: null, file: { sha256: info.sha256 } })
  expect((await rpc(coworker.token, 'readConversationFile', [read])).status).toBe(404)
  expect((await rpc(admin.token, 'conversationFilesCapture', [captured.body.value.id])).status).toBe(404)
  expect((await rpc(signed.token, 'readConversationFile', [{ ...read, actorId: administrator }])).status).toBe(400)
  expect((await rpc(signed.token, 'readConversationFile', [{ ...read, maxCharacters: 16385 }])).status).toBe(400)
  expect((await rpc(signed.token, 'saveConversationFiles', [{ ...input,
    files: [{ ...input.files[0], name: 'Caller metadata is rejected' }] }])).status).toBe(400)
  await ctx.office.saveDrivePermissions(administrator, { id: folder.id, revision: folder.revision, defaultAccess: 'deny', grants: [] })
  expect((await rpc(signed.token, 'readConversationFile', [read])).status).toBe(404)
  expect((await rpc(signed.token, 'captureConversationFiles', [preparation])).status).toBe(404)
  expect((await rpc(signed.token, 'conversationFilesCapture', [captured.body.value.id])).status).toBe(200)
})

it('persists private conversation choices over authenticated HTTP without an administrator bypass or caller-selected actor', async () => {
  const { ctx, signIn, request, rpc } = await boot()
  const signed = await signIn()
  const coworker = await signIn(peer)
  const admin = await signIn(administrator)
  const conversationId = 'gateway-native-conversation' as OfficeConversationId
  const input: OfficeConversationLinksInput = { conversationId, revision: 0, requestId: randomUUID(), kind: 'tools',
    tools: [{ kind: 'template', name: 'minutes' }] }
  const saved = await rpc(signed.token, 'saveConversationLinks', [input])
  expect(saved.status).toBe(200)
  expect(saved.body.value).toMatchObject({ conversationId, revision: 1, tools: input.tools })
  expect((await rpc(signed.token, 'saveConversationLinks', [input])).body).toEqual(saved.body)
  const own = await rpc(signed.token, 'conversationLinks', [conversationId])
  expect(own.body.value).toMatchObject({ meId: employee, selection: saved.body.value })
  for (const token of [coworker.token, admin.token]) {
    expect((await rpc(token, 'conversationLinks', [conversationId])).body.value.selection)
      .toMatchObject({ revision: 0, tools: [], integrations: [] })
  }
  const forged = await request('/v1/rpc', { method: 'saveConversationLinks', args: [{ ...input, ownerId: peer }] }, signed.token)
  expect(forged.status).toBe(400)
  await expect(forged.json()).resolves.toMatchObject({ ok: false, code: 'invalid_input' })
  const malformed = await request('/v1/rpc', { method: 'saveConversationLinks', args: [{ ...input,
    tools: [{ kind: 'skill', name: '../not-a-skill' }] }] }, signed.token)
  expect(malformed.status).toBe(400)
  expect((await rpc(signed.token, 'conversationLinks', [conversationId])).body.value.selection).toEqual(saved.body.value)
  await ctx.office.logout(signed.token)
  expect((await request('/v1/rpc', { method: 'conversationLinks', args: [conversationId] }, signed.token)).status).toBe(401)
})

it('reports a full conversation ledger as a localized business conflict over HTTP', async () => {
  const { signIn, request, rpc } = await boot(100, {}, { conversationLinksMaxContexts: 1 })
  const signed = await signIn()
  const input: OfficeConversationLinksInput = { conversationId: 'first-conversation' as OfficeConversationId,
    revision: 0, requestId: randomUUID(), kind: 'tools', tools: [{ kind: 'template', name: 'minutes' }] }
  expect((await rpc(signed.token, 'saveConversationLinks', [input])).status).toBe(200)
  const rejected = await request('/v1/rpc', { method: 'saveConversationLinks', args: [{ ...input,
    requestId: randomUUID(), conversationId: 'second-conversation' }] }, signed.token)
  expect(rejected.status).toBe(409)
  await expect(rejected.json()).resolves.toMatchObject({ ok: false, code: 'conversation_capacity' })
  expect((await rpc(signed.token, 'conversationLinks', [input.conversationId])).body.value.selection.revision).toBe(1)
})

it('closes a Fetch-blocked automatic candidate before exposing a usable office gateway and releases the accepted listener', async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with each real server as its receiver.
  const originalAddress = TcpServer.prototype.address
  const closing = vi.spyOn(TcpServer.prototype, 'close')
  const address = vi.spyOn(TcpServer.prototype, 'address').mockImplementationOnce(function (this: TcpServer) {
    const actual = originalAddress.call(this)
    if (actual === null || typeof actual === 'string') throw new Error('Expected a real TCP listener')
    return { ...actual, port: 6000 }
  })
  try {
    const loaded = await boot()
    expect(new URL(loaded.address).port).not.toBe('6000')
    expect(closing.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect((await loaded.signIn()).member.id).toBe(employee)
    const before = closing.mock.calls.length
    await loaded.ctx.fiber.dispose()
    expect(closing).toHaveBeenCalledTimes(before + 1)
    await expect(loaded.request('/health')).rejects.toThrow()
  } finally { address.mockRestore(); closing.mockRestore() }
})

it('bounds blocked office allocations using deployment configuration and closes every candidate on failure', async () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with each real server as its receiver.
  const originalAddress = TcpServer.prototype.address
  const listening = vi.spyOn(TcpServer.prototype, 'listen')
  const closing = vi.spyOn(TcpServer.prototype, 'close')
  const servers = new Set<TcpServer>()
  const address = vi.spyOn(TcpServer.prototype, 'address').mockImplementation(function (this: TcpServer) {
    servers.add(this)
    const actual = originalAddress.call(this)
    if (actual === null || typeof actual === 'string') throw new Error('Expected a real TCP listener')
    return { ...actual, port: 6000 }
  })
  try {
    await expect(boot(100, { ephemeralPortAttempts: 2 })).rejects.toThrow('Office gateway did not activate')
    expect(contexts.at(-1)?.get('officeGateway')).toBeUndefined()
    expect(listening).toHaveBeenCalledTimes(2)
    expect(closing).toHaveBeenCalledTimes(2)
    for (const server of servers) expect(originalAddress.call(server)).toBeNull()
  } finally { address.mockRestore(); listening.mockRestore(); closing.mockRestore() }
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-gateway-')) throw new Error('Unexpected temporary root')
    await rm(absolute, { recursive: true, force: true })
  }
})

describe('central office HTTP gateway', () => {
  it('shares registered integration manifests while checking import authority at the RPC boundary', async () => {
    const { ctx, signIn, rpc } = await boot()
    const admin = await signIn(administrator)
    const member = await signIn(employee)
    const input = { requestId: randomUUID(), json: JSON.stringify({ name: 'central-oa', system: 'OA', version: '1.0', provider: 'Test vendor', description: 'Shared company catalog', capabilities: ['Read approvals'] }) }
    expect((await rpc(member.token, 'importIntegration', [input])).status).toBe(403)
    expect((await rpc(admin.token, 'importIntegration', [{ ...input, actorId: administrator }])).status).toBe(400)
    const imported = await rpc(admin.token, 'importIntegration', [input])
    expect(imported.status).toBe(200)
    expect((await rpc(admin.token, 'importIntegration', [input])).body.value).toEqual(imported.body.value)
    const board = await rpc(member.token, 'view', [null])
    expect(board.body.value.integrations).toMatchObject({ revision: 1, entries: [{ id: imported.body.value.id, name: 'central-oa' }] })
    expect(JSON.stringify(board.body.value.integrations)).not.toMatch(/fingerprint|requestId/)
    expect(ctx.office.view(employee).items).toEqual([])
  })

  it('binds organization administration to the current authenticated role over the explicit RPC boundary', async () => {
    const { ctx, signIn, rpc } = await boot()
    const admin = await signIn(administrator)
    const member = await signIn(employee)
    expect((await rpc(member.token, 'organization', [])).body.value.initialized).toBe(false)
    expect((await rpc(member.token, 'initializeOrganization', [0])).status).toBe(403)
    const initialized = await rpc(admin.token, 'initializeOrganization', [0])
    expect(initialized.status).toBe(200)
    const department = await rpc(admin.token, 'saveOrganizationUnit', [{ id: null, parentId: null, name: 'New division', active: true, revision: 0 }])
    expect(department.status).toBe(200)
    const unit = department.body.value
    const position = await rpc(admin.token, 'savePosition', [{ id: null, unitId: unit.id, name: 'Administrator title', active: true, revision: 0 }])
    expect(position.status).toBe(200)
    const assignment = initialized.body.value.assignments.find((entry: { memberId: string }) => entry.memberId === employee)
    if (!assignment) throw new Error('Expected initialized employee assignment')
    const input = { ...assignment, unitId: unit.id, positionId: position.body.value.id }
    expect((await rpc(member.token, 'assignOrganization', [input])).status).toBe(403)
    expect((await rpc(admin.token, 'assignOrganization', [input])).status).toBe(200)
    expect((await rpc(admin.token, 'assignOrganization', [input])).status).toBe(409)
    expect((await rpc(admin.token, 'saveOrganizationUnit', [{ ...unit, role: 'admin' }])).status).toBe(400)
    const profile = ctx.office.view(employee).me
    expect((await rpc(member.token, 'updateProfile', [{ name: profile.name, department: 'Self-edited department', jobTitle: 'Self-edited title', email: profile.email, phone: profile.phone }])).status).toBe(200)
    const board = await rpc(member.token, 'view', [null])
    expect(board.body.value.me.role).toBe('employee')
    expect(board.body.value.organization?.assignments.find(entry => entry.memberId === employee))
      .toMatchObject({ unitId: unit.id, positionId: position.body.value.id })
  })

  it('requires real sign-in and rejects caller-selected actors, generic tools and cross-origin requests', async () => {
    const { request, signIn, rpc } = await boot()
    const health = await request('/health')
    expect(await health.json()).toEqual({ protocol: 'office.v1' })
    expect((await request('/v1/rpc', { method: 'view', args: [null] })).status).toBe(401)
    expect((await request('/v1/login', { memberId: employee, password, role: 'admin' })).status).toBe(401)
    const receipt = await signIn()
    const board = await rpc(receipt.token, 'view', [null])
    expect(board.status).toBe(200)
    expect(board.body.value.me.id).toBe(employee)
    expect(board.body.value.managedMembers).toBeUndefined()
    expect((await request('/v1/rpc', { method: 'view', args: [null], actorId: administrator }, receipt.token)).status).toBe(400)
    for (const method of ['terminal', 'tool.execute', 'files.read', 'loader.update', '__proto__', 'constructor']) {
      expect((await rpc(receipt.token, method, [])).status).toBe(400)
    }
    expect((await request('/v1/session', undefined, receipt.token, { Origin: 'https://untrusted.example' })).status).toBe(403)
    expect((await request('/v1/session?token=' + receipt.token, undefined, receipt.token)).status).toBe(404)
    expect((await request('/native/rpc', {}, receipt.token)).status).toBe(404)
    expect((await request('/v1/rpc', { method: 'view', args: [] }, receipt.token)).status).toBe(400)
    expect((await request('/v1/rpc', { method: 'view', args: [null, administrator] }, receipt.token)).status).toBe(400)
  })

  it('isolates private files, messages and drafts across actual HTTP employee sessions', async () => {
    const { signIn, rpc } = await boot()
    const lin = await signIn(employee)
    const chen = await signIn(peer)
    const admin = await signIn(administrator)
    const bytes = Buffer.from('actual employee file bytes')
    const upload = await rpc(lin.token, 'uploadDriveFile', [{ space: 'private', folderId: null, name: 'private.txt', requestId: randomUUID(), mediaType: 'text/plain', byteLength: bytes.byteLength, dataBase64: bytes.toString('base64') }])
    expect(upload.status).toBe(200)
    const file = upload.body.value
    expect((await rpc(lin.token, 'downloadDriveFile', [file.id])).body.value.dataBase64).toBe(bytes.toString('base64'))
    for (const other of [chen, admin]) {
      expect((await rpc(other.token, 'downloadDriveFile', [file.id])).status).toBe(404)
      expect((await rpc(other.token, 'drive', [{ space: 'private', folderId: null, search: '' }])).body.value.entries).toEqual([])
    }
    const message = { id: randomUUID(), recipientId: peer, text: 'A real colleague message' }
    expect((await rpc(lin.token, 'sendMessage', [message])).status).toBe(200)
    expect((await rpc(chen.token, 'chat', [employee, null])).body.value.messages.map((entry: { text: string }) => entry.text)).toEqual([message.text])
    expect((await rpc(admin.token, 'chat', [null, null])).body.value.threads).toEqual([])
    expect((await rpc(lin.token, 'saveChatDraft', [{ peerId: peer, revision: 0, requestId: randomUUID(), text: 'private unsent draft' }])).status).toBe(200)
    for (const other of [chen, admin]) expect((await rpc(other.token, 'chatDrafts', [])).body.value.drafts).toEqual([])
    expect((await rpc(lin.token, 'identityOverview', [])).status).toBe(403)
    expect((await rpc(lin.token, 'setIdentityPassword', [peer, replacement])).status).toBe(403)
    const profile = { ...lin.member, role: 'admin' }
    expect((await rpc(lin.token, 'updateProfile', [profile])).status).toBe(400)
  })

  it('executes only the authenticated employee reminder and returns one durable work receipt over actual HTTP', async () => {
    const { ctx, signIn, rpc, request } = await boot()
    const lin = await signIn(employee)
    const chen = await signIn(peer)
    const admin = await signIn(administrator)
    const conversationId = 'http-agent-work'
    const selection = await rpc(lin.token, 'saveConversationLinks', [{ conversationId, revision: 0,
      requestId: randomUUID(), kind: 'tools', tools: [{ kind: 'template', name: 'reminder' }] }])
    expect(selection.status).toBe(200)
    const prepared = await rpc(lin.token, 'captureConversation', [{ conversationId, revision: 1, requestId: 'http-agent-send' }])
    const input = { requestId: randomUUID(), captureId: prepared.body.value.id,
      work: { kind: 'todo', title: 'Real HTTP Agent to-do', date: '2026-10-17', ownerId: peer } }
    for (const token of [chen.token, admin.token]) {
      expect((await rpc(token, 'createWorkFromConversation', [input])).status).toBe(404)
    }
    for (const body of [
      { method: 'createWorkFromConversation', args: [input], actorId: administrator },
      { method: 'createWorkFromConversation', args: [{ ...input, actorId: administrator }] },
      { method: 'createWorkFromConversation', args: [{ ...input, work: { ...input.work, creatorId: administrator } }] },
    ]) expect((await request('/v1/rpc', body, lin.token)).status).toBe(400)
    const saved = await rpc(lin.token, 'createWorkFromConversation', [input])
    expect(saved.status).toBe(200)
    expect(saved.body.value).toMatchObject({ requestId: input.requestId, captureId: input.captureId,
      item: { title: input.work.title, creatorId: employee, ownerId: peer, kind: 'todo' } })
    expect((await rpc(lin.token, 'createWorkFromConversation', [input])).body).toEqual(saved.body)
    await rpc(lin.token, 'saveConversationLinks', [{ conversationId, revision: 1, requestId: randomUUID(), kind: 'tools', tools: [] }])
    expect((await rpc(lin.token, 'createWorkFromConversation', [input])).body).toEqual(saved.body)
    expect((await rpc(lin.token, 'createWorkFromConversation', [{ ...input, requestId: randomUUID() }])).status).toBe(409)
    await request('/v1/logout', {}, lin.token)
    expect((await rpc(lin.token, 'createWorkFromConversation', [input])).status).toBe(401)
    expect(ctx.office.view(employee).items.filter(row => row.title === input.work.title)).toHaveLength(1)
    expect(ctx.office.view(peer).notifications.filter(row => row.itemId === saved.body.value.item.id)).toHaveLength(1)
  })

  it('captures and recovers private prepared contexts through authenticated HTTP without granting native execution', async () => {
    const { signIn, rpc, request } = await boot()
    const lin = await signIn(employee)
    const chen = await signIn(peer)
    const admin = await signIn(administrator)
    const input = { conversationId: 'http-prepared-conversation', revision: 0, requestId: randomUUID() }
    const prepared = await rpc(lin.token, 'captureConversation', [input])
    expect(prepared.status).toBe(200)
    expect(prepared.body.value).toMatchObject({ format: 1, requestId: input.requestId, memberId: employee, role: 'employee',
      selection: { conversationId: input.conversationId, revision: 0 } })
    expect((await rpc(lin.token, 'captureConversation', [input])).body).toEqual(prepared.body)
    expect((await rpc(lin.token, 'conversationCapture', [prepared.body.value.id])).body).toEqual(prepared.body)
    for (const receipt of [chen, admin]) expect((await rpc(receipt.token, 'conversationCapture', [prepared.body.value.id])).status).toBe(404)
    expect((await rpc(lin.token, 'captureConversation', [{ ...input, memberId: administrator }])).status).toBe(400)
    expect((await rpc(lin.token, 'captureConversation', [{ ...input, revision: 1 }])).status).toBe(409)
    expect((await rpc(lin.token, 'captureConversation', [{ ...input, requestId: '\u0000invalid' }])).status).toBe(400)
    await request('/v1/logout', {}, lin.token)
    expect((await rpc(lin.token, 'conversationCapture', [prepared.body.value.id])).status).toBe(401)
  })

  it('returns distinct context-byte and retention denials through actual HTTP without partial captures', async () => {
    const { ctx, signIn, rpc } = await boot(100, {}, { conversationCaptureMaxBytes: 1024, conversationCapturesMaxEntries: 1 })
    const receipt = await signIn(employee)
    const integration = await ctx.office.importIntegration(administrator, { requestId: randomUUID(), json: JSON.stringify({
      name: 'context-size-system', system: 'Context size system', version: '1', provider: 'Company', description: 'Large capabilities',
      capabilities: Array.from({ length: 30 }, (_, index) => `${index}-` + 'x'.repeat(100)),
    }) })
    const conversationId = 'http-large-conversation' as OfficeConversationId
    await ctx.office.saveConversationLinks(employee, { conversationId, kind: 'integrations', integrations: [integration.id],
      revision: 0, requestId: randomUUID() })
    const oversized = await rpc(receipt.token, 'captureConversation', [{ conversationId, revision: 1, requestId: randomUUID() }])
    expect(oversized).toEqual({ status: 413, body: { ok: false, code: 'context_too_large' } })
    const empty = await rpc(receipt.token, 'captureConversation', [{ conversationId: 'empty-http-context', revision: 0, requestId: randomUUID() }])
    expect(empty.status).toBe(200)
    const full = await rpc(receipt.token, 'captureConversation', [{ conversationId: 'another-http-context', revision: 0, requestId: randomUUID() }])
    expect(full).toEqual({ status: 409, body: { ok: false, code: 'conversation_capacity' } })
  })

  it('supports own sessions, password changes and idempotent durable logout', async () => {
    const { request, signIn } = await boot()
    const first = await signIn()
    const second = await signIn()
    const other = await signIn(peer)
    const sessions = await (await request('/v1/account/sessions', undefined, first.token)).json() as { value: OfficeSessionInfo[] }
    expect(sessions.value).toHaveLength(2)
    expect(JSON.stringify(sessions)).not.toMatch(/tokenHash|salt|digest/)
    const otherSessions = await (await request('/v1/account/sessions', undefined, other.token)).json() as { value: OfficeSessionInfo[] }
    expect((await request('/v1/account/sessions/revoke', { id: otherSessions.value[0]!.id }, first.token)).status).toBe(404)
    const current = sessions.value.find((entry: { current: boolean }) => entry.current)
    if (!current) throw new Error('Expected the authenticated current session')
    expect((await request('/v1/account/sessions/revoke', { id: current.id }, first.token)).status).toBe(200)
    expect((await request('/v1/session', undefined, first.token)).status).toBe(401)
    expect((await request('/v1/account/password', { currentPassword: password, newPassword: replacement }, second.token)).status).toBe(200)
    expect((await request('/v1/session', undefined, second.token)).status).toBe(401)
    expect((await request('/v1/login', { memberId: employee, password })).status).toBe(401)
    const fresh = await signIn(employee, replacement)
    expect((await request('/v1/logout', {}, fresh.token)).status).toBe(200)
    expect((await request('/v1/logout', {}, fresh.token)).status).toBe(200)
    expect((await request('/v1/session', undefined, fresh.token)).status).toBe(401)
  })

  it('keeps storage failures opaque and never reports an uncommitted write as success', async () => {
    const { ctx, signIn, rpc, request } = await boot()
    const receipt = await signIn()
    const domain = ctx.storageDomain.get('enterprise_office')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('disk failure with internal secret path'))
    const response = await rpc(receipt.token, 'createWork', [{ kind: 'todo', title: 'Must not publish', date: '2026-10-16', ownerId: employee }])
    expect(response).toEqual({ status: 503, body: { ok: false, code: 'unavailable' } })
    expect(ctx.office.view(employee).items).toEqual([])
    const retry = await rpc(receipt.token, 'createWork', [{ kind: 'todo', title: 'Confirmed retry', date: '2026-10-16', ownerId: employee }])
    expect(retry.status).toBe(200)
    expect((await request('/v1/session', undefined, receipt.token)).headers.get('cache-control')).toBe('no-store')
  })

  it('bounds login attempts and rejects malformed JSON and unsupported encodings', async () => {
    const { address, request, signIn } = await boot(2)
    const receipt = await signIn()
    expect((await request('/v1/login', { memberId: employee, password: replacement })).status).toBe(401)
    const denied = await request('/v1/login', { memberId: employee, password })
    expect(denied.status).toBe(429)
    expect(denied.headers.get('retry-after')).toBe('60')
    const headers = { Authorization: `Bearer ${receipt.token}`, 'Content-Type': 'application/json' }
    expect((await fetch(address + '/v1/rpc', { method: 'POST', headers, body: '{' })).status).toBe(400)
    expect((await fetch(address + '/v1/rpc', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(400)
    expect((await fetch(address + '/v1/rpc', { method: 'POST', headers: { ...headers, 'Content-Encoding': 'gzip' }, body: '{}' })).status).toBe(400)
  })

  it('rejects a revoked request queued behind another commit and closes its owned listener at unload', async () => {
    const { ctx, signIn, address, entry } = await boot()
    const receipt = await signIn()
    const domain = ctx.storageDomain.get('enterprise_office')!
    const original = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (state) => {
      entered.resolve(undefined)
      await release.promise
      await original(state)
    })
    const holding = ctx.office.createWork(administrator, { kind: 'todo', title: 'Hold commit queue', date: '2026-10-16', ownerId: administrator })
    await entered.promise
    const logout = ctx.office.logout(receipt.token)
    const pending = executeOfficeRequest(ctx.office, receipt.token, { method: 'createWork', args: [{ kind: 'todo', title: 'Revoked queued request', date: '2026-10-16', ownerId: employee }] })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'unauthenticated' })
    release.resolve(undefined)
    await Promise.all([holding, logout, rejection])
    expect(ctx.office.view(employee).items).toEqual([])
    ctx.loader.remove(entry.id)
    await ctx.loader.await()
    await expect(fetch(address + '/health')).rejects.toThrow()
    expect(ctx.get('officeGateway')).toBeUndefined()
  })
})
