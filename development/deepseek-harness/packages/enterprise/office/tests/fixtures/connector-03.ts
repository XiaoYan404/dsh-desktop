/** Real Loader and isolated JSON/credential owners shared only by the new group-03 scenarios. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { brandString } from '@deepseek-ai/dsh-brand'
import OfficeService from '../../src/index.ts'
import type { OfficeConnectorAdapter } from '../../src/connector-http.ts'
import type { OfficeConnectorWriteInput, OfficeMember, OfficeMemberId } from '../../src/types.ts'

/** Fixed active owner; no caller-supplied roles are accepted by the real Office service. */
export const lin = brandString<OfficeMemberId>('lin')
/** Another active employee for private-data denial. */
export const wei = brandString<OfficeMemberId>('wei')
/** Deployment administrator; it has no override to private automation runs. */
export const admin = brandString<OfficeMemberId>('admin')
/**
 * Start actual Office services through a persisted cordis.yml; no real customer or MySQL is contacted.
 * @param existingRoot - Optional owned test directory for restart evidence.
 * @returns Real context, private directory and explicit owned teardown.
 */
export async function bootConnector03(existingRoot?: string, allowedOrigins = ['http://127.0.0.1:49031']) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-group03-'))
  const ctx = new Context()
  let stopped = false
  async function stop() { if (!stopped) { stopped = true; await ctx.fiber.dispose() } }
  onTestFinished(async () => {
    await stop()
    if (!existingRoot) {
      const path = resolve(root)
      if (!path.startsWith(resolve(tmpdir()) + sep) || !basename(path).startsWith('dsh-group03-')) throw new Error('Foreign test root')
      await rm(path, { recursive: true, force: true })
    }
  })
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:storage' }, { name: 'cordis:json', config: { root: join(root, 'data') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:credentials', config: { dshHome: root, watch: false } },
    { name: 'cordis:office', config: { dshHome: root, companyName: 'Group 03 local protocol tests', timeZone: 'Asia/Shanghai',
      connectorAllowedOrigins: allowedOrigins, connectorCredentials: { oa: 'GROUP03_LOCAL_TEST' },
      members: [lin, wei, admin].map(id => ({ id, name: id, role: id === admin ? 'admin' : 'employee',
        department: 'Office', jobTitle: 'Employee' })) } },
  ]))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, storage: Storage, json: StorageJson,
    domain: StorageDomain, credentials: CredentialsLocal, office: OfficeService })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Group03 Loader did not activate Office')
  await ctx.credentials.set(credentialRef('GROUP03_LOCAL_TEST'), 'local-fixture-only')
  return { root, ctx, stop }
}

/**
 * Register an actual adapter and approved connection through Office's existing configuration and execution path.
 * @param ctx - Running Loader context.
 * @param adapter - Trusted provider, disposed with its test owner.
 * @returns Exact current action coordinates for one reviewed write.
 */
export async function connect03(ctx: Context, adapter: OfficeConnectorAdapter, origin = 'http://127.0.0.1:49031'): Promise<OfficeConnectorWriteInput> {
  ctx.effect(() => ctx.office.registerConnector(adapter))
  const integration = await ctx.office.importIntegration(admin, { requestId: randomUUID(), json: JSON.stringify({
    name: 'group03-test', system: adapter.id, version: '2.0.0', provider: 'Local protocol fixture',
    description: 'No real customer connection', capabilities: ['Reviewed operations'],
  }) })
  await ctx.office.saveConnection(admin, { integrationId: integration.id, revision: 0, requestId: randomUUID(),
    adapterId: adapter.id, baseUrl: origin + '/oa/', probePath: 'v2/health',
    authentication: { kind: 'bearer', credential: 'oa' }, enabled: true })
  const directory = await ctx.office.connectorActions(lin, integration.id)
  if (!directory.adapterRevision) throw new Error('Group03 provider unavailable')
  return { integrationId: integration.id, connectionRevision: 1, adapterRevision: directory.adapterRevision,
    actionId: adapter.actions?.find(value => value.kind === 'write')?.id ?? '', requestId: randomUUID(), values: { title: 'Reviewed title' } }
}

/** Fixture current identity mirror used by the leaf owner; writes still recheck actual Office authority. */
export function member03(id: OfficeMemberId): OfficeMember {
  return { id, role: id === admin ? 'admin' : 'employee', active: true, name: id,
    department: 'Office', jobTitle: 'Employee', email: '', phone: '' }
}
