/** Short Win32 access paths retain Electron's existing account preference directory. */
import { lstat, mkdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Create or verify an account alias; the full account digest still names the original data.
 * @param sessionData - Electron's absolute browser-data directory.
 * @param digest - SHA-256 of the Platform origin and stable account ID.
 * @returns a short junction path addressing the original persistent partition.
 */
export async function platformStoragePath(sessionData: string, digest: string): Promise<string> {
  const directory = join(sessionData, 'Partitions', 'dsh-platform-' + digest)
  const alias = join(sessionData, 'pa-' + digest.slice(0, 32))
  await mkdir(directory, { recursive: true })
  try { await symlink(directory, alias, 'junction') }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  }
  // Reject an occupied path or digest-prefix collision before opening another account's storage.
  if (!(await lstat(alias)).isSymbolicLink() || await realpath(alias) !== await realpath(directory)) {
    throw new Error('Platform storage alias does not address the expected account directory: ' + alias)
  }
  return alias
}
