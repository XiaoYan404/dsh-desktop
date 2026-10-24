/** GUI cancellation must stop before provider work or archive I/O; no database is used. */
import { expect, it, vi } from 'vitest'
import { captureArchive, readArchive } from '../src/archive.ts'
import { importArchive } from '../src/import.ts'
import type { MigrationLimits, MigrationSource, MigrationTarget } from '../src/types.ts'

const limits: MigrationLimits = { maxArchiveBytes: 100000, maxFileBytes: 20000, maxSessionBytes: 20000, batchEvents: 2 }

function cancelled() {
  const controller = new AbortController()
  const reason = new Error('GUI operation cancelled')
  controller.abort(reason)
  return { signal: controller.signal, reason }
}

it('honors cancelled archive inspection before touching a missing input path', async () => {
  const { signal, reason } = cancelled()
  await expect(readArchive('not-an-existing-archive', limits, signal)).rejects.toBe(reason)
})

it('does not acquire maintenance ownership for an already cancelled export', async () => {
  const { signal, reason } = cancelled()
  const freeze = vi.fn(async (): Promise<never> => { throw new Error('Unexpected maintenance acquisition') })
  const source: MigrationSource = { freeze }
  await expect(captureArchive(source, 'unused-parent', 'cancelled', limits, signal)).rejects.toBe(reason)
  expect(freeze).not.toHaveBeenCalled()
})

it('does not inspect receipts or start staging for an already cancelled GUI import', async () => {
  const { signal, reason } = cancelled()
  const work = vi.fn(async (): Promise<never> => { throw new Error('Unexpected target access') })
  const target: MigrationTarget = { namespace: 'independent-target', schemaMode: 'verify',
    begin: work, stageSession: work, append: work, progress: work, stageWorkspace: work,
    exportStaging: work, publish: work, receipt: work }
  await expect(importArchive('unused-archive', target, 'cancelled', 'empty-revision', limits, signal)).rejects.toBe(reason)
  expect(work).not.toHaveBeenCalled()
})
