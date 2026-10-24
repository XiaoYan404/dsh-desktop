/** The original office queue checks actual XLSX bytes before allocation and authority again after parsing. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import { OfficeDriveTransferFiles } from '../src/drive-transfer-files.ts'
import { officeDriveDomain } from '../src/drive.ts'
import * as Xlsx from '../src/xlsx.ts'
import type { OfficeConversationId } from '../src/types.ts'
import { installDocxFixtureOffice, docxAdministrator, docxEmployee } from './docx-office-fixture.ts'
import { submittedXlsxFixture } from './xlsx-fixture.ts'

async function fixture(config: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-xlsx-authority-'))
  const ctx = new Context()
  onTestFinished(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-xlsx-authority-'))
      throw new Error('Unexpected spreadsheet authority fixture directory')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await installDocxFixtureOffice(ctx, join(root, 'authority'), config)
  const parent = await ctx.office.createDriveFolder(docxAdministrator, { name: 'Spreadsheet parent', folderId: null, space: 'shared' })
  const bytes = submittedXlsxFixture()
  const file = await ctx.office.uploadDriveFile(docxAdministrator, { name: 'reviewed.xlsx', space: 'shared', folderId: parent.id,
    requestId: randomUUID(), mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const info = await ctx.office.driveFileInfo(docxEmployee, file.id)
  const conversationId = 'spreadsheet-authority-fixture' as OfficeConversationId
  await ctx.office.saveConversationFiles(docxEmployee, { conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const capture = await ctx.office.captureConversationFiles(docxEmployee, { conversationId, revision: 1, requestId: randomUUID() })
  return { ctx, parent, input: { captureId: capture.id, fileId: file.id, sheetNumber: 1, offset: 0, maxCells: 256 } }
}

it('rejects oversized submitted XLSX metadata before full-byte reads or worker creation', async () => {
  const { ctx, input } = await fixture({ conversationXlsx: { maxBytes: 1 } })
  const reads = vi.spyOn(OfficeDriveTransferFiles.prototype, 'readRange')
  await expect(ctx.office.readConversationXlsx(docxEmployee, input)).rejects.toMatchObject({ code: 'context_too_large' })
  expect(reads).not.toHaveBeenCalled()
})

it.each(['acl', 'stop'] as const)('withholds actually parsed saved spreadsheet values after a final %s change', async (action) => {
  const { ctx, parent, input } = await fixture()
  const original = Xlsx.extractOfficeXlsx
  const controller = new AbortController()
  const stopped = new Error('Original spreadsheet tool canceled after parsing')
  vi.spyOn(Xlsx, 'extractOfficeXlsx').mockImplementationOnce(async (...args) => {
    const document = await original(...args)
    if (action === 'stop') controller.abort(stopped)
    else {
      // Ordinary ACL mutations serialize in this queue; replacement exercises the post-parser check directly.
      const domain = ctx.storageDomain.get('enterprise_office_drive')!
      const state = officeDriveDomain.global.schema.parse(domain.global.get())
      await domain.global.set({ ...state, nodes: state.nodes.map(node => node.id === parent.id
        ? { ...node, defaultAccess: 'deny' as const } : node) })
    }
    return document
  })
  const pending = ctx.office.readConversationXlsx(docxEmployee, input, controller.signal)
  if (action === 'stop') await expect(pending).rejects.toBe(stopped)
  else await expect(pending).rejects.toMatchObject({ code: 'not_found' })
})
