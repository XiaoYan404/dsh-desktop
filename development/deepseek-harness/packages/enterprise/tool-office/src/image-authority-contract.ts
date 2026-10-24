/** Native policy and authenticated raster operations; source result types belong to Office. */
import type { OfficeConversationImageReadInput, OfficeConversationImageResult } from '@deepseek-ai/dsh-enterprise-office/types'

/** The employee Host forwards these operations through the fixed Office allowlist. */
export interface OfficeImageAuthority {
  /**
   * Read original bytes or recheck the same source after Native normalization.
   * @param input - Exact submitted coordinates and source version/digest for recheck.
   * @param signal - Combined Native execution and tool lifetime.
   * @returns Verified source data or a structured current-authority denial.
   */
  readConversationImage(input: OfficeConversationImageReadInput, signal: AbortSignal): Promise<OfficeConversationImageResult>
}

/** Resolved only for an explicitly enabled Native image reader. */
export interface OfficeImageToolPolicy {
  /** Maximum source bytes, bounded again by the current Native attachment provider. */
  readonly maxSourceBytes: number
  /** Hard bound on normalized image bytes, independent of the provider's encoding target. */
  readonly maxNormalizedResultBytes: number
}
