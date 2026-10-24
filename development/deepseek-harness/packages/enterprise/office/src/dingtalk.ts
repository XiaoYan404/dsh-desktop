/** DingTalk enterprise operations use server-owned employee mappings and freshly resolved app credentials. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { OfficeConnectorAdapter, OfficeConnectorReadRequest,
  OfficeConnectorReadResult, OfficeConnectorWriteRequest, OfficeConnectorReconcileRequest,
  OfficeConnectorWriteResult } from './connector-http.ts'
import type { OfficeConnectorActionDeclaration, OfficeConnectorExecutionId, OfficeDingTalkConfig } from './types.ts'
import { officeMemberId } from './spec.ts'
import { OfficeError } from './error.ts'
import type { OfficeDingTalkMessageRepository } from './dingtalk-messages.ts'
import { readConnectorJson as json } from './connector-json.ts'
import type { ConnectorRequestLifetime as Lifetime } from './connector-json.ts'

const identifier = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/)
  .refine(value => value !== '.' && value !== '..')
const configuration = z.object({ appKey: identifier, robotCode: identifier.optional(),
  members: z.record(officeMemberId, z.object({ unionId: identifier,
    calendarId: identifier.optional(), userId: identifier.optional() }).strict()),
  actions: z.array(z.enum(['todos', 'calendar', 'create_todo', 'create_calendar', 'send_message'])).max(5)
    .refine(values => new Set(values).size === values.length),
  calendarWindowHours: z.number().int().min(1).max(744).default(24),
}).strict().refine((value) => {
  const members = Object.values(value.members)
  const staff = members.flatMap(member => member.userId === undefined ? [] : [member.userId])
  return members.length <= 10000 && new Set(members.map(member => member.unionId)).size === members.length
    && new Set(staff).size === staff.length && (!value.actions.includes('send_message') || value.robotCode !== undefined)
})
const tokenSchema = z.object({ accessToken: z.string().min(1).max(8192).regex(/^[^\r\n\u0000]+$/),
  expireIn: z.number().int().positive() })
const text = z.string().max(4000)
const todos = z.object({ todoCards: z.array(z.object({ subject: text, isDone: z.boolean() })).max(10000),
  nextToken: z.string().max(8192).optional() })
const eventTime = z.object({ dateTime: z.string().max(100).optional(), date: z.string().max(100).optional() })
const calendar = z.object({ events: z.array(z.object({ summary: text, start: eventTime, end: eventTime })).max(10000),
  nextToken: z.string().max(8192).optional() })
const todoFields = z.object({ subject: z.string().min(1).max(200).refine(value => value.trim().length > 0),
  description: text.optional(), due_time: z.union([z.literal(''), z.iso.datetime({ offset: true })]).optional() }).strict()
const savedTodo = z.object({ id: z.string().min(1).max(4000), creatorId: identifier, sourceId: identifier, subject: text })
const instant = z.iso.datetime({ offset: true }).max(100)
const eventFields = z.object({ summary: z.string().min(1).max(200).refine(value => value.trim().length > 0),
  description: text.optional(), start_time: instant, end_time: instant }).strict()
  .refine(value => Date.parse(value.end_time) > Date.parse(value.start_time))
const savedEvent = z.object({ id: z.string().min(1).max(4000), summary: text,
  start: z.object({ dateTime: instant }), end: z.object({ dateTime: instant }) })
const messageFields = z.object({ title: z.string().min(1).max(200).refine(value => value.trim().length > 0),
  text: z.string().min(1).max(4000).refine(value => value.trim().length > 0) }).strict()
const messageAcknowledgement = z.object({ processQueryKey: z.string().min(1).max(4000).optional(),
  filteredStaffIdList: z.array(identifier).max(1000).default([]), flowControlledStaffIdList: z.array(identifier).max(1000).default([]),
  invalidStaffIdList: z.array(identifier).max(1000).default([]) })
const digest = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
interface MessageSupport {
  readonly repository: () => OfficeDingTalkMessageRepository | null
  readonly storageFailure: (stage: 'lookup' | 'reserve' | 'settle', id: OfficeConnectorExecutionId) => void
}
/**
 * Build a trusted provider without making requests or retaining credentials/tokens.
 * @param value - Explicit app identity, approved operations and private employee-to-DingTalk mappings.
 * @param messages - Provider-owned durable outbox and sanitized reporting, required for message submission.
 * @returns An abort-aware provider; connection bearer credentials supply AppSecret only to the token endpoint.
 */
