// @vitest-environment jsdom
/** Audit presentation retains query context and uses explicit controls for filters, pagination and downloads. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeAudit } from '../src/client/OfficeAudit.tsx'
import type { OfficeAuditModel } from '../src/client/audit-model.ts'
import { en } from '../src/client/locales.ts'
import type { OfficeKey } from '../src/client/locales.ts'

type Snapshot = ReturnType<OfficeAuditModel['state']['getSnapshot']>
const entry = { source: 'business' as const, revision: 4, actorId: 'admin' as OfficeMemberId,
  action: 'work_created', targetId: 'reviewed-work', time: 1000 }
function fixture(value: Partial<Snapshot> = {}) {
  let snapshot: Snapshot = { open: true, filters: { source: '', actorId: '', targetId: '', action: '', since: '', until: '' },
    applied: { limit: 20, before: null }, entries: [entry], next: { source: entry.source, revision: 4, time: 1000 },
    total: 25, loading: false, exporting: false, stale: false, error: null, validation: null, ...value }
  const props: ComponentProps<typeof OfficeAudit> = { t: (key: OfficeKey) => en[key], useAudit: select => select(snapshot),
    closeAudit: vi.fn(), fieldAudit: vi.fn(), searchAudit: vi.fn(async () => {}),
    moreAudit: vi.fn(async () => {}), exportAudit: vi.fn(async () => {}) }
  const mounted = render(<OfficeAudit {...props} />)
  return { props, set: (value: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...value }; mounted.rerender(<OfficeAudit {...props} />)
  } }
}
afterEach(cleanup)

it('labels every filter and keeps source choices, pagination and download scope explicit', () => {
  const { props } = fixture()
  const dialog = within(screen.getByRole('dialog', { name: 'Audit records' }))
  expect(dialog.getAllByRole('option').map(option => option.textContent)).toEqual([
    'All sources', 'Office business', 'Sign-in and identity', 'Organization', 'Drive', 'Integration imports', 'Connection configuration',
    'Request denials',
  ])
  fireEvent.change(dialog.getByRole('combobox', { name: 'Source' }), { target: { value: 'drive' } })
  expect(props.fieldAudit).toHaveBeenCalledWith('source', 'drive')
  for (const label of ['Actor ID', 'Target ID', 'Action name', 'From (local time)', 'Until (local time)'])
    expect(dialog.getByLabelText(label)).toBeTruthy()
  expect(dialog.getByText('Displayed / current matches: 1 / 25')).toBeTruthy()
  const table = within(dialog.getByRole('table', { name: 'Operations' }))
  expect(table.getByRole('cell', { name: 'admin' })).toBeTruthy()
  expect(table.getByRole('cell', { name: 'reviewed-work' })).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Load more records' }))
  expect(props.moreAudit).toHaveBeenCalledOnce()
  fireEvent.click(dialog.getByRole('button', { name: 'Download displayed records (NDJSON)' }))
  expect(props.exportAudit).toHaveBeenCalledOnce()
  fireEvent.click(dialog.getByRole('button', { name: 'Search records' }))
  expect(props.searchAudit).toHaveBeenCalledOnce()
  fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
  expect(props.closeAudit).toHaveBeenCalledOnce()
})

it('keeps rows visible beside a retryable query error and disables downloads while a stale view awaits refresh', () => {
  const { props, set } = fixture({ error: 'unavailable' })
  const dialog = within(screen.getByRole('dialog', { name: 'Audit records' }))
  expect(dialog.getByRole('alert').textContent).toContain(en.unavailable)
  expect(dialog.getByRole('table', { name: 'Operations' })).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Retry' }))
  expect(props.moreAudit).toHaveBeenCalledOnce()
  set({ error: null, stale: true })
  expect(dialog.getByRole('alert').textContent).toBe(en.auditChanged)
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Download displayed records (NDJSON)' }).disabled).toBe(true)
  expect(dialog.getByRole('table', { name: 'Operations' })).toBeTruthy()
})

it('distinguishes loading, empty and invalid-filter states and removes the dialog after its owner clears it', () => {
  const { set } = fixture({ loading: true, entries: [], next: null })
  const dialog = within(screen.getByRole('dialog', { name: 'Audit records' }))
  expect(dialog.getByRole('status', { name: 'Loading audit records' })).toBeTruthy()
  expect(dialog.queryByText('No matching audit records')).toBeNull()
  set({ loading: false, total: 0 })
  expect(dialog.queryByRole('status', { name: 'Loading audit records' })).toBeNull()
  expect(dialog.getByText('No matching audit records')).toBeTruthy()
  set({ applied: null, validation: 'auditInvalidFilters' })
  expect(dialog.getByRole('alert').textContent).toBe(en.auditInvalidFilters)
  set({ open: false })
  expect(screen.queryByRole('dialog')).toBeNull()
})
