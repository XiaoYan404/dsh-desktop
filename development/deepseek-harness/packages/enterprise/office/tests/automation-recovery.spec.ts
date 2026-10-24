/** Regression for two separate automation occurrences sharing an unresolved original connector execution. */
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { OfficeAutomationRepository, officeAutomationDomain } from '../src/automation.ts'
import { bootConnector03, connect03, lin, member03 } from './fixtures/connector-03.ts'

it('recovers a reused unresolved execution by original ledger id while preserving both automation request ids', async () => {
  const { ctx } = await bootConnector03()
  const posts: string[] = []
  const checks: string[] = []
  const write = await connect03(ctx, { id: 'group03-unresolved', actions: [{ id: 'submit', kind: 'write', label: 'Submit',
    description: 'Reviewed write', allowedRoles: ['employee'],
    fields: [{ name: 'title', label: 'Title', required: true, maxLength: 200 }] }],
  async probe() { return { status: 'connected' } }, async write(request) { posts.push(request.executionId); return { status: 'unknown' } },
  async reconcile(request) {
    checks.push(request.executionId)
    return { status: 'succeeded', result: { summary: 'Original acceptance', entries: [] } }
  } })
  const domain = await ctx.storageDomain.open(officeAutomationDomain)
  const repository = new OfficeAutomationRepository(domain, { member: member03,
    actions: (id, system) => ctx.office.connectorActions(id, system), write: (id, input) => ctx.office.writeConnectorAction(id, input),
    executions: id => ctx.office.connectorExecutions(id),
    check: (id, execution) => ctx.office.checkConnectorExecution(id, execution), audit() {},
  }, { maxRules: 10, maxRuns: 10, maxBytes: 1024 * 1024 })
  onTestFinished(async () => { await repository.close(); await domain.close() })
  const { requestId: _id, ...action } = write
  await repository.save(lin, { id: null, revision: 0, title: 'Shared unresolved write', enabled: true,
    trigger: { kind: 'event', source: 'expense' }, action, compensation: null })
  const originals = []
  for (let index = 0; index < 2; index++) {
    const initial = (await repository.trigger(lin, { kind: 'event', source: 'expense', occurrence: randomUUID() }))[0]!
    originals.push(await repository.executeReviewed(lin, initial.id, initial.revision, 'primary'))
  }
  expect(originals[0]!.primary.executionId).toBe(originals[1]!.primary.executionId)
  expect(originals[0]!.primary.requestId).not.toBe(originals[1]!.primary.requestId)
  const recovered = await repository.recover(lin, originals[1]!.id, 'primary')
  expect(recovered.primary).toMatchObject({ stage: 'succeeded', requestId: originals[1]!.primary.requestId })
  expect(posts).toHaveLength(1)
  expect(checks).toEqual(posts)
})
