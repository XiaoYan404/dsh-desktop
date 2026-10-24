/** An explicit AI-entry intent waits for confirmed employee and native catalogs without changing their owners. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'

/** Office destinations share navigation identities independently of their rendered components. */
export type OfficeSection = 'home' | 'calendar' | 'contacts' | 'drive' | 'work' | 'integrations' | 'tools' | 'team'

/** Undefined employee means initialization; null means a confirmed native-only entry. */
export interface OfficeNavigationReadiness {
  readonly employee: OfficeMemberId | null | undefined
  readonly sessionsReady: boolean
  readonly workspacesReady: boolean
}

interface PendingNavigation {
  employee: OfficeMemberId | null | undefined
  readonly controller: AbortController
  readonly finish: (opened: boolean) => void
  readonly detach: () => void
  started: boolean
}

/** One cancellable office navigation intent belongs to this plugin lifetime. */
export class OfficeNavigationModel {
  /** Presentation sees progress only; cancellation handles stay private. */
  readonly state = createSnapshotStore({ waiting: false })
  private readiness: OfficeNavigationReadiness = { employee: undefined, sessionsReady: false, workspacesReady: false }
  private pending: PendingNavigation | undefined
  private disposed = false

  constructor(
    private readonly openReady: (employee: OfficeMemberId | null, signal: AbortSignal) => Promise<boolean>,
    private readonly report: () => void,
  ) {}

  /**
   * Reconcile confirmed dependencies; a changed known identity cancels its earlier intent.
   * @param readiness - Current employee and native catalog lifecycle.
   */
  configure(readiness: OfficeNavigationReadiness): void {
    if (this.disposed) return
    this.readiness = readiness
    const pending = this.pending
    if (pending && pending.employee !== undefined && pending.employee !== readiness.employee) this.cancel()
    else this.proceed()
  }

  /**
   * Remember one entry request until its dependencies are ready.
   * @param signal - Optional home-preparation lifetime.
   * @returns Whether the same request opened its input.
   */
  open(signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || this.pending || signal?.aborted) return Promise.resolve(false)
    return new Promise((finish) => {
      const controller = new AbortController()
      const abort = () => { if (this.pending?.controller === controller) this.cancel() }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending = { employee: this.readiness.employee, controller, finish, started: false,
        detach: () => { signal?.removeEventListener('abort', abort) } }
      this.state.set({ waiting: true })
      this.proceed()
    })
  }

  /** Fence a previous click, home preparation, or explicit navigation without releasing native drafts. */
  cancel(): void {
    const pending = this.pending
    this.pending = undefined
    pending?.controller.abort()
    pending?.detach()
    pending?.finish(false)
    this.state.set({ waiting: false })
  }

  /** A different panel supersedes an entry still waiting for initialization; its own completed open may change panels. */
  cancelWaiting(): void {
    if (this.pending && !this.pending.started) this.cancel()
  }

  /** Cancel owned work before plugin teardown. */
  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  private proceed(): void {
    const pending = this.pending
    if (!pending || pending.started || this.readiness.employee === undefined) return
    pending.employee = this.readiness.employee
    if (pending.employee !== null && (!this.readiness.sessionsReady || !this.readiness.workspacesReady)) return
    pending.started = true
    void this.execute(pending, pending.employee)
  }

  private async execute(pending: PendingNavigation, employee: OfficeMemberId | null): Promise<void> {
    let opened = false
    try { opened = await this.openReady(employee, pending.controller.signal) }
    catch { if (this.pending === pending) this.report() }
    finally {
      if (this.pending === pending) {
        this.pending = undefined
        pending.detach()
        pending.finish(opened && !pending.controller.signal.aborted)
        this.state.set({ waiting: false })
      }
    }
  }
}
