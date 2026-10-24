/** Bounded PDF extraction owns one disposable worker and retains no full-document attachment cache. */
import { Worker } from 'node:worker_threads'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { OfficeError } from './error.ts'
import { officePdfWorkerSource } from './pdf-worker.ts'
import type { OfficeConversationFileReference, OfficeConversationPdfConfig, OfficeConversationPdfRead,
  OfficeConversationPdfReadInput } from './types.ts'

/** Validated deployment configuration; every extraction also enforces the resolved limits. */
export const officePdfConfig: Schema<OfficeConversationPdfConfig> = Schema.object({
  maxBytes: Schema.natural().min(1).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  maxPages: Schema.natural().min(1).max(2000).default(200),
  maxPageCharacters: Schema.natural().min(1).max(2 * 1024 * 1024).default(262144),
  maxOutputBytes: Schema.natural().min(256).max(4 * 1024 * 1024).default(65536),
  timeoutMs: Schema.natural().min(1).max(30000).default(5000),
  workerMemoryMb: Schema.natural().min(32).max(512).default(128),
})

/** Resolved, finite resource policy captured at office startup. */
export type OfficePdfPolicy = Required<OfficeConversationPdfConfig>

/**
 * Resolve deployment defaults before any PDF operation is admitted.
 * @param config - Optional deployment overrides.
 * @returns Validated complete resource policy.
 */
export function resolveOfficePdfPolicy(config: OfficeConversationPdfConfig = {}): OfficePdfPolicy {
  return officePdfConfig(config) as OfficePdfPolicy
}

const response = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), pageCount: z.number().int().min(1).max(2000), text: z.string().max(2 * 1024 * 1024) }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['invalid_input', 'context_too_large']) }).strict(),
])

/**
 * Read the actual PDF text in an isolated parser and await its termination before settling.
 * @param bytes - Verified bytes; the caller checks the input limit before allocating these bytes.
 * @param pageNumber - One-based selected page.
 * @param policy - Complete deployment limits.
 * @param signal - Office lifetime and optional original tool cancellation.
 * @returns Extracted page text and actual document page count; no binary bytes are cached.
 */
export async function extractOfficePdf(bytes: Uint8Array, pageNumber: number, policy: OfficePdfPolicy,
  signal: AbortSignal): Promise<{ readonly pageCount: number; readonly text: string }> {
  signal.throwIfAborted()
  if (bytes.byteLength > policy.maxBytes) throw new OfficeError('context_too_large', 'Submitted PDF exceeds its byte limit')
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(officePdfWorkerSource)}`), {
    workerData: { moduleUrl: import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'), data: bytes, pageNumber,
      maxPages: policy.maxPages, maxPageCharacters: policy.maxPageCharacters },
    execArgv: [], env: {},
    resourceLimits: { maxOldGenerationSizeMb: policy.workerMemoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const result = await new Promise<z.infer<typeof response>>((resolve, reject) => {
      worker.once('message', (message: unknown) => {
        const parsed = response.safeParse(message)
        if (!parsed.success) { reject(new OfficeError('conflict', 'Submitted PDF parser response is unavailable')); return }
        resolve(parsed.data)
      })
      worker.once('error', (cause) => { reject(new OfficeError('context_too_large', 'Submitted PDF parser resource limit or failure', { cause })) })
      worker.once('exit', () => { reject(new OfficeError('conflict', 'Submitted PDF parser stopped before completion')) })
      abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Submitted PDF read was canceled')) }
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { reject(new OfficeError('context_too_large', 'Submitted PDF parsing exceeded its deadline')) }, policy.timeoutMs)
      if (signal.aborted) abort()
    })
    signal.throwIfAborted()
    if (!result.ok) throw new OfficeError(result.code, 'Submitted PDF could not be read within its format and resource limits')
    return { pageCount: result.pageCount, text: result.text }
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}

/**
 * Fit one complete native tool-content JSON value, including escaping and metadata, into its byte budget.
 * @param file - Trusted immutable metadata after the authority's final recheck.
 * @param input - Selected page and character window.
 * @param page - Fully parsed but bounded page text.
 * @param maxOutputBytes - Complete native tool-content UTF-8 byte budget.
 * @returns An exact character continuation; a window never splits a Unicode surrogate pair.
 */
export function officePdfWindow(file: OfficeConversationFileReference, input: OfficeConversationPdfReadInput,
  page: { readonly pageCount: number; readonly text: string }, maxOutputBytes: number): OfficeConversationPdfRead {
  const { text, pageCount } = page
  if (input.offset > text.length || (input.offset > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(input.offset))))
    throw new OfficeError('invalid_input', 'PDF text offset is out of range or splits a character')
  const result = (end: number): OfficeConversationPdfRead => ({ file, pageNumber: input.pageNumber, pageCount,
    offset: input.offset, nextOffset: end, totalCharacters: text.length, eof: end === text.length, text: text.slice(input.offset, end) })
  const size = (value: OfficeConversationPdfRead) => Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]))
  let end = Math.min(text.length, input.offset + input.maxCharacters)
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end++
  if (size(result(input.offset)) > maxOutputBytes)
    throw new OfficeError('context_too_large', 'Submitted PDF metadata exceeds its output budget')
  const ends = [input.offset]
  let cursor = input.offset
  for (const character of text.slice(input.offset, end)) { cursor += character.length; ends.push(cursor) }
  let low = 0
  let high = ends.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (size(result(ends[middle] as number)) <= maxOutputBytes) low = middle
    else high = middle - 1
  }
  end = ends[low] as number
  if (end === input.offset && end < text.length)
    throw new OfficeError('context_too_large', 'Submitted PDF output budget cannot fit the next character')
  return result(end)
}
