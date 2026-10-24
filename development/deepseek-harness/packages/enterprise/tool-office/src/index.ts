/** Native office operations are scoped to submitted conversation associations and executed by the authenticated office BFF. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-client-ui-office'
import type {} from '@deepseek-ai/dsh-client-ui-office/types'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { OfficeConversationCapture, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeApproval, reviewOfficeWork, workParameters } from './work-approval.ts'
import { officeBffRequest, officeRequestId, officeToolDriver } from './driver.ts'
import { officeQueryTools, READ_ACTION_TOOL, reviewOfficeRead } from './query-tools.ts'
import { officeWriteTool, reviewOfficeWrite, WRITE_ACTION_TOOL } from './write-tool.ts'
import { installOfficeFileTool } from './file-tool.ts'
import { installOfficeRunOwnership } from './native-ownership.ts'
import { officeAutomationTool, reviewOfficeAutomation, AUTOMATION_EXECUTE_TOOL } from './automation-tool.ts'
import * as OfficeAutomationSkills from './automation-skills.ts'

/** Optional native office-tool plugin; default Web/CLI compositions do not load it. */
export const name = 'tool-office'
/** Native execution and the authenticated employee BFF remain separate owners. */
export const inject = ['officeController', 'agents', 'tools', 'sessionProjections']

/** Independent office-write/read confirmation; automatic preserves the other native denials and approval gates. */
export interface Config {
  /** Add native manual confirmation for office writes, or preserve only the other configured policy gates. */
  readonly approval?: 'manual' | 'automatic'
  /** Add native confirmation for company queries and submitted file reads; defaults to manual and retains other policy gates. */
  readonly readApproval?: 'manual' | 'automatic'
  /** Independently confirm customer-system business writes; defaults to manual even if internal work is automatic. */
  readonly writeApproval?: 'manual' | 'automatic'
  /** Offer exact own-run automation execution only when the authority server is explicitly configured too. */
  readonly automations?: boolean
  /** Offer the presentation reader to submitted-file turns; defaults to false and still requires authority-side PPTX config. */
  readonly pptx?: boolean
  /** Offer submitted raster reads only with explicit hard normalized-byte limits and current authority capability. */
  readonly image?: boolean
  /** Offer current-authority knowledge reads on submitted file turns; disabled by default. */
  readonly knowledge?: boolean
  /** Enable read-only real Office-output checks for submitted file turns; default false. */
  readonly deliveries?: boolean
  /** Positive safe integer maximum normalized image bytes; required when image is true. */
  readonly imageMaxNormalizedResultBytes?: number
}
/** Default office writes and business reads require the existing native approval channel. */
export const Config: Schema<Config> = Schema.object({
  approval: Schema.union(['manual', 'automatic']).default('manual'),
  readApproval: Schema.union(['manual', 'automatic']).default('manual'),
  writeApproval: Schema.union(['manual', 'automatic']).default('manual'),
  automations: Schema.boolean().default(false),
  pptx: Schema.boolean().default(false),
  image: Schema.boolean().default(false),
  knowledge: Schema.boolean().default(false),
  deliveries: Schema.boolean().default(false),
  imageMaxNormalizedResultBytes: Schema.natural().min(1).max(Number.MAX_SAFE_INTEGER),
})

const WORK_TOOL = 'office_create_work'
const OUTPUT = {
  type: 'object', additionalProperties: false,
  properties: {
    request_id: { type: 'string', required: true },
    capture_id: { type: 'string', required: true },
    item_id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    title: { type: 'string', required: true },
    date: { type: 'string', required: true },
    owner_id: { type: 'string', required: true },
    creator_id: { type: 'string', required: true },
    status: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
  },
} as const

interface Binding {
  readonly turn: number
  readonly capture: OfficeConversationCapture
  readonly dispose: () => void
  readonly names: ReadonlySet<string>
}

