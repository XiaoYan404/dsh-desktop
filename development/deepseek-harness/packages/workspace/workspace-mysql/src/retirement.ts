/** Directed Workspace producer and SQL consumer retirement. */
import type Storage from '@deepseek-ai/dsh-storage'

/** Each hook has one owner; unit cleanup must not dispose its enclosing SQL scope. */
export interface WorkspaceRetirementHooks {
  /** Synchronously refuse new backend/unit opens; keep existing units usable through upstream drains. */
  stopOpening(): void
  /** Unregister the backend and close its units, only after storage's dependent forms have drained. */
  closeUnits(): Promise<void>
  /** Dispose the SQL scope only from the outer closer, never from its own consumer callback. */
  disposeScope(): Promise<void>
}

/** The consumer callback uses retire; the provider's ctx.effect disposer uses close. */
export interface WorkspaceRetirement {
  /** Fence new opens and settle upstream producers, then units. Repeated calls share the same outcome. */
  retire(): Promise<void>
  /** Retire, then release the SQL scope even after a drain failure. Repeated calls share the same outcome. */
  close(): Promise<void>
}

/** Build one directed shutdown operation using existing public storage methods; no registration is implicit.
 * @param storage - The active storage hub with DomainFacility backend barriers.
 * @param name - Existing backend registry name used by the explicit domain route.
 * @param hooks - Provider-owned admission, unit cleanup and SQL release operations.
 * @returns Separate retirement and outer disposal callbacks; each registration must be owned by ctx.effect.
 */
export function createWorkspaceRetirement(storage: Pick<Storage, 'closeBackend'>, name: string,
  hooks: WorkspaceRetirementHooks): WorkspaceRetirement {
  let retiring: Promise<void> | undefined, closing: Promise<void> | undefined
  const retire = (): Promise<void> => {
    if (retiring) return retiring
    const settled = Promise.withResolvers<void>()
    retiring = settled.promise
    void (async () => {
      hooks.stopOpening()
      await storage.closeBackend(name, () => hooks.closeUnits())
    })().then(settled.resolve, settled.reject)
    return retiring
  }
  return {
    retire,
    close: () => {
      if (closing) return closing
      const drain = retire()
      closing = (async () => {
        const failures: unknown[] = []
        try { await drain } catch (error) { failures.push(error) }
        try { await hooks.disposeScope() } catch (error) { failures.push(error) }
        if (failures.length > 0) throw new AggregateError(failures, 'Workspace backend retirement and SQL disposal failed.')
      })()
      return closing
    },
  }
}
