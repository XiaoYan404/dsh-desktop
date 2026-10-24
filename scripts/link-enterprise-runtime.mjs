import { readFile, mkdir, lstat, realpath, symlink, unlink } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute, join } from 'node:path'

const runtime = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('A runtime directory is required')
const manifest = JSON.parse(await readFile(join(runtime, 'runtime-links.json'), 'utf8'))
if (manifest.format !== 1 || manifest.root !== 'deepseek-harness' || !Array.isArray(manifest.links)) {
  throw new Error('Unsupported runtime link manifest')
}
const project = join(runtime, manifest.root)
function owned(path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) throw new Error('Invalid runtime relative path')
  const absolute = resolve(project, path)
  const child = relative(project, absolute)
  if (child.startsWith('..') || isAbsolute(child)) throw new Error('Runtime link escaped its owner')
  return absolute
}
let created = 0
let removed = 0
const cleanup = process.argv[3] === '--cleanup'
for (const entry of manifest.links) {
  const path = owned(entry.path)
  const target = owned(entry.target)
  if (!(await lstat(target)).isDirectory()) throw new Error('Runtime link target is not a directory')
  let current
  try { current = await lstat(path) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (current !== undefined) {
    if (!current.isSymbolicLink() || (await realpath(path)).toLowerCase() !== (await realpath(target)).toLowerCase()) {
      throw new Error('Runtime dependency is occupied by another entry')
    }
    if (cleanup) { await unlink(path); removed++ }
  } else {
    if (cleanup) continue
    await mkdir(dirname(path), { recursive: true })
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    created++
  }
}
console.log(JSON.stringify({ links: manifest.links.length, created, removed }))
