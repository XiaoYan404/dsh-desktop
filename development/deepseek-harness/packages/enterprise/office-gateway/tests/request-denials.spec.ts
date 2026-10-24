/** Central HTTP denials retain only authenticated operation metadata through real Loader and JSON storage. */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
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
import OfficeService, { executeOfficeRequest } from '@deepseek-ai/dsh-enterprise-office'
import type { Config as OfficeConfig } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeLoginResult, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeRequestDenialsDomain } from '@deepseek-ai/dsh-enterprise-office/src/request-denials.ts'
import OfficeGateway from '../src/index.ts'

const admin = 'admin' as OfficeMemberId
const employee = 'lin' as OfficeMemberId
const other = 'chen' as OfficeMemberId
const password = 'Request denial fixture password!'
const contexts: Context[] = []
const roots: string[] = []
const ledgerName = 'enterprise_office_request_denials.json'

async function boot(config: Partial<OfficeConfig> = {}, retainedRoot?: string) {
  const root = retainedRoot ?? await mkdtemp(join(tmpdir(), 'dsh-request-denials-'))
  if (!retainedRoot) roots.push(root)
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:storage' },
    { name: 'cordis:json', config: { root: join(root, 'data') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:office', config: { companyName: 'Denial company', timeZone: 'Asia/Shanghai', dshHome: root,
      members: [
        { id: admin, name: 'Admin', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
        { id: employee, name: 'Lin', department: 'Office', jobTitle: 'Employee', role: 'employee' },
        { id: other, name: 'Chen', department: 'Office', jobTitle: 'Employee', role: 'employee' },
      ], ...config } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, storage: Storage, json: StorageJson,
    domain: StorageDomain, office: OfficeService, gateway: OfficeGateway })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Request denial office did not activate')
  await ctx.office.initializeIdentity(admin, password)
  for (const { id: member } of ctx.office.view(admin).members.filter(member => member.id !== admin))
    if (!ctx.office.identityOverview(admin).enrolledMemberIds.includes(member))
      await ctx.office.setIdentityPassword(admin, member, password)
  await ctx.loader.create({ name: 'cordis:gateway', config: { host: '127.0.0.1', port: 0,
    administratorId: admin, loginRequestsPerMinute: 100 } })
  await ctx.loader.await()
  if (!ctx.get('officeGateway')) throw new Error('Request denial gateway did not activate')
  const address = ctx.officeGateway.address
  const request = (path: string, body: unknown, token?: string) => fetch(address + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...token ? { Authorization: `Bearer ${token}` } : {} },
    body: JSON.stringify(body) })
  const signIn = async (memberId: OfficeMemberId = employee): Promise<OfficeLoginResult> => {
    const response = await request('/v1/login', { memberId, password })
    expect(response.status).toBe(200)
    return (await response.json() as { value: OfficeLoginResult }).value
  }
  const rpc = (token: string, method: string, args: readonly unknown[]) => request('/v1/rpc', { method, args }, token)
  return { ctx, root, request, signIn, rpc, ledger: join(root, 'data', ledgerName) }
}

async function readLedger(path: string) {
  const document: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!document || typeof document !== 'object' || !('global' in document)) throw new Error('Missing denial global state')
  return officeRequestDenialsDomain.global.schema.parse(document.global)
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-request-denials-'))
      throw new Error('Unexpected request denial cleanup root')
    await rm(absolute, { recursive: true, force: true })
  }
})

it('persists an authenticated forbidden member change without publishing business success or retaining request content', async () => {
  const { ctx, root, signIn, rpc, ledger } = await boot()
  const signed = await signIn()
  const original = ctx.office.view(admin).me
  const business = await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')
  const changed = vi.fn()
  ctx.on('office/changed', changed)
  const response = await rpc(signed.token, 'saveMember', [{ ...original, role: 'employee', name: 'PRIVATE REJECTED BODY' }, original])
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ ok: false, code: 'forbidden' })
  expect(ctx.office.view(admin).me).toEqual(original)
  expect(await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')).toBe(business)
  expect(changed).not.toHaveBeenCalled()
  expect(await readdir(join(root, 'data'))).toContain(ledgerName)
  const text = await readFile(ledger, 'utf8')
  const saved = await readLedger(ledger)
  expect(saved).toMatchObject({ revision: 1, entries: [{ revision: 1, actorId: employee,
    action: 'saveMember', targetId: admin, code: 'forbidden' }] })
  expect(saved.entries[0]?.time).toBeTypeOf('number')
  for (const privateValue of [signed.token, password, 'PRIVATE REJECTED BODY', 'tokenHash', 'salt', 'digest'])
    expect(text).not.toContain(privateValue)
})

