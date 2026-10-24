/** Actual temporary files reproduce growth, shrinkage and cancellation around a file-size observation. */
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readOpenArchiveFile } from '../src/archive-read.ts'

const owned: string[] = []
afterEach(async () => {
  for (const path of owned.splice(0)) {
    const actual = await realpath(path)
    if (dirname(actual).toLowerCase() !== (await realpath(tmpdir())).toLowerCase()
      || !basename(actual).startsWith('dsh06-bounded-')) throw new Error('Unexpected cleanup directory')
    await rm(actual, { recursive: true, force: true })
  }
})

async function fixture(bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh06-bounded-'))
  owned.push(directory)
  const path = join(directory, 'archive-input')
  await writeFile(path, bytes)
  return { path, file: await open(path, 'r') }
}

it('refuses growth after size observation without materializing the enlarged file', async () => {
  const { path, file } = await fixture(Buffer.from('ok'))
  try {
    const stat = file.stat.bind(file)
    vi.spyOn(file, 'stat').mockImplementationOnce(async () => {
      const observed = await stat()
      await appendFile(path, Buffer.alloc(4096))
      return observed
    })
    await expect(readOpenArchiveFile(file, 16)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
  } finally { await file.close() }
})

it('refuses a file truncated after size observation instead of returning a partial body', async () => {
  const { path, file } = await fixture(Buffer.from('original'))
  try {
    const stat = file.stat.bind(file)
    vi.spyOn(file, 'stat').mockImplementationOnce(async () => {
      const observed = await stat()
      await writeFile(path, '')
      return observed
    })
    await expect(readOpenArchiveFile(file, 16)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
  } finally { await file.close() }
})

it('preserves exact multibyte bytes and rejects one byte below the required budget before reading', async () => {
  const bytes = Buffer.from('计划 😀')
  const { file } = await fixture(bytes)
  try {
    expect(await readOpenArchiveFile(file, bytes.byteLength)).toEqual(bytes)
    const read = vi.spyOn(file, 'read')
    await expect(readOpenArchiveFile(file, bytes.byteLength - 1)).rejects.toMatchObject({ code: 'CAPACITY' })
    expect(read).not.toHaveBeenCalled()
  } finally { await file.close() }
})

it('stops between metadata observation and body allocation after GUI cancellation', async () => {
  const { file } = await fixture(Buffer.from('retained'))
  try {
    const controller = new AbortController()
    const reason = new Error('Cancelled during metadata read')
    const stat = file.stat.bind(file)
    const read = vi.spyOn(file, 'read')
    vi.spyOn(file, 'stat').mockImplementationOnce(async () => {
      const observed = await stat()
      controller.abort(reason)
      return observed
    })
    await expect(readOpenArchiveFile(file, 16, controller.signal)).rejects.toBe(reason)
    expect(read).not.toHaveBeenCalled()
  } finally { await file.close() }
})
