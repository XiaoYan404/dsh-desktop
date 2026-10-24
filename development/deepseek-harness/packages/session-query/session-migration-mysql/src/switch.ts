/** Explicit provider selection requires verified migration receipts; rollback first preserves post-switch writes. */
import { isDeepStrictEqual } from 'node:util'
import { captureArchive, readArchive, retainReceipt } from './archive.ts'
import { importArchive } from './import.ts'
import { MigrationError } from './error.ts'
import { diffLogical } from './logical.ts'
import type { LogicalStore, MigrationLimits, MigrationReceipt, MigrationSource, MigrationTarget, ProviderSelection } from './types.ts'

/** Integration-owned activation capability; source and target stay drained until verification finishes. */
export interface SelectionControl {
  /** Current explicit profile selection; no home scan or automatic migration. */
  current(): Promise<ProviderSelection>
  /** Compare-and-swap the reviewed selection; release no writers before reload verification. */
  select(expected: ProviderSelection, next: ProviderSelection, receipt: MigrationReceipt): Promise<void>
  /** Read ordinary provider data after a fresh load, while the integration maintenance fence remains held. */
  reload(): Promise<LogicalStore>
}

/**
 * Activate an explicitly requested MySQL composition after validating the complete imported store.
 * @param selection - Integration-owned provider CAS and fresh-load reader.
 * @param expected - Explicit original selection.
 * @param mysql - Reviewed MySQL provider/namespace selection.
 * @param archiveDirectory - Preserved frozen source archive.
 * @param receipt - Confirmed staging-publication receipt for that archive.
 * @param limits - Archive validation budgets.
 * @param source - Provider-owned maintenance fence over the selected original store.
 * @param signal - Cancellation before selection; a committed selection still completes verification and its receipt.
 */
export async function activateMysql(selection: SelectionControl, expected: ProviderSelection, mysql: ProviderSelection,
  archiveDirectory: string, receipt: MigrationReceipt, limits: MigrationLimits, source: MigrationSource | undefined,
  signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!source) throw new MigrationError('FREEZE_UNAVAILABLE')
  await using freeze = await source.freeze(signal)
  await freeze.assertCurrent(signal)
  const archive = await readArchive(archiveDirectory, limits, signal)
  if (mysql.provider !== 'mysql' || mysql.identity !== receipt.namespace || receipt.manifestSha256 !== archive.manifestSha256
    || !receipt.targetRevision || !isDeepStrictEqual(await selection.current(), expected)) throw new MigrationError('TARGET_CONFLICT')
  const frozen = await freeze.read(signal)
  signal?.throwIfAborted()
  if (diffLogical(archive.logical, frozen.logical).length !== 0) throw new MigrationError('SOURCE_CHANGED')
  await retainReceipt(archiveDirectory, receipt.runId + '-switch-prepared', { expected, mysql, receipt })
  await freeze.assertCurrent(signal)
  signal?.throwIfAborted()
  await selection.select(expected, mysql, receipt)
  if (diffLogical(archive.logical, await selection.reload()).length !== 0) throw new MigrationError('DIFFERENCE')
  await freeze.assertCurrent()
  await retainReceipt(archiveDirectory, receipt.runId + '-switch-completed', { expected, mysql, receipt })
}

/**
 * Preserve all post-switch data before returning to an explicitly selected fresh file target.
 * @param options - Frozen MySQL source, immutable baseline, fresh restore target and integration CAS.
 * @returns Both export identity and confirmed restore receipt; originals and MySQL data remain retained.
 */
export async function rollbackMysql(options: {
  source: MigrationSource | undefined
  archiveParent: string
  archiveId: string
  baselineDirectory: string
  restoreTarget: MigrationTarget | undefined
  expectedEmptyRevision: string
  runId: string
  selection: SelectionControl
  mysql: ProviderSelection
  fallback: ProviderSelection
  limits: MigrationLimits
  signal?: AbortSignal
}): Promise<{ archiveDirectory: string; receipt: MigrationReceipt }> {
  options.signal?.throwIfAborted()
  if (options.mysql.provider !== 'mysql' || options.fallback.provider === 'mysql'
    || options.mysql.identity === options.fallback.identity
    || !isDeepStrictEqual(await options.selection.current(), options.mysql)) throw new MigrationError('TARGET_CONFLICT')
  if (!options.source) throw new MigrationError('FREEZE_UNAVAILABLE')
  await using freeze = await options.source.freeze(options.signal)
  await freeze.assertCurrent(options.signal)
  const borrowed: MigrationSource = { freeze: () => Promise.resolve({ sourceRoot: freeze.sourceRoot, identity: freeze.identity,
    read: signal => freeze.read(signal), assertCurrent: signal => freeze.assertCurrent(signal),
    [Symbol.asyncDispose]: async () => {} }) }
  const baseline = await readArchive(options.baselineDirectory, options.limits, options.signal)
  const archive = await captureArchive(borrowed, options.archiveParent, options.archiveId, options.limits, options.signal)
  assertRetainedHistory(baseline.logical, archive.logical)
  const receipt = await importArchive(archive.directory, options.restoreTarget, options.runId,
    options.expectedEmptyRevision, options.limits, options.signal)
  if (receipt.namespace !== options.fallback.identity) throw new MigrationError('TARGET_CONFLICT')
  await retainReceipt(archive.directory, options.runId + '-rollback-prepared', { mysql: options.mysql, fallback: options.fallback,
    baselineManifestSha256: baseline.manifestSha256, exportManifestSha256: archive.manifestSha256, receipt })
  options.signal?.throwIfAborted()
  await freeze.assertCurrent(options.signal)
  if (diffLogical(archive.logical, (await freeze.read(options.signal)).logical).length !== 0) {
    throw new MigrationError('SOURCE_CHANGED')
  }
  if (!isDeepStrictEqual(await options.selection.current(), options.mysql)) throw new MigrationError('TARGET_CONFLICT')
  await options.selection.select(options.mysql, options.fallback, receipt)
  if (diffLogical(archive.logical, await options.selection.reload()).length !== 0) throw new MigrationError('DIFFERENCE')
  await freeze.assertCurrent()
  await retainReceipt(archive.directory, options.runId + '-rollback-completed', { receipt })
  return { archiveDirectory: archive.directory, receipt }
}

function assertRetainedHistory(baseline: LogicalStore, current: LogicalStore): void {
  for (const session of baseline.sessions) {
    const restored = current.sessions.find(candidate =>
      candidate.header.id === session.header.id && candidate.lifecycle === session.lifecycle)
    if (!restored || !isDeepStrictEqual(session.header, restored.header)
      || !isDeepStrictEqual(session.events, restored.events.slice(0, session.events.length))) throw new MigrationError('ROLLBACK_REQUIRED')
    for (const generation of session.generations) if (!restored.generations.some(candidate => isDeepStrictEqual(candidate, generation))) {
      throw new MigrationError('ROLLBACK_REQUIRED')
    }
    for (const receipt of session.appendReceipts) if (!restored.appendReceipts.some(candidate => isDeepStrictEqual(candidate, receipt))) {
      throw new MigrationError('ROLLBACK_REQUIRED')
    }
  }
}
