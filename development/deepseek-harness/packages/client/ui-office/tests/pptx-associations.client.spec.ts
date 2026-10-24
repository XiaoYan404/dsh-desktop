/** Presentation selection follows current authority metadata before native preparation. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConversationFileLimits, OfficeDriveDownloadInfo,
  OfficeDriveId, OfficeDriveVersionId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeFileAssociationsModel, officeFileReferenceSupported } from '../src/client/file-associations-model.ts'

const limits: OfficeConversationFileLimits = { protocol: 1, maxSelectedFiles: 20, maxTextBytes: 1048576, maxCharacters: 16384 }
const file: OfficeDriveDownloadInfo = { id: 'c22209aa-a0d1-40c7-bc01-533fb5e4bd52' as OfficeDriveId,
  versionId: 'abff878b-cbc5-452c-9634-b3bad1597307' as OfficeDriveVersionId,
  name: 'Quarterly review.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  byteLength: 2048, sha256: '1'.repeat(64), chunkBytes: 512 }
type Remote = ConstructorParameters<typeof OfficeFileAssociationsModel>[0]
function ok<T>(value: T): RemoteResult<OfficeOutcome<T>> { return { ok: true, value: { ok: true, value } } }

it.each(['legacy', 'oversized', 'forbidden', 'supported'] as const)('prepares a reviewed PPTX only with current reader capability (%s)', async (kind) => {
  const remote = {
    conversationFiles: vi.fn<Remote['conversationFiles']>(),
    saveConversationFiles: vi.fn<Remote['saveConversationFiles']>(),
    driveFileInfo: vi.fn<Remote['driveFileInfo']>().mockResolvedValue(kind === 'forbidden'
      ? { ok: true, value: { ok: false, code: 'forbidden' } }
      : ok({ ...file, byteLength: kind === 'oversized' ? 2049 : 2048 })),
  }
  const prepare = vi.fn<ConstructorParameters<typeof OfficeFileAssociationsModel>[1]>().mockResolvedValue(true)
  const model = new OfficeFileAssociationsModel(remote, prepare, vi.fn())
  onTestFinished(() => { model.dispose() })
  model.bind({ id: 'alice' as OfficeMemberId, role: 'employee' }, { ...limits,
    ...kind === 'legacy' ? {} : { pptx: { maxBytes: 2048 } } })
  expect(await model.useFile(file.id)).toBe(kind === 'supported')
  expect(prepare).toHaveBeenCalledTimes(kind === 'supported' ? 1 : 0)
  if (kind === 'supported') {
    expect(prepare).toHaveBeenCalledWith(file, expect.any(AbortSignal))
    expect(model.state.getSnapshot()).toMatchObject({ preparing: false, choosing: false, error: null })
  } else expect(model.state.getSnapshot().error).toBe(kind === 'forbidden' ? 'forbidden' : 'fileAssociationTextOnly')
  expect(remote.saveConversationFiles).not.toHaveBeenCalled()
  expect(remote.conversationFiles).not.toHaveBeenCalled()
})

it('recognizes advertised PPTX metadata without treating a renamed presentation as plain text', () => {
  const enabled = { ...limits, pptx: { maxBytes: 2048 } }
  expect(officeFileReferenceSupported({ ...file, name: 'upper.PPTX', mediaType: 'application/octet-stream' }, enabled)).toBe(true)
  expect(officeFileReferenceSupported({ ...file, name: 'saved.txt', mediaType: file.mediaType.toUpperCase() + '; x=1' }, enabled)).toBe(true)
  expect(officeFileReferenceSupported({ ...file, mediaType: 'text/plain' }, limits)).toBe(false)
  expect(officeFileReferenceSupported({ ...file, name: 'old.ppt', mediaType: 'application/vnd.ms-powerpoint' }, enabled)).toBe(false)
})

it('withdraws PPTX preparation when the server removes its optional reader', async () => {
  const remote = { conversationFiles: vi.fn<Remote['conversationFiles']>(), saveConversationFiles: vi.fn<Remote['saveConversationFiles']>(),
    driveFileInfo: vi.fn<Remote['driveFileInfo']>().mockResolvedValue(ok(file)) }
  const prepare = vi.fn<ConstructorParameters<typeof OfficeFileAssociationsModel>[1]>().mockResolvedValue(true)
  const model = new OfficeFileAssociationsModel(remote, prepare, vi.fn())
  onTestFinished(() => { model.dispose() })
  const member = { id: 'alice' as OfficeMemberId, role: 'employee' as const }
  model.bind(member, { ...limits, pptx: { maxBytes: 2048 } })
  model.bind(member, limits)
  expect(await model.useFile(file.id)).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
})
