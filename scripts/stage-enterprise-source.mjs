import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const status = JSON.parse(await readFile(join(repository, 'project-docs', 'consolidation-status.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(repository, status.privateArchive, 'manifest.json'), 'utf8'))
const selected = []
for (const record of manifest.records) {
  if (!['harness-source', 'prototype', 'project-documents'].includes(record.category)) continue
  try { await stat(join(repository, record.path)); selected.push(record.path) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
for (const directory of ['build', 'scripts']) for (const file of await readdir(join(repository, directory))) {
  if (/enterprise/.test(file) || ['consolidate-workspace.mjs', 'archive-development-records.mjs'].includes(file)) {
    if ((await stat(join(repository, directory, file))).isFile()) selected.push(directory + '/' + file)
  }
}
for (const directory of ['project-docs', 'development/企业工作台页面开发文档']) {
  for (const file of await readdir(join(repository, directory))) selected.push(directory + '/' + file)
}
for (const file of await readdir(join(repository, 'development'))) if (file.endsWith('.cmd')) selected.push('development/' + file)
selected.push('.gitignore', 'package.json', 'README.md', 'README.zh.md', 'test/ppt-source-build-contract.test.ts',
  'electron-builder.enterprise.cjs', '启动DeepSeekHarness.cmd', '停止DeepSeekHarness.cmd')
const paths = [...new Set(selected)]
const pathspec = join(repository, '.build', 'enterprise-delivery.pathspec')
await writeFile(pathspec, paths.join('\0') + '\0')
const result = spawnSync('git', ['-c', 'core.longpaths=true', '--literal-pathspecs', 'add', '--force',
  '--pathspec-from-file=' + pathspec, '--pathspec-file-nul'], { cwd: repository, stdio: 'inherit' })
if (result.status !== 0) throw new Error('Explicit source staging failed')
console.log(JSON.stringify({ stagedSourceInputs: paths.length, runtimeDirectoriesTraversed: false }))