it('denial slice records work, invitation and Drive targets with the actual typed rejection and no success event', async () => {
  const { ctx, root, signIn, rpc, ledger } = await boot()
  const signed = await signIn()
  const administrator = await signIn(admin)
  const hidden = await ctx.office.createWork(admin, { kind: 'todo', title: 'PRIVATE hidden work', date: '2026-10-19', ownerId: admin })
  const own = await ctx.office.createWork(employee, { kind: 'todo', title: 'PRIVATE own work', date: '2026-10-19', ownerId: employee })
  const meeting = await ctx.office.createSchedule(admin, { title: 'PRIVATE meeting', date: '2026-10-19', startTime: '10:00',
    endTime: '11:00', inviteeIds: [other] })
  const folder = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'PRIVATE folder' })
  const business = await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')
  const drive = await readFile(join(root, 'data', 'enterprise_office_drive.json'), 'utf8')
  const changed = vi.fn()
  ctx.on('office/changed', changed)
  ctx.on('office/drive-changed', changed)
  const cases = [
    { token: signed.token, method: 'setStatus', args: [hidden.id, hidden.revision, 'completed'], target: hidden.id, code: 'not_found', status: 404 },
    { token: signed.token, method: 'reply', args: [meeting.id, meeting.revision, 'accepted'], target: meeting.id, code: 'not_found', status: 404 },
    { token: signed.token, method: 'saveDrivePermissions', args: [{ id: folder.id, revision: folder.revision,
      defaultAccess: 'edit', grants: [] }], target: folder.id, code: 'forbidden', status: 403 },
    { token: signed.token, method: 'setStatus', args: [own.id, own.revision + 1, 'completed'], target: own.id, code: 'conflict', status: 409 },
    { token: signed.token, method: 'reply', args: [own.id, own.revision, 'accepted'], target: own.id, code: 'forbidden', status: 403 },
    { token: administrator.token, method: 'saveDrivePermissions', args: [{ id: folder.id, revision: folder.revision,
      defaultAccess: 'view', grants: [{ memberId: employee, access: 'view' }, { memberId: employee, access: 'edit' }] }],
    target: folder.id, code: 'invalid_input', status: 400 },
  ]
  for (const attempt of cases) {
    const response = await rpc(attempt.token, attempt.method, attempt.args)
    expect(response.status).toBe(attempt.status)
    expect(await response.json()).toEqual({ ok: false, code: attempt.code })
  }
  expect((await readLedger(ledger)).entries.map(entry => ({ action: entry.action, targetId: entry.targetId, code: entry.code,
    actorId: entry.actorId }))).toEqual(cases.map(attempt => ({ action: attempt.method, targetId: attempt.target, code: attempt.code,
    actorId: attempt.token === administrator.token ? admin : employee })))
  expect(await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')).toBe(business)
  expect(await readFile(join(root, 'data', 'enterprise_office_drive.json'), 'utf8')).toBe(drive)
  expect(changed).not.toHaveBeenCalled()
  expect(await readFile(ledger, 'utf8')).not.toContain('PRIVATE')
})

it('denial slice ignores unauthenticated or malformed requests, claimed actors and unselected operations', async () => {
  const { ctx, root, request, signIn, rpc } = await boot()
  const signed = await signIn()
  const original = ctx.office.view(admin).me
  const args = [{ ...original, role: 'employee' }, original]
  for (const body of [
    { method: 'saveMember', args, actorId: admin },
    { method: 'saveMember', args: [{ ...original, actorId: admin }, original] },
    { method: 'unknown-operation', args },
  ]) expect((await request('/v1/rpc', body, signed.token)).status).toBe(400)
  expect((await request('/v1/rpc', { method: 'saveMember', args })).status).toBe(401)
  expect((await rpc('x'.repeat(43), 'saveMember', args)).status).toBe(401)
  expect((await request('/v1/login', { memberId: admin, password: 'PRIVATE invalid credential' })).status).toBe(401)
  expect((await rpc(signed.token, 'identityOverview', [])).status).toBe(403)
  expect(ctx.storageDomain.get(officeRequestDenialsDomain.name)!.global.get()).toEqual({ revision: 0, entries: [] })
  expect(await readdir(join(root, 'data'))).not.toContain(ledgerName)
})

