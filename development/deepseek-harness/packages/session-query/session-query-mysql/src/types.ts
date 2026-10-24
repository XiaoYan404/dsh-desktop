/** Fixed observations and explicit resource limits for the MySQL search provider. */
import type { SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEventSearchDocument, SessionRecord } from '@deepseek-ai/dsh-session-query'

/** A published native log observation; decimal SQL identities never become numbers. */
export interface SearchCut {
  readonly storeId: string
  readonly slotId: string
  readonly lifecycle: Uint8Array
  readonly format: number
  readonly revision: string
  readonly eventCount: number
  readonly inheritedEventCount: SessionLogOffset
  readonly header: SessionHeader
}

/** One claim owns its staging build and the exact search-state CAS observation. */
export interface SearchClaim {
  readonly cut: SearchCut
  readonly token: Uint8Array
  readonly buildId: Uint8Array
  readonly expectedStateRevision: string
}

/** Deployment limits apply to complete values; exceeding a limit rejects the operation. */
export interface SearchLimits {
  /** SQL rows per read or staging batch (1–1000); larger sets continue across batches. */
  readonly pageSize: number
  /** Claim lifetime in milliseconds (1000–600000), renewed during staging; expired or replaced claims cannot publish. */
  readonly claimTtlMs: number
  /** Maximum UTF-8 bytes of one semantic document's text; exceeding it rejects the build with CAPACITY. */
  readonly maxDocumentBytes: number
  /**
   * Per-build limit for native input bytes and, separately, total UTF-8 semantic text bytes.
   * The same value also bounds the native event count; exceeding any limit leaves the build unpublished.
   */
  readonly maxBuildBytes: number
  /** Maximum semantic documents in one session build; exceeding it rejects the build with CAPACITY. */
  readonly maxDocuments: number
  /** Maximum candidate documents across selected sessions per search; exceeding it rejects the whole search with CAPACITY. */
  readonly maxCandidates: number
  /** Maximum total UTF-8 candidate text bytes per search; exceeding it rejects the whole search with CAPACITY. */
  readonly maxCandidateBytes: number
  /** Result items per page when the request omits its limit; must not exceed maxLimit. */
  readonly defaultLimit: number
  /** Maximum requested result items per page; larger limits are rejected with SESSION_QUERY_INVALID_LIMIT. */
  readonly maxLimit: number
  /** Maximum Unicode code points per snippet, including ellipses; longer text is shortened around its first match. */
  readonly snippetChars: number
}

/** Principal and policy identity supplied by the existing employee authorization mechanism. */
export interface SearchAuthorization {
  readonly principal: string
  readonly revision: string
  readonly sessionIds: readonly SessionId[]
}

/** Host policy and live-writer barrier; neither capability is accepted from a remote request. */
export interface MysqlSearchAccess {
  /** Flush every accepted local write; reject when another owner has an unobservable pending prefix. */
  flush(signal: AbortSignal): Promise<void>
  /** Reuse the current employee policy and intersect its result with these candidates. */
  authorize(candidates: readonly SessionRecord[], signal: AbortSignal): Promise<SearchAuthorization>
  /** Resolve live from the actual runtime registry, never a writer lease. */
  isLive(id: SessionId): boolean
}

/** All metadata needed to detect a changed visible corpus, including append-only log revisions. */
export interface SearchView {
  readonly storeId: string
  readonly epoch: string
  readonly registryRevision: string
  readonly cuts: readonly SearchCut[]
}

/** The row joins a published build to the currently selected native generation. */
export interface SearchCandidate extends SessionEventSearchDocument {
  readonly record: SessionRecord
}
