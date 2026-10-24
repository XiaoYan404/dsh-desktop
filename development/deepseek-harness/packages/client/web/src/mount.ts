/**
 * Application mount through a dependency fiber, so replacing `uiRenderer`
 * remounts the application. Shared by `AppWebEntry` and the test carrier.
 * @module @deepseek-ai/dsh-client-web/src/mount
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ClientEntryState } from '@deepseek-ai/dsh-client-modules/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** The boot kernel owns replacement progress and visible assembly failures. */
export interface ClientMountLifecycle {
  readonly entries: ObservableSnapshot<ClientEntryState>
  /** @param reason - Assembly failure to present through the boot kernel. */
  failed(reason: unknown): void
}

/**
 * Mount the UI renderer into `container` through a dependency fiber on
 * `uiRenderer`: the mount effect installs when the service is provided and
 * reinstalls when it is replaced.
 * @param ctx - booted root Context.
 * @param container - application mount point.
 * @param lifecycle - Optional live entry state and kernel failure presentation.
 * @returns resolves once the dependency fiber exists; with `uiRenderer`
 * already provided (as after `bootClient`) the mount effect is installed by
 * then, otherwise it installs when the service arrives.
 */
export async function mountClient(ctx: Context, container: HTMLElement, lifecycle?: ClientMountLifecycle): Promise<void> {
  const mounted = ctx.inject(lifecycle === undefined ? ['uiRenderer'] : ['uiRenderer', 'slots'], (scope) => {
    if (lifecycle === undefined) {
      scope.effect(() => scope.uiRenderer.mount(container), 'web boot: application mount')
      return
    }
    scope.effect(() => {
      let dispose: (() => void) | undefined
      let missingReported = false
      const unmount = () => { const previous = dispose; dispose = undefined; previous?.() }
      const reconcile = () => {
        const syncing = lifecycle.entries.getSnapshot().syncing
        const hasRoot = scope.slots.entries('root').length > 0
        if (!hasRoot) unmount()
        if (syncing) { missingReported = false; return }
        if (!hasRoot) {
          if (!missingReported) {
            missingReported = true
            lifecycle.failed(new Error('web boot: root registration is unavailable after client synchronization'))
          }
          return
        }
        missingReported = false
        if (dispose === undefined) {
          try { dispose = scope.uiRenderer.mount(container) }
          catch (error) { lifecycle.failed(error) }
        }
      }
      // Observe withdrawals before the mounted Root outlet subscribes to this registry.
      const stopRoot = scope.slots.subscribe('root', reconcile)
      const stopEntries = lifecycle.entries.subscribe(reconcile)
      reconcile()
      return () => { stopRoot(); stopEntries(); unmount() }
    }, 'web boot: synchronized application mount')
  })
  await mounted
}
