/** Compile-only public capability checks; this module is not loaded by the three behavior cases. */
import type { DomainAtomicMutator } from '@deepseek-ai/dsh-storage-domain'
import type { workspaceDomainSpec } from '@deepseek-ai/dsh-workspace'

/**
 * Retain synchronous preparation/publication and existing Workspace key branding in the public API.
 * @param mutate - Spec-typed capability; this function is never invoked at runtime.
 */
export function checkAtomicTypes(mutate: DomainAtomicMutator<typeof workspaceDomainSpec>): void {
  const prepare = () => ({ mutation: { records: [] }, value: 1 })
  // @ts-expect-error Publication must finish synchronously before notifications; async is not assignable to undefined.
  void mutate(prepare, async () => {})
  // @ts-expect-error Preparation runs synchronously on the domain chain.
  void mutate(async () => prepare())
  // @ts-expect-error Record keys retain WorkspaceId branding through the batch API.
  void mutate(() => ({ mutation: { records: [{ table: 'workspaces', operation: 'delete', key: 'unbranded' }] }, value: 1 }))
}
