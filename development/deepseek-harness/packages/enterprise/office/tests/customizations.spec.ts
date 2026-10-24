/** Real Loader and JSON storage cover private drafts, immutable save receipts and authenticated transport. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService, { executeOfficeRequest } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { OfficeCustomizationInput, OfficeMemberId } from '../src/types.ts'

const admin = 'admin' as OfficeMemberId
const employee = 'lin' as OfficeMemberId
const roots: string[] = []
const contexts: Context[] = []
const seed: Config = { companyName: 'Customization company', timeZone: 'Asia/Shanghai', members: [
  { id: admin, name: 'Admin', department: 'Office', jobTitle: 'Admin', role: 'admin' },
  { id: employee, name: 'Lin', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
] }
function draft(target = 'Company OA'): OfficeCustomizationInput {
  return { id: null, revision: 0, requestId: randomUUID(), target, contact: 'Lin', requirements: '保留原有审批\n支持查询状态。' }
}
async function boot(config: Partial<Config> = {}, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-office-customization-'))
  if (!existingRoot) roots.push(root)
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:storage' },
    { name: 'cordis:json', config: { root: join(root, 'data') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:office', config: { ...seed, dshHome: root, ...config } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins,
    { include: Include, storage: Storage, json: StorageJson, domain: StorageDomain, office: OfficeService })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Customization office did not activate')
  return { ctx, root, file: join(root, 'data/enterprise_office_customizations.json') }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !absolute.includes('dsh-office-customization-'))
      throw new Error('Unexpected customization cleanup root')
    await rm(absolute, { recursive: true, force: true })
  }
})

it('preserves original receipts across edits and restart while keeping requirements private from administrators', async () => {
  const { ctx, root, file } = await boot()
  const input = draft()
  const first = await ctx.office.saveCustomizationRequest(employee, input)
  expect(first.record).toMatchObject({ ownerId: employee, companyName: seed.companyName, revision: 1, delivery: 'not_sent' })
  expect(first.record.requirements).toBe(input.requirements)
  const edit = { ...input, id: first.record.id, revision: 1, requestId: randomUUID(), requirements: '增加会议安排' }
  const second = await ctx.office.saveCustomizationRequest(employee, edit)
  expect(second.record).toMatchObject({ revision: 2, requirements: edit.requirements, createdAt: first.record.createdAt })
  expect(await ctx.office.saveCustomizationRequest(employee, input)).toEqual({ ...first, currentRevision: 2 })
  const bytes = await readFile(file)
  await expect(ctx.office.saveCustomizationRequest(employee, { ...input, requirements: 'changed retry' }))
    .rejects.toMatchObject({ code: 'conflict' })
  await expect(ctx.office.saveCustomizationRequest(employee, { ...edit, requestId: randomUUID() }))
    .rejects.toMatchObject({ code: 'conflict' })
  expect(await ctx.office.customizationRequests(admin, null)).toEqual({ meId: admin, entries: [], next: null })
  await expect(ctx.office.customizationRequest(admin, first.record.id)).rejects.toMatchObject({ code: 'not_found' })
  expect(await readFile(file)).toEqual(bytes)
  const page = await ctx.office.customizationRequests(employee, null)
  expect(page.entries).toHaveLength(1)
  expect(JSON.stringify(page)).not.toContain(edit.requirements)
  expect(JSON.stringify(page)).not.toContain('contact')
  await ctx.fiber.dispose()
  const restarted = await boot({}, root)
  expect(await restarted.ctx.office.customizationRequest(employee, first.record.id)).toEqual(second.record)
  expect(await restarted.ctx.office.saveCustomizationRequest(employee, input)).toEqual({ ...first, currentRevision: 2 })
  expect(await readFile(file)).toEqual(bytes)
})

it('publishes only durable saves and enforces operation and complete UTF-8 bounds without losing retry receipts', async () => {
  const { ctx, file } = await boot({ customizationMaxOperations: 2 })
  const firstInput = draft()
  const first = await ctx.office.saveCustomizationRequest(employee, firstInput)
  const before = await readFile(file)
  vi.spyOn(ctx.storageDomain.get('enterprise_office_customizations')!.global, 'set')
    .mockRejectedValueOnce(new Error('Draft storage unavailable'))
  const input = draft('New skill')
  await expect(ctx.office.saveCustomizationRequest(employee, input)).rejects.toThrow('Draft storage unavailable')
  expect(await readFile(file)).toEqual(before)
  expect((await ctx.office.customizationRequests(employee, null)).entries).toHaveLength(1)
  await ctx.office.saveCustomizationRequest(employee, input)
  const full = await readFile(file)
  await expect(ctx.office.saveCustomizationRequest(employee, draft())).rejects.toMatchObject({ code: 'customization_capacity' })
  expect(await ctx.office.saveCustomizationRequest(employee, firstInput)).toEqual(first)
  expect(await readFile(file)).toEqual(full)
  const bounded = await boot({ customizationMaxBytes: 2048 })
  const short = draft()
  const saved = await bounded.ctx.office.saveCustomizationRequest(employee, short)
  const bytes = await readFile(bounded.file)
  await expect(bounded.ctx.office.saveCustomizationRequest(employee, { ...short, id: saved.record.id, revision: 1,
    requestId: randomUUID(), requirements: '界'.repeat(900) })).rejects.toMatchObject({ code: 'customization_capacity' })
  expect(await readFile(bounded.file)).toEqual(bytes)
  expect(await bounded.ctx.office.customizationRequest(employee, saved.record.id)).toEqual(saved.record)
})

it('binds all three wire operations to sign-in and pages private metadata with stable save positions', async () => {
  const { ctx } = await boot()
  const password = 'Customization fixture password!'
  await ctx.office.initializeIdentity(admin, password)
  await ctx.office.setIdentityPassword(admin, employee, password)
  const signed = await ctx.office.login({ memberId: employee, password })
  const input = draft()
  const saved = await executeOfficeRequest(ctx.office, signed.token, { method: 'saveCustomizationRequest', args: [input] })
  expect(saved).toMatchObject({ meId: employee, record: { delivery: 'not_sent' } })
  for (const extra of [{ ownerId: admin }, { recipient: 'someone' }, { url: 'https://example.com' }, { delivery: 'sent' }]) {
    await expect(executeOfficeRequest(ctx.office, signed.token,
      { method: 'saveCustomizationRequest', args: [{ ...draft(), ...extra }] })).rejects.toMatchObject({ code: 'invalid_input' })
  }
  await expect(executeOfficeRequest(ctx.office, signed.token,
    { method: 'customizationRequests', args: [null], actorId: admin })).rejects.toMatchObject({ code: 'invalid_input' })
  const initial = (await ctx.office.customizationRequests(employee, null)).entries[0]!
  expect(await executeOfficeRequest(ctx.office, signed.token, { method: 'customizationRequest', args: [initial.id] }))
    .toMatchObject({ id: initial.id, ownerId: employee })
  for (let index = 0; index < 21; index++) await ctx.office.saveCustomizationRequest(employee, draft(`Request ${index}`))
  const page = await ctx.office.customizationRequests(employee, null)
  expect(page.entries).toHaveLength(20)
  expect(page.next).not.toBeNull()
  const anchor = await ctx.office.customizationRequest(employee, page.entries.at(-1)!.id)
  await ctx.office.saveCustomizationRequest(employee, { id: anchor.id, revision: anchor.revision, requestId: randomUUID(),
    target: anchor.target, contact: anchor.contact, requirements: 'Later edit' })
  const older = await executeOfficeRequest(ctx.office, signed.token, { method: 'customizationRequests', args: [page.next] })
  expect(older).toMatchObject({ meId: employee, next: null })
  const ownOlder = await ctx.office.customizationRequests(employee, page.next)
  expect(ownOlder.entries).toHaveLength(2)
  expect(ownOlder.entries.some(entry => page.entries.some(previous => previous.id === entry.id))).toBe(false)
})
