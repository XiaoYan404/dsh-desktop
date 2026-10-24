/** GUI workflow state keeps dismissed reviews and exact uncertain writes independent. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeDriveDownloadInfo, OfficeDriveId, OfficeDriveVersionId, OfficeMemberId,
  OfficeKnowledgeSearch, OfficeKnowledgePublication } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeKnowledgeModel } from '../src/client/knowledge-model.ts'

it('invalidates the prior search status after a confirmed index mutation instead of claiming no matches', async () => {
  const { model, remote } = fixture()
  remote.searchKnowledge.mockResolvedValueOnce(ok({ query: 'policy', entries, hasMore: true }))
  await model.search('policy')
  await model.review(file.id)
  remote.publishKnowledge.mockResolvedValueOnce(ok({ ...publication, revision: 2 }))
  await model.save('publish')
  expect(model.state.getSnapshot()).toMatchObject({ query: null, entries: [], citation: null, hasMore: false })
})

type Remote = ConstructorParameters<typeof OfficeKnowledgeModel>[0]
const member = { id: 'gui-reader' as OfficeMemberId, role: 'manager' as const }
const file: OfficeDriveDownloadInfo = { id: '548aac71-d450-4d93-85e8-6405eb2ac932' as OfficeDriveId,
  versionId: '8b1169b5-5a67-4083-919b-ad097c9315ca' as OfficeDriveVersionId, name: '政策.txt', mediaType: 'text/plain',
  byteLength: 12, sha256: '1'.repeat(64), chunkBytes: 1024 }
const entries: OfficeKnowledgeSearch['entries'] = [0, 1, 2].map(chunk => ({ file, revision: 1, chunk,
  location: { kind: 'text', part: 1, offset: chunk * 10, label: '' }, text: `policy ${chunk}` }))
const publication: OfficeKnowledgePublication = { file, revision: 1, publisherId: member.id, publishedAt: 100, chunks: 3, withdrawn: false }
function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
function fixture() {
  const remote = { driveFileInfo: vi.fn<Remote['driveFileInfo']>().mockResolvedValue(ok(file)),
    knowledgePublication: vi.fn<Remote['knowledgePublication']>().mockResolvedValue(ok(publication)),
    publishKnowledge: vi.fn<Remote['publishKnowledge']>(), withdrawKnowledge: vi.fn<Remote['withdrawKnowledge']>(),
    searchKnowledge: vi.fn<Remote['searchKnowledge']>().mockResolvedValue(ok({ query: 'policy', entries, hasMore: false })),
    readKnowledgeCitation: vi.fn<Remote['readKnowledgeCitation']>() }
  const notify = vi.fn()
  const model = new OfficeKnowledgeModel(remote, notify)
  model.bind(member, { protocol: 1, maxResults: 10 })
  return { remote, model, notify }
}

it('keeps an untouched query distinct from a completed empty search and ignores whitespace submissions', async () => {
  const { model, remote } = fixture()
  expect(model.state.getSnapshot().query).toBeNull()
  await model.search('  ')
  expect(remote.searchKnowledge).not.toHaveBeenCalled()
  remote.searchKnowledge.mockResolvedValueOnce(ok({ query: 'policy', entries: [], hasMore: false }))
  await model.search('  policy  ')
  expect(remote.searchKnowledge).toHaveBeenCalledWith({ query: 'policy', limit: 10 })
  expect(model.state.getSnapshot()).toMatchObject({ query: 'policy', entries: [], busy: false, error: null })
})

it('applies a tightened visible result bound to both delayed and already displayed searches', async () => {
  const { model, remote } = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<Remote['searchKnowledge']>>>()
  remote.searchKnowledge.mockReturnValueOnce(response.promise)
  const work = model.search('policy')
  model.bind(member, { protocol: 1, maxResults: 1 })
  response.resolve(ok({ query: 'policy', entries, hasMore: false }))
  await work
  expect(model.state.getSnapshot()).toMatchObject({ entries: entries.slice(0, 1), hasMore: true })
  model.bind(member, { protocol: 1, maxResults: 10 })
  await model.search('policy')
  expect(model.state.getSnapshot().entries).toHaveLength(3)
  model.bind(member, { protocol: 1, maxResults: 2 })
  expect(model.state.getSnapshot()).toMatchObject({ entries: entries.slice(0, 2), hasMore: true })
})

it('dismisses a metadata review immediately and ignores its late response without reopening the dialog', async () => {
  const { model, remote } = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<Remote['driveFileInfo']>>>()
  remote.driveFileInfo.mockReturnValueOnce(response.promise)
  const work = model.review(file.id)
  expect(model.state.getSnapshot()).toMatchObject({ busy: true, reviewOpen: true })
  model.closeReview()
  response.resolve(ok(file))
  await work
  expect(remote.knowledgePublication).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ busy: false, reviewOpen: false, review: null })
})

it('discards a publication review that is closed after file metadata but before publication metadata arrives', async () => {
  const { model, remote } = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<Remote['knowledgePublication']>>>()
  remote.knowledgePublication.mockReturnValueOnce(response.promise)
  const work = model.review(file.id)
  await vi.waitFor(() => { expect(remote.knowledgePublication).toHaveBeenCalledOnce() })
  model.closeReview()
  response.resolve(ok(publication))
  await work
  expect(model.state.getSnapshot()).toMatchObject({ busy: false, reviewOpen: false, review: null })
})

it('reopens a dismissed unknown withdrawal with its original source, kind and UUID instead of starting a publication', async () => {
  const { model, remote, notify } = fixture()
  remote.withdrawKnowledge.mockRejectedValueOnce(new Error('Owned lost acknowledgement'))
    .mockResolvedValueOnce(ok({ ...publication, revision: 2, withdrawn: true, chunks: 0 }))
  await model.review(file.id)
  await model.save('withdraw')
  model.closeReview()
  expect(model.state.getSnapshot()).toMatchObject({ pending: true, reviewOpen: false })
  await model.review('45a44271-2aeb-4588-aa52-d50b1879020a' as OfficeDriveId)
  expect(model.state.getSnapshot().reviewOpen).toBe(false)
  await model.review(file.id)
  expect(model.state.getSnapshot().reviewOpen).toBe(true)
  await model.save('publish')
  expect(remote.withdrawKnowledge.mock.calls[1]?.[0]).toEqual(remote.withdrawKnowledge.mock.calls[0]?.[0])
  expect(remote.publishKnowledge).not.toHaveBeenCalled()
  expect(remote.driveFileInfo).toHaveBeenCalledOnce()
  expect(model.state.getSnapshot()).toMatchObject({ pending: false, error: null })
  expect(notify).toHaveBeenCalledOnce()
})

it('keeps an in-flight write alive when its dialog closes and never reopens it on acknowledgement', async () => {
  const { model, remote, notify } = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<Remote['publishKnowledge']>>>()
  remote.publishKnowledge.mockReturnValueOnce(response.promise)
  await model.review(file.id)
  const work = model.save('publish')
  model.closeReview()
  expect(model.state.getSnapshot()).toMatchObject({ reviewOpen: false, pending: true, busy: true })
  expect(notify).not.toHaveBeenCalled()
  response.resolve(ok({ ...publication, revision: 2 }))
  await work
  expect(model.state.getSnapshot()).toMatchObject({ reviewOpen: false, pending: false, busy: false })
  expect(notify).toHaveBeenCalledOnce()
})

it('does not cancel a search when a stale close callback arrives without an open review', async () => {
  const { model, remote } = fixture()
  const response = Promise.withResolvers<Awaited<ReturnType<Remote['searchKnowledge']>>>()
  remote.searchKnowledge.mockReturnValueOnce(response.promise)
  const work = model.search('policy')
  model.closeReview()
  expect(model.state.getSnapshot().busy).toBe(true)
  response.resolve(ok({ query: 'policy', entries, hasMore: true }))
  await work
  const citation = entries[0]
  if (!citation) throw new Error('Missing citation fixture')
  remote.readKnowledgeCitation.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
  await model.open(citation)
  expect(model.state.getSnapshot()).toMatchObject({ entries: [], hasMore: false, citation: null, error: 'forbidden' })
})
