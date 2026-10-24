/** Original settlement accounting preserves last provider usage and excludes inherited/conflicting attribution. */
import { expect, it } from 'vitest'
import type { SessionEvent, SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeNativeUsageObservation } from '../src/native-usage.ts'
const session = { id: 'native-usage-fixture' as SessionId, inheritedEventCount: 0 as SessionLogOffset }
const history = { owner: { memberId: 'employee' as OfficeMemberId, role: 'employee' as const }, mixed: false, invalid: false }
const event: SessionEvent<'assistant/attempt'> = { type: 'assistant/attempt', seq: 7 as SessionSeq, time: 1000,
  data: { turn: 0, step: 0, stream: [
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } } },
    { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 20 } } },
  ] } }
it('captures the final original attempt counters without summing incremental usage chunks or inventing costs', () => {
  expect(officeNativeUsageObservation(session, event, history)).toMatchObject({ sessionId: session.id, seq: 7, memberId: history.owner.memberId,
    kind: 'attempt', usage: { inputTokens: 9, outputTokens: 4, cacheReadTokens: 20 }, inherited: false })
  expect(officeNativeUsageObservation(session, { ...event, data: { ...event.data, stream: [] } }, history)?.usage).toBeNull()
})
it('omits inherited or conflicting employee settlements rather than attributing tokens to another employee', () => {
  expect(officeNativeUsageObservation({ ...session, inheritedEventCount: 8 as SessionLogOffset }, event, history)).toBeNull()
  expect(officeNativeUsageObservation(session, event, { ...history, mixed: true })).toBeNull()
  expect(officeNativeUsageObservation(session, event, { ...history, invalid: true })).toBeNull()
})
