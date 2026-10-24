/** Offline, checksummed backups and non-destructive restores of explicitly selected deployment roots. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

interface Root { id: string; path: string }
interface Entry { root: string; path: string; kind: 'directory' | 'file'; bytes: number; sha256: string; mode: number }
interface Manifest {
  format: 'dsh-enterprise-backup'
  version: 1
  createdAt: string
  provider: 'local' | 'mysql-frozen-export'
  roots: string[]
  entries: Entry[]
}
interface VerifiedManifest { manifest: Manifest; manifestSha256: string }

/** An operational failure code safe to display without paths, file contents or credentials. */
export class BackupError extends Error {
  /** @param code - Stable non-sensitive failure identifier. */
  constructor(readonly code: string) { super(`enterprise-backup: ${code}`); this.name = 'BackupError' }
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const idPattern = /^[a-z][a-z0-9-]{0,63}$/u
const hashPattern = /^[a-f0-9]{64}$/u
const inside = (parent: string, child: string): boolean => {
  const part = relative(parent, child)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
function safePath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes('\\') && !value.includes(':')
    && !value.includes('\0') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const bytes: AsyncIterable<Uint8Array> = createReadStream(path)
  for await (const chunk of bytes) hash.update(chunk)
  return hash.digest('hex')
}
async function walk(root: Root, directory = root.path, prefix = ''): Promise<Entry[]> {
  const entries: Entry[] = []
  const rootInfo = await lstat(directory)
  if (prefix === '' && rootInfo.isFile()) {
    const path = basename(directory)
    if (!safePath(path)) throw new BackupError('unsupported-file-name')
    return [{ root: root.id, path, kind: 'file', bytes: rootInfo.size, sha256: await hashFile(directory), mode: rootInfo.mode & 0o777 }]
  }
  if (!rootInfo.isDirectory()) throw new BackupError('link-or-special-file')
  const names = await readdir(directory)
  names.sort()
  for (const name of names) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (!safePath(path)) throw new BackupError('unsupported-file-name')
    const absolute = join(directory, name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new BackupError('link-or-special-file')
    entries.push({ root: root.id, path, kind: info.isDirectory() ? 'directory' : 'file',
      bytes: info.isFile() ? info.size : 0, sha256: info.isFile() ? await hashFile(absolute) : '', mode: info.mode & 0o777 })
    if (info.isDirectory()) entries.push(...await walk(root, absolute, path))
  }
  return entries
}
async function destination(path: string, sources: readonly Root[]): Promise<string> {
  const absolute = resolve(path)
  const canonical = join(await realpath(dirname(absolute)), basename(absolute))
  if (sources.some(root => inside(root.path, canonical) || inside(canonical, root.path))) throw new BackupError('overlapping-destination')
  try { await lstat(canonical) }
  catch (error) {
    if (object(error) && error.code === 'ENOENT') return canonical
    throw error
  }
  throw new BackupError('destination-exists')
}
async function rootsOf(roots: readonly Root[]): Promise<Root[]> {
  if (roots.length === 0 || new Set(roots.map(root => root.id)).size !== roots.length) throw new BackupError('invalid-roots')
  const result: Root[] = []
  for (const root of roots) {
    const info = await lstat(root.path)
    if (!idPattern.test(root.id) || (!info.isDirectory() && !info.isFile()) || (root.id === 'home' && !info.isDirectory())) {
      throw new BackupError('invalid-root')
    }
    result.push({ id: root.id, path: await realpath(root.path) })
  }
  if (result.some((root, index) => result.some((other, second) => second !== index && inside(root.path, other.path)))) {
    throw new BackupError('overlapping-roots')
  }
  return result
}
async function copyEntries(entries: readonly Entry[], source: (id: string) => string, target: string): Promise<void> {
  for (const entry of entries) {
    const path = join(target, entry.root, entry.path)
    if (entry.kind === 'directory') await mkdir(path, { mode: 0o700 })
    else {
      await copyFile(join(source(entry.root), entry.path), path, 1)
      await chmod(path, 0o600)
      if (await hashFile(path) !== entry.sha256) throw new BackupError('copy-hash-mismatch')
    }
  }
}
function parseManifest(value: unknown): Manifest {
  if (!object(value) || value.format !== 'dsh-enterprise-backup' || value.version !== 1) throw new BackupError('unsupported-format')
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || (value.provider !== 'local' && value.provider !== 'mysql-frozen-export')
    || !Array.isArray(value.roots) || value.roots.length === 0
    || !value.roots.every((root): root is string => typeof root === 'string' && idPattern.test(root))
    || new Set(value.roots).size !== value.roots.length
    || !Array.isArray(value.entries) || value.entries.length > 1_000_000) throw new BackupError('invalid-manifest')
  const roots = value.roots
  const entries: Entry[] = []
  for (const row of value.entries) {
    if (!object(row) || typeof row.root !== 'string' || !roots.includes(row.root) || !safePath(row.path)
      || (row.kind !== 'directory' && row.kind !== 'file') || typeof row.bytes !== 'number'
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || typeof row.sha256 !== 'string'
      || (row.kind === 'file' ? !hashPattern.test(row.sha256) : row.sha256 !== '' || row.bytes !== 0)
      || typeof row.mode !== 'number' || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777) {
      throw new BackupError('invalid-entry')
    }
    entries.push({ root: row.root, path: row.path, kind: row.kind, bytes: row.bytes, sha256: row.sha256, mode: row.mode })
  }
  if (new Set(entries.map(entry => `${entry.root}/${entry.path}`)).size !== entries.length) throw new BackupError('duplicate-entry')
  if (value.provider === 'mysql-frozen-export' && !roots.includes('mysql-export')) throw new BackupError('missing-provider-export')
  return { format: value.format, version: value.version, createdAt: value.createdAt, provider: value.provider, roots, entries }
}
function comparable(entries: readonly Entry[]): string {
  return JSON.stringify(entries.map(({ root, path, kind, bytes, sha256 }) => ({ root, path, kind, bytes, sha256 })))
}

