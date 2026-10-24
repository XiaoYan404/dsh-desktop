// @vitest-environment jsdom
/** Query recovery retains its own terms and errors alongside an independently uncertain publication. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OfficeDriveDownloadInfo, OfficeDriveId, OfficeDriveVersionId, OfficeMemberId,
  OfficeKnowledgeCitation, OfficeKnowledgePublication, OfficeKnowledgePublishInput, OfficeKnowledgeSearch,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeKnowledgeModel } from '../src/client/knowledge-model.ts'
import { OfficeKnowledge } from '../src/client/OfficeKnowledge.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { OfficeKey } from '../src/client/locales.ts'

type Remote = ConstructorParameters<typeof OfficeKnowledgeModel>[0]
type Props = Parameters<typeof OfficeKnowledge>[0]
const member = { id: 'query-owner' as OfficeMemberId, role: 'manager' as const }
const file: OfficeDriveDownloadInfo = { id: 'dd9fb229-9ca3-4dce-8ffa-a0111483530e' as OfficeDriveId,
  versionId: 'c00c70c7-4bbb-460e-a179-536bf5bc8aab' as OfficeDriveVersionId, name: '报销政策.txt', mediaType: 'text/plain',
  byteLength: 24, sha256: 'b'.repeat(64), chunkBytes: 1024 }
const citation: OfficeKnowledgeCitation = { file, revision: 1, chunk: 0,
  location: { kind: 'text', part: 1, offset: 0, label: '' }, text: '报销 policy body' }
const search: OfficeKnowledgeSearch = { query: '报销', entries: [citation], hasMore: false }
const publication: OfficeKnowledgePublication = { file, revision: 1, publisherId: member.id,
  publishedAt: 100, chunks: 1, withdrawn: false }
function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
function fixture() {
  const remote = { driveFileInfo: vi.fn<Remote['driveFileInfo']>().mockResolvedValue(ok(file)),
    knowledgePublication: vi.fn<Remote['knowledgePublication']>().mockResolvedValue(ok(publication)),
    publishKnowledge: vi.fn<Remote['publishKnowledge']>().mockImplementation(async (input: OfficeKnowledgePublishInput) =>
      ok({ ...publication, revision: input.revision + 1 })),
    withdrawKnowledge: vi.fn<Remote['withdrawKnowledge']>(),
    searchKnowledge: vi.fn<Remote['searchKnowledge']>().mockResolvedValue(ok(search)),
    readKnowledgeCitation: vi.fn<Remote['readKnowledgeCitation']>().mockResolvedValue(ok(citation)) }
  const notify = vi.fn()
  const model = new OfficeKnowledgeModel(remote, notify)
  model.bind(member, { protocol: 1, maxResults: 3 })
  onTestFinished(() => { cleanup(); model.dispose() })
  return { remote, model, notify }
}
function mount(copy: typeof en | typeof zh, current: ReturnType<typeof fixture>) {
  const { model } = current
  const props: Props = { t: (key: OfficeKey) => copy[key],
    useKnowledge: selector => selector(useSyncExternalStore(model.state.subscribe, model.state.getSnapshot)),
    searchKnowledge: query => model.search(query), openKnowledgeCitation: value => model.open(value),
    reviewKnowledgeFile: id => model.review(id), saveKnowledge: kind => model.save(kind),
    closeKnowledgeReview: () => { model.closeReview() }, downloadDriveVersion: vi.fn<Props['downloadDriveVersion']>().mockResolvedValue(),
    selectedFile: file.id, publisher: true }
  return render(<OfficeKnowledge {...props} />)
}

it.each([en, zh])('labels a delayed reply with its submitted terms while retaining a newer unsent draft (%#)', async (copy) => {
  const current = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<Remote['searchKnowledge']>>>()
  current.remote.searchKnowledge.mockReturnValueOnce(response.promise)
  mount(copy, current)
  const input = screen.getByRole('textbox', { name: copy.knowledgeQuery })
  fireEvent.change(input, { target: { value: '报销' } })
  fireEvent.click(screen.getByRole('button', { name: copy.knowledgeSearch, exact: true }))
  fireEvent.change(input, { target: { value: '休假草稿' } })
  await act(async () => { response.resolve(ok(search)) })
  const results = screen.getByRole('region', { name: copy.searchResults })
  expect(within(results).getByText(`${copy.knowledgeQuery}: 报销`)).toBeTruthy()
  expect(within(results).getByRole('button', { name: file.name, exact: true })).toBeTruthy()
  expect(input).toHaveProperty('value', '休假草稿')
  expect(current.remote.searchKnowledge).toHaveBeenCalledExactlyOnceWith({ query: '报销', limit: 3 })
})

it.each([en, zh])('retries failed submitted terms without replacing the employee draft or starting a publication (%#)', async (copy) => {
  const current = fixture()
  current.remote.searchKnowledge.mockRejectedValueOnce(new Error('Controlled query transport failure'))
  mount(copy, current)
  const input = screen.getByRole('textbox', { name: copy.knowledgeQuery })
  fireEvent.change(input, { target: { value: '  报销  ' } })
  fireEvent.click(screen.getByRole('button', { name: copy.knowledgeSearch, exact: true }))
  const results = screen.getByRole('region', { name: copy.searchResults })
  await within(results).findByRole('alert')
  expect(within(results).queryByRole('status')).toBeNull()
  fireEvent.change(input, { target: { value: '下一次新查询' } })
  fireEvent.click(within(results).getByRole('button', { name: copy.retry, exact: true }))
  await within(results).findByRole('button', { name: file.name, exact: true })
  expect(current.remote.searchKnowledge.mock.calls.map(call => call[0])).toEqual([
    { query: '报销', limit: 3 }, { query: '报销', limit: 3 },
  ])
  expect(input).toHaveProperty('value', '下一次新查询')
  expect(current.remote.publishKnowledge).not.toHaveBeenCalled()
  expect(current.model.state.getSnapshot()).toMatchObject({ queryError: null, error: null, saving: false })
})

it.each([en, zh])(
  'recovers a failed query separately from an unknown publication and retains the original mutation UUID (%#)',
  async (copy) => {
    const current = fixture()
    current.remote.publishKnowledge.mockRejectedValueOnce(new Error('Controlled lost publication acknowledgement'))
    current.remote.searchKnowledge.mockRejectedValueOnce(new Error('Controlled independent query failure'))
    mount(copy, current)
    fireEvent.click(screen.getByRole('button', { name: copy.knowledgeReview, exact: true }))
    let dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: copy.knowledgePublish, exact: true }))
    await waitFor(() => { expect(current.model.state.getSnapshot()).toMatchObject({ pending: true, saving: false, busy: false }) })
    fireEvent.click(within(dialog).getByRole('button', { name: copy.close, exact: true }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '报销' } })
    fireEvent.click(screen.getByRole('button', { name: copy.knowledgeSearch, exact: true }))
    const results = screen.getByRole('region', { name: copy.searchResults })
    expect((await within(results).findByRole('alert')).textContent).toBe(copy.knowledgeUnavailable)
    const unknown = screen.getByRole('complementary', { name: copy.knowledgeSaveUnknown })
    expect(within(unknown).getByRole('alert').textContent).toBe(copy.knowledgeSaveUnknown)
    fireEvent.click(within(results).getByRole('button', { name: copy.retry, exact: true }))
    await within(results).findByRole('button', { name: file.name, exact: true })
    expect(current.remote.publishKnowledge).toHaveBeenCalledOnce()
    expect(current.notify).not.toHaveBeenCalled()
    fireEvent.click(within(unknown).getByRole('button', { name: copy.retry, exact: true }))
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('alert').textContent).toBe(copy.knowledgeSaveUnknown)
    fireEvent.click(within(dialog).getByRole('button', { name: copy.retry, exact: true }))
    await waitFor(() => { expect(current.notify).toHaveBeenCalledOnce() })
    expect(current.remote.publishKnowledge.mock.calls[1]?.[0]).toEqual(current.remote.publishKnowledge.mock.calls[0]?.[0])
    expect(current.model.state.getSnapshot()).toMatchObject({ pending: false, saving: false, query: null, queryError: null })
  },
)

it('retains unknown write status while a read is busy and routes a business denial only to its query', async () => {
  const { model, remote } = fixture()
  remote.publishKnowledge.mockRejectedValueOnce(new Error('Controlled lost write response'))
  await model.review(file.id); await model.save('publish'); model.closeReview()
  const response = Promise.withResolvers<Awaited<ReturnType<Remote['searchKnowledge']>>>()
  remote.searchKnowledge.mockReturnValueOnce(response.promise)
  const query = model.search('报销')
  expect(model.state.getSnapshot()).toMatchObject({ pending: true, busy: true, saving: false, queryError: null })
  response.resolve({ ok: true, value: { ok: false, code: 'forbidden' } })
  await query
  expect(model.state.getSnapshot()).toMatchObject({ pending: true, saving: false, queryError: 'forbidden', error: null })
  await model.review(file.id)
  expect(model.state.getSnapshot()).toMatchObject({ reviewOpen: true, pending: true, queryError: 'forbidden', error: null })
})

it('keeps query errors separate from a later review failure and a definitive write rejection', async () => {
  const { model, remote, notify } = fixture()
  remote.searchKnowledge.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
  await model.search('报销')
  remote.driveFileInfo.mockRejectedValueOnce(new Error('Controlled metadata read failure'))
  await model.review(file.id)
  expect(model.state.getSnapshot()).toMatchObject({ queryError: 'forbidden', error: 'knowledgeUnavailable' })
  model.closeReview()
  expect(model.state.getSnapshot()).toMatchObject({ queryError: 'forbidden', error: null })
  await model.review(file.id)
  remote.publishKnowledge.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'conflict' } })
  await model.save('publish')
  expect(model.state.getSnapshot()).toMatchObject({ queryError: 'forbidden', error: 'conflict', pending: false, saving: false })
  expect(notify).not.toHaveBeenCalled()
})

it('prevents an old employee write settlement from clearing a new employee saving state', async () => {
  const { model, remote, notify } = fixture()
  const first = Promise.withResolvers<Awaited<ReturnType<Remote['publishKnowledge']>>>()
  const second = Promise.withResolvers<Awaited<ReturnType<Remote['publishKnowledge']>>>()
  remote.publishKnowledge.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  await model.review(file.id)
  const oldWrite = model.save('publish')
  expect(model.state.getSnapshot().saving).toBe(true)
  model.bind({ ...member, id: 'next-query-owner' as OfficeMemberId }, { protocol: 1, maxResults: 3 })
  expect(model.state.getSnapshot()).toMatchObject({ saving: false, pending: false, queryError: null })
  await model.review(file.id)
  const newWrite = model.save('publish')
  first.resolve(ok({ ...publication, revision: 2 }))
  await oldWrite
  expect(model.state.getSnapshot()).toMatchObject({ saving: true, busy: true, pending: true })
  expect(notify).not.toHaveBeenCalled()
  second.resolve(ok({ ...publication, revision: 2 }))
  await newWrite
  expect(model.state.getSnapshot()).toMatchObject({ saving: false, busy: false, pending: false })
  expect(notify).toHaveBeenCalledOnce()
})
