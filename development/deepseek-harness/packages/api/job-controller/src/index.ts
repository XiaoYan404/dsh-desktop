/**
 * Host job Remote owner: streams the background-job roster one session can
 * see and one job's retained output to browsers over the generated `job`
 * namespace, and stops a job on a human's behalf. The streams are
 * projections of `ctx.jobs`; the model's consuming cursor and notice state
 * never observe them, and a human kill is not the model's own, so the
 * completion notice still reaches the owning agent.
 * @module @deepseek-ai/dsh-api-job-controller
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { observeJobOutput } from './observe.ts'
import { streamJobRows } from './rows.ts'
import type { JobKillRequest, JobKillValue, JobFollowFrame, JobFollowRequest, JobListFrame, JobListRequest } from './types.ts'

export type * from './types.ts'

/** Host-only Session authority input for the optional `job/access` policy. */
export interface JobAccessRequest {
  /** Session whose visible jobs the Remote caller requests. */
  readonly sessionId: SessionId
  /** Cancellation of this authority check; abort must not cancel a job. */
  readonly signal: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host job Remote namespace owner. */
    jobController: JobController
  }
  interface Events {
    /**
     * Authorize Session job observations and human cancellation without activating an Agent.
     * @mode waterfall
     * @param request - Session identity and cancellation for this access check.
     * @param next - Delegate and retain any earlier policy lifetime.
     * @returns Installed policy lifetime, aborted when that policy is withdrawn; undefined when none is installed.
     */
    'job/access': (request: JobAccessRequest,
      next: () => Promise<AbortSignal | undefined>) => Promise<AbortSignal | undefined>
  }
}

/** Default coalescing window between reads, in milliseconds. */
const DEFAULT_OBSERVE_FLUSH_MS = 100

/** Default soft byte budget per output frame. */
const DEFAULT_OBSERVE_MAX_FRAME_BYTES = 64 * 1024

/** Job Controller deployment policy. */
export interface Config {
  /** Coalescing window after a registry commit before the next rows or output read, in milliseconds (default 100). */
  readonly observeFlushMs?: number
  /** Soft byte budget per observation output frame (default 65536); one larger chunk ships whole. */
  readonly observeMaxFrameBytes?: number
}

/** Host service backing the generated `ctx.remote.job` namespace. */
export class JobController extends TypertRemoteService {
  static inject = ['jobs', 'typert']

  static Config: z<Config> = z.object({
    observeFlushMs: z.natural().min(1).default(DEFAULT_OBSERVE_FLUSH_MS),
    observeMaxFrameBytes: z.natural().min(1).default(DEFAULT_OBSERVE_MAX_FRAME_BYTES),
  })

  private readonly observeFlushMs: number
  private readonly observeMaxFrameBytes: number
  private policySeen = false

