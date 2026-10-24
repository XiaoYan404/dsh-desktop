/** Native automation execution reuses the Office write review and exact submitted association capture. */
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, validateArgs } from '@deepseek-ai/dsh-tools'
import type { InferArgs, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OfficeConversationCapture } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeAutomationCommandInput, OfficeAutomationResponse } from '@deepseek-ai/dsh-enterprise-office'
import { officeBffRequest, officeToolDriver } from './driver.ts'
import { selectedSystem } from './query-tools.ts'
import { reviewOfficeWrite, writeParameters } from './write-tool.ts'
import type { OfficeWorkReview } from './work-approval.ts'

/** Agent-local tool identity; installed only by the opt-in Office automation composition. */
export const AUTOMATION_EXECUTE_TOOL = 'office_automation_execute'
const parameters = { ...writeParameters,
  run_id: { type: 'string', required: true, description: 'Own pending automation run UUID from the explicit automation review.' },
  run_revision: { type: 'integer', required: true, description: 'Exact run revision shown in the human review.' },
  part: { type: 'string', required: true, enum: ['primary', 'compensation'], description: 'Explicitly reviewed execution phase.' },
} as const
/** Existing authenticated BFF call, supplied after the common request and Remote aggregation are integrated. */
export interface OfficeAutomationToolPort {
  /** Call the existing employee-authenticated Office endpoint; never accept an actor from model arguments. */
  call(command: OfficeAutomationCommandInput): Promise<OfficeAutomationResponse>
}
function parsed(input: unknown): InferArgs<typeof parameters> | undefined {
  if (validateArgs(parameters, input).length) return
  const value = input as InferArgs<typeof parameters>
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.run_id) ||
    !Number.isSafeInteger(value.run_revision) || value.run_revision < 1) return
  return value
}

/**
 * Describe every reviewed field and the exact run/phase before native approval.
 * @param input - Closed native arguments; execution checks them against the retained immutable run again.
 * @param capture - Original user submission's own selected systems.
 * @returns Complete bilingual review, or absence for malformed arguments or unavailable selected systems.
 */
export function reviewOfficeAutomation(input: unknown, capture: OfficeConversationCapture): OfficeWorkReview | undefined {
  const args = parsed(input)
  if (!args) return
  const { run_id: _id, run_revision: _revision, part: _part, ...write } = args
  const review = reviewOfficeWrite(write, capture)
  if (!review) return
  return { en: `${review.en}\nAutomation run: ${args.run_id}\nRun revision: ${args.run_revision}\nPhase: ${args.part}`,
    zh: `${review.zh}\n自动化运行：${args.run_id}\n运行版本：${args.run_revision}\n阶段：${args.part}` }
}

/**
 * Build a native tool whose approval is enforced by the existing tools/pre-execute Office write policy.
 * @param ctx - Native scope owning the current initiator and existing Office controller.
 * @param capture - Exact human submission and selected company systems.
 * @param lifetime - Owning plugin lifetime; a late result cannot publish after unload or identity replacement.
 * @param port - Authenticated Office automation route; no raw transport, credential or role override.
 * @returns Definition to register under the same Agent scope and native manual-write review as office_write_action.
 */
export function officeAutomationTool(ctx: Context, capture: OfficeConversationCapture, lifetime: AbortSignal,
  port: OfficeAutomationToolPort): ToolDefinition {
  return defineTool({ name: AUTOMATION_EXECUTE_TOOL, parameters,
    description: 'Execute one own pending automation only when the user explicitly requests its exact run review. '
      + 'Include the reviewed system, action, fields, versions, run id and phase. Compensation needs separate approval. '
      + 'Unknown results require original-execution recovery; never create a replacement run or resubmit.',
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      run_id: { type: 'string', required: true }, revision: { type: 'integer', required: true },
      phase: { type: 'string', required: true }, status: { type: 'string', required: true },
      execution_id: { type: 'string', required: true }, request_id: { type: 'string', required: true },
      rejection: { type: 'string', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(input, exec) {
      officeToolDriver(ctx, exec, capture, lifetime)
      const args = parsed(input)
      if (!args || !reviewOfficeAutomation(input, capture)) throw new HarnessError('Review the exact automation fields.', 'INVALID_ARGS')
      const system = selectedSystem(capture, args.system)
      const review = await officeBffRequest(() => port.call({ kind: 'review', id: args.run_id, part: args.part }))
      officeToolDriver(ctx, exec, capture, lifetime)
      if (review.kind !== 'review' || review.review.revision !== args.run_revision ||
        review.review.action.integrationId !== system.id || review.review.action.actionId !== args.action_id ||
        review.review.action.connectionRevision !== args.connection_revision ||
        review.review.action.adapterRevision !== args.adapter_revision ||
        JSON.stringify(Object.entries(review.review.action.values).sort()) !==
          JSON.stringify(args.values.map(value => [value.name, value.value]).sort()))
        throw new HarnessError('Automation run changed; obtain a new exact review.', 'OFFICE_AUTOMATION_CHANGED')
      const response = await officeBffRequest(() => port.call({ kind: 'execute', id: args.run_id, part: args.part,
        revision: args.run_revision, captureId: capture.id }))
      officeToolDriver(ctx, exec, capture, lifetime)
      if (response.kind !== 'run') throw new HarnessError('Automation result is unavailable.', 'OFFICE_AUTOMATION_UNKNOWN')
      const phase = args.part === 'primary' ? response.run.primary : response.run.compensation
      return { run_id: response.run.id, revision: response.run.revision,
        phase: args.part, status: phase?.stage ?? 'unknown', execution_id: phase?.executionId ?? '',
        request_id: phase?.requestId ?? '', rejection: phase?.rejection ?? '' }
    },
    presentCall: args => ({ card: 'generic', title: 'Review office automation operation', kind: 'other', rawInput: args }),
  })
}