it('denial slice serializes concurrent authenticated actors and resumes its exact sequence after restart', async () => {
  const { ctx, root, signIn, rpc, ledger } = await boot()
  const first = await signIn()
  const second = await signIn(other)
  const original = ctx.office.view(admin).me
  const business = await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => rpc(index % 2 ? second.token : first.token,
    'saveMember', [{ ...original, role: 'employee', name: 'PRIVATE parallel body' }, original])))
  expect(responses.map(response => response.status)).toEqual(Array(12).fill(403))
  const saved = await readLedger(ledger)
  expect(saved.entries.map(entry => entry.revision)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
  expect(saved.entries.filter(entry => entry.actorId === employee)).toHaveLength(6)
  expect(saved.entries.filter(entry => entry.actorId === other)).toHaveLength(6)
  const bytes = await readFile(ledger, 'utf8')
  await ctx.fiber.dispose()
  const reopened = await boot({}, root)
  expect(await readFile(ledger, 'utf8')).toBe(bytes)
  expect((await reopened.rpc(second.token, 'saveMember', [{ ...original, role: 'employee' }, original])).status).toBe(403)
  expect((await readLedger(ledger)).entries.at(-1)).toMatchObject({ revision: 13, actorId: other, action: 'saveMember' })
  expect(await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')).toBe(business)
})

it('denial slice keeps the verified initiating actor when its real session is revoked ahead of queued execution', async () => {
  const { ctx, signIn, ledger } = await boot()
  const signed = await signIn()
  const original = ctx.office.view(admin).me
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let first = true
  // oxlint-disable-next-line typescript/no-misused-promises -- Office commits await observers before releasing their queue slot.
  ctx.on('office/changed', async () => {
    if (!first) return
    first = false
    entered.resolve(undefined)
    await release.promise
  })
  const holding = ctx.office.createWork(admin, { kind: 'todo', title: 'Real committed queue owner', date: '2026-10-19', ownerId: admin })
  try {
    await entered.promise
    const revoked = ctx.office.logout(signed.token)
    const denied = expect(executeOfficeRequest(ctx.office, signed.token, { method: 'saveMember',
      args: [{ ...original, role: 'employee' }, original] })).rejects.toMatchObject({ code: 'unauthenticated' })
    release.resolve(undefined)
    await Promise.all([holding, revoked, denied])
    expect((await readLedger(ledger)).entries).toMatchObject([{ revision: 1, actorId: employee,
      action: 'saveMember', targetId: admin, code: 'unauthenticated' }])
  } finally {
    release.resolve(undefined)
    await holding
  }
})

