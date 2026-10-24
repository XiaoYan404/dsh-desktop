/** Server time projection through real Loader, office authorization and durable JSON storage. */
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
import { brandString } from '@deepseek-ai/dsh-brand'
import OfficeService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { OfficeMemberId } from '../src/types.ts'

const admin = brandString<OfficeMemberId>('admin')
const employee = brandString<OfficeMemberId>('lin')
const other = brandString<OfficeMemberId>('chen')
const roots: string[] = []
const contexts: Context[] = []
const seed: Config = { companyName: 'Company clock', timeZone: 'Asia/Shanghai', members: [
  { id: admin, name: 'Admin', department: 'Office', jobTitle: 'Admin', role: 'admin' },
  { id: employee, name: 'Lin', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
  { id: other, name: 'Chen', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
] }

async function boot(timeZone = seed.timeZone, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-office-calendar-view-'))
  if (!existingRoot) roots.push(root)
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:storage' },
    { name: 'cordis:json', config: { root: join(root, 'data') } },
    { name: 'cordis:domain', config: { backend: 'json' } },
    { name: 'cordis:office', config: { ...seed, timeZone, dshHome: root } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins,
    { include: Include, storage: Storage, json: StorageJson, domain: StorageDomain, office: OfficeService })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Calendar office did not activate')
  return { ctx, root }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-calendar-view-'))
      throw new Error('Unexpected calendar cleanup root')
    await rm(absolute, { recursive: true, force: true })
  }
})

it('uses one server instant for company today and every authorized item across midnight', async () => {
  const { ctx, root } = await boot()
  const first = await ctx.office.createWork(employee, { kind: 'task', title: 'First untimed', date: '2026-10-19', ownerId: employee })
  const second = await ctx.office.createWork(employee, { kind: 'todo', title: 'Second untimed', date: '2026-10-19', ownerId: employee })
  const hidden = await ctx.office.createWork(other, { kind: 'task', title: 'Private work', date: '2026-10-18', ownerId: other })
  const path = join(root, 'data', 'enterprise_office.json')
  const before = await readFile(path)
  const now = Date.parse('2026-10-19T15:59:59.999Z')
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 1)
  const view = ctx.office.view(employee)
  expect(clock).toHaveBeenCalledTimes(1)
  expect(view.day.date).toBe('2026-10-19')
  expect(view.calendarTime).toEqual({ checkedAt: now, items: [first, second].map(item => ({
    itemId: item.id, kind: 'work', dueAt: now + 1, overdue: false,
  })) })
  clock.mockReturnValue(now + 1)
  expect(ctx.office.view(employee).calendarTime?.items.every(item => item.kind === 'work' && item.overdue)).toBe(true)
  expect(view.items.some(item => item.id === hidden.id)).toBe(false)
  expect(view.calendarTime?.items.some(item => item.itemId === hidden.id)).toBe(false)
  expect(await readFile(path)).toEqual(before)
})

it('keeps closed and retained inactive work out of unfinished overdue warnings', async () => {
  const { ctx } = await boot()
  const expired = await ctx.office.createWork(employee, { kind: 'task', title: 'Expired', date: '2026-10-18', time: '10:00', ownerId: employee })
  const completed = await ctx.office.createWork(employee, { kind: 'todo', title: 'Done', date: '2026-10-18', ownerId: employee, status: 'completed' })
  const cancelled = await ctx.office.createWork(employee, { kind: 'task', title: 'Cancelled', date: '2026-10-18', ownerId: employee, status: 'cancelled' })
  const archived = await ctx.office.createWork(employee, { kind: 'task', title: 'Archive', date: '2026-10-18', ownerId: employee })
  const deleted = await ctx.office.createWork(employee, { kind: 'todo', title: 'Recycle', date: '2026-10-18', ownerId: employee })
  await ctx.office.changeWorkLifecycle(employee, archived.id, archived.revision, { kind: 'archive', reason: 'Retain historical work' })
  await ctx.office.changeWorkLifecycle(employee, deleted.id, deleted.revision, { kind: 'delete', reason: 'Retain recycled work' })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-19T12:00:00Z'))
  const view = ctx.office.view(employee)
  const times = new Map(view.calendarTime?.items.map(item => [item.itemId, item]))
  expect(times.get(expired.id)).toMatchObject({ kind: 'work', overdue: true })
  for (const item of [completed, cancelled, archived, deleted])
    expect(times.get(item.id)).toMatchObject({ kind: 'work', overdue: false })
  expect(view.inactiveWork?.map(item => item.id).sort()).toEqual([archived.id, deleted.id].sort())
  const before = view.me
  await ctx.office.saveMember(admin, { ...before, active: false }, before)
  expect(() => ctx.office.view(employee)).toThrow(expect.objectContaining({ code: 'forbidden' }))
})

