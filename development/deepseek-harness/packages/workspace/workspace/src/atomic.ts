/** Atomic Workspace registration mutations; backends without this capability retain the pending-marker implementation. */
import type { DomainAtomicMutator } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceDomainState, WorkspaceId, WorkspaceRecord, workspaceDomainSpec } from '@deepseek-ai/dsh-workspace'

/**
 * Commit one registration and its next global order together.
 * @param mutate - Capability explicitly provided by the opened Domain.
 * @param input - Existing Registry's new stable identity/record and first-use flag.
 * @param current - Current Registry state, read synchronously at the Domain's chain slot.
 * @param publish - Replace Registry state/entity cache after acknowledgement and before Domain notifications.
 * @returns The complete committed Registry state.
 */
export function createWorkspaceAtomic(mutate: DomainAtomicMutator<typeof workspaceDomainSpec>,
  input: { readonly id: WorkspaceId; readonly record: WorkspaceRecord; readonly firstUse: boolean },
  current: () => WorkspaceDomainState, publish: (state: WorkspaceDomainState) => undefined): Promise<WorkspaceDomainState> {
  return mutate(() => {
    const state = current()
    const next: WorkspaceDomainState = { ...state, pendingMutation: undefined, initialized: true,
      ...(input.firstUse ? { defaultWorkspaceId: input.id } : {}), workspaceIds: [input.id, ...state.workspaceIds] }
    return { mutation: { records: [{ table: 'workspaces', operation: 'put', key: input.id, value: input.record }], global: { value: next } },
      value: next }
  }, publish)
}

/**
 * Commit one registration removal and global order together; the provider removes only its candidate ledger.
 * @param mutate - Capability explicitly provided by the opened Domain.
 * @param id - Existing Workspace identity; no Session or directory deletion is requested.
 * @param current - Current Registry state, read at the shared write-chain slot.
 * @param publish - Remove the entity and replace Registry state before Domain notifications.
 * @returns The committed state with first-use identity, archive and pins retained.
 */
export function deleteWorkspaceAtomic(mutate: DomainAtomicMutator<typeof workspaceDomainSpec>, id: WorkspaceId,
  current: () => WorkspaceDomainState, publish: (state: WorkspaceDomainState) => undefined): Promise<WorkspaceDomainState> {
  return mutate(() => {
    const state = current()
    const next: WorkspaceDomainState = { ...state, pendingMutation: undefined, initialized: true,
      workspaceIds: state.workspaceIds.filter(candidate => candidate !== id) }
    return { mutation: { records: [{ table: 'workspaces', operation: 'delete', key: id }], global: { value: next } }, value: next }
  }, publish)
}
