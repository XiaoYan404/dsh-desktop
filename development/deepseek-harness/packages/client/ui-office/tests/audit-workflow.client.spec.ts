/** The audit workflow reauthorizes reviewed pages and prevents changed, partial or revoked downloads. */
import { expect, it, vi } from 'vitest'
import { auditMetadataFile, collaborationAuditQuery } from '../src/client/collaboration-audit.ts'
import { readOfficeAuditFields } from '../src/client/audit-filter-fields.ts'
import { downloadOfficeAudit } from '../src/client/audit-download.ts'
import { auditPage, auditRows, auditWorkflowFixture } from './audit-workflow-fixture.ts'
import { guiDeferred, guiDenied, guiMember, guiOk, guiPeer } from './collaboration-gui-fixture.ts'
import type { CollaborationAuditPage } from '../src/client/collaboration-audit.ts'
import type { OfficeCollaborationRemote } from '../src/client/collaboration-model.ts'

it('admits execution filters only in the combined audit source set while preserving device-local exact fields', () => {
  const fields = { source: 'execution', actorId: ` ${guiMember.id} `, targetId: ' reviewed-target ', action: ' write_completed ',
    since: '2026-10-24T00:00', until: '2026-10-26T00:00' }
  expect(readOfficeAuditFields(fields, ['business', 'identity'])).toBeNull()
  expect(collaborationAuditQuery(fields)).toEqual({ source: 'execution', actorId: guiMember.id, targetId: 'reviewed-target',
    action: 'write_completed', since: new Date(fields.since).getTime(), until: new Date(fields.until).getTime(), limit: 50, before: null })
})

it('rejects invalid combined audit input before dispatching a server query', async () => {
  const { model, remote } = await auditWorkflowFixture()
  const calls = remote.governanceAudit.mock.calls.length
  model.fieldAudit('actorId', 'invalid/member')
  expect(await model.searchAudit()).toBe(false)
  expect(remote.governanceAudit).toHaveBeenCalledTimes(calls)
  expect(model.state.getSnapshot().auditValidation).toBe('collaborationAuditInvalid')
  expect(await model.exportAudit()).toBeNull()
  model.dispose()
})

it('keeps applied filters on older audit pages and refuses duplicate continuation rows', async () => {
  const rows = auditRows(3)
  const { model, remote } = await auditWorkflowFixture(rows.slice(0, 2), 3, true)
  model.fieldAudit('source', 'execution')
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(0, 2), 3, true)))
  expect(await model.searchAudit()).toBe(true)
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(2), 3)))
  expect(await model.moreAudit()).toBe(true)
  expect(remote.governanceAudit.mock.calls.at(-1)?.[0]).toMatchObject({ source: 'execution', before: {
    key: rows[1]!.key, time: rows[1]!.time } })
  expect(model.state.getSnapshot().audit?.entries).toEqual(rows)
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(0, 2), 3, true)))
  await model.searchAudit()
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(1, 2), 3)))
  expect(await model.moreAudit()).toBe(false)
  expect(model.state.getSnapshot().auditStale).toBe(true)
  expect(await model.exportAudit()).toBeNull()
  model.dispose()
})

async function manyPages() {
  const rows = auditRows(150)
  const fixture = await auditWorkflowFixture(rows.slice(0, 50), 150, true)
  fixture.remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(50, 100), 150, true)))
  await fixture.model.moreAudit()
  fixture.remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(100), 150)))
  await fixture.model.moreAudit()
  return { ...fixture, rows }
}

it('reauthorizes every displayed batch and dispatches exact allowlisted Blob bytes once', async () => {
  const { model, remote, rows } = await manyPages()
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(0, 100), 150, true)))
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(100), 150)))
  const saved: Blob[] = []
  const notify = vi.fn()
  expect(await downloadOfficeAudit(model, { save: (_file, blob) => { saved.push(blob) }, notify })).toBe(true)
  expect(saved).toHaveLength(1)
  expect(await saved[0]!.text()).toBe(auditMetadataFile(rows).content)
  expect(await saved[0]!.text()).not.toContain('unreviewed-server-body')
  expect(JSON.parse((await saved[0]!.text()).split('\n')[0]!)).toEqual(rows[0])
  expect(notify).toHaveBeenCalledWith('auditDownloadStarted', true)
  expect(remote.governanceAudit.mock.calls.slice(-2).map(call => call[0].limit)).toEqual([100, 50])
  expect(remote.governanceAudit.mock.calls.at(-1)?.[0].before).toEqual({ key: rows[99]!.key, time: rows[99]!.time })
  model.dispose()
})

