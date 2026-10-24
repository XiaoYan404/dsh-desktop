/** Recover legacy child restrictions from an exact parent-owned catalog position. */
import type SessionQuery from '@deepseek-ai/dsh-session-query'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { officeRunHistoryProjection, type OfficeRunHistoryState } from './native-history.ts'

/**
 * Reconstruct a legacy child's restriction without activating a parent or using its later role reviews.
 * @param query - Existing asynchronous logical Session reader.
 * @param header - Child identity and original parent metadata from the current observation.
 * @param state - Child's committed fold; explicit role reviews are preserved, while conflicting ancestral employees remain restricted.
 * @param signal - Owning read or execution cancellation.
 * @returns Proven original affiliation, including a wholly Native ancestry, or null when original affiliation is unresolved.
 */
export async function readOfficeRunAncestry(query: Pick<SessionQuery, 'observeSession'>, header: SessionHeader,
  state: OfficeRunHistoryState, signal: AbortSignal): Promise<OfficeRunHistoryState | null> {
  signal.throwIfAborted()
  if (state.inherited || header.origin !== 'subagent') return state
  const visited = new Set<SessionId>([header.id])
  let child = header
  while (child.parentSession !== undefined) {
    signal.throwIfAborted()
    if (visited.has(child.parentSession) || visited.size >= 128)
      throw new Error('Office Session ancestry is cyclic or exceeds the supported depth')
    visited.add(child.parentSession)
    try {
      using parent = await query.observeSession(child.parentSession, { signal, projectionMode: 'none' })
      signal.throwIfAborted()
      const matches = parent.events.filter(event => event.type === 'subagent/catalog'
        && event.data.childId === child.id && event.data.childCreatedAt === child.createdAt && event.data.mode !== 'external')
      if (matches.length === 0) {
        // With no office claim anywhere in this complete parent log, a catalog boundary cannot change its affiliation.
        let complete = officeRunHistoryProjection.init()
        for (const event of parent.events) complete = officeRunHistoryProjection.apply(complete, event)
        if (complete.owner !== null) return null
        if (parent.header.origin !== 'subagent') return state
        child = parent.header
        continue
      }
      if (matches.length !== 1) throw new Error('Office Session ancestry has conflicting catalog records')
      const boundary = matches[0]
      if (!boundary) return null
      let inherited: OfficeRunHistoryState = officeRunHistoryProjection.init()
      for (const event of parent.events) {
        if (event.seq >= boundary.seq) break
        inherited = officeRunHistoryProjection.apply(inherited, event)
      }
      signal.throwIfAborted()
      if (inherited.owner !== null || parent.header.origin !== 'subagent') {
        if (!inherited.owner) return state
        const { pendingRole: _pendingRole, ...retained } = state
        return { ...retained, owner: state.owner && !state.pendingRole ? state.owner : inherited.owner,
          mixed: state.mixed || inherited.mixed || state.owner !== null && state.owner.memberId !== inherited.owner.memberId,
          invalid: state.invalid || inherited.invalid }
      }
      child = parent.header
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
      throw error
    }
  }
  return null
}
