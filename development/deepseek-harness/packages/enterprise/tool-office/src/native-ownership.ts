/** Recover and enforce employee affiliation for live Native runs and their delegated children. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { HarnessError, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { OfficeMemberId, OfficeRole } from '@deepseek-ai/dsh-enterprise-office/types'
import type {} from '@deepseek-ai/dsh-client-ui-office/types'
import { officeBffRequest } from './driver.ts'
import { officeRunClaims, type OfficeRunClaim } from './native-claims.ts'
import { officeRunHistoryProjection, readOfficeRunAncestry, type OfficeRunHistoryState } from './native-history.ts'

export type { OfficeRunClaim } from './native-claims.ts'
interface OwnedRun {
  readonly memberId: OfficeMemberId
  readonly role: OfficeRole
  readonly invalid: boolean
}

/** A live scope stays with its first employee; children retain their own inherited snapshot. */
export class OfficeRunOwnership {
  private readonly owners = new Map<object, OwnedRun>()
  private mixed = new WeakSet<object>()
  private claimed = new WeakSet<object>()

  /**
   * Restore restrictions from the original event fold without clearing a live conflicting claim.
   * @param scope - Exact live Agent key.
   * @param history - Derived Native input affiliation, without execution authority.
   */
  restore(scope: object, history: OfficeRunHistoryState): void {
    if (!history.owner) return
    if (history.mixed) this.mixed.add(scope)
    const previous = this.owners.get(scope)
    const memberId = previous?.memberId ?? history.owner.memberId
    const role = this.claimed.has(scope) ? previous?.role ?? history.owner.role : history.owner.role
    const invalid = history.mixed || history.invalid || previous?.invalid === true || memberId !== history.owner.memberId
    if (previous?.memberId === memberId && previous.role === role && previous.invalid === invalid) return
    this.owners.set(scope, { memberId, role, invalid })
  }

  /**
   * Snapshot the registry's explicit runtime owner even when creation used an unscoped service.
   * @param scope - Newly published child Agent.
   * @param parent - Exact live runtime owner from the Agent registry.
   */
  inherit(scope: object, parent: object): void {
    if (this.owners.has(scope)) return
    const owner = this.get(parent)
    if (owner) {
      this.owners.set(scope, { ...owner })
      if (this.mixed.has(parent)) this.mixed.add(scope)
    }
  }

  /**
   * Read or inherit the nearest enclosing employee without retaining the parent Agent.
   * @param scope - Exact live Agent scope key.
   * @returns Its pinned employee snapshot, or undefined for an unassociated Native scope.
   */
  get(scope: object): OwnedRun | undefined {
    const own = this.owners.get(scope)
    if (own) return own
    for (const parent of scopeChainOf(scope).slice(1)) {
      const inherited = this.owners.get(parent)
      if (!inherited) continue
      const copy = { ...inherited }
      this.owners.set(scope, copy)
      if (this.mixed.has(parent)) this.mixed.add(scope)
      return copy
    }
    return undefined
  }

  /**
   * Capture the inherited restriction for the child's own durable history.
   * @param scope - Exact parent Agent whose current restrictions are inherited.
   * @returns Restriction evidence without retaining the parent object.
   */
  snapshot(scope: object): OfficeRunHistoryState {
    const owned = this.get(scope)
    return { owner: owned ? { memberId: owned.memberId, role: owned.role } : null,
      mixed: this.mixed.has(scope), invalid: owned?.invalid ?? false }
  }

  /**
   * Claim the current submission without allowing steering or another employee to remove ownership.
   * @param scope - Exact claiming Agent scope key.
   * @param claims - Submitted office contexts; an empty list preserves any existing ownership.
   */
  claim(scope: object, claims: readonly OfficeRunClaim[]): void {
    const previous = this.get(scope)
    const first = claims[0]
    if (!first) return
    this.claimed.add(scope)
    const memberId = previous?.memberId ?? first.memberId
    const invalid = this.mixed.has(scope)
      || claims.some(claim => !claim.matchesConversation || claim.memberId !== memberId || claim.role !== first.role)
    const role = first.memberId === memberId ? first.role : previous?.role ?? first.role
    if (previous?.memberId === memberId && previous.role === role && previous.invalid === invalid) return
    this.owners.set(scope, { memberId, role, invalid })
  }

  /**
   * Release a disposed Agent; already inherited children keep their snapshots.
   * @param scope - Disposed Agent key.
   */
  delete(scope: object): void { this.owners.delete(scope); this.mixed.delete(scope); this.claimed.delete(scope) }
  /** Withdraw all ownership with the installing plugin. */
  clear(): void { this.owners.clear(); this.mixed = new WeakSet(); this.claimed = new WeakSet() }
}

