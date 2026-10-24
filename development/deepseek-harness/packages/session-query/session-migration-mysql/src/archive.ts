/** Durable immutable archive publication; original files are copied byte for byte and never moved. */
import { lstat, mkdir, open, readFile, realpath, link, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MigrationError } from './error.ts'
import { sha256, validateLogical } from './logical.ts'
import { readOpenArchiveFile } from './archive-read.ts'
import type { ArchiveFile, ArchiveManifest, LogicalStore, MigrationLimits, MigrationSource, VerifiedArchive } from './types.ts'

/**
 * @param root - Canonical parent.
 * @param child - Resolved candidate.
 * @returns Whether child is strictly within root.
 */
function within(root: string, child: string): boolean {
  const path = relative(root, child)
  return path.length > 0 && !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}

/**
 * @param value - Source-relative inventory path.
 * @returns The same normalized safe path.
 */
function archivePath(value: string): string {
  if (!value || value.includes('\\') || value.includes(':') || value.includes('\0') || !value.isWellFormed()
    || isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new MigrationError('INVALID_ARCHIVE')
  return value
}

async function safePath(root: string, path: string, createParents: boolean): Promise<string> {
  const pieces = archivePath(path).split('/')
  let parent = root
  for (const part of pieces.slice(0, -1)) {
    parent = join(parent, part)
    if (createParents) {
      try { await mkdir(parent, { mode: 0o700 }) }
      catch (error) { if (!isCode(error, 'EEXIST')) throw error }
    }
    const info = await lstat(parent)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new MigrationError('INVALID_ARCHIVE')
  }
  const result = resolve(root, ...pieces)
  if (!within(root, result)) throw new MigrationError('INVALID_ARCHIVE')
  try {
    const info = await lstat(result)
    if (!info.isFile() || info.isSymbolicLink()) throw new MigrationError('INVALID_ARCHIVE')
  } catch (error) { if (!isCode(error, 'ENOENT')) throw error }
  return result
}

/**
 * Write once and fsync; a resumed file is reused only if its complete bytes match.
 * @param root - Canonical owned archive directory.
 * @param path - Validated relative path.
 * @param bytes - Complete immutable content.
 */
async function retain(root: string, path: string, bytes: Uint8Array | string): Promise<void> {
  const destination = await safePath(root, path, true)
  try {
    if (sha256(await readFile(destination)) !== sha256(bytes)) throw new MigrationError('SOURCE_CHANGED')
    return
  }
  catch (error) {
    if (!isCode(error, 'ENOENT')) throw error
  }
  const temporary = destination + '.' + randomUUID() + '.partial'
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(bytes); await file.sync() }
  finally { await file.close() }
  try { await link(temporary, destination) }
  catch (error) {
    if (!isCode(error, 'EEXIST')) throw error
    if (sha256(await readFile(destination)) !== sha256(bytes)) throw new MigrationError('SOURCE_CHANGED')
  }
  await unlink(temporary)
}

/**
 * Capture an explicitly selected source under the provider's exclusive maintenance fence.
 * @param source - Real provider freeze capability; missing capability fails before any source read.
 * @param parent - Existing explicit archive parent outside the source tree.
 * @param archiveId - Stable operation id, reused after interruption.
 * @param limits - Complete-value capacity bounds.
 * @param signal - Cancellation; partial files remain resumable and unpublished.
 * @returns A checksum-verified archive published by its final manifest.
 */
