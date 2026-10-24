/** Submitted Word body extraction is independent of durable file selection and native attachments. */
import type { OfficeConversationFileReadInput, OfficeConversationFileReference } from './types.ts'

/** One bounded UTF-16 window from actual DOCX main-document paragraph and table text. */
export type OfficeConversationDocxReadInput = OfficeConversationFileReadInput

/** Actual Word body text; tabs separate cells and line breaks separate paragraphs and table rows. */
export interface OfficeConversationDocxRead {
  readonly file: OfficeConversationFileReference
  readonly paragraphCount: number
  readonly tableCount: number
  readonly offset: number
  readonly nextOffset: number
  readonly totalCharacters: number
  readonly eof: boolean
  readonly text: string
}

/** Deployment limits for isolated DOCX main-document extraction. */
export interface OfficeConversationDocxConfig {
  /** Compressed input bytes, checked before full allocation or worker creation; defaults to 8 MiB. */
  readonly maxBytes?: number
  /** ZIP entries, including skipped media; defaults to 1,024. */
  readonly maxArchiveEntries?: number
  /** Sum of declared expanded ZIP entry bytes; defaults to 32 MiB. */
  readonly maxInflatedBytes?: number
  /** Bytes in any parsed XML package part; defaults to 8 MiB. */
  readonly maxXmlBytes?: number
  /** XML elements and text nodes visited during extraction; defaults to 100,000. */
  readonly maxNodes?: number
  /** Extracted main-document UTF-16 code units; defaults to 1 Mi. */
  readonly maxTextCharacters?: number
  /** Complete escaped native tool-content JSON UTF-8 bytes; defaults to 64 KiB. */
  readonly maxOutputBytes?: number
  /** Worker wall-clock deadline in milliseconds; defaults to 5,000. */
  readonly timeoutMs?: number
  /** Worker V8 old-generation heap limit in MiB; defaults to 128. */
  readonly workerMemoryMb?: number
}
