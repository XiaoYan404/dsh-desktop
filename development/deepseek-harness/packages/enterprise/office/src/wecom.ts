/** WeCom internal-app authentication and private, deployment-mapped employee reads. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { officeMemberId } from './spec.ts'
import type { OfficeConnectorActionDeclaration, OfficeConnectorExecutionId, OfficeWeComConfig } from './types.ts'
import type { OfficeConnectorAdapter, OfficeConnectorReadRequest, OfficeConnectorReadResult,
  OfficeConnectorWriteRequest, OfficeConnectorWriteResult, OfficeConnectorReconcileRequest } from './connector-http.ts'
import { OfficeError } from './error.ts'
import type { OfficeMessageProviderRepository } from './message-provider.ts'
import { readConnectorJson } from './connector-json.ts'
import type { ConnectorRequestLifetime, ConnectorJsonResult } from './connector-json.ts'

const identifier = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
const userId = identifier.refine(value => Buffer.byteLength(value, 'utf8') <= 64 && value.trim().length > 0
  && !value.includes('|') && value.toLowerCase() !== '@all')
const configuration = z.object({ corpId: identifier, agentId: z.number().int().positive(),
  members: z.record(officeMemberId, userId), actions: z.array(z.enum(['profile', 'send_message'])).max(2)
    .refine(value => new Set(value).size === value.length),
}).strict().refine(value => Object.keys(value.members).length <= 10000
  && new Set(Object.values(value.members).map(value => value.toLowerCase())).size === Object.keys(value.members).length)
const envelope = z.object({ errcode: z.number().int() })
const token = z.object({ errcode: z.literal(0), access_token: z.string().min(1).max(512).regex(/^[^\u0000-\u0020\u007f]+$/)
  .refine(value => Buffer.byteLength(value, 'utf8') <= 512), expires_in: z.number().int().positive() })
const profile = z.object({ errcode: z.literal(0), userid: userId,
  name: z.string().min(1).max(4000), position: z.string().max(4000).optional() })
const messageFields = z.object({ content: z.string().min(1).max(2048)
  .refine(value => value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 2048) }).strict()
const messageAcknowledgement = z.object({ errcode: z.number().int(), msgid: z.string().min(1).max(4000).optional(),
  invaliduser: z.string().max(4000).default(''), unlicenseduser: z.string().max(4000).default(''),
  invalidparty: z.string().max(4000).default(''), invalidtag: z.string().max(4000).default('') })
interface MessageSupport {
  readonly repository: () => OfficeMessageProviderRepository | null
  readonly storageFailure: (stage: 'lookup' | 'reserve' | 'settle', id: OfficeConnectorExecutionId) => void
}
const digest = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Failure = Exclude<OfficeConnectorReadResult, { readonly status: 'read' }>
type Authentication = { readonly ok: true; readonly token: string; readonly httpStatus: number }
  | { readonly ok: false; readonly failure: Failure; readonly httpStatus?: number }

/**
 * Own an opt-in WeCom adapter and its one-entry, process-only token cache.
 * @param value - Deployment-owned internal-app identity and distinct Office-to-WeCom employee mappings.
 * @param messages - Durable provider outbox and sanitized reporting, required for reviewed message submission.
 * @returns Adapter plus an unloading disposer; no request starts until an authorized operation is admitted.
 */
