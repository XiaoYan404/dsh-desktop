import { getEventListeners } from 'node:events'
import { Worker } from 'node:worker_threads'
import { strToU8 } from 'fflate'
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeConversationFileReference, OfficeConversationFilesCaptureId,
  OfficeDriveId, OfficeDriveVersionId } from '@deepseek-ai/dsh-enterprise-office/types'
import { extractOfficePptx, officePptxWindow, resolveOfficePptxPolicy } from '../src/pptx.ts'
import type { OfficeConversationPptxRead, OfficeConversationPptxReadInput, OfficePptxPolicy,
  OfficePptxSelection } from '../src/pptx-types.ts'
import { pptxFixtureParts, replacePptxPart, submittedPptxFixture } from './pptx-fixture.ts'

const limits: OfficePptxPolicy = resolveOfficePptxPolicy({ maxBytes: 8 * 1024 * 1024, maxArchiveEntries: 2048,
  maxInflatedBytes: 32 * 1024 * 1024, maxXmlBytes: 8 * 1024 * 1024, maxNodes: 500000,
  maxSlides: 200, maxTextCharacters: 1024 * 1024, maxOutputBytes: 65536, timeoutMs: 5000, workerMemoryMb: 128 })
const first: OfficePptxSelection = { slideNumber: 1, section: 'slide' }
const richText = '第二页🙂\n组合中文\n换行\nA1\tB1\nA2\tB2'
const laterText = '第一页（文件名先出现）'
const notesText = '演讲者备注\n追加说明'
const parse = (bytes: Uint8Array, selection: OfficePptxSelection = first, policy: OfficePptxPolicy = limits,
  signal: AbortSignal = new AbortController().signal) => extractOfficePptx(bytes, selection, policy, signal)
const denied = (code: 'invalid_input' | 'context_too_large') => ({ name: 'OfficeError', code })
const nativeSize = (result: OfficeConversationPptxRead) =>
  Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(result) }]))

it('extracts genuine deflated PPTX in relationship order with grouped Unicode text and row-ordered tables', async () => {
  const bytes = submittedPptxFixture()
  expect(Buffer.from(bytes).includes(Buffer.from('第二页🙂'))).toBe(false)
  const result = await parse(bytes)
  expect(result).toEqual({ ...first, text: richText, paragraphCount: 6, tableCount: 1, hiddenShapeCount: 0,
    slides: [{ number: 1, hidden: false, hasNotes: true }, { number: 2, hidden: false, hasNotes: false }] })
  expect((await parse(bytes, { slideNumber: 2, section: 'slide' })).text).toBe(laterText)
})

it('reads strict OOXML namespaces and UTF-16 parts while leaving an external hyperlink inert', async () => {
  const parts = pptxFixtureParts({ strictNamespaces: true, externalHyperlink: 'http://127.0.0.1:1/must-never-fetch' })
  const name = 'ppt/slides/slide2.xml'
  const xml = parts[name]
  if (!xml) throw new Error('Missing explicit UTF-16 fixture part')
  parts[name] = Buffer.concat([Buffer.from([0xff, 0xfe]),
    Buffer.from(new TextDecoder().decode(xml).replace('encoding="UTF-8"', 'encoding="UTF-16"'), 'utf16le')])
  const result = await parse(submittedPptxFixture(parts))
  expect(result.text).toBe(richText)
  expect(result.text).not.toContain('127.0.0.1')
  expect(result.tableCount).toBe(1)
})

it('keeps notes separate, drops notes boilerplate, and reports hidden slides and grouped shapes', async () => {
  const bytes = submittedPptxFixture(pptxFixtureParts({ hiddenSlide: true, hiddenShape: true }))
  const body = await parse(bytes)
  expect(body.text).toBe(richText)
  expect(body.hiddenShapeCount).toBe(1)
  expect(body.slides[0]).toEqual({ number: 1, hidden: true, hasNotes: true })
  const notes = await parse(bytes, { ...first, section: 'notes' })
  expect(notes).toMatchObject({ section: 'notes', text: notesText, paragraphCount: 2, tableCount: 0, hiddenShapeCount: 0 })
  expect(notes.text).not.toMatch(/BOILERPLATE|第二页/u)
  expect(await parse(bytes, { slideNumber: 2, section: 'notes' })).toMatchObject({ text: '', paragraphCount: 0 })
})

