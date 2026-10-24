/** Durable office context is descriptive evidence, independent of native or business execution permission. */
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import type { OfficeConversationCapture, OfficeConversationFilesCapture } from '@deepseek-ai/dsh-enterprise-office/types'

/** Immutable preparation rendered through the native snapshot-context presentation. */
export interface OfficePromptContextSource {
  readonly kind: 'office'
  readonly form: 'snapshot'
  readonly sections: readonly ContextSnapshotSection[]
  readonly capture: OfficeConversationCapture
}

/** Submitted immutable file metadata; contents arrive only through separately authorized native tool results. */
export interface OfficeFilesPromptContextSource {
  readonly kind: 'office-files'
  readonly form: 'snapshot'
  readonly sections: readonly ContextSnapshotSection[]
  readonly capture: OfficeConversationFilesCapture
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Descriptive office attribution; readers preserve content and metadata without this producer.
     * It imposes no replay or execution authority requirement.
     * @persistenceAttribution
     */
    office: OfficePromptContextSource
    /** Descriptive submitted file attribution; readers retain its text without granting execution authority.
     * @persistenceAttribution
     */
    'office-files': OfficeFilesPromptContextSource
  }
}
