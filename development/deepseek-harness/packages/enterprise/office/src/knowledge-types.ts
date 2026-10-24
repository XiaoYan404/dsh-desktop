/** Versioned company knowledge citations retain the exact authorized Drive source and document position. */
import type { OfficeConversationFileReference, OfficeDriveId, OfficeDriveVersionId, OfficeMemberId } from './types.ts'

/** Every retention, extraction and returned-body bound is explicit when knowledge is enabled. */
export interface OfficeKnowledgePolicy {
  /** Maximum retained publication records, including withdrawn entries; replacement reuses the existing record. */
  readonly maxDocuments: number
  /** Maximum UTF-8 bytes of the complete persisted index JSON, including publications and mutation receipts. */
  readonly maxIndexBytes: number
  /** Maximum source file bytes before extraction, also constrained by the selected format parser's byte limit. */
  readonly maxSourceBytes: number
  /** Maximum cumulative extracted text length per document, measured in UTF-16 code units. */
  readonly maxDocumentCharacters: number
  /** Maximum PDF pages, PPTX slides or XLSX worksheets per document; text and DOCX each use one section. */
  readonly maxSections: number
  /** Maximum UTF-16 code units per indexed chunk; a surrogate pair is never split. */
  readonly chunkCharacters: number
  /** Maximum text chunks per document; exceeding this count rejects publication. */
  readonly maxChunksPerDocument: number
  /** Maximum requested citation count per search; larger requests are rejected. */
  readonly maxResults: number
  /** Maximum UTF-8 bytes of a complete knowledge response, including HTTP or escaped Native text-block envelopes. */
  readonly maxResponseBytes: number
  /** Extraction deadline in milliseconds, combined with caller cancellation and existing format parser limits. */
  readonly timeoutMs: number
}

/** Position in the original format; offsets count UTF-16 units and never split a surrogate pair. */
export interface OfficeKnowledgeLocation {
  readonly kind: 'text' | 'docx' | 'pdf' | 'xlsx' | 'pptx'
  readonly part: number
  readonly offset: number
  readonly label: string
}

/** One fully extracted paragraph, page, slide or saved worksheet cell; no rendered appearance is asserted. */
export interface OfficeKnowledgeUnit {
  readonly location: OfficeKnowledgeLocation
  readonly text: string
}

/** An authorized answer citation carries real text and exact source identity, never a cached permission grant. */
export interface OfficeKnowledgeCitation {
  readonly file: OfficeConversationFileReference
  readonly revision: number
  readonly chunk: number
  readonly location: OfficeKnowledgeLocation
  readonly text: string
}

/** Metadata-only publication; querying its text requires fresh source authorization. */
export interface OfficeKnowledgePublication {
  readonly file: OfficeConversationFileReference
  readonly revision: number
  readonly publisherId: OfficeMemberId
  readonly publishedAt: number
  readonly chunks: number
  readonly withdrawn: boolean
}

/** Publishing and replacement require an explicitly reviewed current source and publication revision. */
export interface OfficeKnowledgePublishInput {
  readonly fileId: OfficeDriveId
  readonly versionId: OfficeDriveVersionId
  readonly revision: number
  readonly requestId: string
}

/** Removing a publication keeps its revision while dropping its indexed body. */
export interface OfficeKnowledgeWithdrawInput {
  readonly fileId: OfficeDriveId
  readonly revision: number
  readonly requestId: string
}

/** A citation can be reopened only while its original version, digest and publication remain current. */
export interface OfficeKnowledgeCitationInput {
  readonly fileId: OfficeDriveId
  readonly versionId: OfficeDriveVersionId
  readonly sha256: string
  readonly revision: number
  readonly chunk: number
}

/** Literal terms are matched locally; query syntax never becomes a database expression. */
export interface OfficeKnowledgeSearchInput {
  readonly query: string
  readonly limit: number
}

/** Only authorized, current chunks contribute results or the hasMore flag. */
export interface OfficeKnowledgeSearch {
  readonly query: string
  readonly entries: readonly OfficeKnowledgeCitation[]
  readonly hasMore: boolean
}