export async function captureArchive(source: MigrationSource | undefined, parent: string, archiveId: string,
  limits: MigrationLimits, signal?: AbortSignal): Promise<VerifiedArchive> {
  signal?.throwIfAborted()
  if (!source) throw new MigrationError('FREEZE_UNAVAILABLE')
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(archiveId)) throw new MigrationError('INVALID_ARCHIVE')
  await using lease = await source.freeze(signal)
  await lease.assertCurrent(signal)
  const sourceRoot = await realpath(lease.sourceRoot), parentRoot = await realpath(parent)
  const directory = join(parentRoot, archiveId)
  if (sourceRoot === parentRoot || within(sourceRoot, directory) || within(directory, sourceRoot)) throw new MigrationError('INVALID_ARCHIVE')
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) { if (!isCode(error, 'EEXIST')) throw error }
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MigrationError('INVALID_ARCHIVE')
  const identityText = JSON.stringify({ archiveId, sourceRoot })
  await retain(directory, 'identity.json', identityText)
  const frozen = await lease.read(signal)
  const files: ArchiveFile[] = [], paths = new Set<string>()
  let total = 0
  for (const sourceFile of frozen.files) {
    signal?.throwIfAborted()
    const path = archivePath(sourceFile.path)
    if (paths.has(path)) throw new MigrationError('INVALID_ARCHIVE')
    paths.add(path)
    total += sourceFile.bytes.byteLength
    if (sourceFile.bytes.byteLength > limits.maxFileBytes || total > limits.maxArchiveBytes) throw new MigrationError('CAPACITY')
    await retain(directory, 'raw/' + path, sourceFile.bytes)
    files.push({ path, kind: sourceFile.kind, bytes: sourceFile.bytes.byteLength, sha256: sha256(sourceFile.bytes) })
  }
  validateLogical(frozen.logical, limits)
  for (const session of frozen.logical.sessions) for (const generation of session.generations) {
    if (generation.sourceFiles.some(path => !paths.has(path))) throw new MigrationError('INVALID_ARCHIVE')
  }
  const logicalText = JSON.stringify(frozen.logical)
  total += Buffer.byteLength(logicalText)
  if (total > limits.maxArchiveBytes) throw new MigrationError('CAPACITY')
  await retain(directory, 'logical.json', logicalText)
  await lease.assertCurrent(signal)
  const again = await lease.read(signal)
  if (sha256(JSON.stringify(again.logical)) !== sha256(logicalText) || again.files.length !== files.length
    || again.files.some((file) => {
      const expected = files.find(entry => entry.path === file.path)
      return !expected || expected.kind !== file.kind || expected.sha256 !== sha256(file.bytes) || expected.bytes !== file.bytes.byteLength
    })) throw new MigrationError('SOURCE_CHANGED')
  const manifest: ArchiveManifest = { kind: 'dsh-frozen-store', version: 1, archiveId, freezeIdentity: lease.identity,
    logicalSha256: sha256(logicalText), identitySha256: sha256(identityText), files }
  const manifestText = JSON.stringify(manifest)
  if (Buffer.byteLength(manifestText) > limits.maxFileBytes
    || total + Buffer.byteLength(identityText) + Buffer.byteLength(manifestText) > limits.maxArchiveBytes) throw new MigrationError('CAPACITY')
  try {
    const existing = await readArchive(directory, limits, signal)
    if (existing.manifest.logicalSha256 !== manifest.logicalSha256
      || JSON.stringify(existing.manifest.files) !== JSON.stringify(files)) throw new MigrationError('SOURCE_CHANGED')
    await lease.assertCurrent(signal)
    return existing
  } catch (error) { if (!isCode(error, 'ENOENT')) throw error }
  await lease.assertCurrent(signal)
  await retain(directory, 'manifest.json', manifestText)
  const result = await readArchive(directory, limits, signal)
  await lease.assertCurrent(signal)
  return result
}

/**
 * Verify every archived byte and the complete native logical export before target writes.
 * @param directory - Explicit immutable archive directory.
 * @param limits - Capacity limits for untrusted archive input.
 * @param signal - Cancels before opening input and between reads; original archive bytes remain intact.
 * @returns Detached validated inventory and logical data.
 */
