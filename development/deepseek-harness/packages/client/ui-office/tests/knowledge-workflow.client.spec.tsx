// @vitest-environment jsdom
/** GUI controls expose empty/loading states, recover dismissed writes and download the cited version. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { OfficeDriveId, OfficeDriveVersionId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeKnowledge } from '../src/client/OfficeKnowledge.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { OfficeKey } from '../src/client/locales.ts'

it.each([en, zh])('labels the knowledge action separately from the address-book search hint (%#)', (copy) => {
  onTestFinished(cleanup)
  const props = fixture(copy)
  render(<OfficeKnowledge {...props} />)
  expect(screen.queryByRole('button', { name: copy.search, exact: true })).toBeNull()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '政策' } })
  fireEvent.click(screen.getByRole('button', { name: copy.knowledgeSearch, exact: true }))
  expect(props.searchKnowledge).toHaveBeenCalledExactlyOnceWith('政策')
})

type Props = Parameters<typeof OfficeKnowledge>[0]
type State = Parameters<Parameters<Props['useKnowledge']>[0]>[0]
const file = { id: '7a8c3952-629e-41ac-9af6-0583ab78042b' as OfficeDriveId,
  versionId: '2f7f3b9e-b2e4-4cc8-a6a9-25eb5a2c426b' as OfficeDriveVersionId, name: '<policy>.txt', mediaType: 'text/plain',
  sha256: 'a'.repeat(64), byteLength: 12, chunkBytes: 1024 }
const initial: State = { enabled: true, busy: false, query: null, queryError: null, entries: [], citation: null, hasMore: false,
  review: null, pending: false, saving: false, reviewOpen: false, error: null }
function fixture(copy: typeof en | typeof zh, snapshot: State = initial) {
  const props: Props = { t: (key: OfficeKey) => copy[key], useKnowledge: selector => selector(snapshot),
    searchKnowledge: vi.fn<Props['searchKnowledge']>().mockResolvedValue(),
    openKnowledgeCitation: vi.fn<Props['openKnowledgeCitation']>().mockResolvedValue(),
    reviewKnowledgeFile: vi.fn<Props['reviewKnowledgeFile']>().mockResolvedValue(),
    saveKnowledge: vi.fn<Props['saveKnowledge']>().mockResolvedValue(), closeKnowledgeReview: vi.fn(),
    downloadDriveVersion: vi.fn<Props['downloadDriveVersion']>().mockResolvedValue(), selectedFile: file.id, publisher: true }
  return props
}

it.each([en, zh])('distinguishes an untouched query, empty search and loading without a misleading empty message (%#)', (copy) => {
  onTestFinished(cleanup)
  const props = fixture(copy)
  const view = render(<OfficeKnowledge {...props} />)
  expect(screen.queryByText(copy.searchNoResults)).toBeNull()
  view.rerender(<OfficeKnowledge {...props} useKnowledge={selector => selector({ ...initial, query: 'policy' })} />)
  expect(screen.getByRole('status').textContent).toBe(copy.searchNoResults)
  view.rerender(<OfficeKnowledge {...props} useKnowledge={selector => selector({ ...initial, query: 'policy', busy: true })} />)
  expect(screen.queryByText(copy.searchNoResults)).toBeNull()
  expect(screen.getByRole('progressbar', { name: copy.loading })).toBeTruthy()
  expect(screen.getByRole('button', { name: copy.knowledgeSearch, exact: true })).toHaveProperty('disabled', true)
})

it.each([en, zh])('does not submit an IME composition or a busy form and trims an explicit completed submission (%#)', (copy) => {
  onTestFinished(cleanup)
  const props = fixture(copy)
  const view = render(<OfficeKnowledge {...props} />)
  const input = screen.getByRole('textbox', { name: copy.knowledgeQuery })
  const form = input.closest('form')
  if (!form) throw new Error('Missing knowledge form')
  fireEvent.change(input, { target: { value: '  报销  ' } })
  fireEvent.compositionStart(input)
  expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })).toBe(false)
  fireEvent.submit(form)
  expect(props.searchKnowledge).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input)
  fireEvent.submit(form)
  expect(props.searchKnowledge).toHaveBeenCalledExactlyOnceWith('报销')
  view.rerender(<OfficeKnowledge {...props} useKnowledge={selector => selector({ ...initial, busy: true })} />)
  fireEvent.submit(form)
  expect(props.searchKnowledge).toHaveBeenCalledOnce()
})

it.each([en, zh])('keeps an unknown write dismissible and reopens its reviewed source even when the selection is gone (%#)', (copy) => {
  onTestFinished(cleanup)
  const snapshot: State = { ...initial, reviewOpen: true, pending: true, error: 'knowledgeSaveUnknown',
    review: { file, publication: null } }
  const props = fixture(copy, snapshot)
  const view = render(<OfficeKnowledge {...props} />)
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('alert').textContent).toBe(copy.knowledgeSaveUnknown)
  fireEvent.click(within(dialog).getByRole('button', { name: copy.close, exact: true }))
  expect(props.closeKnowledgeReview).toHaveBeenCalledOnce()
  view.rerender(<OfficeKnowledge {...props} selectedFile={null}
    useKnowledge={selector => selector({ ...snapshot, reviewOpen: false })} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: copy.retry, exact: true }))
  expect(props.reviewKnowledgeFile).toHaveBeenCalledExactlyOnceWith(file.id)
  expect(props.saveKnowledge).not.toHaveBeenCalled()
})

it.each([en, zh])('renders source markup as inert text and downloads the exact cited version (%#)', (copy) => {
  onTestFinished(cleanup)
  const citation = { file, revision: 7, chunk: 1, location: { kind: 'text' as const, part: 1, offset: 10, label: '' },
    text: '<img src=x onerror="alert(1)"> body' }
  const props = fixture(copy, { ...initial, query: 'body', entries: [citation], citation })
  render(<OfficeKnowledge {...props} />)
  const current = screen.getByRole('article', { name: copy.knowledgeCitation })
  expect(within(current).getByText(citation.text).tabIndex).toBe(0)
  expect(screen.queryByRole('img')).toBeNull()
  fireEvent.click(within(current).getByRole('button', { name: copy.downloadFile, exact: true }))
  expect(props.downloadDriveVersion).toHaveBeenCalledExactlyOnceWith(file.id, file.versionId)
  expect(props.openKnowledgeCitation).not.toHaveBeenCalled()
})

it('remounts a changed employee form without retaining the previous employee query draft', () => {
  onTestFinished(cleanup)
  const props = fixture(zh)
  const view = render(<OfficeKnowledge key="employee-a" {...props} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private draft' } })
  view.rerender(<OfficeKnowledge key="employee-b" {...props} />)
  expect(screen.getByRole('textbox')).toHaveProperty('value', '')
})
