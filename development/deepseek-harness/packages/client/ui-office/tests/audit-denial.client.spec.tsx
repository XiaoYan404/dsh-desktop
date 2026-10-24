// @vitest-environment jsdom
/** Denial reasons are localized in the existing action cell while rows without a code keep their original DOM. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { OfficeAuditRecord, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeAudit } from '../src/client/OfficeAudit.tsx'
import type { OfficeAuditModel } from '../src/client/audit-model.ts'
import { en, zh } from '../src/client/locales.ts'
import type { OfficeKey } from '../src/client/locales.ts'

const reasons: { code: NonNullable<OfficeAuditRecord['denialCode']>; label: OfficeKey }[] = [
  { code: 'forbidden', label: 'auditDenialForbidden' }, { code: 'not_found', label: 'auditDenialNotFound' },
  { code: 'conflict', label: 'auditDenialConflict' }, { code: 'invalid_input', label: 'auditDenialInvalidInput' },
  { code: 'unauthenticated', label: 'auditDenialUnauthenticated' },
]
type Snapshot = ReturnType<OfficeAuditModel['state']['getSnapshot']>
afterEach(cleanup)

it.each([['English', en], ['Chinese', zh]] as const)('offers request denials and localized reasons in %s without changing legacy rows', (_language, copy) => {
  const base = { actorId: 'lin' as OfficeMemberId, targetId: 'admin', time: 1000 }
  const entries: OfficeAuditRecord[] = reasons.map(({ code }, index) => ({ ...base, source: 'request_denial', revision: index + 1,
    action: `denied_${code}`, denialCode: code }))
  entries.push({ ...base, source: 'business', revision: 1, action: 'work_created' },
    { ...base, source: 'request_denial', revision: 6, action: 'legacy_request' })
  const snapshot: Snapshot = { open: true, filters: { source: '', actorId: '', targetId: '', action: '', since: '', until: '' },
    applied: { limit: 20, before: null }, entries, next: null, total: entries.length,
    loading: false, exporting: false, stale: false, error: null, validation: null }
  const props: ComponentProps<typeof OfficeAudit> = { t: (key: OfficeKey) => copy[key], useAudit: select => select(snapshot),
    closeAudit: vi.fn(), fieldAudit: vi.fn(), searchAudit: vi.fn(async () => {}),
    moreAudit: vi.fn(async () => {}), exportAudit: vi.fn(async () => {}) }
  render(<OfficeAudit {...props} />)
  const dialog = within(screen.getByRole('dialog', { name: copy.auditTitle }))
  expect(dialog.getByRole('option', { name: copy.auditRequestDenial })).toBeTruthy()
  fireEvent.change(dialog.getByRole('combobox', { name: copy.auditSource }), { target: { value: 'request_denial' } })
  expect(props.fieldAudit).toHaveBeenCalledWith('source', 'request_denial')
  const table = within(dialog.getByRole('table', { name: copy.auditRecords }))
  for (const reason of reasons)
    expect(table.getByRole('cell', { name: `denied_${reason.code} · ${copy[reason.label]}` })).toBeTruthy()
  expect(table.getByRole('cell', { name: 'work_created' }).innerHTML).toBe('work_created')
  expect(table.getByRole('cell', { name: 'legacy_request' }).innerHTML).toBe('legacy_request')
  expect(table.getAllByRole('columnheader')).toHaveLength(6)
})
