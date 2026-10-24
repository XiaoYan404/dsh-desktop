/** Bounded HTTP JSON probing; redirects and remote response content never reach an office view. */
import type { OfficeConnectorActionDeclaration, OfficeConnectorExecutionId, OfficeConnectorExecutionReceipt,
  OfficeConnectorProbeStatus, OfficeConnectorReadData, OfficeMember } from './types.ts'

/** One admitted business effect; the server execution identity is the customer's stable idempotency key. */
export interface OfficeConnectorWriteRequest extends OfficeConnectorReadRequest {
  readonly executionId: OfficeConnectorExecutionId
  readonly values: Readonly<Record<string, string>>
  readonly maxResultBytes: number
}

/** Read an existing customer operation by its original server idempotency key, without resending its business values. */
export interface OfficeConnectorReconcileRequest extends OfficeConnectorReadRequest {
  readonly executionId: OfficeConnectorExecutionId
  readonly maxResultBytes: number
}

/** Only authoritative acceptance/nonacceptance can settle a write; network uncertainty is never rejection. */
export type OfficeConnectorWriteResult =
  | { readonly status: 'succeeded'; readonly result: OfficeConnectorReadData }
  | { readonly status: 'rejected'; readonly rejection: NonNullable<OfficeConnectorExecutionReceipt['rejection']> }
  | { readonly status: 'unknown' }

/** One authorized read with server-owned employee identity and freshly resolved private connection headers. */
export interface OfficeConnectorReadRequest {
  readonly actionId: string
  readonly member: Pick<OfficeMember, 'id' | 'role'>
  readonly baseUrl: string
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly maxResponseBytes: number
  readonly maxEntries: number
}

/** Trusted adapters return sanitized fields only; authentication failures and remote diagnostics contain no data. */
export type OfficeConnectorReadResult =
  | { readonly status: 'read'; readonly data: OfficeConnectorReadData }
  | { readonly status: Extract<OfficeConnectorProbeStatus,
    'unauthorized' | 'rate_limited' | 'timed_out' | 'unreachable' | 'invalid_response' | 'http_error'> }

/** Host-only adapter input. Credentials are resolved afresh for one operation and must not be retained. */
export interface OfficeConnectorProbeRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly maxResponseBytes: number
}

/** An adapter reports network outcomes without returning remote content, error text or credentials. */
export interface OfficeConnectorProbeResult {
  readonly status: Extract<OfficeConnectorProbeStatus,
    'connected' | 'unauthorized' | 'rate_limited' | 'timed_out' | 'unreachable' | 'invalid_response' | 'http_error'>
  readonly httpStatus?: number
}

/** Trusted Host extension; probe must stop all work before settling after signal abort. */
export interface OfficeConnectorAdapter {
  readonly id: string
  /** Optional public action declarations; metadata never grants execution authority or supplies credentials. */
  readonly actions?: readonly OfficeConnectorActionDeclaration[]
  /** Optional exact write-action ids supporting reconcile; omitted preserves lookup support for every declared write. */
  readonly reconcileActions?: readonly string[]
  /**
   * Query one declared read action without business writes, redirects or caller-selected employee identities.
   * @param request - Current approved base URL, authenticated employee, private headers and finite read bounds.
   * @returns Sanitized business fields or a network outcome; stop all work before settling after abort.
   */
  read?(request: OfficeConnectorReadRequest): Promise<OfficeConnectorReadResult>
  /**
   * Submit one declared business operation using executionId as the external idempotency key.
   * @param request - Validated exact fields, server employee identity, private credentials and cooperative lifetime.
   * @returns Authoritative sanitized outcome or unknown; stop all work before settling after abort. Never retry internally.
   */
  write?(request: OfficeConnectorWriteRequest): Promise<OfficeConnectorWriteResult>
  /**
   * Read an existing operation's authoritative outcome without performing or replaying a business write.
   * @param request - Original execution id, current employee/private connection and finite cooperative read bounds.
   * @returns Authoritative success/nonacceptance or unknown; absence, timeout and ambiguous matches must remain unknown.
   */
  reconcile?(request: OfficeConnectorReconcileRequest): Promise<OfficeConnectorWriteResult>
  /**
   * Check one administrator-approved location without following redirects or performing business writes.
   * @param request - Current URL, private headers, complete-response bound and operation lifetime.
   * @returns Sanitized network outcome; unexpected defects reject to the service's reporting owner.
   */
  probe(request: OfficeConnectorProbeRequest): Promise<OfficeConnectorProbeResult>
}

/** Built-in adapter admits only a complete, bounded JSON response from a successful GET. */
export const httpJsonConnector: OfficeConnectorAdapter = {
  id: 'http-json',
  async probe(request) {
    let response: Response | undefined
    try {
      response = await fetch(request.url, {
        method: 'GET', headers: { ...request.headers, accept: 'application/json' },
        signal: request.signal, redirect: 'manual', credentials: 'omit',
      })
      const httpStatus = response.status
      if (httpStatus === 401 || httpStatus === 403) return { status: 'unauthorized', httpStatus }
      if (httpStatus === 429) return { status: 'rate_limited', httpStatus }
      if (!response.ok) return { status: 'http_error', httpStatus }
      if (!response.body) return { status: 'invalid_response', httpStatus }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          length += next.value.byteLength
          if (length > request.maxResponseBytes) return { status: 'invalid_response', httpStatus }
          chunks.push(next.value)
        }
      } finally {
        await reader.cancel().catch((error: unknown) => {
          // Fetch abort can close the stream before cancellation reaches its reader.
          if (!request.signal.aborted) throw error
        })
        reader.releaseLock()
      }
      try {
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) return { status: 'invalid_response', httpStatus }
        throw error
      }
      return { status: 'connected', httpStatus }
    } catch (error) {
      if (request.signal.aborted) return { status: 'timed_out' }
      if (error instanceof TypeError) return { status: 'unreachable' }
      throw error
    } finally {
      if (response?.body && !response.body.locked) {
        await response.body.cancel().catch((error: unknown) => {
          // A failed or already consumed response has no remaining bytes to release.
          if (!response?.bodyUsed && !request.signal.aborted) throw error
        })
      }
    }
  },
}
