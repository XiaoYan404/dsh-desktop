import { mkdir, readFile, writeFile, readdir, lstat, copyFile, link } from 'node:fs/promises'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const development = join(repository, 'development')
const output = join(repository, '.build', 'enterprise-payload')
const status = JSON.parse(await readFile(join(repository, 'project-docs', 'consolidation-status.json'), 'utf8'))
const imported = JSON.parse(await readFile(join(repository, status.privateArchive, 'manifest.json'), 'utf8'))
const sourceFiles = new Set(imported.records.filter(entry => entry.category === 'harness-source')
  .map(entry => entry.path.replace('development/deepseek-harness/', '')))
const work = []
let copied = 0
let countBytes = 0

function allowed(path) {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (['.git', '.artifacts', '.idea', '.claude', '.codex', 'tmp'].includes(parts[0])) return false
  if (parts.some(part => ['.git', '.cache', '.vite'].includes(part))) return false
  if (parts.some(part => part.startsWith('.env') && part !== '.env.example')) return false
  if (/\.(log|url)$/i.test(normalized)) return false
  if (normalized.startsWith('.dsh-build/')) return normalized === '.dsh-build/client-build-environment.json'
  return sourceFiles.has(normalized) || parts.includes('node_modules') || parts.includes('lib')
    || parts.includes('dist') || normalized.startsWith('native/') && parts.includes('build')
}

async function walk(source, target, scope) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    const path = relative(scope, from)
    if (scope.endsWith('deepseek-harness') && ['.git', '.artifacts', '.idea', '.claude', '.codex', 'tmp']
      .includes(path.split(/[\\/]/)[0])) continue
    if (entry.isSymbolicLink()) throw new Error('Payload must be staged before dependency junctions are materialized')
    if (entry.isDirectory()) {
      await walk(from, to, scope)
    } else if (scope.endsWith('deepseek-harness') && !allowed(path)) continue
    else work.push(async () => {
      try {
        await lstat(to)
        throw new Error('Payload output is already populated; preserve it and use a new owned stage')
      } catch (error) { if (error?.code !== 'ENOENT') throw error }
      if (path.split(/[\\/]/).includes('node_modules')) {
        try { await link(from, to) } catch (error) {
          if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(error?.code)) throw error
          await copyFile(from, to)
        }
      } else await copyFile(from, to)
      const info = await lstat(from)
      countBytes += info.size
      copied++
      if (copied % 20000 === 0) console.log(JSON.stringify({ stage: 'payload', copied, bytes: countBytes }))
    })
  }
}
await walk(join(development, 'deepseek-harness'), join(output, 'deepseek-harness'), join(development, 'deepseek-harness'))
await walk(join(development, '.local-run'), join(output, '.local-run'), join(development, '.local-run'))
for (const name of ['runtime-links.json', 'toolchain.json', 'link-enterprise-runtime.mjs', 'prepare-enterprise-baseline.mjs']) {
  work.push(async () => { await copyFile(join(development, name), join(output, name)) })
}
console.log(JSON.stringify({ stage: 'payload-start', files: work.length }))
let cursor = 0
await Promise.all(Array.from({ length: 12 }, async () => { while (cursor < work.length) await work[cursor++]() }))
await writeFile(join(output, 'development-build.json'), JSON.stringify({
  edition: 'enterprise-development', node: '24.22.0', copiedFiles: copied, copiedBytes: countBytes,
  completeReleaseBuild: false, builtHostSnapshot: true, strictClientDiagnosticsRemainVisible: true,
  taskCounts: { total: 175, completed: 137, inProgress: 35, notStarted: 3 },
  rawUserDataIncluded: false, originalHostBuildCapPreserved: true,
}, null, 2) + '\n')
console.log(JSON.stringify({ stage: 'payload-complete', copied, bytes: countBytes }))
