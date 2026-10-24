/** Submitted PPTX text-reading types remain independent of persistence and native attachments. */
import type { OfficeConversationFileReadInput, OfficeConversationFileReference } from '@deepseek-ai/dsh-enterprise-office/types'

/** Complete explicit limits; callers resolve every value before admitting a presentation read. */
export interface OfficePptxPolicy {
  /** Maximum compressed presentation input bytes. */
  readonly maxBytes: number
  /** Maximum ZIP directory entries, including ignored media and other parts. */
  readonly maxArchiveEntries: number
  /** Maximum total declared expanded bytes across every ZIP entry. */
  readonly maxInflatedBytes: number
  /** Maximum bytes in any individual XML, relationships or VML part. */
  readonly maxXmlBytes: number
  /** Maximum cumulative parsed XML nodes across the selected read. */
  readonly maxNodes: number
  /** Maximum slides in the relationship-ordered presentation directory. */
  readonly maxSlides: number
  /** Maximum extracted text and separators, measured in UTF-16 code units. */
  readonly maxTextCharacters: number
  /** Maximum UTF-8 bytes in the complete escaped Native tool-content JSON result. */
  readonly maxOutputBytes: number
  /** Maximum worker parsing duration in milliseconds, before awaited termination. */
  readonly timeoutMs: number
  /** Maximum worker old-generation JavaScript heap size in MiB. */
  readonly workerMemoryMb: number
}

/** Optional presentation reader deployment; every resource limit must be supplied explicitly. */
export type OfficeConversationPptxConfig = OfficePptxPolicy

/** Notes are selected explicitly and never appended to the saved slide-body text. */
export type OfficePptxSection = 'slide' | 'notes'

/** A 1-based position in the presentation's relationship-ordered slide list. */
export interface OfficePptxSelection {
  readonly slideNumber: number
  readonly section: OfficePptxSection
}

/** Submitted immutable file and one bounded UTF-16 window; PPTX never exceeds maxCharacters to complete a pair. */
export interface OfficeConversationPptxReadInput extends OfficeConversationFileReadInput, OfficePptxSelection {}

/** Hidden slides remain listed; hasNotes describes an actual slide-to-notes relationship. */
export interface OfficePptxSlide {
  readonly number: number
  readonly hidden: boolean
  readonly hasNotes: boolean
}

/** Saved text in shape-tree order, including grouped shapes and table cells, without visual layout interpretation. */
export interface OfficePptxExtraction extends OfficePptxSelection {
  readonly slides: readonly OfficePptxSlide[]
  readonly text: string
  readonly paragraphCount: number
  readonly tableCount: number
  /** Text-bearing hidden shapes in the selected section remain part of the saved text. */
  readonly hiddenShapeCount: number
}

/** Complete native-content metadata and an exact text continuation from one authorized submitted section. */
export interface OfficeConversationPptxRead extends OfficePptxSelection {
  readonly file: OfficeConversationFileReference
  readonly slides: readonly OfficePptxSlide[]
  readonly paragraphCount: number
  readonly tableCount: number
  readonly hiddenShapeCount: number
  readonly offset: number
  readonly nextOffset: number
  readonly totalCharacters: number
  readonly eof: boolean
  readonly text: string
}
