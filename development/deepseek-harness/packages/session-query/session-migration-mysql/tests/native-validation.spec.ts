/** Native codec checks after binding the formal Agent 05 validation export. */
import { expect, it } from 'vitest'
import { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeMysqlSessionEvent } from '@deepseek-ai/dsh-session-persistence-mysql'
import { buildSessionEventRecords } from '@deepseek-ai/dsh-session-query'
import { validateLogical } from '../src/logical.ts'
import type { LogicalStore, MigrationLimits } from '../src/types.ts'

const limits: MigrationLimits = { maxArchiveBytes: 100000, maxFileBytes: 10000, maxSessionBytes: 10000, batchEvents: 2 }
function store(event: SessionEvent): LogicalStore {
  const id = SessionId('native-validation'), lifecycle = '01010101010101010101010101010101'
  return { version: 1, sessions: [{ header: { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false },
    lifecycle, logRevision: '2', inheritedEventCount: SessionLogOffset(0), events: [event], surface: buildSessionEventRecords(id, [event]),
    projections: null, appendReceipts: [], selectedGeneration: { lifecycle, format: SESSION_FORMAT_VERSION },
    generations: [{ lifecycle, format: SESSION_FORMAT_VERSION, sourceFiles: ['session.v4.jsonl'] }],
  }], workspace: { version: 2,
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, records: [] } }
}

it('refuses unknown required vocabulary through the formal native decoder without rewriting input', () => {
  const logical = store(decodeMysqlSessionEvent(JSON.stringify({ type: 'future/required', seq: 0, time: 1, data: { unchanged: '原文' } })))
  const before = JSON.stringify(logical)
  expect(() => { validateLogical(logical, limits) }).toThrow()
  expect(JSON.stringify(logical)).toBe(before)
})

it('preserves representable large numeric plugin payloads while business counters remain native-validated', () => {
  const logical = store(decodeMysqlSessionEvent(JSON.stringify({ type: 'plugin:06/metrics', seq: 0, time: 1, ignorable: true,
    data: { value: 1e20, text: '完整内容 😀' } })))
  const before = JSON.stringify(logical)
  expect(() => { validateLogical(logical, limits) }).not.toThrow()
  expect(JSON.stringify(logical)).toBe(before)
})