export function createWeComAdapter(value: OfficeWeComConfig, messages?: MessageSupport): {
  readonly adapter: OfficeConnectorAdapter
  readonly close: () => void
} {
  const config = configuration.parse(value)
  if (config.actions.includes('send_message') && !messages)
    throw new OfficeError('invalid_input', 'WeCom message submission requires a durable provider outbox')
  let cached: { readonly key: string; readonly token: string; readonly expiresAt: number } | undefined
  let closed = false
  function stopped(signal: AbortSignal): boolean { return closed || signal.aborted }
  function failure(result: ConnectorJsonResult): Failure | undefined {
    if (!result.ok) return result.failure
    const parsed = envelope.safeParse(result.value)
    if (!parsed.success) return { status: 'invalid_response' }
    const code = parsed.data.errcode
    if (!code) return
    if (code === 40014 || code === 42001) {
      cached = undefined
      return { status: 'unauthorized' }
    }
    return { status: code === 45009 ? 'rate_limited' : 'http_error' }
  }
  async function authenticate(url: URL, request: ConnectorRequestLifetime & {
    readonly headers: Readonly<Record<string, string>>
  }, refresh = false): Promise<Authentication> {
    if (stopped(request.signal)) return { ok: false, failure: { status: 'timed_out' } }
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim())
      return { ok: false, failure: { status: 'unauthorized' } }
    const key = createHash('sha256').update(JSON.stringify([url.href, config.corpId, config.agentId, authorization.slice(7)])).digest('hex')
    if (!refresh && cached?.key === key && cached.expiresAt > Date.now())
      return { ok: true, token: cached.token, httpStatus: 200 }
    cached = undefined
    url.searchParams.set('corpid', config.corpId)
    url.searchParams.set('corpsecret', authorization.slice(7))
    const result = await readConnectorJson(url, request, 'GET', {})
    const rejected = failure(result)
    if (rejected || !result.ok) return { ok: false, failure: rejected ?? { status: 'invalid_response' },
      ...result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus } }
    const parsed = token.safeParse(result.value)
    if (!parsed.success) return { ok: false, failure: { status: 'invalid_response' }, httpStatus: result.httpStatus }
    if (stopped(request.signal)) return { ok: false, failure: { status: 'timed_out' } }
    const seconds = parsed.data.expires_in
    cached = { key, token: parsed.data.access_token, expiresAt: Date.now() + (seconds - Math.min(60, seconds / 2)) * 1000 }
    return { ok: true, token: cached.token, httpStatus: result.httpStatus }
  }
  async function read(request: OfficeConnectorReadRequest): Promise<OfficeConnectorReadResult> {
    const employee = Object.hasOwn(config.members, request.member.id) ? config.members[request.member.id] : undefined
    if (!employee || request.actionId !== 'wecom-profile' || !config.actions.includes('profile')) return { status: 'unauthorized' }
    const auth = await authenticate(new URL('cgi-bin/gettoken', request.baseUrl), request)
    if (!auth.ok) return auth.failure
    const url = new URL('cgi-bin/user/get', request.baseUrl)
    url.searchParams.set('access_token', auth.token)
    url.searchParams.set('userid', employee)
    const result = await readConnectorJson(url, request, 'GET', {})
    const rejected = failure(result)
    if (rejected || !result.ok) return rejected ?? { status: 'invalid_response' }
    const parsed = profile.safeParse(result.value)
    if (!parsed.success || parsed.data.userid.toLowerCase() !== employee.toLowerCase()) return { status: 'invalid_response' }
    if (stopped(request.signal)) return { status: 'timed_out' }
    return { status: 'read', data: { summary: '企业微信本人资料', entries: [
      { label: '姓名', value: parsed.data.name }, ...parsed.data.position === undefined ? [] : [{ label: '岗位', value: parsed.data.position }],
    ].slice(0, request.maxEntries) } }
  }
  function messageBinding(request: OfficeConnectorReconcileRequest, employee: string): string {
    return digest({ corpId: config.corpId, agentId: config.agentId, baseUrl: new URL(request.baseUrl).href,
      memberId: request.member.id, role: request.member.role, userId: employee.toLowerCase() })
  }
  function messageResult(value: unknown, employee: string): OfficeConnectorWriteResult {
    const parsed = messageAcknowledgement.safeParse(value)
    if (!parsed.success) return { status: 'unknown' }
    const data = parsed.data
    if (data.errcode) {
      if (data.errcode === 40014 || data.errcode === 42001) cached = undefined
      return { status: 'rejected', rejection: data.errcode === 40014 || data.errcode === 42001 ? 'unauthorized'
        : data.errcode === 45009 ? 'rate_limited' : data.errcode === 81013 ? 'denied' : 'not_accepted' }
    }
    if (data.invalidparty || data.invalidtag) return { status: 'unknown' }
    const invalid = data.invaliduser.toLowerCase()
    const unlicensed = data.unlicenseduser.toLowerCase()
    if (invalid || unlicensed) {
      if ((invalid && unlicensed) || (invalid && invalid !== employee.toLowerCase())
        || (unlicensed && unlicensed !== employee.toLowerCase())) return { status: 'unknown' }
      return { status: 'rejected', rejection: invalid ? 'invalid_input' : 'denied' }
    }
    if (!data.msgid) return { status: 'unknown' }
    return { status: 'succeeded', result: { summary: '企业微信已受理本人消息投递，不代表已送达',
      entries: [{ label: '消息标识', value: data.msgid }] } }
  }
  async function write(request: OfficeConnectorWriteRequest): Promise<OfficeConnectorWriteResult> {
    const employee = Object.hasOwn(config.members, request.member.id) ? config.members[request.member.id] : undefined
    const fields = messageFields.safeParse(request.values)
    if (!employee || request.actionId !== 'wecom-send-message' || !config.actions.includes('send_message'))
      return { status: 'rejected', rejection: 'denied' }
    if (!fields.success) return { status: 'rejected', rejection: 'invalid_input' }
    const store = messages?.repository()
    if (!store) return { status: 'rejected', rejection: 'denied' }
    const binding = messageBinding(request, employee)
    const content = digest(fields.data)
    try {
      const prior = await store.lookup(request.member, request.executionId, binding, content)
      if (prior) return prior
    } catch (error) {
      void error; messages?.storageFailure('lookup', request.executionId); return { status: 'unknown' }
    }
    try {
      const reserved = await store.reserve(request.member, request.executionId, binding, content)
      if (!reserved.dispatch) return reserved.result
    } catch (error) {
      messages?.storageFailure('reserve', request.executionId)
      return error instanceof OfficeError && error.code === 'context_too_large'
        ? { status: 'rejected', rejection: 'not_accepted' } : { status: 'unknown' }
    }
    const auth = await authenticate(new URL('cgi-bin/gettoken', request.baseUrl), request)
    let outcome: OfficeConnectorWriteResult
    if (!auth.ok) outcome = { status: 'rejected', rejection: auth.failure.status === 'unauthorized' ? 'unauthorized'
      : auth.failure.status === 'rate_limited' ? 'rate_limited' : 'not_accepted' }
    else {
      await store.lookup(request.member, request.executionId, binding, content)
      const url = new URL('cgi-bin/message/send', request.baseUrl)
      url.searchParams.set('access_token', auth.token)
      const response = await readConnectorJson(url, request, 'POST', { 'content-type': 'application/json' },
        { touser: employee, msgtype: 'text', agentid: config.agentId, text: { content: fields.data.content },
          enable_id_trans: 0, enable_duplicate_check: 0 })
      outcome = response.ok ? messageResult(response.value, employee) : { status: 'unknown' }
    }
    if (outcome.status === 'unknown') return outcome
    try { return await store.settle(request.member, request.executionId, binding, content, outcome) }
    catch (error) {
      void error; messages?.storageFailure('settle', request.executionId); return { status: 'unknown' }
    }
  }
  async function reconcile(request: OfficeConnectorReconcileRequest): Promise<OfficeConnectorWriteResult> {
    const employee = Object.hasOwn(config.members, request.member.id) ? config.members[request.member.id] : undefined
    const store = messages?.repository()
    if (!employee || !store || request.actionId !== 'wecom-send-message' || !config.actions.includes('send_message'))
      return { status: 'unknown' }
    return await store.lookup(request.member, request.executionId, messageBinding(request, employee)) ?? { status: 'unknown' }
  }
  const actions: OfficeConnectorActionDeclaration[] = config.actions.map(action => action === 'profile'
    ? { id: 'wecom-profile', label: '查询我的企业微信资料',
      description: '只读取部署配置中当前员工的姓名和岗位，不读取其他成员或联系方式。', kind: 'read',
      allowedRoles: ['employee', 'manager', 'admin'] }
    : { id: 'wecom-send-message', label: '提交本人的企业微信工作提示', kind: 'write',
      description: '审核后只向本人的企业微信提交文本消息；保留原执行回执，平台受理不代表送达。',
      allowedRoles: ['employee', 'manager', 'admin'],
      fields: [{ name: 'content', label: '消息内容（最多 2048 UTF-8 字节）', required: true, maxLength: 2048 }] })
  return { close() { closed = true; cached = undefined }, adapter: { id: 'wecom', read, actions,
    ...config.actions.includes('send_message') ? { write, reconcile, reconcileActions: ['wecom-send-message'] } : {},
    async probe(request) {
      const url = new URL(request.url)
      if (!url.pathname.endsWith('/cgi-bin/gettoken') || url.search || url.hash) return { status: 'invalid_response' }
      const result = await authenticate(url, request, true)
      return result.ok ? { status: 'connected', httpStatus: result.httpStatus }
        : { ...result.failure, ...result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus } }
    },
  } }
}
