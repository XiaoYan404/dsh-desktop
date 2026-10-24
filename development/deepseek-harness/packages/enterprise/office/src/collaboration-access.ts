/** Queue and authority dependencies shared by the office collaboration repositories. */
import { z } from 'zod'
import { OfficeError } from './error.ts'
import type { OfficeMember, OfficeMemberId } from './types.ts'
import type { OfficeCollaborationLimits } from './collaboration-types.ts'

/** Every asynchronous mutation re-enters the original office queue and resolves current directory authority. */
export interface OfficeCollaborationAccess {
  member(this: void, id: OfficeMemberId): OfficeMember
  members(this: void): readonly OfficeMember[]
  enqueue<T>(this: void, operation: () => Promise<T>): Promise<T>
  changed(this: void): Promise<void>
}
/** Shared durable/wire counter, restricted to exact JavaScript integers. */
export const collaborationCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Strict capacity validation used before opening extension domains. */
export const officeCollaborationLimits = z.object({
  maxEntries: z.number().int().min(1).max(100000),
  maxBytes: z.number().int().min(1024).max(268435456),
  maxGroupMembers: z.number().int().min(2).max(1000),
  maxOccurrences: z.number().int().min(1).max(366),
  deliveryLeaseMs: z.number().int().min(1000).max(86400000),
  maxDeliveryAttempts: z.number().int().min(1).max(10),
}).strict()

/**
 * Refuse overflow before creating a successor revision.
 * @param current - Confirmed exact integer counter.
 * @returns Next exact integer, or a conflict when exhausted.
 */
export function collaborationRevision(current: number): number {
  if(current === Number.MAX_SAFE_INTEGER) throw new OfficeError('conflict', 'Collaboration revision capacity is exhausted')
  return current + 1
}
/**
 * Enforce the complete retained JSON size and total record count before writing.
 * @param value - Complete proposed domain state.
 * @param count - Total proposed records across its collections.
 * @param limits - Deployment-owned retention bounds.
 */
export function checkCollaborationCapacity(value: object, count: number, limits: OfficeCollaborationLimits): void {
  if(count > limits.maxEntries || Buffer.byteLength(JSON.stringify(value), 'utf8') > limits.maxBytes)
    throw new OfficeError('conflict', 'Collaboration retention reached its configured capacity')
}
/**
 * Resolve an active administrator; profile role labels never participate.
 * @param access - Trusted current member resolver.
 * @param actorId - Authenticated server-bound employee id.
 * @returns Current directory administrator.
 */
export function collaborationAdministrator(access: OfficeCollaborationAccess, actorId: OfficeMemberId): OfficeMember {
  const actor = access.member(actorId)
  if(actor.role !== 'admin') throw new OfficeError('forbidden', 'Only an administrator may manage identity policy')
  return actor
}
