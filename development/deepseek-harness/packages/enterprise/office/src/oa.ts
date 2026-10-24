/** Product-owned OA bridge v1; customer bridges own their vendor mapping and durable idempotency. */
import { z } from 'zod'
import { officeMemberId } from './spec.ts'
import { connectorBusinessDataSchema, snapshotConnectorActions, validateConnectorWriteValues } from './connector-actions.ts'
import { readConnectorJson } from './connector-json.ts'
import type { OfficeConnectorAdapter, OfficeConnectorReadRequest, OfficeConnectorReadResult,
  OfficeConnectorWriteRequest, OfficeConnectorWriteResult, OfficeConnectorReconcileRequest } from './connector-http.ts'
import type { OfficeOaConfig } from './types.ts'

const actor = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
  .refine(value => value.trim().length > 0 && Buffer.from(value, 'utf8').toString('utf8') === value)
const configuration = z.object({ members: z.record(officeMemberId, actor), actions: z.array(z.unknown()) }).strict()
  .refine(value => Object.keys(value.members).length <= 10000 &&
    new Set(Object.values(value.members)).size === Object.keys(value.members).length)
const health = z.object({ protocol: z.literal(1) }).strict()
const reservedHeaders = new Set(['x-oa-actor', 'x-oa-action', 'idempotency-key'])

/**
 * Build an optional bridge provider without issuing requests or retaining credentials.
 * @param value - Explicit private member mappings and declared actions; this is not a vendor OA API specification.
 * @param limits - The office owner's deployment bounds for frozen public action declarations.
 * @returns Fixed-path, abort-aware bridge operations; uncertain submissions are only recovered by original-key reads.
 */
export function createOaAdapter(value: OfficeOaConfig,
  limits: { readonly actionMaxCount: number; readonly actionMaxBytes: number }): OfficeConnectorAdapter {
  const config = configuration.parse(value)
  const actions = snapshotConnectorActions(value.actions, { count: limits.actionMaxCount, bytes: limits.actionMaxBytes })
  const writes = actions.filter(action => action.kind === 'write')
  function mappedActor(request: OfficeConnectorReadRequest, kind: 'read' | 'write'): string | undefined {
    if (!actions.some(action => action.id === request.actionId && action.kind === kind &&
      action.allowedRoles.includes(request.member.role))) return
    return Object.hasOwn(config.members, request.member.id) ? config.members[request.member.id] : undefined
  }
  function privateHeaders(headers: Readonly<Record<string, string>>): boolean {
    return !Object.keys(headers).some(name => reservedHeaders.has(name.toLowerCase()))
  }
  function outcome(request: OfficeConnectorReconcileRequest, expectedActor: string, input: unknown): OfficeConnectorWriteResult {
    const parsed = z.object({ protocol: z.literal(1), actor, action: z.string(), executionId: z.uuid(),
      outcome: z.discriminatedUnion('status', [
        z.object({ status: z.literal('succeeded'), result: connectorBusinessDataSchema(request.maxEntries) }).strict(),
        z.object({ status: z.literal('rejected'), rejection: z.enum([
          'denied', 'not_accepted', 'unauthorized', 'rate_limited', 'invalid_input',
        ]) }).strict(),
        z.object({ status: z.literal('unknown') }).strict(),
      ]),
    }).strict().safeParse(input)
    if (!parsed.success || parsed.data.actor !== expectedActor || parsed.data.action !== request.actionId ||
      parsed.data.executionId !== request.executionId || request.signal.aborted) return { status: 'unknown' }
    return parsed.data.outcome
  }
  async function read(request: OfficeConnectorReadRequest): Promise<OfficeConnectorReadResult> {
    const employee = mappedActor(request, 'read')
    if (!employee || !privateHeaders(request.headers)) return { status: 'unauthorized' }
    const response = await readConnectorJson(new URL(`v1/actions/${encodeURIComponent(request.actionId)}/read`, request.baseUrl),
      request, 'GET', { ...request.headers, 'x-oa-actor': encodeURIComponent(employee) })
    if (!response.ok) return response.failure
    const parsed = z.object({ protocol: z.literal(1), actor, action: z.string(),
      data: connectorBusinessDataSchema(request.maxEntries) }).strict().safeParse(response.value)
    if (!parsed.success || parsed.data.actor !== employee || parsed.data.action !== request.actionId)
      return { status: 'invalid_response' }
    return request.signal.aborted ? { status: 'timed_out' } : { status: 'read', data: parsed.data.data }
  }
  async function write(request: OfficeConnectorWriteRequest): Promise<OfficeConnectorWriteResult> {
    const employee = mappedActor(request, 'write')
    if (!employee) return { status: 'rejected', rejection: 'denied' }
    if (!privateHeaders(request.headers)) return { status: 'rejected', rejection: 'unauthorized' }
    const action = writes.find(action => action.id === request.actionId)
    if (!action) return { status: 'rejected', rejection: 'denied' }
    validateConnectorWriteValues(action, request.values)
    const response = await readConnectorJson(new URL(`v1/actions/${encodeURIComponent(request.actionId)}/submit`, request.baseUrl),
      request, 'POST', { ...request.headers, 'content-type': 'application/json', 'x-oa-actor': encodeURIComponent(employee),
        'idempotency-key': request.executionId },
      { protocol: 1, actor: employee, action: request.actionId, executionId: request.executionId, values: request.values })
    return response.ok ? outcome(request, employee, response.value) : { status: 'unknown' }
  }
  async function reconcile(request: OfficeConnectorReconcileRequest): Promise<OfficeConnectorWriteResult> {
    const employee = mappedActor(request, 'write')
    if (!employee || !privateHeaders(request.headers)) return { status: 'unknown' }
    const response = await readConnectorJson(new URL(`v1/executions/${encodeURIComponent(request.executionId)}`, request.baseUrl),
      request, 'GET', { ...request.headers, 'x-oa-actor': encodeURIComponent(employee), 'x-oa-action': request.actionId })
    return response.ok ? outcome(request, employee, response.value) : { status: 'unknown' }
  }
  return { id: 'oa-bridge-v1', actions, reconcileActions: writes.map(action => action.id),
    ...actions.some(action => action.kind === 'read') ? { read } : {},
    ...writes.length ? { write, reconcile } : {},
    async probe(request) {
      if (!privateHeaders(request.headers)) return { status: 'unauthorized' }
      const url = new URL(request.url)
      if (!url.pathname.endsWith('/v1/health')) return { status: 'invalid_response' }
      const response = await readConnectorJson(url, request, 'GET', { ...request.headers })
      if (!response.ok) return { ...response.failure, ...response.httpStatus === undefined ? {} : { httpStatus: response.httpStatus } }
      return { status: health.safeParse(response.value).success && !request.signal.aborted ? 'connected' : 'invalid_response',
        httpStatus: response.httpStatus }
    },
  }
}
