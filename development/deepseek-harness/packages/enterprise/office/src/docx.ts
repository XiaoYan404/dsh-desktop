/** Bounded DOCX extraction reads real body XML in one disposable worker without publishing document copies. */
import { Worker } from 'node:worker_threads'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { OfficeError } from './error.ts'
import { officeDocxWorkerSource } from './docx-worker.ts'
import type { OfficeConversationDocxConfig, OfficeConversationDocxRead, OfficeConversationDocxReadInput } from './docx-types.ts'
import type { OfficeConversationFileReference } from './types.ts'

/** Validated deployment bounds for compressed packages, parsed XML, extracted text and retained tool content. */
export const officeDocxConfig: Schema<OfficeConversationDocxConfig> = Schema.object({
  maxBytes: Schema.natural().min(1).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  maxArchiveEntries: Schema.natural().min(3).max(10000).default(1024),
  maxInflatedBytes: Schema.natural().min(1).max(128 * 1024 * 1024).default(32 * 1024 * 1024),
  maxXmlBytes: Schema.natural().min(1).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
  maxNodes: Schema.natural().min(1).max(1000000).default(100000),
  maxTextCharacters: Schema.natural().min(1).max(2 * 1024 * 1024).default(1024 * 1024),
  maxOutputBytes: Schema.natural().min(256).max(4 * 1024 * 1024).default(65536),
  timeoutMs: Schema.natural().min(1).max(30000).default(5000),
  workerMemoryMb: Schema.natural().min(32).max(512).default(128),
})

/** Complete finite policy captured before submitted Word reads can begin. */
export type OfficeDocxPolicy = Required<OfficeConversationDocxConfig>

/** Actual main-document paragraphs and tables, without layout or external-resource interpretation. */
export interface OfficeDocxText {
  readonly text: string
  readonly paragraphCount: number
  readonly tableCount: number
}

/**
 * Resolve all DOCX deployment limits at startup.
 * @param config - Optional explicit overrides.
 * @returns Complete validated limits; invalid values fail activation.
 */
export function resolveOfficeDocxPolicy(config: OfficeConversationDocxConfig = {}): OfficeDocxPolicy {
  return officeDocxConfig(config) as OfficeDocxPolicy
}

const response = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string().max(2 * 1024 * 1024),
    paragraphCount: z.number().int().nonnegative().max(1000000), tableCount: z.number().int().nonnegative().max(1000000) }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['invalid_input', 'context_too_large']) }).strict(),
])

/**
 * Extract verified compressed DOCX bytes in an isolated bounded parser and await its termination.
 * @param bytes - Actual office bytes; the authority checks the same input limit before allocating them.
 * @param policy - Complete archive, XML, text, worker and result limits.
 * @param signal - Original tool or transport cancellation combined with office lifetime.
 * @returns Main-document paragraph and table text; malformed and over-budget input yields no body.
 */
export async function extractOfficeDocx(bytes: Uint8Array, policy: OfficeDocxPolicy, signal: AbortSignal): Promise<OfficeDocxText> {
  signal.throwIfAborted()
  if (bytes.byteLength > policy.maxBytes) throw new OfficeError('context_too_large', 'Submitted DOCX exceeds its input byte limit')
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(officeDocxWorkerSource)}`), {
    workerData: { data: bytes, policy, zipModuleUrl: import.meta.resolve('fflate'), xmlModuleUrl: import.meta.resolve('fast-xml-parser') },
    execArgv: [], env: {},
    resourceLimits: { maxOldGenerationSizeMb: policy.workerMemoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const result = await new Promise<z.infer<typeof response>>((resolve, reject) => {
      worker.once('message', (message: unknown) => {
        const parsed = response.safeParse(message)
        if (!parsed.success) { reject(new OfficeError('conflict', 'Submitted DOCX parser response is unavailable')); return }
        resolve(parsed.data)
      })
      worker.once('error', (cause) => { reject(new OfficeError('context_too_large', 'Submitted DOCX parser resource limit or failure', { cause })) })
      worker.once('exit', () => { reject(new OfficeError('conflict', 'Submitted DOCX parser stopped before completion')) })
      abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Submitted DOCX read was canceled')) }
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { reject(new OfficeError('context_too_large', 'Submitted DOCX parsing exceeded its deadline')) }, policy.timeoutMs)
      if (signal.aborted) abort()
    })
    signal.throwIfAborted()
    if (!result.ok) throw new OfficeError(result.code, 'Submitted DOCX could not be read within its format and resource limits')
    return { text: result.text, paragraphCount: result.paragraphCount, tableCount: result.tableCount }
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}

/**
 * Bound complete escaped native tool-content bytes while preserving exact UTF-16 continuations.
 * @param file - Immutable authority-resolved metadata after the final permission check.
 * @param input - Reviewed file and bounded character window.
 * @param document - Actual bounded paragraph/table extraction.
 * @param maxOutputBytes - Complete native tool-content UTF-8 byte budget.
 * @returns An inert text window with counts and continuation; surrogate pairs remain complete.
 */
export function officeDocxWindow(file: OfficeConversationFileReference, input: OfficeConversationDocxReadInput,
  document: OfficeDocxText, maxOutputBytes: number): OfficeConversationDocxRead {
  if (input.offset > document.text.length || input.offset > 0 && /[\uDC00-\uDFFF]/u.test(document.text.charAt(input.offset)))
    throw new OfficeError('invalid_input', 'DOCX text offset is out of range or splits a character')
  const make = (end: number): OfficeConversationDocxRead => ({ file,
    paragraphCount: document.paragraphCount, tableCount: document.tableCount,
    offset: input.offset, nextOffset: end, totalCharacters: document.text.length, eof: end === document.text.length,
    text: document.text.slice(input.offset, end) })
  const size = (value: OfficeConversationDocxRead) => Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]))
  let maximum = Math.min(document.text.length, input.offset + input.maxCharacters)
  if (maximum < document.text.length && /[\uD800-\uDBFF]/u.test(document.text.charAt(maximum - 1))) maximum++
  const complete = make(maximum)
  if (size(complete) <= maxOutputBytes) return complete
  const empty = make(input.offset)
  const overhead = Math.max(size(empty), size({ ...complete, text: '' }))
  if (overhead > maxOutputBytes) throw new OfficeError('context_too_large', 'Submitted DOCX metadata exceeds its output budget')
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
    throw new OfficeError('context_too_large', 'Submitted DOCX output budget cannot fit the next character')
  return make(end)
}
