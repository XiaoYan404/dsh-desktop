/** Resumable staging coordinator; a durable receipt resolves every unknown write before repetition. */
import { MysqlError } from '@deepseek-ai/dsh-mysql'
import { readArchive, retainReceipt } from './archive.ts'
import { MigrationError } from './error.ts'
import { diffLogical, sha256, validateLogical } from './logical.ts'
import type { ImportProgress, LogicalSession, MigrationLimits, MigrationReceipt, MigrationTarget, VerifiedArchive } from './types.ts'

/**
 * Import into an explicit empty, independently provisioned namespace and publish only after full equality.
 * @param directory - Immutable frozen archive, revalidated before and after target staging.
 * @param target - Formally wired provider maintenance capability, never a remote/model callback.
 * @param runId - Stable identity reused after interruption or an uncertain write.
 * @param expectedEmptyRevision - Operator-reviewed initial target CAS; existing data is never overwritten.
 * @param limits - Full-value and append-batch budgets.
 * @param signal - Cancellation between durable operations; retained progress remains resumable.
 * @returns Confirmed durable publication receipt, also retained beside the source archive.
 */
export async function importArchive(directory: string, target: MigrationTarget | undefined, runId: string,
  expectedEmptyRevision: string, limits: MigrationLimits, signal?: AbortSignal): Promise<MigrationReceipt> {
  signal?.throwIfAborted()
  if (!target) throw new MigrationError('FREEZE_UNAVAILABLE')
  if (!target.namespace || !/^[A-Za-z0-9_-]{1,128}$/u.test(runId)
    || !expectedEmptyRevision || !Number.isSafeInteger(limits.batchEvents) || limits.batchEvents < 1) throw new MigrationError('TARGET_CONFLICT')
  const archive = await readArchive(directory, limits, signal)
  signal?.throwIfAborted()
  const existing = await target.receipt(runId)
  if (existing !== undefined) {
    assertReceipt(existing, archive, runId, target.namespace)
    await retainReceipt(directory, runId, existing)
    return existing
  }
  await target.begin(runId, archive.manifest, archive.manifestSha256, expectedEmptyRevision)
  for (const session of archive.logical.sessions) {
    signal?.throwIfAborted()
    const progress = await target.stageSession(runId, session)
    assertProgress(progress, archive, session)
    let offset = progress.eventCount
    while (offset < session.events.length) {
      signal?.throwIfAborted()
      const batch = session.events.slice(offset, offset + limits.batchEvents)
      const hash = sha256(JSON.stringify(batch))
      const batchId = sha256(JSON.stringify([runId, archive.manifestSha256, session.header.id, offset, hash]))
      try { await target.append(runId, session.header.id, batchId, offset, batch, hash) }
      catch (error) {
        if (!(error instanceof MysqlError) || error.outcome !== 'unknown') throw error
        const durable = await target.progress(runId, session.header.id)
        assertProgress(durable, archive, session)
        if (durable.eventCount !== offset + batch.length) throw new MigrationError('IMPORT_UNKNOWN', { cause: error })
      }
      const durable = await target.progress(runId, session.header.id)
      assertProgress(durable, archive, session)
      if (durable.eventCount !== offset + batch.length) throw new MigrationError('TARGET_CONFLICT')
      offset = durable.eventCount
    }
  }
  signal?.throwIfAborted()
  await target.stageWorkspace(runId, archive.logical.workspace)
  const staged = await target.exportStaging(runId)
  validateLogical(staged, limits)
  if (diffLogical(archive.logical, staged).length !== 0) throw new MigrationError('DIFFERENCE')
  const rechecked = await readArchive(directory, limits, signal)
  if (rechecked.manifestSha256 !== archive.manifestSha256) throw new MigrationError('SOURCE_CHANGED')
  signal?.throwIfAborted()
  let receipt: MigrationReceipt
  try { receipt = await target.publish(runId, archive.manifestSha256, expectedEmptyRevision) }
  catch (error) {
    if (!(error instanceof MysqlError) || error.outcome !== 'unknown') throw error
    const confirmed = await target.receipt(runId)
    if (confirmed === undefined) throw new MigrationError('IMPORT_UNKNOWN', { cause: error })
    receipt = confirmed
  }
  assertReceipt(receipt, archive, runId, target.namespace)
  await retainReceipt(directory, runId, receipt)
  return receipt
}

function assertProgress(progress: ImportProgress, archive: VerifiedArchive, session: LogicalSession): void {
  if (progress.manifestSha256 !== archive.manifestSha256 || !Number.isSafeInteger(progress.eventCount)
    || progress.eventCount < 0 || progress.eventCount > session.events.length
    || progress.prefixSha256 !== sha256(JSON.stringify(session.events.slice(0, progress.eventCount)))) throw new MigrationError('TARGET_CONFLICT')
}

function assertReceipt(receipt: MigrationReceipt, archive: VerifiedArchive, runId: string, namespace: string): void {
  if (receipt.runId !== runId || receipt.manifestSha256 !== archive.manifestSha256 || receipt.namespace !== namespace
    || !receipt.targetRevision) throw new MigrationError('TARGET_CONFLICT')
}
