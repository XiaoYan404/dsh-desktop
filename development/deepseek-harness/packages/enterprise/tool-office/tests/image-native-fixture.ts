/** Real Loader, central JSON/HTTP authority and employee Host; only model inference and human answers are controlled. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import Approval from '@deepseek-ai/dsh-user-approval'
import OfficeController from '@deepseek-ai/dsh-client-ui-office'
import OfficeGateway from '@deepseek-ai/dsh-enterprise-office-gateway'
import type { OfficeConversationId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { Config as OfficeConfig } from '@deepseek-ai/dsh-enterprise-office'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { onTestFinished } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { installPptxFixtureOffice, pptxAdministrator as admin, pptxEmployee as employee } from '../../office/tests/pptx-office-fixture.ts'
import * as OfficeTools from '../src/index.ts'

class ImageAdapter extends MockAdapter {
  constructor(readonly responses: StreamChunk[][], private readonly image: boolean) { super(responses) }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...await super.resolveModel(provider, model), inputModalities: this.image ? ['text', 'image'] : ['text'] }
  }
}

/**
 * Boot two isolated owned Loader contexts without changing the running preview or opening a database.
 * @param options - Distinct registration, model, review or normalized-byte scenarios.
 * @returns Actual central Office, authenticated Host, durable Native conversation and submission helpers.
 */
export async function imageNativeFixture(
  options: { image?: boolean; modelImage?: boolean; allow?: boolean; maxResultBytes?: number;
    knowledge?: boolean; deliveries?: boolean; office?: Partial<OfficeConfig> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-image-integrated-'))
  const central = new Context()
  const host = new Context()
  onTestFinished(async () => {
    const closed = await Promise.allSettled([host.fiber.dispose(), central.fiber.dispose()])
    const errors: unknown[] = []
    for (const row of closed) if (row.status === 'rejected') errors.push(row.reason)
    if (errors.length) throw new AggregateError(errors, 'Image composition cleanup did not settle')
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-image-integrated-'))
      throw new Error('Unexpected owned image integration directory')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  for (const ctx of [central, host]) {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include })
  }
  await installPptxFixtureOffice(central, join(root, 'authority'), { imageRead: {
    maxSourceBytes: 1024 * 1024, maxSourcePixels: 64 * 1024 * 1024, maxSourceDimension: 8192,
    maxResponseBytes: 2 * 1024 * 1024, mediaTypes: ['image/png'],
  }, ...options.office })
  const password = 'Owned integration identity 2026!'
  await central.office.initializeIdentity(admin, password)
  await central.office.setIdentityPassword(admin, employee, password)
  Object.assign(central.loader.builtins, { imageGateway: OfficeGateway })
  await central.loader.create({ name: 'cordis:imageGateway', config: { host: '127.0.0.1', port: 0,
    administratorId: admin, loginRequestsPerMinute: 20 } })
  await central.loader.await()
  const plugins = { llm: LlmRuntime, sessions: SessionStore, projections: SessionProjections, prompt: SystemPrompt,
    fs: FsLocal, directory: WorkingDirectory, skills: SkillRegistry, tools: ToolRuntime, agents: AgentRegistry,
    loop: AgentLoop, persistence: JsonlPersistence, attachments: LocalAttachmentStore,
    approval: Approval, credentials: MemoryCredentials, imageController: OfficeController, imageTools: OfficeTools }
  Object.assign(host.loader.builtins, plugins)
  const config: Record<string, object> = { loop: { agents: [] }, persistence: { root: join(root, 'sessions') },
    attachments: { dshHome: join(root, 'native-home') }, imageController: { gatewayUrl: central.officeGateway.address },
    imageTools: { ...(options.image === false ? {} : { image: true, imageMaxNormalizedResultBytes: options.maxResultBytes ?? 65536 }),
      ...(options.knowledge ? { knowledge: true } : {}), ...(options.deliveries ? { deliveries: true } : {}) } }
  const file = join(root, 'host.cordis.yml')
  await writeFile(file, JSON.stringify(Object.keys(plugins).map(name => ({ name: `cordis:${name}`, config: config[name] }))))
  await host.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await host.loader.await()
  const signed = await host.officeController.signIn({ memberId: employee, password })
  if (!signed.ok) throw new Error('Owned image employee did not sign in')
  const reviews: string[] = []
  host.on('approval/request', async (request) => {
    reviews.push(request.reason ?? '')
    return options.allow === false ? 'rejected' : 'allowed-once'
  })
  const script: StreamChunk[][] = []
  const adapter = new ImageAdapter(script, options.modelImage !== false)
  host.effect(() => host.llm.registerAdapter(['image-integration-fixture'], adapter))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const agent = await host.agentLoop.create(SessionId(randomUUID()), { provider: 'image-integration-fixture', model: 'fixture' }, { cwd: workspace })
  const bytes = await readFile(new URL('../../../../snapshots/session/read-image-reencode/workspace/gradient.png', import.meta.url))
  const parent = await central.office.createDriveFolder(admin, { name: 'Reviewed images', folderId: null, space: 'shared' })
  const uploaded = await central.office.uploadDriveFile(admin, { name: 'reviewed.png', space: 'shared', folderId: parent.id,
    requestId: randomUUID(), mediaType: 'image/png', byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const info = await central.office.driveFileInfo(employee, uploaded.id)
  const conversationId = String(agent.id) as OfficeConversationId
  const selection = await host.officeController.saveConversationFiles({ conversationId, revision: 0,
    requestId: randomUUID(), files: [{ id: uploaded.id, versionId: info.versionId }] })
  if (!selection.ok) throw new Error('Actual HTTP image selection did not commit')
  const run = async (name = 'office_read_image', args: object = { file_id: uploaded.id }) => {
    const contexts = await host.waterfall('api-session/prepare-context', { sessionId: agent.id,
      requestId: randomUUID() as SessionRequestId, mode: 'queue', signal: new AbortController().signal }, async () => [])
    script.push(toolCallResponse(`registered-image-${adapter.requests.length}`, name, args),
      textResponse('ACTUAL_IMAGE_RESULT_SETTLED'))
    const idle = Promise.withResolvers<undefined>()
    const stop = host.on('agent/status', ({ agent: current, status }) => {
      if (current === agent && status === 'idle') { stop(); idle.resolve(undefined) }
    })
    onTestFinished(() => { stop() })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read this submitted image.' }],
      source: { kind: 'user', preparedContexts: contexts } }))
    await idle.promise
    await host.sessionPersistence.flush()
    const reader = await host.sessionPersistence.open(agent.id, 'read')
    try { return (await reader.read()).events } finally { await reader.close() }
  }
  return { central, host, root, agent, adapter, reviews, bytes, info, parent, run }
}
