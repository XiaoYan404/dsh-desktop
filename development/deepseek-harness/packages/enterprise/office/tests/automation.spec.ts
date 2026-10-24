/** New automation paths use actual Loader, Office execution ledger and isolated JSON stores. */
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { OfficeAutomationRepository, officeAutomationDomain } from '../src/automation.ts'
import type { OfficeAutomationAction, OfficeAutomationHost, OfficeAutomationRun } from '../src/automation.ts'
import { ingestOfficeAutomationWebhook, ingestOfficeAutomationSchedule } from '../src/automation-triggers.ts'
import { OfficeError } from '../src/error.ts'
import type { OfficeConnectorWriteResult } from '../src/connector-http.ts'
import { bootConnector03, connect03, lin, wei, admin, member03 } from './fixtures/connector-03.ts'
import { wecomCapabilityReadiness } from '../src/wecom-capabilities.ts'

const bounds = { maxRules: 20, maxRuns: 100, maxBytes: 1024 * 1024 }
async function fixture() {
  const boot = await bootConnector03()
  let outcome: OfficeConnectorWriteResult = { status: 'succeeded', result: { summary: 'Accepted; business approval pending', entries: [] } }
  let checked: OfficeConnectorWriteResult = { status: 'succeeded', result: { summary: 'Original acceptance observed', entries: [] } }
  let active = true
  const posts: string[] = []
  const gets: string[] = []
  const input = await connect03(boot.ctx, { id: 'group03-automation', actions: [
    { id: 'submit', label: 'Submit', description: 'Reviewed write.', kind: 'write', allowedRoles: ['employee'],
      fields: [{ name: 'title', label: 'Title', required: true, maxLength: 200 }] },
    { id: 'withdraw', label: 'Withdraw', description: 'Separately reviewed compensation.', kind: 'write', allowedRoles: ['employee'],
      fields: [{ name: 'title', label: 'Original title', required: true, maxLength: 200 }] },
  ], async probe() { return { status: 'connected' } }, async write(request) { posts.push(request.executionId); return outcome },
  async reconcile(request) { gets.push(request.executionId); return checked } })
  const { requestId: _request, ...action } = input
  const domain = await boot.ctx.storageDomain.open(officeAutomationDomain)
  const audits: Parameters<OfficeAutomationHost['audit']>[0][] = []
  const host: OfficeAutomationHost = {
    member(id) { if (!active) throw new OfficeError('forbidden', 'Current owner revoked'); return member03(id) },
    actions: (id, integration) => boot.ctx.office.connectorActions(id, integration),
    write: (id, input) => boot.ctx.office.writeConnectorAction(id, input),
    executions: id => boot.ctx.office.connectorExecutions(id),
    check: (id, execution) => boot.ctx.office.checkConnectorExecution(id, execution), audit: (value) => { audits.push(value) },
  }
  let repository = new OfficeAutomationRepository(domain, host, bounds)
  onTestFinished(async () => { await repository.close(); await domain.close() })
  return { ...boot, action, host, audits, domain, posts, gets, get repository() { return repository },
    setOutcome(value: OfficeConnectorWriteResult) { outcome = value }, setChecked(value: OfficeConnectorWriteResult) { checked = value },
    revoke() { active = false },
    async restartLeaf() { await repository.close(); repository = new OfficeAutomationRepository(domain, host, bounds); return repository } }
}

async function rule(f: Awaited<ReturnType<typeof fixture>>, kind: 'form' | 'event' | 'webhook' | 'schedule' = 'form', source = 'expense',
  compensation: OfficeAutomationAction | null = null) {
  return f.repository.save(lin, { id: null, revision: 0, title: 'Reviewed automation', enabled: true,
    trigger: { kind, source }, action: f.action, compensation })
}
async function fire(f: Awaited<ReturnType<typeof fixture>>): Promise<OfficeAutomationRun> {
  const first = (await f.repository.trigger(lin, { kind: 'form', source: 'expense', occurrence: randomUUID() }))[0]
  if (!first) throw new Error('No admitted run')
  return first
}

