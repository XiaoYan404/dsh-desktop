/** Keyless model fixtures drive the actual Loader, native loop, workflow children, files and durable deliveries. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolPresent from '@deepseek-ai/dsh-tool-present'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import { expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as AutomationSkills from '../src/automation-skills.ts'

const material = '2026-10-18 planning meeting. Decision: keep the current launch date. Lin will prepare the checklist by 2026-10-20. Budget remains undecided.'
const draft = '# Meeting minutes\n\nDecision: keep the launch date.\nLin: checklist by 2026-10-20.\nBudget: undecided.\n'
const minutes = '# Meeting minutes\n\n## Confirmed decisions\nKeep the current launch date.\n\n## Action items\n- Lin: prepare the checklist by 2026-10-20.\n\n## Open questions\nBudget remains undecided. Participants: unknown.\n'
type Script = ConstructorParameters<typeof MockAdapter>[0]

async function fixture(script: Script) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-minutes-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  await writeFile(join(cwd, 'meeting.txt'), material)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-minutes-')) {
      throw new Error('Unexpected minutes fixture directory')
    }
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjections], ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-fs-local', FsLocal], ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
    ['@deepseek-ai/dsh-tools', ToolRuntime], ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop], ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence],
    ['@deepseek-ai/dsh-skill', SkillRegistry], ['office-automation-skills', AutomationSkills],
    ['@deepseek-ai/dsh-tool-skill', ToolSkill], ['@deepseek-ai/dsh-subprocess-local', SubprocessLocal],
    ['@deepseek-ai/dsh-sandbox-local', SandboxLocal], ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicy],
    ['@deepseek-ai/dsh-ptc-runtime-node', NodePtcRuntime], ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', SpawnInProcess], ['@deepseek-ai/dsh-workflow-ptc', PtcWorkflowEngine],
    ['@deepseek-ai/dsh-tool-workflow', ToolWorkflow], ['@deepseek-ai/dsh-tool-fs', ToolFs],
    ['@deepseek-ai/dsh-tool-present', ToolPresent],
  ])
  const config: Record<string, object> = {
    '@deepseek-ai/dsh-agent-loop': { agents: [] },
    '@deepseek-ai/dsh-session-persistence-jsonl': { root: join(root, 'sessions') },
    '@deepseek-ai/dsh-sandbox-policy': { mode: 'danger-full-access', workspaceRoot: cwd },
    '@deepseek-ai/dsh-ptc-runtime-node': { graceMs: 50 },
    '@deepseek-ai/dsh-subagent-spawn-in-process': { providerName: 'spawn' },
    '@deepseek-ai/dsh-workflow-ptc': { maxConcurrentAgents: 1, maxTotalAgents: 2 },
    '@deepseek-ai/dsh-tool-workflow': { enableRunInBackground: false },
  }
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([...modules.keys()].map(name => ({ name, config: config[name] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (!internal) throw new Error('Missing Loader internal configuration')
  ctx.loader.internal = new Proxy(internal, {
    get(target, key) {
      if (key === 'import') return async (name: string) => {
        if (!modules.has(name)) throw new Error(`Unexpected minutes fixture module: ${name}`)
        return modules.get(name)
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('workflowEngine') || !ctx.get('skills') || !ctx.tools.get('present')) {
    throw new Error('Minutes composition did not activate')
  }
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['minutes-fixture'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'minutes-fixture', model: 'fixture' }, { cwd })
  const skill = await ctx.skills.get('office-minutes')
  if (!skill) throw new Error('Minutes skill was not registered')
  const workflowScript = /```javascript\r?\n([\s\S]*?)\r?\n```/u.exec(skill.content)?.[1]
  if (!workflowScript) throw new Error('Minutes skill has no workflow script')
  return { ctx, root, cwd, agent, adapter, skill, workflowScript }
}

function workflow(script: string) {
  return toolCallResponse('minutes-workflow', 'workflow', {
    script, meta: { name: 'office-minutes', description: 'Extract and review meeting minutes',
      phases: [{ title: 'Extract' }, { title: 'Review' }] }, args: { material },
  })
}

function send(ctx: Context, agent: Agent): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '/office-minutes Run the extraction and review workflow on meeting.txt and save meeting-minutes.md.' }],
    source: { kind: 'user' },
  }))
  return idle
}

function record(events: readonly SessionEvent[]) {
  return events.flatMap((event) => {
    switch (event.type) {
      case 'tool-workflow/run-start': return [`start:${event.data.name}`]
      case 'tool-workflow/agent-start': return [`member:${event.data.phase}:${event.data.label}`]
      case 'tool-workflow/agent-end': return [`member-end:${event.data.outcome}`]
      case 'tool-workflow/run-end': return [`end:${event.data.stopReason}`]
      case 'deliverables/presented': return event.data.files.map(file => `delivered:${basename(file.path)}`)
      default: return []
    }
  })
}

async function persisted(ctx: Context, agent: Agent) {
  await ctx.sessionPersistence.flush()
  const handle = await ctx.sessionPersistence.open(agent.id, 'read')
  try { return (await handle.read()).events } finally { await handle.close() }
}

it('loads the opt-in skill, runs two real workflow children and delivers the file with replayable execution records', async () => {
  const script: Script = []
  const { ctx, cwd, agent, adapter, skill, workflowScript } = await fixture(script)
  expect(skill).toMatchObject({ name: 'office-minutes', provider: 'dsh-office-automation', source: 'bundled',
    invocation: { modelInvocable: true, userInvocable: true } })
  script.push(
    toolCallResponse('minutes-read', 'read', { file_path: 'meeting.txt' }), workflow(workflowScript),
    textResponse(draft), textResponse(minutes),
    toolCallResponse('minutes-write', 'write', { file_path: 'meeting-minutes.md', content: minutes }),
    toolCallResponse('minutes-verify', 'read', { file_path: 'meeting-minutes.md' }),
    toolCallResponse('minutes-present', 'present', { files: [{ path: 'meeting-minutes.md', description: 'Reviewed meeting minutes' }] }),
    textResponse('Reviewed meeting minutes saved to meeting-minutes.md. Budget and participants remain unresolved.'),
  )
  await send(ctx, agent)
  expect(await readFile(join(cwd, 'meeting-minutes.md'), 'utf8')).toBe(minutes)
  expect(await readFile(join(cwd, 'meeting.txt'), 'utf8')).toBe(material)
  expect(adapter.requests).toHaveLength(8)
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Meeting minutes')
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain(material)
  expect(JSON.stringify(adapter.requests[2]?.messages)).toContain(material)
  expect(adapter.requests[3]?.messages.some(message => message.content.some(block =>
    block.type === 'text' && block.text.includes(JSON.stringify({ material, draft }))))).toBe(true)
  const events = await persisted(ctx, agent)
  expect(record(events)).toMatchInlineSnapshot(`
    [
      "start:office-minutes",
      "member:Extract:Extract meeting facts",
      "member-end:completed",
      "member:Review:Review meeting minutes",
      "member-end:completed",
      "end:completed",
      "delivered:meeting-minutes.md",
    ]
  `)
  const children = events.filter(event => event.type === 'tool-workflow/agent-start')
  expect(children).toHaveLength(2)
  for (const event of children) {
    expect(ctx.agents.get(event.data.childId)).toBeUndefined()
    const child = await ctx.sessionPersistence.open(event.data.childId, 'read')
    try { expect((await child.read()).events.some(entry => entry.type === 'assistant/message')).toBe(true) }
    finally { await child.close() }
  }
  expect(ctx.agents.list()).toHaveLength(1)
})

it('retains workflow failure and publishes no file or delivery when extraction produces no usable draft', async () => {
  const script: Script = []
  const { ctx, cwd, agent, workflowScript } = await fixture(script)
  script.push(toolCallResponse('minutes-read', 'read', { file_path: 'meeting.txt' }), workflow(workflowScript),
    textResponse(''), textResponse('Meeting extraction failed. No completed minutes were delivered.'))
  await send(ctx, agent)
  const events = await persisted(ctx, agent)
  expect(record(events)).toMatchInlineSnapshot(`
    [
      "start:office-minutes",
      "member:Extract:Extract meeting facts",
      "member-end:completed",
      "end:error",
    ]
  `)
  expect(JSON.stringify(events)).toContain('Meeting extraction did not produce a usable draft.')
  expect(await readdir(cwd)).toEqual(['meeting.txt'])
})

it('cancels the actual running workflow child, awaits cleanup and keeps the cancelled attempt in persisted history', async () => {
  const script: Script = []
  const { ctx, cwd, agent, workflowScript } = await fixture(script)
  script.push(toolCallResponse('minutes-read', 'read', { file_path: 'meeting.txt' }), workflow(workflowScript), 'hang')
  const childStarted = new Promise<void>((resolve) => {
    ctx.on('workflow/agent-start', () => { resolve() })
  })
  const idle = send(ctx, agent)
  await childStarted
  agent.cancel({ kind: 'user' })
  await idle
  const events = await persisted(ctx, agent)
  expect(record(events)).toMatchInlineSnapshot(`
    [
      "start:office-minutes",
      "member:Extract:Extract meeting facts",
      "member-end:cancelled",
      "end:cancelled",
    ]
  `)
  expect(await readdir(cwd)).toEqual(['meeting.txt'])
  expect(ctx.agents.list()).toHaveLength(1)
})

it('preserves native write denials after successful review without claiming that a file was delivered', async () => {
  const script: Script = []
  const { ctx, cwd, agent, workflowScript } = await fixture(script)
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'write'
    ? { kind: 'deny', reason: 'Writing minutes requires the existing approval.' } : next())
  script.push(toolCallResponse('minutes-read', 'read', { file_path: 'meeting.txt' }), workflow(workflowScript),
    textResponse(draft), textResponse(minutes),
    toolCallResponse('minutes-write', 'write', { file_path: 'meeting-minutes.md', content: minutes }),
    textResponse('Review completed, but writing was denied. No file was delivered.'))
  await send(ctx, agent)
  const events = await persisted(ctx, agent)
  expect(record(events).at(-1)).toBe('end:completed')
  expect(events.some(event => event.type === 'deliverables/presented')).toBe(false)
  expect(JSON.stringify(events)).toContain('Writing minutes requires the existing approval.')
  expect(await readdir(cwd)).toEqual(['meeting.txt'])
})
