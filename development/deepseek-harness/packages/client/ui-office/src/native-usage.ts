/** Native accounting observes original Session settlements and never accepts counters from browser mutations. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { } from '@deepseek-ai/dsh-session-query'
import type { OfficeUsageObservation } from '@deepseek-ai/dsh-enterprise-office'
import { officeRunHistoryProjection } from './native-history.ts'
import type { OfficeRunHistoryState } from './native-history.ts'

/**
 * Select only actual provider usage from one original logged settlement, without summing repeated stream updates.
 * @param session - Original session and its immutable fork-prefix count.
 * @param event - Original durable settlement event.
 * @param history - Incrementally folded attribution at this exact log position; role labels grant no permission.
 * @returns Safe coordinate/counters or absence for unattributed, conflicting and inherited events.
 */
export function officeNativeUsageObservation(session: Pick<Session, 'id' | 'inheritedEventCount'>, event: SessionEvent,
  history: OfficeRunHistoryState): OfficeUsageObservation | null {
  if(!history.owner || history.mixed || history.invalid || history.pendingRole || event.seq < session.inheritedEventCount
    || event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
  let usage: TokenUsage | null = event.type === 'assistant/message' ? event.data.usage ?? null : null
  if(event.type === 'assistant/attempt') {
    for(const record of event.data.stream) if(record.type === 'chunk' && record.chunk.type === 'usage') usage = record.chunk.usage
  }
  return {
    sessionId: session.id, seq: event.seq, memberId: history.owner.memberId, time: event.time,
    kind: event.type === 'assistant/message' ? 'message' : 'attempt', usage, inherited: false,
  }
}
/**
 * Register incremental settlement capture with replay, flush failure reporting and plugin-owned drain.
 * @param ctx - Native Host plugin scope with original Session events.
 * @param capture - Trusted same-process accounting owner; central forwarding requires separately configured Host trust.
 * @returns Disposer that unregisters events before draining admitted capture operations.
 */
export function installOfficeNativeUsage(ctx: Context,
  capture: (observation: OfficeUsageObservation) => Promise<void>): () => Promise<void> {
  const pending = new Set<Promise<void>>()
  const failures = new WeakSet<Session>()
  let closed = false
  const observe = (session: Session, event: SessionEvent) => {
    if(closed) return
    const history = ctx.sessionProjections.stateOf(session, 'officeRunOwnership')
    if(!history) throw new Error('Office usage requires the office ownership projection')
    const observation = officeNativeUsageObservation(session, event, history)
    if(!observation) return
    const work = capture(observation)
    pending.add(work)
    void work.then(() => { pending.delete(work) }, () => {
      pending.delete(work); failures.add(session)
      ctx.logger.warn('Office usage capture was not confirmed; accounting coverage is incomplete. Check storage and capacity.')
    })
  }
  const ownership: ProjectionDefinition<'officeRunOwnership'> = officeRunHistoryProjection
  const stopCreated = ctx.on('session/created', (session) => {
    const replay = (async () => {
      using original = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
      if(closed) return
      let history = ownership.init(original.header, session.inheritedEventCount)
      for(const event of original.events) {
        history = ownership.apply(history, event)
        const observation = officeNativeUsageObservation(session, event, history)
        if(observation) await capture(observation)
      }
    })()
    pending.add(replay)
    void replay.catch(() => {
      failures.add(session)
      ctx.logger.warn('Office usage replay was not confirmed; accounting coverage is incomplete. Check original history and storage.')
    }).finally(() => { pending.delete(replay) })
  })
  const stopEvent = ctx.on('session/event', (session, event) => { observe(session, event) })
  const stopFlush = ctx.on('session/flush', async (session) => {
    await Promise.allSettled([...pending])
    if(failures.has(session)) throw new Error('Office usage capture is incomplete for this session')
  })
  return async () => { closed = true; stopCreated(); stopEvent(); stopFlush(); await Promise.allSettled([...pending]) }
}
