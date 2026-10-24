/** Group downloads reuse original range verification and recheck group access before publishing a browser file. */
import { OfficeDriveTransfers } from './drive-transfers.ts'
import type { OfficeCollaborationRemote } from './collaboration-model.ts'
import type { OfficeDriveDownloadInfo, OfficeDriveTransferLimits, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeGroupAttachment, OfficeGroupId } from '@deepseek-ai/dsh-enterprise-office/src/collaboration-types.ts'
import type { OfficeKey } from './locales.ts'
type OriginalTransferRemote = ConstructorParameters<typeof OfficeDriveTransfers>[0]
/** Original transfer implementation remains the sole decoder, digest checker and bounded chunk collector. */
export interface OfficeGroupDownloadOptions {
  readonly remote: OriginalTransferRemote & Pick<OfficeCollaborationRemote, 'downloadGroupAttachment'>
  readonly memberId: OfficeMemberId
  readonly limits: OfficeDriveTransferLimits
  readonly groupId: OfficeGroupId
  readonly messageId: string
  readonly file: OfficeGroupAttachment
  readonly signal: AbortSignal
  current(this: void): boolean
  notify(this: void, key: OfficeKey, success: boolean): void
  save(this: void, info: OfficeDriveDownloadInfo, content: Blob): void
}
/**
 * Download an authorized original version, using group authorization for every chunk and immediately before save.
 * @param options - Current identity/group reference, original transfer limits and owner-held publication callbacks.
 * @returns After verified bytes are saved or a safe original transfer failure is presented; cancellation publishes nothing.
 */
export async function downloadOfficeGroupFile(options: OfficeGroupDownloadOptions): Promise<void> {
  const { remote, groupId, messageId, file } = options
  const completed: Array<{ readonly info: OfficeDriveDownloadInfo; readonly content: Blob }> = []
  const current = () => !options.signal.aborted && options.current()
  const coordinate = { groupId, messageId, file }
  const authorize = () => remote.downloadGroupAttachment({ ...coordinate, offset: 0, byteLength: 0 })
  const versionInfo: OriginalTransferRemote['driveVersionInfo'] = async (id, versionId) => {
    if(id !== file.fileId || versionId !== file.versionId) return { ok: true, value: { ok: false, code: 'not_found' } }
    const access = await authorize()
    if(!access.ok) return access
    if(!access.value.ok) return { ok: true, value: access.value }
    return remote.driveVersionInfo(id, versionId)
  }
  const transfer = new OfficeDriveTransfers({
    beginDriveUpload: (...args) => remote.beginDriveUpload(...args), driveUploads: () => remote.driveUploads(),
    getDriveUpload: (...args) => remote.getDriveUpload(...args), appendDriveUpload: (...args) => remote.appendDriveUpload(...args),
    completeDriveUpload: (...args) => remote.completeDriveUpload(...args), cancelDriveUpload:
      (...args) => remote.cancelDriveUpload(...args),
    driveFileInfo: async id => versionInfo(id, file.versionId), driveVersionInfo: versionInfo,
    downloadDriveRange: async input => input.id === file.fileId && input.versionId === file.versionId
      ? remote.downloadGroupAttachment({ ...coordinate, offset: input.offset, byteLength: input.byteLength })
      : { ok: true, value: { ok: false, code: 'not_found' } },
  }, options.notify, async () => { }, (info, content) => { completed.push({ info, content }) })
  const cancel = () => { transfer.dispose(); completed.length = 0 }
  options.signal.addEventListener('abort', cancel, { once: true })
  try {
    if(!current()) return
    transfer.bind(options.memberId)
    transfer.configure(options.limits)
    await transfer.downloadVersion(file.fileId, file.versionId)
    const downloaded = completed.at(0)
    if(!downloaded || !current()) return
    const access = await authorize()
    if(!access.ok) { options.notify('unavailable', false); return }
    if(!access.value.ok) { options.notify(access.value.code, false); return }
    if(current()) options.save(downloaded.info, downloaded.content)
  } finally {
    options.signal.removeEventListener('abort', cancel)
    transfer.dispose()
    completed.length = 0
  }
}