/**
 * Contribute work and company-read tools only to the exact live conversation carrying their submitted office associations.
 * @param ctx - Native plugin scope with the employee BFF and original Agent/tool services.
 * @param config - Additional office approval policy; other gates remain authoritative.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(OfficeAutomationSkills)
  const lifetime = new AbortController()
  installOfficeRunOwnership(ctx, lifetime.signal)
  installOfficeFileTool(ctx, lifetime.signal, config.readApproval, config.pptx,
    config.image ? { maxNormalizedResultBytes: config.imageMaxNormalizedResultBytes ?? NaN } : undefined, config.knowledge, config.deliveries)
  const bindings = new Map<Agent, Binding>()
  const drop = (agent: Agent) => {
    bindings.get(agent)?.dispose()
    bindings.delete(agent)
  }
  ctx.effect(() => () => {
    lifetime.abort()
    for (const agent of bindings.keys()) drop(agent)
  }, 'office-tools.close')
  ctx.on('agent/disposed', ({ agent }) => { drop(agent) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const agent = ctx.agents.get(session.id)
    if (agent && bindings.get(agent)?.turn === event.data.turn) drop(agent)
  })
  // Inbox claims precede prompt assembly; pre-step runs after its tool schemas have already been collected.
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (message.source.kind !== 'user') return
    const capture = capturedOffice(message)
    if (!capture || capture.selection.conversationId !== String(agent.id)) {
      drop(agent)
      return
    }
    const previous = bindings.get(agent)
    if (previous?.turn === turn && previous.capture.id === capture.id) return
    drop(agent)
    if (lifetime.signal.aborted || ctx.agents.get(agent.id) !== agent) return
    const definitions = []
    if (capturedReminder(message)) definitions.push(workTool(ctx, capture, lifetime.signal))
    if (capture.integrations.some(row => row.status === 'unverified' && capture.selection.integrations.includes(row.id))) {
      const queries = officeQueryTools(ctx, capture, lifetime.signal)
      definitions.push(queries.list, queries.read, officeWriteTool(ctx, capture, lifetime.signal))
      if (config.automations) definitions.push(officeAutomationTool(ctx, capture, lifetime.signal, {
        async call(command) {
          const result = await ctx.officeController.automation(command)
          if (!result.ok) throw new HarnessError('Office automation is unavailable under current authority.', 'OFFICE_AUTOMATION_DENIED')
          return result.value
        },
      }))
    }
    const names = new Set<string>()
    const disposers: (() => void)[] = []
    for (const definition of definitions) {
      if (ctx.tools.get(definition.name, agent)) {
        ctx.logger.warn(`Office tool ${definition.name} was not installed because its name is already registered`)
        continue
      }
      disposers.push(agent.ctx.tools.register(definition))
      names.add(definition.name)
    }
    if (names.size) bindings.set(agent, { turn, capture, names, dispose: () => { for (const dispose of disposers.reverse()) dispose() } })
  })
  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || lifetime.signal.aborted || bindings.get(agent)?.turn !== turn) drop(agent)
    return decision
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if ((decision.kind !== 'allow' && decision.kind !== 'ask') || !exec.agent) return decision
    const binding = bindings.get(exec.agent)
    if (!binding?.names.has(exec.name) || ![WORK_TOOL, READ_ACTION_TOOL, WRITE_ACTION_TOOL, AUTOMATION_EXECUTE_TOOL].includes(exec.name)) return decision
    const approval = exec.name === WORK_TOOL ? config.approval
      : exec.name === READ_ACTION_TOOL ? config.readApproval : config.writeApproval
    if (decision.kind === 'allow' && approval === 'automatic') return decision
    const review = exec.name === WORK_TOOL ? reviewOfficeWork(exec.arguments, binding.capture.memberId)
      : exec.name === READ_ACTION_TOOL ? reviewOfficeRead(exec.arguments, binding.capture)
        : exec.name === AUTOMATION_EXECUTE_TOOL ? reviewOfficeAutomation(exec.arguments, binding.capture)
          : reviewOfficeWrite(exec.arguments, binding.capture)
    if (!review) return { kind: 'deny', reason: 'Invalid office operation arguments; correct the requested fields.',
      info: { name: 'ToolArgsError', code: 'INVALID_ARGS' } }
    return officeApproval(decision.kind === 'ask' ? decision : undefined, review)
  })
}

function capturedOffice(message: UserMessage): OfficeConversationCapture | undefined {
  const source = message.source
  if (source.kind !== 'user' || !('preparedContexts' in source)) return undefined
  const prepared = source.preparedContexts.findLast(context => context.source.kind === 'office')
  if (prepared?.source.kind !== 'office') return undefined
  return prepared.source.capture
}

function capturedReminder(message: UserMessage): OfficeConversationCapture | undefined {
  const capture = capturedOffice(message)
  if (!capture) return undefined
  if (!capture.selection.tools.some(tool => tool.kind === 'template' && tool.name === 'reminder')) return undefined
  const required = capture.requirements.find(row => row.tool.kind === 'template' && row.tool.name === 'reminder')
  if (required?.missing.length) return undefined
  if (required?.integrations.some(id => !capture.selection.integrations.includes(id) ||
    capture.integrations.find(row => row.id === id)?.status !== 'unverified')) return undefined
  return capture
}

function workTool(ctx: Context, capture: OfficeConversationCapture, lifetime: AbortSignal) {
  return defineTool({
    name: 'office_create_work',
    description: 'Create one internal company task or to-do under the explicitly submitted reminder context. '
      + 'Use only when the employee requests work creation. This does not send an external DingTalk/WeCom message or schedule an Agent prompt. '
      + 'The office server rechecks current employee, associations, dependencies and permissions. Omit owner_id to assign to the submitting employee.',
    parameters: workParameters,
    output: { schema: OUTPUT, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const agent = officeToolDriver(ctx, exec, capture, lifetime)
      const requestId = officeRequestId(capture.id, agent.id, exec.callId)
      const result = await officeBffRequest(() => ctx.officeController.createWorkFromConversation({ captureId: capture.id, requestId,
        work: { kind: args.kind, title: args.title, date: args.date,
          ownerId: args.owner_id === undefined ? capture.memberId : args.owner_id as OfficeMemberId,
          ...args.time === undefined ? {} : { time: args.time },
          ...args.description === undefined ? {} : { description: args.description } } }))
      lifetime.throwIfAborted()
      exec.signal.throwIfAborted()
      if (!result.ok) throw new HarnessError(`Office work was not accepted (${result.code}).`, 'OFFICE_WORK_DENIED')
      const item = result.value.item
      return { request_id: result.value.requestId, capture_id: result.value.captureId, item_id: item.id,
        kind: item.kind, title: item.title, date: item.date, owner_id: item.ownerId, creator_id: item.creatorId,
        status: item.status, revision: item.revision }
    },
    presentCall: args => ({ card: 'generic', title: args.kind === 'task' ? 'Create office task' : 'Create office to-do',
      kind: 'other', rawInput: args }),
  })
}
