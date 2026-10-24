/** MySQL provider for mandatory checkpoint writes; cache values are folded from its own validated source observation. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionProjectionCheckpointBackend } from '@deepseek-ai/dsh-session-projection-cache'
import type { CheckpointRecord } from '@deepseek-ai/dsh-session-projection-cache'
import { createProjectionMysqlAdapter } from './adapter.ts'
import type { MysqlProjectionAdapter } from './adapter.ts'
import { captureRecord, identityOf, ProjectionAdapterError } from './model.ts'
import type { ProjectionAdapterConfig } from './model.ts'
import { requireMysqlProjectionPersistence } from './persistence.ts'

/** Explicit namespace and limits; no default storage route is selected here. */
export const Config: z<ProjectionAdapterConfig> = z.object({ storeKey: z.string().required(),
  maxEvents: z.natural().min(1).required(), maxInputBytes: z.natural().min(1).required(),
  maxCheckpointBytes: z.natural().min(1).required(), maxUnits: z.natural().min(1).max(4294967295).required(),
  readPageSize: z.natural().min(1).required(), maxPendingOperations: z.natural().min(1).required() })

/** The optional cache transport replays durable cuts and never interprets a public revision as a database lifecycle. */
export class MysqlProjectionCheckpointBackend extends SessionProjectionCheckpointBackend {
  static inject = ['mysql', 'sessionProjections', 'sessionPersistence']
  static Config = Config
  private adapter: MysqlProjectionAdapter | undefined
  private persistence: ReturnType<typeof requireMysqlProjectionPersistence> | undefined
  private accepting = true
  private pending = 0
  private tail: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined

  constructor(ctx: Context, readonly config: ProjectionAdapterConfig) { super(ctx) }

  protected async [Service.init](): Promise<void> {
    this.persistence = requireMysqlProjectionPersistence(this.ctx.sessionPersistence, this.config.storeKey)
    this.adapter = await createProjectionMysqlAdapter(this.ctx, this.ctx.mysql, this.config, () => this.drain())
    this.ctx.effect(() => () => this.drain(), 'mysql.projection.producer')
  }

  get(_id: SessionId, _header: SessionHeader): CheckpointRecord | undefined {
    // A bare SessionHeader does not witness MySQL's lifecycle UUID. Synchronous readers safely replay instead.
    return undefined
  }

  write(session: Session): Promise<CheckpointRecord> {
    if (!this.accepting) return Promise.reject(new ProjectionAdapterError('closed'))
    if (this.pending >= this.config.maxPendingOperations) return Promise.reject(new ProjectionAdapterError('capacity'))
    this.pending++
    const operation = this.tail.then(async () => {
      const adapter = this.adapter
      const persistence = this.persistence
      if (!adapter || !persistence) throw new ProjectionAdapterError('closed')
      // Includes the detached creator's last accepted native events; an unknown Session flush aborts cache writing.
      await persistence.flush()
      const observed = await adapter.observe(session.id)
      if (observed.header.createdAt !== session.header.createdAt || observed.header.cwd !== session.header.cwd
        || observed.header.isSeeded !== session.header.isSeeded
        || observed.inheritedEventCount !== session.inheritedEventCount) throw new ProjectionAdapterError('identity-mismatch')
      const restored = this.ctx.sessionProjections.restore(observed.checkpoint?.rows ?? {}, observed.events,
        SessionLogOffset(0), observed.header, observed.inheritedEventCount)
      const source = { header: observed.header, version: observed.header.version,
        inheritedEventCount: observed.inheritedEventCount, eventCount: observed.eventCount }
      const record = captureRecord({ identity: identityOf(source), rows: restored.checkpoint }, source, this.config)
      await adapter.replace(observed, record)
      return record
    })
    this.tail = operation.then(() => { this.pending-- }, (_error: unknown) => { this.pending-- })
    return operation
  }

  private drain(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.accepting = false
    this.closeTask = this.tail
    return this.closeTask
  }
}
