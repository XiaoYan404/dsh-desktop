/** Real Loader and isolated JSON stores exercise central reminder timing, authority and lifetime. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import OfficeService, { executeOfficeRequest } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { officeRemindersDomain, resolveOfficeReminderConfig } from '../src/reminders.ts'
import type { OfficeItem, OfficeMemberId, OfficeReminderConfig } from '../src/types.ts'

const admin = brandString<OfficeMemberId>('admin')
const lin = brandString<OfficeMemberId>('lin')
const chen = brandString<OfficeMemberId>('chen')
const xu = brandString<OfficeMemberId>('xu')
const inactive = brandString<OfficeMemberId>('inactive')
const interval = 137
const configured: OfficeReminderConfig = { pollIntervalMs: interval, catchUpWindowMs: 2 * 60 * 60 * 1000,
  maxEntries: 100, maxBytes: 1024 * 1024 }
const seed: Config = { companyName: 'Central reminder company', timeZone: 'Asia/Shanghai', members: [
  { id: admin, name: 'Administrator', department: 'Office', jobTitle: 'Admin', role: 'admin' },
  ...[lin, chen, xu, inactive].map(id => ({ id, name: id, department: 'Operations', jobTitle: 'Employee', role: 'employee' as const })),
] }
const contexts: Context[] = []
const roots: string[] = []
let now: number

beforeEach(() => {
  now = Date.parse('2026-10-19T02:00:00Z')
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

async function boot(options: { root?: string; config?: Partial<Config>; officeFirst?: boolean } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-office-reminders-'))
  if (!options.root) roots.push(root)
  const path = join(root, 'cordis.yml')
  const office = { name: 'cordis:office', config: { ...seed, dshHome: root, ...options.config } }
  const storage = [{ name: 'cordis:storage' }, { name: 'cordis:json', config: { root: join(root, 'data') } },
    { name: 'cordis:domain', config: { backend: 'json' } }]
  await writeFile(path, JSON.stringify(options.officeFirst ? [office, ...storage] : [...storage, office]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins,
    { include: Include, storage: Storage, json: StorageJson, domain: StorageDomain, office: OfficeService })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Reminder Loader did not activate the office service')
  return { ctx, root }
}

async function close(ctx: Context) {
  await ctx.fiber.dispose()
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-reminders-'))
      throw new Error('Unexpected reminder cleanup root')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function domain(ctx: Context) {
  const value = ctx.storageDomain.get('enterprise_office_reminders')
  if (!value) throw new Error('Reminder domain is missing')
  return value
}

function saved(ctx: Context) { return officeRemindersDomain.global.schema.parse(domain(ctx).global.get()) }
function notices(ctx: Context, actor = lin) { return ctx.office.view(actor).reminders?.entries ?? [] }
async function tick(ctx: Context) {
  await vi.advanceTimersByTimeAsync(interval)
  // The existing queue read settles only after the timer-admitted scan, including durable storage.
  await ctx.office.connections(admin)
  await Promise.resolve()
}
function work(ctx: Context, title: string, ownerId = lin) {
  return ctx.office.createWork(admin, { kind: 'task', title, date: '2026-10-19', time: '10:00', ownerId })
}
function latest(ctx: Context, item: OfficeItem) {
  const value = ctx.office.view(admin).items.find(entry => entry.id === item.id)
  if (!value) throw new Error('Expected current reminder fixture item')
  return value
}
function profile(ctx: Context, name: string) {
  const me = ctx.office.view(admin).me
  return { name, department: me.department, jobTitle: me.jobTitle, email: me.email, phone: me.phone }
}

it('keeps default polling absent and rejects invalid explicit timer or catch-up configuration', async () => {
  const { ctx, root } = await boot()
  await work(ctx, 'Default remains ordinary work')
  const before = await readFile(join(root, 'data/enterprise_office.json'))
  expect(ctx.storageDomain.get('enterprise_office_reminders')).toBeUndefined()
  expect(ctx.office.view(lin).reminders).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
  await tick(ctx)
  expect(await readFile(join(root, 'data/enterprise_office.json'))).toEqual(before)
  expect(() => OfficeService.Config({ ...seed, reminders: { ...configured, pollIntervalMs: 2147483648 } })).toThrow()
  expect(() => Schema.resolve({ ...seed, reminders: { pollIntervalMs: interval } }, OfficeService.Config, {})).toThrow()
  expect(() => resolveOfficeReminderConfig({ ...configured, catchUpWindowMs: interval - 1 })).toThrow()
})

it('delivers company-time work and live meetings only to current active eligible recipients', async () => {
  now = Date.parse('2026-11-01T05:15:00Z')
  const { ctx, root } = await boot({ config: { timeZone: 'America/New_York', reminders: configured } })
  const timed = await ctx.office.createWork(admin, { kind: 'task', title: 'Earlier overlap deadline', date: '2026-11-01', time: '01:15', ownerId: lin })
  const untimed = await ctx.office.createWork(admin, { kind: 'todo', title: 'Previous company day', date: '2026-10-31', ownerId: lin })
  await ctx.office.createWork(admin, { kind: 'task', title: 'Outside catch-up', date: '2026-10-01', ownerId: lin })
  await ctx.office.createWork(admin, { kind: 'task', title: 'Unresolved DST gap', date: '2026-03-08', time: '02:30', ownerId: lin })
  const meeting = await ctx.office.createSchedule(admin, { title: 'Live overlap meeting', date: '2026-11-01', startTime: '01:15', endTime: '01:45', inviteeIds: [lin, chen, xu, inactive] })
  await ctx.office.reply(chen, meeting.id, latest(ctx, meeting).revision, 'accepted')
  await ctx.office.reply(xu, meeting.id, latest(ctx, meeting).revision, 'declined')
  await ctx.office.createSchedule(admin, { title: 'Ended meeting', date: '2026-11-01', startTime: '00:10', endTime: '00:20', inviteeIds: [lin] })
  await ctx.office.createSchedule(admin, { title: 'Upcoming meeting', date: '2026-11-01', startTime: '01:30', endTime: '01:50', inviteeIds: [lin] })
  const previous = ctx.office.view(inactive).me
  await ctx.office.saveMember(admin, { ...previous, active: false }, previous)
  const original = await readFile(join(root, 'data/enterprise_office.json'))
  const published = vi.fn()
  ctx.on('office/reminders-changed', published)
  await tick(ctx)
  expect(notices(ctx).map(entry => [entry.itemId, entry.kind, entry.occursAt])).toEqual([
    [timed.id, 'work_due', now], [untimed.id, 'work_due', Date.parse('2026-11-01T04:00:00Z')], [meeting.id, 'meeting_start', now],
  ])
  expect(notices(ctx, admin).map(entry => entry.itemId)).toEqual([meeting.id])
  expect(notices(ctx, chen).map(entry => entry.itemId)).toEqual([meeting.id])
  expect(notices(ctx, xu)).toEqual([])
  expect(() => notices(ctx, inactive)).toThrow(expect.objectContaining({ code: 'forbidden' }))
  expect(published).toHaveBeenCalledTimes(1)
  expect(published).toHaveBeenCalledWith()
  expect(await readFile(join(root, 'data/enterprise_office.json'))).toEqual(original)
  const retained = saved(ctx)
  for (const entry of retained.entries)
    expect(Object.keys(entry).sort()).toEqual(['deliveredAt', 'id', 'itemId', 'kind', 'occursAt', 'read', 'recipientId'])
  const clock = vi.mocked(Date.now)
  clock.mockClear()
  expect(ctx.office.view(lin).calendarTime?.checkedAt).toBe(now)
  expect(clock).toHaveBeenCalledTimes(1)
  now = Date.parse('2026-11-01T05:45:00Z')
  expect(notices(ctx).some(entry => entry.itemId === meeting.id)).toBe(false)
  await close(ctx)
  const restored = await boot({ root, config: { reminders: configured } })
  expect(saved(restored.ctx)).toEqual(retained)
})

it('deduplicates by occurrence time through content edits, acknowledgements and a fresh Loader', async () => {
  const first = await boot({ config: { reminders: configured } })
  const item = await work(first.ctx, 'Original deadline')
  await tick(first.ctx)
  const original = notices(first.ctx)[0]!
  await first.ctx.office.markReminderRead(lin, original.id)
  let current = await first.ctx.office.updateWork(admin, item.id, item.revision, { title: '当前授权标题，不入账本', date: item.date, time: item.time, priority: 'high' })
  current = await first.ctx.office.setStatus(lin, current.id, current.revision, 'in_progress')
  await tick(first.ctx)
  expect(notices(first.ctx)).toEqual([{ ...original, read: true, itemTitle: current.title }])
  expect(saved(first.ctx).entries).toHaveLength(1)
  expect(await readFile(join(first.root, 'data/enterprise_office_reminders.json'), 'utf8')).not.toContain(current.title)
  await close(first.ctx)
  const restarted = await boot({ root: first.root, config: { reminders: configured } })
  await tick(restarted.ctx)
  expect(notices(restarted.ctx)).toEqual([{ ...original, read: true, itemTitle: current.title }])
  current = await restarted.ctx.office.updateWork(admin, current.id, current.revision, { title: current.title, date: current.date, time: '10:01' })
  expect(notices(restarted.ctx)).toEqual([])
  now += 60_000
  await tick(restarted.ctx)
  expect(notices(restarted.ctx)).toEqual([expect.objectContaining({ itemId: current.id, occursAt: now, read: false })])
  expect(notices(restarted.ctx)[0]!.id).not.toBe(original.id)
  expect(saved(restarted.ctx).entries).toHaveLength(2)
})

it('rechecks queued cancellations, archive, rescheduling, transfer and membership before delivering', async () => {
  const { ctx } = await boot({ config: { reminders: configured } })
  const completed = await work(ctx, 'Complete before poll')
  const cancelled = await work(ctx, 'Cancel before poll')
  const archived = await work(ctx, 'Archive before poll')
  const rescheduled = await work(ctx, 'Reschedule before poll')
  const transferred = await work(ctx, 'Transfer before poll')
  await work(ctx, 'Inactive employee is excluded')
  const office = ctx.storageDomain.get('enterprise_office')!
  const persist = office.global.set.bind(office.global)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const write = vi.spyOn(office.global, 'set').mockImplementationOnce(async (next) => {
    entered.resolve(undefined)
    await release.promise
    await persist(next)
  })
  const pendingProfile = ctx.office.updateProfile(admin, profile(ctx, 'Queue owner'))
  await entered.promise
  const disabled = ctx.office.view(lin).me
  const changes = [
    ctx.office.setStatus(lin, completed.id, completed.revision, 'completed'),
    ctx.office.setStatus(lin, cancelled.id, cancelled.revision, 'cancelled'),
    ctx.office.changeWorkLifecycle(admin, archived.id, archived.revision, { kind: 'archive', reason: 'Retain closed project' }),
    ctx.office.updateWork(admin, rescheduled.id, rescheduled.revision, { title: rescheduled.title, date: rescheduled.date, time: '11:00' }),
    ctx.office.decideTask(admin, transferred.id, transferred.revision, { kind: 'transfer', ownerId: chen, reason: 'Current assignee changed' }),
    ctx.office.saveMember(admin, { ...disabled, active: false }, disabled),
  ]
  await vi.advanceTimersByTimeAsync(interval)
  release.resolve(undefined)
  await pendingProfile
  await Promise.all(changes)
  await ctx.office.connections(admin)
  write.mockRestore()
  expect(saved(ctx).entries).toEqual([expect.objectContaining({ itemId: transferred.id, recipientId: chen })])
  expect(notices(ctx, chen)).toHaveLength(1)
  expect(() => notices(ctx, lin)).toThrow(expect.objectContaining({ code: 'forbidden' }))
  const moved = latest(ctx, transferred)
  await ctx.office.decideTask(admin, moved.id, moved.revision, { kind: 'transfer', ownerId: xu, reason: 'Final handover' })
  expect(notices(ctx, chen)).toEqual([])
  await tick(ctx)
  expect(notices(ctx, xu)).toHaveLength(1)
  expect(saved(ctx).entries).toHaveLength(2)
})

it('acknowledges only current recipient UUIDs and rejects a session that expires while queued', async () => {
  const { ctx, root } = await boot({ config: { reminders: configured } })
  await work(ctx, 'Private recipient reminder')
  await tick(ctx)
  const reminder = notices(ctx)[0]!
  const password = 'Central reminder fixture password 2026!'
  await ctx.office.initializeIdentity(admin, password)
  await ctx.office.setIdentityPassword(admin, lin, password)
  await ctx.office.setIdentityPassword(admin, chen, password)
  const signed = await ctx.office.login({ memberId: lin, password })
  const other = await ctx.office.login({ memberId: chen, password })
  const administrator = await ctx.office.login({ memberId: admin, password })
  const request = { method: 'markReminderRead', args: [reminder.id] }
  await expect(executeOfficeRequest(ctx.office, other.token, request)).rejects.toMatchObject({ code: 'not_found' })
  await expect(executeOfficeRequest(ctx.office, administrator.token, request)).rejects.toMatchObject({ code: 'not_found' })
  await expect(executeOfficeRequest(ctx.office, signed.token, { ...request, args: ['not-a-uuid'] })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(executeOfficeRequest(ctx.office, signed.token, { ...request, args: [randomUUID()] })).rejects.toMatchObject({ code: 'not_found' })
  await expect(executeOfficeRequest(ctx.office, signed.token, request)).resolves.toBeNull()
  const file = join(root, 'data/enterprise_office_reminders.json')
  const bytes = await readFile(file)
  await expect(executeOfficeRequest(ctx.office, signed.token, request)).resolves.toBeNull()
  expect(await readFile(file)).toEqual(bytes)
  expect(notices(ctx, admin)).toEqual([])
  const office = ctx.storageDomain.get('enterprise_office')!
  const persist = office.global.set.bind(office.global)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(office.global, 'set').mockImplementationOnce(async (next) => { entered.resolve(undefined); await release.promise; await persist(next) })
  const pendingProfile = ctx.office.updateProfile(admin, profile(ctx, 'Queue pause'))
  await entered.promise
  const queued = executeOfficeRequest(ctx.office, signed.token, request)
  const denied = expect(queued).rejects.toMatchObject({ code: 'unauthenticated' })
  now = signed.expiresAt
  release.resolve(undefined)
  await pendingProfile
  await denied
  expect(await readFile(file)).toEqual(bytes)
})

it('keeps whole batches unpublished on capacity or storage failure and rejects detached saved history', async () => {
  const bounded = await boot({ config: { reminders: { ...configured, maxEntries: 1 } } })
  const one = await work(bounded.ctx, 'First eligible work')
  const two = await work(bounded.ctx, 'Second eligible work')
  const changed = vi.fn()
  bounded.ctx.on('office/reminders-changed', changed)
  const warning = vi.spyOn(bounded.ctx.logger, 'warn').mockImplementation(() => {})
  await tick(bounded.ctx)
  expect(saved(bounded.ctx).entries).toEqual([])
  expect(changed).not.toHaveBeenCalled()
  await bounded.ctx.office.setStatus(admin, two.id, two.revision, 'cancelled')
  await tick(bounded.ctx)
  expect(saved(bounded.ctx).entries.map(entry => entry.itemId)).toEqual([one.id])
  const full = saved(bounded.ctx)
  await work(bounded.ctx, 'Capacity is retained')
  await tick(bounded.ctx)
  expect(saved(bounded.ctx)).toEqual(full)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(warning).toHaveBeenCalled()
  await close(bounded.ctx)

  const emptyBytes = Buffer.byteLength(JSON.stringify({ revision: 0, entries: [] }), 'utf8')
  const bytes = await boot({ config: { reminders: { ...configured, maxBytes: emptyBytes + 1 } } })
  await work(bytes.ctx, '多字节标题只在授权视图派生')
  const byteChanges = vi.fn()
  bytes.ctx.on('office/reminders-changed', byteChanges)
  vi.spyOn(bytes.ctx.logger, 'warn').mockImplementation(() => {})
  await tick(bytes.ctx)
  expect(saved(bytes.ctx).entries).toEqual([])
  expect(byteChanges).not.toHaveBeenCalled()
  await close(bytes.ctx)

  const retry = await boot({ config: { reminders: configured } })
  await work(retry.ctx, 'Storage retry keeps its occurrence')
  const retried = vi.fn()
  retry.ctx.on('office/reminders-changed', retried)
  const logs = vi.spyOn(retry.ctx.logger, 'warn').mockImplementation(() => {})
  vi.spyOn(domain(retry.ctx).global, 'set').mockRejectedValueOnce(new Error('PRIVATE reminder storage failure'))
  await tick(retry.ctx)
  expect(saved(retry.ctx).entries).toEqual([])
  expect(retried).not.toHaveBeenCalled()
  expect(JSON.stringify(logs.mock.calls)).not.toContain('PRIVATE')
  await tick(retry.ctx)
  expect(saved(retry.ctx).entries).toHaveLength(1)
  expect(retried).toHaveBeenCalledTimes(1)
  const history = saved(retry.ctx)
  await close(retry.ctx)
  await writeFile(join(retry.root, 'data/enterprise_office_reminders.json'), JSON.stringify({
    unit: { name: 'enterprise_office_reminders', version: 1 }, tables: {},
    global: { ...history, entries: history.entries.map(entry => ({ ...entry, recipientId: 'missing-original-member' })) },
  }))
  await expect(boot({ root: retry.root, config: { reminders: configured } })).rejects.toThrow('Reminder Loader did not activate')
})

it('drains an in-flight poll in either root disposal order and disables polling without discarding history', async () => {
  for (const officeFirst of [false, true]) {
    const fixture = await boot({ config: { reminders: configured }, officeFirst })
    await work(fixture.ctx, 'Drain owned reminder delivery')
    const persisted = domain(fixture.ctx).global.set.bind(domain(fixture.ctx).global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain(fixture.ctx).global, 'set').mockImplementationOnce(async (next) => {
      entered.resolve(undefined); await release.promise; await persisted(next)
    })
    const changed = vi.fn()
    fixture.ctx.on('office/reminders-changed', changed)
    await vi.advanceTimersByTimeAsync(interval)
    await entered.promise
    let disposed = false
    const closing = close(fixture.ctx).then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    await vi.advanceTimersByTimeAsync(interval * 20)
    expect(vi.getTimerCount()).toBe(0)
    release.resolve(undefined)
    await closing
    expect(changed).not.toHaveBeenCalled()
    const file = join(fixture.root, 'data/enterprise_office_reminders.json')
    const bytes = await readFile(file)
    const disabled = await boot({ root: fixture.root })
    expect(disabled.ctx.storageDomain.get('enterprise_office_reminders')).toBeUndefined()
    expect(disabled.ctx.office.view(lin).reminders).toBeUndefined()
    await tick(disabled.ctx)
    expect(await readFile(file)).toEqual(bytes)
    await close(disabled.ctx)
    const resumed = await boot({ root: fixture.root, config: { reminders: configured } })
    await tick(resumed.ctx)
    expect(saved(resumed.ctx).entries).toHaveLength(1)
    expect(notices(resumed.ctx)).toHaveLength(1)
    await close(resumed.ctx)
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('retains a pre-epoch work occurrence through durable restart and recipient acknowledgement', async () => {
  const occursAt = Date.parse('1969-12-31T15:30:00Z')
  const reminders = { ...configured, catchUpWindowMs: now - occursAt + interval }
  const first = await boot({ config: { reminders } })
  const item = await first.ctx.office.createWork(admin, { kind: 'todo', title: 'Retained pre-epoch company deadline',
    date: '1969-12-31', time: '23:30', ownerId: lin })
  await tick(first.ctx)
  const original = notices(first.ctx)[0]!
  expect(original).toMatchObject({ itemId: item.id, occursAt, deliveredAt: now, read: false })
  expect(occursAt).toBeLessThan(0)
  expect(saved(first.ctx).entries[0]?.occursAt).toBe(occursAt)
  await close(first.ctx)
  const restarted = await boot({ root: first.root, config: { reminders } })
  expect(notices(restarted.ctx)).toEqual([original])
  await tick(restarted.ctx)
  expect(saved(restarted.ctx).entries).toHaveLength(1)
  await restarted.ctx.office.markReminderRead(lin, original.id)
  expect(notices(restarted.ctx)).toEqual([{ ...original, read: true }])
  await close(restarted.ctx)
  const acknowledged = await boot({ root: first.root, config: { reminders } })
  expect(notices(acknowledged.ctx)).toEqual([{ ...original, read: true }])
})
