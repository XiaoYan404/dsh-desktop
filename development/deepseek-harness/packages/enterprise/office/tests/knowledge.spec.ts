/** Real JSON Office indexing reuses actual parsers and checks current Drive authority for every search and citation. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { OfficeKnowledgePolicy, OfficeConversationFileReference } from '../src/types.ts'
import { installPptxFixtureOffice, pptxAdministrator as admin, pptxEmployee as employee, pptxOtherEmployee as peer,
  pptxTestPolicy } from './pptx-office-fixture.ts'
import { submittedDocxFixture } from './docx-fixture.ts'
import { submittedPptxFixture } from './pptx-fixture.ts'

/** Explicit small isolated index limits; no deployment defaults are enabled by the test. */
export const knowledgeTestPolicy: OfficeKnowledgePolicy = { maxDocuments: 20, maxIndexBytes: 2 * 1024 * 1024,
  maxSourceBytes: 1024 * 1024, maxDocumentCharacters: 65536, maxSections: 20, chunkCharacters: 512,
  maxChunksPerDocument: 256, maxResults: 10, maxResponseBytes: 16384, timeoutMs: 10000 }

async function fixture(config: Partial<OfficeKnowledgePolicy> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-knowledge-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-knowledge-'))
      throw new Error('Unexpected owned knowledge fixture directory')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include })
  await installPptxFixtureOffice(ctx, join(root, 'authority'), { knowledge: { ...knowledgeTestPolicy, ...config }, conversationPptx: pptxTestPolicy })
  const parent = await ctx.office.createDriveFolder(admin, { name: 'Knowledge sources', space: 'shared', folderId: null })
  const upload = async (name: string, mediaType: string, bytes: Uint8Array, target?: { id: OfficeConversationFileReference['id']; revision: number }) => {
    const ticket = await ctx.office.beginDriveUpload(admin, { name, mediaType, space: 'shared', folderId: parent.id,
      byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      requestId: randomUUID(), ...(target ? { target } : {}) })
    for (let offset = 0; offset < bytes.length; offset += ticket.chunkBytes) {
      const part = bytes.subarray(offset, offset + ticket.chunkBytes)
      await ctx.office.appendDriveUpload(admin, { uploadId: ticket.id, index: offset / ticket.chunkBytes,
        dataBase64: Buffer.from(part).toString('base64'), sha256: createHash('sha256').update(part).digest('hex') })
    }
    const completed = await ctx.office.completeDriveUpload(admin, ticket.id)
    if (!completed.fileId) throw new Error('Knowledge source did not upload')
    const info = await ctx.office.driveFileInfo(admin, completed.fileId)
    const entry = ctx.office.drive(admin, { space: 'shared', folderId: parent.id, search: '' }).entries.find(row => row.id === info.id)
    if (!entry) throw new Error('Actual current knowledge Drive revision missing')
    return { ...info, revision: entry.revision }
  }
  return { ctx, root, parent, upload }
}

it('indexes real text incrementally and refuses old citations after replacement, withdrawal and ancestor revocation', async () => {
  const { ctx, upload, parent } = await fixture()
  const file = await upload('政策.txt', 'text/plain', Buffer.from('企业报销政策🙂\n每笔报销必须提供发票'))
  const input = { fileId: file.id, versionId: file.versionId, revision: 0, requestId: randomUUID() }
  const published = await ctx.office.publishKnowledge(admin, input)
  expect(published.chunks).toBe(1)
  expect(await ctx.office.publishKnowledge(admin, input)).toEqual(published)
  await expect(ctx.office.publishKnowledge(employee, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'forbidden' })
  const found = await ctx.office.searchKnowledge(employee, { query: '报销', limit: 10 })
  expect(found.entries).toHaveLength(1)
  const citation = found.entries[0]
  if (!citation) throw new Error('Authorized knowledge citation missing')
  expect(citation.text).toContain('报销政策🙂')
  expect(citation.location).toEqual({ kind: 'text', part: 1, offset: 0, label: '' })
  expect(citation.file.sha256).toBe(file.sha256)
  const reopen = { fileId: file.id, versionId: file.versionId, sha256: file.sha256,
    revision: citation.revision, chunk: citation.chunk }
  expect(await ctx.office.readKnowledgeCitation(peer, reopen)).toEqual(citation)
  const replacement = await upload(file.name, file.mediaType, Buffer.from('新政策：报销上限1000元'), { id: file.id, revision: file.revision })
  expect((await ctx.office.searchKnowledge(employee, { query: '报销', limit: 10 })).entries).toEqual([])
  await expect(ctx.office.readKnowledgeCitation(employee, reopen)).rejects.toMatchObject({ code: 'not_found' })
  expect((await ctx.office.knowledgePublication(admin, file.id))?.revision).toBe(1)
  const updated = await ctx.office.publishKnowledge(admin,
    { ...input, versionId: replacement.versionId, revision: 1, requestId: randomUUID() })
  expect(updated.revision).toBe(2)
  expect((await ctx.office.searchKnowledge(employee, { query: '1000', limit: 10 })).entries[0]?.file.versionId).toBe(replacement.versionId)
  await ctx.office.saveDrivePermissions(admin, { id: parent.id, revision: parent.revision, defaultAccess: 'deny', grants: [] })
  expect((await ctx.office.searchKnowledge(employee, { query: '1000', limit: 10 }))).toEqual({ query: '1000', entries: [], hasMore: false })
  const withdrawn = await ctx.office.withdrawKnowledge(admin, { fileId: file.id, revision: 2, requestId: randomUUID() })
  expect(withdrawn.withdrawn).toBe(true)
  expect(withdrawn.chunks).toBe(0)
  expect((await ctx.office.searchKnowledge(admin, { query: '1000', limit: 10 })).entries).toEqual([])
})

