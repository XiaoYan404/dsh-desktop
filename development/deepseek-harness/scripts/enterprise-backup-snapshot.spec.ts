/** Backup identities refer to the manifest read and validated during that operation. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createBackup, restoreBackup, verifyBackup } from './enterprise-backup.ts'

const boundary = vi.hoisted<{ afterCompletionRead: (() => Promise<void>) | null }>(() => ({ afterCompletionRead: null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const bytes = await actual.readFile(...args)
      if (typeof args[0] === 'string' && args[0].replaceAll('\\', '/').endsWith('/COMPLETE')) {
        const afterRead = boundary.afterCompletionRead
        boundary.afterCompletionRead = null
        if (afterRead) await afterRead()
      }
      return bytes
    },
  }
})

afterEach(() => { boundary.afterCompletionRead = null })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-backup-snapshot-'))
  onTestFinished(async () => {
    const absolute = resolve(directory)
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('dsh-backup-snapshot-')) {
      throw new Error('Unexpected backup snapshot fixture directory')
    }
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const home = join(directory, 'home')
  await mkdir(home)
  const payload = Buffer.from([0, 255, 17, 42])
  await writeFile(join(home, 'retained.bin'), payload)
  const backup = join(directory, 'backup')
  const summary = await createBackup({ roots: [{ id: 'home', path: home }], output: backup, provider: 'local', quiescent: true })
  const manifest = join(backup, 'manifest.json')
  const original = await readFile(manifest, 'utf8')
  const replacement = original.replace(/"createdAt": "[^"]+"/u, '"createdAt": "2040-01-02T03:04:05.000Z"')
  expect(replacement).not.toBe(original)
  boundary.afterCompletionRead = async () => { await writeFile(manifest, replacement) }
  return { directory, backup, manifest, original, replacement, summary, payload }
}

it('verification identifies the validated manifest when its file is replaced after capture', async () => {
  const current = await fixture()
  const result = await verifyBackup(current.backup)
  expect(await readFile(current.manifest, 'utf8')).toBe(current.replacement)
  expect(result).toEqual(current.summary)
  expect(result.manifestSha256).toBe(createHash('sha256').update(current.original).digest('hex'))
})

it('restoration records the validated manifest identity rather than a replacement file', async () => {
  const current = await fixture()
  const target = join(current.directory, 'restored')
  await restoreBackup(current.backup, target)
  const receipt: unknown = JSON.parse(await readFile(join(target, 'RESTORED.json'), 'utf8'))
  expect(await readFile(current.manifest, 'utf8')).toBe(current.replacement)
  expect(await readFile(join(target, 'home/retained.bin'))).toEqual(current.payload)
  expect(receipt).toMatchObject({ manifestSha256: current.summary.manifestSha256 })
})
