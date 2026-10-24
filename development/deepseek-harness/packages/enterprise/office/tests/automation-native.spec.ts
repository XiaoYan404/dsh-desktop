/** Native-source adapter tests inspect subscription and disposal; fixtures do not claim a real customer source or model completion. */
import { expect, it, vi } from 'vitest'
import { bindOfficeAutomationSchedules } from '../src/automation-native.ts'
import type { OfficeAutomationScheduleSource } from '../src/automation-native.ts'
import type { OfficeAutomationScheduleReceipt } from '../src/automation-triggers.ts'
import type { OfficeAutomationRepository } from '../src/automation.ts'
import { lin } from './fixtures/connector-03.ts'

const binding = { ownerId: lin, scheduleId: 'schedule-native', sessionId: 'native-session' }
const receipt: OfficeAutomationScheduleReceipt = { id: binding.scheduleId, sessionId: binding.sessionId,
  lastDelivery: { scheduledAt: '2026-10-19T00:00:00.000Z', deliveredAt: '2026-10-19T00:00:01.000Z', messageId: 'native-inbox-message' } }

it('consumes only existing bound Schedule receipts and delegates permission checks without creating a timer', async () => {
  const trigger = vi.fn<OfficeAutomationRepository['trigger']>().mockResolvedValue([])
  let changed: (() => void) | undefined
  const remove = vi.fn()
  const source: OfficeAutomationScheduleSource = { subscribe(listener) { changed = listener; return remove },
    catalog: vi.fn(async () => [receipt]), authorize: vi.fn(async () => {}), failed: vi.fn() }
  const owner = bindOfficeAutomationSchedules({ trigger }, [binding], source, 10)
  await owner.refresh()
  expect(trigger.mock.calls[0]?.[0]).toBe(lin)
  expect(trigger.mock.calls[0]?.[1]).toMatchObject({ kind: 'schedule', source: binding.scheduleId })
  expect(trigger.mock.calls[0]?.[1].occurrence).toMatch(/^[a-f0-9]{64}$/)
  changed?.()
  await owner.refresh()
  expect(trigger.mock.calls[1]?.[1].occurrence).toBe(trigger.mock.calls[0]?.[1].occurrence)
  await owner.close()
  await owner.close()
  expect(remove).toHaveBeenCalledTimes(1)
})

it('unsubscribes, aborts and drains a pending catalog read before close returns, without publishing a late trigger', async () => {
  const trigger = vi.fn<OfficeAutomationRepository['trigger']>().mockResolvedValue([])
  const pending = Promise.withResolvers<readonly OfficeAutomationScheduleReceipt[]>()
  const signals: AbortSignal[] = []
  const removed = vi.fn()
  const owner = bindOfficeAutomationSchedules({ trigger }, [binding], { subscribe: () => removed,
    catalog(signal) { signals.push(signal); return pending.promise }, authorize: vi.fn(async () => {}), failed: vi.fn() }, 10)
  const reading = owner.refresh()
  let closed = false
  const closing = owner.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(signals[0]?.aborted).toBe(true)
  pending.resolve([receipt])
  await Promise.all([reading, closing])
  expect(closed).toBe(true)
  expect(trigger).not.toHaveBeenCalled()
  expect(removed).toHaveBeenCalledOnce()
})