export function createDingTalkAdapter(value: OfficeDingTalkConfig, messages?: MessageSupport): OfficeConnectorAdapter {
  const config = configuration.parse(value)
  if (config.actions.includes('send_message') && !messages)
    throw new OfficeError('invalid_input', 'DingTalk message submission requires a durable provider outbox')
  const descriptions = { todos: ['dingtalk-todos', '查询我的钉钉待办', '读取本人企业待办的第一页，结果明确标注截断。'],
    calendar: ['dingtalk-calendar', '查询我的钉钉日历', '读取本人指定日历在配置时间范围内的第一页。'],
    create_todo: ['dingtalk-create-todo', '创建我的钉钉待办', '审核后只为本人创建待办；结果不确定时按原标识核查，不重新提交。'],
    create_calendar: ['dingtalk-create-calendar', '创建我的钉钉日程', '审核后在本人的指定日历创建日程，不邀请其他人；不确定结果须保留原标识并在钉钉核对。'],
    send_message: ['dingtalk-send-message', '提交本人的钉钉工作提示', '审核后只向本人的钉钉账户提交工作提示；发件箱防止原请求重复，平台受理不代表送达。'],
  } as const
  const actions: OfficeConnectorActionDeclaration[] = config.actions.map((action) => {
    const [id, label, description] = descriptions[action]
    if (action === 'send_message') return { id, label, description, kind: 'write', allowedRoles: ['employee', 'manager', 'admin'],
      fields: [{ name: 'title', label: '工作提示标题', required: true, maxLength: 200 },
        { name: 'text', label: '工作提示内容', required: true, maxLength: 4000 }] }
    if (action === 'create_calendar') return { id, label, description, kind: 'write', allowedRoles: ['employee', 'manager', 'admin'],
      fields: [{ name: 'summary', label: '日程标题', required: true, maxLength: 200 },
        { name: 'description', label: '日程说明', required: false, maxLength: 4000 },
        { name: 'start_time', label: '开始时间（ISO 8601，含时区）', required: true, maxLength: 64 },
        { name: 'end_time', label: '结束时间（ISO 8601，含时区）', required: true, maxLength: 64 }] }
    if (action === 'create_todo') return { id, label, description, kind: 'write', allowedRoles: ['employee', 'manager', 'admin'],
      fields: [{ name: 'subject', label: '待办标题', required: true, maxLength: 200 },
        { name: 'description', label: '待办说明', required: false, maxLength: 4000 },
        { name: 'due_time', label: '截止时间（ISO 8601，可空）', required: false, maxLength: 64 }] }
    return { id, label, description, kind: 'read', allowedRoles: ['employee', 'manager', 'admin'] }
  })
  async function token(url: URL, request: Lifetime & { readonly headers: Readonly<Record<string, string>> }) {
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim())
      return { ok: false as const, httpStatus: undefined, failure: { status: 'unauthorized' as const } }
    const result = await json(url, request, 'POST', { 'content-type': 'application/json' },
      { appKey: config.appKey, appSecret: authorization.slice(7) })
    if (!result.ok) return result
    const parsed = tokenSchema.safeParse(result.value)
    if (!parsed.success) return { ok: false as const, httpStatus: result.httpStatus, failure: { status: 'invalid_response' as const } }
    return { ok: true as const, token: parsed.data.accessToken, httpStatus: result.httpStatus }
  }
  async function read(request: OfficeConnectorReadRequest): Promise<OfficeConnectorReadResult> {
    const action = actions.find(action => action.id === request.actionId)
    const member = Object.hasOwn(config.members, request.member.id) ? config.members[request.member.id] : undefined
    if (!action || action.kind !== 'read' || !member || (action.id === 'dingtalk-calendar' && !member.calendarId))
      return { status: 'unauthorized' }
    const auth = await token(new URL('v1.0/oauth2/accessToken', request.baseUrl), request)
    if (!auth.ok) return auth.failure
    const headers = { 'x-acs-dingtalk-access-token': auth.token, 'content-type': 'application/json' }
    const user = encodeURIComponent(member.unionId)
    if (action.id === 'dingtalk-todos') {
      const result = await json(new URL(`v1.0/todo/users/${user}/org/tasks/query`, request.baseUrl), request, 'POST', headers,
        { isDone: false, todoType: 'TODO' })
      if (!result.ok) return result.failure
      const parsed = todos.safeParse(result.value)
      if (!parsed.success) return { status: 'invalid_response' }
      const entries = parsed.data.todoCards.slice(0, request.maxEntries).map((entry, index) => ({
        label: `${index + 1}. ${entry.subject}`.slice(0, 200), value: entry.isDone ? '已完成' : '未完成',
      }))
      return { status: 'read', data: { summary: `钉钉本人待办：本页显示 ${entries.length} 条；${
        parsed.data.nextToken || parsed.data.todoCards.length > entries.length ? '还有更多结果' : '本页已完整显示'}`, entries } }
    }
    const at = Date.now()
    const url = new URL(`v1.0/calendar/users/${user}/calendars/${encodeURIComponent(member.calendarId ?? '')}/events`, request.baseUrl)
    url.searchParams.set('timeMin', new Date(at).toISOString().slice(0, 16) + 'Z')
    url.searchParams.set('timeMax', new Date(at + config.calendarWindowHours * 3600000).toISOString().slice(0, 16) + 'Z')
    url.searchParams.set('maxResults', String(request.maxEntries))
    url.searchParams.set('showDeleted', 'false')
    const result = await json(url, request, 'GET', headers)
    if (!result.ok) return result.failure
    const parsed = calendar.safeParse(result.value)
    if (!parsed.success) return { status: 'invalid_response' }
    const entries = parsed.data.events.slice(0, request.maxEntries).map((event, index) => ({
      label: `${index + 1}. ${event.summary}`.slice(0, 200),
      value: `${event.start.dateTime ?? event.start.date ?? ''} — ${event.end.dateTime ?? event.end.date ?? ''}`,
    }))
    return { status: 'read', data: { summary: `钉钉本人日历：未来 ${config.calendarWindowHours} 小时，本页显示 ${entries.length} 条；${
      parsed.data.nextToken || parsed.data.events.length > entries.length ? '还有更多结果' : '本页已完整显示'}`, entries } }
  }
  function result(value: unknown, unionId: string, sourceId: string, maxEntries: number): OfficeConnectorWriteResult {
    const parsed = savedTodo.safeParse(value)
    if (!parsed.success || parsed.data.creatorId !== unionId || parsed.data.sourceId !== sourceId) return { status: 'unknown' }
    return { status: 'succeeded', result: { summary: '钉钉待办已确认创建', entries: [
      { label: '任务标识', value: parsed.data.id }, { label: '标题', value: parsed.data.subject },
    ].slice(0, maxEntries) } }
  }
  function writer(request: OfficeConnectorReconcileRequest) {
    const scope = request.actionId === 'dingtalk-create-todo' ? 'create_todo'
      : request.actionId === 'dingtalk-create-calendar' ? 'create_calendar'
        : request.actionId === 'dingtalk-send-message' ? 'send_message' : null
    if (!scope || !config.actions.includes(scope)) return
    return Object.hasOwn(config.members, request.member.id) ? config.members[request.member.id] : undefined
  }
  function messageBinding(request: OfficeConnectorReconcileRequest, userId: string) {
    return digest({ appKey: config.appKey, robotCode: config.robotCode, baseUrl: new URL(request.baseUrl).href,
      memberId: request.member.id, role: request.member.role, userId })
  }
  function messageResult(value: unknown, userId: string): OfficeConnectorWriteResult {
    const parsed = messageAcknowledgement.safeParse(value)
    if (!parsed.success) return { status: 'unknown' }
    const data = parsed.data
    const failures = [data.invalidStaffIdList, data.filteredStaffIdList, data.flowControlledStaffIdList]
    if (failures.some(list => list.length > 0)) {
      if (failures.filter(list => list.length > 0).length !== 1 || failures.some(list => list.some(id => id !== userId)))
        return { status: 'unknown' }
      return { status: 'rejected', rejection: data.invalidStaffIdList.length ? 'invalid_input'
        : data.filteredStaffIdList.length ? 'denied' : 'rate_limited' }
    }
    if (!data.processQueryKey) return { status: 'unknown' }
    return { status: 'succeeded', result: { summary: '钉钉已受理本人消息投递，不代表已送达',
      entries: [{ label: '投递查询标识', value: data.processQueryKey }] } }
  }
  async function sendMessage(request: OfficeConnectorWriteRequest, userId: string): Promise<OfficeConnectorWriteResult> {
    const fields = messageFields.safeParse(request.values)
    const store = messages?.repository()
    if (!fields.success) return { status: 'rejected', rejection: 'invalid_input' }
    if (!store || !config.robotCode) return { status: 'rejected', rejection: 'denied' }
    const binding = messageBinding(request, userId)
    const content = digest({ title: fields.data.title, text: fields.data.text })
    try {
      const prior = await store.lookup(request.member, request.executionId, binding, content)
      if (prior) return prior
    } catch (error) {
      // An unreadable original reservation cannot authorize a second business dispatch.
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
    const auth = await token(new URL('v1.0/oauth2/accessToken', request.baseUrl), request)
    let outcome: OfficeConnectorWriteResult
    if (!auth.ok) outcome = { status: 'rejected', rejection: auth.failure.status === 'unauthorized' ? 'unauthorized'
      : auth.failure.status === 'rate_limited' ? 'rate_limited' : 'not_accepted' }
    else {
      // Recheck current employee authority after the separate token request and before the message POST.
      await store.lookup(request.member, request.executionId, binding, content)
      const response = await json(new URL('v1.0/robot/oToMessages/batchSend', request.baseUrl), request, 'POST',
        { 'x-acs-dingtalk-access-token': auth.token, 'content-type': 'application/json' },
        { robotCode: config.robotCode, userIds: [userId], msgKey: 'sampleMarkdown',
          msgParam: JSON.stringify({ title: fields.data.title, text: fields.data.text }) })
      outcome = response.ok ? messageResult(response.value, userId) : { status: 'unknown' }
    }
    if (outcome.status === 'unknown') return outcome
    try { return await store.settle(request.member, request.executionId, binding, content, outcome) }
    catch (error) {
      // Missing durable acknowledgement remains uncertain even when the vendor returned a response.
      void error; messages?.storageFailure('settle', request.executionId); return { status: 'unknown' }
    }
  }
  async function createEvent(request: OfficeConnectorWriteRequest, unionId: string,
    calendarId: string): Promise<OfficeConnectorWriteResult> {
    const fields = eventFields.safeParse(request.values)
    if (!fields.success) return { status: 'rejected', rejection: 'invalid_input' }
    const auth = await token(new URL('v1.0/oauth2/accessToken', request.baseUrl), request)
    if (!auth.ok) return { status: 'rejected', rejection: auth.failure.status === 'unauthorized' ? 'unauthorized'
      : auth.failure.status === 'rate_limited' ? 'rate_limited' : 'not_accepted' }
    const saved = await json(new URL(`v1.0/calendar/users/${encodeURIComponent(unionId)}/calendars/${
      encodeURIComponent(calendarId)}/events`, request.baseUrl), request, 'POST', { 'x-acs-dingtalk-access-token': auth.token,
      'x-client-token': request.executionId, 'content-type': 'application/json' },
    { summary: fields.data.summary, description: fields.data.description ?? '', isAllDay: false, attendees: [],
      start: { dateTime: fields.data.start_time }, end: { dateTime: fields.data.end_time } })
    if (!saved.ok) return { status: 'unknown' }
    const parsed = savedEvent.safeParse(saved.value)
    if (!parsed.success || parsed.data.summary !== fields.data.summary
      || Date.parse(parsed.data.start.dateTime) !== Date.parse(fields.data.start_time)
      || Date.parse(parsed.data.end.dateTime) !== Date.parse(fields.data.end_time)) return { status: 'unknown' }
    return { status: 'succeeded', result: { summary: '钉钉日程已确认创建', entries: [
      { label: '日程标识', value: parsed.data.id }, { label: '标题', value: parsed.data.summary },
      { label: '开始', value: parsed.data.start.dateTime }, { label: '结束', value: parsed.data.end.dateTime },
    ].slice(0, request.maxEntries) } }
  }
  async function write(request: OfficeConnectorWriteRequest): Promise<OfficeConnectorWriteResult> {
    const member = writer(request)
    if (!member) return { status: 'rejected', rejection: 'denied' }
    if (request.actionId === 'dingtalk-send-message') return member.userId
      ? sendMessage(request, member.userId) : { status: 'rejected', rejection: 'denied' }
    if (request.actionId === 'dingtalk-create-calendar') return member.calendarId
      ? createEvent(request, member.unionId, member.calendarId) : { status: 'rejected', rejection: 'denied' }
    const fields = todoFields.safeParse(request.values)
    if (!fields.success) return { status: 'rejected', rejection: 'invalid_input' }
    const auth = await token(new URL('v1.0/oauth2/accessToken', request.baseUrl), request)
    if (!auth.ok) return { status: 'rejected', rejection: auth.failure.status === 'unauthorized' ? 'unauthorized'
      : auth.failure.status === 'rate_limited' ? 'rate_limited' : 'not_accepted' }
    const saved = await json(new URL(`v1.0/todo/users/${encodeURIComponent(member.unionId)}/tasks`, request.baseUrl),
      request, 'POST', { 'x-acs-dingtalk-access-token': auth.token, 'content-type': 'application/json' },
      { subject: fields.data.subject, description: fields.data.description ?? '', sourceId: request.executionId,
        creatorId: member.unionId, executorIds: [member.unionId], isOnlyShowExecutor: true, todoType: 'TODO',
        ...fields.data.due_time ? { dueTime: Date.parse(fields.data.due_time) } : {} })
    // Once the business POST starts, an error or missing receipt cannot authorize another submission.
    return saved.ok ? result(saved.value, member.unionId, request.executionId, request.maxEntries) : { status: 'unknown' }
  }
  async function reconcile(request: OfficeConnectorReconcileRequest): Promise<OfficeConnectorWriteResult> {
    if (request.actionId === 'dingtalk-send-message') {
      const member = writer(request)
      const store = messages?.repository()
      if (!member?.userId || !store) return { status: 'unknown' }
      return await store.lookup(request.member, request.executionId, messageBinding(request, member.userId)) ?? { status: 'unknown' }
    }
    if (request.actionId !== 'dingtalk-create-todo') return { status: 'unknown' }
    const member = writer(request)
    if (!member) return { status: 'unknown' }
    const auth = await token(new URL('v1.0/oauth2/accessToken', request.baseUrl), request)
    if (!auth.ok) return { status: 'unknown' }
    const found = await json(new URL(`v1.0/todo/users/${encodeURIComponent(member.unionId)}/tasks/sources/${
      encodeURIComponent(request.executionId)}`, request.baseUrl), request, 'GET', { 'x-acs-dingtalk-access-token': auth.token })
    // Even a 404 can be a delayed vendor projection; absence never means the original POST was unaccepted.
    return found.ok ? result(found.value, member.unionId, request.executionId, request.maxEntries) : { status: 'unknown' }
  }
  const writes = config.actions.includes('create_todo') || config.actions.includes('create_calendar') || config.actions.includes('send_message')
  const reconcileActions = [
    ...config.actions.includes('create_todo') ? ['dingtalk-create-todo'] : [],
    ...config.actions.includes('send_message') ? ['dingtalk-send-message'] : [],
  ]
  const checks = reconcileActions.length ? { reconcile, reconcileActions } : {}
  return { id: 'dingtalk', actions, read, ...writes ? { write } : {}, ...checks, async probe(request) {
    const url = new URL(request.url)
    if (!url.pathname.endsWith('/v1.0/oauth2/accessToken') || url.search) return { status: 'invalid_response' }
    const result = await token(url, request)
    return { status: result.ok ? 'connected' : result.failure.status,
      ...result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus } }
  } }
}