it('denial slice returns a safe 503 after a real filesystem write failure and retains its previous durable state', async () => {
  const { ctx, root, signIn, rpc, ledger } = await boot()
  const signed = await signIn()
  const original = ctx.office.view(admin).me
  const args = [{ ...original, role: 'employee', name: 'PRIVATE failed write' }, original]
  expect((await rpc(signed.token, 'saveMember', args)).status).toBe(403)
  const retained = await readFile(ledger, 'utf8')
  const previous = await readLedger(ledger)
  const business = await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')
  expect(resolve(ledger)).toBe(join(resolve(root), 'data', ledgerName))
  const backup = ledger + '.retained'
  await rename(ledger, backup)
  await mkdir(ledger)
  try {
    const failed = await rpc(signed.token, 'saveMember', args)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({ ok: false, code: 'unavailable' })
    expect(ctx.storageDomain.get(officeRequestDenialsDomain.name)!.global.get()).toEqual(previous)
    expect(await readFile(backup, 'utf8')).toBe(retained)
    expect(await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')).toBe(business)
  } finally {
    await rmdir(ledger)
    await rename(backup, ledger)
  }
  expect((await rpc(signed.token, 'saveMember', args)).status).toBe(403)
  expect((await readLedger(ledger)).entries.map(entry => entry.revision)).toEqual([1, 2])
})

it.each(['entries', 'bytes'] as const)('denial slice enforces %s capacity without truncating history or blocking an authorized mutation', async (capacity) => {
  const longActor = ('employee_' + 'a'.repeat(119)) as OfficeMemberId
  const longTarget = ('target_' + 'b'.repeat(121)) as OfficeMemberId
  const config: Partial<OfficeConfig> = capacity === 'entries' ? { requestDenialMaxEntries: 1 } : {
    requestDenialMaxBytes: 1024,
    members: [
      { id: admin, name: 'Admin', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
      { id: longActor, name: 'Actor', department: 'Office', jobTitle: 'Employee', role: 'employee' },
      { id: longTarget, name: 'Target', department: 'Office', jobTitle: 'Employee', role: 'employee' },
    ],
  }
  const { ctx, signIn, rpc, ledger } = await boot(config)
  const signed = await signIn(capacity === 'entries' ? employee : longActor)
  const original = ctx.office.view(admin).members.find(member => member.id === (capacity === 'entries' ? admin : longTarget))!
  const args = [{ ...original, role: 'admin' }, original]
  const allowed = capacity === 'entries' ? 1 : 2
  for (let index = 0; index < allowed; index++) expect((await rpc(signed.token, 'saveMember', args)).status).toBe(403)
  const retained = await readFile(ledger, 'utf8')
  const failed = await rpc(signed.token, 'saveMember', args)
  expect(failed.status).toBe(503)
  expect(await failed.json()).toEqual({ ok: false, code: 'unavailable' })
  expect(await readFile(ledger, 'utf8')).toBe(retained)
  expect((await readLedger(ledger)).entries).toHaveLength(allowed)
  const own = await ctx.office.createWork(signed.member.id, { kind: 'todo', title: 'Authorized work after audit capacity',
    date: '2026-10-19', ownerId: signed.member.id })
  expect((await rpc(signed.token, 'setStatus', [own.id, own.revision, 'completed'])).status).toBe(200)
  expect(await readFile(ledger, 'utf8')).toBe(retained)
})

it('denial slice drains an admitted audit when shutdown begins before its write acknowledgement returns', async () => {
  const { ctx, root, signIn, ledger } = await boot()
  const signed = await signIn()
  const original = ctx.office.view(admin).me
  const office = ctx.office
  const entered = Promise.withResolvers<undefined>()
  let closing: Promise<void> | undefined
  ctx.on('domain/changed', (change) => {
    if (change.domain !== officeRequestDenialsDomain.name) return
    // The real backend has committed, while global.set and the office queue still owe their acknowledgements.
    closing = ctx.fiber.dispose()
    entered.resolve(undefined)
  })
  const denied = expect(executeOfficeRequest(office, signed.token, { method: 'saveMember',
    args: [{ ...original, role: 'employee' }, original] })).rejects.toMatchObject({ code: 'forbidden' })
  await entered.promise
  await denied
  await closing
  const retained = await readFile(ledger, 'utf8')
  expect((await readLedger(ledger)).entries).toMatchObject([{ actorId: employee, code: 'forbidden' }])
  await expect(executeOfficeRequest(office, signed.token, { method: 'saveMember', args: [original, original] }))
    .rejects.toMatchObject({ code: 'closed' })
  expect(await readFile(ledger, 'utf8')).toBe(retained)
  const reopened = await boot({}, root)
  expect(await readFile(ledger, 'utf8')).toBe(retained)
  expect(reopened.ctx.office.view(admin).me).toEqual(original)
})

it.each(['actor', 'sequence', 'directory'] as const)('denial slice refuses retained %s corruption or loss without replacing the ledger', async (kind) => {
  const { ctx, root, signIn, rpc, ledger } = await boot()
  const signed = await signIn()
  const original = ctx.office.view(admin).me
  expect((await rpc(signed.token, 'saveMember', [{ ...original, role: 'employee' }, original])).status).toBe(403)
  const saved = await readLedger(ledger)
  await ctx.fiber.dispose()
  if (kind === 'directory') {
    await rm(join(root, 'data', 'enterprise_office.json'))
    await rm(join(root, 'data', 'enterprise_office_identity.json'))
  } else {
    const changed = { ...saved, ...kind === 'sequence' ? { revision: 99 } : {},
      entries: saved.entries.map(entry => ({ ...entry, ...kind === 'actor' ? { actorId: 'missing_employee' } : {} })) }
    const document: unknown = JSON.parse(await readFile(ledger, 'utf8'))
    if (!document || typeof document !== 'object') throw new Error('Missing retained denial unit')
    await writeFile(ledger, JSON.stringify({ ...document, global: changed }))
  }
  const retained = await readFile(ledger, 'utf8')
  await expect(boot({}, root)).rejects.toThrow('Request denial office did not activate')
  expect(await readFile(ledger, 'utf8')).toBe(retained)
})
