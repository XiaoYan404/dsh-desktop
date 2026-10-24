/** Filesystem identity checks for the Win32 account-directory access path. */
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { platformStoragePath } from '../src/platform-storage.ts'

const roots: string[] = []
const digest = 'a'.repeat(64)

async function fixture(): Promise<{ root: string; original: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-platform-alias-'))
  roots.push(root)
  const original = join(root, 'Partitions', 'dsh-platform-' + digest)
  await mkdir(original, { recursive: true })
  await writeFile(join(original, 'preference'), '旧版偏好字节')
  return { root, original }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('dsh-platform-alias-')) {
      throw new Error('Unexpected owned Platform alias fixture')
    }
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('reads and writes the original preference through one shorter filesystem alias', async () => {
  const { root, original } = await fixture()
  const alias = await platformStoragePath(root, digest)
  expect(alias.length).toBeLessThan(original.length)
  expect((await lstat(alias)).isSymbolicLink()).toBe(true)
  expect(await realpath(alias)).toBe(await realpath(original))
  expect(await readFile(join(alias, 'preference'), 'utf8')).toBe('旧版偏好字节')
  await writeFile(join(alias, 'preference'), '新版偏好字节')
  expect(await readFile(join(original, 'preference'), 'utf8')).toBe('新版偏好字节')
  expect(await platformStoragePath(root, digest)).toBe(alias)
})

it('shares a single verified target when simultaneous opens create the alias', async () => {
  const { root, original } = await fixture()
  const paths = await Promise.all(Array.from({ length: 10 }, () => platformStoragePath(root, digest)))
  expect(new Set(paths).size).toBe(1)
  expect(await realpath(paths[0]!)).toBe(await realpath(original))
  expect(await readFile(join(original, 'preference'), 'utf8')).toBe('旧版偏好字节')
})

it.each(['directory', 'other-account', 'digest-collision'] as const)('rejects an occupied alias (%s) without altering preferences', async (kind) => {
  const { root, original } = await fixture()
  const alias = await platformStoragePath(root, digest)
  if (kind === 'digest-collision') {
    await expect(platformStoragePath(root, digest.slice(0, 32) + 'b'.repeat(32))).rejects.toThrow('expected account directory')
  } else {
    await unlink(alias)
    if (kind === 'directory') await mkdir(alias)
    else {
      const other = join(root, 'other-account')
      await mkdir(other)
      await writeFile(join(other, 'preference'), '另一账号偏好')
      await symlink(other, alias, 'junction')
    }
    await expect(platformStoragePath(root, digest)).rejects.toThrow('expected account directory')
  }
  expect(await readFile(join(original, 'preference'), 'utf8')).toBe('旧版偏好字节')
  if (kind === 'other-account') expect(await readFile(join(alias, 'preference'), 'utf8')).toBe('另一账号偏好')
})
