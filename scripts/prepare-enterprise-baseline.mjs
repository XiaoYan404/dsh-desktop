import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const [projectInput, outputInput] = process.argv.slice(2)
if (!projectInput || !outputInput) throw new Error('Project and backup directories are required')
const project = resolve(projectInput)
const output = resolve(outputInput)
await mkdir(output, { recursive: true })
const recordPath = join(output, 'artifact-backup.json')
async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
let current
try { current = JSON.parse(await readFile(recordPath, 'utf8')) }
catch (error) { if (error?.code !== 'ENOENT') throw error }
if (current !== undefined) {
  if (!current.complete || current.archive !== 'artifacts-before-watch.tar'
    || await digest(join(output, current.archive)) !== current.sha256) throw new Error('Existing baseline backup is not intact')
  console.log(JSON.stringify({ complete: true, reused: true }))
  process.exit(0)
}
const roots = []
async function find(path) {
  for (const entry of await readdir(join(project, path), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || ['node_modules', '.git', '.artifacts', 'tmp'].includes(entry.name)) continue
    const next = path ? `${path}/${entry.name}` : entry.name
    if (['lib', 'dist', '.dsh-build'].includes(entry.name)) roots.push(next)
    else await find(next)
  }
}
await find('')
if (!roots.includes('apps/cli/lib')) throw new Error('No built CLI is available for the development baseline')
const list = join(output, 'artifact-roots.txt')
const archive = join(output, 'artifacts-before-watch.tar')
await writeFile(list, roots.sort().join('\n') + '\n')
await new Promise((accept, reject) => {
  const child = spawn('tar.exe', ['-cf', archive, '-C', project, '-T', list], { windowsHide: true, stdio: 'ignore' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? accept() : reject(new Error(`Artifact backup exited with code ${code}`)))
})
const metadata = { complete: true, archive: 'artifacts-before-watch.tar', sha256: await digest(archive),
  bytes: (await stat(archive)).size, directories: roots.length,
  completeReleaseBuild: false, purpose: 'Actual installed-development artifact backup before starting source watchers' }
await writeFile(recordPath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ complete: true, reused: false, bytes: metadata.bytes, directories: roots.length }))