export async function readArchive(directory: string, limits: MigrationLimits, signal?: AbortSignal): Promise<VerifiedArchive> {
  signal?.throwIfAborted()
  const rootInfo = await lstat(directory)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new MigrationError('INVALID_ARCHIVE')
  const root = await realpath(directory)
  const manifestBytes = await boundedRead(root, 'manifest.json', Math.min(limits.maxFileBytes, limits.maxArchiveBytes), signal)
  const raw = jsonObject(manifestBytes)
  if (raw['kind'] !== 'dsh-frozen-store' || raw['version'] !== 1) throw new MigrationError('FUTURE_FORMAT')
  if (typeof raw['archiveId'] !== 'string' || typeof raw['freezeIdentity'] !== 'string' || !raw['freezeIdentity']
    || typeof raw['logicalSha256'] !== 'string' || typeof raw['identitySha256'] !== 'string'
    || !/^[0-9a-f]{64}$/u.test(raw['identitySha256']) || !Array.isArray(raw['files'])) throw new MigrationError('INVALID_ARCHIVE')
  const identity = await boundedRead(root, 'identity.json', Math.min(limits.maxFileBytes, limits.maxArchiveBytes - manifestBytes.byteLength), signal)
  if (sha256(identity) !== raw['identitySha256']) throw new MigrationError('SOURCE_CHANGED')
  const files: ArchiveFile[] = [], paths = new Set<string>()
  let total = manifestBytes.byteLength + identity.byteLength
  const fileCandidates: readonly unknown[] = raw['files']
  for (const candidate of fileCandidates) {
    signal?.throwIfAborted()
    if (!candidate || typeof candidate !== 'object' || !('path' in candidate) || typeof candidate.path !== 'string'
      || !('kind' in candidate) || !['session_log', 'workspace', 'projection', 'receipt'].includes(String(candidate.kind))
      || !('bytes' in candidate) || typeof candidate.bytes !== 'number' || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0
      || !('sha256' in candidate) || typeof candidate.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.sha256)) {
      throw new MigrationError('INVALID_ARCHIVE')
    }
    const entry: ArchiveFile = { path: archivePath(candidate.path), kind: candidate.kind as ArchiveFile['kind'],
      bytes: candidate.bytes, sha256: candidate.sha256 }
    if (paths.has(entry.path)) throw new MigrationError('INVALID_ARCHIVE')
    paths.add(entry.path)
    const bytes = await boundedRead(root, 'raw/' + entry.path, Math.min(limits.maxFileBytes, limits.maxArchiveBytes - total), signal)
    total += bytes.byteLength
    if (total > limits.maxArchiveBytes) throw new MigrationError('CAPACITY')
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) throw new MigrationError('SOURCE_CHANGED')
    files.push(entry)
  }
  const logicalBytes = await boundedRead(root, 'logical.json', limits.maxArchiveBytes - total, signal)
  if (sha256(logicalBytes) !== raw['logicalSha256']) throw new MigrationError('SOURCE_CHANGED')
  let logical: LogicalStore
  try {
    const parsed: unknown = jsonObject(logicalBytes)
    validateLogical(parsed, limits)
    logical = parsed
  } catch (error) {
    if (error instanceof MigrationError) throw error
    throw new MigrationError('INVALID_ARCHIVE', { cause: error })
  }
  for (const session of logical.sessions) for (const generation of session.generations) {
    if (generation.sourceFiles.some(path => !paths.has(path))) throw new MigrationError('INVALID_ARCHIVE')
  }
  const manifest: ArchiveManifest = { kind: 'dsh-frozen-store', version: 1, archiveId: raw['archiveId'],
    freezeIdentity: raw['freezeIdentity'], logicalSha256: raw['logicalSha256'], identitySha256: raw['identitySha256'], files }
  return { directory: root, manifest, manifestSha256: sha256(manifestBytes), logical }
}

/**
 * Retain an operation receipt beside its archive; existing different receipts are never overwritten.
 * @param directory - Owned archive directory.
 * @param id - Stable operation id.
 * @param receipt - Non-secret operator receipt.
 */
export async function retainReceipt(directory: string, id: string, receipt: object): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new MigrationError('INVALID_ARCHIVE')
  await retain(await realpath(directory), 'receipts/' + id + '.json', JSON.stringify(receipt))
}

async function boundedRead(root: string, path: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  const target = await safePath(root, path, false)
  const file = await open(target, 'r')
  try { return await readOpenArchiveFile(file, maximum, signal) }
  finally { await file.close() }
}
function jsonObject(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) }
  catch (_error) { throw new MigrationError('INVALID_ARCHIVE') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MigrationError('INVALID_ARCHIVE')
  return value as Record<string, unknown>
}
function isCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code }
