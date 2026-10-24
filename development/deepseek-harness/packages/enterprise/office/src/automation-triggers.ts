/** Product-owned signed Webhooks and native Schedule receipt admission; neither implies model execution or remote delivery. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { OfficeError } from './error.ts'
import type { OfficeMemberId } from './types.ts'
import type { OfficeAutomationRepository, OfficeAutomationRun } from './automation.ts'

/** Private fixed principal and source with explicit ingress bounds; the secret is resolved afresh by the Host. */
export interface OfficeAutomationWebhookConfig {
  readonly ownerId: OfficeMemberId
  readonly source: string
  readonly maxBytes: number
  readonly maxSkewMs: number
}

/**
 * Authenticate an exact raw request before JSON parsing and admit its durable event identity for human review.
 * @param repository - Existing automation owner with durable occurrence deduplication.
 * @param config - Private endpoint binding; body fields cannot choose an employee or source.
 * @param input - Bounded raw bytes, canonical epoch milliseconds and lowercase SHA-256 HMAC hex from transport headers.
 * @param secret - Fresh Host credential bytes, at least 32 bytes, never retained or included in diagnostics.
 * @returns Original or new pending-review runs; failures send no business write and disclose no secret.
 */
export async function ingestOfficeAutomationWebhook(repository: Pick<OfficeAutomationRepository, 'trigger'>,
  config: OfficeAutomationWebhookConfig,
  input: { readonly body: Uint8Array
    readonly timestamp: string
    readonly signature: string }, secret: Uint8Array): Promise<readonly OfficeAutomationRun[]> {
  const settings = z.object({ ownerId: z.string().min(1).max(128), source: z.string().min(1).max(200),
    maxBytes: z.number().int().min(1).max(1024 * 1024), maxSkewMs: z.number().int().min(1).max(86400000) }).strict().parse(config)
  if (input.body.byteLength > settings.maxBytes || secret.byteLength < 32 || !/^[0-9]{1,16}$/.test(input.timestamp) ||
    !Number.isSafeInteger(Number(input.timestamp)) || Math.abs(Date.now() - Number(input.timestamp)) > settings.maxSkewMs ||
    !/^[a-f0-9]{64}$/.test(input.signature)) throw new OfficeError('forbidden', 'Automation Webhook authentication failed')
  const signature = createHmac('sha256', secret).update(input.timestamp).update('.').update(input.body).digest()
  if (!timingSafeEqual(signature, Buffer.from(input.signature, 'hex')))
    throw new OfficeError('forbidden', 'Automation Webhook authentication failed')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.body)) }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new OfficeError('invalid_input', 'Invalid automation Webhook JSON')
    throw error
  }
  const parsed = z.object({ protocol: z.literal(1), eventId: z.uuid() }).strict().safeParse(value)
  if (!parsed.success) throw new OfficeError('invalid_input', 'Invalid automation Webhook event')
  return repository.trigger(config.ownerId, { kind: 'webhook', source: config.source, occurrence: parsed.data.eventId })
}

/** A committed native inbox receipt; prompt text and message delivery do not establish model completion. */
export interface OfficeAutomationScheduleReceipt {
  readonly id: string
  readonly sessionId: string
  readonly lastDelivery?: { readonly scheduledAt: string; readonly deliveredAt: string; readonly messageId: string }
}

/**
 * Consume an actual native Schedule catalog receipt after current owner/session authorization; never create a timer.
 * @param repository - Durable trigger owner.
 * @param binding - Deployment-owned employee, native Session and Schedule identities.
 * @param receipt - Actual persisted catalog row; absent delivery evidence admits nothing.
 * @param assertCurrent - Current native Session ownership check, awaited again before trigger admission.
 * @returns Pending-review runs only; no synthesis of missed, pruned or deleted native occurrences.
 */
export async function ingestOfficeAutomationSchedule(repository: Pick<OfficeAutomationRepository, 'trigger'>,
  binding: { readonly ownerId: OfficeMemberId; readonly sessionId: string; readonly scheduleId: string },
  receipt: OfficeAutomationScheduleReceipt, assertCurrent: () => Promise<void>): Promise<readonly OfficeAutomationRun[]> {
  if (receipt.id !== binding.scheduleId || receipt.sessionId !== binding.sessionId)
    throw new OfficeError('forbidden', 'Automation native schedule binding changed')
  if (!receipt.lastDelivery) return []
  await assertCurrent()
  const original = JSON.stringify([receipt.id, receipt.lastDelivery.scheduledAt, receipt.lastDelivery.messageId])
  // Bound arbitrary native identity lengths without truncating or merging occurrence identities.
  const occurrence = createHash('sha256').update(original).digest('hex')
  await assertCurrent()
  return repository.trigger(binding.ownerId, { kind: 'schedule', source: binding.scheduleId, occurrence })
}