it('rejects missing duplicate wrong-type and external slide or notes relationships without filename guesses', async () => {
  const cases: ReadonlyArray<readonly [string, (source: string) => string]> = [
    ['ppt/presentation.xml', source => source.replace('rIdSecond', 'missing')],
    ['ppt/_rels/presentation.xml.rels', source => source.replace('Id="rIdSecond"', 'Id="rIdFirst"')],
    ['ppt/_rels/presentation.xml.rels', source => source.replace('Target="slides/slide2.xml"', 'Target="slides/slide1.xml"')],
    ['ppt/_rels/presentation.xml.rels', source => source.replace('/slide" Target="slides/slide2.xml"', '/notesSlide" Target="slides/slide2.xml"')],
    ['ppt/_rels/presentation.xml.rels', source => source.replace('Target="slides/slide2.xml"', 'Target="https://example.invalid/a.xml" TargetMode="External"')],
    ['ppt/slides/_rels/slide2.xml.rels', source => source.replace('notesSlide1.xml', 'missing.xml')],
    ['ppt/slides/_rels/slide2.xml.rels', source => source.replace('</Relationships>',
      '<Relationship Id="second" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" '
      + 'Target="../notesSlides/notesSlide1.xml"/></Relationships>')],
    ['_rels/.rels', source => source.replace('/officeDocument"', '/slide"')],
  ]
  for (const [name, transform] of cases) {
    const parts = pptxFixtureParts()
    replacePptxPart(parts, name, transform)
    await expect(parse(submittedPptxFixture(parts)), name).rejects.toMatchObject(denied('invalid_input'))
  }
  const parts = pptxFixtureParts()
  delete parts['ppt/slides/slide2.xml']
  await expect(parse(submittedPptxFixture(parts))).rejects.toMatchObject(denied('invalid_input'))
  await expect(parse(submittedPptxFixture(), { slideNumber: 3, section: 'slide' })).rejects.toMatchObject(denied('invalid_input'))
})