it('creates no partial file and keeps displayed audit rows after the second export batch fails', async () => {
  const { model, remote, rows } = await manyPages()
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(0, 100), 150, true)))
  remote.governanceAudit.mockRejectedValueOnce(new Error('Second batch unavailable'))
  const save = vi.fn(), notify = vi.fn()
  expect(await downloadOfficeAudit(model, { save, notify })).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalledWith('auditDownloadStarted', true)
  expect(model.state.getSnapshot().audit?.entries).toEqual(rows)
  expect(model.state.getSnapshot().feedback?.key).toBe('collaborationAuditExportFailed')
  model.dispose()
})

it('requires a fresh search rather than exporting records that changed after review', async () => {
  const { model, remote } = await auditWorkflowFixture()
  const rows = auditRows(1).map(row => ({ ...row, decision: 'unknown' as const }))
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows)))
  expect(await model.exportAudit()).toBeNull()
  expect(model.state.getSnapshot()).toMatchObject({ auditStale: true, feedback: { key: 'collaborationAuditChanged' } })
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows)))
  expect(await model.searchAudit()).toBe(true)
  expect(model.state.getSnapshot().auditStale).toBe(false)
  model.dispose()
})

it('blocks a late export and success feedback after closing and reopening the same administrator dialog', async () => {
  const { model, remote } = await auditWorkflowFixture()
  const pending = guiDeferred<Awaited<ReturnType<OfficeCollaborationRemote['governanceAudit']>>>()
  remote.governanceAudit.mockReturnValueOnce(pending.promise)
  const save = vi.fn(), notify = vi.fn()
  const downloading = downloadOfficeAudit(model, { save, notify })
  model.close(); await model.open()
  pending.resolve(guiOk(auditPage(auditRows(1))))
  expect(await downloading).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalledWith('auditDownloadStarted', true)
  model.dispose()
})

it('blocks export bytes after role loss and clears the old administrator filters', async () => {
  const { model, remote } = await auditWorkflowFixture()
  const pending = guiDeferred<Awaited<ReturnType<OfficeCollaborationRemote['governanceAudit']>>>()
  remote.governanceAudit.mockReturnValueOnce(pending.promise)
  const save = vi.fn(), notify = vi.fn()
  const downloading = downloadOfficeAudit(model, { save, notify })
  model.bind(guiPeer, [guiPeer]); await model.open()
  pending.resolve(guiOk(auditPage(auditRows(1))))
  expect(await downloading).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalledWith('auditDownloadStarted', true)
  expect(model.state.getSnapshot()).toMatchObject({ audit: null, auditApplied: null,
    auditFilters: { source: '', actorId: '', targetId: '', action: '', since: '', until: '' } })
  model.dispose()
})

it('reports a file-saver failure without announcing a successful download', async () => {
  const { model, remote } = await auditWorkflowFixture()
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(auditRows(1))))
  const notify = vi.fn()
  expect(await downloadOfficeAudit(model, { save: () => { throw new Error('Download dispatch failed') }, notify })).toBe(false)
  expect(notify).toHaveBeenCalledWith('unavailable', false)
  expect(notify).not.toHaveBeenCalledWith('auditDownloadStarted', true)
  model.dispose()
})

it('discards reviewed audit data when a fresh authorization query is denied', async () => {
  const { model, remote } = await auditWorkflowFixture()
  remote.governanceAudit.mockResolvedValueOnce(guiDenied<CollaborationAuditPage>())
  expect(await model.exportAudit()).toBeNull()
  expect(model.state.getSnapshot()).toMatchObject({ audit: null, auditApplied: null, error: 'collaborationDenied' })
  model.dispose()
})

it('discards an already verified file at the final save port after a same-member role change', async () => {
  const { model } = await auditWorkflowFixture()
  const pending = guiDeferred<ReturnType<typeof auditMetadataFile> | null>()
  const save = vi.fn(), notify = vi.fn()
  const downloading = downloadOfficeAudit({ state: model.state, exportAudit: () => pending.promise }, { save, notify })
  model.bind({ ...guiMember, role: 'employee' }, [guiMember])
  await model.open()
  pending.resolve(auditMetadataFile(auditRows(1)))
  expect(await downloading).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalledWith('auditDownloadStarted', true)
  model.dispose()
})

it('discards an already verified file at the final save port after a same-role dialog epoch change', async () => {
  const { model } = await auditWorkflowFixture()
  const pending = guiDeferred<ReturnType<typeof auditMetadataFile> | null>()
  const save = vi.fn(), notify = vi.fn()
  const downloading = downloadOfficeAudit({ state: model.state, exportAudit: () => pending.promise }, { save, notify })
  model.close(); await model.open()
  pending.resolve(auditMetadataFile(auditRows(1)))
  expect(await downloading).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalledWith('auditDownloadStarted', true)
  model.dispose()
})