/**
 * Snapshot stopped deployment roots. A MySQL deployment additionally requires a separately frozen logical export.
 * Writers must remain stopped until this resolves; stable hashes detect changes but cannot establish transactional quiescence.
 * @param options - Explicit roots, provider and fresh destination, with the operator's quiescence acknowledgement.
 * @returns Non-sensitive totals after source and copied bytes both match the final manifest.
 */
export async function createBackup(options: {
  roots: readonly Root[]
  output: string
  quiescent: boolean
  provider: Manifest['provider']
}): Promise<{ roots: number; files: number; bytes: number; manifestSha256: string }> {
  if (!options.quiescent) throw new BackupError('writers-must-be-stopped')
  const roots = await rootsOf(options.roots)
  if (options.provider === 'mysql-frozen-export' && !roots.some(root => root.id === 'mysql-export')) throw new BackupError('missing-provider-export')
  const output = await destination(options.output, roots)
  const entries = (await Promise.all(roots.map(root => walk(root)))).flat()
  const stage = output
  await mkdir(stage, { mode: 0o700 })
  const payload = join(stage, 'roots')
  await mkdir(payload, { mode: 0o700 })
  for (const root of roots) await mkdir(join(payload, root.id), { mode: 0o700 })
  const sources = new Map<string, string>()
  for (const root of roots) sources.set(root.id, (await lstat(root.path)).isFile() ? dirname(root.path) : root.path)
  await copyEntries(entries, (id) => {
    const source = sources.get(id)
    if (source === undefined) throw new BackupError('missing-root')
    return source
  }, payload)
  const after = (await Promise.all(roots.map(root => walk(root)))).flat()
  if (comparable(entries) !== comparable(after)) throw new BackupError('source-changed')
  const manifest: Manifest = { format: 'dsh-enterprise-backup', version: 1, createdAt: new Date().toISOString(),
    provider: options.provider, roots: roots.map(root => root.id), entries }
  const contents = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(stage, 'manifest.json'), contents, { flag: 'wx', mode: 0o600 })
  await writeFile(join(stage, 'COMPLETE'), `${digest(contents)}\n`, { flag: 'wx', mode: 0o600 })
  const result = await verifyBackup(stage)
  return result
}

async function verifiedManifest(path: string): Promise<VerifiedManifest> {
  if (!(await lstat(path)).isDirectory()) throw new BackupError('invalid-backup-root')
  const info = await lstat(join(path, 'manifest.json'))
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new BackupError('invalid-manifest-file')
  const contents = await readFile(join(path, 'manifest.json'), 'utf8')
  const marker = await lstat(join(path, 'COMPLETE'))
  if (!marker.isFile() || marker.size > 128) throw new BackupError('invalid-completion-marker')
  if ((await readFile(join(path, 'COMPLETE'), 'utf8')).trim() !== digest(contents)) throw new BackupError('manifest-hash-mismatch')
  const value: unknown = JSON.parse(contents)
  const manifest = parseManifest(value)
  const rootInfo = await lstat(join(path, 'roots'))
  if (!rootInfo.isDirectory()) throw new BackupError('invalid-payload')
  const rootNames = (await readdir(join(path, 'roots'))).sort()
  if (JSON.stringify(rootNames) !== JSON.stringify([...manifest.roots].sort())) throw new BackupError('payload-roots-mismatch')
  const actual: Entry[] = []
  for (const id of manifest.roots) {
    const root = join(path, 'roots', id)
    if (!(await lstat(root)).isDirectory()) throw new BackupError('link-or-special-file')
    actual.push(...await walk({ id, path: root }))
  }
  if (comparable(actual) !== comparable(manifest.entries)) throw new BackupError('payload-mismatch')
  return { manifest, manifestSha256: digest(contents) }
}

