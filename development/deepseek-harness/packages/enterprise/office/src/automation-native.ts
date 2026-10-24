/** Lifecycle-owned consumer of the original Schedule change subscription; it never creates or modifies a scheduled task. */
import { z } from 'zod'
import { officeMemberId } from './spec.ts'
import { ingestOfficeAutomationSchedule } from './automation-triggers.ts'
import type { OfficeAutomationScheduleReceipt } from './automation-triggers.ts'
import type { OfficeAutomationRepository } from './automation.ts'
import type { OfficeMemberId } from './types.ts'

/** Fixed deployment principal and original native task/session pair, outside all event payloads. */
export interface OfficeAutomationScheduleBinding {
  readonly ownerId: OfficeMemberId
  readonly scheduleId: string
  readonly sessionId: string
}
/** Original Schedule service, current native-session authority and sanitized reporting supplied by the Host. */
export interface OfficeAutomationScheduleSource {
  /** Subscribe to existing schedule/changed and return its real unregister function. */
  subscribe(changed: () => void): () => void
  /** Read actual retained native catalog rows; honor abort and settle before disposal returns. */
  catalog(signal: AbortSignal): Promise<readonly OfficeAutomationScheduleReceipt[]>
  /** Recheck current fixed employee/session ownership; a configured id alone is not permission. */
  authorize(binding: OfficeAutomationScheduleBinding, signal: AbortSignal): Promise<void>
  /** Report a contained source failure without exposing native prompts, customer content or credentials. */
  failed(stage: 'catalog' | 'authorization_or_admission'): void
}

/**
 * Consume real Schedule notifications with one coalesced, drainable read operation and durable occurrence deduplication.
 * @param repository - Existing automation trigger owner, never its execution/approval methods.
 * @param bindings - Private deployment principal/task/session bindings.
 * @param source - Actual native subscription, catalog and current permission providers.
 * @param maxRows - Explicit complete-catalog bound; oversized catalogs stop admission without truncation.
 * @returns Explicit refresh and async disposer; missing receipts create no synthetic occurrences or model-completion claims.
 */
export function bindOfficeAutomationSchedules(repository: Pick<OfficeAutomationRepository, 'trigger'>,
  bindings: readonly OfficeAutomationScheduleBinding[], source: OfficeAutomationScheduleSource, maxRows: number): {
  readonly refresh: () => Promise<void>
  readonly close: () => Promise<void>
} {
  const configured = z.array(z.object({ ownerId: officeMemberId, scheduleId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200) }).strict()).max(10000).parse(bindings)
  z.number().int().min(1).max(100000).parse(maxRows)
  const controller = new AbortController()
  const stopped = () => controller.signal.aborted
  let active: Promise<void> | undefined
  let requested = false
  let disposal: Promise<void> | undefined
  function failed(stage: Parameters<OfficeAutomationScheduleSource['failed']>[0]): void {
    try { source.failed(stage) }
    catch (error) {
      void error
      process.emitWarning('Native automation source reporting failed; inspect the configured source before refreshing.',
        { code: 'OFFICE_AUTOMATION_SOURCE_REPORTING' })
    }
  }
  const refresh = (): Promise<void> => {
    if (stopped()) return Promise.resolve()
    requested = true
    if (active) return active
    active = (async () => {
      while (requested && !stopped()) {
        requested = false
        let catalog: readonly OfficeAutomationScheduleReceipt[]
        try {
          catalog = await source.catalog(controller.signal)
          if (catalog.length > maxRows) throw new Error('Native catalog exceeds configured bound')
        } catch (error) {
          void error
          if (!stopped()) failed('catalog')
          return
        }
        for (const binding of configured) {
          if (stopped()) return
          const receipt = catalog.find(value => value.id === binding.scheduleId && value.sessionId === binding.sessionId)
          if (!receipt) continue
          try {
            await ingestOfficeAutomationSchedule(repository, binding, receipt, async () => {
              controller.signal.throwIfAborted()
              await source.authorize(binding, controller.signal)
              controller.signal.throwIfAborted()
            })
          } catch (error) {
            void error
            if (!stopped()) failed('authorization_or_admission')
          }
        }
      }
    })().finally(() => { active = undefined })
    return active
  }
  const unsubscribe = source.subscribe(() => { void refresh() })
  return { refresh, close() {
    disposal ??= (async () => {
      try { unsubscribe() }
      finally { controller.abort(); await active }
    })()
    return disposal
  } }
}
