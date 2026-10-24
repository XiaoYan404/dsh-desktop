/** Remaining parsed authenticated RPC denials have their own generation without widening the frozen four-operation ledger. */
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import { collaborationCounter as counter, collaborationRevision, checkCollaborationCapacity } from './collaboration-access.ts'
import type { OfficeMemberId } from './types.ts'
import type { OfficeCollaborationLimits } from './collaboration-types.ts'
import type { OfficeGovernanceAuditRow } from './usage-audit.ts'
import { OfficeRequestDenialWriteError } from './request-denials.ts'

const entry = z.object({
  revision: counter.min(1), actorId: officeMemberId,
  method: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,79}$/u),
  code: z.enum(['forbidden', 'not_found', 'conflict', 'invalid_input', 'unauthenticated']), time: counter,
}).strict()
const state = z.object({ revision: counter, entries: z.array(entry).max(100000) }).strict()
  .refine(value => value.revision === value.entries.length && value.entries.every((entry, index) => entry.revision === index + 1))
/** No argument, diagnostic, token, URL or request-body field is retained. */
export const officeRpcDenialsDomain = defineDomain({
  name: 'enterprise_office_rpc_denials', version: 1,
  global: { schema: state, initial: { revision: 0, entries: [] } }, tables: {},
})
/** Only the original queue owner invokes this repository after a parsed business call is rejected. */
export class OfficeRpcDenialsRepository {
  constructor(private readonly domain: Domain<typeof officeRpcDenialsDomain>, private readonly limits: OfficeCollaborationLimits) { }
  /**
   * Persist a business denial independently of the refused operation.
   * @param actorId - Employee authenticated before queue admission, even if revoked while waiting.
   * @param method - Server-selected parsed method discriminator, never supplied independently by the browser.
   * @param failure - Actual typed denial; unknown execution outcomes and infrastructure failures are excluded.
   */
  async record(actorId: OfficeMemberId, method: string, failure: unknown): Promise<void> {
    if(!(failure instanceof OfficeError) || !entry.shape.code.safeParse(failure.code).success) return
    try {
      const current = this.domain.global.get()
      const revision = collaborationRevision(current.revision)
      const next = {
        revision, entries: [...current.entries, entry.parse({
          revision, actorId, method, code: failure.code, time:
            Date.now(),
        })],
      }
      checkCollaborationCapacity(next, next.entries.length, this.limits)
      await this.domain.global.set(next)
    } catch(error) {
      throw new OfficeRequestDenialWriteError('storage', { cause: error })
    }
  }
  /**
   * Project only safe refusal metadata after the owner checks administrator authorization.
   * @returns Stable independently-namespaced denial rows.
   */
  audit(): readonly OfficeGovernanceAuditRow[] {
    return this.domain.global.get().entries.map(entry => ({
      key: `rpc-denial:${entry.revision}`, source: 'request_denial',
      actorId: entry.actorId, targetId: entry.actorId, action: entry.method, time: entry.time, decision: 'denied',
    }))
  }
}
