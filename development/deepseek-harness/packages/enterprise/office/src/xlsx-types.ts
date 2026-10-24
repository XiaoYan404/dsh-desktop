/** Submitted spreadsheets expose exact saved values without native attachment copies or formula execution. */
import type { OfficeConversationFileReadInput, OfficeConversationFileReference } from './types.ts'

/** One sparse cell window in workbook sheet order; offsets count stored cells, including explicit blanks. */
export interface OfficeConversationXlsxReadInput extends Pick<OfficeConversationFileReadInput, 'captureId' | 'fileId'> {
  readonly sheetNumber: number
  readonly offset: number
  readonly maxCells: number
}

/** Exact saved cell evidence; numeric values and date serials remain XML lexical strings. */
export interface OfficeConversationXlsxCell {
  readonly address: string
  readonly row: number
  readonly column: number
  readonly hiddenRow: boolean
  readonly hiddenColumn: boolean
  readonly kind: 'blank' | 'string' | 'number' | 'boolean' | 'error' | 'date_serial' | 'iso_date'
  readonly value: string | null
  readonly rawValue: string | null
  readonly numberFormat: string
  readonly formula: {
    readonly text: string
    readonly type: 'normal' | 'shared' | 'array' | 'dataTable'
    readonly sharedIndex: string | null
    readonly range: string | null
  } | null
  readonly cacheState: 'not_formula' | 'present_may_be_stale' | 'missing'
}

/** Bounded directory retains workbook order and hidden worksheet state. */
export interface OfficeConversationXlsxSheet {
  readonly number: number
  readonly name: string
  readonly state: 'visible' | 'hidden' | 'veryHidden'
  readonly storedCells: number
}

/** Actual saved spreadsheet values and formula caches, never recalculated or visually formatted. */
export interface OfficeConversationXlsxRead {
  readonly file: OfficeConversationFileReference
  readonly sheets: readonly OfficeConversationXlsxSheet[]
  readonly sheetNumber: number
  readonly dateSystem: '1900' | '1904'
  readonly offset: number
  readonly nextOffset: number
  readonly totalCells: number
  readonly eof: boolean
  readonly cells: readonly OfficeConversationXlsxCell[]
}

/** Deployment bounds for isolated XLSX archive checks and exact saved-cell extraction. */
export interface OfficeConversationXlsxConfig {
  /** Compressed bytes checked before full allocation or worker creation; defaults to 8 MiB. */
  readonly maxBytes?: number
  /** Complete archive entry count, including skipped media; defaults to 2,048. */
  readonly maxArchiveEntries?: number
  /** Sum of declared expanded bytes across the complete ZIP; defaults to 32 MiB. */
  readonly maxInflatedBytes?: number
  /** Bytes in any XML, relationship or VML part; defaults to 8 MiB. */
  readonly maxXmlBytes?: number
  /** XML nodes inspected before workbook decoding; defaults to 500,000. */
  readonly maxNodes?: number
  /** Complete workbook worksheet count; defaults to 32. */
  readonly maxWorksheets?: number
  /** Stored cells across all sheets, including explicit blanks; defaults to 100,000. */
  readonly maxCells?: number
  /** Extracted values, raw values, formulas, formats and sheet names in UTF-16 code units; defaults to 1 Mi. */
  readonly maxTextCharacters?: number
  /** Complete escaped native tool-content JSON UTF-8 bytes; defaults to 64 KiB. */
  readonly maxOutputBytes?: number
  /** Worker wall-clock deadline in milliseconds; defaults to 5,000. */
  readonly timeoutMs?: number
  /** Worker V8 old-generation heap limit in MiB; defaults to 256. */
  readonly workerMemoryMb?: number
}
