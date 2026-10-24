/** Real PDF reference selection, native read approval, binary extraction and durable model-visible results. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { OfficeConversationId, OfficeConversationPdfRead, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { submittedPdfFixture } from '../../../packages/enterprise/office/tests/pdf-fixture.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, writeComposerDraft } from './support.ts'

const actor = 'local' as OfficeMemberId
const owner = 'owner' as OfficeMemberId
const provider = 'office-pdf-fixture'
const reply = 'PDF_NATIVE_TURN_FINISHED'

class PdfAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly fileId: string) { super() }
  override async listModels(name: string) { return [{ provider: name, id: 'pdf-text', name: 'Submitted PDF fixture' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.messages.at(-1)?.role !== 'tool') {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`pdf-read-${this.requests.length}`),
        name: 'office_read_pdf', arguments: JSON.stringify({ file_id: this.fileId, page_number: 2, offset: 0, max_characters: 16384 }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('selects a real PDF through Drive, records its approved page in the native log and refuses a revoked reread', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [] },
    extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const parent = await scaffold.ctx.office.createDriveFolder(owner, { space: 'shared', folderId: null, name: 'PDF reference folder' })
  const bytes = submittedPdfFixture()
  const file = await scaffold.ctx.office.uploadDriveFile(owner, { space: 'shared', folderId: parent.id,
    name: 'reviewed-binary.pdf', mediaType: 'application/pdf', byteLength: bytes.length,
    dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await scaffold.ctx.office.driveFileInfo(actor, file.id)
  const adapter = new PdfAdapter(file.id)
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'pdf-text' })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  if (!current.sessionId) throw new Error('Expected the original native PDF input')
  const conversationId = current.sessionId as OfficeConversationId
  const associations = page.getByRole('region', { name: 'Conversation files', exact: true })
  await associations.getByRole('button', { name: 'Link files', exact: true }).click()
  const drive = page.getByRole('region', { name: 'Drive', exact: true })
  await drive.getByRole('button', { name: 'Shared drive', exact: true }).first().click()
  await drive.locator(`[data-drive-entry="${parent.id}"]`).dblclick()
  await drive.locator(`[data-drive-entry="${file.id}"]`).click()
  await drive.getByRole('button', { name: 'Use in AI chat', exact: true }).click()
  await associations.getByText(file.name, { exact: true }).waitFor()
  const selection = await scaffold.ctx.office.conversationFiles(actor, conversationId)
  expect(selection.files[0]).toMatchObject({ id: file.id, versionId: info.versionId })
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Read the second page of the submitted PDF.')
  await input.press('Enter')
  const approval = page.locator('[data-approval-key]')
  await approval.waitFor()
  expect(await approval.innerText()).toContain('Read submitted company PDF')
  expect(await approval.innerText()).toContain('Page: 2')
  const settled = scaffold.whenTurnSettled()
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
  const id = await settled
  const firstEvents = await readPersistedEvents(scaffold, id)
  const result = firstEvents.find(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Missing original native PDF tool result')
  expect(result.data.message.isError).toBe(false)
  const text = result.data.message.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('PDF tool result has no actual text')
  const parsed = JSON.parse(text.text) as OfficeConversationPdfRead
  expect(parsed.file).toMatchObject({ id: file.id, versionId: info.versionId, sha256: info.sha256, byteLength: bytes.length })
  const { file: _file, ...pageResult } = parsed
  expect(`${JSON.stringify(pageResult, null, 2)}\n`).toBe(await readFile(new URL('./expected/office-pdf/pdf-read.expected.md', import.meta.url), 'utf8'))
  expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
  expect(result.data.message.content.every(block => block.type === 'text')).toBe(true)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_file')
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_pdf')
  await writeComposerDraft(page, input, 'Read the same submitted PDF page again.')
  await input.press('Enter')
  await approval.waitFor()
  await scaffold.ctx.office.saveDrivePermissions(owner, { id: parent.id, revision: parent.revision, defaultAccess: 'deny', grants: [] })
  const refused = scaffold.whenTurnSettled()
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
  await refused
  const events = await readPersistedEvents(scaffold, id)
  const denied = events.findLast(event => event.type === 'tool/result')
  if (denied?.type !== 'tool/result') throw new Error('Missing original native PDF denial')
  expect(denied.data.message.isError).toBe(true)
  expect(JSON.stringify(denied.data)).toContain('OFFICE_PDF_READ_DENIED')
  expect(JSON.stringify(denied.data.message.content)).not.toContain('Actual binary PDF page two')
  expect(adapter.requests[3]?.messages.at(-1)?.content).toEqual(denied.data.message.content)
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
