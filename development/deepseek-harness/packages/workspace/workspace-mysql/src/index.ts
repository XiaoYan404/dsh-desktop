/** Opt-in normalized MySQL Workspace backend; the Domain route is selected explicitly in the profile. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { createWorkspaceMysqlBackend } from './adapter.ts'
import type { WorkspaceAdapterConfig } from './model.ts'

/** Cordis plugin name. */
export const name = 'workspace-mysql'
/** The backend retains both storage and SQL ownership through producer drain. */
export const inject = ['storage', 'mysql']
/** Namespace, registration and lease policy are explicit deployment settings. */
export interface Config extends WorkspaceAdapterConfig {
  /** Storage backend registration name selected by the Workspace Domain route. */
  readonly backendName: string
}
export const Config: z<Config> = z.object({ storeKey: z.string().pattern(/^[\x21-\x7e]{1,128}$/u).required(),
  backendName: z.string().required(), leaseTtlMs: z.natural().min(1000).max(600000).required(),
  heartbeatIntervalMs: z.natural().min(100).max(200000).required() })
/** Register only the reviewed Workspace unit; never initialize schema, provision stores or migrate files.
 * @param ctx - Plugin owner.
 * @param config - Explicit namespace/route/lease settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let unregister = (): void => {}
  const backend = await createWorkspaceMysqlBackend(ctx, ctx.mysql, config, ctx.storage, config.backendName, () => { unregister() })
  ctx.effect(() => {
    unregister = ctx.storage.backend.register(config.backendName, backend)
    return () => backend.close()
  }, 'mysql.workspace.register')
  ctx.provide(storageBackendServiceKey(config.backendName), backend)
}
export { createWorkspaceMysqlBackend } from './adapter.ts'
export { WorkspaceAdapterError } from './model.ts'
