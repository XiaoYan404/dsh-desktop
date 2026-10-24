/** Isolated XLSX reading preserves exact saved numeric lexemes and bounds the complete native result. */
import { Worker } from 'node:worker_threads'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { OfficeError } from './error.ts'
import { officeXlsxWorkerSource } from './xlsx-worker.ts'
import type { OfficeConversationFileReference } from './types.ts'
import type { OfficeConversationXlsxConfig, OfficeConversationXlsxRead, OfficeConversationXlsxReadInput } from './xlsx-types.ts'

/** Validated archive, worksheet, sparse-cell, worker and complete-result deployment bounds. */
export const officeXlsxConfig: Schema<OfficeConversationXlsxConfig> = Schema.object({
  maxBytes: Schema.natural().min(1).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  maxArchiveEntries: Schema.natural().min(4).max(10000).default(2048),
  maxInflatedBytes: Schema.natural().min(1).max(128 * 1024 * 1024).default(32 * 1024 * 1024),
  maxXmlBytes: Schema.natural().min(1).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
  maxNodes: Schema.natural().min(1).max(2000000).default(500000),
  maxWorksheets: Schema.natural().min(1).max(256).default(32),
  maxCells: Schema.natural().min(1).max(1000000).default(100000),
  maxTextCharacters: Schema.natural().min(1).max(2 * 1024 * 1024).default(1024 * 1024),
  maxOutputBytes: Schema.natural().min(256).max(4 * 1024 * 1024).default(65536),
  timeoutMs: Schema.natural().min(1).max(30000).default(5000),
  workerMemoryMb: Schema.natural().min(32).max(512).default(256),
})

/** Fully resolved startup policy for one bounded spreadsheet parser. */
export type OfficeXlsxPolicy = Required<OfficeConversationXlsxConfig>

/**
 * Resolve XLSX deployment limits before reads are admitted.
 * @param config - Optional explicit policy overrides.
 * @returns Complete validated finite limits; invalid values fail activation.
 */
export function resolveOfficeXlsxPolicy(config: OfficeConversationXlsxConfig = {}): OfficeXlsxPolicy {
  return officeXlsxConfig(config) as OfficeXlsxPolicy
}

const cell = z.object({ address: z.string().max(10), row: z.number().int().min(1).max(1048576),
  column: z.number().int().min(1).max(16384), hiddenRow: z.boolean(), hiddenColumn: z.boolean(),
  kind: z.enum(['blank', 'string', 'number', 'boolean', 'error', 'date_serial', 'iso_date']),
  value: z.string().nullable(), rawValue: z.string().nullable(), numberFormat: z.string(),
  formula: z.object({ text: z.string(), type: z.enum(['normal', 'shared', 'array', 'dataTable']),
    sharedIndex: z.string().nullable(), range: z.string().nullable() }).strict().nullable(),
  cacheState: z.enum(['not_formula', 'present_may_be_stale', 'missing']),
}).strict()
const sheet = z.object({ number: z.number().int().min(1).max(256), name: z.string().max(31),
  state: z.enum(['visible', 'hidden', 'veryHidden']), storedCells: z.number().int().nonnegative().max(1000000) }).strict()
const extracted = z.object({ sheets: z.array(sheet).max(256),
  sheetNumber: z.number().int().min(1).max(256), dateSystem: z.enum(['1900', '1904']),
  offset: z.number().int().nonnegative().max(1000000), totalCells: z.number().int().nonnegative().max(1000000),
  cells: z.array(cell).max(256),
}).strict()
const response = z.discriminatedUnion('ok', [extracted.extend({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.enum(['invalid_input', 'context_too_large']) }).strict()])

/** Actual worksheet directory and one sparse saved-cell window returned from an isolated parser. */
export type OfficeXlsxExtraction = z.infer<typeof extracted>