it('rejects unsafe ZIP parts malformed or entity XML macro packages and non-presentation content', async () => {
  for (const path of ['../escape.xml', '/absolute.xml', 'ppt\\escape.xml', 'PPT/SLIDES/SLIDE2.XML', 'ppt/vbaProject.bin', 'ppt/activeX/activeX1.bin']) {
    const parts = pptxFixtureParts()
    parts[path] = strToU8('<unused/>')
    await expect(parse(submittedPptxFixture(parts)), path).rejects.toMatchObject(denied('invalid_input'))
  }
  for (const source of ['<unused><broken></unused>', '<!DOCTYPE x [<!ENTITY a "expanded">]><x>&a;</x>',
    '<!DOCTYPE x SYSTEM "http://127.0.0.1:1/no-resource"><x/>']) {
    const parts = pptxFixtureParts()
    parts['ppt/unused.xml'] = strToU8(source)
    await expect(parse(submittedPptxFixture(parts))).rejects.toMatchObject(denied('invalid_input'))
  }
  for (const type of ['application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']) {
    const parts = pptxFixtureParts()
    replacePptxPart(parts, '[Content_Types].xml', source => source.replace(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', type))
    await expect(parse(submittedPptxFixture(parts))).rejects.toMatchObject(denied('invalid_input'))
  }
  await expect(parse(strToU8('not a ZIP archive'))).rejects.toMatchObject(denied('invalid_input'))
})

it('enforces complete input entry expanded XML node slide and whole-deck text budgets', async () => {
  const parts = pptxFixtureParts()
  parts['ppt/media/unused.bin'] = new Uint8Array(8192)
  parts['ppt/unused.xml'] = strToU8(`<unused>${'x'.repeat(4096)}</unused>`)
  const bytes = submittedPptxFixture(parts)
  const entries = Object.values(parts)
  const inflated = entries.reduce((sum, entry) => sum + entry.byteLength, 0)
  const xmlBytes = Math.max(...Object.entries(parts).filter(([name]) => /\.(xml|rels)$/u.test(name)).map(([, entry]) => entry.byteLength))
  const characters = richText.length + laterText.length + notesText.length
  const exact: OfficePptxPolicy = { ...limits, maxBytes: bytes.length, maxArchiveEntries: entries.length,
    maxInflatedBytes: inflated, maxXmlBytes: xmlBytes, maxSlides: 2, maxTextCharacters: characters }
  expect((await parse(bytes, first, exact)).text).toBe(richText)
  const rejected: ReadonlyArray<OfficePptxPolicy> = [
    { ...exact, maxBytes: bytes.length - 1 }, { ...exact, maxArchiveEntries: entries.length - 1 },
    { ...exact, maxInflatedBytes: inflated - 1 }, { ...exact, maxXmlBytes: xmlBytes - 1 },
    { ...exact, maxNodes: 1 }, { ...exact, maxSlides: 1 }, { ...exact, maxTextCharacters: characters - 1 },
  ]
  for (const policy of rejected) await expect(parse(bytes, first, policy)).rejects.toMatchObject(denied('context_too_large'))
})

it('bounds complete escaped native output and continues without splitting Unicode or accepting a different section', async () => {
  const document = { ...await parse(submittedPptxFixture()), text: 'A🙂"\\\n中文\tZ' }
  const file: OfficeConversationFileReference = { id: brandString<OfficeDriveId>('00000000-0000-4000-8000-000000000001'),
    versionId: brandString<OfficeDriveVersionId>('00000000-0000-4000-8000-000000000002'), name: '讲稿"\\🙂.pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', byteLength: 1234, sha256: 'a'.repeat(64) }
  const input: OfficeConversationPptxReadInput = { captureId: brandString<OfficeConversationFilesCaptureId>('00000000-0000-4000-8000-000000000003'),
    fileId: file.id, ...first, offset: 0, maxCharacters: 16384 }
  const complete = officePptxWindow(file, input, document, limits.maxOutputBytes)
  const exact = nativeSize(complete)
  expect(officePptxWindow(file, input, document, exact)).toEqual(complete)
  const bounded = officePptxWindow(file, input, document, exact - 1)
  expect(nativeSize(bounded)).toBeLessThanOrEqual(exact - 1)
  expect(bounded.eof).toBe(false)
  expect(bounded.text + officePptxWindow(file, { ...input, offset: bounded.nextOffset }, document, exact).text).toBe(document.text)
  const beforeEmoji = officePptxWindow(file, { ...input, maxCharacters: 2 }, document, exact)
  expect(beforeEmoji.text).toBe('A')
  expect(beforeEmoji.nextOffset).toBe(1)
  expect(officePptxWindow(file, { ...input, offset: 1, maxCharacters: 2 }, document, exact).text).toBe('🙂')
  expect(() => officePptxWindow(file, { ...input, offset: 1, maxCharacters: 1 }, document, exact)).toThrow('next complete character')
  const invalidInputs: readonly OfficeConversationPptxReadInput[] = [{ ...input, offset: 2 },
    { ...input, offset: document.text.length + 1 }, { ...input, section: 'notes' }, { ...input, slideNumber: 2 }]
  for (const invalid of invalidInputs) {
    expect(() => officePptxWindow(file, invalid, document, exact)).toThrow('invalid or splits a character')
  }
  expect(() => officePptxWindow(file, input, document, 256)).toThrow('metadata exceeds')
  const noProgressBudget = nativeSize({ ...complete, text: '', eof: false })
  expect(() => officePptxWindow(file, input, document, noProgressBudget)).toThrow('next complete character')
  expect(officePptxWindow(file, { ...input, offset: document.text.length }, document, exact)).toMatchObject({ text: '', eof: true })
})

it('validates every explicit policy field and settles real workers and abort listeners on success error cancellation and timeout', async () => {
  const { timeoutMs: _timeout, ...incomplete } = limits
  for (const invalid of [undefined, incomplete, { ...limits, timeoutMs: 2147483648 }, { ...limits, maxBytes: NaN },
    { ...limits, workerMemoryMb: 31 }, { ...limits, enabled: true }]) {
    expect(() => resolveOfficePptxPolicy(invalid)).toThrow('complete finite explicit limits')
  }
  // oxlint-disable-next-line typescript/unbound-method -- The forwarding spy below preserves the actual Worker receiver with .call(this).
  const terminate = Worker.prototype.terminate
  let inFlightTermination = 0
  let terminated = 0
  const termination = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
    inFlightTermination++
    return terminate.call(this).finally(() => { inFlightTermination--; terminated++ })
  })
  try {
    const bytes = submittedPptxFixture()
    const finished = new AbortController()
    expect((await parse(bytes, first, limits, finished.signal)).text).toBe(richText)
    expect(getEventListeners(finished.signal, 'abort')).toHaveLength(0)
    await expect(parse(strToU8('bad archive'))).rejects.toMatchObject(denied('invalid_input'))
    const preaborted = new AbortController()
    const original = new Error('original caller cancellation')
    preaborted.abort(original)
    const before = termination.mock.calls.length
    await expect(parse(bytes, first, limits, preaborted.signal)).rejects.toBe(original)
    expect(termination).toHaveBeenCalledTimes(before)
    const canceled = new AbortController()
    const pending = parse(bytes, first, limits, canceled.signal)
    canceled.abort(original)
    await expect(pending).rejects.toBe(original)
    expect(getEventListeners(canceled.signal, 'abort')).toHaveLength(0)
    const deadline = new AbortController()
    await expect(parse(bytes, first, { ...limits, timeoutMs: 1 }, deadline.signal)).rejects.toMatchObject(denied('context_too_large'))
    expect(getEventListeners(deadline.signal, 'abort')).toHaveLength(0)
    expect(terminated).toBe(4)
    expect(inFlightTermination).toBe(0)
    expect(termination).toHaveBeenCalledTimes(4)
  } finally { termination.mockRestore() }
})
