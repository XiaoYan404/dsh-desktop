/** Office history reflects native membership, archives and real metadata without mutating them. */
import { expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isOfficeConversation, officeSessionRows } from '../src/client/session-list.ts'

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: id as SessionId, displayTitle: `Native ${id}`, running: false, retainedBy: {}, blank: false, updatedAt: 10, ...extra }
}
function state(rows: readonly SessionSummary[], ids = rows.map(row => row.id)): SessionListState {
  return { ids, byId: Object.fromEntries(rows.map(row => [row.id, row])), phase: 'ready', projectionsBySession: {} }
}

it('excludes archives, children and retained fallbacks outside catalog membership', () => {
  const rows = [session('a'), session('archived'), session('child', { parentId: 'a' as SessionId }),
    session('origin', { origin: 'subagent' }), session('retained')]
  const source = state(rows, rows.slice(0, 4).map(row => row.id))
  expect(officeSessionRows(source, ['archived' as SessionId], '', {}).map(row => row.session.id)).toEqual(['a'])
  expect(source.ids).toHaveLength(4)
  expect(Object.keys(source.byId)).toHaveLength(5)
})

it('never treats a child view as the ordinary employee return target', () => {
  expect(isOfficeConversation(undefined)).toBe(false)
  expect(isOfficeConversation(session('ordinary'))).toBe(true)
  expect(isOfficeConversation(session('child', { origin: 'subagent' }))).toBe(false)
  expect(isOfficeConversation(session('child', { parentId: 'parent' as SessionId }))).toBe(false)
})

it('searches current item aliases, native names and Workspace paths without case/width differences', () => {
  const source = state([session('a', { cwd: 'E:/Office/Reports' }), session('b', { displayTitle: '客户复盘' })])
  expect(officeSessionRows(source, [], '  ＲＥＰＯＲＴＳ  ', {}).map(row => row.session.id)).toEqual(['a'])
  expect(officeSessionRows(source, [], '复盘', {}).map(row => row.session.id)).toEqual(['b'])
  expect(officeSessionRows(source, [], 'project review', { a: 'Project Review' }).map(row => row.label)).toEqual(['Project Review'])
  expect(officeSessionRows(source, [], 'does not exist', {})).toEqual([])
})

it('uses stable newest-first order and reads prototype-looking ids as owned data', () => {
  const source = state([session('c'), session('b'), session('a', { updatedAt: 20 }), session('constructor')])
  expect(officeSessionRows(source, [], '', {}).map(row => row.session.id)).toEqual(['a', 'b', 'c', 'constructor'])
  expect(officeSessionRows(source, [], 'constructor', {})[0]?.label).toBe('Native constructor')
  expect(officeSessionRows(source, [], '', Object.fromEntries([['constructor', 'Actual alias']]))[3]?.label).toBe('Actual alias')
})
