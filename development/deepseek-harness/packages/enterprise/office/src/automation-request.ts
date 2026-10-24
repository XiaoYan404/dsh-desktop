/** Closed automation command parser; Host business events, signed Webhooks and Schedule receipts have no public trigger route. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { officeAutomationSaveInput } from './automation.ts'
import type { OfficeAutomationRepository, OfficeAutomationRunId, OfficeAutomationRule, OfficeAutomationRun, OfficeAutomationReview } from './automation.ts'
import { officeConversationCaptureSchemas } from './conversation-captures.ts'
import type { OfficeMemberId } from './types.ts'

const id = z.uuid().transform(value => brandString<OfficeAutomationRunId>(value))
const revision = z.number().int().positive()
const part = z.enum(['primary', 'compensation'])
/** Public commands never carry a claimed principal, arbitrary event payload, URL or credential. */
export const officeAutomationCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list') }).strict(),
  z.object({ kind: z.literal('save'), input: officeAutomationSaveInput }).strict(),
  z.object({ kind: z.literal('form'), source: z.string().min(1).max(200), occurrence: z.uuid() }).strict(),
  z.object({ kind: z.literal('review'), id, part }).strict(),
  z.object({ kind: z.literal('execute'), id, revision, part, captureId: officeConversationCaptureSchemas.id.optional() }).strict(),
  z.object({ kind: z.literal('manage'), id, revision, command: z.enum(['cancel', 'compensate', 'retry']) }).strict(),
  z.object({ kind: z.literal('recover'), id, part }).strict(),
])
/** Wire command whose actor is always selected by Office's existing authenticated request owner. */
export type OfficeAutomationCommand = z.infer<typeof officeAutomationCommand>
/** Unparsed wire input; UUID branding and strict validation belong to the existing Office request parser. */
export type OfficeAutomationCommandInput = z.input<typeof officeAutomationCommand>
/** Tagged command results remain distinct from external delivery, business approval or model completion. */
export type OfficeAutomationResponse =
  | { kind: 'list', rules: readonly OfficeAutomationRule[], runs: readonly OfficeAutomationRun[] }
  | { kind: 'rule', rule: OfficeAutomationRule }
  | { kind: 'runs', runs: readonly OfficeAutomationRun[] }
  | { kind: 'review', review: OfficeAutomationReview }
  | { kind: 'run', run: OfficeAutomationRun }

/**
 * Dispatch a parsed own command; triggers only create pending review and never call execution implicitly.
 * @param repository - Initialized private automation owner.
 * @param actorId - Existing server-authenticated employee, not a command property.
 * @param command - Closed parsed wire command.
 * @returns Tagged durable state or exact review fields; failures propagate to Office's existing typed error owner.
 */
export async function executeOfficeAutomationCommand(repository: OfficeAutomationRepository,
  actorId: OfficeMemberId, command: OfficeAutomationCommand) : Promise<OfficeAutomationResponse> {
  switch (command.kind) {
    case 'list': return { kind: 'list' as const, ...repository.list(actorId) }
    case 'save': return { kind: 'rule' as const, rule: await repository.save(actorId, command.input) }
    case 'form': return { kind: 'runs' as const, runs: await repository.trigger(actorId,
      { kind: 'form', source: command.source, occurrence: command.occurrence }) }
    case 'review': return { kind: 'review' as const, review: repository.review(actorId, command.id, command.part) }
    case 'execute': return { kind: 'run' as const, run: await repository.executeReviewed(actorId, command.id, command.revision,
      command.part, command.captureId) }
    case 'manage': return { kind: 'run' as const, run: await repository.manage(actorId, command.id, command.revision, command.command) }
    case 'recover': return { kind: 'run' as const, run: await repository.recover(actorId, command.id, command.part) }
    default: {
      const unreachable: never = command
      throw new Error(`Unsupported automation command ${String(unreachable)}`)
    }
  }
}
