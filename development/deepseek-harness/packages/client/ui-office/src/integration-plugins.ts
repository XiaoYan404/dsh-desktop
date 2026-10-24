/** Deployment package references and a read-only projection of the existing profile manager. */
import { z } from 'zod'
import type { BundleInfo, PluginInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import type { OfficeIntegrationPlugin } from './types.ts'

const adapterId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const packageName = z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/)
const declarations = z.record(adapterId, packageName).refine(value => Object.keys(value).length <= 100)

/**
 * Validate deployment-only npm package roots; references never grant permission to install or execute them.
 * @param value - Adapter ids mapped to package roots in this employee Host's configuration.
 * @returns Detached validated declarations, with no install spec, URL or filesystem path.
 */
export function integrationPluginDeclarations(value: Record<string, string>): Readonly<Record<string, string>> {
  return declarations.parse(value)
}

/**
 * Project package selection independently from the Loader's actual row phases.
 * @param packages - Validated deployment relationships.
 * @param bundles - Real manager observations, or null when profile management is unavailable.
 * @param plugins - Real Loader observations from the same manager read.
 * @returns Safe package metadata without local paths, package diagnostics or customer credentials.
 */
export function integrationPluginRows(packages: Readonly<Record<string, string>>, bundles: readonly BundleInfo[] | null,
  plugins: readonly PluginInfo[]): readonly OfficeIntegrationPlugin[] {
  return Object.entries(packages).map(([adapterId, packageName]) => {
    const bundle = bundles?.find(entry => entry.name === packageName)
    const rows = bundle?.rows ?? []
    const phases = rows.map(row => row.entryId ? plugins.find(entry => entry.entryId === row.entryId)?.fiberPhase : null)
    return { adapterId, packageName, bundle: bundles ? {
      installed: bundle?.installed ?? false, availability: bundle?.availability ?? 'missing', enabled: bundle?.enabled ?? false,
      version: bundle?.version ?? null, problem: Boolean(bundle?.error), totalRows: rows.length,
      activeRows: phases.filter(phase => phase === 'active').length,
      pendingRows: phases.filter(phase => phase === 'pending' || phase === 'loading' || phase === 'unloading').length,
      failedRows: phases.filter(phase => phase === 'failed').length,
    } : null }
  })
}
