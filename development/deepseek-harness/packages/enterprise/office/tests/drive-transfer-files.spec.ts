/** Actual disk bytes, retry identities and bounded large-file reads without a model or database mock. */
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OfficeDriveTransferFiles } from '../src/drive-transfer-files.ts'
import type { DriveUploadPart } from '../src/drive-transfer-files.ts'

const mib = 1024 * 1024
const limits = { maxFileBytes: 12 * mib, chunkBytes: mib }
const roots: string[] = []
const digest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-drive-transfer-'))
  roots.push(root)
  const objects = join(root, 'objects')
  return { root, objects, files: new OfficeDriveTransferFiles(objects, limits) }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const target = resolve(root)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('dsh-drive-transfer-')) {
      throw new Error('Unexpected owned drive-transfer fixture')
    }
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

it('merges a file above eight MiB from out-of-order chunks and restores exact range bytes after reopening', async () => {
  const { objects, files } = await fixture()
  const id = randomUUID()
  const bytes = Buffer.alloc(9 * mib + 19).fill(Buffer.from('大文件真实内容\n'))
  const parts: DriveUploadPart[] = []
  for (let index = Math.ceil(bytes.length / mib) - 1; index >= 0; index--) {
    parts.push(await files.stageChunk(id, index, bytes.subarray(index * mib, (index + 1) * mib)))
  }
  const content = { byteLength: bytes.length, sha256: digest(bytes) }
  const blob = await files.merge(id, content, parts)
  expect(blob).toEqual({ id, ...content })
  expect((await readFile(join(objects, `${id}.bin`))).equals(bytes)).toBe(true)
  const reopened = new OfficeDriveTransferFiles(objects, limits)
  await reopened.verify(blob)
  const ranges: Buffer[] = []
  for (let offset = 0; offset < bytes.length; offset += mib) {
    ranges.push(await reopened.readRange(blob, offset, Math.min(mib, bytes.length - offset)))
  }
  expect(Buffer.concat(ranges).equals(bytes)).toBe(true)
  expect(digest(Buffer.concat(ranges))).toBe(content.sha256)
  expect(await files.merge(id, content, parts)).toEqual(blob)
  expect((await readdir(objects)).filter(name => name.endsWith('.bin'))).toEqual([`${id}.bin`])
})

it('accepts identical simultaneous chunk retries and rejects changed bytes without replacing the original', async () => {
  const { objects, files } = await fixture()
  const id = randomUUID()
  const bytes = Buffer.from('保留的原分块')
  const [first, second] = await Promise.all([files.stageChunk(id, 0, bytes), files.stageChunk(id, 0, bytes)])
  expect(first).toEqual(second)
  await expect(files.stageChunk(id, 0, Buffer.alloc(bytes.length, 1))).rejects.toMatchObject({ code: 'conflict' })
  expect((await readFile(join(objects, 'uploads', id, '0.part'))).equals(bytes)).toBe(true)
  expect(await readdir(join(objects, 'uploads', id))).toEqual(['0.part'])
})

it('keeps contended identical retries readable while unrelated chunks publish independently', async () => {
  const { objects, files } = await fixture()
  const bytes = Buffer.from('Concurrent immutable chunk publication\n')
  for (let wave = 0; wave < 32; wave++) {
    const id = randomUUID()
    const results = await Promise.allSettled([
      ...Array.from({ length: 8 }, (_, index) => files.stageChunk(
        process.platform === 'win32' && index % 2 ? id.toUpperCase() : id, 0, bytes,
      )),
      files.stageChunk(id, 1, bytes),
    ])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const parts = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    expect(parts.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => ({ index: 0, byteLength: bytes.length, sha256: digest(bytes) })))
    expect(parts[8]).toEqual({ index: 1, byteLength: bytes.length, sha256: digest(bytes) })
    expect((await readFile(join(objects, 'uploads', id, '0.part'))).equals(bytes)).toBe(true)
    expect((await readdir(join(objects, 'uploads', id))).sort()).toEqual(['0.part', '1.part'])
  }
})

it('releases a failed publication before the next exact object attempt and preserves its successful bytes', async () => {
  const { objects, files } = await fixture()
  const id = randomUUID()
  const bytes = Buffer.from('Publication recovery after an invalid complete digest')
  const part = await files.stageChunk(id, 0, bytes)
  const content = { byteLength: bytes.length, sha256: digest(bytes) }
  const results = await Promise.allSettled([
    files.merge(id, { ...content, sha256: '0'.repeat(64) }, [part]),
    files.merge(id, content, [part]),
  ])
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } })
  expect(results[1]).toEqual({ status: 'fulfilled', value: { id, ...content } })
  expect((await readFile(join(objects, `${id}.bin`))).equals(bytes)).toBe(true)
  expect((await readdir(objects)).filter(name => name.endsWith('.partial'))).toEqual([])
})

