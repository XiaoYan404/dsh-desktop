/** A prepared context describes a selection; current ownership, role and association versions still authorize every query. */
import { z } from 'zod'
import { officeConnectorReadInput } from './connector-actions.ts'
import { officeConversationCaptureSchemas } from './conversation-captures.ts'
import { OfficeError } from './error.ts'
import type { OfficeCapturedIntegration, OfficeConversationCapture, OfficeConversationLinksView,
  OfficeIntegrationId, OfficeMember } from './types.ts'

/** Closed Agent discovery request: the session supplies its private capture and a selected system identity. */
export const officeConversationConnectorInput = z.object({ captureId: officeConversationCaptureSchemas.id,
  integrationId: officeConnectorReadInput.shape.integrationId }).strict()
/** Closed Agent read request: actor, role, URLs and arbitrary business arguments are never accepted. */
export const officeConversationConnectorReadInput = officeConnectorReadInput.extend({
  captureId: officeConversationCaptureSchemas.id,
}).strict()

/**
 * Require the same employee, current role, reviewed association and configured system at execution time.
 * @param actor - Current active server-authenticated employee.
 * @param capture - Private persisted capture recovered for that employee.
 * @param choices - Current private choices in the captured logical native conversation.
 * @param integrationId - One selected company system; an id is not execution authority.
 * @returns Captured system coordinates that current directory/read execution must still match.
 */
export function assertConversationConnectorAuthority(actor: OfficeMember, capture: OfficeConversationCapture,
  choices: OfficeConversationLinksView, integrationId: OfficeIntegrationId): OfficeCapturedIntegration {
  if (actor.id !== capture.memberId || choices.meId !== actor.id || capture.role !== actor.role)
    throw new OfficeError('forbidden', 'Conversation query employee or role changed')
  if (choices.selection.conversationId !== capture.selection.conversationId || choices.selection.revision !== capture.selection.revision)
    throw new OfficeError('conflict', 'Review the current conversation associations')
  const integration = capture.integrations.find(row => row.id === integrationId)
  if (!capture.selection.integrations.includes(integrationId) || !choices.selection.integrations.includes(integrationId) ||
    !integration || integration.status !== 'unverified')
    throw new OfficeError('forbidden', 'Conversation query requires a selected configured system')
  return integration
}
