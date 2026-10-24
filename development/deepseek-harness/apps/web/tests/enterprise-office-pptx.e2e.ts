/** Real uploaded presentation text reaches a manually approved Native tool, Session log and next model request. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeConversationId, OfficeConversationPptxRead, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { submittedPptxFixture } from '../../../packages/enterprise/office/tests/pptx-fixture.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, REPO_ROOT,
  saveFailureShot, writeComposerDraft } from './support.ts'

const actor = 'local' as OfficeMemberId
const provider = 'office-pptx-browser-fixture'
const callId = ToolCallId('submitted-pptx-slide-read')
const body = '第二页🙂\n组合中文\n换行\nA1\tB1\nA2\tB2'
const answer = 'PPTX_NATIVE_RELATIONSHIP_ORDER=' + body

class PptxAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly fileId: string) { super() }
  override async listModels(name: string) { return [{ provider: name, id: 'saved-slide', name: 'Submitted PPTX fixture' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'office_read_pptx',
        arguments: JSON.stringify({ file_id: this.fileId, slide_number: 1, section: 'slide', offset: 0, max_characters: 16384 }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const result = options.messages.at(-1)
    if (result?.role !== 'tool' || result.isError) throw new Error('Expected the actual successful PPTX tool result')
    const block = result.content.find(block => block.type === 'text')
    if (block?.type !== 'text') throw new Error('Actual PPTX result has no saved slide text')
    const parsed = JSON.parse(block.text) as OfficeConversationPptxRead
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PPTX_NATIVE_RELATIONSHIP_ORDER=' + parsed.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('uploads an advertised PPTX and reads its relationship-ordered slide through the original approved Native conversation', async () => {
  const artifactRoot = join(REPO_ROOT, '.artifacts/enterprise-office/round162-pptx/browser')
  await mkdir(artifactRoot, { recursive: true })
  const scaffold = await launchWebScaffold({ profile: { packages: [] },
    extraOverlayPath: join(REPO_ROOT, 'enterprise-workbench.patch.yml') })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-pptx'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  if (!current.sessionId) throw new Error('Expected the original Native presentation conversation')
  const nativeId = SessionId(current.sessionId)
  const conversationId = current.sessionId as OfficeConversationId
  const associations = page.getByRole('region', { name: 'Conversation files', exact: true })
  await associations.getByRole('button', { name: 'Link files', exact: true }).click()
  const drive = page.getByRole('region', { name: 'Drive', exact: true })
  await drive.getByRole('button', { name: 'Private drive', exact: true }).first().click()
  const bytes = Buffer.from(submittedPptxFixture())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const name = 'native-reviewed.pptx'
  const mediaType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
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
  const selection = await scaffold.ctx.office.conversationFiles(actor, conversationId)
  expect(selection.files.map(row => ({ id: row.id, versionId: row.versionId }))).toEqual([{ id: file.id, versionId: info.versionId }])
  const selected = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  expect(selected.sessionId).toBe(current.sessionId)
  const adapter = new PptxAdapter(file.id)
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'saved-slide' })
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Read slide 1 of the submitted presentation. Report its saved text, without reading speaker notes.')
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const approval = page.locator('[data-approval-key]')
  await approval.waitFor()
  const review = await approval.innerText()
  for (const detail of ['Read submitted company presentation', `File: ${JSON.stringify(name)}`,
    `File id: ${JSON.stringify(file.id)}`, `Version: ${JSON.stringify(info.versionId)}`, `SHA-256: ${sha256}`,
    'Slide number: 1', 'Section: slide', 'Offset: 0', 'Character budget: 16384', 'Employee: "local"']) expect(review).toContain(detail)
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_pptx')
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
  expect(await settled).toBe(nativeId)
  await page.getByText(/PPTX_NATIVE_RELATIONSHIP_ORDER=/u).last().waitFor({ state: 'visible' })
  const events = await readPersistedEvents(scaffold, nativeId)
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.data).toMatchObject({ callId, name: 'office_read_pptx' })
  expect(JSON.parse(calls[0]!.data.arguments)).toEqual({ file_id: file.id, slide_number: 1, section: 'slide', offset: 0, max_characters: 16384 })
  expect(results).toHaveLength(1)
  const result = results[0]!
  expect(result.data.message).toMatchObject({ toolCallId: callId, isError: false })
  const text = result.data.message.content.find(block => block.type === 'text')
  if (text?.type !== 'text') throw new Error('Original Native log has no actual presentation text')
  const parsed = JSON.parse(text.text) as OfficeConversationPptxRead
  expect(parsed.file).toMatchObject({ id: file.id, versionId: info.versionId, sha256, byteLength: bytes.length, name, mediaType })
  expect(parsed).toMatchObject({ slideNumber: 1, section: 'slide', text: body, offset: 0, eof: true, tableCount: 1 })
  expect(parsed.slides).toEqual([{ number: 1, hidden: false, hasNotes: true }, { number: 2, hidden: false, hasNotes: false }])
  expect(parsed.text).not.toContain('演讲者备注')
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
  expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  const final = events.findLast(event => event.type === 'assistant/message')
  expect(final?.data.message.content).toContainEqual({ type: 'text', text: answer })
  const card = page.locator(`[data-chat-call-id="${callId}"] [data-tool="office_read_pptx"]`)
  await expandOwningTurnProcess(page, card)
  await card.waitFor({ state: 'visible' })
  expect(await card.getAttribute('data-state')).toBe('ok')
  await card.getByRole('button', { expanded: false }).first().click()
  await expect.poll(() => card.innerText()).toContain('第二页🙂')
  await page.screenshot({ path: join(artifactRoot, 'native-result.png'), fullPage: true, animations: 'disabled' })
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
  await writeFile(join(artifactRoot, 'evidence.json'), JSON.stringify({ fileId: file.id, versionId: info.versionId,
    sha256, byteLength: bytes.length, sessionId: nativeId, manualApproval: true, sameNativeConversation: true,
    relationshipOrderedBody: parsed.text, notesExcluded: true, toolCalls: calls.length, modelRequests: adapter.requests.length,
    pageErrors: console.pageErrors, warnings: console.warnings, realExternalModel: false }, null, 2) + '\n')
})