it('contains legacy gap and date-overflow failures to the authorized item across a real restart', async () => {
  const { ctx, root } = await boot('America/New_York')
  const gap = await ctx.office.createWork(employee, { kind: 'task', title: 'Legacy gap', date: '2026-03-08', time: '02:30', ownerId: employee })
  const meetingGap = await ctx.office.createSchedule(employee, { title: 'Legacy meeting gap', date: '2026-03-08', startTime: '01:30', endTime: '02:30', inviteeIds: [] })
  const overflow = await ctx.office.createWork(employee, { kind: 'todo', title: 'Unbounded next day', date: '9999-12-31', ownerId: employee })
  const valid = await ctx.office.createWork(employee, { kind: 'todo', title: 'Interpretable', date: '2026-03-08', time: '03:30', ownerId: employee })
  const hiddenGap = await ctx.office.createWork(other, { kind: 'task', title: 'Hidden gap', date: '2026-03-08', time: '02:30', ownerId: other })
  const path = join(root, 'data', 'enterprise_office.json')
  const before = await readFile(path)
  await ctx.fiber.dispose()
  // A new seed timezone cannot replace the durable company's timezone on restart.
  const restarted = await boot('Asia/Shanghai', root)
  const now = Date.parse('2026-03-08T07:45:00Z')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const view = restarted.ctx.office.view(employee)
  expect(view.timeZone).toBe('America/New_York')
  const times = new Map(view.calendarTime?.items.map(item => [item.itemId, item]))
  for (const item of [gap, meetingGap, overflow]) expect(times.get(item.id)).toEqual({ itemId: item.id, kind: 'unresolved' })
  expect(times.get(valid.id)).toEqual({ itemId: valid.id, kind: 'work', dueAt: Date.parse('2026-03-08T07:30:00Z'), overdue: true })
  expect(times.has(hiddenGap.id)).toBe(false)
  expect(view.items).toHaveLength(4)
  expect(await readFile(path)).toEqual(before)
})

it('shows server-derived meeting phases while leaving status and durable bytes unchanged', async () => {
  const { ctx, root } = await boot('America/New_York')
  const item = await ctx.office.createSchedule(employee, { title: 'Repeated-time meeting', date: '2026-11-01', startTime: '01:15', endTime: '01:45', inviteeIds: [] })
  const path = join(root, 'data', 'enterprise_office.json')
  const before = await readFile(path)
  const startsAt = Date.parse('2026-11-01T05:15:00Z')
  const endsAt = Date.parse('2026-11-01T05:45:00Z')
  const clock = vi.spyOn(Date, 'now')
  for (const [now, phase] of [[startsAt - 1, 'upcoming'], [startsAt, 'ongoing'], [endsAt, 'ended']] as const) {
    clock.mockReturnValue(now)
    const view = ctx.office.view(employee)
    expect(view.calendarTime).toEqual({ checkedAt: now, items: [{ itemId: item.id, kind: 'schedule', startsAt, endsAt, phase }] })
    expect(view.items[0]?.status).toBe('pending')
  }
  expect(await readFile(path)).toEqual(before)
})

it('preserves an infrastructure read failure instead of reporting an unresolved item', async () => {
  const { ctx } = await boot()
  const domain = ctx.storageDomain.get('enterprise_office')
  if (!domain) throw new Error('Calendar office domain is missing')
  const failure = new Error('Storage observation unavailable')
  vi.spyOn(domain.global, 'get').mockImplementationOnce(() => { throw failure })
  expect(() => ctx.office.view(employee)).toThrow(failure)
})
