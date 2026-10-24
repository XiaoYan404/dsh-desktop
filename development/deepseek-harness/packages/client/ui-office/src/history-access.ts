/** Employee checks at the Native history controller's read-only delivery points. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-remotes'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-api-job-controller'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { OfficeRunHistoryState } from './native-history.ts'
import { readOfficeRunAncestry } from './native-ancestry.ts'

/**
 * Restrict attributed history to its active employee without activating cold Agents or exposing Host state on the wire.
 * @param ctx - Office plugin with authenticated employee, Native read and projection services.
 * @param lifetime - Plugin lifetime; captured reads cannot deliver data after withdrawal.
 */
export function installOfficeHistoryAccess(ctx: Context, lifetime: AbortSignal): void {
  const resourceOwners = new WeakMap<AbortSignal, Map<SessionId, OfficeRunHistoryState['owner']>>()
  let credentialEpoch = new AbortController()
  ctx.on('credentials/record-updated', (key) => {
    if (key !== 'client-ui-office/office-session') return
    const previous = credentialEpoch
    credentialEpoch = new AbortController()
    previous.abort()
  })
  const addressId = (address: SessionAddress): SessionId => address.kind === 'session' ? address.sessionId : address.childSessionId
  const readHistory = async (sessionId: SessionId, signal: AbortSignal): Promise<OfficeRunHistoryState> => {
    lifetime.throwIfAborted()
    signal.throwIfAborted()
    try {
      using observation = await ctx.sessionQuery.observeSession(sessionId,
        { signal, projectionMode: 'none', stateKeys: ['officeRunOwnership'] })
      const history = observation.states?.officeRunOwnership
      if (history === undefined) throw new RemoteError('session/projections-unavailable', 'Office history policy is unavailable', {})
      lifetime.throwIfAborted()
      signal.throwIfAborted()
      const ancestry = await readOfficeRunAncestry(ctx.sessionQuery, observation.header, history,
        AbortSignal.any([lifetime, signal]))
      if (ancestry === null) throw new RemoteError('session/not-found', 'Session not found', { sessionId })
      return ancestry
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', 'Session not found', { sessionId })
      }
      throw error
    }
  }
  const assertReadable = async (sessionId: SessionId, signal: AbortSignal,
    requireRole = false): Promise<OfficeRunHistoryState> => {
    const history = await readHistory(sessionId, signal)
    if (history.owner === null) return history
    const connection = await ctx.officeController.connection()
    lifetime.throwIfAborted()
    signal.throwIfAborted()
    if (!connection.ok || !connection.value.connected || !connection.value.member?.active
      || connection.value.member.id !== history.owner.memberId || history.mixed || history.invalid
      || requireRole && connection.value.member.role !== history.owner.role) {
      throw new RemoteError('session/not-found', 'Session not found', { sessionId })
    }
    return history
  }
  ctx.on('api-session/visible', async ({ candidates, signal }, next) => {
    const remaining = new Set(await next())
    const histories: { sessionId: SessionId; history: OfficeRunHistoryState | undefined }[] = []
    for (const candidate of candidates) {
      if (!remaining.has(candidate.sessionId)) continue
      // Preserve the Native migration entry without trying to interpret an older log.
      if (candidate.formatStatus === 'migration-required') {
        histories.push({ sessionId: candidate.sessionId, history: undefined })
        continue
      }
      try {
        histories.push({ sessionId: candidate.sessionId, history: await readHistory(candidate.sessionId, signal) })
      } catch (error: unknown) {
        // A Session removed during enumeration is no longer a result; other failures stay visible.
        if (!(error instanceof RemoteError) || error.code !== 'session/not-found') throw error
      }
    }
    const attributed = histories.some(({ history }) => history?.owner !== undefined && history.owner !== null)
    const connection = attributed ? await ctx.officeController.connection() : undefined
    lifetime.throwIfAborted()
    signal.throwIfAborted()
    const member = connection?.ok && connection.value.connected ? connection.value.member : undefined
    return histories.filter(({ history }) => history?.owner === undefined || history.owner === null
      || member?.active && history.owner.memberId === member.id && !history.mixed && !history.invalid)
      .map(({ sessionId }) => sessionId)
  })
  ctx.on('api-session/page', async ({ request, signal }, next) => {
    const result = await next()
    await assertReadable(addressId(request.address), signal)
    return result
  })
  ctx.on('api-session/projections', async ({ request, signal }, next) => {
    const result = await next()
    // Pre-office generations retain the Native migration-hint path without activation.
    if (result !== null && result.kind !== 'migration-required') await assertReadable(request.sessionId, signal)
    return result
  })
  ctx.on('api-session/follow', async function* ({ request, signal }, next) {
    for await (const frame of next()) {
      await assertReadable(addressId(request.address), signal)
      yield frame
    }
  })
  const visibleIds = async (ids: readonly SessionId[], signal: AbortSignal): Promise<ReadonlySet<SessionId>> => {
    lifetime.throwIfAborted()
    signal.throwIfAborted()
    const candidates = ids.map(sessionId => ({ sessionId }))
    const allowed = await ctx.waterfall('api-session/visible', { candidates, signal }, () => Promise.resolve(ids))
    lifetime.throwIfAborted()
    signal.throwIfAborted()
    return new Set(allowed)
  }
  ctx.on('api-workspace/visible', async ({ sessionIds, signal }, next) => {
    const remaining = await next()
    const allowed = await visibleIds(remaining, signal)
    return sessionIds.filter(id => allowed.has(id))
  })
  ctx.on('workspace/session-mutation', async ({ sessionIds }, next) => {
    await next()
    const allowed = await visibleIds(sessionIds, lifetime)
    const hidden = sessionIds.find(id => !allowed.has(id))
    if (hidden !== undefined) throw new RemoteError('session/not-found', 'Session not found', { sessionId: hidden })
  })
  for (const event of ['workspace-files/access', 'terminal/access', 'job/access', 'deliverables/access'] as const) {
    ctx.on(event, async ({ sessionId, signal }, next) => {
      const epoch = credentialEpoch.signal
      const previous = await next()
      const allowed = await visibleIds([sessionId], signal)
      if (!allowed.has(sessionId)) throw new RemoteError('session/not-found', 'Session not found', { sessionId })
      const { owner } = await assertReadable(sessionId, signal, true)
      let admitted = resourceOwners.get(signal)
      if (admitted === undefined) { admitted = new Map(); resourceOwners.set(signal, admitted) }
      const expected = admitted.get(sessionId)
      // This snapshot only restricts a retained request; every delivery still checks current authority above.
      if (admitted.has(sessionId) && (expected?.memberId !== owner?.memberId || expected?.role !== owner?.role)) {
        throw new RemoteError('session/not-found', 'Session not found', { sessionId })
      }
      admitted.set(sessionId, owner)
      // A committed grant replacement revokes this request even when the employee signs back in.
      if (owner !== null) epoch.throwIfAborted()
      const authority = owner === null ? lifetime : AbortSignal.any([lifetime, epoch])
      return previous === undefined ? authority : AbortSignal.any([previous, authority])
    })
  }
  ctx.on('api-remotes/emit', (payload, next) => {
    if (payload.event !== 'api-session/added') return next()
    return (async () => {
      if (!await next()) return false
      const summary = payload.args[0]
      if (summary === null || typeof summary !== 'object' || Array.isArray(summary)
        || typeof summary.sessionId !== 'string') throw new TypeError('Invalid queued Session summary')
      const sessionId = summary.sessionId as SessionId
      const allowed = await visibleIds([sessionId], payload.signal)
      return allowed.has(sessionId)
    })()
  })
  ctx.on('api-session/control', async function* ({ signal }, next) {
    for await (const frame of next()) {
      if (frame.type === 'baseline') {
        const entries = Object.entries(frame.value.projections)
        const allowed = await visibleIds(entries.map(([id]) => id as SessionId), signal)
        yield { type: 'baseline', value: { projections: Object.fromEntries(
          entries.filter(([id]) => allowed.has(id as SessionId))) } }
      } else {
        const allowed = await visibleIds([frame.sessionId], signal)
        if (allowed.has(frame.sessionId)) yield frame
      }
    }
  })
}
