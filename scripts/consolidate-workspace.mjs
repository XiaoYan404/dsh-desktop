import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir, lstat, readlink, access } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(repository, '..')
const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const privateRoot = join(repository, 'local-only', `consolidation-${stamp}`)
const development = join(repository, 'development')
const records = []
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

function inside(root, path) {
  const child = relative(root, resolve(path))
  if (child.startsWith('..') || isAbsolute(child)) throw new Error('Migration path escaped its owner')
  return child
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`Git metadata operation failed (${result.status})`)
  return result.stdout
}

async function exists(path) { try { await access(path); return true } catch (error) {
  if (error?.code === 'ENOENT') return false
  throw error
} }

async function copy(source, destination, category) {
  inside(workspace, source)
  inside(repository, destination)
  const info = await lstat(source)
  const link = info.isSymbolicLink() ? await readlink(source) : undefined
  const bytes = link === undefined ? await readFile(source) : Buffer.from(link)
  await mkdir(dirname(destination), { recursive: true })
  if (await exists(destination)) {
    if (sha(await readFile(destination)) !== sha(bytes)) {
      throw new Error(`Existing destination differs: ${relative(repository, destination)}`)
    }
  } else await writeFile(destination, bytes, { flag: 'wx' })
  if (sha(await readFile(destination)) !== sha(bytes)) throw new Error('Migration byte verification failed')
  records.push({ path: relative(repository, destination).replaceAll('\\', '/'), category,
    bytes: bytes.length, sha256: sha(bytes), ...(link === undefined ? {} : { gitLinkTarget: link }) })
}

async function tree(source, destination, category, excluded = new Set()) {
  if (!await exists(source)) return
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await tree(from, to, category, excluded)
    else await copy(from, to, category)
  }
}

await mkdir(privateRoot, { recursive: true })
await writeFile(join(repository, 'local-only', '.gitignore'), '*\n!.gitignore\n', { flag: 'wx' })
await mkdir(development, { recursive: true })
for (const name of ['deepseek-harness', 'dsh-desktop', 'cc-switch']) {
  const source = join(workspace, name)
  if (!await exists(join(source, '.git'))) continue
  const vcs = join(privateRoot, 'vcs', name)
  await mkdir(vcs, { recursive: true })
  await writeFile(join(vcs, 'status.z'), git(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
  await writeFile(join(vcs, 'unstaged.patch'), git(source, ['diff', '--binary']))
  await writeFile(join(vcs, 'staged.patch'), git(source, ['diff', '--cached', '--binary']))
  await writeFile(join(vcs, 'head.txt'), git(source, ['rev-parse', 'HEAD']))
  const bundle = spawnSync('git', ['-C', source, 'bundle', 'create', join(vcs, 'history.bundle'), '--all'],
    { windowsHide: true, encoding: 'utf8' })
  if (bundle.status !== 0) throw new Error(`History bundle failed: ${name}`)
  if (name !== 'deepseek-harness') continue
  const modes = Object.fromEntries(git(source, ['ls-files', '--stage', '-z']).toString('utf8')
    .split('\0').filter(Boolean).map(line => {
      const separator = line.indexOf('\t')
      return [line.slice(separator + 1), line.slice(0, separator).split(' ')[0]]
    }))
  await writeFile(join(vcs, 'index-modes.json'), JSON.stringify(modes, null, 2) + '\n')
  const paths = [...new Set(git(source, ['ls-files', '-c', '-o', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean))]
  console.log(JSON.stringify({ stage: 'source-copy', files: paths.length }))
  let copied = 0
  for (const path of paths) {
    const from = resolve(source, path)
    inside(source, from)
    if (!await exists(from)) continue
    if (/^\.env(?:\.|$)/.test(path) && path !== '.env.example') {
      await copy(from, join(privateRoot, 'harness-private', path), 'private')
    } else await copy(from, resolve(development, name, path), 'harness-source')
    copied++
    if (copied % 2500 === 0) console.log(JSON.stringify({ stage: 'source-copy', copied }))
  }
}

const prototype = '企业工作台页面原型改造'
await tree(join(workspace, prototype), join(development, prototype), 'prototype',
  new Set(['.preview-data', '__pycache__', 'node_modules', '.git']))
await tree(join(workspace, prototype, '.preview-data'), join(privateRoot, 'prototype-data'), 'private')
await tree(join(workspace, '企业工作台页面开发文档'), join(development, '企业工作台页面开发文档'), 'project-documents')
for (const entry of await readdir(workspace, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(md|cmd)$/i.test(entry.name)) continue
  await copy(join(workspace, entry.name), join(development, entry.name), 'workspace-documents-and-launchers')
}
await tree(join(workspace, 'deepseek-harness', 'parallel-tasks'),
  join(privateRoot, 'handoff', 'parallel-tasks'), 'private-handoff')
await tree(join(workspace, 'deepseek-harness', '.artifacts', 'parallel-handoff'),
  join(privateRoot, 'handoff', 'parallel-handoff'), 'private-handoff', new Set(['node_modules', 'vite-cache']))

const originalFork = join(privateRoot, 'vcs', 'dsh-desktop-fork')
await mkdir(originalFork, { recursive: true })
await writeFile(join(originalFork, 'status.z'), git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
await writeFile(join(originalFork, 'unstaged.patch'), git(repository, ['diff', '--binary']))
await writeFile(join(originalFork, 'staged.patch'), git(repository, ['diff', '--cached', '--binary']))
await writeFile(join(originalFork, 'head.txt'), git(repository, ['rev-parse', 'HEAD']))
const manifest = { createdUtc: new Date().toISOString(), originalDirectoriesRetained: true,
  liveDataMoved: false, secretsPublished: false, records, fileCount: records.length,
  totalBytes: records.reduce((total, record) => total + record.bytes, 0) }
await writeFile(join(privateRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await mkdir(join(repository, 'project-docs'), { recursive: true })
await writeFile(join(repository, 'project-docs', 'consolidation-status.json'), JSON.stringify({
  source: 'development/deepseek-harness', prototype: `development/${prototype}`,
  privateArchive: relative(repository, privateRoot).replaceAll('\\', '/'),
  filesVerified: records.length, bytesVerified: manifest.totalBytes, originalDirectoriesRetained: true,
  taskCounts: { total: 175, completed: 137, inProgress: 35, notStarted: 3 },
  releaseAccepted: false, executableCreated: false, pushed: false,
}, null, 2) + '\n')
console.log(JSON.stringify({ stage: 'complete', files: records.length, bytes: manifest.totalBytes,
  privateArchive: relative(repository, privateRoot).replaceAll('\\', '/') }))
