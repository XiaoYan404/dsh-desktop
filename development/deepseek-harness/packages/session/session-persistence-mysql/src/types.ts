/** Provider-local database identities and immutable append preparations. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** An exact MySQL store key, kept out of JavaScript number arithmetic. */
export type StoreId = Branded<'MysqlSessionStoreId'>
/** An exact MySQL session-slot key. */
export type SlotId = Branded<'MysqlSessionSlotId'>
/** A handle stays bound to one generation even when its external id is reused. */
export interface LogIdentity {
  readonly id: SessionId
  readonly storeId: StoreId
  readonly slotId: SlotId
  readonly lifecycle: Buffer
  readonly version: number
}
/** Committed log metadata; counters are admitted as safe business integers. */
export interface StoredLog extends LogIdentity {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly eventCount: number
  readonly revision: string
}
/** A lease's fence remains exact and is never reset on release. */
export interface WriterIdentity extends LogIdentity {
  readonly owner: Buffer
  readonly fence: string
}
/** The same nonempty batch preparation survives every uncertain attempt. */
export interface FrozenBatch {
  readonly batchId: Buffer
  readonly events: readonly SessionEvent[]
  readonly eventTexts: readonly string[]
  readonly sha256: Buffer
  readonly firstSeq: number
}
/** A verified append receipt advances the local cursor only after acknowledgement. */
export interface AppendReceipt {
  readonly eventCount: number
  readonly revision: string
}
/** Pending creators have no published log until an append or valid empty flush. */
export interface CreatedWriter {
  readonly writer: WriterIdentity
  readonly parentSlot: SlotId | null
}
