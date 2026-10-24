/** Real Loader composition and isolated JSON resources for the new identity/collaboration behavior. */
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
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import type { Config } from '@deepseek-ai/dsh-enterprise-office'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeMemberId } from '../src/types.ts'
import type { OfficeCollaborationLimits } from '../src/collaboration-types.ts'

/** Current administrator; no synthetic role claims enter the service methods. */
export const admin = brandString<OfficeMemberId>('collab-admin')
/** Active employee with no administrator permissions. */
export const lin = brandString<OfficeMemberId>('collab-lin')
/** Second active employee. */
export const chen = brandString<OfficeMemberId>('collab-chen')
/** Nonmember used to exercise private-group denials. */
export const xu = brandString<OfficeMemberId>('collab-xu')
/** Fixture-owned secret is never logged or returned by test evidence. */
export const password = 'Only isolated collaboration fixture 2026!'
/** Explicit new deployment limits. */
export const limits: OfficeCollaborationLimits = { maxEntries: 1000, maxBytes: 4 * 1024 * 1024,
  maxGroupMembers: 20, maxOccurrences: 20, deliveryLeaseMs: 60000, maxDeliveryAttempts: 3 }
/**
 * Load the actual optional Office composition, retaining only fixture-owned resources across a requested restart.
 * @param config - Explicit deployment overrides.
 * @returns Running Office, storage and a real Loader restart helper.
 */
export async function collaborationFixture(config: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-group04-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-group04-')) throw new Error('Unexpected collaboration test root')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:storage' }, { name: 'cordis:json', config: { root: join(root, 'data') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:office', config: { companyName: 'Group04 actual fixture', timeZone: 'Asia/Shanghai', dshHome: root,
      members: [admin, lin, chen, xu].map(id => ({ id, name: id, department: 'Office', jobTitle: 'Employee', role: id === admin ? 'admin' : 'employee' })),
      collaboration: limits, memberInvites: { maxTtlMs: 3600000, maxEntries: 100, maxBytes: 65536 }, ...config } },
  ]))
  async function boot() {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, storage: Storage, json: StorageJson, domain: StorageDomain, office: OfficeService })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
    await ctx.loader.await()
    const office = ctx.get('office')
    if (!office) throw new Error('Real collaboration Office composition failed activation')
    return { ctx, office }
  }
  const running = await boot()
  return { ...running, root, boot, id: randomUUID }
}
