/** The standard resource channel owns one retained native input; hooks carry its address, never a saved handle. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { OfficeConversationModel, OfficeOrdinaryInput } from './conversation-model.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'office/input-unavailable': Record<string, never>
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** One live home Conversation resource; released on resource or employee lifetime end. */
    officeHome: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Framework SessionProvider currency retained only by the resource occurrence. */
    officeinput: { readonly reference: SessionReference | undefined }
  }
  interface SlotMap {
    /** Native Conversation content embedded in the home card's retained ordinary Session. */
    'office.home.conversation': { kind: 'single'; scope: 'session' }
  }
}

/**
 * Address an ordinary input in this employee's current window lifetime.
 * @param input - Confirmed JSON identity.
 * @param attempt - Local resource retry, without changing the native Session.
 * @returns Resource address without prompt, file or authentication data.
 */
export function officeHomeInputAddress(input: OfficeOrdinaryInput, attempt = 0): string {
  return `dsh-resource://officeinput/session/${input.generation}/${encodeURIComponent(input.principal)}` +
    `/${encodeURIComponent(input.sessionId)}?attempt=${attempt}`
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted }

async function waitForReady(reference: SessionReference, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const stopped = Promise.withResolvers<never>()
  const abort = () => { stopped.reject(new DOMException('Office input preparation was cancelled', 'AbortError')) }
  signal.addEventListener('abort', abort, { once: true })
  try { await Promise.race([reference.ready, stopped.promise]) }
  finally { signal.removeEventListener('abort', abort) }
}

/**
 * Registerable native reference provider following the standard embedded-Conversation resource pattern.
 * @param sessions - Native reference owner.
 * @param conversations - Current employee's validated navigation owner.
 * @returns One scope-checked provider; unloading its resource releases only its own reference.
 */
export function officeHomeInputProvider(sessions: Pick<ISessions, 'retain'>,
  conversations: OfficeConversationModel): ResourceProvider<'officeinput'> {
  return {
    protocol: 'officeinput',
    async *open(address, context) {
      const scope = conversations.ordinaryScope()
      if (!scope) { yield { ok: true, value: { reference: undefined } }; return }
      const attempt = new URL(address).searchParams.get('attempt')
      if (attempt === null || !/^\d+$/u.test(attempt) || !Number.isSafeInteger(Number(attempt)) ||
        officeHomeInputAddress(scope, Number(attempt)) !== address) {
        yield { ok: false, error: new RemoteError('office/input-unavailable', 'Office input is unavailable', {}) }
        return
      }
      const signal = AbortSignal.any([context.signal, scope.signal])
      if (isAborted(signal)) return
      const reference = sessions.retain(scope.sessionId, { source: 'officeHome', signal })
      try {
        await waitForReady(reference, signal)
        if (isAborted(signal)) return
        const current = conversations.ordinaryScope()
        if (!current || current.sessionId !== scope.sessionId || current.generation !== scope.generation) {
          yield { ok: true, value: { reference: undefined } }
          return
        }
        yield { ok: true, value: { reference } }
        await waitForAbort(signal)
        if (!context.signal.aborted) yield { ok: true, value: { reference: undefined } }
      } catch {
        if (!isAborted(signal)) yield { ok: false, error: new RemoteError('office/input-unavailable', 'Office input is unavailable', {}) }
        else if (!context.signal.aborted) yield { ok: true, value: { reference: undefined } }
      } finally { reference.release() }
    },
  }
}
