import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const status = JSON.parse(await readFile(join(repository, 'project-docs', 'consolidation-status.json'), 'utf8'))
const archive = resolve(repository, status.privateArchive)
const owner = relative(join(repository, 'local-only'), archive)
if (owner.startsWith('..') || isAbsolute(owner)) throw new Error('Private source archive escaped its owner')
try {
  const receipt = JSON.parse(await readFile(join(archive, 'source-emissions.json'), 'utf8'))
  if (Array.isArray(receipt.records) && receipt.recordedSessionSnapshotsChanged === false) {
    console.log(JSON.stringify({ alreadyFinalized: true, emissionsArchived: receipt.records.length }))
    process.exit(0)
  }
} catch (error) { if (error.code !== 'ENOENT') throw error }
const modes = JSON.parse(await readFile(join(archive, 'vcs', 'deepseek-harness', 'index-modes.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))
const generated = new Set()
for (const record of manifest.records) {
  const path = record.path.replace('development/deepseek-harness/', '')
  if (record.category !== 'harness-source' || modes[path] || !path.startsWith('packages/')
    || !path.includes('/src/') || !path.endsWith('.js.map')) continue
  const source = join(repository, record.path)
  let map
  try { map = JSON.parse(await readFile(source, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  const javascript = source.slice(0, -4)
  const typescript = javascript.slice(0, -3)
  let implementation = false
  for (const extension of ['.ts', '.tsx']) {
    try { implementation ||= (await stat(typescript + extension)).isFile() }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (implementation && map.sources?.some(value => /\.tsx?$/.test(value))) {
    generated.add(record.path.slice(0, -4))
    generated.add(record.path)
  }
}
const records = []
for (const path of generated) {
  const source = join(repository, path)
  const destination = join(archive, 'source-emissions', path)
  const hash = createHash('sha256').update(await readFile(source)).digest('hex')
  await mkdir(dirname(destination), { recursive: true })
  try { await stat(destination); throw new Error('An existing emission archive must not be overwritten') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await rename(source, destination)
  if (createHash('sha256').update(await readFile(destination)).digest('hex') !== hash) throw new Error('An archived emission changed')
  records.push({ path, sha256: hash })
}
function git(args, input) {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd: repository,
    input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('Source index metadata operation failed')
  return result.stdout
}
const changes = []
for (const entry of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
  const tab = entry.indexOf('\t')
  const path = entry.slice(tab + 1)
  const [mode, object] = entry.slice(0, tab).split(' ')
  if (generated.has(path)) changes.push(`0 ${'0'.repeat(object.length)}\t${path}\0`)
  else if (path.startsWith('development/deepseek-harness/')) {
    const expected = modes[path.slice('development/deepseek-harness/'.length)]
    if (expected && mode !== expected) changes.push(`${expected} ${object}\t${path}\0`)
  }
}
if (changes.length) git(['update-index', '-z', '--index-info'], changes.join(''))
await writeFile(join(archive, 'source-emissions.json'), JSON.stringify({ records,
  originalFilesRetainedInSourceRepository: true, recordedSessionSnapshotsChanged: false }, null, 2) + '\n')
console.log(JSON.stringify({ emissionsArchived: records.length, indexEntriesAdjusted: changes.length,
  originalSourceUnchanged: true }))
