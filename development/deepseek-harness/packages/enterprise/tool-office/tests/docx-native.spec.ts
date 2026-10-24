/** Actual DOCX bytes pass real Loader services, scoped native tools, authorization and durable model history. */
import { createHash, randomUUID } from 'node:crypto'
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
import { installDocxFixtureOffice, docxAdministrator, docxEmployee } from '../../office/tests/docx-office-fixture.ts'
import { submittedDocxFixture, submittedDocxText } from '../../office/tests/docx-fixture.ts'
import { automationEvents } from './fixtures/automation-context.ts'
import * as OfficeTools from '../src/index.ts'

async function fixture(readApproval: 'manual' | 'automatic' = 'automatic') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-docx-native-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-docx-native-'))
      throw new Error('Unexpected DOCX native fixture directory')
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
  Object.assign(ctx.loader.builtins, { include: Include, ...plugins, docxController: OfficePlugin, docxTools: OfficeTools })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  await installDocxFixtureOffice(ctx, join(root, 'authority'))
  await ctx.loader.create({ name: 'cordis:docxController', config: { principalId: docxEmployee } })
  await ctx.loader.create({ name: 'cordis:docxTools', config: { readApproval } })
  await ctx.loader.await()
  const parent = await ctx.office.createDriveFolder(docxAdministrator, { name: 'Reviewed Word files', folderId: null, space: 'shared' })
  const bytes = submittedDocxFixture()
  const file = await ctx.office.uploadDriveFile(docxAdministrator, { name: 'reviewed.docx', space: 'shared', folderId: parent.id,
    requestId: randomUUID(), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const info = await ctx.office.driveFileInfo(docxEmployee, file.id)
  const adapter = new MockAdapter([toolCallResponse('submitted-word-read', 'office_read_docx', {
    file_id: file.id, offset: 0, max_characters: 16384 }), textResponse('DOCX_NATIVE_READ_FINISHED')])
  ctx.effect(() => ctx.llm.registerAdapter(['docx-fixture'], adapter))
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'docx-fixture', model: 'fixture' }, { cwd })
  const conversationId = String(agent.id) as OfficeConversationId
  await ctx.office.saveConversationFiles(docxEmployee, { conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const contexts = await ctx.waterfall('api-session/prepare-context', { sessionId: agent.id,
    requestId: randomUUID() as SessionRequestId, mode: 'queue', signal: new AbortController().signal }, async () => [])
  return { ctx, root, agent, adapter, file, info, parent, bytes, contexts }
}

it.each(['authorized', 'acl', 'role', 'version'] as const)(
  'runs submitted DOCX reading through the native log with current authority (%s)', async (action) => {
    const { ctx, agent, adapter, file, info, parent, bytes, contexts } = await fixture()
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'office_read_docx') {
        if (action === 'acl') await ctx.office.saveDrivePermissions(docxAdministrator,
          { id: parent.id, revision: parent.revision, defaultAccess: 'deny', grants: [] })
        else if (action === 'role') {
          const member = ctx.office.view(docxAdministrator).members.find(row => row.id === docxEmployee)!
          await ctx.office.saveMember(docxAdministrator, { ...member, role: 'manager' }, member)
        } else if (action === 'version') {
          const replacement = submittedDocxFixture({ document: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>Replacement Word content</w:t></w:r></w:p></w:body></w:document>` })
          const sha256 = createHash('sha256').update(replacement).digest('hex')
          const upload = await ctx.office.beginDriveUpload(docxAdministrator, { name: file.name, space: 'shared', folderId: parent.id,
            requestId: randomUUID(), mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            byteLength: replacement.length, sha256,
            target: { id: file.id, revision: file.revision } })
          await ctx.office.appendDriveUpload(docxAdministrator, { uploadId: upload.id, index: 0,
            sha256, dataBase64: replacement.toString('base64') })
          await ctx.office.completeDriveUpload(docxAdministrator, upload.id)
        }
      }
      return next()
    }, { prepend: true })
    const idle = new Promise<void>((done) => {
      const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { stop(); done() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the submitted Word paragraphs and table.' }],
      source: { kind: 'user', preparedContexts: contexts } }))
    await idle
    const events = await automationEvents(ctx, agent)
    const result = events.find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Submitted Word call did not settle in the original log')
    expect(result.data.message.isError).toBe(action !== 'authorized')
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_docx')
    if (action === 'authorized') {
      const text = result.data.message.content.find(block => block.type === 'text')
      if (text?.type !== 'text') throw new Error('Actual DOCX text is absent')
      const parsed = JSON.parse(text.text) as {
        text: string
        paragraphCount: number
        tableCount: number
        file: { id: string; versionId: string; sha256: string }
      }
      expect(parsed.file).toMatchObject({ id: file.id, versionId: info.versionId, sha256: createHash('sha256').update(bytes).digest('hex') })
      expect(parsed.text).toBe(submittedDocxText)
      expect(parsed.paragraphCount).toBe(7)
      expect(parsed.tableCount).toBe(1)
      expect(parsed.text + '\n').toBe(await readFile(new URL('./expected/docx-read.expected.md', import.meta.url), 'utf8'))
      expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
    } else {
      expect(JSON.stringify(result.data.message.content)).not.toContain(submittedDocxText)
      expect(JSON.stringify(result.data.message.content)).not.toContain('Replacement Word content')
    }
    expect(ctx.tools.get('office_read_docx', agent)).toBeUndefined()
    expect(ctx.tools.get('read', agent)).toBeDefined()
  },
)

it('requires the native manual DOCX review before exposing the submitted body', async () => {
  const { ctx, agent, file, info, contexts } = await fixture('manual')
  const reviews: { reason?: string; displayReason?: Readonly<Record<string, string>> }[] = []
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (exec.name === 'office_read_docx' && decision.kind === 'ask') reviews.push(decision)
    return decision
  }, { prepend: true })
  const idle = new Promise<void>((done) => {
    const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { stop(); done() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review this submitted Word before reading.' }],
    source: { kind: 'user', preparedContexts: contexts } }))
  await idle
  expect(reviews).toHaveLength(1)
  expect(reviews[0]?.reason).toBe('Read submitted company Word document\nFile: "reviewed.docx"\n'
    + `File id: ${JSON.stringify(file.id)}\nVersion: ${JSON.stringify(info.versionId)}\nSHA-256: ${info.sha256}\n`
    + 'Offset: 0\nCharacter budget: 16384\nEmployee: "docx-employee"')
  expect(reviews[0]?.displayReason?.zh).toBe('读取已提交的公司 Word 文档\n文件："reviewed.docx"\n'
    + `文件标识：${JSON.stringify(file.id)}\n版本：${JSON.stringify(info.versionId)}\nSHA-256：${info.sha256}\n`
    + '起始位置：0\n字符预算：16384\n员工："docx-employee"')
  const events = await automationEvents(ctx, agent)
  const result = events.find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Unapproved Word call did not settle in the original log')
  expect(result.data.message.isError).toBe(true)
  expect(JSON.stringify(result.data.message.content)).not.toContain(submittedDocxText)
})
