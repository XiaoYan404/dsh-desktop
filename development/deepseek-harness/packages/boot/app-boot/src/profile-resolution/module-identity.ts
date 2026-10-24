/** Node retains evaluated modules after profile removal; a later package version needs a distinct identity. */
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModuleLoader, ResolveResult } from '@deepseek-ai/cordis-plugin-loader'
import type { RuntimeResolution } from '../profile.ts'

interface Root {
  readonly directory: string
  readonly profile: boolean
  readonly version?: string | undefined
  readonly readVersion: boolean
}
interface History {
  readonly versions: Set<string | undefined>
  readonly esm: Map<string, string | undefined>
  readonly commonJs: Map<string, string | undefined>
}
// Match Node's module-cache lifetime, including successive profile contexts in one isolate.
const histories = new WeakMap<object, Map<string, History>>()
const require = createRequire(import.meta.url)

function canonical(directory: string): string {
  try { return realpathSync(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return resolve(directory)
  }
}

/** Private resolver companion; installation packages and unchanged profile versions retain existing identities. */
export class PackageModuleIdentity {
  private roots: readonly Root[] = []
  private versions = new Map<Root, string | undefined>()
  private readonly history: Map<string, History>

  constructor(private readonly loader: ModuleLoader, resolution: RuntimeResolution) {
    this.history = histories.get(loader) ?? new Map<string, History>()
    histories.set(loader, this.history)
    this.update(resolution)
  }

  /**
   * Prepare roots and evict only cached files whose owning profile package changed version.
   * @param resolution - Validated successor; unchanged nested dependencies remain cached.
   */
  update(resolution: RuntimeResolution): void {
    const roots = new Map<string, Root>()
    for (const entry of resolution.entries) {
      const directory = canonical(entry.packageDir)
      roots.set(directory, { directory, profile: entry.scope === 'profile', version: entry.version, readVersion: false })
    }
    if (resolution.profileDir) for (const name of resolution.localPackageNames) {
      const directory = canonical(join(resolution.profileDir, 'node_modules', name))
      if (!roots.has(directory)) roots.set(directory, { directory, profile: true, readVersion: true })
    }
    const next = [...roots.values()].sort((left, right) => right.directory.length - left.directory.length)
    const versions = new Map<Root, string | undefined>()
    for (const previous of this.roots) {
      const retained = roots.get(previous.directory)
      if (previous.profile && retained?.profile && this.versions.has(previous)
        && this.versions.get(previous) !== this.version(retained, versions)) {
        throw new Error(`profile resolution: replacing ${JSON.stringify(previous.directory)} requires a process restart`)
      }
    }
    const evictEsm: string[] = []
    for (const url of this.loader.loadCache.keys()) {
      if (!url.startsWith('file:')) continue
      const filename = fileURLToPath(url)
      const root = next.find(value => filename.startsWith(value.directory + sep))
      const history = root && this.history.get(root.directory)
      if (!root?.profile || !history) continue
      const version = this.version(root, versions)
      if (history.esm.has(url) ? history.esm.get(url) !== version : !history.versions.has(version)) evictEsm.push(url)
    }
    const evict: string[] = []
    for (const filename of Object.keys(require.cache)) {
      const root = next.find(value => filename.startsWith(value.directory + sep))
      const history = root && this.history.get(root.directory)
      if (!root?.profile || !history) continue
      const version = this.version(root, versions)
      if (history.commonJs.has(filename) ? history.commonJs.get(filename) !== version : !history.versions.has(version)) {
        evict.push(filename)
      }
    }
    this.roots = next
    this.versions = versions
    // Node 24's LoadCache.delete leaves a typed slot; remove the complete key as HMR does.
    for (const url of evictEsm) Map.prototype.delete.call(this.loader.loadCache, url)
    for (const filename of evict) Reflect.deleteProperty(require.cache, filename)
  }

  /**
   * Record an ESM file's owning version, including package-relative imports, without changing file URLs.
   * @param result - Native result after profile routing.
   * @returns The native result with its existing file URL, also used by HMR and diagnostics.
   */
  esm(result: ResolveResult): ResolveResult {
    if (!result.url.startsWith('file:')) return result
    const filename = fileURLToPath(result.url)
    const root = this.roots.find(value => filename.startsWith(value.directory + sep))
    if (!root?.profile) return result
    const { history, version } = this.observe(root)
    history.esm.set(result.url, version)
    if (result.format === 'commonjs') history.commonJs.set(filename, version)
    return result
  }

  /**
   * Remember a CommonJS file's version without changing require.resolve() output.
   * @param filename - Native CommonJS filename.
   */
  commonJs(filename: string): void {
    const root = this.roots.find(value => filename.startsWith(value.directory + sep))
    if (!root?.profile) return
    const { history, version } = this.observe(root)
    history.commonJs.set(filename, version)
  }

  private observe(root: Root): { history: History; version: string | undefined } {
    const version = this.version(root, this.versions)
    let history = this.history.get(root.directory)
    if (!history) {
      history = { versions: new Set(), esm: new Map(), commonJs: new Map() }
      this.history.set(root.directory, history)
    }
    history.versions.add(version)
    return { history, version }
  }

  private version(root: Root, versions: Map<Root, string | undefined>): string | undefined {
    if (versions.has(root)) return versions.get(root)
    let version = root.version
    if (root.readVersion) {
      const value: unknown = JSON.parse(readFileSync(join(root.directory, 'package.json'), 'utf8'))
      const declared: unknown = value && typeof value === 'object' ? Reflect.get(value, 'version') : undefined
      version = typeof declared === 'string' ? declared : undefined
    }
    versions.set(root, version)
    return version
  }
}
