/** Office tools require the exact live calling Agent; a captured id never grants native execution authority. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { OfficeConversationCapture, OfficeConversationFilesCapture } from '@deepseek-ai/dsh-enterprise-office/types'

/**
 * Derive an employee operation retry UUID from the exact claimed capture, Agent and immutable native call identity.
 * @param captureId - Server-owned submitted context identity.
 * @param agentId - Exact calling logical conversation identity.
 * @param callId - Registry-owned native tool-call identity; repeating this call retains the same retry UUID.
 * @returns Deterministic UUID without placing private business values in its identity.
 */
export function officeRequestId(captureId: string, agentId: string, callId: string): string {
  const hash = createHash('sha256').update(JSON.stringify([captureId, agentId, callId])).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/**
 * Verify the exact live native driver and cancellation state before an office BFF operation.
 * @param ctx - Native office-tool plugin scope.
 * @param exec - Registry-materialized calling execution, never caller-supplied Agent metadata.
 * @param capture - Private submitted context bound to this tool's Agent registration.
 * @param lifetime - Owning office-tool plugin lifetime.
 * @returns The exact current calling Agent; detached, stopped and cross-conversation calls reject.
 */
export function officeToolDriver(ctx: Context, exec: ToolExecution,
  capture: OfficeConversationCapture | OfficeConversationFilesCapture, lifetime: AbortSignal): Agent {
  const agent = exec.agent
  if (!agent || ctx.agents.get(agent.id) !== agent || agent.status !== 'running' || ctx.agents.currentInitiator() !== agent ||
    String(agent.id) !== capture.selection.conversationId)
    throw new HarnessError('Office tools require their exact live calling conversation.', 'OFFICE_TOOL_DRIVER_REQUIRED')
  lifetime.throwIfAborted()
  exec.signal.throwIfAborted()
  return agent
}

/**
 * Contain unexpected office infrastructure diagnostics before native tool results enter a model request or transcript.
 * @param operation - One authenticated BFF request; structured business denials remain ordinary returned values.
 * @returns The original result, or a stable failure retaining its private cause without exposing its diagnostic text.
 */
export async function officeBffRequest<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (cause) {
    throw new HarnessError('Office service is unavailable. Inspect office-server diagnostics and check the original operation outcome '
      + 'before retrying.', 'OFFICE_SERVICE_UNAVAILABLE', { cause })
  }
}
