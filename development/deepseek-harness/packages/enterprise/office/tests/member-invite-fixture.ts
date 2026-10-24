/** Isolated real Loader and JSON domains for first-password invitation service, HTTP and Host acceptance. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { onTestFinished, vi } from 'vitest'
import OfficeService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { OfficeMemberId, OfficeMemberInviteConfig } from '../src/types.ts'

/** Fixture administrator already owns the company's original credential. */
export const inviteAdmin = brandString<OfficeMemberId>('invite-admin')
/** New retained employee starts without any sign-in credential. */
export const inviteTarget = brandString<OfficeMemberId>('invite-target')
/** Another ordinary employee has no directory or invitation management authority. */
export const invitePeer = brandString<OfficeMemberId>('invite-peer')
/** Existing fixture password; never a customer credential. */
export const invitePassword = 'Isolated invitation fixture password 2026!'
/** Explicit finite fixture deployment policy. */
export const invitePolicy: OfficeMemberInviteConfig = { maxTtlMs: 3600000, maxEntries: 100, maxBytes: 65536 }

/**
 * Boot real storage and Office from a fixture-owned cordis.yml, retaining files for an optional restart.
 * @param config - Complete explicit invitation deployment override; an empty object tests the disabled default.
 * @returns Initial context, private root and a restart helper; teardown drains every acquired context and removes only this root.
 */
export async function createMemberInviteFixture(config: Partial<Config> = { memberInvites: invitePolicy }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-member-invite-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    vi.restoreAllMocks()
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-member-invite-'))
      throw new Error('Unexpected member invitation fixture directory')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await mkdir(join(root, 'data'))
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:inviteStorage' }, { name: 'cordis:inviteJson', config: { root: join(root, 'data') } },
    { name: 'cordis:inviteDomain', config: { backend: 'json' } },
    { name: 'cordis:inviteOffice', config: { companyName: 'Invitations fixture', timeZone: 'Asia/Shanghai', dshHome: root,
      members: [inviteAdmin, inviteTarget, invitePeer].map(id => ({ id, name: id, department: 'Office', jobTitle: 'Member',
        role: id === inviteAdmin ? 'admin' : 'employee' })), ...config } },
  ]))
  async function boot() {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, inviteStorage: Storage, inviteJson: StorageJson,
      inviteDomain: StorageDomain, inviteOffice: OfficeService })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    if (!ctx.get('office')) throw new Error('Real invitation authority did not activate')
    await ctx.office.initializeIdentity(inviteAdmin, invitePassword)
    return ctx
  }
  return { ctx: await boot(), root, boot }
}

/**
 * Issue a real current invitation for the uncredentialed fixture member.
 * @param ctx - Running fixture authority.
 * @returns First committed metadata and its actual, nonrecoverable code.
 */
export async function issueFixtureMemberInvite(ctx: Context) {
  const input = { requestId: randomUUID(), memberId: inviteTarget, expectedRole: 'employee' as const, expiresAt: Date.now() + 600000 }
  const receipt = await ctx.office.issueMemberInvite(inviteAdmin, input)
  if (!receipt.code) throw new Error('First committed invitation code is absent')
  return { input, ...receipt, code: receipt.code }
}
