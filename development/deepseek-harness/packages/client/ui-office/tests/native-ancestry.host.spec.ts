/** Exact catalog positions preserve legacy affiliation without trusting future parent reviews. */
import { expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { OfficeConversationCapture, OfficeConversationCaptureId, OfficeConversationId,
  OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { readOfficeRunAncestry } from '../src/native-ancestry.ts'
import { officeRunHistoryProjection } from '../src/native-history.ts'

const lin = 'lin' as OfficeMemberId
const empty = () => officeRunHistoryProjection.init()
const signal = () => new AbortController().signal
const owner = { memberId: lin, role: 'employee' as const }
function session(id: string, parent?: Session) {
  return Session.create(SessionId(id), [], { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1,
    isSeeded: false, ...(parent ? { origin: 'subagent' as const, parentSession: parent.id } : {}) })
}
function attribute(parent: Session) {
  parent.append('office/run-inherited', { parentSession: SessionId('original-office'), owner, mixed: false, invalid: false })
}
function catalog(parent: Session, child: Session, createdAt = child.header.createdAt) {
  parent.append('subagent/catalog', { version: 0, childId: child.id, childCreatedAt: createdAt, mode: 'continuable', label: 'Legacy child' })
}
function fixture(...sessions: Session[]) {
  const values = new Map(sessions.map(value => [value.id, value]))
  const disposed = vi.fn()
  const observation = (value: Session): SessionObservation => {
    const events = value.snapshotEvents()
    return { source: 'prepared', header: value.header, inheritedEventCount: SessionLogOffset(0), events,
      cursor: (events.length - 1) as SessionSeqCursor, retain: () => observation(value), [Symbol.dispose]: disposed }
  }
  const query = { observeSession: vi.fn(async (id: SessionId) => {
    const value = values.get(id)
    if (!value) throw Object.assign(new Error('Not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    return observation(value)
  }) }
  return { query, disposed, observation }
}

it('uses the catalog position rather than timestamps or a later parent role review', async () => {
  const parent = session('parent')
  const child = session('child', parent)
  attribute(parent)
  catalog(parent, child)
  const capture: OfficeConversationCapture = { format: 1, id: 'capture' as OfficeConversationCaptureId, requestId: 'review',
    memberId: lin, role: 'manager', capturedAt: 1, selection: { conversationId: parent.id as string as OfficeConversationId,
      revision: 1, requestId: 'review', updatedAt: 1, integrations: [], tools: [] }, requirements: [], integrations: [], digest: 'a'.repeat(64) }
  parent.append('user/message', createUserMessage({ source: { kind: 'user', preparedContexts: [{ text: 'Later role review',
    source: { kind: 'office', form: 'snapshot', sections: [], capture } }] }, content: [{ type: 'text', text: 'New role' }] }),
  { surfaceOp: 'append' })
  const before = parent.snapshotEvents()
  const { query, disposed } = fixture(parent)
  expect(await readOfficeRunAncestry(query, child.header, empty(), signal())).toEqual({ owner, mixed: false, invalid: false })
  expect(parent.snapshotEvents()).toEqual(before)
  expect(query.observeSession).toHaveBeenCalledTimes(1)
  expect(query.observeSession.mock.calls[0]?.[0]).toBe(parent.id)
  expect(disposed).toHaveBeenCalledTimes(1)
})

it('keeps a child Native when the parent acquired office affiliation only after cataloging it', async () => {
  const parent = session('native-parent')
  const child = session('native-child', parent)
  catalog(parent, child)
  attribute(parent)
  const { query } = fixture(parent)
  expect(await readOfficeRunAncestry(query, child.header, empty(), signal())).toEqual(empty())
})

it('requires the exact retained child identity and creation time and propagates read failures', async () => {
  const parent = session('parent')
  const child = session('child', parent)
  attribute(parent)
  catalog(parent, child, 2)
  const { query } = fixture(parent)
  expect(await readOfficeRunAncestry(query, child.header, empty(), signal())).toBeNull()
  expect(await readOfficeRunAncestry(fixture().query, child.header, empty(), signal())).toBeNull()
  query.observeSession.mockRejectedValueOnce(new Error('Corrupt parent storage'))
  await expect(readOfficeRunAncestry(query, child.header, empty(), signal())).rejects.toThrow('Corrupt parent storage')
})

it('recovers nested catalog ancestry while preserving a child-owned review without reading its parent', async () => {
  const root = session('root')
  const parent = session('parent', root)
  const child = session('child', parent)
  attribute(root)
  catalog(root, parent)
  catalog(parent, child)
  const { query, disposed } = fixture(root, parent)
  const owned = { owner, mixed: false, invalid: false }
  expect(await readOfficeRunAncestry(query, child.header, empty(), signal())).toEqual(owned)
  expect(disposed).toHaveBeenCalledTimes(2)
  query.observeSession.mockClear()
  expect(await readOfficeRunAncestry(query, child.header, { ...owned, inherited: true }, signal())).toEqual({ ...owned, inherited: true })
  expect(query.observeSession).not.toHaveBeenCalled()
})

it('preserves a child role review but quarantines a different queued employee against the original catalog owner', async () => {
  const parent = session('parent')
  const child = session('child', parent)
  attribute(parent)
  catalog(parent, child)
  const { query } = fixture(parent)
  expect(await readOfficeRunAncestry(query, child.header,
    { owner: { memberId: lin, role: 'manager' }, mixed: false, invalid: false }, signal()))
    .toMatchObject({ owner: { memberId: lin, role: 'manager' }, mixed: false, invalid: false })
  expect(await readOfficeRunAncestry(query, child.header,
    { owner: { memberId: 'chen' as OfficeMemberId, role: 'employee' }, mixed: false, invalid: false }, signal()))
    .toMatchObject({ mixed: true })
})

it('rejects conflicting catalog records and cyclic ancestry', async () => {
  const root = session('root')
  const parent = session('parent', root)
  const child = session('child', parent)
  catalog(parent, child)
  catalog(parent, child)
  await expect(readOfficeRunAncestry(fixture(parent).query, child.header, empty(), signal())).rejects.toThrow('conflicting')
  const cycle = session('cycle', child)
  const leaf = session('child', cycle)
  catalog(cycle, leaf)
  await expect(readOfficeRunAncestry(fixture(cycle).query, leaf.header, empty(), signal())).rejects.toThrow('cyclic')
})

it('disposes a late parent observation when its read is cancelled', async () => {
  const parent = session('parent')
  const child = session('child', parent)
  attribute(parent)
  catalog(parent, child)
  const { query, disposed, observation } = fixture(parent)
  const pending = Promise.withResolvers<SessionObservation>()
  query.observeSession.mockReturnValueOnce(pending.promise)
  const controller = new AbortController()
  const result = readOfficeRunAncestry(query, child.header, empty(), controller.signal)
  controller.abort(new Error('Read cancelled'))
  pending.resolve(observation(parent))
  await expect(result).rejects.toThrow('Read cancelled')
  expect(disposed).toHaveBeenCalledTimes(1)
})

it('proves Native ancestry without a catalog only when every complete parent history is free of office affiliation', async () => {
  const root = session('uncatalogued-native-root')
  const parent = session('uncatalogued-native-parent', root)
  const child = session('uncatalogued-native-child', parent)
  const { query, disposed } = fixture(root, parent)
  expect(await readOfficeRunAncestry(query, child.header, empty(), signal())).toEqual(empty())
  expect(disposed).toHaveBeenCalledTimes(2)
  attribute(root)
  expect(await readOfficeRunAncestry(query, child.header, empty(), signal())).toBeNull()
  expect(await readOfficeRunAncestry(fixture(parent).query, child.header, empty(), signal())).toBeNull()
})
