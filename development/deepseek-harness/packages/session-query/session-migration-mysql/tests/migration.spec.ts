/** Filesystem archives are real; the staging target is an explicit protocol fixture, not MySQL restore evidence. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildSessionEventRecords } from '@deepseek-ai/dsh-session-query'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { captureArchive, readArchive } from '../src/archive.ts'
import { importArchive } from '../src/import.ts'
import { diffLogical, sha256 } from '../src/logical.ts'
import { activateMysql, rollbackMysql } from '../src/switch.ts'
import type { ArchiveManifest, FrozenSourceFile, LogicalSession, LogicalStore, LogicalWorkspace, MigrationLimits,
  MigrationReceipt, MigrationSource, MigrationTarget, ProviderSelection } from '../src/types.ts'

const limits: MigrationLimits = { maxArchiveBytes: 2000000, maxFileBytes: 500000, maxSessionBytes: 500000, batchEvents: 2 }
const owned: string[] = []

afterEach(async () => {
  for (const path of owned.splice(0)) {
    const actual = await realpath(path)
    if (dirname(actual).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(actual).startsWith('dsh06-')) {
      throw new Error('Refusing cleanup outside the exact owned temporary directory.')
    }
    await rm(actual, { recursive: true, force: true })
  }
})

function session(id = 'session-😀'): LogicalSession {
  const header: SessionHeader = { id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/source' }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: SessionSeq(2), time: 3, data: createUserMessage({ content: [{ type: 'text', text: '原始计划 😀 foo()' }], source: { kind: 'user' } }), surfaceOp: 'append' },
    { type: 'step/end', seq: SessionSeq(3), time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(4), time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return { header, lifecycle: '01010101010101010101010101010101', logRevision: '2', inheritedEventCount: SessionLogOffset(0), events,
    surface: buildSessionEventRecords(header.id, events), projections: { identity: { formatVersion: SESSION_FORMAT_VERSION,
      createdAt: 1, isSeeded: false, inheritedEventCount: 0, cwd: '/source' }, rows: { title: { ver: 1, seq: 2, val: null } } },
    appendReceipts: [{ batch: 'receipt-1', firstSeq: 0, eventCount: events.length }],
    selectedGeneration: { lifecycle: '01010101010101010101010101010101', format: SESSION_FORMAT_VERSION },
    generations: [{ lifecycle: '01010101010101010101010101010101', format: 3, sourceFiles: ['sessions/session.v3.jsonl'] },
      { lifecycle: '01010101010101010101010101010101', format: SESSION_FORMAT_VERSION, sourceFiles: ['sessions/session.v4.jsonl'] }] }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh06-'))
  owned.push(resolve(root))
  const sourceRoot = join(root, 'source'), archives = join(root, 'archives')
  await mkdir(sourceRoot); await mkdir(archives)
  const workspaceId = brandString<WorkspaceId>('workspace-1')
  let logical: LogicalStore = { version: 1, sessions: [session()], workspace: { version: 2,
    global: { initialized: true, defaultWorkspaceId: workspaceId, workspaceIds: [workspaceId], archivedSessionIds: [],
      pinnedSessionIds: [SessionId('unresolved-candidate'), SessionId('session-😀')] },
    records: [{ id: workspaceId, value: { path: '/source', title: '工作区', createdAt: '2026-10-19T00:00:00Z',
      updatedAt: '2026-10-19T00:00:00Z', sessionIds: [SessionId('session-😀'), SessionId('unresolved-candidate')] } }] } }
  const bytes = Buffer.from('retained original\r\n{"v":3}\r\n')
  let files: FrozenSourceFile[] = [{ path: 'sessions/session.v3.jsonl', kind: 'session_log', bytes },
    { path: 'sessions/session.v4.jsonl', kind: 'session_log', bytes: Buffer.from('original v4 complete bytes\r\n') }]
  let reads = 0, valid = true, freezes = 0, releases = 0
  const source: MigrationSource = { freeze: async () => {
    freezes++
    return { sourceRoot, identity: `owned-fence-${freezes}`,
      assertCurrent: async () => { if (!valid) throw new Error('fixture maintenance fence lost') },
      read: async () => { reads++; return structuredClone({ logical, files }) },
      [Symbol.asyncDispose]: async () => { releases++ },
    }
  } }
  return { root, archives, source, bytes, get logical() { return logical }, setLogical: (value: LogicalStore) => { logical = value },
    setFiles: (value: FrozenSourceFile[]) => { files = value }, reads: () => reads, freezes: () => freezes,
    releases: () => releases, invalidate: () => { valid = false } }
}

class ProtocolTarget implements MigrationTarget {
  readonly namespace = 'agent06-protocol-target'
  readonly schemaMode = 'verify' as const
  hash = ''
  staged = new Map<string, LogicalSession>()
  workspace: LogicalWorkspace | undefined
  published: MigrationReceipt | undefined
  appendCalls = 0
  publishCalls = 0
  interruptAt = 0
  loseAppendAck = false
  losePublishAck = false
  async begin(_runId: string, _manifest: ArchiveManifest, hash: string, _expected: string) {
    if (this.hash && this.hash !== hash) throw new Error('different fixture manifest')
    this.hash = hash
  }
  async stageSession(_runId: string, value: LogicalSession) {
    if (!this.staged.has(value.header.id)) this.staged.set(value.header.id, { ...structuredClone(value), events: [] })
    return this.progress(_runId, value.header.id)
  }
  async append(_runId: string, id: SessionId, _batch: string, first: number, events: readonly SessionEvent[], _hash: string) {
    this.appendCalls++
    if (this.interruptAt === this.appendCalls) throw new Error('explicit interrupted protocol fixture')
    const old = this.staged.get(id)
    if (!old || old.events.length !== first) throw new Error('fixture prefix mismatch')
    this.staged.set(id, { ...old, events: [...old.events, ...structuredClone(events)] })
    if (this.loseAppendAck) { this.loseAppendAck = false; throw new MysqlError('transaction_unknown', 'fixture acknowledgement lost', 'unknown') }
  }
  async progress(_run: string, id: SessionId) {
    const events = this.staged.get(id)?.events ?? []
    return { manifestSha256: this.hash, eventCount: events.length, prefixSha256: sha256(JSON.stringify(events)) }
  }
  async stageWorkspace(_run: string, value: LogicalWorkspace) { this.workspace = structuredClone(value) }
  async exportStaging(_run: string): Promise<LogicalStore> {
    if (!this.workspace) throw new Error('fixture workspace absent')
    return { version: 1, sessions: [...this.staged.values()], workspace: this.workspace }
  }
  async publish(runId: string, manifestSha256: string, _expected: string) {
    this.publishCalls++
    this.published = { runId, manifestSha256, namespace: this.namespace, targetRevision: 'committed-1' }
    if (this.losePublishAck) throw new MysqlError('transaction_unknown', 'fixture commit acknowledgement lost', 'unknown')
    return this.published
  }
  async receipt(_run: string) { return this.published }
}

describe('Frozen migration archive, staging and rollback protocol', () => {
  it('requires a real freeze capability before touching an ambient source', async () => {
    await expect(captureArchive(undefined, '/not-read', 'operation', limits)).rejects.toMatchObject({ code: 'FREEZE_UNAVAILABLE' })
  })

  it('retains exact source bytes and generations and verifies a completed archive on resume', async () => {
    const f = await fixture()
    const first = await captureArchive(f.source, f.archives, 'backup', limits)
    expect(await readFile(join(first.directory, 'raw/sessions/session.v3.jsonl'))).toEqual(f.bytes)
    expect(first.logical).toEqual(f.logical)
    const second = await captureArchive(f.source, f.archives, 'backup', limits)
    expect(second.manifestSha256).toBe(first.manifestSha256)
    expect(f.releases()).toBe(2)
    expect(diffLogical(first.logical, second.logical)).toEqual([])
  })

  it('refuses checksum changes and future manifest formats without target writes', async () => {
    const f = await fixture()
    const archive = await captureArchive(f.source, f.archives, 'backup', limits)
    await writeFile(join(archive.directory, 'raw/sessions/session.v3.jsonl'), 'changed')
    await expect(readArchive(archive.directory, limits)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' })
    await writeFile(join(archive.directory, 'manifest.json'), JSON.stringify({ kind: 'dsh-frozen-store', version: 99 }))
    await expect(readArchive(archive.directory, limits)).rejects.toMatchObject({ code: 'FUTURE_FORMAT' })
  })

  it('preserves raw bytes when a lone surrogate cannot be represented by MySQL', async () => {
    const f = await fixture()
    f.setLogical({ ...f.logical, workspace: { ...f.logical.workspace, records: f.logical.workspace.records.map(record =>
      ({ ...record, value: { ...record.value, title: 'unsupported-\ud800' } })) } })
    await expect(captureArchive(f.source, f.archives, 'unsupported', limits)).rejects.toMatchObject({ code: 'UNREPRESENTABLE' })
    expect(await readFile(join(f.archives, 'unsupported/raw/sessions/session.v3.jsonl'))).toEqual(f.bytes)
    await expect(readFile(join(f.archives, 'unsupported/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('compares full event data, projection values, receipts, surface and workspace order', async () => {
    const f = await fixture()
    const value = structuredClone(f.logical.sessions[0]!)
    const changed: LogicalStore = { ...structuredClone(f.logical),
      sessions: [{ ...value, projections: { different: true }, appendReceipts: [], surface: [] }] }
    changed.workspace.global.pinnedSessionIds.reverse()
    expect(diffLogical(f.logical, changed).map(value => value.field)).toEqual(['surface', 'projections', 'appendReceipts', 'workspace'])
  })

  it('resumes an interrupted import from a hashed durable prefix and publishes no partial log', async () => {
    const f = await fixture()
    const archive = await captureArchive(f.source, f.archives, 'backup', limits)
    const target = new ProtocolTarget()
    target.interruptAt = 2
    await expect(importArchive(archive.directory, target, 'import-run', 'empty-1', limits)).rejects.toThrow('interrupted')
    expect(target.published).toBeUndefined()
    expect(target.staged.get('session-😀')?.events).toHaveLength(2)
    target.interruptAt = 0
    const receipt = await importArchive(archive.directory, target, 'import-run', 'empty-1', limits)
    expect(diffLogical(f.logical, await target.exportStaging('import-run'))).toEqual([])
    expect(receipt.manifestSha256).toBe(archive.manifestSha256)
    expect(target.publishCalls).toBe(1)
    expect(JSON.parse(await readFile(join(archive.directory, 'receipts/import-run.json'), 'utf8'))).toEqual(receipt)
  })

  it('reads back lost append/publication acknowledgements without repeating committed batches', async () => {
    const f = await fixture()
    const archive = await captureArchive(f.source, f.archives, 'backup', limits)
    const target = new ProtocolTarget()
    target.loseAppendAck = true; target.losePublishAck = true
    const receipt = await importArchive(archive.directory, target, 'uncertain-run', 'empty-1', limits)
    expect(target.appendCalls).toBe(3)
    expect(target.publishCalls).toBe(1)
    expect(await importArchive(archive.directory, target, 'uncertain-run', 'empty-1', limits)).toEqual(receipt)
    expect(target.appendCalls).toBe(3)
  })

  it('requires explicit MySQL selection and a current source freeze before activation', async () => {
    const f = await fixture()
    const archive = await captureArchive(f.source, f.archives, 'backup', limits)
    const target = new ProtocolTarget()
    const receipt = await importArchive(archive.directory, target, 'activate', 'empty-1', limits)
    const current: ProviderSelection = { provider: 'jsonl', identity: 'original-home' }
    let selected = current
    const control = { current: async () => selected,
      select: async (_expected: ProviderSelection, next: ProviderSelection) => { selected = next },
      reload: async () => target.exportStaging('activate') }
    await expect(activateMysql(control, current, { provider: 'jsonl', identity: target.namespace }, archive.directory, receipt, limits, f.source))
      .rejects.toMatchObject({ code: 'TARGET_CONFLICT' })
    expect(selected).toBe(current)
    await activateMysql(control, current, { provider: 'mysql', identity: target.namespace }, archive.directory, receipt, limits, f.source)
    expect(selected.provider).toBe('mysql')
  })

  it('exports post-switch new sessions before a fresh fallback and holds the source freeze through reload', async () => {
    const f = await fixture()
    const baseline = await captureArchive(f.source, f.archives, 'baseline', limits)
    const added = session('new-after-switch')
    f.setLogical({ ...f.logical, sessions: [...f.logical.sessions, added] })
    const target = new ProtocolTarget()
    const mysql: ProviderSelection = { provider: 'mysql', identity: 'agent06-mysql' }
    const fallback: ProviderSelection = { provider: 'jsonl', identity: target.namespace }
    let selected = mysql
    const selection = { current: async () => selected, select: async (_expected: ProviderSelection, next: ProviderSelection) => {
      expect(target.published).toBeDefined()
      expect(f.releases()).toBe(1)
      selected = next
    }, reload: async () => { expect(f.releases()).toBe(1); return target.exportStaging('rollback') } }
    const result = await rollbackMysql({ source: f.source, archiveParent: f.archives, archiveId: 'rollback-export',
      baselineDirectory: baseline.directory, restoreTarget: target, expectedEmptyRevision: 'fresh-1', runId: 'rollback',
      selection, mysql, fallback, limits })
    expect(selected).toEqual(fallback)
    expect((await readArchive(result.archiveDirectory, limits)).logical.sessions.map(session => session.header.id)).toContain('new-after-switch')
    expect(f.releases()).toBe(2)
    expect(await readFile(join(baseline.directory, 'raw/sessions/session.v3.jsonl'))).toEqual(f.bytes)
  })

  it('stops rollback if the post-switch export lost an original lifecycle', async () => {
    const f = await fixture()
    const baseline = await captureArchive(f.source, f.archives, 'baseline', limits)
    f.setLogical({ ...f.logical, sessions: [] })
    const target = new ProtocolTarget(), mysql: ProviderSelection = { provider: 'mysql', identity: 'owned-mysql' }
    let called = false
    await expect(rollbackMysql({ source: f.source, archiveParent: f.archives, archiveId: 'lost-history', baselineDirectory: baseline.directory,
      restoreTarget: target, expectedEmptyRevision: 'fresh', runId: 'rollback', selection: { current: async () => mysql,
        select: async () => { called = true }, reload: async () => f.logical }, mysql,
      fallback: { provider: 'jsonl', identity: target.namespace }, limits })).rejects.toMatchObject({ code: 'ROLLBACK_REQUIRED' })
    expect(called).toBe(false)
    expect(target.publishCalls).toBe(0)
  })
})
