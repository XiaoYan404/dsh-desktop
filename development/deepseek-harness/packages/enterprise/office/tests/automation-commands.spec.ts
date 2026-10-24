/** Wire admission and failed-compensation recovery do not create another primary business operation. */
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { OfficeAutomationRepository, officeAutomationDomain } from '../src/automation.ts'
import { executeOfficeAutomationCommand, officeAutomationCommand } from '../src/automation-request.ts'
import { bootConnector03, connect03, lin, member03 } from './fixtures/connector-03.ts'

it('rejects forged principals, business events, native schedule receipts and arbitrary transport in the public route', () => {
  for (const input of [
    { kind: 'list', actorId: 'admin' }, { kind: 'trigger', trigger: 'schedule' },
    { kind: 'form', source: 'expense', occurrence: randomUUID(), ownerId: 'admin' },
    { kind: 'form', source: 'expense', occurrence: randomUUID(), url: 'https://unapproved.invalid' },
    { kind: 'execute', id: randomUUID(), revision: 1, part: 'primary', approved: true },
  ]) expect(officeAutomationCommand.safeParse(input).success).toBe(false)
})

it('retries definitively rejected compensation under a new review and retains the confirmed primary request and ledger id', async () => {
  const { ctx } = await bootConnector03()
  const posts: { id: string; action: string }[] = []
  let rejectCompensation = true
  const write = await connect03(ctx, { id: 'group03-compensation', actions: ['submit', 'withdraw'].map(id => ({
    id, kind: 'write', label: id, description: 'Separate reviewed action', allowedRoles: ['employee'],
    fields: [{ name: 'title', label: 'Title', required: true, maxLength: 200 }],
  })), async probe() { return { status: 'connected' } }, async write(request) {
    posts.push({ id: request.executionId, action: request.actionId })
    return request.actionId === 'withdraw' && rejectCompensation ? { status: 'rejected', rejection: 'not_accepted' }
      : { status: 'succeeded', result: { summary: 'Accepted operation only', entries: [] } }
  } })
  const domain = await ctx.storageDomain.open(officeAutomationDomain)
  const repository = new OfficeAutomationRepository(domain, { member: member03,
    actions: (id, system) => ctx.office.connectorActions(id, system), write: (id, input) => ctx.office.writeConnectorAction(id, input),
    executions: id => ctx.office.connectorExecutions(id),
    check: (id, execution) => ctx.office.checkConnectorExecution(id, execution), audit() {},
  }, { maxRules: 10, maxRuns: 10, maxBytes: 1024 * 1024 })
  onTestFinished(async () => { await repository.close(); await domain.close() })
  const { requestId: _id, ...action } = write
  await repository.save(lin, { id: null, revision: 0, title: 'Compensate once', enabled: true,
    trigger: { kind: 'form', source: 'expense' }, action, compensation: { ...action, actionId: 'withdraw' } })
  const fired = await executeOfficeAutomationCommand(repository, lin,
    officeAutomationCommand.parse({ kind: 'form', source: 'expense', occurrence: randomUUID() }))
  if (fired.kind !== 'runs' || !fired.runs[0]) throw new Error('Expected original pending run')
  const first = await repository.executeReviewed(lin, fired.runs[0].id, 1, 'primary')
  const pending = await repository.manage(lin, first.id, first.revision, 'compensate')
  const failed = await repository.executeReviewed(lin, pending.id, pending.revision, 'compensation')
  expect(failed.compensation?.stage).toBe('rejected')
  const retry = await repository.manage(lin, failed.id, failed.revision, 'retry')
  expect(retry.primary).toEqual(first.primary)
  expect(retry.compensation?.stage).toBe('pending_approval')
  expect(retry.compensation?.requestId).not.toBe(failed.compensation?.requestId)
  expect(posts.map(value => value.action)).toEqual(['submit', 'withdraw'])
  rejectCompensation = false
  expect((await repository.executeReviewed(lin, retry.id, retry.revision, 'compensation')).compensation?.stage).toBe('succeeded')
  expect(posts.map(value => value.action)).toEqual(['submit', 'withdraw', 'withdraw'])
  expect(new Set(posts.map(value => value.id)).size).toBe(3)
})
