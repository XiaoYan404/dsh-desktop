/** Immutable Host preparation travels with native queued input and enters the model through logged user messages. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreparedPromptContext, SessionPromptRequest } from './types.ts'
import type {} from './index.ts'

/**
 * Install logged context consumption without changing an ordinary prompt's text, receipts or RPC identity.
 * @param ctx - Native API owner's effect scope.
 */
export function installPreparedPromptContexts(ctx: Context): void {
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const prepared = decision.messages.flatMap((message) => {
      const source = message.source
      if (source.kind !== 'user' || !('preparedContexts' in source) || !Object.hasOwn(source, 'preparedContexts')) return []
      return (source.preparedContexts ?? []).map(context => createUserMessage({
        content: [{ type: 'text', text: context.text }], source: context.source,
      }))
    })
    return prepared.length ? { ...decision, messages: [...prepared, ...decision.messages] } : decision
  })
}

/**
 * Await current Host providers before native message admission, fencing late success after controller unload.
 * @param ctx - Owning native API scope.
 * @param agent - Exact resolved native target.
 * @param request - Original request identity and delivery mode.
 * @param signal - Controller lifetime; provider effects retain their own cleanup and idempotency obligations.
 * @returns Captured text and producer metadata, or an abort/provider failure without native admission.
 */
export async function preparePromptContexts(
  ctx: Context, agent: Agent, request: SessionPromptRequest, signal: AbortSignal,
): Promise<readonly PreparedPromptContext[]> {
  signal.throwIfAborted()
  let rejectAborted: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
  const onAbort = () => { rejectAborted?.(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const prepared = await Promise.race([aborted, ctx.waterfall('api-session/prepare-context', {
      sessionId: agent.id, requestId: request.requestId, mode: request.mode, signal,
    }, () => Promise.resolve([]))])
    signal.throwIfAborted()
    return prepared
  } finally { signal.removeEventListener('abort', onAbort) }
}
