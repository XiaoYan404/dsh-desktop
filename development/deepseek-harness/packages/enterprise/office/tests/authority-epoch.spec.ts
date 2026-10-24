/** Native authority epoch checks use real JSON persistence, ordinary Office work and a complete Loader restart. */
import { expect, it } from 'vitest'
import { collaborationFixture, admin, lin } from './collaboration-fixture.ts'
import { officeAuthorityEpochDomain, OfficeAuthorityEpochRepository } from '../src/authority-epoch.ts'

it('keeps ordinary business writes independent of durable authentication revisions and retains role-review increments after restart', async () => {
  const { office, ctx, boot } = await collaborationFixture()
  const domain = await ctx.storageDomain.open(officeAuthorityEpochDomain)
  const epochs = new OfficeAuthorityEpochRepository(domain)
  await epochs.configure(true, false)
  const initial = epochs.current()
  await office.createWork(admin, { kind: 'task', title: 'Does not revoke a valid Native operation', date: '2026-10-19', ownerId: lin })
  expect(epochs.current()).toBe(initial)
  await epochs.advance()
  await epochs.advance()
  expect(epochs.current()).toBe(initial + 2)
  await domain.close()
  await ctx.fiber.dispose()
  const restored = await boot()
  const reopened = await restored.ctx.storageDomain.open(officeAuthorityEpochDomain)
  const retained = new OfficeAuthorityEpochRepository(reopened)
  await retained.configure(true, false)
  expect(retained.current()).toBe(initial + 2)
  await reopened.close()
})
it('advances on governance disable/enable ABA and refuses to reseed a missing directory over retained authority history', async () => {
  const { ctx } = await collaborationFixture()
  const domain = await ctx.storageDomain.open(officeAuthorityEpochDomain)
  const epochs = new OfficeAuthorityEpochRepository(domain)
  await epochs.configure(true, false)
  const initial = epochs.current()
  await epochs.configure(true, true)
  await epochs.configure(true, false)
  expect(epochs.current()).toBe(initial + 2)
  await expect(epochs.configure(false, false)).rejects.toMatchObject({ code: 'conflict' })
  await domain.close()
})
