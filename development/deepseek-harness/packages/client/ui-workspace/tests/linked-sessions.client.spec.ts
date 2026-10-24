/** Local navigation links must not turn corrupt storage or prototype keys into native Session addresses. */
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LinkedSessionIndex } from '../src/client/linked-sessions.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('restores separate opaque keys, including prototype-looking keys, without changing native identities', () => {
  const backing = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
  })
  const first = new LinkedSessionIndex()
  for (const key of ['__proto__', 'constructor', 'office:user-a:item-a', 'office:user-b:item-a']) {
    expect(first.get(key)).toBeUndefined()
    first.set(key, { sessionId: key as SessionId, initialized: false })
  }
  const restored = new LinkedSessionIndex()
  expect(restored.get('__proto__')).toEqual({ sessionId: '__proto__', initialized: false })
  restored.set('constructor', { sessionId: 'constructor' as SessionId, initialized: true })
  expect(new LinkedSessionIndex().get('constructor')?.initialized).toBe(true)
  expect(restored.get('office:user-b:item-a')?.sessionId).toBe('office:user-b:item-a')
})

it.each([null, [], 'text', { bad: {} }, { bad: { sessionId: '', initialized: false } }, { bad: { sessionId: 'a', initialized: 'yes' } }])(
  'refuses malformed persisted links rather than silently creating replacement histories: %j', (value) => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(value), setItem: vi.fn() })
    const index = new LinkedSessionIndex()
    expect(() => index.get('known-key')).toThrow('Invalid saved conversation link')
    expect(() => { index.set('known-key', { sessionId: 'replacement' as SessionId, initialized: false }) }).toThrow()
  },
)

it('rejects empty and unbounded caller keys', () => {
  const index = new LinkedSessionIndex()
  expect(() => index.get('')).toThrow('Invalid linked conversation key')
  expect(() => index.get('x'.repeat(1025))).toThrow('Invalid linked conversation key')
})

it.each(['invalid-json', 'unreadable'] as const)('does not recreate histories when saved links are %s', (kind) => {
  const setItem = vi.fn()
  vi.stubGlobal('localStorage', {
    getItem: () => {
      if (kind === 'unreadable') throw new Error('Expected browser storage failure')
      return '{incomplete'
    },
    setItem,
  })
  const index = new LinkedSessionIndex()
  expect(() => index.get('office:item')).toThrow('Saved conversation links could not be loaded')
  expect(() => { index.set('office:item', { sessionId: 'substitute' as SessionId, initialized: false }) }).toThrow()
  expect(setItem).not.toHaveBeenCalled()
})
