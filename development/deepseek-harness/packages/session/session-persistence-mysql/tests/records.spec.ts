/** R7 preparations preserve native payloads and reject representations the database cannot retain. */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { Config } from '../src/index.ts'
import { assertRepresentable, count, creationHeader, decodeEvent, freezeBatch, storedHeader, validatePrefix } from '../src/records.ts'

const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('会话 😀'), createdAt: 1, isSeeded: false }
const events = () => [
  decodeEvent(JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })),
  decodeEvent(JSON.stringify({ type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })),
]

describe('MySQL Session records', () => {
  it('preserves absent metadata separately from explicit zero', () => {
    expect(creationHeader(header)).not.toHaveProperty('delegationDepth')
    expect(storedHeader(JSON.stringify(header), header.id)).toEqual(header)
    expect(storedHeader(JSON.stringify({ ...header, delegationDepth: 0 }), header.id)).toHaveProperty('delegationDepth', 0)
  })

  it('freezes receipt payloads before a caller changes them and uses the exact R7 array hash', () => {
    const source = events()
    const batch = freezeBatch(source)
    if (!batch) throw new Error('Missing nonempty preparation')
    const expected = JSON.stringify(source)
    source.splice(0)
    expect(batch.events).toHaveLength(2)
    expect('[' + batch.eventTexts.join(',') + ']').toBe(expected)
    expect(batch.sha256.toString('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
    expect(batch.batchId).toHaveLength(16)
    expect(freezeBatch([])).toBeUndefined()
  })

  it('retains an ignorable plugin record through current native validation', () => {
    const stored = [...events(), decodeEvent(JSON.stringify({ type: 'plugin:mysql-test/state', seq: 2, time: 3,
      ignorable: true, data: { text: '完整负载 😀', arguments: 'not an object' } }))]
    const before = JSON.stringify(stored)
    validatePrefix({ header, inheritedEventCount: SessionLogOffset(0) }, stored, true)
    expect(JSON.stringify(stored)).toBe(before)
  })

  it('keeps typed unknown-required append behavior but refuses its subsequent read', () => {
    const stored = [...events(), decodeEvent(JSON.stringify({ type: 'future/required', seq: 2, time: 3, data: { untouched: true } }))]
    validatePrefix({ header, inheritedEventCount: SessionLogOffset(0) }, stored, false)
    expect(() => { validatePrefix({ header, inheritedEventCount: SessionLogOffset(0) }, stored, true) })
      .toThrow(SessionFormatUnsupportedError)
  })

  it('refuses future header generations before interpreting current fields', () => {
    expect(() => storedHeader(JSON.stringify({ version: SESSION_FORMAT_VERSION + 1 }), header.id))
      .toThrow(SessionFormatUnsupportedError)
  })

  it('rejects lone surrogates without changing the source identity', () => {
    const id = 'original-\ud800'
    expect(() => { assertRepresentable(id) }).toThrow(/well-formed Unicode/)
    expect(id.charCodeAt(id.length - 1)).toBe(0xd800)
    expect(() => { assertRepresentable('合法 😀') }).not.toThrow()
  })

  it('rejects unsafe business counters rather than rounding exact SQL values', () => {
    expect(count('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => count('9007199254740992')).toThrow(/unsafe/)
  })

  it('requires an explicit namespace while keeping bounded defaults', async () => {
    expect(Config({ storeKey: 'reviewed-store' })).toMatchObject({ leaseTtlMs: 30000, heartbeatIntervalMs: 10000,
      batchDelayMs: 200, readPageSize: 1000 })
    expect(await Config['~standard'].validate({})).toHaveProperty('issues')
  })
})
