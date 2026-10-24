/** Real Loader, durable office ACLs, binary PDF.js parsing and bounded native tool-content results. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, expect, it, vi } from 'vitest'
import OfficeService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { OfficeDriveTransferFiles } from '../src/drive-transfer-files.ts'
import { officeDriveDomain } from '../src/drive.ts'
import * as Pdf from '../src/pdf.ts'
import { extractOfficePdf, officePdfWindow, resolveOfficePdfPolicy } from '../src/pdf.ts'
import type { OfficeConversationId, OfficeConversationPdfRead, OfficeMemberId } from '../src/types.ts'
import { submittedPdfFixture } from './pdf-fixture.ts'

const admin = 'admin' as OfficeMemberId
const lin = 'lin' as OfficeMemberId
const chen = 'chen' as OfficeMemberId
const conversationId = 'native-submitted-pdf' as OfficeConversationId
const contexts: Context[] = []
const roots: string[] = []
const seed: Config = { companyName: 'PDF company', timeZone: 'Asia/Shanghai', members: [admin, lin, chen].map(id => ({
  id, name: id, department: 'Office', jobTitle: 'Member', role: id === admin ? 'admin' : 'employee',
})) }

async function boot(overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-submitted-pdf-'))
  roots.push(root)
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'data') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { id: 'office', name: '@deepseek-ai/dsh-enterprise-office', config: { ...seed, ...overrides, dshHome: root } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-enterprise-office', OfficeService],
  ])
  const internal = ctx.loader.internal
  if (!internal) throw new Error('Missing Loader internal configuration')
  ctx.loader.internal = new Proxy(internal, {
    get(target, key) {
      if (key === 'import') return async (name: string) => {
        if (!modules.has(name)) throw new Error('Unexpected PDF fixture module')
        return modules.get(name)
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('PDF office did not activate')
  return { ctx, root }
}

async function selected(ctx: Context, bytes = submittedPdfFixture(), name = 'actual.pdf') {
  let parent = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: randomUUID() })
  parent = await ctx.office.saveDrivePermissions(admin, { id: parent.id, revision: parent.revision, defaultAccess: 'view', grants: [] })
  const file = await ctx.office.uploadDriveFile(admin, { space: 'shared', folderId: parent.id, name,
    mediaType: 'application/pdf', byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await ctx.office.driveFileInfo(lin, file.id)
  const current = await ctx.office.conversationFiles(lin, conversationId)
  const saved = await ctx.office.saveConversationFiles(lin, { conversationId, revision: current.revision,
    requestId: randomUUID(), files: [{ id: file.id, versionId: info.versionId }] })
  const capture = await ctx.office.captureConversationFiles(lin, { conversationId, revision: saved.revision, requestId: randomUUID() })
  return { file, info, parent, bytes, capture, input: { captureId: capture.id, fileId: file.id,
    pageNumber: 1, offset: 0, maxCharacters: 16384 } }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-submitted-pdf-'))
      throw new Error('Unexpected PDF fixture directory')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('extracts exact selected-page text from compressed PDF bytes and retains no attachment copy', async () => {
  const { ctx, root } = await boot()
  const fixture = await selected(ctx)
  expect(fixture.bytes.includes(Buffer.from('Actual binary PDF page one'))).toBe(false)
  const first = await ctx.office.readConversationPdf(lin, { ...fixture.input, maxCharacters: 8 })
  expect(first).toMatchObject({ file: { versionId: fixture.info.versionId, sha256: createHash('sha256').update(fixture.bytes).digest('hex') },
    pageNumber: 1, pageCount: 2, offset: 0, nextOffset: 8, eof: false, text: 'Actual b' })
  const rest = await ctx.office.readConversationPdf(lin, { ...fixture.input, offset: first.nextOffset })
  expect(first.text + rest.text).toBe('Actual binary PDF page one')
  expect(rest.eof).toBe(true)
  expect((await ctx.office.readConversationPdf(lin, { ...fixture.input, pageNumber: 2 })).text).toBe('Actual binary PDF page two')
  expect((await readdir(root)).some(entry => entry.includes('attachment'))).toBe(false)
  await expect(ctx.office.readConversationFile(lin, fixture.input)).rejects.toMatchObject({ code: 'invalid_input' })
})

it('rechecks private ownership, captured role, ancestor ACLs and current version on every page/window read', async () => {
  const { ctx } = await boot()
  const fixture = await selected(ctx)
  await expect(ctx.office.readConversationPdf(chen, fixture.input)).rejects.toMatchObject({ code: 'not_found' })
  await ctx.office.readConversationPdf(lin, fixture.input)
  let parent = await ctx.office.saveDrivePermissions(admin, { id: fixture.parent.id, revision: fixture.parent.revision,
    defaultAccess: 'deny', grants: [] })
  await expect(ctx.office.readConversationPdf(lin, fixture.input)).rejects.toMatchObject({ code: 'not_found' })
  parent = await ctx.office.saveDrivePermissions(admin, { id: parent.id, revision: parent.revision, defaultAccess: 'view', grants: [] })
  const member = ctx.office.view(admin).members.find(row => row.id === lin)!
  await ctx.office.saveMember(admin, { ...member, role: 'manager' }, member)
  await expect(ctx.office.readConversationPdf(lin, fixture.input)).rejects.toMatchObject({ code: 'forbidden' })
  const changed = ctx.office.view(admin).members.find(row => row.id === lin)!
  await ctx.office.saveMember(admin, { ...changed, role: 'employee' }, changed)
  const replacement = submittedPdfFixture(['Replacement content'])
  const ticket = await ctx.office.beginDriveUpload(admin, { space: 'shared', folderId: parent.id, name: fixture.file.name,
    requestId: randomUUID(), mediaType: 'application/pdf', byteLength: replacement.length,
    sha256: createHash('sha256').update(replacement).digest('hex'), target: { id: fixture.file.id, revision: fixture.file.revision } })
  await ctx.office.appendDriveUpload(admin, { uploadId: ticket.id, index: 0,
    sha256: createHash('sha256').update(replacement).digest('hex'), dataBase64: replacement.toString('base64') })
  await ctx.office.completeDriveUpload(admin, ticket.id)
  await expect(ctx.office.readConversationPdf(lin, fixture.input)).rejects.toMatchObject({ code: 'conflict' })
})

it('rejects oversized metadata before accessing full bytes or creating a parser', async () => {
  const { ctx } = await boot({ conversationPdf: { maxBytes: 50 } })
  const fixture = await selected(ctx)
  const reads = vi.spyOn(OfficeDriveTransferFiles.prototype, 'readRange')
  await expect(ctx.office.readConversationPdf(lin, fixture.input)).rejects.toMatchObject({ code: 'context_too_large' })
  expect(reads).not.toHaveBeenCalled()
})

it('withholds actual parsed text when permissions change before the final queued authorization check', async () => {
  const { ctx } = await boot()
  const fixture = await selected(ctx)
  const domain = ctx.storageDomain.get('enterprise_office_drive')!
  const actual = Pdf.extractOfficePdf
  vi.spyOn(Pdf, 'extractOfficePdf').mockImplementationOnce(async (...args) => {
    const parsed = await actual(...args)
    // A direct storage replacement exercises the post-parser check even though ordinary ACL writes serialize in this queue.
    const state = officeDriveDomain.global.schema.parse(domain.global.get())
    await domain.global.set({ ...state, nodes: state.nodes.map(node => node.id === fixture.parent.id
      ? { ...node, defaultAccess: 'deny' as const } : node) })
    return parsed
  })
  await expect(ctx.office.readConversationPdf(lin, fixture.input)).rejects.toMatchObject({ code: 'not_found' })
})

it.each([{ maxPages: 1 }, { maxPageCharacters: 4 }, { maxOutputBytes: 256 }, { timeoutMs: 1 }])(
  'enforces parser and complete output limits (%j) without retaining a body', async (conversationPdf) => {
    const { ctx } = await boot({ conversationPdf })
    const fixture = await selected(ctx)
    await expect(ctx.office.readConversationPdf(lin, fixture.input)).rejects.toMatchObject({ code: 'context_too_large' })
    expect((await ctx.office.conversationFiles(lin, conversationId)).files[0]?.id).toBe(fixture.file.id)
  },
)

it('rejects malformed PDF, invalid pages and tampered actual bytes instead of supplying invented text', async () => {
  const { ctx, root } = await boot()
  const malformed = await selected(ctx, Buffer.from('%PDF-1.7\nmalformed binary\0'), 'damaged.pdf')
  await expect(ctx.office.readConversationPdf(lin, malformed.input)).rejects.toMatchObject({ code: 'invalid_input' })
  const fixture = await selected(ctx)
  await expect(ctx.office.readConversationPdf(lin, { ...fixture.input, pageNumber: 3 })).rejects.toMatchObject({ code: 'invalid_input' })
  await writeFile(join(root, 'office/drive/v1/objects', `${fixture.info.versionId}.bin`), Buffer.alloc(fixture.bytes.length))
  await expect(ctx.office.readConversationPdf(lin, fixture.input)).rejects.toMatchObject({ code: 'conflict' })
})

it('cancels and awaits an actual parser worker before exposing any text', async () => {
  const controller = new AbortController()
  const pending = extractOfficePdf(submittedPdfFixture(), 1, resolveOfficePdfPolicy(), controller.signal)
  const reason = new Error('Original native tool stopped')
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  expect(await extractOfficePdf(submittedPdfFixture(['After canceled worker']), 1,
    resolveOfficePdfPolicy(), new AbortController().signal)).toMatchObject({ text: 'After canceled worker' })
})

it('fits complete escaped UTF-8 tool content at the exact byte limit and preserves character continuations', () => {
  const file = { id: randomUUID(), versionId: randomUUID(), name: '资料.pdf', mediaType: 'application/pdf',
    byteLength: 1, sha256: 'a'.repeat(64) } as OfficeConversationPdfRead['file']
  const input = { captureId: randomUUID(), fileId: file.id, pageNumber: 1, offset: 0, maxCharacters: 16384 } as const
  const page = { pageCount: 1, text: 'A🙂\\"\n中文🙂'.repeat(20) }
  const request = { ...input, captureId: input.captureId as Parameters<typeof officePdfWindow>[1]['captureId'] }
  const complete = officePdfWindow(file, request, page, 65536)
  const size = (value: OfficeConversationPdfRead) => Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]))
  expect(officePdfWindow(file, request, page, size(complete))).toEqual(complete)
  const bounded = officePdfWindow(file, request, page, size(complete) - 1)
  expect(size(bounded)).toBeLessThanOrEqual(size(complete) - 1)
  expect(bounded.eof).toBe(false)
  expect(bounded.text + officePdfWindow(file, { ...request, offset: bounded.nextOffset }, page, 65536).text).toBe(page.text)
  expect(officePdfWindow(file, { ...request, maxCharacters: 2 }, page, 65536).text).toBe('A🙂')
  expect(() => officePdfWindow(file, { ...request, offset: 2 }, page, 65536)).toThrow('splits a character')
})
