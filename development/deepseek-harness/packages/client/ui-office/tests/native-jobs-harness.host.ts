/** Real Office authority and Loader-composed Native job resources for access regressions. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import JobController from '@deepseek-ai/dsh-api-job-controller'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import OfficeGateway from '@deepseek-ai/dsh-enterprise-office-gateway'
import type { OfficeConversationId, OfficeMemberId, OfficeRole } from '@deepseek-ai/dsh-enterprise-office/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { onTestFinished } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import OfficeController from '../src/index.ts'

const admin = 'admin' as OfficeMemberId
export const alice = 'alice' as OfficeMemberId
export const bob = 'bob' as OfficeMemberId
const password = 'Native job access fixture password!'

/** @param role - Alice's initial server role. @returns Source-composed Host and actual Office authority. */
export async function nativeJobsFixture(role: OfficeRole = 'employee') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-jobs-access-'))
  const central = new Context()
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally {
      try { await central.fiber.dispose() }
      finally {
        const target = resolve(root)
        if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('dsh-office-jobs-access-')) {
          throw new Error('Unexpected Native job fixture cleanup directory')
        }
        await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    }
  })
  await central.plugin(Storage)
  await central.plugin(StorageJson, { root: join(root, 'central') })
  await central.plugin(StorageDomain, { backend: 'json' })
  await central.plugin(OfficeService, {
    companyName: 'Job authority fixture', timeZone: 'Asia/Shanghai', dshHome: root,
    members: [
      { id: admin, name: 'Admin', department: 'Office', jobTitle: 'Admin', role: 'admin' },
      { id: alice, name: 'Alice', department: 'Office', jobTitle: 'Employee', role },
      { id: bob, name: 'Bob', department: 'Office', jobTitle: 'Employee', role: 'employee' },
    ],
  })
  await central.office.initializeIdentity(admin, password)
  await central.office.setIdentityPassword(admin, alice, password)
  await central.office.setIdentityPassword(admin, bob, password)
  await central.plugin(OfficeGateway, { host: '127.0.0.1', port: 0, administratorId: admin, loginRequestsPerMinute: 100 })

  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjections],
    ['@deepseek-ai/dsh-session-query-sqlite', SqliteSessionQuery],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-jobs-local', LocalJobs],
    ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
    ['@deepseek-ai/dsh-api-job-controller', JobController],
    ['fixture-credentials', MemoryCredentials],
    ['@deepseek-ai/dsh-client-ui-office', OfficeController],
  ])
  const config: Record<string, object> = {
    '@deepseek-ai/dsh-session-query-sqlite': { path: ':memory:', openAt: 'first-search' },
    '@deepseek-ai/dsh-client-ui-office': { gatewayUrl: central.officeGateway.address },
    '@deepseek-ai/dsh-api-job-controller': { observeFlushMs: 1 },
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ name, config: config[name] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('Native job Loader has no import provider')
  ctx.loader.internal = new Proxy(internal, {
    get(target, key) {
      if (key === 'import') return async (name: string) => {
        if (!modules.has(name)) throw new Error(`Unexpected Native job fixture module: ${name}`)
        return modules.get(name)
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  if (!ctx.get('officeController') || !ctx.get('jobController') || !ctx.get('sessionQuery')) {
    throw new Error('Native job access composition did not activate')
  }
  ctx.jobs.attachController('native-job-access-fixture')
  const signIn = async (memberId: OfficeMemberId): Promise<void> => {
    const result = await ctx.officeController.signIn({ memberId, password })
    if (!result.ok) throw new Error('Fixture employee could not sign in')
  }
  await signIn(alice)

  const session = ctx.sessions.create()
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
    content: [{ type: 'text', text: 'Start the reviewed background work.' }],
    source: { kind: 'user', preparedContexts: [{ text: 'Reviewed Office input',
      source: { kind: 'office', form: 'snapshot', sections: [], capture: captured.value } }] },
  }), { surfaceOp: 'append' })

  const register = async (value: Session): Promise<Agent> => {
    const scope = ctx.plugin(() => {})
    const agent: Agent = {
      id: value.id, session: value, ctx: scope.ctx, options: {}, inbox: unsupportedInbox(), status: 'idle',
      send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    return agent
  }
  const agent = await register(session)
  const start = (owner: Agent | null = agent) => {
    const completion = Promise.withResolvers<JobOutcome>()
    const state: { handle?: JobHandle } = {}
    const cancels: (string | undefined)[] = []
    const id = ctx.jobs.start({ kind: 'bash', label: 'Private Office job',
      ...(owner === null ? {} : { owner: owner.id }),
      run: (handle) => {
        state.handle = handle
        return { done: completion.promise, cancel: (reason) => {
          cancels.push(reason)
          completion.resolve({ status: 'killed' })
        } }
      },
    })
    return {
      id, cancels,
      append: (text: string) => {
        if (state.handle === undefined) throw new Error('Fixture job was not started')
        state.handle.append(text)
      },
      finish: async () => {
        completion.resolve({ status: 'completed' })
        await ctx.jobs.wait(id, 5_000, owner?.id)
      },
    }
  }
  const visible = () => ctx.waterfall('api-session/visible',
    { candidates: [{ sessionId: session.id }], signal: new AbortController().signal }, () => Promise.resolve([session.id]))
  return { ctx, central, session, agent, register, start, signIn, visible }
}
