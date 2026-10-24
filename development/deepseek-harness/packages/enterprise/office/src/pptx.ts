/** Isolated PPTX extraction returns saved slide or notes text without granting file access or registering tools. */
import { Worker } from 'node:worker_threads'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { OfficeError } from './error.ts'
import type { OfficeConversationFileReference } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeConversationFileSchemas } from './conversation-files.ts'
import { officePptxWorkerSource } from './pptx-worker.ts'
import type { OfficeConversationPptxRead, OfficeConversationPptxReadInput, OfficePptxExtraction,
  OfficeConversationPptxConfig, OfficePptxPolicy, OfficePptxSelection } from './pptx-types.ts'

/** Explicit presentation-reader resource limits; an omitted optional deployment remains disabled. */
export const officePptxConfig: Schema<OfficeConversationPptxConfig> = Schema.object({
  maxBytes: Schema.natural().min(1).max(64 * 1024 * 1024).required(),
  maxArchiveEntries: Schema.natural().min(1).max(10000).required(),
  maxInflatedBytes: Schema.natural().min(1).max(128 * 1024 * 1024).required(),
  maxXmlBytes: Schema.natural().min(1).max(32 * 1024 * 1024).required(),
  maxNodes: Schema.natural().min(1).max(2000000).required(),
  maxSlides: Schema.natural().min(1).max(10000).required(),
  maxTextCharacters: Schema.natural().min(1).max(2 * 1024 * 1024).required(),
  maxOutputBytes: Schema.natural().min(256).max(4 * 1024 * 1024).required(),
  timeoutMs: Schema.natural().min(1).max(30000).required(),
  workerMemoryMb: Schema.natural().min(32).max(512).required(),
})

const policy = z.object({
  maxBytes: z.number().int().min(1).max(64 * 1024 * 1024),
  maxArchiveEntries: z.number().int().min(1).max(10000),
  maxInflatedBytes: z.number().int().min(1).max(128 * 1024 * 1024),
  maxXmlBytes: z.number().int().min(1).max(32 * 1024 * 1024),
  maxNodes: z.number().int().min(1).max(2000000),
  maxSlides: z.number().int().min(1).max(10000),
  maxTextCharacters: z.number().int().min(1).max(2 * 1024 * 1024),
  maxOutputBytes: z.number().int().min(256).max(4 * 1024 * 1024),
  timeoutMs: z.number().int().min(1).max(30000),
  workerMemoryMb: z.number().int().min(32).max(512),
}).strict()
const selection = z.object({ slideNumber: z.number().int().min(1).max(10000), section: z.enum(['slide', 'notes']) }).strict()
/** Current submitted-file coordinates plus an explicit actual slide and separately selected saved section. */
export const officePptxReadInput = officeConversationFileSchemas.readDocx.extend(selection.shape).strict()
const slide = z.object({ number: z.number().int().min(1).max(10000), hidden: z.boolean(), hasNotes: z.boolean() }).strict()
const extraction = selection.extend({ slides: z.array(slide).max(10000), text: z.string().max(2 * 1024 * 1024),
  paragraphCount: z.number().int().nonnegative().max(2000000), tableCount: z.number().int().nonnegative().max(2000000),
  hiddenShapeCount: z.number().int().nonnegative().max(2000000),
}).strict()
const response = z.discriminatedUnion('ok', [
  extraction.extend({ ok: z.literal(true) }).refine(value => value.slides.length >= value.slideNumber
    && value.slides.every((entry, index) => entry.number === index + 1)),
  z.object({ ok: z.literal(false), code: z.enum(['invalid_input', 'context_too_large']) }).strict(),
])

/**
 * Validate explicit resource bounds without constructing deployment defaults or enabling a reader.
 * @param input - Every input, archive, XML, slide, text, output and worker limit.
 * @returns Complete finite limits; malformed configuration rejects before any worker is created.
 */
export function resolveOfficePptxPolicy(input: unknown): OfficePptxPolicy {
  const parsed = policy.safeParse(input)
  if (!parsed.success) throw new OfficeError('invalid_input', 'PPTX reading requires complete finite explicit limits')
  return parsed.data
}

/**
 * Extract one actual slide or notes section in an empty-environment worker and await its termination.
 * @param bytes - Actual immutable PPTX bytes; the future authority must authorize and verify them before calling.
 * @param input - Relationship-ordered slide position and explicitly chosen section.
 * @param limits - Complete validated limits returned by resolveOfficePptxPolicy.
 * @param signal - Original caller cancellation; no background parser survives settlement.
 * @returns Saved shape/table text and a bounded directory; malformed or over-budget packages return no content.
 */