  /**
   * @param ctx - Host context carrying the live Agent registry and the job registry.
   * @param config - observation cadence and framing policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'jobController', { namespace: 'job' })
    // schemastery (the exported Config schema) has already filled the defaulted
    // fields; the assertion records that resolution, not a hidden fallback.
    const resolved = config as Required<Config>
    this.observeFlushMs = resolved.observeFlushMs
    this.observeMaxFrameBytes = resolved.observeMaxFrameBytes
  }

  /**
   * Stream the jobs one session can see — its own plus every unowned job —
   * as whole-set frames: one on open, then one after each coalesced burst of
   * lifecycle commits. Access is checked before opening and before every frame;
   * withdrawal aborts the observation without cancelling its jobs. The stream
   * has no natural end; the carrier closes it.
   * @param request - the session whose visible set to mirror.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns the roster frames.
   */
  @Remote({ mode: 'stream' })
  list(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame> {
    return this.authorizedStream(request.sessionId, signal, activeSignal =>
      streamJobRows(this.ctx.jobs, request, { flushMs: this.observeFlushMs }, activeSignal))
  }

  /**
   * Stream one job's retained output from an absolute byte offset, then its
   * terminal projection once settled and drained. Non-consuming: the
   * model-facing cursor and notice state never observe these reads. The
   * request's session is the fenced read's caller; the registry rejects a
   * job the session cannot see and an unknown job. Session access is checked
   * before opening and before each frame. Policy withdrawal ends observation
   * without cancelling the job or advancing its model cursor.
   * @param request - target job, owning session, and optional resume offset.
   * @param signal - cancellation owned by the Remote stream carrier.
   * @returns anchor, coalesced output frames, and the terminal status.
   */
  @Remote({ mode: 'stream' })
  follow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame> {
    return this.authorizedStream(request.sessionId, signal, activeSignal => observeJobOutput(this.ctx.jobs, request, {
      flushMs: this.observeFlushMs,
      maxFrameBytes: this.observeMaxFrameBytes,
    }, activeSignal))
  }

  /**
   * Authorize the human Remote `job.kill` before requesting cancellation.
   * Denial, abort, or unavailable policy leaves the producer and job untouched.
   * @param request - Session whose job list carries the job, and the job id.
   * @param signal - Remote call cancellation.
   * @returns The registry's admission after current Session authority is checked.
   */
  @Remote('kill')
  async requestKill(request: JobKillRequest, signal: AbortSignal): Promise<JobKillValue> {
    const authority = await this.authorize(request.sessionId, signal)
    authority?.throwIfAborted()
    signal.throwIfAborted()
    return this.kill(request)
  }

  /**
   * Cancel a job from trusted Host code under the registry's Session owner fence.
   * This synchronous Host method is not a Remote endpoint. The kill records
   * `cancelled by the user` as its reason; it is not one the model requested,
   * so the owning agent still receives the completion notice, and a shell
   * tool waiting on that job reads the reason in its own result.
   * @param request - Session whose job list carries the job, and the job id.
   * @returns the registry's admission of the kill request.
   */
  kill(request: JobKillRequest): JobKillValue {
    const jobs = this.ctx.jobs
    try {
      jobs.get(request.jobId, request.sessionId)
    } catch (error) {
      // `unknown job` and `belongs to another session` both mean this session's
      // list no longer carries a killable row; the client renders one story.
      throw new RemoteError('job/not-found', String(error), {
        sessionId: request.sessionId,
        jobId: request.jobId,
      })
    }
    // Same synchronous span as the lookup, so nothing can remove the job in
    // between — and a producer-cancel throw propagates per the registry
    // contract (job state unchanged) instead of masquerading as job-not-found.
    const outcome = jobs.kill(request.jobId, request.sessionId, 'cancelled by the user')
    return { outcome }
  }

  private async authorize(sessionId: SessionId | undefined, signal: AbortSignal): Promise<AbortSignal | undefined> {
    signal.throwIfAborted()
    // An omitted caller can only observe an unowned job under the registry's own fence.
    if (sessionId === undefined) return undefined
    let authority: AbortSignal | undefined
    try {
      authority = await this.ctx.waterfall('job/access', { sessionId, signal }, () => Promise.resolve(undefined))
    } catch (error) {
      this.policySeen = true
      throw error
    }
    if (authority !== undefined) this.policySeen = true
    if (this.policySeen && authority === undefined) {
      throw new RemoteError('job/access-unavailable', 'Job authorization policy is unavailable', {})
    }
    authority?.throwIfAborted()
    signal.throwIfAborted()
    return authority
  }

  private async *authorizedStream<Frame>(
    sessionId: SessionId | undefined,
    signal: AbortSignal,
    open: (activeSignal: AbortSignal) => AsyncIterable<Frame>,
  ): AsyncIterable<Frame> {
    const authority = await this.authorize(sessionId, signal)
    const activeSignal = authority === undefined ? signal : AbortSignal.any([signal, authority])
    try {
      for await (const frame of open(activeSignal)) {
        authority?.throwIfAborted()
        await this.authorize(sessionId, signal)
        authority?.throwIfAborted()
        yield frame
      }
      authority?.throwIfAborted()
      if (!signal.aborted) {
        await this.authorize(sessionId, signal)
        authority?.throwIfAborted()
      }
    } catch (error) {
      if (!signal.aborted) {
        authority?.throwIfAborted()
        await this.authorize(sessionId, signal)
        authority?.throwIfAborted()
      }
      throw error
    }
  }
}

export default JobController
