/** Selection protocol cancellation over real retained archives; no profile, database or original home is switched. */
import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureArchive } from '../src/archive.ts'
import { activateMysql, rollbackMysql } from '../src/switch.ts'
import type { SelectionControl } from '../src/switch.ts'
import type { LogicalStore, MigrationReceipt, MigrationSource, ProviderSelection } from '../src/types.ts'
import { archiveLimits, frozenArchiveFixture } from './fixtures/frozen-archive.ts'

const mysql: ProviderSelection = { provider: 'mysql', identity: 'independent-target' }
const original: ProviderSelection = { provider: 'jsonl', identity: 'original-provider' }

function control(logical: LogicalStore) {
  return { current: vi.fn(async () => original), select: vi.fn(async () => {}),
    reload: vi.fn(async () => structuredClone(logical)) } satisfies SelectionControl
}

it('does not read selection or freeze a source after activation was cancelled in the GUI', async () => {
  await using f = await frozenArchiveFixture()
  const selection = control(f.logical)
  const controller = new AbortController(), reason = new Error('Activation cancelled')
  controller.abort(reason)
  const freeze = vi.spyOn(f.source, 'freeze')
  await expect(activateMysql(selection, original, mysql, 'unused-archive',
    { runId: 'unused', manifestSha256: 'unused', namespace: mysql.identity, targetRevision: 'unused' },
    archiveLimits, f.source, controller.signal)).rejects.toBe(reason)
  expect(selection.current).not.toHaveBeenCalled()
  expect(freeze).not.toHaveBeenCalled()
})

it('cancels during frozen source comparison before selecting or reloading any provider', async () => {
  await using f = await frozenArchiveFixture()
  const archive = await captureArchive(f.source, f.parent, 'baseline', archiveLimits)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const source: MigrationSource = { freeze: async () => {
    const lease = await f.source.freeze()
    return { sourceRoot: lease.sourceRoot, identity: lease.identity,
      assertCurrent: signal => lease.assertCurrent(signal),
      read: async () => { entered.resolve(undefined); await release.promise; return lease.read() },
      [Symbol.asyncDispose]: () => lease[Symbol.asyncDispose]() }
  } }
  const selection = control(f.logical)
  const receipt: MigrationReceipt = { runId: 'cancel-run', manifestSha256: archive.manifestSha256,
    namespace: mysql.identity, targetRevision: 'published-target' }
  const controller = new AbortController(), reason = new Error('Cancelled while comparing source')
  const pending = activateMysql(selection, original, mysql, archive.directory, receipt, archiveLimits, source, controller.signal)
  const settled = expect(pending).rejects.toBe(reason)
  await entered.promise
  controller.abort(reason)
  release.resolve(undefined)
  await settled
  expect(selection.select).not.toHaveBeenCalled()
  expect(selection.reload).not.toHaveBeenCalled()
  expect(f.held).toBe(false)
})

it('finishes verification and retains its receipt when cancellation follows committed provider selection', async () => {
  await using f = await frozenArchiveFixture()
  const archive = await captureArchive(f.source, f.parent, 'baseline', archiveLimits)
  const controller = new AbortController()
  const selection = control(f.logical)
  selection.select = vi.fn(async () => { expect(f.held).toBe(true); controller.abort() })
  const receipt: MigrationReceipt = { runId: 'committed-run', manifestSha256: archive.manifestSha256,
    namespace: mysql.identity, targetRevision: 'published-target' }
  await activateMysql(selection, original, mysql, archive.directory, receipt, archiveLimits, f.source, controller.signal)
  expect(selection.reload).toHaveBeenCalledOnce()
  expect(f.held).toBe(false)
  expect(JSON.parse(await readFile(join(archive.directory, 'receipts', 'committed-run-switch-completed.json'), 'utf8')))
    .toEqual({ expected: original, mysql, receipt })
})

it('does not start post-switch export or inspect selection for a cancelled rollback', async () => {
  await using f = await frozenArchiveFixture()
  const selection = control(f.logical)
  const controller = new AbortController(), reason = new Error('Rollback cancelled')
  controller.abort(reason)
  const freeze = vi.spyOn(f.source, 'freeze')
  await expect(rollbackMysql({ source: f.source, archiveParent: f.parent, archiveId: 'unused', baselineDirectory: 'unused',
    restoreTarget: undefined, expectedEmptyRevision: 'unused', runId: 'unused', selection, mysql, fallback: original,
    limits: archiveLimits, signal: controller.signal })).rejects.toBe(reason)
  expect(selection.current).not.toHaveBeenCalled()
  expect(freeze).not.toHaveBeenCalled()
})