export async function extractOfficePptx(bytes: Uint8Array, input: OfficePptxSelection,
  limits: OfficePptxPolicy, signal: AbortSignal): Promise<OfficePptxExtraction> {
  signal.throwIfAborted()
  limits = resolveOfficePptxPolicy(limits)
  const parsed = selection.safeParse(input)
  if (!parsed.success) throw new OfficeError('invalid_input', 'PPTX reading requires an actual slide and explicit section')
  if (bytes.byteLength > limits.maxBytes) throw new OfficeError('context_too_large', 'Submitted PPTX exceeds its input byte limit')
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(officePptxWorkerSource)}`), {
    workerData: { data: bytes, selection: parsed.data, policy: limits,
      zipModuleUrl: import.meta.resolve('fflate'), xmlModuleUrl: import.meta.resolve('fast-xml-parser') },
    execArgv: [], env: {},
    resourceLimits: { maxOldGenerationSizeMb: limits.workerMemoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const result = await new Promise<z.infer<typeof response>>((resolve, reject) => {
      worker.once('message', (message: unknown) => {
        const value = response.safeParse(message)
        if (!value.success) { reject(new OfficeError('conflict', 'Submitted PPTX parser response is unavailable')); return }
        resolve(value.data)
      })
      worker.once('error', (cause) => {
        reject(new OfficeError('context_too_large', 'Submitted PPTX parser resource limit or failure', { cause }))
      })
      worker.once('exit', () => { reject(new OfficeError('conflict', 'Submitted PPTX parser stopped before completion')) })
      abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Submitted PPTX read was canceled')) }
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { reject(new OfficeError('context_too_large', 'Submitted PPTX parsing exceeded its deadline')) }, limits.timeoutMs)
      if (signal.aborted) abort()
    })
    signal.throwIfAborted()
    if (!result.ok) throw new OfficeError(result.code, 'Submitted PPTX could not be read within its format and resource limits')
    if (result.slideNumber !== parsed.data.slideNumber || result.section !== parsed.data.section)
      throw new OfficeError('conflict', 'Submitted PPTX parser returned a different selection')
    return { slides: result.slides, slideNumber: result.slideNumber, section: result.section, text: result.text,
      paragraphCount: result.paragraphCount, tableCount: result.tableCount, hiddenShapeCount: result.hiddenShapeCount }
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}

/**
 * Bound the complete escaped native text result after the future authority's final permission check.
 * @param file - Current immutable authorized file metadata; this function grants no access itself.
 * @param input - Exact section and UTF-16 text window; offsets never split a surrogate pair.
 * @param document - Actual bounded extraction of that same section.
 * @param maxOutputBytes - Complete escaped native tool-content JSON UTF-8 bound.
 * @returns A precise continuation or a typed error when metadata or the next complete character cannot fit.
 */
export function officePptxWindow(file: OfficeConversationFileReference, input: OfficeConversationPptxReadInput,
  document: OfficePptxExtraction, maxOutputBytes: number): OfficeConversationPptxRead {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
    || input.slideNumber !== document.slideNumber || input.section !== document.section
    || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > document.text.length
    || !Number.isSafeInteger(input.maxCharacters) || input.maxCharacters < 1 || input.maxCharacters > 16384
    || input.offset > 0 && /[\uDC00-\uDFFF]/u.test(document.text.charAt(input.offset)))
    throw new OfficeError('invalid_input', 'PPTX selection or text window is invalid or splits a character')
  const make = (end: number): OfficeConversationPptxRead => ({ file, slides: document.slides,
    slideNumber: document.slideNumber, section: document.section, paragraphCount: document.paragraphCount,
    tableCount: document.tableCount, hiddenShapeCount: document.hiddenShapeCount,
    offset: input.offset, nextOffset: end, totalCharacters: document.text.length,
    eof: end === document.text.length, text: document.text.slice(input.offset, end) })
  const size = (value: OfficeConversationPptxRead) => Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]))
  let maximum = Math.min(document.text.length, input.offset + input.maxCharacters)
  if (maximum < document.text.length && /[\uD800-\uDBFF]/u.test(document.text.charAt(maximum - 1))) maximum--
  if (maximum === input.offset && maximum < document.text.length)
    throw new OfficeError('context_too_large', 'Submitted PPTX character window cannot fit the next complete character')
  const complete = make(maximum)
  if (size(complete) <= maxOutputBytes) return complete
  const overhead = Math.max(size(make(input.offset)), size({ ...complete, text: '', eof: false }))
  if (overhead > maxOutputBytes) throw new OfficeError('context_too_large', 'Submitted PPTX metadata exceeds its output budget')
  let used = overhead
  let end = input.offset
  const emptyEscapedBytes = Buffer.byteLength(JSON.stringify(JSON.stringify('')))
  for (const character of complete.text) {
    const cost = Buffer.byteLength(JSON.stringify(JSON.stringify(character))) - emptyEscapedBytes
    if (used + cost > maxOutputBytes) break
    used += cost
    end += character.length
  }
  if (end === input.offset && end < document.text.length)
    throw new OfficeError('context_too_large', 'Submitted PPTX output budget cannot fit the next complete character')
  return make(end)
}
