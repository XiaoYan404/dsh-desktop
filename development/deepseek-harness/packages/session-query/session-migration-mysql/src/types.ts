/** Explicit maintenance capabilities and complete logical data for opt-in migration. */
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEventRecord } from '@deepseek-ai/dsh-session-query'
import type { SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import type { WorkspaceDomainState, WorkspaceRecord } from '@deepseek-ai/dsh-workspace'

/** A retained generation's immutable source reference; no historical file is overwritten. */
export interface RetainedGeneration {
  readonly lifecycle: string
  readonly format: number
  readonly sourceFiles: readonly string[]
}

/** Complete native logical export, including operational receipts and projection identity. */
export interface LogicalSession {
  readonly header: SessionHeader
  readonly lifecycle: string
  readonly logRevision: string
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
  readonly surface: readonly SessionEventRecord[]
  readonly projections: SessionFormatJsonValue
  readonly appendReceipts: readonly SessionFormatJsonValue[]
  readonly generations: readonly RetainedGeneration[]
  readonly selectedGeneration: { readonly lifecycle: string; readonly format: number }
}

/** Registry order, stale candidate ids, archive order and pins are authoritative export data. */
export interface LogicalWorkspace {
  readonly version: 2
  readonly global: WorkspaceDomainState
  readonly records: readonly { readonly id: string; readonly value: WorkspaceRecord }[]
}

/** Current selection and every retained generation's source are exported under one freeze. */
export interface LogicalStore {
  readonly version: 1
  readonly sessions: readonly LogicalSession[]
  readonly workspace: LogicalWorkspace
}

/** Source-only bytes exclude secrets and unrelated homes; ids remain in the complete logical export. */
export interface FrozenSourceFile {
  readonly path: string
  readonly kind: 'session_log' | 'workspace' | 'projection' | 'receipt'
  readonly bytes: Uint8Array
}

/** Cross-Host exclusive maintenance ownership, held until the operation's final verification. */
export interface FrozenStoreLease extends AsyncDisposable {
  readonly sourceRoot: string
  readonly identity: string
  /** Export native data, original bytes and every selected/retained generation under this fence. */
  read(signal?: AbortSignal): Promise<{ readonly logical: LogicalStore; readonly files: readonly FrozenSourceFile[] }>
  /** Reject if any writer, workspace/projection producer or newer maintenance owner invalidated this fence. */
  assertCurrent(signal?: AbortSignal): Promise<void>
}

/** The owning provider must drain and fence all producers; flush alone cannot implement this capability. */
export interface MigrationSource {
  freeze(signal?: AbortSignal): Promise<FrozenStoreLease>
}

/** Immutable inventory entry over the exact bytes preserved in the archive. */
export interface ArchiveFile {
  readonly path: string
  readonly kind: FrozenSourceFile['kind']
  readonly bytes: number
  readonly sha256: string
}

/** Published last after logical validation, source verification and every byte checksum. */
export interface ArchiveManifest {
  readonly kind: 'dsh-frozen-store'
  readonly version: 1
  readonly archiveId: string
  readonly freezeIdentity: string
  readonly logicalSha256: string
  readonly identitySha256: string
  readonly files: readonly ArchiveFile[]
}

/** The directory and hash identify one immutable archive, never an ambient home. */
export interface VerifiedArchive {
  readonly directory: string
  readonly manifest: ArchiveManifest
  readonly manifestSha256: string
  readonly logical: LogicalStore
}

/** Explicit limits reject complete oversized items; no event, id or body is truncated. */
export interface MigrationLimits {
  readonly maxArchiveBytes: number
  readonly maxFileBytes: number
  readonly maxSessionBytes: number
  readonly batchEvents: number
}

/** A durable item progress receipt must describe the same manifest and exact imported prefix. */
export interface ImportProgress {
  readonly manifestSha256: string
  readonly eventCount: number
  readonly prefixSha256: string
}

/** Publish receipts are immutable and survive retries and later provider selection. */
export interface MigrationReceipt {
  readonly runId: string
  readonly manifestSha256: string
  readonly namespace: string
  readonly targetRevision: string
}

/**
 * Provider-owned durable staging. All writes require its maintenance fence, a verify-only schema
 * and an independently provisioned empty target; no staging current pointer is query-visible.
 */
export interface MigrationTarget {
  readonly namespace: string
  readonly schemaMode: 'verify'
  /** Reserve/resume one immutable manifest and the target's initial empty revision. */
  begin(runId: string, manifest: ArchiveManifest, manifestSha256: string, expectedEmptyRevision: string): Promise<void>
  /** Store full header, lineage, generations, source inventory, projections and receipts without publishing. */
  stageSession(runId: string, session: LogicalSession): Promise<ImportProgress>
  /** Insert one immutable batch and its progress/receipt atomically; reuse batchId after uncertainty. */
  append(runId: string, id: SessionId, batchId: string, firstSeq: number, events: readonly SessionEvent[], sha256: string): Promise<void>
  /** Read the durable prefix before retrying; eventCount and prefixSha256 must both match. */
  progress(runId: string, id: SessionId): Promise<ImportProgress>
  /** Atomically stage the complete workspace, including unresolved candidate ids. */
  stageWorkspace(runId: string, workspace: LogicalWorkspace): Promise<void>
  /** Export staging through the same codecs/readers used after publication. */
  exportStaging(runId: string): Promise<LogicalStore>
  /** Atomically publish after manifest, empty-target CAS and maintenance-fence verification. */
  publish(runId: string, manifestSha256: string, expectedEmptyRevision: string): Promise<MigrationReceipt>
  /** Resolve unknown COMMIT without redoing publication or accepting a different manifest. */
  receipt(runId: string): Promise<MigrationReceipt | undefined>
}

/** Only the integration owner changes the explicitly selected profile/provider. */
export interface ProviderSelection {
  readonly provider: 'jsonl' | 'sqlite' | 'mysql'
  readonly identity: string
}
