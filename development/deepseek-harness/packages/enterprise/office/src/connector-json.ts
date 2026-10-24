/** Shared bounded JSON transport for trusted adapters; credentials and remote diagnostics stay with the caller. */
import type { OfficeConnectorProbeRequest, OfficeConnectorReadResult } from './connector-http.ts'

type Failure = Exclude<OfficeConnectorReadResult, { readonly status: 'read' }>
/** Cooperative lifetime and complete-response byte bound supplied by the office owner. */
export type ConnectorRequestLifetime = Pick<OfficeConnectorProbeRequest, 'signal' | 'maxResponseBytes'>
/** Only a complete parsed JSON body crosses this private transport boundary. */
export type ConnectorJsonResult = { readonly ok: true; readonly value: unknown; readonly httpStatus: number }
  | { readonly ok: false; readonly failure: Failure; readonly httpStatus?: number }

/**
 * Request one approved adapter URL without following redirects or retrying.
 * @param url - Deployment-approved URL assembled by the trusted adapter.
 * @param lifetime - Current operation signal and finite response bound.
 * @param method - Explicit read or business request method.
 * @param headers - Operation-scoped private headers; never returned or retained.
 * @param body - Optional fixed-shape JSON body.
 * @returns Complete JSON or a sanitized transport failure, after response readers have stopped.
 */
export async function readConnectorJson(url: URL, lifetime: ConnectorRequestLifetime, method: 'GET' | 'POST',
  headers: Record<string, string>, body?: object): Promise<ConnectorJsonResult> {
  let response: Response
  try {
    response = await fetch(url, { method, headers: { accept: 'application/json', ...headers },
      ...body === undefined ? {} : { body: JSON.stringify(body) }, signal: lifetime.signal,
      redirect: 'manual', credentials: 'omit' })
  } catch (error) {
    if (lifetime.signal.aborted) return { ok: false, failure: { status: 'timed_out' } }
    if (error instanceof TypeError) return { ok: false, failure: { status: 'unreachable' } }
    throw error
  }
  const httpStatus = response.status
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (!response.ok) return { ok: false, httpStatus, failure: { status: httpStatus === 401 || httpStatus === 403
      ? 'unauthorized' : httpStatus === 429 ? 'rate_limited' : 'http_error' } }
    if (!response.body) return { ok: false, httpStatus, failure: { status: 'invalid_response' } }
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > lifetime.maxResponseBytes) return { ok: false, httpStatus, failure: { status: 'invalid_response' } }
      chunks.push(next.value)
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError)
        return { ok: false, httpStatus, failure: { status: 'invalid_response' } }
      throw error
    }
    return { ok: true, value, httpStatus }
  } catch (error) {
    if (lifetime.signal.aborted) return { ok: false, failure: { status: 'timed_out' } }
    if (error instanceof TypeError) return { ok: false, failure: { status: 'unreachable' } }
    throw error
  } finally {
    try {
      if (reader) await reader.cancel()
      else if (response.body) await response.body.cancel()
    } catch (error) {
      // Fetch abort may already have closed the response stream.
      if (!lifetime.signal.aborted) throw error
    } finally { reader?.releaseLock() }
  }
}
