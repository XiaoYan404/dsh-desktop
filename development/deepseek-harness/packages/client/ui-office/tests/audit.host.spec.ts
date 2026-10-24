/** Real Loader storage and the authenticated gateway exercise both administrator audit Remote wrappers. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import OfficeGateway from '@deepseek-ai/dsh-enterprise-office-gateway'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import OfficePlugin from '../src/index.ts'

const admin = 'admin' as OfficeMemberId
const employee = 'lin' as OfficeMemberId
const contexts: Context[] = []
const roots: string[] = []
async function office(principal = admin) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-audit-controller-'))
  roots.push(root)
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:storage' }, { name: 'cordis:json', config: { root: join(root, 'data') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:office', config: { companyName: 'Audit company', timeZone: 'Asia/Shanghai', dshHome: root, members: [
      { id: admin, name: 'Admin', department: 'Office', jobTitle: 'Administrator', role: 'admin' },
      { id: employee, name: 'Lin', department: 'Office', jobTitle: 'Employee', role: 'employee' },
    ] } },
    { name: 'cordis:controller', config: { principalId: principal } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, storage: Storage, json: StorageJson, domain: StorageDomain,
    office: OfficeService, controller: OfficePlugin })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  if (!ctx.get('officeController')) throw new Error('Audit controller composition did not activate')
  return ctx
}
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-audit-controller-'))
      throw new Error('Unexpected audit controller cleanup root')
    await rm(absolute, { recursive: true, force: true })
  }
})

it('uses the fixed local principal and never lets an ordinary employee read or export administrator metadata', async () => {
  const ctx = await office(employee)
  const work = await ctx.office.createWork(admin, { kind: 'todo', title: 'Retained work', date: '2026-10-19', ownerId: employee })
  const query = { limit: 20, before: null, targetId: work.id }
  expect(await ctx.officeController.auditPage(query)).toEqual({ ok: false, code: 'forbidden' })
  expect(await ctx.officeController.auditExport(query)).toEqual({ ok: false, code: 'forbidden' })
  const original = ctx.office.view(admin).members.find(member => member.id === employee)!
  await ctx.office.saveMember(admin, { ...original, role: 'admin' }, original)
  const page = await ctx.officeController.auditPage(query)
  expect(page).toMatchObject({ ok: true, value: { total: 1, entries: [{ actorId: admin, targetId: work.id }] } })
  const exported = await ctx.officeController.auditExport(query)
  expect(exported).toMatchObject({ ok: true, value: { mediaType: 'application/x-ndjson', count: 1 } })
  const promoted = ctx.office.view(employee).me
  await ctx.office.saveMember(admin, { ...promoted, role: 'employee' }, promoted)
  expect(await ctx.officeController.auditPage(query)).toEqual({ ok: false, code: 'forbidden' })
  expect(await ctx.officeController.auditExport(query)).toEqual({ ok: false, code: 'forbidden' })
})

it('reauthorizes every gateway page and export using the current signed-in role and session', async () => {
  const server = await office()
  const password = 'Audit controller password 2026!'
  await server.office.initializeIdentity(admin, password)
  await server.office.setIdentityPassword(admin, employee, password)
  await server.plugin(OfficeGateway, { host: '127.0.0.1', port: 0, administratorId: admin, loginRequestsPerMinute: 100 })
  const host = new Context()
  contexts.push(host)
  await host.plugin(MemoryCredentials)
  await host.plugin(OfficePlugin, { gatewayUrl: server.officeGateway.address })
  const query = { limit: 1, before: null }
  expect(await host.officeController.auditPage(query)).toEqual({ ok: false, code: 'unauthenticated' })
  await host.officeController.signIn({ memberId: admin, password })
  const first = await host.officeController.auditPage(query)
  if (!first.ok) throw new Error('Expected administrator audit metadata')
  expect(first.value.entries).toHaveLength(1)
  expect(await host.officeController.auditExport(query)).toMatchObject({ ok: true, value: { count: 1 } })
  const originalEmployee = server.office.view(employee).me
  await server.office.saveMember(admin, { ...originalEmployee, role: 'admin' }, originalEmployee)
  const originalAdmin = server.office.view(admin).me
  await server.office.saveMember(employee, { ...originalAdmin, role: 'employee' }, originalAdmin)
  expect(await host.officeController.auditPage({ ...query, before: first.value.next })).toEqual({ ok: false, code: 'forbidden' })
  expect(await host.officeController.auditExport(query)).toEqual({ ok: false, code: 'forbidden' })
  await host.officeController.signOut()
  expect(await host.officeController.auditPage(query)).toEqual({ ok: false, code: 'unauthenticated' })
  expect(await host.officeController.auditExport(query)).toEqual({ ok: false, code: 'unauthenticated' })
})
