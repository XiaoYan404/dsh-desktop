/** Product-owned OA v2 operations; neither vendor APIs nor v1 receipts are reinterpreted. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import Schema from '@deepseek-ai/schemastery'
import { officeMemberId } from './spec.ts'
import { OfficeError } from './error.ts'
import { snapshotConnectorActions, validateConnectorWriteValues } from './connector-actions.ts'
import { readConnectorJson } from './connector-json.ts'
import type { OfficeConnectorAdapter, OfficeConnectorReadRequest, OfficeConnectorReadResult,
  OfficeConnectorWriteRequest, OfficeConnectorWriteResult, OfficeConnectorReconcileRequest } from './connector-http.ts'
import type { OfficeOaConfig } from './types.ts'

const text = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
  .refine(value => value.trim().length > 0 && Buffer.from(value).toString('utf8') === value)
const operation = z.enum(['approvals', 'requirements', 'status', 'submit', 'supplement', 'withdraw', 'approve', 'reject'])
const reads = new Set(['approvals', 'requirements', 'status'])
const material = z.object({ id: z.uuid(), version: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const materialList = z.array(material).max(20).refine(values => new Set(values.map(value => value.id)).size === values.length)
const configSchema = z.object({ members: z.record(officeMemberId, text),
  actions: z.array(z.object({ declaration: z.unknown(), operation, scope: text,
    materials: z.boolean() }).strict()).min(1).max(1000),
  maxMaterialBytes: z.number().int().min(1).max(16 * 1024 * 1024),
}).strict().refine(value => Object.keys(value.members).length <= 10000 &&
  new Set(Object.values(value.members)).size === Object.keys(value.members).length)

/** Deployment-owned operation whitelist and business scope; no caller-selected endpoints or actors. */
export interface OfficeOaV2Config {
  /** Fixed mapping from Office member IDs to distinct OA bridge actor identifiers. */
  readonly members: Readonly<Record<string, string>>
  /** Deployment-owned action whitelist, with a fixed OA operation and business scope for each declaration. */
  readonly actions: {
    /** Action ID, role allowlist and reviewed input fields exposed through the existing Office action directory. */
    readonly declaration: OfficeOaConfig['actions'][number]
    /** Fixed OA v2 operation; its read or write kind must match the action declaration. */
    readonly operation: z.infer<typeof operation>
    /** Fixed business scope sent to the bridge and required unchanged in its response. */
    readonly scope: string
    /** Whether submit or supplement accepts reviewed immutable Drive attachments through the declared materials field. */
    readonly materials: boolean }[]
  /** Maximum combined raw attachment bytes per submission, before base64 encoding; from 1 byte to 16 MiB. */
  readonly maxMaterialBytes: number
}

/** Explicit optional Loader configuration; omission does not instantiate or register a provider. */
export const officeOaV2Config: Schema<OfficeOaV2Config> = Schema.union([Schema.object({
  members: Schema.dict(Schema.string()).required(), maxMaterialBytes: Schema.natural().min(1).max(16777216).required(),
  actions: Schema.array(Schema.object({
    operation: Schema.union(['approvals', 'requirements', 'status', 'submit', 'supplement', 'withdraw', 'approve', 'reject']).required(),
    scope: Schema.string().required(), materials: Schema.boolean().required(), declaration: Schema.object({
      id: Schema.string().required(), label: Schema.string().required(), description: Schema.string().required(),
      kind: Schema.union(['read', 'write']).required(),
      allowedRoles: Schema.array(Schema.union(['employee', 'manager', 'admin'])).required(),
      fields: Schema.array(Schema.object({ name: Schema.string().required(), label: Schema.string().required(),
        required: Schema.boolean().required(), maxLength: Schema.natural().min(1).max(4000).required() })),
    }).required(),
  })).required(),
})])

/** Current Drive authorization and immutable version lookup, supplied by the Office owner. */
export interface OfficeOaMaterialReader {
  /** Read precisely the reviewed version under this employee's current permission; never resolve a path or URL. */
  read(request: OfficeConnectorWriteRequest, reference: z.infer<typeof material>): Promise<{
    readonly bytes: Uint8Array
    readonly name: string
    readonly mediaType: string
  }>
  /** Recheck every selected version and current permission after reads, immediately before submission. */
  assertCurrent(request: OfficeConnectorWriteRequest, references: readonly z.infer<typeof material>[]): Promise<void>
}

/**
 * Create a separately selected OA v2 provider without altering the existing v1 adapter.
 * @param value - Exact mappings, operation declarations, scopes and complete attachment-byte bound.
 * @param limits - Existing Office action-directory bounds.
 * @param files - Current authorized immutable material reader; required when materials are advertised.
 * @returns Fixed-path provider using the original execution UUID for submissions and recovery reads only.
 */
