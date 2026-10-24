/** Browser-uploaded spreadsheet bytes reach the original Native conversation, approval, log and next model request. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { z } from 'zod'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeConversationId, OfficeConversationXlsxRead, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { submittedXlsxAmount, submittedXlsxFixture } from '../../../packages/enterprise/office/tests/xlsx-fixture.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import {
  connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, REPO_ROOT, saveFailureShot, writeComposerDraft,
} from './support.ts'

const actor = 'local' as OfficeMemberId
const provider = 'office-xlsx-browser-fixture'
const callId = ToolCallId('submitted-xlsx-read')
const replyPrefix = 'XLSX_NATIVE_SAVED_B1='

class XlsxAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly fileId: string) { super() }
  override async listModels(name: string) { return [{ provider: name, id: 'saved-cells', name: 'Submitted XLSX fixture' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId,
        name: 'office_read_xlsx', arguments: JSON.stringify({ file_id: this.fileId, sheet_number: 1, offset: 0, max_cells: 256 }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const result = options.messages.at(-1)
    if (result?.role !== 'tool' || result.isError) throw new Error('Expected the actual successful XLSX tool result')
    const block = result.content.find(block => block.type === 'text')
    if (block?.type !== 'text') throw new Error('Actual XLSX result has no saved cells')
    const parsed = JSON.parse(block.text) as OfficeConversationXlsxRead
    const amount = parsed.cells.find(cell => cell.address === 'B1')?.value
    if (typeof amount !== 'string') throw new Error('Actual XLSX result has no saved B1 value')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: replyPrefix + amount } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('uploads an XLSX through Drive and reads its exact saved cells in the original Native conversation', async () => {
  const scaffold = await launchWebScaffold({ profile: { packages: [] },
    extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-xlsx'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  if (!current.sessionId) throw new Error('Expected the original Native spreadsheet conversation')
  const nativeId = SessionId(current.sessionId)
  const conversationId = current.sessionId as OfficeConversationId
  const associations = page.getByRole('region', { name: 'Conversation files', exact: true })
  await associations.getByRole('button', { name: 'Link files', exact: true }).click()
  const drive = page.getByRole('region', { name: 'Drive', exact: true })
  await drive.getByRole('button', { name: 'Private drive', exact: true }).first().click()
  const bytes = submittedXlsxFixture()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const name = 'native-reviewed.xlsx'
  const mediaType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  await drive.locator('input[type=file][aria-label="Upload file"]').setInputFiles({ name, mimeType: mediaType, buffer: bytes })
  const upload = page.getByRole('dialog', { name: 'Upload file', exact: true })
  await upload.getByRole('button', { name: 'Upload file', exact: true }).click()
  await upload.waitFor({ state: 'hidden' })
  await drive.getByText('Upload complete', { exact: true }).waitFor()
  const matches = scaffold.ctx.office.drive(actor, { space: 'private', folderId: null, search: '' }).entries
    .filter(entry => entry.kind === 'file' && entry.name === name)
  expect(matches).toHaveLength(1)
  const file = matches[0]!
  const info = await scaffold.ctx.office.driveFileInfo(actor, file.id)
  expect(info).toMatchObject({ byteLength: bytes.length, sha256, mediaType })
  await drive.locator(`[data-drive-entry="${file.id}"]`).click()
  await drive.getByRole('button', { name: 'Use in AI chat', exact: true }).click()
  await associations.getByText(name, { exact: true }).waitFor()
  const selected = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  expect(selected.sessionId).toBe(current.sessionId)
  const selection = await scaffold.ctx.office.conversationFiles(actor, conversationId)
  expect(selection.files.map(row => ({ id: row.id, versionId: row.versionId }))).toEqual([{ id: file.id, versionId: info.versionId }])
  const adapter = new XlsxAdapter(file.id)
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'saved-cells' })
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Read the submitted spreadsheet and report the exact saved amount in B1 without recalculating formulas.')
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const approval = page.locator('[data-approval-key]')
  await approval.waitFor()
  const review = await approval.innerText()
  for (const detail of ['Read submitted company spreadsheet', `File: ${JSON.stringify(name)}`,
    `File id: ${JSON.stringify(file.id)}`, `Version: ${JSON.stringify(info.versionId)}`, `SHA-256: ${sha256}`,
    'Sheet number: 1', 'Stored-cell offset: 0', 'Cell budget: 256', 'Employee: "local"']) expect(review).toContain(detail)
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_xlsx')
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
  expect(await settled).toBe(nativeId)
  await page.getByText(replyPrefix + submittedXlsxAmount, { exact: true }).waitFor()
  const events = await readPersistedEvents(scaffold, nativeId)
  const calls = events.filter(event => event.type === 'tool/call')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.data).toMatchObject({ callId, name: 'office_read_xlsx' })
  expect(JSON.parse(calls[0]!.data.arguments)).toEqual({ file_id: file.id, sheet_number: 1, offset: 0, max_cells: 256 })
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(1)
  const result = results[0]!
  expect(result.data.message).toMatchObject({ toolCallId: callId, isError: false })
  expect(result.data.message.content.every(block => block.type === 'text')).toBe(true)
  const text = result.data.message.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Original Native log has no actual XLSX saved cells')
  const parsed = JSON.parse(text.text) as OfficeConversationXlsxRead
  expect(parsed.file).toMatchObject({ id: file.id, versionId: info.versionId, sha256, byteLength: bytes.length, name, mediaType })
  expect(parsed).toMatchObject({ sheetNumber: 1, dateSystem: '1900', offset: 0, nextOffset: 12, totalCells: 12, eof: true })
  expect(parsed.sheets.map(sheet => ({ number: sheet.number, state: sheet.state, storedCells: sheet.storedCells })))
    .toEqual([{ number: 1, state: 'visible', storedCells: 12 }, { number: 2, state: 'veryHidden', storedCells: 1 }])
  expect(parsed.cells.find(cell => cell.address === 'B1')).toMatchObject({ kind: 'number', value: submittedXlsxAmount,
    rawValue: submittedXlsxAmount, hiddenColumn: true, cacheState: 'not_formula' })
  expect(parsed.cells.find(cell => cell.address === 'A2')).toMatchObject({ value: '0', rawValue: '0', hiddenRow: true,
    formula: { text: '1-1' }, cacheState: 'present_may_be_stale' })
  expect(parsed.cells.find(cell => cell.address === 'C2')).toMatchObject({ value: null, rawValue: null,
    formula: { text: 'WEBSERVICE("https://127.0.0.1:1/DO_NOT_FETCH")' }, cacheState: 'missing' })
  const user = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
  if (user?.type !== 'user/message' || user.data.source.kind !== 'user')
    throw new Error('Original Native input has no durable submitted file context')
  const capturedSource = z.object({ kind: z.literal('user'), preparedContexts: z.array(z.object({
    source: z.object({ kind: z.string(), capture: z.unknown().optional() }),
  })) }).parse(user.data.source)
  const submitted = capturedSource.preparedContexts.find(context => context.source.kind === 'office-files')
  expect(submitted?.source).toMatchObject({ kind: 'office-files', capture: { memberId: actor,
    selection: { conversationId, files: [{ id: file.id, versionId: info.versionId, sha256 }] } } })
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
  expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  const card = page.locator(`[data-chat-call-id="${callId}"] [data-tool="office_read_xlsx"]`)
  await expandOwningTurnProcess(page, card)
  await card.waitFor({ state: 'visible' })
  expect(await card.getAttribute('data-state')).toBe('ok')
  expect(await card.innerText()).toContain('office_read_xlsx')
  await card.getByRole('button', { expanded: false }).first().click()
  await expect.poll(() => card.innerText()).toContain(submittedXlsxAmount)
  await page.screenshot({ path: join(REPO_ROOT, '.artifacts/enterprise-office/xlsx-browser/xlsx-native-result.png'),
    fullPage: true, animations: 'disabled' })
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})
