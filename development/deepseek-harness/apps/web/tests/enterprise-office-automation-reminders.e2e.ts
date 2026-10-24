/** Headless real Web composition exercises the new reminder skill through Native Schedule, delivery and deletion. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-schedule'
import { launchWebScaffold, readPersistedEvents } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

type ModelStep = (options: GenerateOptions) => StreamChunk[]
const provider = 'office-reminder-automation-fixture'

class ReminderAutomationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(readonly steps: ModelStep[]) { super() }
  override async listModels(name: string) { return [{ provider: name, id: 'reminders', name: 'Office reminder fixture' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.steps.shift()
    if (!step) throw new Error('Reminder automation model fixture exhausted')
    options.signal?.throwIfAborted()
    yield* step(options)
  }
}

function call(id: string, name: string, args: object): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function reply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function fixture(steps: ModelStep[]) {
  const scaffold = await launchWebScaffold({ profile: { packages: [] },
    extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const adapter = new ReminderAutomationAdapter(steps)
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'reminders' })
  const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd, agentPreset: 'standard' })
  const resolved = await scaffold.ctx.sessionController.resolveAgent(sessionId)
  if ('error' in resolved) throw resolved.error
  const agent = resolved.agent
  // This isolated fixture selects the existing full-access preset; the skill contributes no permission changes.
  scaffold.ctx.permissionPresets.set(agent.session, 'danger-full-access')
  const lifetime = new AbortController()
  onTestFinished(() => { lifetime.abort() })
  const send = async (text: string) => {
    const settled = scaffold.whenTurnSettled()
    await scaffold.ctx.sessionController.prompt({ sessionId, requestId: randomUUID() as SessionRequestId,
      mode: 'queue', content: [{ type: 'text', text }] }, lifetime.signal)
    await settled
  }
  return { scaffold, adapter, agent, sessionId, send }
}

it('runs the installed reminder skill, stores the actual id and records due inbox delivery separately from the model response', async () => {
  const message = 'Reminder: review the daily-report checklist.'
  const { scaffold, adapter, agent, sessionId, send } = await fixture([
    () => call('reminder-create', 'schedule_create', { title: 'Daily-report review', prompt: message, after_seconds: 1 }),
    () => call('reminder-verify', 'schedule_list', {}),
    () => reply('Reminder saved in this AI conversation. The due message is separate from task completion.'),
    () => reply('ACTUAL_REMINDER_MESSAGE_RECEIVED'),
  ])
  await send('/office-task-reminder In 1 second remind me in this AI conversation to review the daily-report checklist.')
  await expect.poll(async () => (await scaffold.ctx.schedule.catalog()).find(row => row.sessionId === sessionId)?.status,
    { timeout: 15_000 }).toBe('inactive')
  await expect.poll(
    () => agent.session.snapshotEvents().some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'ACTUAL_REMINDER_MESSAGE_RECEIVED')),
    { timeout: 15_000 },
  ).toBe(true)
  await agent.whenIdle()
  await scaffold.ctx.sessionPersistence.flush()
  const rows = await scaffold.ctx.schedule.catalog()
  expect(rows).toHaveLength(1)
  const task = rows[0]!
  expect(task).toMatchObject({ sessionId, title: 'Daily-report review', prompt: message, kind: 'after', status: 'inactive' })
  const events = await readPersistedEvents(scaffold, sessionId)
  const queued = events.flatMap(event => event.type === 'agent/inbox/spliced'
    ? event.data.inserted.filter(entry => entry.source.kind === 'schedule') : [])
  expect(queued).toHaveLength(1)
  const history = await scaffold.ctx.schedule.history({ sessionId, id: task.id, limit: 10 })
  if ('code' in history) throw new Error(`Missing reminder delivery history: ${history.code}`)
  expect(history.records).toHaveLength(1)
  expect(history.records[0]).toMatchObject({ messageId: queued[0]?.id, prompt: message, scheduledAt: task.scheduledAt })
  expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'schedule')).toHaveLength(1)
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toMatchInlineSnapshot(`
    [
      "schedule_create",
      "schedule_list",
    ]
  `)
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Native task reminders')
  expect(adapter.requests).toHaveLength(4)
  expect(adapter.steps).toEqual([])
})

it('cancels the exact saved reminder through native list and delete while retaining its real tool history', async () => {
  const steps: ModelStep[] = [
    () => call('cancel-create', 'schedule_create', { title: 'Cancel this reminder', prompt: 'Review the report.', after_seconds: 3600 }),
    () => call('cancel-created-list', 'schedule_list', {}),
    () => reply('Reminder saved for this conversation in one hour.'),
  ]
  const { scaffold, adapter, agent, sessionId, send } = await fixture(steps)
  await send('/office-task-reminder In one hour remind me in this AI conversation to review the report.')
  const [created] = await scaffold.ctx.schedule.list({ sessionId })
  if (!created) throw new Error('Expected the actual saved reminder')
  steps.push(() => call('cancel-review-list', 'schedule_list', {}),
    () => call('cancel-delete', 'schedule_delete', { id: created.id }),
    () => call('cancel-verify-list', 'schedule_list', {}),
    () => reply('The selected reminder was deleted. Already queued messages cannot be retracted.'))
  await send(`/office-task-reminder Cancel reminder ${created.id} in this AI conversation.`)
  expect(await scaffold.ctx.schedule.list({ sessionId })).toEqual([])
  expect(await scaffold.ctx.schedule.catalog()).toEqual([])
  await agent.whenIdle()
  await scaffold.ctx.sessionPersistence.flush()
  const events = await readPersistedEvents(scaffold, sessionId)
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'cancel-delete')
  if (result?.type !== 'tool/result') throw new Error('Missing the real cancellation result')
  const text = result.data.message.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Missing the cancellation result text')
  expect(JSON.parse(text.text)).toEqual({ id: created.id, deleted: true })
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toMatchInlineSnapshot(`
    [
      "schedule_create",
      "schedule_list",
      "schedule_list",
      "schedule_delete",
      "schedule_list",
    ]
  `)
  expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'schedule')).toBe(false)
  expect(adapter.steps).toEqual([])
})

it('records a real missing-time validation failure and leaves the reminder catalog empty', async () => {
  const { scaffold, adapter, agent, sessionId, send } = await fixture([
    () => call('missing-time-create', 'schedule_create', { title: 'Needs a time', prompt: 'Review the report.' }),
    () => call('missing-time-list', 'schedule_list', {}),
    () => reply('A time is required. No reminder was saved.'),
  ])
  await send('/office-task-reminder Remind me in this AI conversation to review the report; no time has been supplied.')
  expect(await scaffold.ctx.schedule.catalog()).toEqual([])
  await agent.whenIdle()
  await scaffold.ctx.sessionPersistence.flush()
  const events = await readPersistedEvents(scaffold, sessionId)
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'missing-time-create')
  if (result?.type !== 'tool/result') throw new Error('Missing the original native validation result')
  const text = result.data.message.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Missing the validation result text')
  expect(JSON.parse(text.text)).toMatchObject({ code: 'invalid_selector' })
  expect(events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted)
    .some(entry => entry.source.kind === 'schedule')).toBe(false)
  expect(adapter.steps).toEqual([])
})
