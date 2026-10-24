/** Real ZIP/XML extraction and complete native content limits run without document-parser mocks. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { extractOfficeDocx, officeDocxWindow, resolveOfficeDocxPolicy } from '../src/docx.ts'
import type { OfficeConversationDocxConfig, OfficeConversationDocxReadInput } from '../src/docx-types.ts'
import type { OfficeConversationFileReference } from '../src/types.ts'
import { submittedDocxFixture, submittedDocxText } from './docx-fixture.ts'

const signal = () => new AbortController().signal

it('extracts actual Unicode Word paragraphs and table cells from compressed DOCX without interpreting external content', async () => {
  const bytes = submittedDocxFixture({ extra: {
    'word/header1.xml': new TextEncoder().encode('HEADER_OUTSIDE_READER_SCOPE'),
    'word/_rels/document.xml.rels': new TextEncoder().encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
 Target="https://127.0.0.1:1/DO_NOT_FETCH" TargetMode="External"/></Relationships>`),
  } })
  expect(bytes.includes(Buffer.from('真实 Word'))).toBe(false)
  expect(await extractOfficeDocx(bytes, resolveOfficeDocxPolicy(), signal())).toEqual({
    text: submittedDocxText, paragraphCount: 7, tableCount: 1,
  })
})

it('honors Word namespaces instead of requiring the authoring application w prefix', async () => {
  const document = `<x:document xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main"><x:body>
<x:p><x:r><x:t>strict namespace</x:t><x:tab/><x:t>cell</x:t><x:br/><x:t>line</x:t></x:r></x:p></x:body></x:document>`
  expect(await extractOfficeDocx(submittedDocxFixture({ document }), resolveOfficeDocxPolicy(), signal()))
    .toEqual({ text: 'strict namespace\tcell\nline', paragraphCount: 1, tableCount: 0 })
})

it.each([
  { document: '<w:document><w:body>broken' },
  { document: '<!DOCTYPE x [<!ENTITY secret "DO_NOT_EXPAND">]><x/>' },
  { externalMain: true, relationshipTarget: 'https://127.0.0.1:1/private' },
  { relationshipTarget: 'other/document.xml' },
  { contentType: 'application/vnd.ms-word.document.macroEnabled.main+xml' },
  { extra: { '../outside.xml': new Uint8Array([1]) } },
])('rejects malformed, external, macro-enabled or nonstandard Word packages (%j)', async (options) => {
  await expect(extractOfficeDocx(submittedDocxFixture(options), resolveOfficeDocxPolicy(), signal()))
    .rejects.toMatchObject({ code: 'invalid_input' })
})

it.each<OfficeConversationDocxConfig>([
  { maxBytes: 1 }, { maxArchiveEntries: 3 }, { maxInflatedBytes: 64 }, { maxXmlBytes: 64 },
  { maxNodes: 3 }, { maxTextCharacters: 3 }, { timeoutMs: 1 },
])('enforces input, complete archive, XML, traversal, extracted text and time limits (%j)', async (overrides) => {
  const bytes = submittedDocxFixture({ extra: { 'word/media/unused.bin': new Uint8Array(1024 * 1024) } })
  await expect(extractOfficeDocx(bytes, resolveOfficeDocxPolicy(overrides), signal())).rejects.toMatchObject({ code: 'context_too_large' })
})

it('cancels and awaits an actual DOCX worker using the original tool signal', async () => {
  const controller = new AbortController()
  const pending = extractOfficeDocx(submittedDocxFixture(), resolveOfficeDocxPolicy(), controller.signal)
  const stopped = new Error('Original native DOCX tool stopped')
  controller.abort(stopped)
  await expect(pending).rejects.toBe(stopped)
})

it('fits the complete escaped UTF-8 result at its exact limit and preserves continuation through a table and surrogate pair', () => {
  const file = { id: randomUUID(), versionId: randomUUID(), name: '预算.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byteLength: 2000, sha256: 'a'.repeat(64) } as OfficeConversationFileReference
  const input = { captureId: randomUUID(), fileId: file.id, offset: 0, maxCharacters: 16384 } as OfficeConversationDocxReadInput
  const document = { text: 'A🙂\t"\\中文\n'.repeat(20), paragraphCount: 2, tableCount: 1 }
  const complete = officeDocxWindow(file, input, document, 65536)
  const size = (value: typeof complete) => Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]))
  expect(officeDocxWindow(file, input, document, size(complete))).toEqual(complete)
  const bounded = officeDocxWindow(file, input, document, size(complete) - 1)
  expect(size(bounded)).toBeLessThanOrEqual(size(complete) - 1)
  expect(bounded.eof).toBe(false)
  expect(bounded.text + officeDocxWindow(file, { ...input, offset: bounded.nextOffset }, document, 65536).text).toBe(document.text)
  expect(officeDocxWindow(file, { ...input, maxCharacters: 2 }, document, 65536).text).toBe('A🙂')
  expect(() => officeDocxWindow(file, { ...input, offset: 2 }, document, 65536)).toThrow('splits a character')
  expect(() => officeDocxWindow(file, input, document, 1)).toThrow('metadata exceeds')
})
