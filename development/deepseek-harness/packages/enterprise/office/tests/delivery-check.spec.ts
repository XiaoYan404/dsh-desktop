/** Actual Office/PDF bytes are parsed and linked through the original work submission and acceptance operations. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import ExcelJS from 'exceljs'
import { expect, it, onTestFinished } from 'vitest'
import type { OfficeConversationId, OfficeDeliveryTemplate, OfficeDeliveryPolicy } from '../src/types.ts'
import { installPptxFixtureOffice, pptxAdministrator as admin, pptxEmployee as employee, pptxOtherEmployee as peer,
  pptxTestPolicy } from './pptx-office-fixture.ts'
import { submittedDocxFixture } from './docx-fixture.ts'
import { submittedPptxFixture } from './pptx-fixture.ts'
import { submittedPdfFixture } from './pdf-fixture.ts'
import { officeDeliveryTemplates } from '../src/delivery-check.ts'

const policy: OfficeDeliveryPolicy = { maxSourceBytes: 1048576, maxDocumentCharacters: 65536, maxSections: 20,
  timeoutMs: 10000, maxResultBytes: 16384, maxExpectedTexts: 10, maxExpectedTextCharacters: 256 }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-delivery-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-delivery-'))
      throw new Error('Unexpected owned delivery directory')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include })
  await installPptxFixtureOffice(ctx, join(root, 'authority'), { conversationPptx: pptxTestPolicy, deliveryChecks: policy })
  const parent = await ctx.office.createDriveFolder(admin, { name: 'Delivery output', space: 'shared', folderId: null })
  const submit = async (template: OfficeDeliveryTemplate, bytes: Uint8Array) => {
    const file = await ctx.office.uploadDriveFile(admin, { name: `finished-${randomUUID()}.${template === 'document' ? 'docx'
      : template === 'spreadsheet' ? 'xlsx' : template === 'presentation' ? 'pptx' : 'pdf'}`,
    mediaType: officeDeliveryTemplates[template].mediaType, space: 'shared', folderId: parent.id,
    requestId: randomUUID(), byteLength: bytes.length, dataBase64: Buffer.from(bytes).toString('base64') })
    const info = await ctx.office.driveFileInfo(employee, file.id)
    const conversationId = randomUUID() as OfficeConversationId
    const selection = await ctx.office.saveConversationFiles(employee, { conversationId, revision: 0, requestId: randomUUID(),
      files: [{ id: file.id, versionId: info.versionId }] })
    const capture = await ctx.office.captureConversationFiles(employee,
      { conversationId, revision: selection.revision, requestId: randomUUID() })
    return { file, info, capture }
  }
  return { ctx, root, parent, submit }
}

it.each(['document', 'spreadsheet', 'presentation', 'pdf'] as const)(
  'verifies real %s output and uses its exact version in the existing work delivery chain', async (template) => {
    const { ctx, submit } = await fixture()
    let bytes: Uint8Array, required: string
    if (template === 'document') { bytes = submittedDocxFixture(); required = '真实 Word' }
    else if (template === 'presentation') { bytes = submittedPptxFixture(); required = '第二页' }
    else if (template === 'pdf') { bytes = submittedPdfFixture(['Verified office PDF output']); required = 'Verified office PDF output' }
    else {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Delivery')
      sheet.addRow(['Verified delivery', 'Amount'])
      sheet.addRow(['Office output', 500])
      bytes = Buffer.from(await workbook.xlsx.writeBuffer())
      required = 'Verified delivery'
    }
    const { file, info, capture } = await submit(template, bytes)
    const input = { captureId: capture.id, fileId: file.id, template, expectedText: [required] }
    const checked = await ctx.office.checkConversationDeliverable(employee, input)
    expect(checked.file.sha256).toBe(info.sha256)
    expect(checked.file.versionId).toBe(info.versionId)
    expect(checked.templateSource).toContain('bundled:office-')
    expect(checked.assertions).toEqual([{ text: required, found: true }])
    expect(checked.verification).toBe('structure_and_text')
    expect(checked.visualLayout).toBe('not_checked')
    const work = await ctx.office.createWork(admin, { kind: 'task', title: 'Review actual Office output',
      date: '2026-10-19', ownerId: employee })
    const linked = await ctx.office.updateWorkAttachments(admin, work.id, work.revision,
      { files: [{ id: file.id, versionId: info.versionId }] })
    const running = await ctx.office.decideTask(employee, work.id, linked.revision, { kind: 'accept' })
    const submitted = await ctx.office.reviewTaskDelivery(employee, work.id, running.revision, { kind: 'submit', reason: 'Structure and requested text checked' })
    const accepted = await ctx.office.reviewTaskDelivery(admin, work.id, submitted.revision, { kind: 'accept', reason: 'Reviewed exact delivery source' })
    expect(accepted.status).toBe('completed')
    expect((await ctx.office.workAttachmentInfo(employee, work.id, file.id)).versionId).toBe(info.versionId)
    await expect(ctx.office.checkConversationDeliverable(peer, input)).rejects.toMatchObject({ code: 'not_found' })
  })

it('refuses renamed text, missing expected content and a revoked real output instead of reporting a successful delivery', async () => {
  const { ctx, submit, parent } = await fixture()
  const forged = await submit('document', Buffer.from('This text is not a DOCX'))
  await expect(ctx.office.checkConversationDeliverable(employee, { captureId: forged.capture.id, fileId: forged.file.id,
    template: 'document', expectedText: ['This text'] })).rejects.toMatchObject({ code: 'invalid_input' })
  const real = await submit('document', submittedDocxFixture())
  await expect(ctx.office.checkConversationDeliverable(employee, { captureId: real.capture.id, fileId: real.file.id,
    template: 'document', expectedText: ['Never present in this binary'] })).rejects.toMatchObject({ code: 'conflict' })
  await ctx.office.saveDrivePermissions(admin, { id: parent.id, revision: parent.revision, defaultAccess: 'deny', grants: [] })
  await expect(ctx.office.checkConversationDeliverable(employee, { captureId: real.capture.id, fileId: real.file.id,
    template: 'document', expectedText: ['真实 Word'] })).rejects.toMatchObject({ code: 'not_found' })
})
