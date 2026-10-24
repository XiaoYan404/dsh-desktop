/** Captured reminder authority and durable reservations for exactly one internal office item per Agent request. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId, officeWorkInput } from './spec.ts'
import { officeConversationCaptureSchemas } from './conversation-captures.ts'
import type { OfficeAgentWorkInput, OfficeConnectorView, OfficeConversationCapture, OfficeConversationLinksView,
  OfficeItemId, OfficeMember, OfficeToolRequirement } from './types.ts'

/** Explicit office work operation; arbitrary actor ids, endpoints and tool dispatch are not admitted. */
export const officeAgentWorkInput = z.object({ requestId: z.uuid(), captureId: officeConversationCaptureSchemas.id,
  work: officeWorkInput }).strict()
const itemId = z.uuid().transform(value => brandString<OfficeItemId>(value))
const entry = z.object({ memberId: officeMemberId, input: officeAgentWorkInput, itemId,
  acceptedAt: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
  .refine(value => hash(value.input) === value.fingerprint)
const state = z.object({ entries: z.array(entry).max(10000).readonly() }).strict().refine(value =>
  new Set(value.entries.map(row => row.itemId)).size === value.entries.length &&
  new Set(value.entries.map(row => JSON.stringify([row.memberId, row.input.requestId]))).size === value.entries.length)

/** Reservations commit before the business item; restart can reconcile the same item id after an interrupted acknowledgement. */
export const officeAgentWorkDomain = defineDomain({
  name: 'enterprise_office_agent_work', version: 1,
  global: { schema: state, initial: { entries: [] } }, tables: {},
})

/** Finite retained request evidence; existing reservations remain readable after lowering a bound. */
export interface OfficeAgentWorkPolicy {
  readonly maxEntries: number
  readonly maxBytes: number
}

/**
 * Validate request retention before opening its domain.
 * @param policy - Entry and compact UTF-8 domain byte limits.
 * @returns Validated limits without implicit pruning.
 */
export function resolveAgentWorkPolicy(policy: OfficeAgentWorkPolicy): OfficeAgentWorkPolicy {
  return z.object({ maxEntries: z.number().int().min(1).max(10000),
    maxBytes: z.number().int().min(1024).max(256 * 1024 * 1024) }).strict().parse(policy)
}

/** Reserved item identities are private employee evidence, never reusable execution grants. */
export class OfficeAgentWorkRepository {
  /**
   * @param domain - Independent durable reservation owner.
   * @param policy - Validated finite retention.
   */
  constructor(private readonly domain: Domain<typeof officeAgentWorkDomain>, private readonly policy: OfficeAgentWorkPolicy) {}

  /**
   * Refuse reservations whose original employee directory was lost.
   * @param members - Current directory, including retained inactive employees.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    if (this.domain.global.get().entries.some(row => !members.some(member => member.id === row.memberId))) {
      throw new OfficeError('conflict', 'Agent work requires its original employee directory')
    }
  }

  /**
   * Find an exact private retry without admitting another business mutation.
   * @param actor - Current active employee.
   * @param input - Strictly validated original request.
   * @returns Original reservation or absence; a changed request identity conflicts.
   */
  find(actor: OfficeMember, input: OfficeAgentWorkInput): z.infer<typeof entry> | undefined {
    const existing = this.domain.global.get().entries.find(row => row.memberId === actor.id && row.input.requestId === input.requestId)
    if (existing && existing.fingerprint !== hash(input)) throw new OfficeError('conflict', 'Agent work retry changed')
    return existing
  }

  /**
   * Persist a stable item identity before the office queue creates its business record.
   * @param actor - Employee whose current execution authority was checked by the service.
   * @param input - Validated capture and work request.
   * @returns Original or newly committed reservation; failed persistence publishes no identity.
   */
  async reserve(actor: OfficeMember, input: OfficeAgentWorkInput): Promise<z.infer<typeof entry>> {
    const existing = this.find(actor, input)
    if (existing) return existing
    const saved = entry.parse({ memberId: actor.id, input, itemId: randomUUID(), acceptedAt: Date.now(), fingerprint: hash(input) })
    const next = { entries: [...this.domain.global.get().entries, saved] }
    if (next.entries.length > this.policy.maxEntries || Buffer.byteLength(JSON.stringify(next)) > this.policy.maxBytes) {
      throw new OfficeError('conflict', 'Agent work request retention is full')
    }
    await this.domain.global.set(next)
    return saved
  }
}

/**
 * Recheck a reminder's employee, reviewed selection, current declared requirements and required connections before a write.
 * @param actor - Current active authenticated employee, never supplied by the browser payload.
 * @param capture - Private descriptive context recovered for that employee.
 * @param choices - Current choices in the same logical conversation.
 * @param connections - Current readiness; successful external delivery is not implied.
 */
export function assertAgentWorkAuthority(actor: OfficeMember, capture: OfficeConversationCapture,
  choices: OfficeConversationLinksView, connections: OfficeConnectorView): void {
  if (capture.memberId !== actor.id || choices.meId !== actor.id || capture.role !== actor.role) {
    throw new OfficeError('forbidden', 'Agent work employee or role changed')
  }
  if (capture.selection.conversationId !== choices.selection.conversationId ||
    capture.selection.revision !== choices.selection.revision) {
    throw new OfficeError('conflict', 'Review the current Agent work associations')
  }
  const reminder = (value: { readonly kind: string; readonly name: string }) => value.kind === 'template' && value.name === 'reminder'
  if (!capture.selection.tools.some(reminder) || !choices.selection.tools.some(reminder)) {
    throw new OfficeError('forbidden', 'Agent work requires the selected reminder template')
  }
  const current = choices.requirements.find(row => reminder(row.tool))
  const captured = capture.requirements.find(row => reminder(row.tool))
  if (requirementKey(current) !== requirementKey(captured)) throw new OfficeError('conflict', 'Agent work requirements changed')
  if (current?.missing.length) throw new OfficeError('forbidden', 'A required company system is not registered')
  for (const id of current?.integrations ?? []) {
    const historical = capture.integrations.find(row => row.id === id)
    const active = connections.entries.find(row => row.integrationId === id)
    if (!capture.selection.integrations.includes(id) || !choices.selection.integrations.includes(id) || !historical || !active ||
      active.status !== 'unverified') throw new OfficeError('forbidden', 'A required company connection is unavailable')
    if (historical.connectionRevision !== active.revision) throw new OfficeError('conflict', 'A required connection version changed')
  }
}

function requirementKey(value: OfficeToolRequirement | undefined): string {
  return JSON.stringify({ names: [...value?.integrationNames ?? []].sort(), ids: [...value?.integrations ?? []].sort(),
    missing: [...value?.missing ?? []].sort() })
}
function hash(input: OfficeAgentWorkInput): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex') }