/** @param path - Backup directory. @returns Verified totals without paths or application content. */
export async function verifyBackup(path: string): Promise<{ roots: number; files: number; bytes: number; manifestSha256: string }> {
  const { manifest, manifestSha256 } = await verifiedManifest(path)
  return { roots: manifest.roots.length, files: manifest.entries.filter(entry => entry.kind === 'file').length,
    bytes: manifest.entries.reduce((total, entry) => total + entry.bytes, 0),
    manifestSha256 }
}

/**
 * Restore verified bytes to a fresh directory; this never changes source data or selects an active provider.
 * MySQL logical exports still require the owning import, comparison and explicit provider-selection procedure.
 * @param backup - Complete backup directory.
 * @param output - New parent containing one directory per named root.
 * @returns Verified totals; application reopening and permission checks remain required before cutover.
 */
export async function restoreBackup(backup: string, output: string): Promise<{ roots: number; files: number; bytes: number }> {
  const { manifest, manifestSha256 } = await verifiedManifest(backup)
  const target = await destination(output, [{ id: 'backup', path: await realpath(backup) }])
  await mkdir(target, { mode: 0o700 })
  for (const id of manifest.roots) await mkdir(join(target, id), { mode: 0o700 })
  await copyEntries(manifest.entries, id => join(backup, 'roots', id), target)
  const actual = (await Promise.all(manifest.roots.map(id => walk({ id, path: join(target, id) })))).flat()
  if (comparable(actual) !== comparable(manifest.entries)) throw new BackupError('restore-mismatch')
  for (const entry of manifest.entries) await chmod(join(target, entry.root, entry.path), entry.mode)
  await writeFile(join(target, 'RESTORED.json'), `${JSON.stringify({ version: 1, restoredAt: new Date().toISOString(),
    manifestSha256, provider: manifest.provider })}\n`, { flag: 'wx', mode: 0o600 })
  return { roots: manifest.roots.length, files: manifest.entries.filter(entry => entry.kind === 'file').length,
    bytes: manifest.entries.reduce((total, entry) => total + entry.bytes, 0) }
}

/** @param path - Deployment data root. @returns Counts and available capacity, without filenames, logs or secrets. */
export async function backupDiagnostics(path: string): Promise<{ files: number; bytes: number; availableBytes: number }> {
  const root = (await rootsOf([{ id: 'home', path }]))[0]
  if (root === undefined) throw new BackupError('invalid-root')
  const entries = await walk(root)
  const volume = await statfs(root.path)
  return { files: entries.filter(entry => entry.kind === 'file').length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0), availableBytes: volume.bavail * volume.bsize }
}

/** @param argv - Command arguments. @returns Exit status; output contains only verified totals or a safe failure code. */
export async function runBackup(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      home: { type: 'string' }, output: { type: 'string' }, backup: { type: 'string' },
      provider: { type: 'string' }, 'mysql-export': { type: 'string' }, root: { type: 'string', multiple: true },
      quiescent: { type: 'boolean', default: false },
    } })
    if (positionals.length !== 1) throw new BackupError('expected-backup-verify-restore-or-diagnostics')
    let result: object
    if (positionals[0] === 'verify' && values.backup) result = await verifyBackup(values.backup)
    else if (positionals[0] === 'restore' && values.backup && values.output) result = await restoreBackup(values.backup, values.output)
    else if (positionals[0] === 'diagnostics' && values.home) result = await backupDiagnostics(values.home)
    else if (positionals[0] === 'backup' && values.home && values.output
      && (values.provider === 'local' || values.provider === 'mysql-frozen-export')) {
      const roots: Root[] = [{ id: 'home', path: values.home }]
      if (values['mysql-export']) roots.push({ id: 'mysql-export', path: values['mysql-export'] })
      for (const item of values.root ?? []) {
        const split = item.indexOf('=')
        if (split < 1) throw new BackupError('root-needs-id-equals-path')
        roots.push({ id: item.slice(0, split), path: item.slice(split + 1) })
      }
      result = await createBackup({ roots, output: values.output, quiescent: values.quiescent, provider: values.provider })
    } else throw new BackupError('missing-or-invalid-arguments')
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error instanceof BackupError ? error.code : 'io-or-invalid-input' })}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runBackup(process.argv.slice(2))
}
