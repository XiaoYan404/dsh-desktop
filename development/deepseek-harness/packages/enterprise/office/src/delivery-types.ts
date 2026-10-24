/** Delivery verification reuses the original Office skills and preserves exact submitted Drive sources. */
import type { OfficeConversationFileReference, OfficeConversationFilesCaptureId, OfficeDriveId } from './types.ts'
import type { OfficeDocumentExtractionPolicy } from './knowledge-document.ts'

/** Repository-authored request recipes, using the existing Office skills rather than claiming third-party design assets. */
export type OfficeDeliveryTemplate = 'document' | 'spreadsheet' | 'presentation' | 'pdf'

/** Every enabled deployment supplies finite source, extraction, assertion and complete-result limits. */
export interface OfficeDeliveryPolicy extends OfficeDocumentExtractionPolicy {
  /** Maximum UTF-8 bytes of the complete check response, including HTTP or escaped Native text-block envelopes. */
  readonly maxResultBytes: number
  /** Maximum number of required text assertions accepted in one delivery check. */
  readonly maxExpectedTexts: number
  /** Maximum UTF-16 code units in each expected-text assertion. */
  readonly maxExpectedTextCharacters: number
}

/** A check reads the exact human-submitted version and verifies requested content in a real binary format. */
export interface OfficeDeliveryCheckInput {
  readonly captureId: OfficeConversationFilesCaptureId
  readonly fileId: OfficeDriveId
  readonly template: OfficeDeliveryTemplate
  readonly expectedText: readonly string[]
}

/** Structural/content checks establish neither rendered appearance nor business acceptance. */
export interface OfficeDeliveryCheck {
  readonly file: OfficeConversationFileReference
  readonly template: OfficeDeliveryTemplate
  readonly templateSource: string
  readonly verifiedSections: number
  readonly textCharacters: number
  readonly assertions: readonly { readonly text: string; readonly found: true }[]
  readonly verification: 'structure_and_text'
  readonly visualLayout: 'not_checked'
}
