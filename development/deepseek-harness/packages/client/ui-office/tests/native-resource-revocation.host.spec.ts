/** Native resource delivery retains the admitted role while ordinary employee history stays browsable. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables'
import type { OfficeConversationId, OfficeMemberId, OfficeRole } from '@deepseek-ai/dsh-enterprise-office/types'
import { alice, nativeJobsFixture } from './native-jobs-harness.host.ts'

const admin = 'admin' as OfficeMemberId
const accesses = ['terminal/access', 'workspace-files/access', 'job/access', 'deliverables/access'] as const

async function changeRole(fixture: Awaited<ReturnType<typeof nativeJobsFixture>>, role: OfficeRole): Promise<void> {
  const member = fixture.central.office.view(admin).members.find(value => value.id === alice)
  if (member === undefined) throw new Error('Fixture employee is missing')
  await fixture.central.office.saveMember(admin, { ...member, role }, member)
}

async function submitCurrentRole(fixture: Awaited<ReturnType<typeof nativeJobsFixture>>): Promise<void> {
  const conversationId = String(fixture.session.id) as OfficeConversationId
  const links = await fixture.ctx.officeController.conversationLinks(conversationId)
  if (!links.ok) throw new Error('Fixture association is unavailable')
  const capture = await fixture.ctx.officeController.captureConversation({ conversationId,
    revision: links.value.selection.revision, requestId: randomUUID() })
  if (!capture.ok) throw new Error('Fixture role could not be captured')
  fixture.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Reviewed new role.' }],
    source: { kind: 'user', preparedContexts: [{ text: 'Reviewed Office input',
      source: { kind: 'office', form: 'snapshot', sections: [], capture: capture.value } }] } }), { surfaceOp: 'append' })
}

it.each(accesses)('refuses %s after a server-side downgrade without hiding employee history', async (event) => {
  const fixture = await nativeJobsFixture('manager')
  const signal = new AbortController().signal
  const access = (currentSignal = signal) => fixture.ctx.waterfall(event,
    { sessionId: fixture.session.id, signal: currentSignal }, () => Promise.resolve(undefined))
  await access()
  const sequence = fixture.session.seq
  await changeRole(fixture, 'employee')
  expect(await fixture.visible()).toEqual([fixture.session.id])
  await expect(access()).rejects.toMatchObject({ code: 'session/not-found' })
  await expect(access(new AbortController().signal)).rejects.toMatchObject({ code: 'session/not-found' })
  expect(fixture.session.seq).toBe(sequence)
})

it('detaches old job output even when a fresh reviewed input has claimed the downgraded role', async () => {
  const fixture = await nativeJobsFixture('manager')
  const job = fixture.start()
  const abort = new AbortController()
  const output = fixture.ctx.jobController.follow({ sessionId: fixture.session.id, jobId: job.id }, abort.signal)[Symbol.asyncIterator]()
  try {
    expect((await output.next()).value).toMatchObject({ type: 'opened' })
    await changeRole(fixture, 'employee')
    await submitCurrentRole(fixture)
    job.append('PRIVATE_OLD_MANAGER_STREAM')
    await expect(output.next()).rejects.toMatchObject({ code: 'session/not-found' })
    expect(job.cancels).toEqual([])
    expect(fixture.ctx.jobs.get(job.id, fixture.session.id).status).toBe('running')
    const freshAbort = new AbortController()
    const fresh = fixture.ctx.jobController.follow({ sessionId: fixture.session.id, jobId: job.id },
      freshAbort.signal)[Symbol.asyncIterator]()
    try { expect((await fresh.next()).value).toMatchObject({ type: 'opened' }) }
    finally { freshAbort.abort(); await fresh.return?.() }
  } finally { abort.abort(); await output.return?.() }
})

it.each(accesses)('retains unrelated Native %s access across the same role downgrade', async (event) => {
  const fixture = await nativeJobsFixture('manager')
  const native = fixture.ctx.sessions.create()
  const signal = new AbortController().signal
  const access = () => fixture.ctx.waterfall(event, { sessionId: native.id, signal }, () => Promise.resolve(undefined))
  await access()
  await changeRole(fixture, 'employee')
  await expect(access()).resolves.toBeInstanceOf(AbortSignal)
  expect(native.seq).toBe(0)
})
