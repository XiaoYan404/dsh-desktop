/** Isolated real Loader/AgentLoop/Node-workflow composition; only model responses are controlled. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { onTestFinished } from 'vitest'
import { MockAdapter, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import * as AutomationSkills from '../../src/automation-skills.ts'

/** Source-side fixture script for the external language model. */
export type AutomationModelScript = ConstructorParameters<typeof MockAdapter>[0]

/**
 * Boot the native execution stack from a real cordis.yml using Loader builtins.
 * @param script - Responses consumed by the root and its real workflow children in call order.
 * @returns Context, Agent, private workspace and observed model calls; teardown drains all owned resources.
 */
export async function createAutomationFixture(script: AutomationModelScript) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-auto-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-auto-')) {
      throw new Error('Unexpected office automation fixture directory')
    }
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const plugins = {
    llm: LlmRuntime, session: SessionStore, projections: SessionProjections, prompt: SystemPrompt,
    fs: FsLocal, directory: WorkingDirectory, tools: ToolRuntime, agents: AgentRegistry, loop: AgentLoop,
    persistence: JsonlPersistence, skills: SkillRegistry, automation: AutomationSkills, toolSkill: ToolSkill,
    subprocess: SubprocessLocal, sandbox: SandboxLocal, policy: SandboxPolicy, ptc: NodePtcRuntime,
    subagents: SubagentRuntime, spawn: SpawnInProcess, workflow: PtcWorkflowEngine,
    toolWorkflow: ToolWorkflow, toolFs: ToolFs, present: ToolPresent,
  }
  const config: Record<string, object> = {
    loop: { agents: [] }, persistence: { root: join(root, 'sessions') },
    policy: { mode: 'danger-full-access', workspaceRoot: cwd }, ptc: { graceMs: 50 },
    spawn: { providerName: 'spawn' }, workflow: { maxConcurrentAgents: 1, maxTotalAgents: 2 },
    toolWorkflow: { enableRunInBackground: false },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(Object.keys(plugins).map(key => ({ name: `cordis:${key}`, config: config[key] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, ...plugins })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  if (!ctx.get('workflowEngine') || !ctx.get('skills') || !ctx.tools.get('present')) {
    throw new Error('Office automation composition did not activate')
  }
  const adapter = new MockAdapter(script)
  ctx.effect(() => ctx.llm.registerAdapter(['office-automation-fixture'], adapter))
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'office-automation-fixture', model: 'fixture' }, { cwd })
  return { ctx, cwd, agent, adapter }
}

/**
 * Load a skill's actual shipped workflow body and produce a fixture model tool call.
 * @param ctx - Running native skill registry.
 * @param skillName - Explicit automation selected by the user.
 * @param args - Actual source data passed as JSON rather than source-code interpolation.
 * @param phases - Progress labels belonging to this shipped workflow.
 * @returns Scripted model chunks invoking the real native workflow tool.
 */
export async function automationWorkflow(ctx: Context, skillName: string, args: object, phases: readonly string[]) {
  const skill = await ctx.skills.get(skillName)
  const script = skill && /```javascript\r?\n([\s\S]*?)\r?\n```/u.exec(skill.content)?.[1]
  if (!script) throw new Error(`Automation ${skillName} has no shipped workflow script`)
  return toolCallResponse('automation-workflow', 'workflow', {
    script, meta: { name: skillName, description: 'Execute the requested office automation',
      phases: phases.map(title => ({ title })) }, args,
  })
}

/**
 * Send one explicit automation request to an otherwise idle fixture Agent.
 * @param ctx - Native lifecycle owner.
 * @param agent - Sole fixture root Agent.
 * @param text - User-explicit skill invocation and requirements.
 * @returns The next whole-Agent idle interval; no concurrent input is submitted by this fixture.
 */
export function runAutomationTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { stop(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  return idle
}

/**
 * Read the actual flushed JSONL event log through an independent read handle.
 * @param ctx - Native persistence owner.
 * @param agent - Root execution being inspected.
 * @returns Committed events without retaining a read handle.
 */
export async function automationEvents(ctx: Context, agent: Agent) {
  await ctx.sessionPersistence.flush()
  const reader = await ctx.sessionPersistence.open(agent.id, 'read')
  try { return (await reader.read()).events } finally { await reader.close() }
}

/**
 * Project stable execution and delivery facts from actual recorded native events.
 * @param events - Committed execution log.
 * @returns Snapshot rows excluding only generated identities and absolute temporary paths.
 */
export function automationRecord(events: readonly SessionEvent[]): string[] {
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
