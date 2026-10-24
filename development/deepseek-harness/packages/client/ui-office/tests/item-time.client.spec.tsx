// @vitest-environment jsdom
/** Time badges render authoritative server decisions without a browser clock or timezone calculation. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { OfficeCalendarItemTime, OfficeItemId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeItemTimeBadge } from '../src/client/OfficeItemTimeBadge.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { OfficeKey } from '../src/client/locales.ts'

const itemId = 'authorized-item' as OfficeItemId
const t = (key: OfficeKey) => en[key]

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('displays the server overdue decision even when its instant is in the browser future', () => {
  const time: OfficeCalendarItemTime = { itemId, kind: 'work', dueAt: 253402300799000, overdue: true }
  vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Presentation must not read the browser clock') })
  render(<OfficeItemTimeBadge t={t} time={time} />)
  expect(screen.getByLabelText('Company time status: Overdue').textContent).toBe('Overdue')
})

it.each([
  ['upcoming', 'Not started'], ['ongoing', 'In progress'], ['ended', 'Ended'],
] as const)('shows the server meeting phase %s independently of browser time', (phase, label) => {
  vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Presentation must not read the browser clock') })
  render(<OfficeItemTimeBadge t={t} time={{ itemId, kind: 'schedule', startsAt: 0, endsAt: 1, phase }} />)
  expect(screen.getByLabelText(`Company time status: ${label}`).textContent).toBe(label)
})

it('shows a localized safe review marker without exposing an error cause', () => {
  render(<OfficeItemTimeBadge t={(key: OfficeKey) => zh[key]} time={{ itemId, kind: 'unresolved' }} />)
  expect(screen.getByLabelText('公司时间状态: 时间待核对').textContent).toBe('时间待核对')
})

it('adds no badge when an older server omits time decisions or work is not overdue', () => {
  const mounted = render(<OfficeItemTimeBadge t={t} time={undefined} />)
  expect(mounted.container.textContent).toBe('')
  mounted.rerender(<OfficeItemTimeBadge t={t} time={{ itemId, kind: 'work', dueAt: 0, overdue: false }} />)
  expect(mounted.container.textContent).toBe('')
})
