/** Actual Drive selection and browser approval retain real image bytes through the existing Native history and adapter serialization. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { OfficeConversationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type {} from '@deepseek-ai/dsh-enterprise-office'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { prepareImages } from '../../../packages/llm/llm-deepseek/src/images.ts'
import { serialize } from '../../../packages/llm/llm-deepseek/src/serialize.ts'
import { resolveAdapterOptions } from '../../../packages/llm/llm-deepseek/src/config.ts'
import { launchWebScaffold, readPersistedEvents, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const provider = 'office-image-page-fixture'
const callId = ToolCallId('actual-submitted-image-page')
const actor = 'local' as OfficeMemberId
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

class ImagePageAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  binaryDigest: string | undefined
  constructor(private readonly fileId: string, private readonly attachments: AttachmentStore) { super() }
  override async listModels(name: string) { return [{ provider: name, id: 'vision', name: 'Controlled image acceptance', inputModalities: ['text', 'image'] as const }] }
  override async resolveModel(name: string, model: string): Promise<LlmResolvedModelInfo> {
    return { ...await super.resolveModel(name, model), inputModalities: ['text', 'image'] }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'office_read_image',
        arguments: JSON.stringify({ file_id: this.fileId }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const result = options.messages.at(-1)
    const image = result?.content.find(block => block.type === 'image')
    if (result?.role !== 'tool' || result.isError || image?.type !== 'image') throw new Error('Actual approved image result is missing')
    const stored = await this.attachments.readImage(image.attachment)
    const connection = resolveAdapterOptions({ models: [{ id: 'vision', inputModalities: ['text', 'image'], imagePixelBudget: 'low' }] })
    const prepared = await prepareImages(options.messages, connection, 'vision', this.attachments, () => undefined, new AbortController().signal)
    const wire = serialize(options, connection, prepared.messages, prepared.versions, () => undefined)
    const tool = wire.messages.flatMap(message => message.content).find(block => block.type === 'tool_result')
    const binary = tool?.type === 'tool_result' ? tool.content.find(block => block.type === 'image') : undefined
    if (binary?.type !== 'image' || binary.source.type !== 'base64') throw new Error('Actual image adapter serialization omitted bytes')
    const requestImage = prepared.versions.get(image.attachment.attachmentId)
    if (!requestImage) throw new Error('Actual attachment request variant is missing')
    expect(Buffer.from(binary.source.data, 'base64')).toEqual(Buffer.from(requestImage.data))
    expect(`sha256:${sha(stored.data)}`).toBe(image.attachment.attachmentId)
    this.binaryDigest = sha(Buffer.from(binary.source.data, 'base64'))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ACTUAL_IMAGE_BYTES_ACCEPTED' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('selects a real Drive image and approves the original Native image result whose binary reaches the next adapter request', async () => {
  const artifacts = join(REPO_ROOT, '.artifacts/parallel-handoff/02/image-page')
  await mkdir(artifacts, { recursive: true })
  const rows = z.array(z.looseObject({ id: z.string(), config: z.record(z.string(), z.unknown()).optional() }))
    .parse(yaml.load(await readFile(join(REPO_ROOT, 'enterprise-workbench.patch.yml'), 'utf8')))
  const office = rows.find(row => row.id === 'enterprise-office')
  const tools = rows.find(row => row.id === 'tool-office')
  if (!office?.config || !tools?.config) throw new Error('Expected the original Office composition rows')
  office.config.imageRead = { maxSourceBytes: 1048576, maxSourcePixels: 64000000, maxSourceDimension: 8192,
    maxResponseBytes: 2097152, mediaTypes: ['image/png'] }
  tools.config.image = true
  tools.config.imageMaxNormalizedResultBytes = 65536
  const overlay = join(artifacts, 'explicit-image.overlay.yml')
  await writeFile(overlay, yaml.dump(rows))
  const scaffold = await launchWebScaffold({ profile: { packages: [] }, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser, 900)
  const observed = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'enterprise-office-image-reader'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: 'Native workspace', exact: true }).click()
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const current = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string })
  if (!current.sessionId) throw new Error('Expected an original Native image conversation')
  const associations = page.getByRole('region', { name: 'Conversation files', exact: true })
  await associations.getByRole('button', { name: 'Link files', exact: true }).click()
  const drive = page.getByRole('region', { name: 'Drive', exact: true })
  await drive.getByRole('button', { name: 'Private drive', exact: true }).first().click()
  const bytes = await readFile(join(REPO_ROOT, 'snapshots/session/read-image-reencode/workspace/gradient.png'))
  const name = 'native-reviewed-image.png'
  await drive.locator('input[type=file][aria-label="Upload file"]').setInputFiles({ name, mimeType: 'image/png', buffer: bytes })
  const upload = page.getByRole('dialog', { name: 'Upload file', exact: true })
  await upload.getByRole('button', { name: 'Upload file', exact: true }).click()
  await upload.waitFor({ state: 'hidden' })
  await drive.getByText('Upload complete', { exact: true }).waitFor()
  const file = scaffold.ctx.office.drive(actor, { space: 'private', folderId: null, search: '' }).entries.find(row => row.name === name)
  if (!file) throw new Error('Actual uploaded image missing from Drive')
  const info = await scaffold.ctx.office.driveFileInfo(actor, file.id)
  expect(info.sha256).toBe(sha(bytes))
  await drive.locator(`[data-drive-entry="${file.id}"]`).click()
  await drive.getByRole('button', { name: 'Use in AI chat', exact: true }).click()
  await associations.getByText(name, { exact: true }).waitFor()
  const selection = await scaffold.ctx.office.conversationFiles(actor, current.sessionId as OfficeConversationId)
  expect(selection.files[0]?.versionId).toBe(info.versionId)
  const adapter = new ImagePageAdapter(file.id, scaffold.ctx.attachments)
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([provider], adapter))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider, model: 'vision' })
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Read the exact submitted picture with the image tool.')
  const settled = scaffold.whenTurnSettled()
  await input.press('Enter')
  const approval = page.locator('[data-approval-key]')
  await approval.waitFor()
  expect(await approval.innerText()).toContain(info.sha256)
  expect(adapter.binaryDigest).toBeUndefined()
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
  await settled
  await page.getByText('ACTUAL_IMAGE_BYTES_ACCEPTED', { exact: true }).last().waitFor()
  const events = await readPersistedEvents(scaffold, SessionId(current.sessionId))
  const result = events.findLast(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result' || result.data.message.isError) throw new Error('Original durable image result missing')
  expect(result.data.message.content.some(block => block.type === 'image')).toBe(true)
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
  expect(adapter.binaryDigest).toMatch(/^[a-f\d]{64}$/u)
  expect(observed.pageErrors).toEqual([])
  expect(observed.warnings).toEqual([])
  await page.screenshot({ path: join(artifacts, 'native-image-result.png'), fullPage: true, animations: 'disabled' })
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify({ sourceBytes: bytes.length, sourceDigest: info.sha256,
    versionId: info.versionId, imageAdapterBinaryDigest: adapter.binaryDigest, sameNativeConversation: true,
    manualBrowserApproval: true, persistedImageBlock: true, nextModelRequestMatches: true, realExternalModel: false }, null, 2) + '\n')
}, 30000)
