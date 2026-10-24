/** Bounded central mutation denials commit independently while the existing office queue still owns the failed request. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type { OfficeDriveId, OfficeItemId, OfficeMember, OfficeMemberId, OfficeRequestDenialScope } from './types.ts'

const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const itemId = z.uuid().transform(value => brandString<OfficeItemId>(value))
const driveId = z.uuid().transform(value => brandString<OfficeDriveId>(value))
const code = z.enum(['forbidden', 'not_found', 'conflict', 'invalid_input', 'unauthenticated'])
const metadata = z.object({ revision: number.min(1), actorId: officeMemberId, code, time: number })
const entry = z.discriminatedUnion('action', [
  metadata.extend({ action: z.literal('saveMember'), targetId: officeMemberId }).strict(),
  metadata.extend({ action: z.literal('setStatus'), targetId: itemId }).strict(),
  metadata.extend({ action: z.literal('reply'), targetId: itemId }).strict(),
  metadata.extend({ action: z.literal('saveDrivePermissions'), targetId: driveId }).strict(),
])
const state = z.object({ revision: number, entries: z.array(entry).max(100000).readonly() }).strict()
  .superRefine((value, context) => {
    if (value.revision !== value.entries.length || value.entries.some((record, index) => record.revision !== index + 1))
      context.addIssue({ code: 'custom', message: 'Invalid office request denial sequence' })
  })
const limits = z.object({ maxEntries: z.number().int().min(1).max(100000),
  maxBytes: z.number().int().min(1024).max(268435456) }).strict()

/** Independent history; existing business, identity and Native Session schemas remain unchanged. */
export const officeRequestDenialsDomain = defineDomain({ name: 'enterprise_office_request_denials', version: 1,
  global: { schema: state, initial: { revision: 0, entries: [] } }, tables: {} })

/** Deployment capacity applies to the complete compact global JSON and never silently discards prior entries. */
export interface OfficeRequestDenialLimits {
  readonly maxEntries: number
  readonly maxBytes: number
}

/**
 * Validate explicit deployment capacity before opening the office service.
 * @param input - Record count and complete global-state UTF-8 byte bounds.
 * @returns Validated limits; invalid configuration fails activation.
 */
export function resolveOfficeRequestDenialLimits(input: OfficeRequestDenialLimits): OfficeRequestDenialLimits {
  return limits.parse(input)
}

/** A denied business operation remains denied when its separate audit cannot be confirmed. */
export class OfficeRequestDenialWriteError extends Error {
  /**
   * @param reason - Safe failure category; the underlying cause never belongs in a gateway response or log.
   * @param options - Private infrastructure cause.
   */
  constructor(readonly reason: 'capacity' | 'storage', options?: ErrorOptions) {
    super('Office request denial audit could not be saved', options)
    this.name = 'OfficeRequestDenialWriteError'
  }
}

/** Writes must run inside the shared office mutation queue; this repository never enqueues another operation. */
export class OfficeRequestDenialsRepository {
  constructor(private readonly domain: Domain<typeof officeRequestDenialsDomain>,
    private readonly limits: OfficeRequestDenialLimits) {}

  /**
   * Keep saved actors attached to the retained directory without requiring them to remain active.
   * @param members - Complete durable directory, including disabled identities.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    if (this.domain.global.get().entries.some(record => !ids.has(record.actorId)))
      throw new OfficeError('conflict', 'Saved request denial audit requires its original employee directory')
  }

  /**
   * Persist only selected typed denials after a parsed authenticated mutation fails; publish no business event.
   * @param actor - Employee authenticated before queue admission, including a session revoked while waiting.
   * @param scope - Server-selected method and validated target coordinate.
   * @param failure - Actual operation rejection; infrastructure and uncertain external outcomes are not denials.
   * @returns After audit durability, or immediately for an excluded failure. Capacity/storage failures reject separately.
   */
  async record(actor: OfficeMemberId, scope: OfficeRequestDenialScope, failure: unknown): Promise<void> {
    if (!(failure instanceof OfficeError)) return
    switch (failure.code) {
      case 'forbidden': case 'not_found': case 'conflict': case 'invalid_input': case 'unauthenticated': break
      default: return
    }
    try {
      const current = this.domain.global.get()
      if (current.entries.length >= this.limits.maxEntries || current.revision === Number.MAX_SAFE_INTEGER)
        throw new OfficeRequestDenialWriteError('capacity')
      const revision = current.revision + 1
      const record = entry.parse({ revision, actorId: actor, action: scope.action,
        targetId: scope.targetId, code: failure.code, time: Date.now() })
      const next = { revision, entries: [...current.entries, record] }
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > this.limits.maxBytes)
        throw new OfficeRequestDenialWriteError('capacity')
      await this.domain.global.set(next)
    } catch (error) {
      if (error instanceof OfficeRequestDenialWriteError) throw error
      throw new OfficeRequestDenialWriteError('storage', { cause: error })
    }
  }
}
