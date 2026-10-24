/** Group download verification uses the original transfer implementation and actual generated Remote envelopes. */
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeOutcome } from '../src/types.ts'
import type { OfficeDriveId, OfficeDriveVersionId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeGroupId } from '@deepseek-ai/dsh-enterprise-office/src/collaboration-types.ts'
import { downloadOfficeGroupFile } from '../src/client/group-download.ts'
import type { OfficeGroupDownloadOptions } from '../src/client/group-download.ts'

const id = 'a01f56c1-095a-444b-b316-23e0be2fc30a' as OfficeDriveId
const versionId = '56ce8069-f521-4fb3-a153-939fabd029ec' as OfficeDriveVersionId
const groupId = '39668c7c-03f6-42f1-815c-292cd22371e8' as OfficeGroupId
const content = Buffer.from('Verified original group file')
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const denied = (): RemoteResult<OfficeOutcome<never>> => ({ ok: true, value: { ok: false, code: 'not_found' } })

function fixture(revoked: 'never' | 'before' | 'after') {
  let allowed = revoked !== 'before'
  const info = { id, versionId, name: 'authorized.txt', mediaType: 'text/plain', byteLength: content.length, sha256: sha256(content), chunkBytes: 65536 }
  const remote = {
    beginDriveUpload: vi.fn(async () => denied()), driveUploads: vi.fn(async () => denied()), getDriveUpload: vi.fn(async () => denied()),
    appendDriveUpload: vi.fn(async () => denied()), completeDriveUpload: vi.fn(async () => denied()), cancelDriveUpload: vi.fn(async () => denied()),
    driveFileInfo: vi.fn(async () => success(info)), driveVersionInfo: vi.fn(async () => success(info)), downloadDriveRange: vi.fn(async () => denied()),
    downloadGroupAttachment: vi.fn<OfficeGroupDownloadOptions['remote']['downloadGroupAttachment']>(async (input) => {
      if (!allowed) return denied()
      const bytes = content.subarray(input.offset, input.offset + input.byteLength)
      if (input.byteLength > 0 && revoked === 'after') allowed = false
      return success({ id, versionId, offset: input.offset, byteLength: input.byteLength, dataBase64: bytes.toString('base64'), sha256: sha256(bytes) })
    }),
  } satisfies OfficeGroupDownloadOptions['remote']
  const save = vi.fn<OfficeGroupDownloadOptions['save']>()
  const notify = vi.fn()
  return { remote, save, notify, options: { remote, save, notify, memberId: 'group-reader' as OfficeMemberId,
    limits: { protocol: 1 as const, maxFileBytes: 1048576, ownerQuotaBytes: 1048576, chunkBytes: 65536, maxPendingUploads: 1, expiresAfterMs: 60000 },
    groupId, messageId: '3873fc5d-dff5-4ac7-8f46-e2d1ad2974bf', file: { fileId: id, versionId }, signal: new AbortController().signal,
    current: () => true } }
}
it('verifies actual original file bytes and performs a final group check before publishing a browser file', async () => {
  const { options, save, remote } = fixture('never')
  await downloadOfficeGroupFile(options)
  expect(save).toHaveBeenCalledTimes(1)
  const saved = save.mock.calls[0]?.[1]
  if (!saved) throw new Error('Expected verified original blob')
  expect(Buffer.from(await saved.arrayBuffer())).toEqual(content)
  expect(remote.downloadGroupAttachment.mock.calls.map(([input]) => input.byteLength)).toEqual([0, content.length, 0])
  expect(remote.downloadDriveRange).not.toHaveBeenCalled()
})
it.each(['before', 'after'] as const)('publishes no file when group access is revoked %s the range transfer', async revoked => {
  const { options, save } = fixture(revoked)
  await downloadOfficeGroupFile(options)
  expect(save).not.toHaveBeenCalled()
})
