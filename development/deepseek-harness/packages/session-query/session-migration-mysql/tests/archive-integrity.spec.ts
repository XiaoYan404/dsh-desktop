/** Additional generation selection, manifest integrity and complete-archive budget cases. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { LogicalStore, MigrationLimits, MigrationSource } from '../src/types.ts'
import { captureArchive, readArchive } from '../src/archive.ts'
import { diffLogical } from '../src/logical.ts'

const owned: string[] = []
const limits: MigrationLimits = { maxArchiveBytes: 100000, maxFileBytes: 20000, maxSessionBytes: 20000, batchEvents: 2 }

afterEach(async () => {
  for (const root of owned.splice(0)) {
    const actual = await realpath(root)
    if (dirname(actual).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(actual).startsWith('dsh06-integrity-')) {
      throw new Error('Refusing cleanup outside this test’s exact temporary directory.')
    }
    await rm(actual, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh06-integrity-'))
  owned.push(root)
  const parent = join(root, 'archives'), sourceRoot = join(root, 'source')
  await mkdir(parent); await mkdir(sourceRoot)
  const lifecycle = '01010101010101010101010101010101'
  let logical: LogicalStore = { version: 1, sessions: [{
    header: { id: SessionId('empty'), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
    lifecycle, logRevision: '1', inheritedEventCount: SessionLogOffset(0), events: [], surface: [], projections: null,
    appendReceipts: [], selectedGeneration: { lifecycle, format: 4 },
    generations: [{ lifecycle, format: 3, sourceFiles: ['session.v3.jsonl'] }, { lifecycle, format: 4, sourceFiles: ['session.v4.jsonl'] }],
  }], workspace: { version: 2,
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, records: [] } }
  const source: MigrationSource = { freeze: async () => ({ sourceRoot, identity: 'maintenance-owner',
    assertCurrent: async () => {}, [Symbol.asyncDispose]: async () => {},
    read: async () => ({ logical: structuredClone(logical), files: [
      { path: 'session.v3.jsonl', kind: 'session_log' as const, bytes: Buffer.from('old bytes\r\n') },
      { path: 'session.v4.jsonl', kind: 'session_log' as const, bytes: Buffer.from('current bytes\r\n') },
    ] }),
  }) }
  return { parent, source, get logical() { return logical }, setLogical(value: LogicalStore) { logical = value } }
}

it('refuses selection of a lower canonical source generation', async () => {
  const f = await fixture()
  f.setLogical({ ...f.logical, sessions: f.logical.sessions.map(value => ({ ...value,
    selectedGeneration: { lifecycle: value.lifecycle, format: 3 } })) })
  await expect(captureArchive(f.source, f.parent, 'lower', limits)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
  expect(await readFile(join(f.parent, 'lower/raw/session.v4.jsonl'), 'utf8')).toBe('current bytes\r\n')
})

it('refuses a future retained generation before using an older supported selection', async () => {
  const f = await fixture()
  f.setLogical({ ...f.logical, sessions: f.logical.sessions.map(value => ({ ...value, generations: [...value.generations,
    { lifecycle: value.lifecycle, format: SESSION_FORMAT_VERSION + 1, sourceFiles: ['session.v4.jsonl'] }] })) })
  await expect(captureArchive(f.source, f.parent, 'future', limits)).rejects.toMatchObject({ code: 'FUTURE_FORMAT' })
})

it('covers identity-file bytes with the final manifest checksum', async () => {
  const f = await fixture()
  const archive = await captureArchive(f.source, f.parent, 'identity', limits)
  await writeFile(join(archive.directory, 'identity.json'), '{}')
  await expect(readArchive(archive.directory, limits)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
})

it('includes the manifest and source identity in complete-archive capacity checks', async () => {
  const f = await fixture()
  const archive = await captureArchive(f.source, f.parent, 'budget', limits)
  const metadataBytes = (await readFile(join(archive.directory, 'manifest.json'))).byteLength
    + (await readFile(join(archive.directory, 'identity.json'))).byteLength
  const dataBytes = archive.manifest.files.reduce((sum, value) => sum + value.bytes, 0)
    + (await readFile(join(archive.directory, 'logical.json'))).byteLength
  await expect(readArchive(archive.directory, { ...limits, maxArchiveBytes: dataBytes + metadataBytes - 1 }))
    .rejects.toMatchObject({ code: 'CAPACITY' })
})

it('compares optional header presence and newly observed session fields instead of dropping them', async () => {
  const f = await fixture()
  const first = f.logical.sessions[0]!
  const other: LogicalStore = { ...f.logical, sessions: [{ ...first, header: { ...first.header, delegationDepth: 0 } }] }
  expect(diffLogical(f.logical, other)).toContainEqual({ sessionId: 'empty', field: 'header' })
  const extended = { ...f.logical, sessions: [{ ...first, extraDurableValue: 'retained' }] }
  expect(diffLogical(f.logical, extended)).toContainEqual({ sessionId: 'empty', field: 'session-record' })
})
