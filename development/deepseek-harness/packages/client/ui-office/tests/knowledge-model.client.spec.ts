/** Identity changes discard delayed text, citation access is renewed and uncertain writes retain their reviewed UUID. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeDriveDownloadInfo, OfficeDriveId, OfficeDriveVersionId, OfficeMemberId,
  OfficeKnowledgeSearch, OfficeKnowledgePublication, OfficeKnowledgePublishInput } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeKnowledgeModel } from '../src/client/knowledge-model.ts'

type Remote = ConstructorParameters<typeof OfficeKnowledgeModel>[0]
const member = { id: 'knowledge-alice' as OfficeMemberId, role: 'manager' as const }
const file: OfficeDriveDownloadInfo = { id: '43d5419f-7a53-4229-86a1-eb0e81b582e1' as OfficeDriveId,
  versionId: 'b42a41c5-05a0-4d71-8589-655678073366' as OfficeDriveVersionId, name: '政策.txt', mediaType: 'text/plain',
  byteLength: 12, sha256: '1'.repeat(64), chunkBytes: 1024 }
const result: OfficeKnowledgeSearch = { query: 'policy', entries: [{ file, revision: 1, chunk: 0,
  location: { kind: 'text', part: 1, offset: 0, label: '' }, text: 'policy body' }], hasMore: false }
function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }
function fixture() {
  const remote = { driveFileInfo: vi.fn<Remote['driveFileInfo']>().mockResolvedValue(ok(file)),
    knowledgePublication: vi.fn<Remote['knowledgePublication']>().mockResolvedValue(ok(null)),
    publishKnowledge: vi.fn<Remote['publishKnowledge']>(), withdrawKnowledge: vi.fn<Remote['withdrawKnowledge']>(),
    searchKnowledge: vi.fn<Remote['searchKnowledge']>().mockResolvedValue(ok(result)),
    readKnowledgeCitation: vi.fn<Remote['readKnowledgeCitation']>() }
  const notify = vi.fn()
  const model = new OfficeKnowledgeModel(remote, notify)
  model.bind(member, { protocol: 1, maxResults: 10 })
  return { remote, model, notify }
}

it('discards a delayed search after account replacement or capability withdrawal', async () => {
  const { remote, model } = fixture()
  const delayed = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeKnowledgeSearch>>>()
  remote.searchKnowledge.mockReturnValueOnce(delayed.promise)
  const pending = model.search('policy')
  model.bind({ ...member, id: 'knowledge-bob' as OfficeMemberId }, { protocol: 1, maxResults: 10 })
  delayed.resolve(ok(result))
  await pending
  expect(model.state.getSnapshot().entries).toEqual([])
  await model.search('policy')
  expect(model.state.getSnapshot().entries).toEqual(result.entries)
  model.bind(member)
  expect(model.state.getSnapshot().enabled).toBe(false)
  expect(model.state.getSnapshot().entries).toEqual([])
})

it('retries an unconfirmed reviewed publication with the exact input and reports success only after the real acknowledgement', async () => {
  const { remote, model, notify } = fixture()
  remote.publishKnowledge.mockRejectedValueOnce(new Error('Owned lost response'))
    .mockImplementationOnce(async (input: OfficeKnowledgePublishInput) => ok({ file, publisherId: member.id, revision: input.revision + 1,
      publishedAt: 100, chunks: 1, withdrawn: false } satisfies OfficeKnowledgePublication))
  await model.review(file.id)
  await model.save('publish')
  expect(model.state.getSnapshot().pending).toBe(true)
  expect(model.state.getSnapshot().error).toBe('knowledgeSaveUnknown')
  expect(notify).not.toHaveBeenCalled()
  model.closeReview()
  expect(model.state.getSnapshot().review).not.toBeNull()
  await model.save('publish')
  expect(remote.publishKnowledge.mock.calls).toHaveLength(2)
  expect(remote.publishKnowledge.mock.calls[1]?.[0]).toEqual(remote.publishKnowledge.mock.calls[0]?.[0])
  expect(model.state.getSnapshot().pending).toBe(false)
  expect(notify).toHaveBeenCalledOnce()
})

it('reopens citations through current authority and removes a newly denied source body', async () => {
  const { remote, model } = fixture()
  await model.search('policy')
  const citation = result.entries[0]
  if (!citation) throw new Error('Knowledge fixture citation missing')
  remote.readKnowledgeCitation.mockResolvedValue({ ok: true, value: { ok: false, code: 'forbidden' } })
  await model.open(citation)
  expect(remote.readKnowledgeCitation).toHaveBeenCalledWith({ fileId: file.id, versionId: file.versionId,
    sha256: file.sha256, revision: 1, chunk: 0 })
  expect(model.state.getSnapshot().entries).toEqual([])
  expect(model.state.getSnapshot().citation).toBeNull()
  expect(model.state.getSnapshot().error).toBe('forbidden')
})
