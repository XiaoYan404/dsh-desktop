/** Optional asynchronous checkpoint provider; default cache storage remains the existing Domain. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { CheckpointRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { sessionProjectionCheckpointBackend: SessionProjectionCheckpointBackend }
}

/** A provider owns its complete durable observation, lifecycle witness, CAS and queue drain. */
export abstract class SessionProjectionCheckpointBackend extends Service {
  constructor(ctx: Context) { super(ctx, 'sessionProjectionCheckpointBackend') }
  /** A synchronous listing/hydration hint; absence always causes canonical replay.
   * @param id - Exact Session slot.
   * @param header - Authoritative native identity; providers may refuse when it does not witness their lifecycle UUID.
   * @returns A validated checkpoint or an uncached miss, never an asynchronous observation.
   */
  abstract get(id: SessionId, header: SessionHeader): CheckpointRecord | undefined
  /** Fold only a complete committed provider observation and publish its full checkpoint after SQL ACK.
   * @param session - Live or detaching Session; unpublished repair events must not enter a durable checkpoint.
   * @returns The acknowledged checkpoint. Rejection may leave the provider frozen until reopen.
   */
  abstract write(session: Session): Promise<CheckpointRecord>
}