it('publishes no object for missing chunks, failed reads or a different complete-file digest', async () => {
  const { objects, files } = await fixture()
  const id = randomUUID()
  const firstBytes = Buffer.alloc(mib, 7)
  const lastBytes = Buffer.from('last')
  const part = await files.stageChunk(id, 0, firstBytes)
  const missing = { index: 1, byteLength: lastBytes.length, sha256: digest(lastBytes) }
  const content = { byteLength: firstBytes.length + lastBytes.length, sha256: digest(Buffer.concat([firstBytes, lastBytes])) }
  await expect(files.merge(id, content, [part])).rejects.toThrow('incomplete')
  await expect(files.merge(id, content, [part, missing])).rejects.toMatchObject({ code: 'ENOENT' })
  const final = await files.stageChunk(id, 1, lastBytes)
  await expect(files.merge(id, { ...content, sha256: '0'.repeat(64) }, [part, final])).rejects.toThrow('integrity')
  expect(await readdir(objects)).toEqual(['uploads'])
  await expect(access(join(objects, `${id}.bin`))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readFile(join(objects, 'uploads', id, '0.part'))).equals(firstBytes)).toBe(true)
})

it('detects changed staged bytes before merge and changed published bytes after a verified download', async () => {
  const { objects, files } = await fixture()
  const stagedId = randomUUID()
  const bytes = Buffer.from('immutable original')
  const part = await files.stageChunk(stagedId, 0, bytes)
  await writeFile(join(objects, 'uploads', stagedId, '0.part'), Buffer.alloc(bytes.length, 1))
  await expect(files.merge(stagedId, { byteLength: bytes.length, sha256: digest(bytes) }, [part])).rejects.toThrow('integrity')
  const id = randomUUID()
  const original = await files.stageChunk(id, 0, bytes)
  const blob = await files.merge(id, { byteLength: bytes.length, sha256: digest(bytes) }, [original])
  expect((await files.readRange(blob, 0, bytes.length)).equals(bytes)).toBe(true)
  await writeFile(join(objects, `${id}.bin`), Buffer.alloc(bytes.length, 2))
  await expect(files.readRange(blob, 0, bytes.length)).rejects.toThrow('integrity')
})

it('cancels staging without deleting a committed object and removes explicitly unpublished bytes', async () => {
  const { objects, files } = await fixture()
  const id = randomUUID()
  const bytes = Buffer.from('published original')
  const part = await files.stageChunk(id, 0, bytes)
  const blob = await files.merge(id, { byteLength: bytes.length, sha256: digest(bytes) }, [part])
  await files.discard(id, false)
  await expect(access(join(objects, 'uploads', id))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await files.readRange(blob, 0, bytes.length)).equals(bytes)).toBe(true)
  await files.discard(id, false)
  await files.discard(id, true)
  await expect(access(join(objects, `${id}.bin`))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a replaced staging junction without removing its target', async () => {
  const { root, objects, files } = await fixture()
  const id = randomUUID()
  const outside = join(root, 'retained data')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'retained bytes')
  await mkdir(join(objects, 'uploads'), { recursive: true })
  await symlink(outside, join(objects, 'uploads', id), 'junction')
  await expect(files.discard(id, true)).rejects.toThrow('replaced')
  await expect(files.stageChunk(id, 0, Buffer.from('new'))).rejects.toThrow('replaced')
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('retained bytes')
})

it('handles empty files and enforces byte limits before publication or range allocation', async () => {
  const { files } = await fixture()
  const id = randomUUID()
  const empty = await files.merge(id, { byteLength: 0, sha256: digest(Buffer.alloc(0)) }, [])
  expect(await files.readRange(empty, 0, 0)).toEqual(Buffer.alloc(0))
  await expect(files.stageChunk(randomUUID(), 0, Buffer.alloc(mib + 1))).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(files.merge(randomUUID(), { byteLength: limits.maxFileBytes + 1, sha256: '0'.repeat(64) }, [])).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(files.readRange(empty, 0, mib + 1)).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(files.readRange(empty, -1, 0)).rejects.toMatchObject({ code: 'invalid_input' })
})
