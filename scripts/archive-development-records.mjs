import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises'
import { join, resolve, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(repository, '..')
const status = JSON.parse(await readFile(join(repository, 'project-docs', 'consolidation-status.json'), 'utf8'))
const output = resolve(repository, status.privateArchive)
const owner = relative(join(repository, 'local-only'), output)
if (owner.startsWith('..') || isAbsolute(owner)) throw new Error('Private archive directory escaped its owner')
const receipt = join(output, 'archives.json')
try {
  const saved = JSON.parse(await readFile(receipt, 'utf8'))
  if (saved.runtimeFileCopyComplete) {
    console.log(JSON.stringify({ alreadySaved: true, archiveAttempts: saved.archiveAttempts }))
    process.exit(0)
  }
} catch (error) { if (error.code !== 'ENOENT') throw error }

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

// Keep all three tar outcomes. Preserve the selected scripts as individual
// verified files without retrying, overwriting or relabeling a failed archive.
const archives = []
for (const [name, complete] of [
  ['harness-artifacts.tar', true],
  ['runtime-tools-and-logs.r1.incomplete.tar', false],
  ['runtime-scripts-and-records-r2.tar', false],
]) {
  const path = join(output, name)
  archives.push({ name, complete, bytes: (await stat(path)).size, sha256: await sha256(path) })
}
const paths = (await readFile(join(output, 'runtime-scripts.files0'), 'utf8')).split('\0').filter(Boolean)
const records = []
let cursor = 0
await Promise.all(Array.from({ length: 12 }, async () => {
  while (cursor < paths.length) {
    const path = paths[cursor++]
    const source = resolve(workspace, path)
    const owned = relative(join(workspace, '.local-run'), source)
    if (owned.startsWith('..') || isAbsolute(owned)) throw new Error('Runtime record escaped its source')
    const destination = join(output, 'runtime-records', owned)
    const before = await sha256(source)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    const after = await sha256(destination)
    if (before !== after) throw new Error('A live runtime record changed during its copy; the original remains available')
    records.push({ path: owned.replaceAll('\\', '/'), bytes: (await stat(destination)).size, sha256: after })
  }
}))
records.sort((a, b) => a.path.localeCompare(b.path))
await writeFile(join(output, 'runtime-records-manifest.json'), JSON.stringify({ records }, null, 2) + '\n')
await writeFile(receipt, JSON.stringify({ archives, archiveAttempts: 3,
  failures: [
    { round: 1, reason: 'Broad runtime archive stalled; only the owned archiver was stopped.' },
    { round: 2, reason: 'Overwrite guard refused the nonempty interrupted archive.' },
    { round: 3, reason: 'Selected-file tar exited with code 1; partial archive retained.' },
  ],
  runtimeFileCopyComplete: true, runtimeFiles: records.length,
  runtimeBytes: records.reduce((sum, record) => sum + record.bytes, 0),
  originalDirectoriesRetained: true, activeUserDataMoved: false, databaseBackup: false,
  exclusions: ['Active browser and database stores', 'Dependency stores and downloaded tool binaries'],
}, null, 2) + '\n')
console.log(JSON.stringify({ runtimeFilesSaved: records.length, archiveAttempts: 3, originalDirectoriesRetained: true }))
