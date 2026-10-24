/** Administrator audit behavior through Loader composition and durable JSON storage. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { brandString } from '@deepseek-ai/dsh-brand'
import OfficeService, { executeOfficeRequest } from '../src/index.ts'
import { queryOfficeAudit } from '../src/audit.ts'
import type { Config } from '../src/index.ts'
import type { OfficeAuditRecord, OfficeAuditCursor, OfficeAuditPage, OfficeMemberId } from '../src/types.ts'

const admin = brandString<OfficeMemberId>('admin')
const employee = brandString<OfficeMemberId>('lin')
const roots: string[] = []
const contexts: Context[] = []
const seed: Config = { companyName: 'Audit company', timeZone: 'Asia/Shanghai', members: [
  { id: admin, name: 'Admin', department: 'Office', jobTitle: 'Admin', role: 'admin' },
  { id: employee, name: 'Lin', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
] }

async function boot(existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-office-audit-'))
  if (!existingRoot) roots.push(root)
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:storage' },
    { name: 'cordis:json', config: { root: join(root, 'data') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:office', config: { ...seed, dshHome: root } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins,
    { include: Include, storage: Storage, json: StorageJson, domain: StorageDomain, office: OfficeService })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Audit office did not activate')
  return { ctx, root }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-audit-'))
      throw new Error('Unexpected audit cleanup root')
    await rm(absolute, { recursive: true, force: true })
  }
})

it('attributes reactivation session revocation to the administrator who restored the employee', async () => {
  const { ctx, root } = await boot()
  const password = 'Audit fixture password 2026!'
  await ctx.office.initializeIdentity(admin, password)
  await ctx.office.setIdentityPassword(admin, employee, password)
  const receipt = await ctx.office.login({ memberId: employee, password })
  const original = ctx.office.view(employee).me
  const inactive = await ctx.office.saveMember(admin, { ...original, active: false }, original)
  await ctx.office.saveMember(admin, { ...inactive, active: true }, inactive)
  expect(() => ctx.office.authenticate(receipt.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  const path = join(root, 'data', 'enterprise_office_identity.json')
  const saved = JSON.parse(await readFile(path, 'utf8')) as { global: { audit: readonly object[] } }
  expect(saved.global.audit.at(-1)).toMatchObject({ action: 'session_revoked', actorId: admin, targetId: employee })
  await ctx.fiber.dispose()
  const restarted = await boot(root)
  expect(() => restarted.ctx.office.authenticate(receipt.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  expect(restarted.ctx.office.auditPage(admin, { limit: 100, before: null, source: 'identity',
    action: 'session_revoked' }).entries).toMatchObject([{ actorId: admin, targetId: employee }])
})

it('searches and exports six committed histories without credentials or business fields across restart', async () => {
  const { ctx, root } = await boot()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const password = 'Private audit fixture password!'
  await ctx.office.initializeIdentity(admin, password)
  const receipt = await ctx.office.login({ memberId: admin, password })
  await ctx.office.initializeOrganization(admin, ctx.office.view(admin).revision)
  await ctx.office.createSchedule(admin, { title: 'Private meeting title', date: '2026-10-18',
    startTime: '10:00', endTime: '11:00', inviteeIds: [employee] })
  await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Private folder name' })
  const integration = await ctx.office.importIntegration(admin, { requestId: randomUUID(), json: JSON.stringify({
    name: 'Audit OA', system: 'OA', version: '1.0', provider: 'Company', description: 'Private integration description',
    capabilities: ['Query approvals'],
  }) })
  await ctx.office.saveConnection(admin, { integrationId: integration.id, revision: 0, requestId: randomUUID(),
    adapterId: 'http-json', baseUrl: 'https://private-audit.invalid/', probePath: 'health',
    authentication: { kind: 'bearer', credential: 'private-audit-secret' }, enabled: false })
  const query = { limit: 100, before: null } as const
  const page = ctx.office.auditPage(admin, query)
  expect(new Set(page.entries.map(entry => entry.source))).toEqual(
    new Set(['business', 'identity', 'organization', 'drive', 'integration', 'connection']))
  expect(page.total).toBe(page.entries.length)
  expect(page.next).toBeNull()
  const combined: OfficeAuditRecord[] = []
  let older: OfficeAuditCursor | null = null
  do {
    const batch: OfficeAuditPage = ctx.office.auditPage(admin, { limit: 2, before: older })
    combined.push(...batch.entries)
    older = batch.next
  } while (older)
  expect(combined).toEqual(page.entries)
  const filtered = ctx.office.auditPage(admin, { ...query, source: 'integration', actorId: admin,
    targetId: integration.id, action: 'integration_imported' })
  expect(filtered.entries).toMatchObject([{ source: 'integration', actorId: admin, targetId: integration.id }])
  expect(filtered.total).toBe(1)
  const exported = ctx.office.auditExport(admin, query)
  expect(exported.mediaType).toBe('application/x-ndjson')
  expect(exported.content.endsWith('\n')).toBe(true)
  expect(exported.count).toBe(page.total)
  expect(exported.content.trimEnd().split('\n').map((line): unknown => JSON.parse(line))).toEqual(page.entries)
  for (const row of page.entries)
    expect(Object.keys(row).sort()).toEqual(['action', 'actorId', 'revision', 'source', 'targetId', 'time'])
  for (const secret of [password, receipt.token, 'salt', 'digest', 'tokenHash', 'Private meeting title',
    'Private folder name', 'Private integration description', 'private-audit.invalid', 'private-audit-secret'])
    expect(exported.content).not.toContain(secret)
  expect(await executeOfficeRequest(ctx.office, receipt.token, { method: 'auditPage', args: [query] })).toEqual(page)
  expect(await executeOfficeRequest(ctx.office, receipt.token, { method: 'auditExport', args: [query] })).toEqual(exported)
  await ctx.fiber.dispose()
  const restarted = await boot(root)
  expect(restarted.ctx.office.auditPage(admin, query)).toEqual(page)
  expect(restarted.ctx.office.auditExport(admin, query)).toEqual(exported)
})

it('pages equal timestamps without duplicates when later operations arrive and applies inclusive time filters', async () => {
  const { ctx } = await boot()
  const time = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(time)
  for (let index = 0; index < 5; index++)
    await ctx.office.createWork(employee, { kind: 'todo', title: `Work ${index}`, date: '2026-10-18', ownerId: employee })
  const query = { limit: 2, before: null, since: time, until: time } as const
  const expected = ctx.office.auditPage(admin, { ...query, limit: 100 }).entries
  const first = ctx.office.auditPage(admin, query)
  expect(first.entries.map(entry => entry.revision)).toEqual([5, 4])
  await ctx.office.createWork(employee, { kind: 'todo', title: 'Later operation', date: '2026-10-18', ownerId: employee })
  const entries: OfficeAuditRecord[] = [...first.entries]
  let before: OfficeAuditCursor | null = first.next
  while (before) {
    const page: OfficeAuditPage = ctx.office.auditPage(admin, { ...query, before })
    entries.push(...page.entries)
    before = page.next
  }
  expect(entries).toEqual(expected)
  expect(new Set(entries.map(entry => `${entry.source}:${entry.revision}`)).size).toBe(5)
  expect(ctx.office.auditPage(admin, { ...query, since: time + 1, until: time + 1 }).entries).toEqual([])
  expect(ctx.office.auditExport(admin, { ...query, source: 'identity' })).toEqual({
    mediaType: 'application/x-ndjson', content: '', count: 0, total: 0, next: null,
  })
})

it('withholds failed mutations and rechecks current administrator authority for every page and export', async () => {
  const { ctx, root } = await boot()
  const password = 'Audit authority password 2026!'
  await ctx.office.initializeIdentity(admin, password)
  await ctx.office.setIdentityPassword(admin, employee, password)
  const receipt = await ctx.office.login({ memberId: admin, password })
  const employeeReceipt = await ctx.office.login({ memberId: employee, password })
  const query = { limit: 1, before: null } as const
  await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Retained folder' })
  const before = ctx.office.auditPage(admin, { limit: 100, before: null })
  const disk = await readFile(join(root, 'data', 'enterprise_office_drive.json'), 'utf8')
  vi.spyOn(ctx.storageDomain.get('enterprise_office_drive')!.global, 'set')
    .mockRejectedValueOnce(new Error('Audit fixture drive commit unavailable'))
  await expect(ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Failed folder' }))
    .rejects.toThrow('Audit fixture drive commit unavailable')
  expect(ctx.office.auditPage(admin, { limit: 100, before: null })).toEqual(before)
  expect(await readFile(join(root, 'data', 'enterprise_office_drive.json'), 'utf8')).toBe(disk)
  for (const method of ['auditPage', 'auditExport'])
    await expect(executeOfficeRequest(ctx.office, employeeReceipt.token, { method, args: [query] }))
      .rejects.toMatchObject({ code: 'forbidden' })
  const first = ctx.office.auditPage(admin, query)
  const originalEmployee = ctx.office.view(employee).me
  await ctx.office.saveMember(admin, { ...originalEmployee, role: 'admin' }, originalEmployee)
  const originalAdmin = ctx.office.view(admin).me
  await ctx.office.saveMember(employee, { ...originalAdmin, role: 'employee' }, originalAdmin)
  for (const method of ['auditPage', 'auditExport'])
    await expect(executeOfficeRequest(ctx.office, receipt.token, { method, args: [{ ...query, before: first.next }] }))
      .rejects.toMatchObject({ code: 'forbidden' })
  const office = ctx.office
  await ctx.fiber.dispose()
  expect(() => office.auditPage(employee, query)).toThrow(expect.objectContaining({ code: 'closed' }))
  expect(() => office.auditExport(employee, query)).toThrow(expect.objectContaining({ code: 'closed' }))
})

it('copies only allowlisted metadata when a retained event contains additional private fields', () => {
  const event = { revision: 1, actorId: admin, targetId: 'work', action: 'work_created', time: 1,
    credential: 'private-extension', token: 'private-token' }
  const page = queryOfficeAudit({ business: [event], identity: [], organization: [], drive: [],
    integration: [], connection: [], requestDenials: [] }, { limit: 100, before: null })
  expect(page.entries).toEqual([{ source: 'business', revision: 1, actorId: admin,
    action: 'work_created', targetId: 'work', time: 1 }])
  expect(page.entries[0]).not.toBe(event)
})

it('request-denial audit retains authenticated codes through filtered pages, exports and a new Loader', async () => {
  const { ctx, root } = await boot()
  const password = 'Request denial audit password 2026!'
  const privateInput = 'PRIVATE rejected input must not enter audit output'
  await ctx.office.initializeIdentity(admin, password)
  await ctx.office.setIdentityPassword(admin, employee, password)
  const administrator = await ctx.office.login({ memberId: admin, password })
  const signed = await ctx.office.login({ memberId: employee, password })
  const original = ctx.office.view(admin).me
  const work = await ctx.office.createWork(employee, {
    kind: 'todo', title: 'Retained audit work', date: '2026-10-19', ownerId: employee,
  })
  const businessPath = join(root, 'data', 'enterprise_office.json')
  const businessBytes = await readFile(businessPath)
  for (const [request, code] of [
    [{ method: 'saveMember', args: [{ ...original, name: privateInput }, original] }, 'forbidden'],
    [{ method: 'setStatus', args: [work.id, work.revision + 1, 'completed'] }, 'conflict'],
    [{ method: 'setStatus', args: [randomUUID(), 1, 'completed'] }, 'not_found'],
  ] as const) {
    await expect(executeOfficeRequest(ctx.office, signed.token, request))
      .rejects.toThrow(expect.objectContaining({ code }))
  }
  expect(await readFile(businessPath)).toEqual(businessBytes)
  const query = { limit: 100, before: null, source: 'request_denial' } as const
  const page = ctx.office.auditPage(admin, query)
  expect(page.total).toBe(3)
  expect(page.next).toBeNull()
  expect(page.entries.map(entry => entry.denialCode)).toEqual(['not_found', 'conflict', 'forbidden'])
  expect(page.entries.every(entry => entry.source === 'request_denial' && entry.actorId === employee)).toBe(true)
  expect(page.entries.map(entry => entry.revision)).toEqual([3, 2, 1])
  const expectedKeys = ['source', 'revision', 'actorId', 'action', 'targetId', 'time', 'denialCode'].sort()
  for (const entry of page.entries) expect(Object.keys(entry).sort()).toEqual(expectedKeys)
  const paged: OfficeAuditRecord[] = []
  let cursor: OfficeAuditCursor | null = null
  do {
    const batch = ctx.office.auditPage(admin, { ...query, limit: 1, before: cursor })
    paged.push(...batch.entries)
    cursor = batch.next
  } while (cursor)
  expect(paged).toEqual(page.entries)
  const first = page.entries[2]!
  expect(ctx.office.auditPage(admin, { ...query, actorId: employee, targetId: admin, action: 'saveMember',
    since: first.time, until: first.time }).entries).toEqual([first])
  const exported = ctx.office.auditExport(admin, query)
  expect(exported.content).toBe(page.entries.map(entry => JSON.stringify(entry) + '\n').join(''))
  await expect(executeOfficeRequest(ctx.office, administrator.token, { method: 'auditPage', args: [query] }))
    .resolves.toEqual(page)
  await expect(executeOfficeRequest(ctx.office, administrator.token, { method: 'auditExport', args: [query] }))
    .resolves.toEqual(exported)
  for (const forbidden of [privateInput, password, administrator.token, signed.token])
    expect(exported.content).not.toContain(forbidden)
  for (const method of ['auditPage', 'auditExport']) {
    await expect(executeOfficeRequest(ctx.office, signed.token, { method, args: [query] }))
      .rejects.toThrow(expect.objectContaining({ code: 'forbidden' }))
  }
  expect(ctx.office.auditPage(admin, query)).toEqual(page)
  const denialPath = join(root, 'data', 'enterprise_office_request_denials.json')
  const denialBytes = await readFile(denialPath)
  await ctx.fiber.dispose()
  const reopened = await boot(root)
  expect(reopened.ctx.office.auditPage(admin, query)).toEqual(page)
  expect(reopened.ctx.office.auditExport(admin, query)).toEqual(exported)
  expect(await readFile(denialPath)).toEqual(denialBytes)
  expect(await readFile(businessPath)).toEqual(businessBytes)
})

it('request-denial audit isolates denial codes and private fields while paging equal timestamps across sources', () => {
  const privateValue = 'PRIVATE request and credential fields'
  const operation = { revision: 1, actorId: admin, targetId: 'work', action: 'work_created', time: 10,
    code: 'forbidden', body: privateValue }
  const denial = { revision: 1, actorId: employee, targetId: 'admin', action: 'saveMember', time: 10,
    code: 'forbidden', body: privateValue, credential: privateValue } as const
  const histories = { business: [operation], identity: [], organization: [], drive: [], integration: [], connection: [],
    requestDenials: [denial, { ...denial, revision: 2, code: 'conflict' as const }] }
  const first = queryOfficeAudit(histories, { limit: 2, before: null })
  expect(first.entries).toEqual([
    { source: 'business', revision: 1, actorId: admin, action: 'work_created', targetId: 'work', time: 10 },
    { source: 'request_denial', revision: 2, actorId: employee, action: 'saveMember', targetId: 'admin', time: 10,
      denialCode: 'conflict' },
  ])
  expect(first.next).toEqual({ source: 'request_denial', revision: 2, time: 10 })
  const second = queryOfficeAudit(histories, { limit: 2, before: first.next })
  expect(second.entries).toEqual([{ source: 'request_denial', revision: 1, actorId: employee,
    action: 'saveMember', targetId: 'admin', time: 10, denialCode: 'forbidden' }])
  expect(second.total).toBe(3)
  expect(second.next).toBeNull()
  expect(JSON.stringify([first, second])).not.toContain(privateValue)
})

it('rejects malformed filters, oversized batches and caller-claimed actors at the authenticated request parser', async () => {
  const { ctx } = await boot()
  const password = 'Audit parser password 2026!'
  await ctx.office.initializeIdentity(admin, password)
  const receipt = await ctx.office.login({ memberId: admin, password })
  const query = { limit: 1, before: null }
  for (const invalid of [{ ...query, limit: 0 }, { ...query, limit: 101 }, { ...query, source: 'credentials' },
    { ...query, since: 2, until: 1 }, { ...query, before: { time: 1, source: 'identity', revision: 0 } },
    { ...query, targetId: 'x'.repeat(129) }, { ...query, token: receipt.token }])
    await expect(executeOfficeRequest(ctx.office, receipt.token, { method: 'auditPage', args: [invalid] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  await expect(executeOfficeRequest(ctx.office, receipt.token, { method: 'auditExport', args: [query], actorId: employee }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  await expect(executeOfficeRequest(ctx.office, 'invalid', { method: 'auditPage', args: [{ limit: 0 }] }))
    .rejects.toMatchObject({ code: 'unauthenticated' })
  expect(() => ctx.office.auditPage(admin, { ...query, limit: 101 }))
    .toThrow(expect.objectContaining({ code: 'invalid_input' }))
})