it('admits all four stable trigger kinds without granting approval and authenticates exact Webhook bytes', async () => {
  const f = await fixture()
  for (const kind of ['form', 'event', 'webhook', 'schedule'] as const) await rule(f, kind, kind)
  const occurrence = randomUUID()
  const form = await f.repository.trigger(lin, { kind: 'form', source: 'form', occurrence })
  expect(await f.repository.trigger(lin, { kind: 'form', source: 'form', occurrence })).toEqual(form)
  expect(await f.repository.trigger(lin, { kind: 'event', source: 'event', occurrence })).toHaveLength(1)
  const config = { ownerId: lin, source: 'webhook', maxBytes: 4096, maxSkewMs: 60000 }
  const secret = Buffer.alloc(32, 0x47)
  const body = Buffer.from(JSON.stringify({ protocol: 1, eventId: occurrence }))
  const timestamp = String(Date.now())
  const signature = createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex')
  const webhook = await ingestOfficeAutomationWebhook(f.repository, config, { body, timestamp, signature }, secret)
  expect(await ingestOfficeAutomationWebhook(f.repository, config, { body, timestamp, signature }, secret)).toEqual(webhook)
  await expect(ingestOfficeAutomationWebhook(f.repository, config, { body: Buffer.concat([body, Buffer.from(' ')]), timestamp, signature }, secret))
    .rejects.toMatchObject({ code: 'forbidden' })
  await expect(ingestOfficeAutomationWebhook(f.repository, config, { body, timestamp: '0', signature }, secret)).rejects.toMatchObject({ code: 'forbidden' })
  const receipt = { id: 'schedule', sessionId: 'owned-session', lastDelivery: { scheduledAt: '2026-10-19T00:00:00.000Z',
    deliveredAt: '2026-10-19T00:00:01.000Z', messageId: randomUUID() } }
  const native = await ingestOfficeAutomationSchedule(f.repository, { ownerId: lin, scheduleId: 'schedule', sessionId: 'owned-session' }, receipt, async () => {})
  expect(native).toHaveLength(1)
  expect(f.repository.list(lin).runs).toHaveLength(4)
  expect(f.posts).toEqual([])
  expect(f.audits.filter(value => value.runId).every(value => value.stage === 'pending_approval')).toBe(true)
})

it('executes exact reviewed fields once and requires separate explicit compensation approval', async () => {
  const f = await fixture()
  await rule(f, 'form', 'expense', { ...f.action, actionId: 'withdraw' })
  const initial = await fire(f)
  expect(f.repository.review(lin, initial.id, 'primary')).toMatchObject({ revision: 1, action: f.action })
  const settled = await f.repository.executeReviewed(lin, initial.id, 1, 'primary')
  expect(settled.primary).toMatchObject({ stage: 'succeeded', requestId: initial.primary.requestId })
  await expect(f.repository.executeReviewed(lin, initial.id, 1, 'primary')).rejects.toMatchObject({ code: 'conflict' })
  const compensating = await f.repository.manage(lin, settled.id, settled.revision, 'compensate')
  expect(compensating.compensation?.stage).toBe('pending_approval')
  expect(f.posts).toHaveLength(1)
  expect(f.repository.review(lin, settled.id, 'compensation').action.actionId).toBe('withdraw')
  const restored = await f.repository.executeReviewed(lin, settled.id, compensating.revision, 'compensation')
  expect(restored.compensation?.stage).toBe('succeeded')
  expect(new Set(f.posts).size).toBe(2)
  expect(f.audits.every(value => !JSON.stringify(value).includes('Reviewed title'))).toBe(true)
})

it('retains original UUID after unknown dispatch, rejects retry/compensation and recovers only by original lookup', async () => {
  const f = await fixture()
  await rule(f, 'form', 'expense', { ...f.action, actionId: 'withdraw' })
  const initial = await fire(f)
  f.setOutcome({ status: 'unknown' })
  const unknown = await f.repository.executeReviewed(lin, initial.id, 1, 'primary')
  expect(unknown.primary.stage).toBe('unknown')
  await f.restartLeaf()
  await expect(f.repository.manage(lin, unknown.id, unknown.revision, 'retry')).rejects.toMatchObject({ code: 'conflict' })
  await expect(f.repository.manage(lin, unknown.id, unknown.revision, 'compensate')).rejects.toMatchObject({ code: 'conflict' })
  const recovered = await f.repository.recover(lin, unknown.id, 'primary')
  expect(recovered.primary).toMatchObject({ stage: 'succeeded', executionId: unknown.primary.executionId, requestId: initial.primary.requestId })
  expect(f.posts).toHaveLength(1)
  expect(f.gets).toEqual(f.posts)
})

it('preserves unknown on an absent original receipt and on outcome-storage failure without blindly calling write', async () => {
  const f = await fixture()
  await rule(f)
  const initial = await fire(f)
  const realWrite = f.host.write.bind(f.host)
  f.host.write = async () => { throw new Error('No authoritative dispatch evidence') }
  const uncertain = await f.repository.executeReviewed(lin, initial.id, 1, 'primary')
  f.host.write = realWrite
  expect((await f.repository.recover(lin, uncertain.id, 'primary')).primary).toMatchObject({ stage: 'unknown', requestId: initial.primary.requestId })
  expect(f.posts).toEqual([])
  const next = await fire(f)
  const originalSet = f.domain.global.set.bind(f.domain.global)
  const storage = vi.spyOn(f.domain.global, 'set')
  let sets = 0
  storage.mockImplementation(async (value) => { sets++; if (sets === 2) throw new Error('Outcome persistence failed'); await originalSet(value) })
  await expect(f.repository.executeReviewed(lin, next.id, next.revision, 'primary')).rejects.toThrow('Outcome persistence failed')
  storage.mockRestore()
  expect(f.repository.list(lin).runs.find(value => value.id === next.id)?.primary.stage).toBe('unknown')
  expect((await f.repository.recover(lin, next.id, 'primary')).primary.stage).toBe('succeeded')
  expect(f.posts).toHaveLength(1)
})

