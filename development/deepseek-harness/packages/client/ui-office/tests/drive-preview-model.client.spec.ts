/** Authorized ranges, immutable versions, bounded buffers and employee lifetimes. */
import { createHash } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeDriveDownloadInfo, OfficeDriveId, OfficeDriveVersionId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeDrivePreviewModel } from '../src/client/drive-preview-model.ts'

type Remote = ConstructorParameters<typeof OfficeDrivePreviewModel>[0]
const id = '8ac2c2be-47b7-4a2d-89ac-3ce523c1ff15' as OfficeDriveId
const versionId = 'b4e87b76-edce-4018-aa89-3184a6eca47a' as OfficeDriveVersionId
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

function fixture(text = 'Office file\n<script>window.compromised=true</script>') {
  const bytes = Buffer.from(text)
  const info: OfficeDriveDownloadInfo = { id, versionId, name: 'report.txt', mediaType: 'text/plain',
    byteLength: bytes.length, sha256: digest(bytes), chunkBytes: 7 }
  const remote = {
    driveFileInfo: vi.fn<Remote['driveFileInfo']>().mockImplementation(async () => success(info)),
    downloadDriveRange: vi.fn<Remote['downloadDriveRange']>().mockImplementation(async (input) => {
      const part = bytes.subarray(input.offset, input.offset + input.byteLength)
      return success({ ...input, sha256: digest(part), dataBase64: part.toString('base64') })
    }),
  }
  const notify = vi.fn()
  const model = new OfficeDrivePreviewModel(remote, notify)
  model.bind('employee-a' as OfficeMemberId)
  onTestFinished(() => { model.dispose(); vi.useRealTimers() })
  return { model, remote, info, bytes, notify }
}

it('reads actual ranges, verifies the full digest and reauthorizes before exposing inert text', async () => {
  const { model, remote, bytes } = fixture()
  await model.open(id)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'ready', done: bytes.length,
    content: { kind: 'text', text: bytes.toString('utf8') } })
  expect(remote.driveFileInfo).toHaveBeenCalledTimes(2)
  expect(remote.downloadDriveRange.mock.calls.every(([input]) => input.versionId === versionId && input.byteLength <= 7)).toBe(true)
  expect(remote.downloadDriveRange).toHaveBeenCalledTimes(Math.ceil(bytes.length / 7))
})

it('reauthorizes an empty file without requesting a zero-sized range', async () => {
  const { model, remote } = fixture('')
  remote.driveFileInfo.mockResolvedValueOnce(await remote.driveFileInfo(id))
    .mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
  await model.open(id)
  expect(remote.downloadDriveRange).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'forbidden', content: null })
})

it('rejects a corrupt range before showing any partial content', async () => {
  const { model, remote } = fixture()
  remote.downloadDriveRange.mockImplementationOnce(async input => success({ ...input, sha256: '0'.repeat(64), dataBase64: 'eA==' }))
  await model.open(id)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'downloadCorrupt', content: null })
})

it('rejects a full digest mismatch even when every range digest agrees', async () => {
  const { model, remote, info } = fixture()
  remote.driveFileInfo.mockResolvedValue(success({ ...info, sha256: '0'.repeat(64) }))
  await model.open(id)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'downloadCorrupt', content: null })
})

it('rejects a version changed after the final range and retries from current authorization', async () => {
  const { model, remote, info } = fixture()
  remote.driveFileInfo.mockResolvedValueOnce(success(info))
    .mockResolvedValueOnce(success({ ...info, versionId: 'a-new-version' as OfficeDriveVersionId }))
  await model.open(id)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'drivePreviewChanged', content: null })
  model.retry()
  await vi.waitFor(() => { expect(model.state.getSnapshot().phase).toBe('ready') })
})

it.each(['close', 'identity', 'dispose'] as const)('fences a pending range after %s', async (action) => {
  const { model, remote } = fixture()
  const held = Promise.withResolvers<Awaited<ReturnType<Remote['downloadDriveRange']>>>()
  remote.downloadDriveRange.mockImplementationOnce(() => held.promise)
  const opening = model.open(id)
  await vi.waitFor(() => { expect(remote.downloadDriveRange).toHaveBeenCalledTimes(1) })
  if (action === 'close') model.close()
  else if (action === 'identity') model.bind('employee-b' as OfficeMemberId)
  else model.dispose()
  held.resolve(success({ id, versionId, offset: 0, byteLength: 7, sha256: '0'.repeat(64), dataBase64: '' }))
  await opening
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'closed', content: null, id: null })
  expect(remote.downloadDriveRange).toHaveBeenCalledTimes(1)
})

it('refuses unsupported and oversized contents before downloading any ranges', async () => {
  const { model, remote, info } = fixture()
  remote.driveFileInfo.mockResolvedValueOnce(success({ ...info, mediaType: 'image/svg+xml', name: 'active.svg' }))
  await model.open(id)
  expect(model.state.getSnapshot().error).toBe('drivePreviewUnsupported')
  remote.driveFileInfo.mockResolvedValueOnce(success({ ...info, byteLength: 1024 * 1024 + 1 }))
  await model.open(id)
  expect(model.state.getSnapshot().error).toBe('drivePreviewTooLarge')
  expect(remote.downloadDriveRange).not.toHaveBeenCalled()
})

it('does not expose invalid UTF-8 or binary bytes as text', async () => {
  const { model } = fixture('Text\0binary')
  await model.open(id)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'drivePreviewEncoding', content: null })
})

it('publishes only verified raster bytes and withdraws them on sign-out', async () => {
  const { model, remote, info, bytes } = fixture()
  remote.driveFileInfo.mockResolvedValue(success({ ...info, mediaType: 'image/png', name: 'preview.png' }))
  await model.open(id)
  expect(model.state.getSnapshot().content).toEqual({ kind: 'image', mediaType: 'image/png', data: Uint8Array.from(bytes) })
  model.bind(null)
  expect(model.state.getSnapshot().content).toBeNull()
  await model.open(id)
  expect(model.state.getSnapshot().phase).toBe('closed')
})

it('withdraws a displayed preview on its next denied authorization renewal', async () => {
  vi.useFakeTimers()
  const { model, remote } = fixture()
  await model.open(id)
  remote.driveFileInfo.mockResolvedValue({ ok: true, value: { ok: false, code: 'forbidden' } })
  await vi.advanceTimersByTimeAsync(5000)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', error: 'forbidden', content: null })
  const reads = remote.driveFileInfo.mock.calls.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(remote.driveFileInfo).toHaveBeenCalledTimes(reads)
})

it('refresh withdraws a previously displayed version after replacement', async () => {
  const { model, remote, info } = fixture()
  await model.open(id)
  remote.driveFileInfo.mockResolvedValue(success({ ...info, sha256: '0'.repeat(64) }))
  model.refresh()
  await vi.waitFor(() => { expect(model.state.getSnapshot().error).toBe('drivePreviewChanged') })
  expect(model.state.getSnapshot().content).toBeNull()
})

it('clears private content on authentication failure and reports only the safe error key', async () => {
  const { model, remote, notify } = fixture()
  remote.driveFileInfo.mockResolvedValue({ ok: true, value: { ok: false, code: 'unauthenticated' } })
  await model.open(id)
  expect(model.state.getSnapshot()).toMatchObject({ phase: 'failed', content: null, error: 'unauthenticated' })
  expect(notify).toHaveBeenCalledWith('unauthenticated', false)
})
