/** Real Loader/AgentLoop/JSON persistence and actual PPTX workers; only the model's responses are scripted. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import OfficePlugin from '@deepseek-ai/dsh-client-ui-office'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { OfficeConversationId } from '@deepseek-ai/dsh-enterprise-office/types'
import { expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { installPptxFixtureOffice, pptxAdministrator, pptxEmployee,
  pptxTestPolicy, submitPptxFixture } from '../../office/tests/pptx-office-fixture.ts'
import { pptxFixtureParts, replacePptxPart, submittedPptxFixture } from '../../office/tests/pptx-fixture.ts'
import * as OfficeTools from '../src/index.ts'

interface FixtureOptions {
  readonly readApproval?: 'manual' | 'automatic'
  readonly pptx?: boolean
  readonly authority?: boolean
  readonly section?: 'slide' | 'notes'
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pptx-native-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-pptx-native-'))
      throw new Error('Unexpected presentation native fixture directory')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const plugins = { llm: LlmRuntime, sessions: SessionStore, projections: SessionProjections, prompt: SystemPrompt,
    fs: FsLocal, directory: WorkingDirectory, tools: ToolRuntime, agents: AgentRegistry, loop: AgentLoop,
    persistence: JsonlPersistence, skills: SkillRegistry, toolFs: ToolFs }
  const config: Record<string, object> = { loop: { agents: [] }, persistence: { root: join(root, 'sessions') } }
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify(Object.keys(plugins).map(name => ({ name: `cordis:${name}`, config: config[name] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, ...plugins, pptxController: OfficePlugin, pptxTools: OfficeTools })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  await installPptxFixtureOffice(ctx, join(root, 'authority'),
    options.authority === false ? {} : { conversationPptx: pptxTestPolicy })
  await ctx.loader.create({ name: 'cordis:pptxController', config: { principalId: pptxEmployee } })
  await ctx.loader.create({ name: 'cordis:pptxTools', config: { readApproval: options.readApproval ?? 'automatic',
    ...(options.pptx === false ? {} : { pptx: true }) } })
  await ctx.loader.await()
  const script: ConstructorParameters<typeof MockAdapter>[0] = []
  const adapter = new MockAdapter(script)
  ctx.effect(() => ctx.llm.registerAdapter(['pptx-fixture'], adapter))
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'pptx-fixture', model: 'fixture' }, { cwd })
  const submitted = await submitPptxFixture(ctx, String(agent.id) as OfficeConversationId)
  script.push(toolCallResponse('submitted-presentation-read', 'office_read_pptx', {
    file_id: submitted.file.id, slide_number: 1, section: options.section ?? 'slide', offset: 0, max_characters: 16384 }),
  textResponse('PPTX_NATIVE_READ_FINISHED'))
  const contexts = await ctx.waterfall('api-session/prepare-context', { sessionId: agent.id,
    requestId: randomUUID() as SessionRequestId, mode: 'queue', signal: new AbortController().signal }, async () => [])
  return { ctx, root, agent, adapter, contexts, ...submitted }
}

async function run(subject: Awaited<ReturnType<typeof fixture>>) {
  const { ctx, agent, contexts } = subject
  const idle = new Promise<void>((done) => {
    const stop = ctx.on('agent/status', ({ agent: current, status }) => {
      if (current === agent && status === 'idle') { stop(); done() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the explicitly selected presentation section.' }],
    source: { kind: 'user', preparedContexts: contexts } }))
  await idle
  await ctx.sessionPersistence.flush()
  const reader = await ctx.sessionPersistence.open(agent.id, 'read')
  try {
    const result = (await reader.read()).events.find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Presentation tool call did not settle in the original durable log')
    return result
  } finally { await reader.close() }
}

it.each(['slide', 'notes', 'acl', 'role', 'version'] as const)(
  'runs real submitted PPTX through the approved native BFF and durable model log (%s)', async (action) => {
    const subject = await fixture({ section: action === 'notes' ? 'notes' : 'slide' })
    const { ctx, agent, adapter, file, info, parent, bytes } = subject
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'office_read_pptx') {
        if (action === 'acl') await ctx.office.saveDrivePermissions(pptxAdministrator,
          { id: parent.id, revision: parent.revision, defaultAccess: 'deny', grants: [] })
        else if (action === 'role') {
          const member = ctx.office.view(pptxAdministrator).members.find(row => row.id === pptxEmployee)
          if (!member) throw new Error('Missing real presentation employee')
          await ctx.office.saveMember(pptxAdministrator, { ...member, role: 'manager' }, member)
        } else if (action === 'version') {
          const parts = pptxFixtureParts()
          replacePptxPart(parts, 'ppt/slides/slide2.xml', source => source.replace('第二页🙂', 'Replacement presentation content'))
          const replacement = Buffer.from(submittedPptxFixture(parts))
          const sha256 = createHash('sha256').update(replacement).digest('hex')
          const upload = await ctx.office.beginDriveUpload(pptxAdministrator, { name: file.name, space: 'shared', folderId: parent.id,
            requestId: randomUUID(), mediaType: file.mediaType, byteLength: replacement.length, sha256,
            target: { id: file.id, revision: file.revision } })
          await ctx.office.appendDriveUpload(pptxAdministrator, { uploadId: upload.id, index: 0,
            sha256, dataBase64: replacement.toString('base64') })
          await ctx.office.completeDriveUpload(pptxAdministrator, upload.id)
        }
      }
      return next()
    }, { prepend: true })
    const result = await run(subject)
    expect(result.data.message.isError).toBe(!['slide', 'notes'].includes(action))
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_pptx')
    const content = JSON.stringify(result.data.message.content)
    if (action === 'slide' || action === 'notes') {
      expect(content).toContain(action === 'slide' ? '第二页🙂' : '演讲者备注')
      expect(content).not.toContain(action === 'slide' ? '演讲者备注' : '第二页🙂')
      expect(content).toContain(info.versionId)
      expect(content).toContain(createHash('sha256').update(bytes).digest('hex'))
      expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
    } else expect(content).not.toMatch(/第二页|演讲者备注|Replacement presentation content/u)
    expect(ctx.tools.get('office_read_pptx', agent)).toBeUndefined()
    expect(ctx.tools.get('read', agent)).toBeDefined()
  },
)

it('requires native manual PPTX review with immutable slide and explicit notes before exposing any body', async () => {
  const subject = await fixture({ readApproval: 'manual', section: 'notes' })
  const reviews: { reason?: string; displayReason?: Readonly<Record<string, string>> }[] = []
  subject.ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (exec.name === 'office_read_pptx' && decision.kind === 'ask') reviews.push(decision)
    return decision
  }, { prepend: true })
  const result = await run(subject)
  expect(reviews).toHaveLength(1)
  expect(reviews[0]?.reason).toBe('Read submitted company presentation\nFile: "reviewed.pptx"\n'
    + `File id: ${JSON.stringify(subject.file.id)}\nVersion: ${JSON.stringify(subject.info.versionId)}\nSHA-256: ${subject.info.sha256}\n`
    + 'Slide number: 1\nSection: notes\nOffset: 0\nCharacter budget: 16384\nEmployee: "pptx-employee"')
  expect(reviews[0]?.displayReason?.zh).toContain('幻灯片序号：1\n内容部分：演讲者备注\n起始位置：0')
  expect(result.data.message.isError).toBe(true)
  expect(JSON.stringify(result.data.message.content)).not.toMatch(/第二页|追加说明/u)
})

it('keeps the legacy native file tool set when the PPTX consumer switch is omitted', async () => {
  const subject = await fixture({ pptx: false })
  const result = await run(subject)
  const names = subject.adapter.requests[0]?.tools?.map(tool => tool.name)
  expect(names).toEqual(expect.arrayContaining(['office_read_file', 'office_read_pdf', 'office_read_docx', 'office_read_xlsx', 'read']))
  expect(names).not.toContain('office_read_pptx')
  expect(result.data.message.isError).toBe(true)
  expect(JSON.stringify(result.data.message.content)).not.toMatch(/第二页|演讲者备注/u)
})

it('withholds PPTX body when only the native consumer is enabled and the real authority remains disabled', async () => {
  const subject = await fixture({ authority: false })
  const result = await run(subject)
  expect(subject.adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_pptx')
  expect(result.data.message.isError).toBe(true)
  expect(JSON.stringify(result.data.message.content)).not.toMatch(/第二页|演讲者备注/u)
})