export function createOaV2Adapter(value: OfficeOaV2Config,
  limits: { readonly actionMaxCount: number; readonly actionMaxBytes: number }, files?: OfficeOaMaterialReader): OfficeConnectorAdapter {
  const config = configSchema.parse(value)
  const declarations = snapshotConnectorActions(value.actions.map(action => action.declaration),
    { count: limits.actionMaxCount, bytes: limits.actionMaxBytes })
  const actions = declarations.map((declaration, index) => {
    const entry = config.actions[index]
    if (!entry) throw new OfficeError('invalid_input', 'OA v2 action configuration is incomplete')
    return { ...entry, declaration }
  })
  for (const action of actions) {
    if ((action.declaration.kind === 'read') !== reads.has(action.operation) ||
      action.materials && (!files || !['submit', 'supplement'].includes(action.operation)) ||
      action.materials !== !!action.declaration.fields?.some(field => field.name === 'materials'))
      throw new OfficeError('invalid_input', 'OA v2 operation and material declarations do not match')
    if (!reads.has(action.operation) && action.operation !== 'submit' &&
      !['approval_id', 'expected_revision'].every(name => action.declaration.fields?.some(field => field.name === name && field.required)))
      throw new OfficeError('invalid_input', 'OA v2 mutations require reviewed approval identity and revision')
  }
  function admission(request: OfficeConnectorReadRequest) {
    const action = actions.find(value => value.declaration.id === request.actionId &&
      value.declaration.allowedRoles.includes(request.member.role))
    const actor = Object.hasOwn(config.members, request.member.id) ? config.members[request.member.id] : undefined
    if (!action || !actor || request.signal.aborted || Object.keys(request.headers).some(name =>
      ['x-oa-actor', 'x-oa-action', 'idempotency-key'].includes(name.toLowerCase()))) return
    return { action, actor }
  }
  function outcome(request: OfficeConnectorReconcileRequest, input: unknown): OfficeConnectorWriteResult {
    const admitted = admission(request)
    if (!admitted || reads.has(admitted.action.operation)) return { status: 'unknown' }
    const parsed = z.object({ protocol: z.literal(2), actor: text, action: text, scope: text, operation,
      executionId: z.uuid(), outcome: z.discriminatedUnion('status', [
        z.object({ status: z.literal('succeeded'), acceptance: z.literal('accepted'), reference: text }).strict(),
        z.object({ status: z.literal('rejected'), rejection: z.enum([
          'denied', 'not_accepted', 'unauthorized', 'rate_limited', 'invalid_input',
        ]) }).strict(), z.object({ status: z.literal('unknown') }).strict(),
      ]),
    }).strict().safeParse(input)
    if (!parsed.success || parsed.data.actor !== admitted.actor || parsed.data.action !== request.actionId ||
      parsed.data.scope !== admitted.action.scope || parsed.data.operation !== admitted.action.operation ||
      parsed.data.executionId !== request.executionId) return { status: 'unknown' }
    const result = parsed.data.outcome
    if (result.status !== 'succeeded') return result
    if (request.maxEntries < 1) return { status: 'unknown' }
    return { status: 'succeeded', result: { summary: 'OA 操作已受理；审批决定须另行查询',
      entries: [{ label: '受理标识', value: result.reference }] } }
  }
  async function read(request: OfficeConnectorReadRequest): Promise<OfficeConnectorReadResult> {
    const admitted = admission(request)
    if (!admitted || !reads.has(admitted.action.operation)) return { status: 'unauthorized' }
    const response = await readConnectorJson(new URL(`v2/actions/${encodeURIComponent(request.actionId)}/read`, request.baseUrl),
      request, 'GET', { ...request.headers, 'x-oa-actor': encodeURIComponent(admitted.actor) })
    if (!response.ok) return response.failure
    const parsed = z.object({ protocol: z.literal(2), actor: text, action: text, scope: text, operation,
      observedAt: z.iso.datetime(), approvals: z.array(z.object({ id: text, revision: z.number().int().positive(),
        state: z.enum(['pending', 'needs_materials', 'approved', 'rejected', 'withdrawn']),
        requirements: z.array(text).max(32),
      }).strict()).max(100),
    }).strict().safeParse(response.value)
    if (!parsed.success || request.signal.aborted || parsed.data.actor !== admitted.actor ||
      parsed.data.action !== request.actionId || parsed.data.scope !== admitted.action.scope ||
      parsed.data.operation !== admitted.action.operation ||
      new Set(parsed.data.approvals.map(value => value.id)).size !== parsed.data.approvals.length)
      return { status: 'invalid_response' }
    const entries = [{ label: '观察时间', value: parsed.data.observedAt }, ...parsed.data.approvals.flatMap(value => [
      { label: '审批标识', value: value.id }, { label: '业务版本', value: String(value.revision) },
      { label: '审批状态', value: value.state }, ...value.requirements.map(requirement => ({ label: '材料要求', value: requirement })),
    ])]
    if (entries.length > request.maxEntries) return { status: 'invalid_response' }
    return { status: 'read', data: { summary: 'OA 当前审批与材料快照', entries } }
  }
  async function write(request: OfficeConnectorWriteRequest): Promise<OfficeConnectorWriteResult> {
    const admitted = admission(request)
    if (!admitted || reads.has(admitted.action.operation)) return { status: 'rejected', rejection: 'denied' }
    validateConnectorWriteValues(admitted.action.declaration, request.values)
    if (admitted.action.operation !== 'submit' && (!text.safeParse(request.values.approval_id).success ||
      !/^[1-9][0-9]{0,15}$/.test(request.values.expected_revision ?? '') ||
      !Number.isSafeInteger(Number(request.values.expected_revision)))) return { status: 'rejected', rejection: 'invalid_input' }
    let references: z.infer<typeof materialList> = []
    if (admitted.action.materials && request.values.materials !== undefined) {
      try { references = materialList.parse(JSON.parse(request.values.materials)) }
      catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError) return { status: 'rejected', rejection: 'invalid_input' }
        throw error
      }
    }
    const attachments: { id: string; version: string; sha256: string; name: string; mediaType: string; contentBase64: string }[] = []
    let bytes = 0
    for (const reference of references) {
      if (!files) return { status: 'rejected', rejection: 'denied' }
      const file = await files.read(request, reference)
      bytes += file.bytes.byteLength
      if (bytes > config.maxMaterialBytes || !text.safeParse(file.name).success || !text.safeParse(file.mediaType).success ||
        createHash('sha256').update(file.bytes).digest('hex') !== reference.sha256)
        return { status: 'rejected', rejection: 'invalid_input' }
      attachments.push({ ...reference, name: file.name, mediaType: file.mediaType, contentBase64: Buffer.from(file.bytes).toString('base64') })
    }
    if (files && references.length) await files.assertCurrent(request, references)
    if (request.signal.aborted) return { status: 'rejected', rejection: 'not_accepted' }
    const { materials: _materials, ...values } = request.values
    const response = await readConnectorJson(new URL(`v2/actions/${encodeURIComponent(request.actionId)}/submit`, request.baseUrl),
      request, 'POST', { ...request.headers, 'content-type': 'application/json', 'x-oa-actor': encodeURIComponent(admitted.actor),
        'idempotency-key': request.executionId }, { protocol: 2, actor: admitted.actor, action: request.actionId,
        operation: admitted.action.operation, scope: admitted.action.scope, executionId: request.executionId, values, attachments })
    return response.ok ? outcome(request, response.value) : { status: 'unknown' }
  }
  async function reconcile(request: OfficeConnectorReconcileRequest): Promise<OfficeConnectorWriteResult> {
    const admitted = admission(request)
    if (!admitted || reads.has(admitted.action.operation)) return { status: 'unknown' }
    const response = await readConnectorJson(new URL(`v2/executions/${encodeURIComponent(request.executionId)}`, request.baseUrl),
      request, 'GET', { ...request.headers, 'x-oa-actor': encodeURIComponent(admitted.actor), 'x-oa-action': request.actionId })
    return response.ok ? outcome(request, response.value) : { status: 'unknown' }
  }
  return { id: 'oa-bridge-v2', actions: declarations, read, write, reconcile,
    reconcileActions: actions.filter(value => !reads.has(value.operation)).map(value => value.declaration.id),
    async probe(request) {
      const url = new URL(request.url)
      if (!url.pathname.endsWith('/v2/health') || url.search || url.hash || Object.keys(request.headers).some(name =>
        ['x-oa-actor', 'x-oa-action', 'idempotency-key'].includes(name.toLowerCase()))) return { status: 'invalid_response' }
      const response = await readConnectorJson(url, request, 'GET', { ...request.headers })
      if (!response.ok) return response.failure
      return { status: !request.signal.aborted && z.object({ protocol: z.literal(2) }).strict().safeParse(response.value).success
        ? 'connected' : 'invalid_response', httpStatus: response.httpStatus }
    },
  }
}
