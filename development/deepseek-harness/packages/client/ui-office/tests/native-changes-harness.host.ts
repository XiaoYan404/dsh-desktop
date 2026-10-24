/** Source-composed HTTP routes over real Office authority and turn snapshots. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import OfficeGateway from '@deepseek-ai/dsh-enterprise-office-gateway'
import type { OfficeConversationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { onTestFinished } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import OfficeController from '../src/index.ts'
import { registerPresentOpen } from '../../ui-deliverables/src/present-open.ts'

const runFile = promisify(execFile)
const admin = 'admin' as OfficeMemberId
export const alice = 'alice' as OfficeMemberId
export const bob = 'bob' as OfficeMemberId
const password = 'Changes access fixture password!'
export const filename = 'alice-private-plan.txt'
export const marker = 'ALICE_PRIVATE_CHANGE_8c905f33'

/** @returns Real composed Session, HTTP access and a recorded private change. */
export async function changesAccessFixture(options: { office?: boolean; attributed?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-changes-access-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  const central = new Context()
  const lifetime = new AbortController()
  const attributed = options.office !== false && options.attributed !== false
  const targetName = attributed ? filename : 'native-plan.txt'
  const outputMarker = attributed ? marker : 'UNASSOCIATED_NATIVE_CHANGE'
  onTestFinished(async () => {
    lifetime.abort()
    try { await ctx.fiber.dispose() }
    finally {
      try { await central.fiber.dispose() }
      finally {
        const target = resolve(root)
        if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('dsh-office-changes-access-')) {
          throw new Error('Unexpected changes access cleanup directory')
        }
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })
  const git = async (...args: string[]): Promise<void> => {
    await runFile('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
      '-c', 'commit.gpgsign=false', ...args], { cwd, timeout: 10_000, windowsHide: true, signal: lifetime.signal })
  }
  await git('init', '-q')
  await writeFile(join(cwd, targetName), 'public initial content\n')
  await git('add', '--', targetName)
  await git('commit', '-q', '-m', 'Fixture baseline')

  await central.plugin(Storage)
  await central.plugin(StorageJson, { root: join(root, 'central') })
  await central.plugin(StorageDomain, { backend: 'json' })
  await central.plugin(OfficeService, {
    companyName: 'Changes authority fixture', timeZone: 'Asia/Shanghai', dshHome: root,
    members: [
      { id: admin, name: 'Admin', department: 'Office', jobTitle: 'Admin', role: 'admin' },
      { id: alice, name: 'Alice', department: 'Office', jobTitle: 'Employee', role: 'employee' },
      { id: bob, name: 'Bob', department: 'Office', jobTitle: 'Employee', role: 'employee' },
    ],
  })
  await central.office.initializeIdentity(admin, password)
  await central.office.setIdentityPassword(admin, alice, password)
  await central.office.setIdentityPassword(admin, bob, password)
  await central.plugin(OfficeGateway, { host: '127.0.0.1', port: 0, administratorId: admin, loginRequestsPerMinute: 100 })

  const routes = {
    inject: ['connection', 'webServer', 'workspaceChanges', 'sessionQuery'],
    apply(scope: Context): void {
      // This is the production exact-route registrar; no route or recorder is replaced.
      registerPresentOpen(scope)
      scope.effect(() => scope.webServer.register({ kind: 'exact', path: '/', handler: (request, response) => {
        if (!scope.connection.authorizeIndex(request, response)) return
        response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        response.end('Changes access fixture')
      } }))
    },
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjections],
    ['@deepseek-ai/dsh-session-query-sqlite', SqliteSessionQuery],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocess],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-workspace-changes', WorkspaceChanges],
    ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
    ['fixture-credentials', MemoryCredentials],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-client-ui-office', OfficeController],
    ['fixture-deliverables-routes', routes],
  ])
  if (options.office === false) modules.delete('@deepseek-ai/dsh-client-ui-office')
  const config: Record<string, object> = {
    '@deepseek-ai/dsh-session-query-sqlite': { path: ':memory:', openAt: 'first-search' },
    '@deepseek-ai/dsh-tools': { mode: 'native' },
    '@deepseek-ai/dsh-fs-local': { cwd },
    '@deepseek-ai/dsh-host-webserver': { host: '127.0.0.1', port: 0 },
    '@deepseek-ai/dsh-client-ui-office': { gatewayUrl: central.officeGateway.address },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ name, config: config[name] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('Changes access Loader has no import provider')
  ctx.loader.internal = new Proxy(internal, {
    get(target, key) {
      if (key === 'import') return async (name: string) => {
        if (!modules.has(name)) throw new Error(`Unexpected changes access fixture module: ${name}`)
        return modules.get(name)
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  if (options.office !== false && !ctx.get('officeController') || !ctx.get('workspaceChanges') || !ctx.get('sessionQuery')
    || !ctx.get('connection') || !ctx.get('webServer') || !ctx.get('tools')) {
    throw new Error('Changes access composition did not activate')
  }
  const signIn = async (memberId: OfficeMemberId): Promise<void> => {
    const result = await ctx.officeController.signIn({ memberId, password })
    if (!result.ok || result.value.member?.id !== memberId) throw new Error('Fixture employee could not sign in')
  }
  if (options.office !== false) await signIn(alice)
  const session = ctx.sessions.create(undefined, { meta: { cwd } })
  if (attributed) {
    const conversationId = String(session.id) as OfficeConversationId
    const selected = await ctx.officeController.saveConversationLinks({
      conversationId, revision: 0, requestId: randomUUID(), kind: 'integrations', integrations: [],
    })
    if (!selected.ok) throw new Error('Fixture Office association could not be saved')
    const captured = await ctx.officeController.captureConversation({
      conversationId, revision: selected.value.revision, requestId: randomUUID(),
    })
    if (!captured.ok) throw new Error('Fixture Office association could not be captured')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Update the reviewed private plan.' }],
      source: { kind: 'user', preparedContexts: [{ text: 'Reviewed Office input',
        source: { kind: 'office', form: 'snapshot', sections: [], capture: captured.value } }] },
    }), { surfaceOp: 'append' })
  }

  const agentScope = ctx.plugin(() => {})
  const agent: Agent = {
    id: session.id, session, ctx: agentScope.ctx, options: {}, inbox: unsupportedInbox(), status: 'idle',
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    runMaintenance: task => task(lifetime.signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  ctx.tools.register(defineTool({
    name: 'fixture_change', description: 'Write the fixture private plan.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (_args, execution) => {
      await writeFile(join(cwd, targetName), outputMarker + '\n', { signal: execution.signal })
      return 'Private plan updated'
    },
  }))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const callId = ToolCallId('fixture-private-change')
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'fixture_change', arguments: '{}' }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'fixture_change', arguments: '{}' })
  const result = await ctx.tools.execute({ callId, name: 'fixture_change', arguments: {}, agent, signal: lifetime.signal })
  if (result.isError) throw new Error('Actual fixture tool execution failed')
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: result.content, isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: lifetime.signal })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const announced = session.snapshotEvents().filter(event => event.type === 'workspace/changes')
  const event = announced[0]
  if (announced.length !== 1 || event === undefined) throw new Error('Actual recorder did not announce exactly one change')
  const summary = ctx.workspaceChanges.summary(session.id, event.seq)
  const index = summary?.files.findIndex(file => file.path === targetName)
  if (summary === undefined || index === undefined || index < 0) throw new Error('Actual recorder did not retain the private file')

  const baseUrl = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const exchanged = await fetch(ctx.connection.authenticatedUrl(baseUrl + '/'), {
    redirect: 'manual', signal: lifetime.signal,
  })
  const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0]
  await exchanged.text()
  if (exchanged.status !== 303 || cookie === undefined) throw new Error('Native launch-token exchange did not issue a cookie')
  const coordinates = `?sessionId=${encodeURIComponent(session.id)}&seq=${String(event.seq)}`
  const paths = { summary: '/api/changes.summary' + coordinates,
    diff: '/api/changes.diff' + coordinates + `&index=${String(index)}` }
  const http = async (path: string, authenticated = true, signal?: AbortSignal) => {
    const response = await fetch(baseUrl + path, {
      headers: authenticated ? { cookie } : {}, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000),
        ...(signal === undefined ? [] : [signal])]),
    })
    return { pathname: new URL(baseUrl + path).pathname, status: response.status, text: await response.text() }
  }
  const visible = () => ctx.waterfall('api-session/visible',
    { candidates: [{ sessionId: session.id }], signal: lifetime.signal }, () => Promise.resolve([session.id]))
  return { ctx, session, event, summary, index, paths, http, signIn, visible, filename: targetName, marker: outputMarker }
}
