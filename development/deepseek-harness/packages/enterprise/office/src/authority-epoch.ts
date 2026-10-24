/** Authentication-only revisions survive role/active ABA without invalidating ordinary office writes. */
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { collaborationCounter, collaborationRevision } from './collaboration-access.ts'

const state = z.object({
  revision: collaborationCounter,
  governanceEnabled: z.boolean().nullable(),
}).strict().refine(value => value.governanceEnabled !== null || value.revision === 0)

/** Independent v1 state does not replace or widen original business, identity or invitation formats. */
export const officeAuthorityEpochDomain = defineDomain({ name: 'enterprise_office_authority_epoch', version: 1,
  global: { schema: state, initial: { revision: 0, governanceEnabled: null } }, tables: {} })

/** Bootstrap and mutations are serialized by the original Office owner; no token or member data is retained here. */
export class OfficeAuthorityEpochRepository {
  constructor(private readonly domain: Domain<typeof officeAuthorityEpochDomain>) {}

  /**
   * Persist governance activation changes before the service admits Native authority observations.
   * @param directoryInitialized - Whether the original retained directory exists.
   * @param governanceEnabled - Explicit presence of centralized governance configuration.
   * @returns After durability; an unrelated retained epoch cannot silently seed a missing directory.
   */
  async configure(directoryInitialized: boolean, governanceEnabled: boolean): Promise<void> {
    const current = this.domain.global.get()
    if (!directoryInitialized && current.revision > 0)
      throw new OfficeError('conflict', 'Native authority revisions require their original employee directory')
    if (current.governanceEnabled === governanceEnabled) return
    await this.domain.global.set({ revision: directoryInitialized ? collaborationRevision(current.revision) : current.revision,
      governanceEnabled })
  }

  /**
   * Read the current authentication revision without coupling it to task, message or file writes.
   * @returns The configured monotonic counter.
   */
  current(): number {
    const current = this.domain.global.get()
    if (current.governanceEnabled === null) throw new OfficeError('conflict', 'Native authority was not configured')
    return current.revision
  }

  /**
   * Invalidate earlier authority observations before a role/active directory commit.
   * The owner calls this only after checking the initiating administrator inside its mutation queue.
   * @returns After durability; a later failed directory commit conservatively invalidates earlier work.
   */
  async advance(): Promise<void> {
    const revision = collaborationRevision(this.current())
    await this.domain.global.set({ ...this.domain.global.get(), revision })
  }
}
