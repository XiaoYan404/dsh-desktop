/** Delivery-time Session filtering for Workspace Remote results and follow frames. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFollowFrame, WorkspaceView } from './types.ts'

/** Filters Session identities without changing authoritative Workspace accounting. */
export class WorkspaceAccess {
  private readonly lifetime = new AbortController()

  /** @param ctx - Controller lifetime and the composed Session visibility policies. */
  constructor(private readonly ctx: Context) {
    ctx.effect(() => () => { this.lifetime.abort() }, 'workspace-controller.access')
  }

  /**
   * Keep the input order and only identities accepted by every policy.
   * @param sessionIds - Detached Session identities to project.
   * @param signal - Optional follow request lifetime.
   * @returns Visible identities, without policy-injected additions.
   */
  async sessions(sessionIds: readonly SessionId[], signal = this.lifetime.signal): Promise<readonly SessionId[]> {
    const active = AbortSignal.any([signal, this.lifetime.signal])
    active.throwIfAborted()
    const accepted = await this.ctx.waterfall('api-workspace/visible', { sessionIds, signal: active },
      () => Promise.resolve(sessionIds))
    active.throwIfAborted()
    const allowed = new Set(accepted)
    return sessionIds.filter(id => allowed.has(id))
  }

  /**
   * Refuse a metadata mutation before entering the registry queue.
   * @param sessionIds - Target and optional order anchor.
   */
  async assert(sessionIds: readonly SessionId[]): Promise<void> {
    const allowed = new Set(await this.sessions(sessionIds))
    const hidden = sessionIds.find(id => !allowed.has(id))
    if (hidden !== undefined) throw new RemoteError('session/not-found', 'Session not found', { sessionId: hidden })
  }

  /**
   * Filter one detached Workspace projection.
   * @param workspace - Snapshot produced by the registry projection.
   * @returns Snapshot containing only currently visible Session identities.
   */
  async workspace(workspace: WorkspaceView): Promise<WorkspaceView> {
    return { ...workspace, sessionIds: await this.sessions(workspace.sessionIds) }
  }

  /**
   * Filter a queued frame immediately before yielding it to a follower.
   * @param frame - Baseline or ordered registry increment.
   * @param signal - Follow generation lifetime.
   * @returns Frame with private Session identities withheld.
   */
  async frame(frame: WorkspaceFollowFrame, signal: AbortSignal): Promise<WorkspaceFollowFrame> {
    switch (frame.type) {
      case 'baseline': {
        const ids = [...new Set([...frame.value.items.flatMap(item => item.sessionIds),
          ...frame.value.archivedSessionIds, ...frame.value.pinnedSessionIds])]
        const allowed = new Set(await this.sessions(ids, signal))
        return { type: 'baseline', value: {
          items: frame.value.items.map(item => ({ ...item, sessionIds: item.sessionIds.filter(id => allowed.has(id)) })),
          archivedSessionIds: frame.value.archivedSessionIds.filter(id => allowed.has(id)),
          pinnedSessionIds: frame.value.pinnedSessionIds.filter(id => allowed.has(id)),
        } }
      }
      case 'upsert':
        return { ...frame, workspace: { ...frame.workspace, sessionIds: await this.sessions(frame.workspace.sessionIds, signal) } }
      case 'archived':
        return { ...frame, archivedSessionIds: await this.sessions(frame.archivedSessionIds, signal) }
      case 'pinned':
        return { ...frame, pinnedSessionIds: await this.sessions(frame.pinnedSessionIds, signal) }
      case 'remove':
      case 'order':
        return frame
      default:
        return assertNever(frame)
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unknown Workspace follow frame: ${String(value)}`)
}