/**
 * Check current office authority before model admission and around approved Native tool dispatch.
 * @param ctx - Optional office plugin with live Agent and authenticated office-controller services.
 * @param lifetime - Installing plugin lifetime; late work cannot disclose results after unload.
 */
export function installOfficeRunOwnership(ctx: Context, lifetime: AbortSignal): void {
  const ownership = new OfficeRunOwnership()
  const agents = ctx.agents
  let credentialEpoch = new AbortController()
  const turnEpochs = new WeakMap<Agent, { turn: number; signal: AbortSignal }>()
  const cancelOwned = (): Agent[] => {
    const active = agents.list().filter(agent => agent.status === 'running' && ownership.get(agent) !== undefined)
    const failures: unknown[] = []
    for (const agent of active) {
      try { agent.cancel({ kind: 'disposed' }, { keepInbox: true }) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Office Native cancellation failed')
    return active
  }
  ctx.on('credentials/record-updated', (key) => {
    if (key !== 'client-ui-office/office-session') return
    const previous = credentialEpoch
    credentialEpoch = new AbortController()
    previous.abort()
    cancelOwned()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start') return
    const agent = agents.get(session.id)
    if (agent?.session === session) turnEpochs.set(agent, { turn: event.data.turn, signal: credentialEpoch.signal })
  })
  const epochFor = (agent: Agent): AbortSignal => {
    const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (boundary === undefined) throw new HarnessError('Native turn projection is unavailable.', 'OFFICE_NATIVE_AUTHORITY_UNAVAILABLE')
    const previous = turnEpochs.get(agent)
    if (previous?.turn === boundary.lastTurn) return previous.signal
    const current = { turn: boundary.lastTurn, signal: credentialEpoch.signal }
    turnEpochs.set(agent, current)
    return current.signal
  }
  const ancestryLifetime = new AbortController()
  const ancestryReads = new WeakMap<Agent, Promise<void>>()
  const pendingAncestry = new Set<Promise<void>>()
  const nativeAncestry = new WeakSet<Agent>()
  ctx.sessionProjections.register(officeRunHistoryProjection)
  const parentOf = (agent: Agent): Agent | undefined => {
    const agents = ctx.agents.list()
    return agents.find(candidate => ctx.agents.isOwnedBy(agent.id, candidate))
      ?? scopeChainOf(agent).slice(1).map(scope => agents.find(candidate => candidate === scope)).find(candidate => candidate !== undefined)
  }
  const recover = (agent: Agent): void => {
    if (ctx.agents.get(agent.id) !== agent) throw changed()
    const state = ctx.sessionProjections.stateOf(agent.session, 'officeRunOwnership')
    if (state === undefined) throw new HarnessError('Office ownership projection is unavailable.', 'OFFICE_NATIVE_AUTHORITY_UNAVAILABLE')
    ownership.restore(agent, state)
    const parent = parentOf(agent)
    if (parent) { recover(parent); ownership.inherit(agent, parent) }
    ownership.get(agent)
  }
  const recoverLegacy = async (agent: Agent, signal: AbortSignal): Promise<void> => {
    ancestryLifetime.signal.throwIfAborted()
    recover(agent)
    const parentSession = agent.session.header.parentSession
    const history = ctx.sessionProjections.stateOf(agent.session, 'officeRunOwnership')
    if (history === undefined) throw new HarnessError('Office ownership projection is unavailable.', 'OFFICE_NATIVE_AUTHORITY_UNAVAILABLE')
    if (history.inherited || nativeAncestry.has(agent) || agent.session.header.origin !== 'subagent') return
    const query = ctx.get('sessionQuery')
    if (!query || parentSession === undefined) throw unresolvedAncestry()
    const existing = ancestryReads.get(agent)
    if (existing) { await existing; return }
    const readSignal = AbortSignal.any([signal, lifetime, ancestryLifetime.signal])
    const pending: Promise<void> = (async () => {
      const inherited = await readOfficeRunAncestry(query, agent.session.header, history, readSignal)
      readSignal.throwIfAborted()
      if (ctx.agents.get(agent.id) !== agent) throw changed()
      if (inherited === null) throw unresolvedAncestry()
      if (inherited.owner) {
        agent.session.append('office/run-inherited', { owner: inherited.owner, mixed: inherited.mixed,
          invalid: inherited.invalid, parentSession })
        recover(agent)
      } else nativeAncestry.add(agent)
    })().finally(() => { ancestryReads.delete(agent); pendingAncestry.delete(pending) })
    ancestryReads.set(agent, pending)
    pendingAncestry.add(pending)
    await pending
  }
  ctx.effect(() => async () => {
    ancestryLifetime.abort()
    credentialEpoch.abort()
    const stopped = cancelOwned()
    const outcomes = await Promise.allSettled(stopped.map(agent => agent.whenIdle()))
    const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length) throw new AggregateError(failures, 'Office Native shutdown did not settle')
    await Promise.allSettled(pendingAncestry)
    ownership.clear()
  }, 'office-run-ownership.close')
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    recover(agent)
    const parent = parentOf(agent)
    if (parent) {
      await recoverLegacy(parent, signal ?? ancestryLifetime.signal)
      const inherited = ownership.snapshot(parent)
      const history = ctx.sessionProjections.stateOf(agent.session, 'officeRunOwnership')
      if (inherited.owner && (source !== 'resume' || history?.owner === null)) {
        agent.session.append('office/run-inherited', { ...inherited, owner: inherited.owner, parentSession: parent.id })
        recover(agent)
      } else if (source !== 'resume' && history?.owner === null) nativeAncestry.add(agent)
    }
    if (source === 'resume') await recoverLegacy(agent, signal ?? ancestryLifetime.signal)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => { ownership.delete(agent) })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    recover(agent)
    ownership.claim(agent, officeRunClaims(message, String(agent.id)))
  })

  const live = (agent: Agent): boolean => ctx.agents.get(agent.id) === agent && agent.status === 'running'
  const assertCurrent = async (agent: Agent, expected: OwnedRun, signal: AbortSignal, epoch: AbortSignal): Promise<void> => {
    epoch.throwIfAborted()
    ancestryLifetime.signal.throwIfAborted()
    lifetime.throwIfAborted()
    signal.throwIfAborted()
    if (expected.invalid || !live(agent)) throw changed()
    const result = await officeBffRequest(() => ctx.officeController.connection())
    lifetime.throwIfAborted()
    signal.throwIfAborted()
    if (!result.ok) throw new HarnessError('Office authority could not be checked. Restore the company connection and check '
      + 'the original operation outcome before retrying.', 'OFFICE_NATIVE_AUTHORITY_UNAVAILABLE')
    epoch.throwIfAborted()
    const current = result.value.member
    recover(agent)
    if (ownership.get(agent) !== expected || !live(agent)
      || !result.value.connected || !current?.active || current.id !== expected.memberId || current.role !== expected.role) throw changed()
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    await recoverLegacy(agent, signal)
    const owned = ownership.get(agent)
    if (owned) await assertCurrent(agent, owned, signal, epochFor(agent))
    return decision
  })
  ctx.on('llm/stream', (options, next) => {
    const agent = ctx.agents.currentInitiator()
    if (!agent || !isAgentLoopRequest(options) || options.sessionId !== agent.id) {
      return next()
    }
    const signal = options.signal
    return (async function* () {
      await recoverLegacy(agent, signal ?? ancestryLifetime.signal)
      const owned = ownership.get(agent)
      if (!owned) { yield* next(); return }
      if (!signal) throw new HarnessError('Office model stream has no cancellation owner.', 'OFFICE_NATIVE_AUTHORITY_UNAVAILABLE')
      const epoch = epochFor(agent)
      await assertCurrent(agent, owned, signal, epoch)
      for await (const chunk of next()) {
        await assertCurrent(agent, owned, signal, epoch)
        yield chunk
      }
    })()
  }, { prepend: true })
  ctx.on('tools/execute', async (exec, next) => {
    const agent = exec.agent
    if (agent) await recoverLegacy(agent, exec.signal)
    const owned = agent && ownership.get(agent)
    if (!agent || !owned) return next()
    const epoch = epochFor(agent)
    await assertCurrent(agent, owned, exec.signal, epoch)
    const result = await next()
    await assertCurrent(agent, owned, exec.signal, epoch)
    return result
  }, { prepend: true })
}

function changed(): HarnessError {
  return new HarnessError('Office account or authority changed. Start a conversation in the current account before continuing. '
    + 'Previously admitted work may already have completed; check its outcome before retrying.', 'OFFICE_NATIVE_AUTHORITY_CHANGED')
}

function unresolvedAncestry(): HarnessError {
  return new HarnessError('Office affiliation of this legacy child cannot be verified. Restore the original parent Session '
    + 'and its child catalog from backup before continuing. Existing history has not been reassigned.',
  'OFFICE_NATIVE_AUTHORITY_UNAVAILABLE')
}
