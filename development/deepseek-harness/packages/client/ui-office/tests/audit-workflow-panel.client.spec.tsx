// @vitest-environment jsdom
/** Driven GUI workflow: local filters, existing server pagination and the exact displayed download. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CollaborationAudit } from '../src/client/CollaborationAudit.tsx'
import { collaborationEn } from '../src/client/collaboration-copy.ts'
import type { CollaborationKey } from '../src/client/collaboration-copy.ts'
import { downloadOfficeAudit } from '../src/client/audit-download.ts'
import { auditMetadataFile } from '../src/client/collaboration-audit.ts'
import { auditRows, auditPage, auditWorkflowFixture } from './audit-workflow-fixture.ts'
import { guiMember, guiOk } from './collaboration-gui-fixture.ts'

afterEach(cleanup)
async function fixture(entries = auditRows(1), total = entries.length, older = false) {
  const harness = await auditWorkflowFixture(entries, total, older)
  const saved: Blob[] = []
  const notify = vi.fn()
  const draw = () => <CollaborationAudit snapshot={harness.model.state.getSnapshot()}
    t={key => Object.hasOwn(collaborationEn, key) ? collaborationEn[key as CollaborationKey] : key}
    fieldCollaborationAudit={(key, value) => { harness.model.fieldAudit(key, value) }}
    searchCollaborationAudit={() => harness.model.searchAudit()} moreCollaborationAudit={() => harness.model.moreAudit()}
    exportCollaborationAudit={async () => {
      await downloadOfficeAudit(harness.model, { save: (_file, blob) => { saved.push(blob) }, notify })
    }} />
  const mounted = render(draw())
  const stop = harness.model.state.subscribe(() => { mounted.rerender(draw()) })
  return { ...harness, saved, notify, finish: () => { stop(); harness.model.dispose() } }
}

it('applies GUI source actor target action and local-time filters to the original query operation', async () => {
  const { remote, finish } = await fixture()
  fireEvent.click(screen.getByRole('button', { name: 'Execution stages' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Actor' }), { target: { value: guiMember.id } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Target ID' }), { target: { value: 'reviewed-target' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Action name' }), { target: { value: 'write_completed' } })
  fireEvent.change(screen.getByLabelText('Since'), { target: { value: '2026-10-24T00:00' } })
  fireEvent.change(screen.getByLabelText('Until'), { target: { value: '2026-10-26T00:00' } })
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(auditRows(1))))
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
  await waitFor(() => { expect(screen.getByText('Displayed records: 1 / 1')).toBeTruthy() })
  expect(remote.governanceAudit.mock.calls.at(-1)?.[0]).toEqual({ source: 'execution', actorId: guiMember.id,
    targetId: 'reviewed-target', action: 'write_completed', since: new Date('2026-10-24T00:00').getTime(),
    until: new Date('2026-10-26T00:00').getTime(), before: null, limit: 50 })
  expect(screen.getByText('write_completed')).toBeTruthy()
  finish()
})

it('loads older GUI records then downloads exactly all displayed authorized metadata', async () => {
  const rows = auditRows(3)
  const { remote, saved, notify, finish } = await fixture(rows.slice(0, 2), 3, true)
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows.slice(2), 3)))
  fireEvent.click(screen.getByRole('button', { name: 'Read older records' }))
  await waitFor(() => { expect(screen.getByText('Displayed records: 3 / 3')).toBeTruthy() })
  remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(rows, 3)))
  fireEvent.click(screen.getByRole('button', { name: 'Export displayed records' }))
  await waitFor(() => { expect(saved).toHaveLength(1) })
  expect(await saved[0]!.text()).toBe(auditMetadataFile(rows).content)
  expect(notify).toHaveBeenCalledWith('auditDownloadStarted', true)
  expect(screen.queryByRole('button', { name: 'Read older records' })).toBeNull()
  finish()
})

it('keeps an invalid GUI filter visible and reports correction without another server call', async () => {
  const { remote, finish } = await fixture()
  const previous = remote.governanceAudit.mock.calls.length
  fireEvent.change(screen.getByRole('textbox', { name: 'Actor' }), { target: { value: 'wrong/member' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(collaborationEn.collaborationAuditInvalid) })
  expect((screen.getByRole('textbox', { name: 'Actor' }) as HTMLInputElement).value).toBe('wrong/member')
  expect(remote.governanceAudit).toHaveBeenCalledTimes(previous)
  expect(screen.getByRole('button', { name: 'Export displayed records' }).matches(':disabled')).toBe(true)
  finish()
})
