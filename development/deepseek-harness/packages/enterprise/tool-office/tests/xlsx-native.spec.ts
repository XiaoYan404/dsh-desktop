/** Real spreadsheet bytes traverse Loader services, scoped approval, current authority and the durable native model log. */
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
import type { OfficeConversationId, OfficeConversationXlsxRead } from '@deepseek-ai/dsh-enterprise-office/types'
import { expect, it, onTestFinished } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { installDocxFixtureOffice, docxAdministrator, docxEmployee } from '../../office/tests/docx-office-fixture.ts'
import { submittedXlsxAmount, submittedXlsxFixture } from '../../office/tests/xlsx-fixture.ts'
import { automationEvents } from './fixtures/automation-context.ts'
import * as OfficeTools from '../src/index.ts'

async function fixture(readApproval: 'manual' | 'automatic' = 'automatic') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-xlsx-native-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-xlsx-native-'))
      throw new Error('Unexpected spreadsheet native fixture directory')
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
  Object.assign(ctx.loader.builtins, { include: Include, ...plugins, xlsxController: OfficePlugin, xlsxTools: OfficeTools })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  await installDocxFixtureOffice(ctx, join(root, 'authority'))
  await ctx.loader.create({ name: 'cordis:xlsxController', config: { principalId: docxEmployee } })
  await ctx.loader.create({ name: 'cordis:xlsxTools', config: { readApproval } })
  await ctx.loader.await()
  const parent = await ctx.office.createDriveFolder(docxAdministrator, { name: 'Reviewed spreadsheets', folderId: null, space: 'shared' })
  const bytes = submittedXlsxFixture()
  const file = await ctx.office.uploadDriveFile(docxAdministrator, { name: 'reviewed.xlsx', space: 'shared', folderId: parent.id,
    requestId: randomUUID(), mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const info = await ctx.office.driveFileInfo(docxEmployee, file.id)
  const adapter = new MockAdapter([toolCallResponse('submitted-spreadsheet-read', 'office_read_xlsx', {
    file_id: file.id, sheet_number: 1, offset: 0, max_cells: 256 }), textResponse('XLSX_NATIVE_READ_FINISHED')])
  ctx.effect(() => ctx.llm.registerAdapter(['xlsx-fixture'], adapter))
  const agent = await ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'xlsx-fixture', model: 'fixture' }, { cwd })
  const conversationId = String(agent.id) as OfficeConversationId
  await ctx.office.saveConversationFiles(docxEmployee, { conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const contexts = await ctx.waterfall('api-session/prepare-context', { sessionId: agent.id, mode: 'queue',
    requestId: randomUUID() as SessionRequestId, signal: new AbortController().signal }, async () => [])
  const run = async () => {
    const idle = new Promise<void>((done) => {
      const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { stop(); done() }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the submitted saved spreadsheet values.' }],
      source: { kind: 'user', preparedContexts: contexts } }))
    await idle
    const events = await automationEvents(ctx, agent)
    const result = events.find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Submitted spreadsheet call did not settle in the original log')
    return result
  }
  return { ctx, agent, adapter, file, info, parent, bytes, run }
}

it.each(['authorized', 'acl', 'role', 'version'] as const)(
  'runs actual XLSX reading through the native model and log with current authority (%s)', async (action) => {
    const { ctx, agent, adapter, file, info, parent, bytes, run } = await fixture()
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'office_read_xlsx') {
        if (action === 'acl') await ctx.office.saveDrivePermissions(docxAdministrator,
          { id: parent.id, revision: parent.revision, defaultAccess: 'deny', grants: [] })
        else if (action === 'role') {
          const member = ctx.office.view(docxAdministrator).members.find(row => row.id === docxEmployee)!
          await ctx.office.saveMember(docxAdministrator, { ...member, role: 'manager' }, member)
        } else if (action === 'version') {
          const replacement = submittedXlsxFixture({ date1904: true })
          const sha256 = createHash('sha256').update(replacement).digest('hex')
          const upload = await ctx.office.beginDriveUpload(docxAdministrator, { name: file.name, space: 'shared', folderId: parent.id,
            requestId: randomUUID(), mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            byteLength: replacement.length, sha256, target: { id: file.id, revision: file.revision } })
          await ctx.office.appendDriveUpload(docxAdministrator, { uploadId: upload.id, index: 0,
            sha256, dataBase64: replacement.toString('base64') })
          await ctx.office.completeDriveUpload(docxAdministrator, upload.id)
        }
      }
      return next()
    }, { prepend: true })
    const result = await run()
    expect(result.data.message.isError).toBe(action !== 'authorized')
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_xlsx')
    if (action === 'authorized') {
      const block = result.data.message.content.find(block => block.type === 'text')
      if (block?.type !== 'text') throw new Error('Actual spreadsheet saved values are absent')
      const parsed = JSON.parse(block.text) as OfficeConversationXlsxRead
      expect(parsed.file).toMatchObject({ id: file.id, versionId: info.versionId, sha256: createHash('sha256').update(bytes).digest('hex') })
      expect(parsed.cells.find(cell => cell.address === 'B1')?.value).toBe(submittedXlsxAmount)
      const normalized = parsed.cells.map(cell => [cell.address, cell.kind, JSON.stringify(cell.value),
        JSON.stringify(cell.rawValue), cell.cacheState].join(' | ')).join('\n') + '\n'
      expect(normalized).toBe(await readFile(new URL('./expected/xlsx-read.expected.md', import.meta.url), 'utf8'))
      expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
    } else expect(JSON.stringify(result.data.message.content)).not.toContain(submittedXlsxAmount)
    expect(ctx.tools.get('office_read_xlsx', agent)).toBeUndefined()
    expect(ctx.tools.get('read', agent)).toBeDefined()
  },
)

it('requires exact bilingual native approval before reading submitted spreadsheet cells', async () => {
  const { ctx, file, info, run } = await fixture('manual')
  const reviews: { reason?: string; displayReason?: Readonly<Record<string, string>> }[] = []
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (exec.name === 'office_read_xlsx' && decision.kind === 'ask') reviews.push(decision)
    return decision
  }, { prepend: true })
  const result = await run()
  expect(reviews).toHaveLength(1)
  expect(reviews[0]?.reason).toBe('Read submitted company spreadsheet\nFile: "reviewed.xlsx"\n'
    + `File id: ${JSON.stringify(file.id)}\nVersion: ${JSON.stringify(info.versionId)}\nSHA-256: ${info.sha256}\n`
    + 'Sheet number: 1\nStored-cell offset: 0\nCell budget: 256\nEmployee: "docx-employee"')
  expect(reviews[0]?.displayReason?.zh).toBe('读取已提交的公司电子表格\n文件："reviewed.xlsx"\n'
    + `文件标识：${JSON.stringify(file.id)}\n版本：${JSON.stringify(info.versionId)}\nSHA-256：${info.sha256}\n`
    + '工作表序号：1\n已存单元格偏移：0\n单元格预算：256\n员工："docx-employee"')
  expect(result.data.message.isError).toBe(true)
  expect(JSON.stringify(result.data.message.content)).not.toContain(submittedXlsxAmount)
})
