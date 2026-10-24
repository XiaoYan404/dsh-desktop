/** Complete store equality cannot ignore a durable domain outside sessions or workspace. */
import { expect, it } from 'vitest'
import { diffLogical, validateLogical } from '../src/logical.ts'
import type { LogicalStore, MigrationLimits } from '../src/types.ts'

const limits: MigrationLimits = { maxArchiveBytes: 100000, maxFileBytes: 20000, maxSessionBytes: 20000, batchEvents: 2 }
const store: LogicalStore = { version: 1, sessions: [], workspace: { version: 2,
  global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, records: [] } }

it('reports a dropped top-level durable domain despite equal sessions and workspace', () => {
  const source = { ...store, officeDomains: { revision: '2', groups: [{ id: 'retained-group', messages: ['retained'] }] } }
  expect(diffLogical(source, store)).toContainEqual({ field: 'store-record' })
})

it('reports a changed nested store value and distinguishes an absent field from a retained null', () => {
  const source = { ...store, extraDurableState: { revision: '1', value: null } }
  const target = { ...store, extraDurableState: { revision: '2', value: null } }
  expect(diffLogical(source, target)).toContainEqual({ field: 'store-record' })
  const withOptionalState = { ...store, optionalDurableState: null }
  expect(diffLogical(withOptionalState, store)).toContainEqual({ field: 'store-record' })
  expect(diffLogical(source, structuredClone(source))).toEqual([])
})

it('rejects an unmodeled Office domain in a v1 archive instead of allowing its target adapter to drop it', () => {
  expect(() => { validateLogical({ ...store, officeDomains: { groups: [] } }, limits) })
    .toThrow(expect.objectContaining({ code: 'FUTURE_FORMAT' }))
})

it('rejects an unmodeled workspace envelope value before staging or provider selection', () => {
  expect(() => { validateLogical({ ...store, workspace: { ...store.workspace, retainedPreference: 'required' } }, limits) })
    .toThrow(expect.objectContaining({ code: 'FUTURE_FORMAT' }))
})