/**
 * Decode verified XLSX bytes with exact XML values and the installed workbook parser in a disposable worker.
 * @param bytes - Actual SHA-256-verified bytes; the authority checks the same size before allocating them.
 * @param input - Exact submitted worksheet and sparse-cell continuation.
 * @param policy - Resolved archive, XML, cell, text, time and heap limits.
 * @param signal - Original tool/transport cancellation combined with office lifetime.
 * @returns Actual saved-cell evidence; malformed, executable and over-budget files disclose no cells.
 */
export async function extractOfficeXlsx(bytes: Uint8Array, input: Pick<OfficeConversationXlsxReadInput, 'sheetNumber' | 'offset' | 'maxCells'>,
  policy: OfficeXlsxPolicy, signal: AbortSignal): Promise<OfficeXlsxExtraction> {
  signal.throwIfAborted()
  if (bytes.byteLength > policy.maxBytes) throw new OfficeError('context_too_large', 'Submitted XLSX exceeds its input byte limit')
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(officeXlsxWorkerSource)}`), {
    workerData: { data: bytes, input, policy, zipModuleUrl: import.meta.resolve('fflate'),
      xmlModuleUrl: import.meta.resolve('fast-xml-parser'), excelModuleUrl: import.meta.resolve('exceljs') },
    execArgv: [], env: {},
    resourceLimits: { maxOldGenerationSizeMb: policy.workerMemoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const result = await new Promise<z.infer<typeof response>>((resolve, reject) => {
      worker.once('message', (message: unknown) => {
        const parsed = response.safeParse(message)
        if (!parsed.success) { reject(new OfficeError('conflict', 'Submitted XLSX parser response is unavailable')); return }
        resolve(parsed.data)
      })
      worker.once('error', (cause) => { reject(new OfficeError('context_too_large', 'Submitted XLSX parser resource limit or failure', { cause })) })
      worker.once('exit', () => { reject(new OfficeError('conflict', 'Submitted XLSX parser stopped before completion')) })
      abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Submitted XLSX read was canceled')) }
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { reject(new OfficeError('context_too_large', 'Submitted XLSX parsing exceeded its deadline')) }, policy.timeoutMs)
      if (signal.aborted) abort()
    })
    signal.throwIfAborted()
    if (!result.ok) throw new OfficeError(result.code, 'Submitted XLSX could not be read within its format and resource limits')
    const { ok: _ok, ...value } = result
    return value
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}

/**
 * Fit whole cells and the complete worksheet directory within the escaped native content byte budget.
 * @param file - Authority-resolved immutable metadata after the final queued permission check.
 * @param document - Actual bounded sparse window from the worker.
 * @param maxOutputBytes - UTF-8 bytes of the complete native text-content JSON, including metadata.
 * @returns A whole-cell prefix and exact continuation; no numeric value, formula or directory is truncated.
 */
export function officeXlsxWindow(file: OfficeConversationFileReference, document: OfficeXlsxExtraction,
  maxOutputBytes: number): OfficeConversationXlsxRead {
  const make = (count: number): OfficeConversationXlsxRead => ({ file, sheets: document.sheets,
    sheetNumber: document.sheetNumber, dateSystem: document.dateSystem,
    offset: document.offset, nextOffset: document.offset + count, totalCells: document.totalCells,
    eof: document.offset + count === document.totalCells, cells: document.cells.slice(0, count) })
  const size = (value: OfficeConversationXlsxRead) => Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]))
  const empty = make(0)
  if (size(empty) > maxOutputBytes) throw new OfficeError('context_too_large', 'Submitted XLSX directory exceeds its output budget')
  let count = 0
  let cellBytes = 0
  for (const cell of document.cells) {
    const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify(cell))) - 2 + (count > 0 ? 1 : 0)
    const overhead = size({ ...make(count + 1), cells: [] })
    if (overhead + cellBytes + bytes > maxOutputBytes) break
    cellBytes += bytes
    count++
  }
  if (count === 0 && document.offset < document.totalCells)
    throw new OfficeError('context_too_large', 'Submitted XLSX output budget cannot fit the next complete cell')
  return make(count)
}
