/** Durable intents use real Loader/JSON storage; no test reservation installs or invokes an external writer. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import OfficeService, { executeOfficeRequest } from '../src/index.ts'
import { officeConnectorExecutionDomain, OfficeConnectorExecutionRepository,
  resolveConnectorExecutionPolicy, officeConnectorExecutionLimits } from '../src/connector-executions.ts'
import type { OfficeConnectorExecutionPolicy } from '../src/connector-executions.ts'
import type { OfficeConnectorWriteInput, OfficeMemberId } from '../src/types.ts'

const admin = 'admin' as OfficeMemberId
const employee = 'lin' as OfficeMemberId
const colleague = 'chen' as OfficeMemberId
const contexts: Context[] = []
const roots: string[] = []
const policy = resolveConnectorExecutionPolicy({ maxEntries: 10000, maxBytes: 16777216, maxInputBytes: 65536, maxResultBytes: 65536 })

async function optionalFile(path: string): Promise<Buffer | null> {
  try { return await readFile(path) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

async function boot(root: string, enabled = true) {
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'data') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-enterprise-office', disabled: !enabled, config: {
      companyName: 'Execution company', timeZone: 'Asia/Shanghai', dshHome: root, members: [
        { id: admin, name: 'Administrator', department: 'Office', jobTitle: 'Admin', role: 'admin' },
        { id: employee, name: 'Lin', department: 'Office', jobTitle: 'Employee', role: 'employee' },
        { id: colleague, name: 'Chen', department: 'Office', jobTitle: 'Employee', role: 'employee' },
      ],
    } },
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
  if (!internal) throw new Error('Execution evidence requires a real Loader')
  ctx.loader.internal = new Proxy(internal, { get(target, key) {
    if (key === 'import') return async (name: string) => { if (!modules.has(name)) throw new Error('Unexpected fixture module'); return modules.get(name) }
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  return ctx
}

async function fixture(limits: Partial<OfficeConnectorExecutionPolicy> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-executions-'))
  roots.push(root)
  const ctx = await boot(root)
  if (!ctx.get('office')) throw new Error('Office execution fixture did not activate')
  const integration = await ctx.office.importIntegration(admin, { requestId: randomUUID(), json: JSON.stringify({
    name: 'execution-system', system: 'Execution system', version: '1', provider: 'Company', description: 'Write ledger fixture',
    capabilities: ['Submit an approved request'],
  }) })
  const domain = ctx.storageDomain.get(officeConnectorExecutionDomain.name) as Domain<typeof officeConnectorExecutionDomain> | undefined
  if (!domain) throw new Error('Execution evidence domain did not open')
  const repo = new OfficeConnectorExecutionRepository(domain, resolveConnectorExecutionPolicy({ ...policy, ...limits }))
  const actor = ctx.office.view(employee).me
  const input: OfficeConnectorWriteInput = { integrationId: integration.id, actionId: 'submit-request', connectionRevision: 1,
    adapterRevision: randomUUID(), requestId: randomUUID(), values: { title: 'Employee request', reason: 'Reviewed reason' } }
  return { root, ctx, domain, repo, actor, input }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-executions-'))
      throw new Error('Unexpected execution fixture directory')
    await rm(absolute, { recursive: true, force: true })
  }
})

it('retains one server identity for exact employee retries without changing office records or exposing private request values', async () => {
  const { root, ctx, repo, actor, input } = await fixture()
  const original = await Promise.all(['enterprise_office.json', 'enterprise_office_integrations.json']
    .map(name => readFile(join(root, 'data', name))))
  const saved = await repo.reserve(actor, input)
  expect(await repo.reserve(actor, { ...input, values: { reason: input.values.reason!, title: input.values.title! } })).toEqual(saved)
  await expect(repo.reserve(actor, { ...input, values: { ...input.values, reason: 'Changed' } })).rejects.toMatchObject({ code: 'conflict' })
  const other = await repo.reserve(ctx.office.view(colleague).me, input)
  expect(other.id).not.toBe(saved.id)
  const receipts = await ctx.office.connectorExecutions(employee)
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ id: saved.id, status: 'reserved', memberId: employee, revision: 1 })
  expect(JSON.stringify(receipts)).not.toMatch(/Reviewed reason|"values"|fingerprint/)
  expect(await ctx.office.connectorExecutions(admin)).toEqual([])
  await expect(repo.dispatch(ctx.office.view(admin).me, saved.id)).rejects.toMatchObject({ code: 'not_found' })
  expect(await Promise.all(['enterprise_office.json', 'enterprise_office_integrations.json']
    .map(name => readFile(join(root, 'data', name))))).toEqual(original)
})

it('commits the uncertain boundary before dispatch and never authorizes another dispatch after it', async () => {
  const { repo, actor, input } = await fixture()
  const saved = await repo.reserve(actor, input)
  expect(await repo.dispatch(actor, saved.id)).toMatchObject({ stage: 'dispatched', status: 'unknown', revision: 2 })
  await expect(repo.dispatch(actor, saved.id)).rejects.toMatchObject({ code: 'conflict' })
  expect(await repo.finish(actor, saved.id, { stage: 'unknown' })).toMatchObject({ stage: 'unknown', revision: 3 })
  await expect(repo.dispatch(actor, saved.id)).rejects.toMatchObject({ code: 'conflict' })
  const result = { summary: 'Authoritative external receipt', entries: [{ label: 'External id', value: 'OA-42' }] }
  const completed = await repo.finish(actor, saved.id, { stage: 'succeeded', result })
  expect(completed).toMatchObject({ status: 'succeeded', revision: 4, result })
  expect(completed.history.map(entry => entry.stage)).toEqual(['reserved', 'dispatched', 'unknown', 'succeeded'])
  expect(await repo.finish(actor, saved.id, { stage: 'succeeded', result })).toEqual(completed)
  await expect(repo.finish(actor, saved.id, { stage: 'rejected', rejection: 'denied' })).rejects.toMatchObject({ code: 'conflict' })
})

it('cancels only an undispatched intent and cannot report success before the dispatch boundary', async () => {
  const { repo, actor, input } = await fixture()
  const first = await repo.reserve(actor, input)
  await expect(repo.finish(actor, first.id, { stage: 'succeeded', result: { summary: 'Not admitted', entries: [] } }))
    .rejects.toMatchObject({ code: 'conflict' })
  expect(await repo.finish(actor, first.id, { stage: 'cancelled' })).toMatchObject({ status: 'cancelled', revision: 2 })
  await expect(repo.dispatch(actor, first.id)).rejects.toMatchObject({ code: 'conflict' })
  const second = await repo.reserve(actor, { ...input, requestId: randomUUID() })
  await repo.dispatch(actor, second.id)
  await expect(repo.finish(actor, second.id, { stage: 'cancelled' })).rejects.toMatchObject({ code: 'conflict' })
  expect(await repo.finish(actor, second.id, { stage: 'rejected', rejection: 'not_accepted' }))
    .toMatchObject({ status: 'rejected', rejection: 'not_accepted' })
})

it('cold-restores reserved and dispatched evidence without changing ids, publishing success or replaying a write', async () => {
  const { root, ctx, repo, actor, input } = await fixture()
  const reserved = await repo.reserve(actor, input)
  const sentInput = { ...input, requestId: randomUUID() }
  const sent = await repo.reserve(actor, sentInput)
  await repo.dispatch(actor, sent.id)
  await ctx.fiber.dispose()
  const restored = await boot(root)
  if (!restored.get('office')) throw new Error('Saved execution evidence did not restore')
  const domain = restored.storageDomain.get(officeConnectorExecutionDomain.name) as Domain<typeof officeConnectorExecutionDomain>
  const recovered = new OfficeConnectorExecutionRepository(domain, policy)
  expect((await recovered.reserve(actor, input)).id).toBe(reserved.id)
  expect((await recovered.reserve(actor, sentInput)).id).toBe(sent.id)
  expect(await restored.office.connectorExecutions(employee)).toMatchObject([
    { id: reserved.id, status: 'reserved' }, { id: sent.id, status: 'unknown', stage: 'dispatched' },
  ])
  await expect(recovered.dispatch(actor, sent.id)).rejects.toMatchObject({ code: 'conflict' })
})

it.each(['reserve', 'dispatch', 'finish'] as const)('retains conservative memory and disk evidence after a failed %s commit', async (phase) => {
  const { root, domain, repo, actor, input } = await fixture()
  const saved = phase === 'reserve' ? null : await repo.reserve(actor, input)
  if (phase === 'finish' && saved) await repo.dispatch(actor, saved.id)
  const before = domain.global.get()
  const path = join(root, 'data', 'enterprise_office_connector_executions.json')
  const disk = await optionalFile(path)
  const failure = new Error('Expected execution evidence storage failure')
  vi.spyOn(domain.global, 'set').mockRejectedValueOnce(failure)
  const pending = phase === 'reserve' ? repo.reserve(actor, input)
    : phase === 'dispatch' && saved ? repo.dispatch(actor, saved.id)
      : saved ? repo.finish(actor, saved.id, { stage: 'succeeded', result: { summary: 'External receipt', entries: [] } })
        : Promise.reject(new Error('Missing execution fixture identity'))
  await expect(pending).rejects.toBe(failure)
  expect(domain.global.get()).toEqual(before)
  expect(await optionalFile(path)).toEqual(disk)
  if (phase === 'finish') expect(repo.list(actor)[0]?.status).toBe('unknown')
})

it('bounds new requests and retention while recovering old exact receipts after limits are lowered', async () => {
  const { domain, repo, actor, input } = await fixture()
  const large = { ...input, values: { reason: 'x'.repeat(2000) } }
  const saved = await repo.reserve(actor, large)
  const smaller = new OfficeConnectorExecutionRepository(domain, { ...policy, maxEntries: 1, maxBytes: 1024, maxInputBytes: 1024 })
  expect(await smaller.reserve(actor, large)).toEqual(saved)
  await expect(smaller.reserve(actor, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
  expect(smaller.list(actor)).toHaveLength(1)
})

it('counts complete multibyte input/result JSON and never stores an oversized result as successful', async () => {
  const { repo, actor, input } = await fixture({ maxInputBytes: 1024, maxResultBytes: 1024 })
  await expect(repo.reserve(actor, { ...input, values: { reason: '文'.repeat(400) } }))
    .rejects.toMatchObject({ code: 'context_too_large' })
  const saved = await repo.reserve(actor, input)
  await repo.dispatch(actor, saved.id)
  await expect(repo.finish(actor, saved.id, { stage: 'succeeded', result: { summary: '文'.repeat(400), entries: [] } }))
    .rejects.toMatchObject({ code: 'context_too_large' })
  expect(repo.list(actor)).toMatchObject([{ status: 'unknown', stage: 'dispatched' }])
})

it('reserves audit and result capacity before dispatch, releases it after a terminal receipt and retains the negotiated result bound', async () => {
  const { domain, actor, input } = await fixture()
  const limited = new OfficeConnectorExecutionRepository(domain, { ...policy, maxBytes: 6000, maxResultBytes: 4096 })
  const saved = await limited.reserve(actor, input)
  await expect(limited.reserve(actor, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
  await limited.dispatch(actor, saved.id)
  const lowered = new OfficeConnectorExecutionRepository(domain, { ...policy, maxBytes: 6000, maxResultBytes: 1024 })
  const result = { summary: 'x'.repeat(2000), entries: [] }
  expect(await lowered.finish(actor, saved.id, { stage: 'succeeded', result })).toMatchObject({ status: 'succeeded', result })
  expect(await lowered.finish(actor, saved.id, { stage: 'succeeded', result })).toMatchObject({ revision: 3 })
  expect((await lowered.reserve(actor, { ...input, requestId: randomUUID() })).id).not.toBe(saved.id)
})

it('keeps audit timestamps monotonic when the wall clock moves backwards', async () => {
  const { repo, actor, input } = await fixture()
  const saved = await repo.reserve(actor, input)
  vi.spyOn(Date, 'now').mockReturnValue(saved.admittedAt - 10000)
  await repo.dispatch(actor, saved.id)
  const receipt = await repo.finish(actor, saved.id, { stage: 'rejected', rejection: 'not_accepted' })
  expect(receipt.history.every(entry => entry.at === saved.admittedAt)).toBe(true)
  expect(receipt.updatedAt).toBe(saved.admittedAt)
})

it('refuses a corrupted fingerprint and lost office directory without replacing retained evidence', async () => {
  const { root, ctx, repo, actor, input } = await fixture()
  await repo.reserve(actor, input)
  await ctx.fiber.dispose()
  const path = join(root, 'data', 'enterprise_office_connector_executions.json')
  const original = await readFile(path, 'utf8')
  const file = JSON.parse(original) as { global: { entries: { fingerprint: string }[] } }
  file.global.entries[0]!.fingerprint = '0'.repeat(64)
  const corrupt = JSON.stringify(file)
  await writeFile(path, corrupt)
  const failed = await boot(root)
  expect(failed.get('office')).toBeUndefined()
  expect(await readFile(path, 'utf8')).toBe(corrupt)
  await failed.fiber.dispose()
  await writeFile(path, original)
  await rm(join(root, 'data', 'enterprise_office.json'))
  const orphaned = await boot(root)
  expect(orphaned.get('office')).toBeUndefined()
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('binds receipt reads to a current session, refuses forged actors and exposes no wire mutation endpoint', async () => {
  const { ctx, repo, actor, input } = await fixture()
  await repo.reserve(actor, input)
  const password = 'External execution test password!'
  await ctx.office.initializeIdentity(admin, password)
  await ctx.office.setIdentityPassword(admin, employee, password)
  const signed = await ctx.office.login({ memberId: employee, password })
  expect(await executeOfficeRequest(ctx.office, signed.token, { method: 'connectorExecutions', args: [] })).toMatchObject([
    { memberId: employee, requestId: input.requestId, status: 'reserved' },
  ])
  for (const request of [{ method: 'connectorExecutions', args: [admin] },
    { method: 'reserveConnectorExecution', args: [input] }, { method: 'finishConnectorExecution', args: [] }]) {
    await expect(executeOfficeRequest(ctx.office, signed.token, request)).rejects.toMatchObject({ code: 'invalid_input' })
  }
  await ctx.office.saveMember(admin, { ...actor, active: false }, actor)
  await expect(ctx.office.connectorExecutions(employee)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(executeOfficeRequest(ctx.office, signed.token, { method: 'connectorExecutions', args: [] }))
    .rejects.toMatchObject({ code: 'unauthenticated' })
})

it('pages only own small metadata, keeps stable older anchors across new admissions and reads large results separately', async () => {
  const { ctx, repo, actor, input } = await fixture()
  const admitted = []
  for (let index = 0; index < 43; index++) admitted.push(await repo.reserve(actor, { ...input, requestId: randomUUID(),
    values: { title: `Private request ${index}` } }))
  const latest = admitted.at(-1)!
  await repo.dispatch(actor, latest.id)
  const result = { summary: 'Employee-only authoritative receipt', entries: [{ label: 'Result', value: '文'.repeat(4000) }] }
  await repo.finish(actor, latest.id, { stage: 'succeeded', result })
  const first = await ctx.office.connectorExecutionPage(employee, { integrationId: input.integrationId })
  expect(first.entries).toHaveLength(20)
  expect(first.entries.map(entry => entry.id)).toEqual(admitted.slice(-20).toReversed().map(entry => entry.id))
  expect(first.next).toBe(first.entries.at(-1)?.id)
  expect(JSON.stringify(first)).not.toMatch(/Private request|authoritative|"result"|"history"|"values"/)
  expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(officeConnectorExecutionLimits.pageMaxBytes)
  await repo.reserve(actor, { ...input, requestId: randomUUID(), values: { title: 'Newer admission' } })
  const second = await ctx.office.connectorExecutionPage(employee, { integrationId: input.integrationId, before: first.next! })
  const third = await ctx.office.connectorExecutionPage(employee, { integrationId: input.integrationId, before: second.next! })
  expect(second.entries).toHaveLength(20)
  expect(third.entries).toHaveLength(3)
  expect(third.next).toBeNull()
  expect([...first.entries, ...second.entries, ...third.entries].map(entry => entry.id))
    .toEqual(admitted.toReversed().map(entry => entry.id))
  const detail = await ctx.office.connectorExecutionDetail(employee, latest.id)
  expect(detail.result).toEqual(result)
  expect(detail.history.map(entry => entry.stage)).toEqual(['reserved', 'dispatched', 'succeeded'])
  expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBeLessThanOrEqual(officeConnectorExecutionLimits.detailMaxBytes)
})

it('rejects foreign, cross-system and malformed history cursors, private details and forged network identities', async () => {
  const { ctx, repo, actor, input } = await fixture()
  const own = await repo.reserve(actor, input)
  const other = await repo.reserve(ctx.office.view(colleague).me, input)
  expect((await ctx.office.connectorExecutionPage(admin, { integrationId: input.integrationId })).entries).toEqual([])
  for (const before of [other.id, randomUUID(), 'invalid'])
    await expect(ctx.office.connectorExecutionPage(employee, { integrationId: input.integrationId, before: before as typeof own.id }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  const second = await ctx.office.importIntegration(admin, { requestId: randomUUID(), json: JSON.stringify({
    name: 'another-system', system: 'Another system', version: '1', provider: 'Company', description: 'History scope test', capabilities: ['Read'],
  }) })
  await expect(ctx.office.connectorExecutionPage(employee, { integrationId: second.id, before: own.id }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  await expect(ctx.office.connectorExecutionDetail(admin, own.id)).rejects.toMatchObject({ code: 'not_found' })
  await expect(ctx.office.connectorExecutionDetail(employee, other.id)).rejects.toMatchObject({ code: 'not_found' })
  const password = 'Execution history test password!'
  await ctx.office.initializeIdentity(admin, password)
  await ctx.office.setIdentityPassword(admin, employee, password)
  const signed = await ctx.office.login({ memberId: employee, password })
  expect(await executeOfficeRequest(ctx.office, signed.token, { method: 'connectorExecutionPage', args: [{ integrationId: input.integrationId }] }))
    .toMatchObject({ entries: [{ id: own.id }] })
  expect(await executeOfficeRequest(ctx.office, signed.token, { method: 'connectorExecutionDetail', args: [own.id] }))
    .toMatchObject({ id: own.id })
  await expect(executeOfficeRequest(ctx.office, signed.token, { method: 'connectorExecutionPage',
    args: [{ integrationId: input.integrationId, actorId: colleague }] })).rejects.toMatchObject({ code: 'invalid_input' })
})

it('cold-restores stable page anchors and unknown detail without installing or calling a customer adapter', async () => {
  const { root, ctx, repo, actor, input } = await fixture()
  const saved = await repo.reserve(actor, input)
  await repo.dispatch(actor, saved.id)
  const page = await ctx.office.connectorExecutionPage(employee, { integrationId: input.integrationId })
  await ctx.fiber.dispose()
  const restored = await boot(root)
  expect(await restored.office.connectorExecutionPage(employee, { integrationId: input.integrationId })).toEqual(page)
  expect(await restored.office.connectorExecutionDetail(employee, saved.id)).toMatchObject({ id: saved.id, status: 'unknown' })
})
