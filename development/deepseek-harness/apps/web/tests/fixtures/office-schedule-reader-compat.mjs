/** Plain-Node artifact comparison against the frozen office reader for the requested feature. */
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const currentPath = join(repo, 'packages/enterprise/office/lib/types/spec.js')
const [before, after, feature = 'schedule'] = process.argv.slice(2)
const fixtures = {
  schedule: { file: 'office-state-before-schedule-updates.mjs', hash: 'c969d3bb47f1828e7fef56efa9f0ed8f2f7aec20b5838be4e63fed3d4dfa0d64' },
  task: { file: 'office-state-before-work-decisions.mjs', hash: '15fe0acbbff3ee0d3cd4a49be64d39da321e6d4d90c51bfab613be5c4f72e3b0' },
  work: { file: 'office-state-before-work-edits.mjs', hash: 'e7c210816d09213436da86b67fb237fca926585c9c45d1287649f1470f14384b' },
  todo: { file: 'office-state-before-todo-assignment.mjs', hash: '28bd0134db280fc7592c6101e30eddb4cea442d4ebed7774fb2fd5d15364d9a4' },
  priority: { file: 'office-state-before-work-priority.mjs', hash: 'c8b25350ba0fe9bdc89232e0360f8e1f6129be7c3c68e87fd0d738acd1d84f47' },
  members: { file: 'office-state-before-schedule-members.mjs', hash: 'aa8ad51a84d96d0b9e4d21ae6007024fe23cdc182f92ca94ed2fb9bd621febd8' },
  subtasks: { file: 'office-state-before-work-subtasks.mjs', hash: '6807525fc55009829701b299d774cb085c8d7a182766d2bab9ccf9b8335f657d' },
  delivery: { file: 'office-state-before-task-delivery.mjs', hash: '3575c938bd9e23a787a3f9747b42d3a17f66cc4d6f9372764bf90c5e83889355' },
  attachments: { file: 'office-state-before-work-attachments.mjs', hash: '892d29500f14207514d956880017a01ee72794b5478a87c6142dd10af6e8c03d' },
  lifecycle: { file: 'office-state-before-work-lifecycle.mjs', hash: '72efe5ba6a473c8dc611c067d0d3c0d552b903ffcd95727fdf6d5a12c1138ad7' },
}
if (!Object.hasOwn(fixtures, feature)) throw new Error('Unknown frozen office reader')
const fixture = fixtures[feature]
const originalPath = fileURLToPath(new URL(`./${fixture.file}`, import.meta.url))
const original = await readFile(originalPath)
const digest = value => createHash('sha256').update(value).digest('hex')
if (digest(original) !== fixture.hash) throw new Error('The frozen office reader changed')
if (!before || !after || process.argv.length > 5) throw new Error('Expected before and after office documents with an optional feature')
const root = await mkdtemp(join(tmpdir(), 'dsh-office-reader-compat-'))
const base = pathToFileURL(currentPath).href
const load = name => import(import.meta.resolve(name, base))
const { Context } = await load('@deepseek-ai/cordis')
const { default: Storage } = await load('@deepseek-ai/dsh-storage')
const StorageJson = await load('@deepseek-ai/dsh-storage-json')
const StorageDomain = await load('@deepseek-ai/dsh-storage-domain')
try {
  const relocated = original.toString('utf8').replace(
    /from '(zod|@deepseek-ai\/dsh-brand|@deepseek-ai\/dsh-storage-domain)'/g,
    (_match, name) => `from '${import.meta.resolve(name, base)}'`,
  )
  const oldPath = join(root, 'frozen-reader.mjs')
  await writeFile(oldPath, relocated)
  const previous = await import(pathToFileURL(oldPath).href)
  const current = await import(base)
  const results = []
  for (const [stage, input] of [['before', before], ['after', after]]) {
    const bytes = await readFile(input)
    for (const [reader, spec] of [['previous', previous.officeDomain], ['current', current.officeDomain]]) {
      const dataRoot = join(root, `${stage}-${reader}`)
      await mkdir(dataRoot)
      const file = join(dataRoot, 'enterprise_office.json')
      await copyFile(input, file)
      const ctx = new Context()
      let domain
      let result
      try {
        await ctx.plugin(Storage)
        await ctx.plugin(StorageJson, { root: dataRoot })
        await ctx.plugin(StorageDomain, { backend: 'json' })
        domain = await ctx.storageDomain.open(spec)
        const state = domain.global.get()
        result = { stage, reader, ok: true, items: state.items.length, revision: state.revision }
      } catch (error) {
        result = { stage, reader, ok: false, name: error?.name, code: error?.code }
      } finally {
        await domain?.close()
        await ctx.fiber.dispose()
      }
      result.unchanged = digest(await readFile(file)) === digest(bytes)
      results.push(result)
    }
  }
  const ok = results.every(result => result.unchanged && result.ok === !(result.stage === 'after' && result.reader === 'previous'))
  process.stdout.write(JSON.stringify({ ok, readerSha256: fixture.hash, results }) + '\n')
  if (!ok) process.exitCode = 1
} finally {
  const absolute = resolve(root)
  if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-reader-compat-'))
    throw new Error('Unexpected reader comparison cleanup root')
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