it('makes cancellation and disabled/stale rules send nothing while private ownership has no admin override', async () => {
  const f = await fixture()
  const savedRule = await rule(f)
  const initial = await fire(f)
  expect(f.repository.list(wei)).toEqual({ rules: [], runs: [] })
  expect(() => f.repository.review(admin, initial.id, 'primary')).toThrow()
  const cancelled = await f.repository.manage(lin, initial.id, 1, 'cancel')
  expect(cancelled.primary.stage).toBe('cancelled')
  const retry = await f.repository.manage(lin, cancelled.id, cancelled.revision, 'retry')
  expect(retry.parentId).toBe(initial.id)
  expect(retry.primary.requestId).not.toBe(initial.primary.requestId)
  const { ownerId: _owner, ownerRole: _role, createdAt: _created, ...editable } = savedRule
  await f.repository.save(lin, { ...editable, enabled: false })
  await expect(f.repository.executeReviewed(lin, retry.id, retry.revision, 'primary')).rejects.toMatchObject({ code: 'conflict' })
  expect(await f.repository.trigger(lin, { kind: 'form', source: 'expense', occurrence: randomUUID() })).toEqual([])
  expect(f.posts).toEqual([])
})

it('retries definitive nonacceptance only as a fresh child review and fences duplicate concurrent approval', async () => {
  const f = await fixture()
  await rule(f)
  f.setOutcome({ status: 'rejected', rejection: 'rate_limited' })
  const initial = await fire(f)
  const result = await f.repository.executeReviewed(lin, initial.id, 1, 'primary')
  expect(result.primary).toMatchObject({ stage: 'rejected', rejection: 'rate_limited' })
  const retry = await f.repository.manage(lin, result.id, result.revision, 'retry')
  expect(await f.repository.manage(lin, result.id, result.revision, 'retry')).toEqual(retry)
  expect(f.posts).toHaveLength(1)
  f.setOutcome({ status: 'succeeded', result: { summary: 'Accepted', entries: [] } })
  const concurrent = await Promise.allSettled([f.repository.executeReviewed(lin, retry.id, 1, 'primary'),
    f.repository.executeReviewed(lin, retry.id, 1, 'primary')])
  expect(concurrent.map(value => value.status)).toEqual(['fulfilled', 'rejected'])
  expect(f.posts).toHaveLength(2)
})

it('rechecks current membership and prevents failed run persistence from sending anything', async () => {
  const f = await fixture()
  await rule(f)
  const initial = await fire(f)
  const original = f.domain.global.set.bind(f.domain.global)
  const failure = vi.spyOn(f.domain.global, 'set').mockRejectedValueOnce(new Error('Reservation not durable'))
  await expect(f.repository.executeReviewed(lin, initial.id, 1, 'primary')).rejects.toThrow('Reservation not durable')
  failure.mockImplementation(original)
  f.revoke()
  await expect(f.repository.executeReviewed(lin, initial.id, 1, 'primary')).rejects.toMatchObject({ code: 'forbidden' })
  expect(f.posts).toEqual([])
  failure.mockRestore()
})

it('retains deduplication across actual JSON domain close/reopen and rejects unsafe stored history', async () => {
  const f = await fixture()
  await rule(f)
  const occurrence = randomUUID()
  const first = await f.repository.trigger(lin, { kind: 'form', source: 'expense', occurrence })
  await f.repository.close()
  await f.domain.close()
  const reopened = await f.ctx.storageDomain.open(officeAutomationDomain)
  const repository = new OfficeAutomationRepository(reopened, f.host, bounds)
  onTestFinished(async () => { await repository.close(); await reopened.close() })
  expect(await repository.trigger(lin, { kind: 'form', source: 'expense', occurrence })).toEqual(first)
  expect(await readFile(join(f.root, 'data', 'enterprise_office_automations.json'), 'utf8')).not.toContain('local-fixture-only')
  await reopened.global.set({ rules: [], runs: [...first] })
  await reopened.close()
  await expect(f.ctx.storageDomain.open(officeAutomationDomain)).rejects.toMatchObject({ code: 'invalid-record' })
  expect(f.posts).toEqual([])
})

it('never claims native WeCom tasks, card callbacks, delivery or customer connection from inventory booleans', () => {
  const pending = wecomCapabilityReadiness({ appIdentityConfigured: false, credentialReferenceConfigured: false,
    employeeMappingConfigured: false, originAllowed: false })
  expect(pending).toMatchObject({ profile: 'pending_configuration', nativeTodo: 'primary_protocol_required', customerConnected: false })
  const configured = wecomCapabilityReadiness({ appIdentityConfigured: true, credentialReferenceConfigured: true,
    employeeMappingConfigured: true, originAllowed: true })
  expect(configured).toMatchObject({ textMessage: 'configured_unverified', interactiveCard: 'primary_protocol_required',
    customerConnected: false, receiptEvidence: 'local_provider_only' })
})
