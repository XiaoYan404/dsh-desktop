/** Private conversation choices through the real Loader, identity queue and durable JSON backend. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, expect, it, vi } from 'vitest'
import OfficeService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { OfficeAgentWorkInput, OfficeConversationCaptureId, OfficeConversationCaptureInput, OfficeConversationId,
  OfficeConversationLinksInput, OfficeMemberId, OfficeToolReference } from '../src/types.ts'
import type { OfficeConversationFilesInput, OfficeDriveId, OfficeDriveVersionId } from '../src/types.ts'

const admin = 'admin' as OfficeMemberId
const employee = 'constructor' as OfficeMemberId
const other = 'chen' as OfficeMemberId
const first = 'ordinary-conversation' as OfficeConversationId
const second = 'item-conversation' as OfficeConversationId
const skill: OfficeToolReference = { kind: 'skill', name: 'office-review' }
const config: Config = {
  companyName: 'Conversation test company', timeZone: 'Asia/Shanghai',
  members: [admin, employee, other].map(id => ({ id, name: id, department: 'Office', jobTitle: 'Employee',
    role: id === admin ? 'admin' : 'employee' })),
  conversationToolDependencies: { 'skill:office-review': ['company-oa'], 'template:minutes': ['company-wecom'] },
}
const roots: string[] = []
const contexts: Context[] = []
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-links-'))
  roots.push(root)
  return root
}
async function boot(root: string, seed: Config = config) {
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'data') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { id: 'office', name: '@deepseek-ai/dsh-enterprise-office', config: { ...seed, dshHome: root } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-enterprise-office', OfficeService],
  ])
  const internal = ctx.loader.internal
  if (!internal) throw new Error('Node Loader is required')
  ctx.loader.internal = new Proxy(internal, {
    get(target, key) {
      if (key === 'import') return async (specifier: string) => {
        if (!modules.has(specifier)) throw new Error('Unexpected conversation fixture module')
        return modules.get(specifier)
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Office composition did not activate')
  return ctx
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-links-')) {
      throw new Error('Unexpected conversation test directory')
    }
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
const toolInput = (conversationId = first, revision = 0): Extract<OfficeConversationLinksInput, { kind: 'tools' }> => ({
  conversationId, revision, requestId: randomUUID(), kind: 'tools', tools: [skill],
})
async function register(ctx: Context, name = 'company-oa') {
  return ctx.office.importIntegration(admin, { requestId: randomUUID(), json: JSON.stringify({
    name, system: 'Company OA', version: '1.0.0', provider: 'Company', description: 'Company workflow', capabilities: ['Review work'],
  }) })
}

it('persists private ordinary/item choices and exact retries while preserving all original office bytes', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const integration = await register(ctx)
  const before = await readFile(join(root, 'data', 'enterprise_office.json'))
  const changes = vi.fn()
  ctx.on('office/conversation-links-changed', changes)
  const request = toolInput()
  const saved = await ctx.office.saveConversationLinks(employee, request)
  expect(saved).toMatchObject({ revision: 1, tools: [skill], integrations: [integration.id] })
  expect(await ctx.office.saveConversationLinks(employee, request)).toEqual(saved)
  expect(changes).toHaveBeenCalledTimes(1)
  for (const actor of [other, admin]) {
    expect((await ctx.office.conversationLinks(actor, first)).selection).toMatchObject({ revision: 0, tools: [], integrations: [] })
  }
  expect((await ctx.office.conversationLinks(employee, second)).selection.revision).toBe(0)
  await ctx.office.saveConversationLinks(employee, { ...toolInput(second), tools: [{ kind: 'template', name: 'minutes' }] })
  expect((await ctx.office.conversationLinks(employee, first)).selection).toEqual(saved)
  expect(await readFile(join(root, 'data', 'enterprise_office.json'))).toEqual(before)
  await ctx.fiber.dispose()
  const next = await boot(root)
  expect((await next.office.conversationLinks(employee, first)).selection).toEqual(saved)
  expect((await next.office.conversationLinks(employee, second)).selection.tools).toEqual([{ kind: 'template', name: 'minutes' }])
  expect(await readFile(join(root, 'data', 'enterprise_office.json'))).toEqual(before)
})

it('resolves explicit requirements without inventing missing systems and preserves an explicit dependency removal', async () => {
  const ctx = await boot(await directory())
  let view = await ctx.office.conversationLinks(employee, first)
  expect(view.requirements).toContainEqual({ tool: skill, integrationNames: ['company-oa'], integrations: [], missing: ['company-oa'] })
  await ctx.office.saveConversationLinks(employee, toolInput())
  const integration = await register(ctx)
  const selected = await ctx.office.saveConversationLinks(employee, toolInput(first, 1))
  expect(selected.integrations).toEqual([integration.id])
  const removed = await ctx.office.saveConversationLinks(employee, {
    conversationId: first, revision: selected.revision, requestId: randomUUID(), kind: 'integrations', integrations: [],
  })
  expect(removed.tools).toEqual([skill])
  expect(removed.integrations).toEqual([])
  view = await ctx.office.conversationLinks(employee, first)
  expect(view.requirements).toContainEqual({ tool: skill, integrationNames: ['company-oa'], integrations: [integration.id], missing: [] })
  expect(view.requirements.find(requirement => requirement.tool.name === 'minutes')?.missing).toEqual(['company-wecom'])
})

it('rejects changed retries and concurrent stale versions without overwriting the accepted choice', async () => {
  const ctx = await boot(await directory())
  const request = toolInput()
  const saved = await ctx.office.saveConversationLinks(employee, request)
  await expect(ctx.office.saveConversationLinks(employee, { ...request, tools: [] })).rejects.toMatchObject({ code: 'conflict' })
  await expect(ctx.office.saveConversationLinks(employee, { ...request, conversationId: second })).rejects.toMatchObject({ code: 'conflict' })
  const results = await Promise.allSettled([
    ctx.office.saveConversationLinks(employee, { ...toolInput(first, 1), tools: [] }),
    ctx.office.saveConversationLinks(employee, toolInput(first, 1)),
  ])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  const latest = (await ctx.office.conversationLinks(employee, first)).selection
  expect(latest.revision).toBe(saved.revision + 1)
  expect(latest.tools).toEqual([])
  await expect(ctx.office.saveConversationLinks(employee, request)).rejects.toMatchObject({ code: 'conflict' })
})

it('publishes no success or notification after a storage fault and retries the exact original request', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const domain = ctx.storageDomain.get('enterprise_office_conversation_links')!
  const files = await readdir(join(root, 'data'))
  expect(files).not.toContain('enterprise_office_conversation_links.json')
  const changed = vi.fn()
  ctx.on('office/conversation-links-changed', changed)
  vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected choice storage failure'))
  const request = toolInput()
  await expect(ctx.office.saveConversationLinks(employee, request)).rejects.toThrow('Expected choice storage failure')
  expect((await ctx.office.conversationLinks(employee, first)).selection.revision).toBe(0)
  expect(await readdir(join(root, 'data'))).toEqual(files)
  expect(changed).not.toHaveBeenCalled()
  expect((await ctx.office.saveConversationLinks(employee, request)).revision).toBe(1)
  expect(changed).toHaveBeenCalledTimes(1)
})

it('bounds retained contexts and lets the owner reduce an existing selection after the configured bound is lowered', async () => {
  const root = await directory()
  const ctx = await boot(root, { ...config, conversationLinksMaxContexts: 1 })
  const selectedTools = ['one', 'two', 'three'].map(name => ({ kind: 'template' as const, name }))
  await ctx.office.saveConversationLinks(employee, { ...toolInput(), tools: selectedTools })
  await expect(ctx.office.saveConversationLinks(employee, toolInput(second))).rejects.toMatchObject({ code: 'conversation_capacity' })
  await ctx.fiber.dispose()
  const next = await boot(root, { ...config, conversationLinksMaxContexts: 1, conversationLinksMaxSelected: 1 })
  const reduced = await next.office.saveConversationLinks(employee, { ...toolInput(first, 1), tools: selectedTools.slice(0, 2) })
  expect(reduced.tools).toHaveLength(2)
  await expect(next.office.saveConversationLinks(employee, { ...toolInput(first, 2), tools: selectedTools }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  const cleared = await next.office.saveConversationLinks(employee, { ...toolInput(first, 2), tools: [] })
  expect(cleared).toMatchObject({ revision: 3, tools: [], integrations: [] })
  await expect(next.office.saveConversationLinks(employee, toolInput(first, 1))).rejects.toMatchObject({ code: 'conflict' })
})

it('rechecks employee activity inside the shared queue before accepting a later choice', async () => {
  const ctx = await boot(await directory())
  const domain = ctx.storageDomain.get('enterprise_office_conversation_links')!
  const set = domain.global.set.bind(domain.global)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
    entered.resolve(undefined)
    await release.promise
    await set(value)
  })
  const saving = ctx.office.saveConversationLinks(employee, toolInput())
  await entered.promise
  const original = ctx.office.view(admin).managedMembers!.find(member => member.id === employee)!
  const disabling = ctx.office.saveMember(admin, { ...original, active: false }, original)
  const queued = ctx.office.saveConversationLinks(employee, toolInput(first, 1))
  const denied = expect(queued).rejects.toMatchObject({ code: 'forbidden' })
  release.resolve(undefined)
  await saving
  await disabling
  await denied
  await expect(ctx.office.conversationLinks(employee, first)).rejects.toMatchObject({ code: 'forbidden' })
})

it('drains an admitted choice write on root disposal and preserves it after a cold restart', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const service = ctx.office
  const domain = ctx.storageDomain.get('enterprise_office_conversation_links')!
  const set = domain.global.set.bind(domain.global)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
    entered.resolve(undefined)
    await release.promise
    await set(value)
  })
  const saving = service.saveConversationLinks(employee, toolInput())
  await entered.promise
  const closing = ctx.fiber.dispose()
  try { await expect(service.saveConversationLinks(employee, toolInput(second))).rejects.toMatchObject({ code: 'closed' }) }
  finally { release.resolve(undefined) }
  const saved = await saving
  await closing
  const next = await boot(root)
  expect((await next.office.conversationLinks(employee, first)).selection).toEqual(saved)
})

it.each(['directory', 'catalog', 'selection'] as const)('refuses detached or corrupt %s data without replacing retained choices', async (missing) => {
  const root = await directory()
  const ctx = await boot(root)
  await register(ctx)
  await ctx.office.saveConversationLinks(employee, toolInput())
  await ctx.fiber.dispose()
  const selectionPath = join(root, 'data', 'enterprise_office_conversation_links.json')
  const saved = await readFile(selectionPath)
  if (missing === 'selection') await writeFile(selectionPath, '{ broken selection')
  else {
    const original = join(root, 'data', missing === 'directory' ? 'enterprise_office.json' : 'enterprise_office_integrations.json')
    await rename(original, original + '.retained')
  }
  await expect(boot(root)).rejects.toThrow('Office composition did not activate')
  expect(await readFile(selectionPath)).toEqual(missing === 'selection' ? Buffer.from('{ broken selection') : saved)
})

const captureInput = (revision = 1, conversationId = first): OfficeConversationCaptureInput => ({
  conversationId, revision, requestId: randomUUID(),
})

it('retains immutable prepared metadata across edited choices and cold restart without changing original office data', async () => {
  const root = await directory()
  const seed = { ...config, connectorAllowedOrigins: ['https://private.example'],
    connectorCredentials: { 'internal-oa-key': 'PRIVATE_ALIAS' } }
  const ctx = await boot(root, seed)
  const integration = await register(ctx)
  await ctx.office.saveConnection(admin, { integrationId: integration.id, revision: 0, requestId: randomUUID(), adapterId: 'http-json',
    baseUrl: 'https://private.example/company/', probePath: 'health', authentication: { kind: 'bearer', credential: 'internal-oa-key' },
    enabled: true })
  await ctx.office.saveConversationLinks(employee, toolInput())
  const original = await readFile(join(root, 'data', 'enterprise_office.json'))
  const request = captureInput()
  const saved = await ctx.office.captureConversation(employee, request)
  expect(saved).toMatchObject({ format: 1, requestId: request.requestId, memberId: employee, role: 'employee',
    selection: { revision: 1, tools: [skill], integrations: [integration.id] },
    integrations: [{ id: integration.id, name: 'company-oa', connectionRevision: 1, status: 'credential_missing' }] })
  expect(saved.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(saved)).not.toMatch(/private\.example|internal-oa-key|PRIVATE_ALIAS|probePath|authentication/)
  await ctx.office.saveConversationLinks(employee, { ...toolInput(first, 1), tools: [] })
  expect(await ctx.office.captureConversation(employee, request)).toEqual(saved)
  expect(await ctx.office.conversationCapture(employee, saved.id)).toEqual(saved)
  expect(await readFile(join(root, 'data', 'enterprise_office.json'))).toEqual(original)
  await ctx.fiber.dispose()
  const reopened = await boot(root, seed)
  expect(await reopened.office.conversationCapture(employee, saved.id)).toEqual(saved)
  expect(await reopened.office.captureConversation(employee, request)).toEqual(saved)
  expect((await reopened.office.conversationLinks(employee, first)).selection.tools).toEqual([])
})

it('scopes prepared identities to their employee without an administrator ownership bypass', async () => {
  const ctx = await boot(await directory())
  const request = captureInput(0)
  const saved = await ctx.office.captureConversation(employee, request)
  for (const actor of [admin, other]) await expect(ctx.office.conversationCapture(actor, saved.id)).rejects.toMatchObject({ code: 'not_found' })
  const independent = await ctx.office.captureConversation(other, request)
  expect(independent).toMatchObject({ requestId: saved.requestId, memberId: other, selection: { revision: 0 } })
  expect(independent.id).not.toBe(saved.id)
  expect(independent.digest).not.toBe(saved.digest)
  expect(await ctx.office.conversationCapture(employee, saved.id)).toEqual(saved)
})

it('rejects stale reviews and changed retry coordinates without replacing an existing prepared record', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const request = captureInput(0)
  const saved = await ctx.office.captureConversation(employee, request)
  const path = join(root, 'data', 'enterprise_office_conversation_captures.json')
  const before = await readFile(path)
  await ctx.office.saveConversationLinks(employee, { ...toolInput(), tools: [] })
  await expect(ctx.office.captureConversation(employee, { ...request, requestId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
  await expect(ctx.office.captureConversation(employee, { ...request, revision: 1 })).rejects.toMatchObject({ code: 'conflict' })
  expect(await ctx.office.captureConversation(employee, request)).toEqual(saved)
  expect(await readFile(path)).toEqual(before)
})

it('projects administrator captures without editable connection locations or credential aliases', async () => {
  const ctx = await boot(await directory(), { ...config, connectorAllowedOrigins: ['https://private.example'],
    connectorCredentials: { 'internal-oa-key': 'PRIVATE_ALIAS' } })
  const integration = await register(ctx)
  await ctx.office.saveConnection(admin, { integrationId: integration.id, revision: 0, requestId: randomUUID(), adapterId: 'http-json',
    baseUrl: 'https://private.example/company/', probePath: 'health', authentication: { kind: 'bearer', credential: 'internal-oa-key' },
    enabled: true })
  await ctx.office.saveConversationLinks(admin, toolInput())
  expect(JSON.stringify(await ctx.office.connections(admin))).toContain('internal-oa-key')
  const saved = await ctx.office.captureConversation(admin, captureInput())
  expect(saved.integrations).toHaveLength(1)
  expect(JSON.stringify(saved)).not.toMatch(/private\.example|internal-oa-key|PRIVATE_ALIAS|probePath|authentication/)
})

it('keeps non-UUID native SDK request identities independent across logical conversations', async () => {
  const ctx = await boot(await directory())
  const firstRequest = { ...captureInput(0), requestId: 'sdk-request-one' }
  const secondRequest = { ...firstRequest, conversationId: second }
  const saved = await ctx.office.captureConversation(employee, firstRequest)
  const separate = await ctx.office.captureConversation(employee, secondRequest)
  expect(saved.id).not.toBe(separate.id)
  expect(saved.requestId).toBe('sdk-request-one')
  expect(separate.requestId).toBe(saved.requestId)
  expect(await ctx.office.captureConversation(employee, firstRequest)).toEqual(saved)
  expect(await ctx.office.captureConversation(employee, secondRequest)).toEqual(separate)
})

it('preserves exact retries after retention bounds are lowered and rejects new captures without deleting evidence', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const firstRequest = captureInput(0)
  const firstCapture = await ctx.office.captureConversation(employee, firstRequest)
  await ctx.office.captureConversation(employee, captureInput(0, second))
  await ctx.fiber.dispose()
  const path = join(root, 'data', 'enterprise_office_conversation_captures.json')
  const before = await readFile(path)
  const reopened = await boot(root, { ...config, conversationCapturesMaxEntries: 1 })
  expect(await reopened.office.captureConversation(employee, firstRequest)).toEqual(firstCapture)
  await expect(reopened.office.captureConversation(employee, captureInput(0))).rejects.toMatchObject({ code: 'conversation_capacity' })
  expect(await readFile(path)).toEqual(before)
})

it('bounds an individual prepared context and the retained unit without publishing a failed record', async () => {
  const root = await directory()
  const ctx = await boot(root, { ...config, conversationCaptureMaxBytes: 1024, conversationCapturesMaxBytes: 1024 })
  await ctx.office.importIntegration(admin, { requestId: randomUUID(), json: JSON.stringify({ name: 'large-system', system: 'Company OA',
    version: '1', provider: 'Company', description: 'Large descriptive capabilities',
    capabilities: Array.from({ length: 30 }, (_, index) => `${index}-` + 'x'.repeat(100)) }) })
  const integration = ctx.office.view(employee).integrations!.entries[0]!
  await ctx.office.saveConversationLinks(employee, { conversationId: first, revision: 0, requestId: randomUUID(),
    kind: 'integrations', integrations: [integration.id] })
  await expect(ctx.office.captureConversation(employee, captureInput())).rejects.toMatchObject({ code: 'context_too_large' })
  const path = join(root, 'data', 'enterprise_office_conversation_captures.json')
  expect(await readdir(join(root, 'data'))).not.toContain('enterprise_office_conversation_captures.json')
  await ctx.office.saveConversationLinks(employee, { ...toolInput(first, 1), tools: [] })
  await ctx.office.saveConversationLinks(employee, { conversationId: first, revision: 2, requestId: randomUUID(),
    kind: 'integrations', integrations: [] })
  const saved = await ctx.office.captureConversation(employee, captureInput(3))
  const before = await readFile(path)
  const domain = ctx.storageDomain.get('enterprise_office_conversation_captures')!
  expect(Buffer.byteLength(JSON.stringify(domain.global.get()))).toBeLessThanOrEqual(1024)
  await expect(ctx.office.captureConversation(employee, captureInput(3))).rejects.toMatchObject({ code: 'conversation_capacity' })
  expect(await ctx.office.conversationCapture(employee, saved.id)).toEqual(saved)
  expect(await readFile(path)).toEqual(before)
})

it('rechecks employee activity when a previously queued deactivation reaches capture preparation', async () => {
  const ctx = await boot(await directory())
  const member = ctx.office.view(admin).members.find(value => value.id === employee)!
  const deactivating = ctx.office.saveMember(admin, { ...member, active: false }, member)
  const preparing = ctx.office.captureConversation(employee, captureInput(0))
  const results = await Promise.allSettled([deactivating, preparing])
  expect(results[0]?.status).toBe('fulfilled')
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'forbidden' } })
})

it('keeps a failed capture absent and confirms only one retained context after the exact request is retried', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const domain = ctx.storageDomain.get('enterprise_office_conversation_captures')!
  const request = captureInput(0)
  const before = await readdir(join(root, 'data'))
  vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected prepared-context storage failure'))
  await expect(ctx.office.captureConversation(employee, request)).rejects.toThrow('Expected prepared-context storage failure')
  await expect(ctx.office.conversationCapture(employee, request.requestId as OfficeConversationCaptureId))
    .rejects.toMatchObject({ code: 'not_found' })
  expect(await readdir(join(root, 'data'))).toEqual(before)
  const saved = await ctx.office.captureConversation(employee, request)
  expect(await ctx.office.captureConversation(employee, request)).toEqual(saved)
  expect(domain.global.get()).toMatchObject({ entries: [{ capture: { id: saved.id } }] })
})

it('drains an admitted prepared-context write during root disposal and restores it without another capture', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const office = ctx.office
  const domain = ctx.storageDomain.get('enterprise_office_conversation_captures')!
  const original = domain.global.set.bind(domain.global)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
    entered.resolve(undefined)
    await release.promise
    await original(value)
  })
  const request = captureInput(0)
  const preparing = office.captureConversation(employee, request)
  await entered.promise
  const closing = ctx.fiber.dispose()
  release.resolve(undefined)
  const saved = await preparing
  await closing
  const next = await boot(root)
  expect(await next.office.captureConversation(employee, request)).toEqual(saved)
  expect(await next.office.conversationCapture(employee, saved.id)).toEqual(saved)
})

it.each(['directory', 'digest'] as const)('refuses missing or corrupt prepared %s evidence without reseeding', async (missing) => {
  const root = await directory()
  const ctx = await boot(root)
  if (missing === 'digest') {
    await register(ctx)
    await ctx.office.saveConversationLinks(employee, toolInput())
  }
  await ctx.office.captureConversation(employee, captureInput(missing === 'digest' ? 1 : 0))
  await ctx.fiber.dispose()
  const path = join(root, 'data', 'enterprise_office_conversation_captures.json')
  const saved = await readFile(path)
  const expected = missing === 'digest' ? Buffer.from(saved.toString().replace('Company OA', 'Company XX')) : saved
  if (missing === 'digest') { expect(expected).not.toEqual(saved); await writeFile(path, expected) }
  else await rename(join(root, 'data', 'enterprise_office.json'), join(root, 'data', 'enterprise_office.json.retained'))
  await expect(boot(root)).rejects.toThrow('Office composition did not activate')
  expect(await readFile(path)).toEqual(expected)
})

async function reminder(ctx: Context): Promise<OfficeAgentWorkInput> {
  const previous = await ctx.office.conversationLinks(employee, first)
  const selection = await ctx.office.saveConversationLinks(employee, { ...toolInput(first, previous.selection.revision),
    tools: [{ kind: 'template', name: 'reminder' }] })
  const capture = await ctx.office.captureConversation(employee, { conversationId: first,
    revision: selection.revision, requestId: `agent-work-native:${randomUUID()}` })
  return { requestId: randomUUID(), captureId: capture.id,
    work: { kind: 'task', title: 'Actual Agent office work', date: '2026-10-17', ownerId: other } }
}

it('creates one actual assigned task and notification across concurrent Agent retries, reload and later unlinking', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const request = await reminder(ctx)
  const before = ctx.office.view(admin)
  const [saved, retried] = await Promise.all([
    ctx.office.createWorkFromConversation(employee, request), ctx.office.createWorkFromConversation(employee, request),
  ])
  expect(retried).toEqual(saved)
  expect(saved).toMatchObject({ requestId: request.requestId, captureId: request.captureId,
    item: { creatorId: employee, ownerId: other, kind: 'task', title: request.work.title, status: 'pending' } })
  expect(ctx.office.view(admin).items).toHaveLength(before.items.length + 1)
  expect(ctx.office.view(other).notifications.filter(row => row.itemId === saved.item.id)).toHaveLength(1)
  const choices = await ctx.office.conversationLinks(employee, first)
  await ctx.office.saveConversationLinks(employee, { ...toolInput(first, choices.selection.revision), tools: [] })
  expect(await ctx.office.createWorkFromConversation(employee, request)).toEqual(saved)
  await expect(ctx.office.createWorkFromConversation(employee, { ...request, requestId: randomUUID() }))
    .rejects.toMatchObject({ code: 'conflict' })
  await expect(ctx.office.createWorkFromConversation(employee, { ...request, work: { ...request.work, title: 'Changed retry' } }))
    .rejects.toMatchObject({ code: 'conflict' })
  await ctx.fiber.dispose()
  const restarted = await boot(root)
  expect(await restarted.office.createWorkFromConversation(employee, request)).toEqual(saved)
  expect(restarted.office.view(admin).items).toHaveLength(before.items.length + 1)
})

it('requires a captured selected reminder and refuses peer, administrator and changed-role capture reuse', async () => {
  const ctx = await boot(await directory())
  const empty = await ctx.office.captureConversation(employee, captureInput(0))
  const work: OfficeAgentWorkInput = { requestId: randomUUID(), captureId: empty.id,
    work: { kind: 'todo', title: 'Must remain absent', date: '2026-10-17', ownerId: employee } }
  const before = ctx.office.view(admin).items
  await expect(ctx.office.createWorkFromConversation(employee, work)).rejects.toMatchObject({ code: 'forbidden' })
  const request = await reminder(ctx)
  for (const actor of [other, admin]) {
    await expect(ctx.office.createWorkFromConversation(actor, request)).rejects.toMatchObject({ code: 'not_found' })
  }
  const member = ctx.office.view(admin).members.find(row => row.id === employee)!
  await ctx.office.saveMember(admin, { ...member, role: 'admin' }, member)
  await expect(ctx.office.createWorkFromConversation(employee, request)).rejects.toMatchObject({ code: 'forbidden' })
  expect(ctx.office.view(admin).items).toEqual(before)
  expect(ctx.storageDomain.get('enterprise_office_agent_work')!.global.get()).toMatchObject({ entries: [] })
})

it('rechecks employee deactivation before queued Agent execution and admits no reservation for an inactive assignee', async () => {
  const ctx = await boot(await directory())
  const request = await reminder(ctx)
  const assignee = ctx.office.view(admin).members.find(row => row.id === other)!
  await ctx.office.saveMember(admin, { ...assignee, active: false }, assignee)
  await expect(ctx.office.createWorkFromConversation(employee, request)).rejects.toMatchObject({ code: 'forbidden' })
  expect(ctx.storageDomain.get('enterprise_office_agent_work')!.global.get()).toMatchObject({ entries: [] })
  const member = ctx.office.view(admin).members.find(row => row.id === employee)!
  const deactivating = ctx.office.saveMember(admin, { ...member, active: false }, member)
  const executing = ctx.office.createWorkFromConversation(employee, { ...request, work: { ...request.work, ownerId: employee } })
  expect(await Promise.allSettled([deactivating, executing])).toMatchObject([
    { status: 'fulfilled' }, { status: 'rejected', reason: { code: 'forbidden' } },
  ])
})

it('refuses missing, unconfigured, disabled and changed required connections without claiming external delivery', async () => {
  const root = await directory()
  const seed = { ...config, connectorAllowedOrigins: ['https://oa.company.invalid'],
    conversationToolDependencies: { 'template:reminder': ['company-oa'] } }
  const ctx = await boot(root, seed)
  const missing = await reminder(ctx)
  await expect(ctx.office.createWorkFromConversation(employee, missing)).rejects.toMatchObject({ code: 'forbidden' })
  const integration = await register(ctx)
  const unconfigured = await reminder(ctx)
  await expect(ctx.office.createWorkFromConversation(employee, unconfigured)).rejects.toMatchObject({ code: 'forbidden' })
  const connection = { integrationId: integration.id, revision: 0, requestId: randomUUID(), adapterId: 'http-json',
    baseUrl: 'https://oa.company.invalid/', probePath: 'health', authentication: { kind: 'none' as const }, enabled: true }
  await ctx.office.saveConnection(admin, connection)
  const ready = await reminder(ctx)
  await ctx.office.saveConnection(admin, { ...connection, revision: 1, requestId: randomUUID(), enabled: false })
  await expect(ctx.office.createWorkFromConversation(employee, ready)).rejects.toMatchObject({ code: 'forbidden' })
  await ctx.office.saveConnection(admin, { ...connection, revision: 2, requestId: randomUUID() })
  await expect(ctx.office.createWorkFromConversation(employee, ready)).rejects.toMatchObject({ code: 'conflict' })
  const current = await reminder(ctx)
  const saved = await ctx.office.createWorkFromConversation(employee, current)
  expect(ctx.office.getItem(employee, saved.item.id)).toEqual(saved.item)
  const choices = await ctx.office.conversationLinks(employee, first)
  await ctx.office.saveConversationLinks(employee, { conversationId: first, revision: choices.selection.revision,
    requestId: randomUUID(), kind: 'integrations', integrations: [] })
  const unlinked = await ctx.office.captureConversation(employee, { conversationId: first,
    revision: choices.selection.revision + 1, requestId: 'unlinked-reminder-send' })
  await expect(ctx.office.createWorkFromConversation(employee, { ...current, captureId: unlinked.id, requestId: randomUUID() }))
    .rejects.toMatchObject({ code: 'forbidden' })
})

it.each(['reservation', 'business', 'acknowledgement'] as const)('recovers an Agent %s write failure without a duplicate item', async (failure) => {
  const root = await directory()
  const ctx = await boot(root)
  const request = await reminder(ctx)
  const before = ctx.office.view(admin).items.length
  const domain = ctx.storageDomain.get(failure === 'reservation' ? 'enterprise_office_agent_work' : 'enterprise_office')!
  const original = domain.global.set.bind(domain.global)
  vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
    if (failure === 'acknowledgement') await original(value)
    throw new Error('Expected Agent work persistence interruption')
  })
  await expect(ctx.office.createWorkFromConversation(employee, request)).rejects.toThrow('Expected Agent work persistence interruption')
  expect(ctx.office.view(admin).items).toHaveLength(before + (failure === 'acknowledgement' ? 1 : 0))
  await ctx.fiber.dispose()
  const next = await boot(root)
  const restored = await next.office.createWorkFromConversation(employee, request)
  expect(await next.office.createWorkFromConversation(employee, request)).toEqual(restored)
  expect(next.office.view(admin).items).toHaveLength(before + 1)
  expect(next.office.view(other).notifications.filter(row => row.itemId === restored.item.id)).toHaveLength(1)
})

it('retains committed retries after lowering Agent request retention and refuses additional writes at capacity', async () => {
  const root = await directory()
  const ctx = await boot(root, { ...config, agentWorkMaxEntries: 1 })
  const prepared = await reminder(ctx)
  const request = { ...prepared, work: { ...prepared.work, description: 'x'.repeat(2000) } }
  const saved = await ctx.office.createWorkFromConversation(employee, request)
  await expect(ctx.office.createWorkFromConversation(employee, { ...request, requestId: randomUUID() }))
    .rejects.toMatchObject({ code: 'conflict' })
  await ctx.fiber.dispose()
  const next = await boot(root, { ...config, agentWorkMaxEntries: 1, agentWorkMaxBytes: 1024 })
  expect(Buffer.byteLength(JSON.stringify(next.storageDomain.get('enterprise_office_agent_work')!.global.get()))).toBeGreaterThan(1024)
  expect(await next.office.createWorkFromConversation(employee, request)).toEqual(saved)
})

it('rechecks changed deployment requirements before recovering a reserved but uncommitted Agent request', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const request = await reminder(ctx)
  const before = ctx.office.view(admin).items.length
  const domain = ctx.storageDomain.get('enterprise_office')!
  vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected unfinished business write'))
  await expect(ctx.office.createWorkFromConversation(employee, request)).rejects.toThrow('Expected unfinished business write')
  await ctx.fiber.dispose()
  const next = await boot(root, { ...config, conversationToolDependencies: { 'template:reminder': ['company-oa'] } })
  await expect(next.office.createWorkFromConversation(employee, request)).rejects.toMatchObject({ code: 'conflict' })
  expect(next.office.view(admin).items).toHaveLength(before)
})

it('refuses oversized reservation evidence before creating a task or consuming a request slot', async () => {
  const ctx = await boot(await directory(), { ...config, agentWorkMaxBytes: 1024 })
  const request = await reminder(ctx)
  const before = ctx.office.view(admin).items
  await expect(ctx.office.createWorkFromConversation(employee, { ...request, work: { ...request.work, description: 'x'.repeat(2000) } }))
    .rejects.toMatchObject({ code: 'conflict' })
  expect(ctx.office.view(admin).items).toEqual(before)
  expect(ctx.storageDomain.get('enterprise_office_agent_work')!.global.get()).toMatchObject({ entries: [] })
  const saved = await ctx.office.createWorkFromConversation(employee, request)
  expect(saved.item.title).toBe(request.work.title)
})

it('drains an admitted Agent reservation and business write on root close without losing its retry identity', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const request = await reminder(ctx)
  const domain = ctx.storageDomain.get('enterprise_office_agent_work')!
  const original = domain.global.set.bind(domain.global)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
    entered.resolve(undefined)
    await release.promise
    await original(value)
  })
  const pending = ctx.office.createWorkFromConversation(employee, request)
  await entered.promise
  const closing = ctx.fiber.dispose()
  release.resolve(undefined)
  const saved = await pending
  await closing
  const next = await boot(root)
  expect(await next.office.createWorkFromConversation(employee, request)).toEqual(saved)
})

it('refuses an adapter unloaded while Agent reservation persistence was pending, then safely retries after recovery', async () => {
  const root = await directory()
  const ctx = await boot(root, { ...config, connectorAllowedOrigins: ['https://oa.company.invalid'],
    conversationToolDependencies: { 'template:reminder': ['company-oa'] } })
  const integration = await register(ctx)
  const adapter = { id: 'agent-work-test', probe: () => Promise.resolve({ status: 'connected' as const }) }
  const unregister = ctx.office.registerConnector(adapter)
  await ctx.office.saveConnection(admin, { integrationId: integration.id, revision: 0, requestId: randomUUID(),
    adapterId: adapter.id, baseUrl: 'https://oa.company.invalid/', probePath: 'health',
    authentication: { kind: 'none' }, enabled: true })
  const request = await reminder(ctx)
  const before = ctx.office.view(admin).items.length
  const domain = ctx.storageDomain.get('enterprise_office_agent_work')!
  const original = domain.global.set.bind(domain.global)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => {
    entered.resolve(undefined)
    await release.promise
    await original(value)
  })
  const pending = ctx.office.createWorkFromConversation(employee, request)
  await entered.promise
  unregister()
  release.resolve(undefined)
  await expect(pending).rejects.toMatchObject({ code: 'forbidden' })
  expect(ctx.office.view(admin).items).toHaveLength(before)
  ctx.effect(() => ctx.office.registerConnector(adapter))
  const saved = await ctx.office.createWorkFromConversation(employee, request)
  expect(await ctx.office.createWorkFromConversation(employee, request)).toEqual(saved)
  expect(ctx.office.view(admin).items).toHaveLength(before + 1)
})

it('preserves manager preparation and execution across restart while rejecting a later role downgrade for a new write', async () => {
  const root = await directory()
  const seed: Config = { ...config, members: config.members.map(member =>
    member.id === employee ? { ...member, role: 'manager' } : member) }
  const ctx = await boot(root, seed)
  const request = await reminder(ctx)
  expect((await ctx.office.conversationCapture(employee, request.captureId)).role).toBe('manager')
  const saved = await ctx.office.createWorkFromConversation(employee, request)
  await ctx.fiber.dispose()
  const next = await boot(root)
  expect(next.office.view(employee).me.role).toBe('manager')
  expect((await next.office.conversationCapture(employee, request.captureId)).role).toBe('manager')
  expect(await next.office.createWorkFromConversation(employee, request)).toEqual(saved)
  const member = next.office.view(admin).members.find(row => row.id === employee)!
  await next.office.saveMember(admin, { ...member, role: 'employee' }, member)
  await expect(next.office.createWorkFromConversation(employee, { ...request, requestId: randomUUID() }))
    .rejects.toMatchObject({ code: 'forbidden' })
  expect(await next.office.createWorkFromConversation(employee, request)).toEqual(saved)
})

it('refuses corrupted Agent reservation fingerprints on cold startup without replacing retained evidence', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const request = await reminder(ctx)
  await ctx.office.createWorkFromConversation(employee, request)
  await ctx.fiber.dispose()
  const path = join(root, 'data', 'enterprise_office_agent_work.json')
  const original = await readFile(path)
  const corrupted = Buffer.from(original.toString().replace('Actual Agent office work', 'Tampered Agent office work'))
  expect(corrupted).not.toEqual(original)
  await writeFile(path, corrupted)
  await expect(boot(root)).rejects.toThrow('Office composition did not activate')
  expect(await readFile(path)).toEqual(corrupted)
})

async function fileReference(ctx: Context, text: string | Buffer = 'Actual office file content', actor = employee) {
  const bytes = typeof text === 'string' ? Buffer.from(text) : text
  const file = await ctx.office.uploadDriveFile(actor, { space: 'private', folderId: null, name: `${randomUUID()}.txt`,
    mediaType: 'text/plain', byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await ctx.office.driveFileInfo(actor, file.id)
  return { file, info, coordinates: { id: file.id, versionId: info.versionId }, bytes }
}

it('associates authority-resolved versions, freezes submitted files and reads exact bounded text', async () => {
  const ctx = await boot(await directory())
  const { coordinates, bytes, info } = await fileReference(ctx)
  const request = { conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] }
  const saved = await ctx.office.saveConversationFiles(employee, request)
  expect(saved.files).toEqual([{
    ...coordinates, name: info.name, mediaType: info.mediaType, byteLength: bytes.length, sha256: info.sha256 }])
  expect(await ctx.office.saveConversationFiles(employee, request)).toEqual(saved)
  const preparation = { conversationId: first, revision: saved.revision, requestId: 'native-file-input' }
  const captured = await ctx.office.captureConversationFiles(employee, preparation)
  await ctx.office.saveConversationFiles(employee, { ...request, revision: 1, requestId: randomUUID(), files: [] })
  expect((await ctx.office.conversationFiles(employee, first)).files).toEqual([])
  expect(await ctx.office.captureConversationFiles(employee, preparation)).toEqual(captured)
  let offset: number | null = 0
  let restored = ''
  while (offset !== null) {
    const page = await ctx.office.readConversationFile(employee, {
      captureId: captured.id, fileId: coordinates.id, offset, maxCharacters: 7 })
    expect(page.file).toEqual(saved.files[0])
    restored += page.text
    offset = page.nextOffset
  }
  expect(restored).toBe(bytes.toString('utf8'))
})

it('keeps ordinary, item and employee file references separate and denies private capture bypass', async () => {
  const ctx = await boot(await directory())
  const { coordinates } = await fileReference(ctx)
  const selected = await ctx.office.saveConversationFiles(employee, { conversationId: first, revision: 0,
    requestId: randomUUID(), files: [coordinates] })
  const captured = await ctx.office.captureConversationFiles(employee, {
    conversationId: first, revision: selected.revision, requestId: 'input' })
  expect((await ctx.office.conversationFiles(employee, second)).files).toEqual([])
  expect((await ctx.office.conversationFiles(other, first)).files).toEqual([])
  await expect(ctx.office.conversationFilesCapture(admin, captured.id)).rejects.toMatchObject({ code: 'not_found' })
  await expect(ctx.office.readConversationFile(other, { captureId: captured.id, fileId: coordinates.id, offset: 0, maxCharacters: 10 }))
    .rejects.toMatchObject({ code: 'not_found' })
  await expect(ctx.office.saveConversationFiles(other, {
    conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] }))
    .rejects.toMatchObject({ code: 'not_found' })
  await expect(ctx.office.readConversationFile(employee, { captureId: captured.id, fileId: randomUUID() as OfficeDriveId,
    offset: 0, maxCharacters: 10 })).rejects.toMatchObject({ code: 'forbidden' })
})

it('serializes concurrent file selection edits and rejects changed retries without altering the winner', async () => {
  const ctx = await boot(await directory())
  const a = await fileReference(ctx, 'A')
  const b = await fileReference(ctx, 'B')
  const request = { conversationId: first, revision: 0, requestId: randomUUID(), files: [a.coordinates] }
  const result = await Promise.allSettled([ctx.office.saveConversationFiles(employee, request),
    ctx.office.saveConversationFiles(employee, { ...request, requestId: randomUUID(), files: [b.coordinates] })])
  expect(result[0]?.status).toBe('fulfilled')
  expect(result[1]).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } })
  await expect(ctx.office.saveConversationFiles(employee, { ...request, files: [b.coordinates] })).rejects.toMatchObject({ code: 'conflict' })
  expect((await ctx.office.conversationFiles(employee, first)).files[0]?.id).toBe(a.file.id)
})

it('rejects caller metadata, duplicate files and excessive reference counts without storing a selection', async () => {
  const ctx = await boot(await directory())
  const { coordinates } = await fileReference(ctx)
  const request = { conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] }
  await expect(ctx.office.saveConversationFiles(employee,
    { ...request, files: [{ ...coordinates, name: 'forged' }] } as unknown as OfficeConversationFilesInput))
    .rejects.toMatchObject({ code: 'invalid_input' })
  await expect(ctx.office.saveConversationFiles(employee, { ...request, files: [coordinates, coordinates] }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  await expect(ctx.office.saveConversationFiles(employee, { ...request, files: Array.from({ length: 21 }, () => coordinates) }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  expect((await ctx.office.conversationFiles(employee, first)).revision).toBe(0)
})

it('reauthorizes submitted files and exact preparation retries after ancestor permissions are removed', async () => {
  const ctx = await boot(await directory())
  const parent = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'File reference ACL' })
  const bytes = Buffer.from('Shared submitted content')
  const file = await ctx.office.uploadDriveFile(admin, { space: 'shared', folderId: parent.id, name: 'shared.txt', mediaType: 'text/plain',
    byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await ctx.office.driveFileInfo(employee, file.id)
  const selected = await ctx.office.saveConversationFiles(employee, { conversationId: first, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const preparation = { conversationId: first, revision: selected.revision, requestId: 'shared-input' }
  const captured = await ctx.office.captureConversationFiles(employee, preparation)
  const request = { captureId: captured.id, fileId: file.id, offset: 0, maxCharacters: 16384 }
  expect((await ctx.office.readConversationFile(employee, request)).text).toBe(bytes.toString())
  await ctx.office.saveDrivePermissions(admin, { id: parent.id, revision: parent.revision, defaultAccess: 'deny', grants: [] })
  await expect(ctx.office.readConversationFile(employee, request)).rejects.toMatchObject({ code: 'not_found' })
  await expect(ctx.office.captureConversationFiles(employee, preparation)).rejects.toMatchObject({ code: 'not_found' })
})

it('refuses submitted file reads and preparation retries after an employee authority role changes', async () => {
  const ctx = await boot(await directory())
  const { coordinates } = await fileReference(ctx)
  const selected = await ctx.office.saveConversationFiles(employee, {
    conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] })
  const preparation = { conversationId: first, revision: selected.revision, requestId: 'role-input' }
  const captured = await ctx.office.captureConversationFiles(employee, preparation)
  const member = ctx.office.view(admin).members.find(row => row.id === employee)!
  await ctx.office.saveMember(admin, { ...member, role: 'manager' }, member)
  await expect(ctx.office.captureConversationFiles(employee, preparation)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(ctx.office.readConversationFile(employee, { captureId: captured.id, fileId: coordinates.id, offset: 0, maxCharacters: 10 }))
    .rejects.toMatchObject({ code: 'forbidden' })
})

it('keeps failed selection and capture commits absent and permits their exact retries', async () => {
  const ctx = await boot(await directory())
  const { coordinates } = await fileReference(ctx)
  const domain = ctx.storageDomain.get('enterprise_office_conversation_files')!
  const request = { conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] }
  vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected file selection write failure'))
  await expect(ctx.office.saveConversationFiles(employee, request)).rejects.toThrow('Expected file selection write failure')
  expect((await ctx.office.conversationFiles(employee, first)).revision).toBe(0)
  const saved = await ctx.office.saveConversationFiles(employee, request)
  const preparation = { conversationId: first, revision: saved.revision, requestId: 'failed-capture' }
  vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected file capture write failure'))
  await expect(ctx.office.captureConversationFiles(employee, preparation)).rejects.toThrow('Expected file capture write failure')
  const captured = await ctx.office.captureConversationFiles(employee, preparation)
  expect(await ctx.office.captureConversationFiles(employee, preparation)).toEqual(captured)
})

it('returns intact Unicode windows and rejects offsets in the middle of a surrogate pair', async () => {
  const ctx = await boot(await directory())
  const { coordinates } = await fileReference(ctx, 'A😊中')
  const saved = await ctx.office.saveConversationFiles(employee, {
    conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] })
  const captured = await ctx.office.captureConversationFiles(employee, {
    conversationId: first, revision: saved.revision, requestId: 'unicode-input' })
  const read = { captureId: captured.id, fileId: coordinates.id, offset: 0, maxCharacters: 2 }
  expect(await ctx.office.readConversationFile(employee, read)).toMatchObject({ text: 'A😊', nextOffset: 3 })
  expect(await ctx.office.readConversationFile(employee, { ...read, offset: 3 })).toMatchObject({ text: '中', nextOffset: null })
  await expect(ctx.office.readConversationFile(employee, { ...read, offset: 2 })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(ctx.office.readConversationFile(employee, { ...read, offset: 9 })).rejects.toMatchObject({ code: 'invalid_input' })
})

it('verifies the actual immutable object even when the submitted file is empty', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const { coordinates } = await fileReference(ctx, '')
  const saved = await ctx.office.saveConversationFiles(employee, {
    conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] })
  const captured = await ctx.office.captureConversationFiles(employee, {
    conversationId: first, revision: saved.revision, requestId: 'empty-input' })
  const request = { captureId: captured.id, fileId: coordinates.id, offset: 0, maxCharacters: 10 }
  expect(await ctx.office.readConversationFile(employee, request)).toMatchObject({ text: '', nextOffset: null, totalCharacters: 0 })
  const path = resolve(root, 'office', 'drive', 'v1', 'objects', `${coordinates.versionId}.bin`)
  expect(path.startsWith(resolve(root) + sep)).toBe(true)
  await rename(path, path + '.missing')
  try { await expect(ctx.office.readConversationFile(employee, request)).rejects.toBeDefined() }
  finally { await rename(path + '.missing', path) }
})

it('rejects an unreviewed version and returns no submitted body after the stored object is changed', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const { coordinates, bytes } = await fileReference(ctx)
  const input = { conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] }
  await expect(ctx.office.saveConversationFiles(employee, { ...input,
    files: [{ ...coordinates, versionId: randomUUID() as OfficeDriveVersionId }] })).rejects.toMatchObject({ code: 'conflict' })
  expect((await ctx.office.conversationFiles(employee, first)).revision).toBe(0)
  const saved = await ctx.office.saveConversationFiles(employee, input)
  const captured = await ctx.office.captureConversationFiles(employee, {
    conversationId: first, revision: saved.revision, requestId: 'verified-file-input' })
  const request = { captureId: captured.id, fileId: coordinates.id, offset: 0, maxCharacters: 100 }
  const path = resolve(root, 'office', 'drive', 'v1', 'objects', `${coordinates.versionId}.bin`)
  expect(path.startsWith(resolve(root) + sep)).toBe(true)
  await writeFile(path, Buffer.alloc(bytes.length, 0x78))
  try { await expect(ctx.office.readConversationFile(employee, request)).rejects.toMatchObject({ code: 'conflict' }) }
  finally { await writeFile(path, bytes) }
  expect((await ctx.office.readConversationFile(employee, request)).text).toBe(bytes.toString('utf8'))
})

it('refuses an oversized submitted text body before allocating a model-visible result', async () => {
  const ctx = await boot(await directory())
  const { coordinates } = await fileReference(ctx, Buffer.alloc(1024 * 1024 + 1, 0x61))
  const saved = await ctx.office.saveConversationFiles(employee, {
    conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] })
  const captured = await ctx.office.captureConversationFiles(employee, {
    conversationId: first, revision: saved.revision, requestId: 'large-file-input' })
  await expect(ctx.office.readConversationFile(employee, {
    captureId: captured.id, fileId: coordinates.id, offset: 0, maxCharacters: 16384 })).rejects.toMatchObject({ code: 'context_too_large' })
})

it.each([Buffer.from([0xc3, 0x28]), Buffer.from('binary\0text')])('returns no body for malformed UTF-8 or binary input (%#)', async (bytes) => {
  const ctx = await boot(await directory())
  const { coordinates } = await fileReference(ctx, bytes)
  const saved = await ctx.office.saveConversationFiles(employee, {
    conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] })
  const captured = await ctx.office.captureConversationFiles(employee, {
    conversationId: first, revision: saved.revision, requestId: 'binary-input' })
  await expect(ctx.office.readConversationFile(employee, { captureId: captured.id, fileId: coordinates.id, offset: 0, maxCharacters: 100 }))
    .rejects.toMatchObject({ code: 'invalid_input' })
})

it('retains submitted file evidence and exact bytes across restart without rewriting existing office domains', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const { coordinates, bytes } = await fileReference(ctx)
  await ctx.office.saveConversationLinks(employee, toolInput())
  const legacy = await Promise.all((await readdir(join(root, 'data'))).filter(name => name.endsWith('.json')).map(async name =>
    [name, await readFile(join(root, 'data', name))] as const))
  const saved = await ctx.office.saveConversationFiles(employee, {
    conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] })
  const preparation = { conversationId: first, revision: saved.revision, requestId: 'durable-input' }
  const captured = await ctx.office.captureConversationFiles(employee, preparation)
  await ctx.fiber.dispose()
  for (const [name, data] of legacy) expect(await readFile(join(root, 'data', name))).toEqual(data)
  const next = await boot(root)
  expect(await next.office.conversationFiles(employee, first)).toEqual({ ...saved, meId: employee, role: 'employee',
    limits: { protocol: 1, maxSelectedFiles: 20, maxTextBytes: 1048576, maxCharacters: 16384 } })
  expect(await next.office.captureConversationFiles(employee, preparation)).toEqual(captured)
  expect((await next.office.readConversationFile(employee, {
    captureId: captured.id, fileId: coordinates.id, offset: 0, maxCharacters: 100 })).text)
    .toBe(bytes.toString('utf8'))
})

it('refuses corrupted submitted file digests on startup while preserving the original bytes for recovery', async () => {
  const root = await directory()
  const ctx = await boot(root)
  const { coordinates } = await fileReference(ctx)
  const saved = await ctx.office.saveConversationFiles(employee, {
    conversationId: first, revision: 0, requestId: randomUUID(), files: [coordinates] })
  await ctx.office.captureConversationFiles(employee, { conversationId: first, revision: saved.revision, requestId: 'corrupt-input' })
  await ctx.fiber.dispose()
  const path = join(root, 'data', 'enterprise_office_conversation_files.json')
  const original = await readFile(path)
  const corrupted = Buffer.from(original.toString().replace(/("digest"\s*:\s*")[a-f\d]{64}("?)/u,
    (_match: string, prefix: string, suffix: string) => prefix + '0'.repeat(64) + suffix))
  expect(corrupted).not.toEqual(original)
  expect(() => { JSON.parse(corrupted.toString()) }).not.toThrow()
  await writeFile(path, corrupted)
  await expect(boot(root)).rejects.toThrow('Office composition did not activate')
  expect(await readFile(path)).toEqual(corrupted)
})
