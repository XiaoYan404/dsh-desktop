/** Real archive files with a local maintenance protocol fixture; this is not a cross-Host or database freeze. */
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { LogicalStore, MigrationLimits, MigrationSource } from '../../src/types.ts'

export const archiveLimits: MigrationLimits = { maxArchiveBytes: 100000, maxFileBytes: 20000, maxSessionBytes: 20000, batchEvents: 2 }

/**
 * Own one exact temporary root and its original raw workspace bytes.
 * @returns Source fixture and disposal which refuses paths outside the original temporary parent.
 */
export async function frozenArchiveFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh06-frozen-gui-'))
  const sourceRoot = join(root, 'source'), parent = join(root, 'archives')
  await mkdir(sourceRoot); await mkdir(parent)
  const logical: LogicalStore = { version: 1, sessions: [], workspace: { version: 2,
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, records: [] } }
  await writeFile(join(sourceRoot, 'workspace.json'), JSON.stringify(logical.workspace))
  let held = false
  const source: MigrationSource = { freeze: async () => {
    if (held) throw new Error('Fixture maintenance ownership is already held')
    held = true
    return { sourceRoot, identity: 'local-fixture-cut',
      assertCurrent: () => {
        if (!held) throw new Error('Fixture maintenance ownership was released')
        return Promise.resolve()
      },
      read: async () => ({ logical: structuredClone(logical), files: [{ path: 'workspace.json', kind: 'workspace',
        bytes: await readFile(join(sourceRoot, 'workspace.json')) }] }),
      [Symbol.asyncDispose]: () => { held = false; return Promise.resolve() } }
  } }
  return { source, sourceRoot, parent, logical, get held() { return held },
    async [Symbol.asyncDispose]() {
      const actual = await realpath(root)
      if (held || dirname(actual).toLowerCase() !== (await realpath(tmpdir())).toLowerCase()
        || !basename(actual).startsWith('dsh06-frozen-gui-')) throw new Error('Unexpected fixture cleanup state or path')
      await rm(actual, { recursive: true, force: true })
    } }
}