it.each(['docx', 'pptx'] as const)('indexes actual %s text with existing worker output and source positions', async (kind) => {
  const { ctx, upload } = await fixture()
  const bytes = kind === 'docx' ? submittedDocxFixture() : submittedPptxFixture()
  const media = kind === 'docx' ? 'wordprocessingml.document' : 'presentationml.presentation'
  const file = await upload(`source.${kind}`, `application/vnd.openxmlformats-officedocument.${media}`, bytes)
  await ctx.office.publishKnowledge(admin, { fileId: file.id, versionId: file.versionId, revision: 0, requestId: randomUUID() })
  const found = await ctx.office.searchKnowledge(employee, { query: kind === 'docx' ? '真实 Word' : '第二页', limit: 10 })
  expect(found.entries.length).toBeGreaterThan(0)
  expect(found.entries[0]?.file.versionId).toBe(file.versionId)
  expect(found.entries[0]?.location.kind).toBe(kind)
  if (kind === 'pptx') expect(found.entries[0]?.location.part).toBe(1)
})

it('enforces complete result bytes and cancellation without publishing an incomplete index', async () => {
  const { ctx, upload } = await fixture({ maxResponseBytes: 640 })
  const file = await upload('bounded.txt', 'text/plain', Buffer.from('bounded secret policy '.repeat(100)))
  const canceled = new AbortController()
  canceled.abort(new Error('Owned knowledge extraction canceled'))
  await expect(ctx.office.publishKnowledge(admin, { fileId: file.id, versionId: file.versionId,
    revision: 0, requestId: randomUUID() }, canceled.signal)).rejects.toThrow()
  expect(await ctx.office.knowledgePublication(admin, file.id)).toBeNull()
  await ctx.office.publishKnowledge(admin, { fileId: file.id, versionId: file.versionId, revision: 0, requestId: randomUUID() })
  await expect(ctx.office.searchKnowledge(employee, { query: 'policy', limit: 1 })).rejects.toMatchObject({ code: 'context_too_large' })
})

it('rechecks current source authority after the actual parser settles before publishing text', async () => {
  const { ctx, upload } = await fixture()
  const file = await upload('reviewed.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', submittedDocxFixture())
  const password = 'Owned knowledge expiry fixture 2026!'
  await ctx.office.initializeIdentity(admin, password)
  const signed = await ctx.office.login({ memberId: admin, password })
  const clock = vi.spyOn(Date, 'now')
  const parser = await import('../src/knowledge-document.ts')
  const extract = parser.extractOfficeKnowledge
  const parse = vi.spyOn(parser, 'extractOfficeKnowledge')
  parse.mockImplementationOnce(async (...args) => {
    const output = await extract(...args)
    clock.mockReturnValue(signed.expiresAt + 1)
    return output
  })
  try {
    await expect(ctx.office.withSession(signed.token, actor => ctx.office.publishKnowledge(actor, {
      fileId: file.id, versionId: file.versionId, revision: 0, requestId: randomUUID() }))).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(parse).toHaveBeenCalledTimes(1)
    expect(await ctx.office.knowledgePublication(admin, file.id)).toBeNull()
  } finally { clock.mockRestore(); parse.mockRestore() }
})

it('excludes a deleted indexed source and denies its earlier citation without altering the Drive version', async () => {
  const { ctx, upload } = await fixture()
  const file = await upload('retired.txt', 'text/plain', Buffer.from('Retired company procedure'))
  await ctx.office.publishKnowledge(admin, { fileId: file.id, versionId: file.versionId, revision: 0, requestId: randomUUID() })
  const before = await ctx.office.searchKnowledge(employee, { query: 'Retired', limit: 1 })
  const citation = before.entries[0]
  if (!citation) throw new Error('Retirement fixture citation missing')
  await ctx.office.changeDriveLifecycle(admin, { id: file.id, revision: file.revision, action: 'trash' })
  expect(await ctx.office.searchKnowledge(employee, { query: 'Retired', limit: 1 }))
    .toEqual({ query: 'Retired', entries: [], hasMore: false })
  await expect(ctx.office.readKnowledgeCitation(employee, { fileId: file.id, versionId: file.versionId,
    sha256: file.sha256, revision: citation.revision, chunk: citation.chunk })).rejects.toMatchObject({ code: 'not_found' })
})

it('bounds the escaped Native knowledge result even when its ordinary HTTP envelope would fit', async () => {
  const { ctx, upload } = await fixture({ maxResponseBytes: 1400 })
  const text = 'q' + '"\n\\'.repeat(100)
  const file = await upload('escaped.txt', 'text/plain', Buffer.from(text))
  const publication = await ctx.office.publishKnowledge(admin, { fileId: file.id, versionId: file.versionId,
    revision: 0, requestId: randomUUID() })
  const value = { query: 'q', entries: [{ file: publication.file, revision: 1, chunk: 0,
    location: { kind: 'text', part: 1, offset: 0, label: '' }, text }], hasMore: true }
  expect(Buffer.byteLength(JSON.stringify({ ok: true, value }))).toBeLessThan(1400)
  expect(Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]))).toBeGreaterThan(1400)
  await expect(ctx.office.searchKnowledge(employee, { query: 'q', limit: 1 })).rejects.toMatchObject({ code: 'context_too_large' })
})
