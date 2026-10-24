/** Private provider receipts make repeated execution ids safe when the vendor has no request-key field. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DomainGlobal } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMember, officeMemberId } from './spec.ts'
import { connectorBusinessDataSchema } from './connector-actions.ts'
import type { OfficeConnectorExecutionId, OfficeMember } from './types.ts'
import type { OfficeConnectorWriteResult } from './connector-http.ts'

type Actor = Pick<OfficeMember, 'id' | 'role'>
type Confirmed = Exclude<OfficeConnectorWriteResult, { readonly status: 'unknown' }>
const id = z.uuid().transform(value => brandString<OfficeConnectorExecutionId>(value))
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.number().int().nonnegative().max(8640000000000000)
const result = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }).strict(),
  z.object({ status: z.literal('succeeded'), result: connectorBusinessDataSchema(1000) }).strict(),
  z.object({ status: z.literal('rejected'), rejection: z.enum(['denied', 'not_accepted', 'unauthorized', 'rate_limited', 'invalid_input']) }).strict(),
])
const row = z.object({ id, ownerId: officeMemberId, role: officeMember.shape.role, bindingHash: hash, contentHash: hash,
  createdAt: timestamp, updatedAt: timestamp, result }).strict().refine(value => value.updatedAt >= value.createdAt)
/** Shared private schema; each provider retains its own independent domain identity and capacity. */
export const messageProviderState = z.object({ entries: z.array(row).max(10000).readonly() }).strict()
  .refine(value => new Set(value.entries.map(entry => entry.id)).size === value.entries.length)

/** Serial reservations commit before dispatch; unresolved reservations are never automatically dispatched again. */
export class OfficeMessageProviderRepository {
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly domain: { readonly global: DomainGlobal<z.infer<typeof messageProviderState>> },
    private readonly limits: { readonly maxEntries: number; readonly maxBytes: number },
    private readonly authorize: (actor: Actor) => void) {}

  /**
   * Reject retained provider receipts whose owners are absent from the original employee directory.
   * @param members - Original retained directory; inactive employees still retain private message ownership.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const owners = new Set(members.map(member => member.id))
    if (this.domain.global.get().entries.some(entry => !owners.has(entry.ownerId)))
      throw new OfficeError('conflict', 'Message receipts require their original employee directory')
  }

  /**
   * Read an original provider outcome without authenticating or contacting the provider again.
   * @param actor - Current employee and role, rechecked by the office owner.
   * @param executionId - Original server execution identity.
   * @param bindingHash - Current approved app, mapping and endpoint fingerprint, excluding credentials.
   * @param contentHash - Exact reviewed payload fingerprint, supplied for a write retry.
   * @returns Null before reservation, the retained outcome, or unknown for a changed binding.
   */
  lookup(actor: Actor, executionId: OfficeConnectorExecutionId, bindingHash: string,
    contentHash?: string): Promise<OfficeConnectorWriteResult | null> {
    return this.enqueue(actor, () => Promise.resolve(this.original(actor, executionId, bindingHash, contentHash)))
  }

  /**
   * Atomically reserve the only permitted dispatch for this execution id.
   * @param actor - Current employee and role.
   * @param executionId - Server identity, never a caller's retry UUID.
   * @param bindingHash - Approved account/endpoint fingerprint without private credentials.
   * @param contentHash - Exact reviewed content fingerprint; message text remains in the office execution owner.
   * @returns Dispatch permission only after durable reservation; prior ids return the original outcome.
   */
  reserve(actor: Actor, executionId: OfficeConnectorExecutionId, bindingHash: string, contentHash: string): Promise<
    { readonly dispatch: true } | { readonly dispatch: false; readonly result: OfficeConnectorWriteResult }
  > {
    return this.enqueue(actor, async () => {
      const original = this.original(actor, executionId, bindingHash, contentHash)
      if (original) return { dispatch: false as const, result: original }
      const current = this.domain.global.get()
      if (current.entries.length >= this.limits.maxEntries) throw new OfficeError('context_too_large', 'Message outbox is full')
      const at = Date.now()
      const entry = row.parse({ id: executionId, ownerId: actor.id, role: actor.role, bindingHash, contentHash,
        createdAt: at, updatedAt: at, result: { status: 'unknown' } })
      await this.commit({ entries: [...current.entries, entry] })
      return { dispatch: true as const }
    })
  }

  /**
   * Retain a sanitized authoritative vendor acknowledgement before exposing success.
   * @param actor - Current employee and role.
   * @param executionId - Previously reserved provider operation.
   * @param bindingHash - Same reviewed app/mapping/endpoint fingerprint.
   * @param contentHash - Same reviewed message fingerprint.
   * @param outcome - Confirmed acceptance or nonacceptance; delivery/read status is not implied.
   * @returns Durable original outcome; repeated settlement cannot replace a confirmed receipt.
   */
  settle(actor: Actor, executionId: OfficeConnectorExecutionId, bindingHash: string, contentHash: string,
    outcome: Confirmed): Promise<OfficeConnectorWriteResult> {
    return this.enqueue(actor, async () => {
      const original = this.original(actor, executionId, bindingHash, contentHash)
      if (!original) throw new OfficeError('not_found', 'Message reservation is unavailable')
      const current = this.domain.global.get()
      const previous = current.entries.find(entry => entry.id === executionId)
      if (!previous || previous.bindingHash !== bindingHash) return { status: 'unknown' }
      if (original.status !== 'unknown') return original
      const value = result.parse(outcome)
      const updated = { ...previous, updatedAt: Math.max(Date.now(), previous.updatedAt), result: value }
      await this.commit({ entries: current.entries.map(entry => entry === previous ? updated : entry) })
      return value
    })
  }

  /** Reject new operations and drain admitted storage work before the owning domain closes. */
  async close(): Promise<void> { this.closed = true; await this.tail }

  private original(actor: Actor, executionId: OfficeConnectorExecutionId, bindingHash: string,
    contentHash?: string): OfficeConnectorWriteResult | null {
    if (!id.safeParse(executionId).success || !hash.safeParse(bindingHash).success
      || (contentHash !== undefined && !hash.safeParse(contentHash).success))
      throw new OfficeError('invalid_input', 'Invalid message receipt coordinates')
    const found = this.domain.global.get().entries.find(entry => entry.id === executionId)
    if (!found) return null
    if (found.ownerId !== actor.id || found.role !== actor.role) throw new OfficeError('not_found', 'Message receipt is unavailable')
    if (found.bindingHash !== bindingHash) return { status: 'unknown' }
    if (contentHash !== undefined && found.contentHash !== contentHash) throw new OfficeError('conflict', 'Message retry content changed')
    return found.result
  }
  private async commit(value: z.infer<typeof messageProviderState>): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.limits.maxBytes)
      throw new OfficeError('context_too_large', 'Message outbox byte capacity reached')
    await this.domain.global.set(value)
  }
  private enqueue<T>(actor: Actor, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new OfficeError('closed', 'Message outbox is closed'))
    const task = this.tail.then(async () => {
      this.authorize(actor)
      const value = await operation()
      this.authorize(actor)
      return value
    })
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
}
