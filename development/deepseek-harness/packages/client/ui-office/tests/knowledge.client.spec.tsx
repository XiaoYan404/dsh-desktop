// @vitest-environment jsdom
/** Localized employees search current citations and publishers explicitly review source metadata. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { OfficeDriveId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeKnowledgeModel } from '../src/client/knowledge-model.ts'
import { OfficeKnowledge } from '../src/client/OfficeKnowledge.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { OfficeKey } from '../src/client/locales.ts'

it.each([en, zh])('shows literal source text and routes search and publication review through bound callbacks (%#)', (copy) => {
  onTestFinished(cleanup)
  const state: ReturnType<OfficeKnowledgeModel['state']['getSnapshot']> = { enabled: true, busy: false, query: null, queryError: null,
    entries: [], citation: null, hasMore: false, review: null, pending: false, saving: false, reviewOpen: false, error: null }
  type Props = Parameters<typeof OfficeKnowledge>[0]
  const props: Props = { t: (key: OfficeKey) => copy[key], useKnowledge: selector => selector(state),
    searchKnowledge: vi.fn<Props['searchKnowledge']>().mockResolvedValue(),
    openKnowledgeCitation: vi.fn<Props['openKnowledgeCitation']>().mockResolvedValue(),
    reviewKnowledgeFile: vi.fn<Props['reviewKnowledgeFile']>().mockResolvedValue(),
    saveKnowledge: vi.fn<Props['saveKnowledge']>().mockResolvedValue(), closeKnowledgeReview: vi.fn(),
    downloadDriveVersion: vi.fn<Props['downloadDriveVersion']>().mockResolvedValue(),
    selectedFile: 'selection' as OfficeDriveId, publisher: true }
  render(<OfficeKnowledge {...props} />)
  fireEvent.change(screen.getByLabelText(copy.knowledgeQuery), { target: { value: '报销' } })
  fireEvent.click(screen.getByRole('button', { name: copy.knowledgeSearch, exact: true }))
  expect(props.searchKnowledge).toHaveBeenCalledWith('报销')
  fireEvent.click(screen.getByRole('button', { name: copy.knowledgeReview, exact: true }))
  expect(props.reviewKnowledgeFile).toHaveBeenCalledWith(props.selectedFile)
})
