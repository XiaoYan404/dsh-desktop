/** Real saved-cell parsing preserves finance lexemes and enforces complete archive, worker and native-result limits. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { unzipSync, zipSync } from 'fflate'
import { expect, it } from 'vitest'
import { extractOfficeXlsx, officeXlsxWindow, resolveOfficeXlsxPolicy } from '../src/xlsx.ts'
import type { OfficeConversationXlsxConfig, OfficeConversationXlsxReadInput } from '../src/xlsx-types.ts'
import type { OfficeConversationFileReference } from '../src/types.ts'
import { submittedXlsxAmount, submittedXlsxFixture } from './xlsx-fixture.ts'

const input = { captureId: randomUUID(), fileId: randomUUID(), sheetNumber: 1, offset: 0, maxCells: 256 } as OfficeConversationXlsxReadInput
const signal = () => new AbortController().signal
const parse = (bytes: Uint8Array, request = input) => extractOfficeXlsx(bytes, request, resolveOfficeXlsxPolicy(), signal())

it('reads compressed finance values and formula caches without losing precision, zero, false or missing-cache evidence', async () => {
  const bytes = submittedXlsxFixture()
  expect(bytes.includes(Buffer.from(submittedXlsxAmount))).toBe(false)
  const result = await parse(bytes)
  expect(result.sheets).toEqual([{ number: 1, name: '真实预算', state: 'visible', storedCells: 12 },
    { number: 2, name: '隐藏明细', state: 'veryHidden', storedCells: 1 }])
  expect(result.cells.map(cell => [cell.address, cell.kind, cell.value, cell.rawValue, cell.cacheState])).toEqual([
    ['A1', 'string', '已保存账本', '0', 'not_formula'],
    ['B1', 'number', submittedXlsxAmount, submittedXlsxAmount, 'not_formula'],
    ['C1', 'number', '1.2300E+05', '1.2300E+05', 'not_formula'],
    ['D1', 'date_serial', '60.000000000000001', '60.000000000000001', 'not_formula'],
    ['A2', 'number', '0', '0', 'present_may_be_stale'], ['B2', 'boolean', 'false', '0', 'present_may_be_stale'],
    ['C2', 'blank', null, null, 'missing'], ['D2', 'string', '', '', 'present_may_be_stale'],
    ['A3', 'string', '中文🙂 &lt; 原值', null, 'not_formula'], ['B3', 'string', '&lt;', '&lt;', 'present_may_be_stale'],
    ['C3', 'error', '#DIV/0!', '#DIV/0!', 'not_formula'], ['D3', 'blank', null, null, 'not_formula'],
  ])
  expect(result.cells.find(cell => cell.address === 'C2')?.formula?.text).toBe('WEBSERVICE("https://127.0.0.1:1/DO_NOT_FETCH")')
  expect(result.cells.find(cell => cell.address === 'D1')?.numberFormat).toBe('mm-dd-yy')
  expect(result.cells.find(cell => cell.address === 'B2')).toMatchObject({ hiddenRow: true, hiddenColumn: true })
  expect(result.dateSystem).toBe('1900')
  expect(JSON.stringify(result)).not.toContain('hyperlink')
})

it('keeps workbook order, sparse last-row coordinates and the original 1904 date epoch without expanding merged ranges', async () => {
  const bytes = submittedXlsxFixture({ date1904: true })
  const first = await parse(bytes, { ...input, maxCells: 3 })
  const second = await parse(bytes, { ...input, sheetNumber: 2 })
  expect(first.cells.map(cell => cell.address)).toEqual(['A1', 'B1', 'C1'])
  expect(first.totalCells).toBe(12)
  expect(first.dateSystem).toBe('1904')
  expect(second.cells).toHaveLength(1)
  expect(second.cells[0]).toMatchObject({ address: 'XFD1048576', row: 1048576, column: 16384, value: '-0.0000' })
})

it('opens existing independent-writer OPC and Strict-namespace spreadsheet fixtures through the real installed parser', async () => {
  const path = new URL('../../../client/ui-sidebar-documentpreview/tests/fixtures/excel-opc/combined.xlsx', import.meta.url)
  const original = new Uint8Array(await readFile(path))
  const parts = unzipSync(original)
  for (const [name, bytes] of Object.entries(parts)) {
    if (!/\.(xml|rels|vml)$/iu.test(name)) continue
    parts[name] = new TextEncoder().encode(new TextDecoder().decode(bytes)
      .replaceAll('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main')
      .replaceAll('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'))
  }
  const normal = await parse(original)
  const strict = await parse(new Uint8Array(zipSync(parts)))
  expect(strict).toEqual(normal)
  expect(normal.sheets.map(sheet => sheet.name)).toEqual(['数据', '隐藏页'])
  expect(normal.cells.find(cell => cell.address === 'B2')?.value).toBe('42')
})

it.each(['macro', 'external', 'connection', 'dtd', 'duplicate', 'ambiguous'] as const)(
  'rejects executable, external, malformed or ambiguous spreadsheet content (%s)', async (kind) => {
    const relation = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
    const bytes = submittedXlsxFixture(kind === 'macro' ? { contentType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' }
      : kind === 'external' ? { workbookRelations: `<Relationship Id="first" Type="${relation}worksheet" TargetMode="External" Target="https://127.0.0.1:1/DO_NOT_FETCH"/>` }
        : kind === 'connection' ? { workbookRelations: `<Relationship Id="connection" Type="${relation}connections" Target="connections.xml"/>` }
          : kind === 'dtd' ? { sheet: '<!DOCTYPE x [<!ENTITY secret "DO_NOT_EXPAND">]><x/>' }
            : kind === 'duplicate' ? { sheet: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"/><c r="A1"/></row></sheetData></worksheet>' }
              : { extra: { 'XL/WORKBOOK.XML': new Uint8Array([1]) } })
    await expect(parse(bytes)).rejects.toMatchObject({ code: 'invalid_input' })
  },
)

it.each<OfficeConversationXlsxConfig>([
  { maxBytes: 1 }, { maxArchiveEntries: 4 }, { maxInflatedBytes: 128 }, { maxXmlBytes: 128 },
  { maxNodes: 2 }, { maxWorksheets: 1 }, { maxCells: 2 }, { maxTextCharacters: 2 }, { timeoutMs: 1 },
])('bounds the complete XLSX archive, XML, sparse cells, text and worker (%j)', async (overrides) => {
  const bytes = submittedXlsxFixture({ extra: { 'xl/media/skipped.bin': new Uint8Array(1024 * 1024) } })
  await expect(extractOfficeXlsx(bytes, input, resolveOfficeXlsxPolicy(overrides), signal()))
    .rejects.toMatchObject({ code: 'context_too_large' })
})

it('cancels and awaits the actual spreadsheet worker with the original native error', async () => {
  const controller = new AbortController()
  const pending = extractOfficeXlsx(submittedXlsxFixture(), input, resolveOfficeXlsxPolicy(), controller.signal)
  const stopped = new Error('Original native spreadsheet tool stopped')
  controller.abort(stopped)
  await expect(pending).rejects.toBe(stopped)
})

it('bounds the complete escaped JSON with whole-cell continuation and refuses an oversized first formula or directory', async () => {
  const document = await parse(submittedXlsxFixture())
  const file = { id: input.fileId, versionId: randomUUID(), name: '预算.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', byteLength: 2000,
    sha256: 'a'.repeat(64) } as OfficeConversationFileReference
  const complete = officeXlsxWindow(file, document, 65536)
  const size = (value: typeof complete) => Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]))
  expect(officeXlsxWindow(file, document, size(complete))).toEqual(complete)
  const bounded = officeXlsxWindow(file, document, size(complete) - 1)
  expect(size(bounded)).toBeLessThanOrEqual(size(complete) - 1)
  expect(bounded.nextOffset).toBeLessThan(complete.nextOffset)
  const continued = await parse(submittedXlsxFixture(), { ...input, offset: bounded.nextOffset })
  expect([...bounded.cells, ...continued.cells]).toEqual(complete.cells)
  expect(() => officeXlsxWindow(file, document, 1)).toThrow('directory exceeds')
  const huge = { ...document, cells: [{ ...document.cells[0]!, formula: { text: '"\\中文🙂'.repeat(1000),
    type: 'normal' as const, sharedIndex: null, range: null } }] }
  expect(() => officeXlsxWindow(file, huge, 2048)).toThrow('next complete cell')
})
