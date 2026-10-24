import { createHash } from 'node:crypto'
import { mkdir, readdir, lstat, stat, readlink, readFile, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const original = join(repository, '..', 'deepseek-harness')
const destination = join(repository, 'development', 'deepseek-harness')
const links = []
const files = []
let bytes = 0
let completed = 0
const tasks = []
const excludedRoots = new Set(['.git', '.artifacts', '.idea', 'tmp', '.local-run', '.desktop-build', '.pnpm-store'])
const sha = content => createHash('sha256').update(content).digest('hex')

function owned(root, path) {
  const result = relative(root, resolve(path))
  if (result.startsWith('..') || isAbsolute(result)) throw new Error('Runtime path escaped its owner')
  return result.replaceAll('\\', '/')
}

async function walk(source, target, root = false) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (root && excludedRoots.has(entry.name)) continue
    if (entry.name.startsWith('.env') && entry.name !== '.env.example') continue
    if (['.cache', '.vite', '.vite-temp'].includes(entry.name)) continue
    if (entry.name === 'development-session.json') continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isSymbolicLink()) {
      const raw = await readlink(from)
      const resolved = resolve(dirname(from), raw.replace(/^\\\\\?\\/, ''))
      const mapped = owned(original, resolved)
      const info = await stat(from)
      if (info.isDirectory()) links.push({ path: owned(destination, to), target: mapped })
      else tasks.push(async () => { await copyFile(resolved, to); completed++ })
    } else if (entry.isDirectory()) await walk(from, to)
    else tasks.push(async () => {
      let previous
      try { previous = await lstat(to) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      if (previous === undefined) await copyFile(from, to)
      else if (!previous.isFile()) throw new Error('Unexpected existing runtime entry')
      const info = await stat(from)
      bytes += info.size
      completed++
      files.push(owned(destination, to))
      if (completed % 15000 === 0) console.log(JSON.stringify({ stage: 'runtime-copy', completed, bytes }))
    })
  }
}

await walk(original, destination, true)
console.log(JSON.stringify({ stage: 'runtime-copy-start', physicalFiles: tasks.length, directoryLinks: links.length }))
let cursor = 0
await Promise.all(Array.from({ length: 12 }, async () => {
  while (cursor < tasks.length) await tasks[cursor++]()
}))
const nodeSource = join(repository, '..', '.local-run', 'node-v24.22.0-win-x64')
const nodeTarget = join(repository, 'development', '.local-run', 'node-v24.22.0-win-x64')
async function copyNode(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) await copyNode(from, to)
    else await copyFile(from, to)
  }
}
await copyNode(nodeSource, nodeTarget)
const manifest = { format: 1, root: 'deepseek-harness', links,
  copiedFiles: completed, copiedBytes: bytes, copiedPaths: files,
  nodeVersion: '24.22.0', nodeSha256: sha(await readFile(join(nodeTarget, 'node.exe'))),
  sourceSnapshot: true, completeReleaseBuild: false, originalSourceUnchanged: true,
  description: 'Current GUI development inputs with existing built Host; no complete Host rebuild or release acceptance.' }
await writeFile(join(repository, 'development', 'runtime-links.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ stage: 'runtime-copied', files: completed, bytes, links: links.length }))
