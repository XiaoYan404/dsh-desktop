/** Extract descriptive employee attribution without granting execution permission. */
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { OfficeMemberId, OfficeRole } from '@deepseek-ai/dsh-enterprise-office/types'
import type {} from './types.ts'

/** Submitted identity; current server authority is checked independently. */
export interface OfficeRunClaim {
  readonly memberId: OfficeMemberId
  readonly role: OfficeRole
  readonly matchesConversation: boolean
}

/**
 * Read office attribution from a human input, including retained fork history.
 * @param message - Identified Native human input.
 * @param conversationId - Exact current conversation for a newly claimed input; omitted for historical attribution.
 * @returns Descriptive identities, without treating them as an authorization credential.
 */
export function officeRunClaims(message: UserMessage, conversationId?: string): OfficeRunClaim[] {
  const source = message.source
  if (source.kind !== 'user' || !('preparedContexts' in source)) return []
  return source.preparedContexts.flatMap(({ source: context }) => {
    if (context.kind !== 'office' && context.kind !== 'office-files') return []
    return [{ memberId: context.capture.memberId, role: context.capture.role,
      matchesConversation: conversationId === undefined || context.capture.selection.conversationId === conversationId }]
  })
}
