/** Knowledge extraction reuses the existing bounded document workers and preserves source positions. */
import { extractOfficeDocx } from './docx.ts'
import type { OfficeDocxPolicy } from './docx.ts'
import { extractOfficePdf } from './pdf.ts'
import type { OfficePdfPolicy } from './pdf.ts'
import { extractOfficePptx } from './pptx.ts'
import type { OfficePptxPolicy } from './pptx-types.ts'
import { extractOfficeXlsx } from './xlsx.ts'
import type { OfficeXlsxPolicy } from './xlsx.ts'
import { OfficeError } from './error.ts'
import type { OfficeConversationFileReference } from './types.ts'
import type { OfficeKnowledgePolicy, OfficeKnowledgeUnit } from './knowledge-types.ts'

/** Parser policies remain owned by the same Office deployment as ordinary submitted-file readers. */
export interface OfficeKnowledgeParsers {
  readonly pdf: OfficePdfPolicy
  readonly docx: OfficeDocxPolicy
  readonly xlsx: OfficeXlsxPolicy
  readonly pptx?: OfficePptxPolicy
}

/** Shared extraction bounds for knowledge publication and explicit office-delivery checks. */
export type OfficeDocumentExtractionPolicy = Pick<OfficeKnowledgePolicy,
  'maxSourceBytes' | 'maxDocumentCharacters' | 'maxSections' | 'timeoutMs'>

/**
 * Determine the input bound before the owner allocates actual file bytes.
 * @param file - Current authority-resolved source metadata.
 * @param policy - Explicit knowledge source-byte limit.
 * @param parsers - Existing supported-format parser policies; absent PPTX stays unavailable.
 * @returns Minimum applicable source byte limit; unsupported formats are rejected.
 */
export function officeKnowledgeSourceLimit(file: OfficeConversationFileReference, policy: Pick<OfficeKnowledgePolicy, 'maxSourceBytes'>,
  parsers: OfficeKnowledgeParsers): number {
  const kind = format(file)
  const parser = kind === 'text' ? undefined : parsers[kind]
  if (kind === 'pptx' && !parser) throw new OfficeError('invalid_input', 'Presentation text reading is not configured')
  return Math.min(policy.maxSourceBytes, parser?.maxBytes ?? policy.maxSourceBytes)
}

function format(file: OfficeConversationFileReference): OfficeKnowledgeUnit['location']['kind'] {
  const media = file.mediaType.split(';', 1)[0]?.trim().toLowerCase()
  if (media === 'application/pdf') return 'pdf'
  if (media === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (media === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx'
  if (media === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx'
  if (media?.startsWith('text/') || media === 'application/json') return 'text'
  throw new OfficeError('invalid_input', 'Knowledge indexing supports UTF-8, PDF text, DOCX, saved XLSX cells and configured PPTX text')
}

/**
 * Parse actual verified bytes with the existing workers; no image OCR, formula evaluation or external refresh is introduced.
 * @param file - Current immutable source identity.
 * @param bytes - Length/digest-verified bytes, allocated only after the input bound passed.
 * @param policy - Explicit total characters, section count and operation deadline.
 * @param parsers - Resolved existing document parser limits.
 * @param original - Original request and Office lifetime cancellation.
 * @returns Exact body/page/slide/cell units with original format positions.
 */
export async function extractOfficeKnowledge(file: OfficeConversationFileReference, bytes: Uint8Array,
  policy: OfficeDocumentExtractionPolicy, parsers: OfficeKnowledgeParsers, original: AbortSignal): Promise<readonly OfficeKnowledgeUnit[]> {
  const signal = AbortSignal.any([original, AbortSignal.timeout(policy.timeoutMs)])
  signal.throwIfAborted()
  if (bytes.byteLength > officeKnowledgeSourceLimit(file, policy, parsers)) throw new OfficeError('context_too_large', 'Knowledge source exceeds its byte limit')
  const kind = format(file)
  const units: OfficeKnowledgeUnit[] = []
  let characters = 0
  const add = (part: number, text: string, label = '') => {
    signal.throwIfAborted()
    characters += text.length
    if (part > policy.maxSections || characters > policy.maxDocumentCharacters)
      throw new OfficeError('context_too_large', 'Knowledge extraction exceeds its total section or text limit')
    units.push({ location: { kind, part, offset: 0, label }, text })
  }
  if (kind === 'text') {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch (cause) { throw new OfficeError('invalid_input', 'Knowledge text is not valid UTF-8', { cause }) }
    if (text.includes('\0')) throw new OfficeError('invalid_input', 'Binary text is not a knowledge document')
    add(1, text)
  } else if (kind === 'docx') add(1, (await extractOfficeDocx(bytes, parsers.docx, signal)).text)
  else if (kind === 'pdf') {
    const first = await extractOfficePdf(bytes, 1, parsers.pdf, signal)
    if (first.pageCount > policy.maxSections) throw new OfficeError('context_too_large', 'Knowledge PDF section limit exceeded')
    add(1, first.text)
    for (let page = 2; page <= first.pageCount; page++) add(page, (await extractOfficePdf(bytes, page, parsers.pdf, signal)).text)
  } else if (kind === 'pptx') {
    if (!parsers.pptx) throw new OfficeError('invalid_input', 'Presentation text reading is not configured')
    const first = await extractOfficePptx(bytes, { slideNumber: 1, section: 'slide' }, parsers.pptx, signal)
    if (first.slides.length > policy.maxSections) throw new OfficeError('context_too_large', 'Knowledge presentation section limit exceeded')
    add(1, first.text)
    for (let slide = 2; slide <= first.slides.length; slide++)
      add(slide, (await extractOfficePptx(bytes, { slideNumber: slide, section: 'slide' }, parsers.pptx, signal)).text)
  } else {
    let totalSheets = 1
    for (let sheet = 1; sheet <= totalSheets; sheet++) {
      let offset = 0
      for (;;) {
        const extracted = await extractOfficeXlsx(bytes, { sheetNumber: sheet, offset, maxCells: 256 }, parsers.xlsx, signal)
        totalSheets = extracted.sheets.length
        if (totalSheets > policy.maxSections) throw new OfficeError('context_too_large', 'Knowledge workbook section limit exceeded')
        const selected = extracted.sheets.find(row => row.number === sheet)
        for (const cell of extracted.cells) add(sheet, JSON.stringify({ dateSystem: extracted.dateSystem, ...cell }),
          `${selected?.name ?? ''}!${cell.address}`)
        offset += extracted.cells.length
        if (offset >= extracted.totalCells) break
        if (!extracted.cells.length) throw new OfficeError('conflict', 'Knowledge workbook parser made no progress')
      }
    }
  }
  signal.throwIfAborted()
  return units
}
