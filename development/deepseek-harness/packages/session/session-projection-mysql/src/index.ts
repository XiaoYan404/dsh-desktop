/** Opt-in MySQL checkpoint provider. Select checkpointBackend: provider in the cache owner. */
import z from '@deepseek-ai/schemastery'
import type { ProjectionAdapterConfig } from './model.ts'
export { MysqlProjectionCheckpointBackend as default } from './backend.ts'
export { createProjectionMysqlAdapter, MysqlProjectionAdapter } from './adapter.ts'
export { ProjectionAdapterError } from './model.ts'
export type { ProjectionAdapterConfig, ProjectionObservation } from './model.ts'
/** Explicit bounded SQL observation and checkpoint policy. */
export const Config: z<ProjectionAdapterConfig> = z.object({
  storeKey: z.string().required(), maxEvents: z.natural().min(1).required(), maxInputBytes: z.natural().min(1).required(),
  maxCheckpointBytes: z.natural().min(1).required(), maxUnits: z.natural().min(1).max(4294967295).required(),
  readPageSize: z.natural().min(1).required(), maxPendingOperations: z.natural().min(1).required(),
})
