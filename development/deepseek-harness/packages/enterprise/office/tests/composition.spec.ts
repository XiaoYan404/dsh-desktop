/** Office behavior through real Loader rows and the shipped JSON storage backend. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { brandString } from '@deepseek-ai/dsh-brand'
import OfficeService from '../src/index.ts'
import { officeDriveDomain } from '../src/drive.ts'
import { OfficeDriveBlobStore } from '../src/drive-blobs.ts'
import type { OfficeDrivePurgeRequestId } from '../src/types.ts'
import type { Config } from '../src/index.ts'
import type { OfficeChatInput, OfficeMemberId, OfficeMessageId, OfficeScheduleInput, OfficeSubtaskId, OfficeWorkInput } from '../src/types.ts'
import type { OfficeDriveId, OfficeDriveUploadDeclaration, OfficeDriveUploadTicket, OfficeDriveVersionId } from '../src/types.ts'
import type { OfficeChatAttachmentId, OfficeChatFilesInput } from '../src/types.ts'
import type { OfficeChatFileDraftInput, OfficeChatFileDraftSendInput } from '../src/types.ts'

const admin = brandString<OfficeMemberId>('admin')
const lin = brandString<OfficeMemberId>('lin')
const chen = brandString<OfficeMemberId>('chen')
const xu = brandString<OfficeMemberId>('xu')
const day = '2026-10-15'
const config: Config = {
  companyName: '远山科技', timeZone: 'Asia/Shanghai',
  members: [
    { id: admin, name: '管理员', department: '行政', jobTitle: '管理员', role: 'admin' },
    { id: lin, name: '林晓', department: '运营', jobTitle: '员工', role: 'employee' },
    { id: chen, name: '陈安', department: '运营', jobTitle: '员工', role: 'employee' },
    { id: xu, name: '许宁', department: '财务', jobTitle: '负责人', role: 'manager' },
  ],
}
const work: OfficeWorkInput = { kind: 'task', title: '整理周报', date: day, time: '09:30', ownerId: chen }
const meeting: OfficeScheduleInput = { title: '周会', date: day, startTime: '10:00', endTime: '11:00', inviteeIds: [chen, lin, chen] }
const contexts: Context[] = []
const roots: string[] = []

function fileMessage(bytes = Buffer.from('真实附件\0\n', 'utf8'), text = '附件说明'): OfficeChatFilesInput {
  return { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text,
    files: [{ name: '合同资料.bin', mediaType: 'application/octet-stream', byteLength: bytes.length, dataBase64: bytes.toString('base64') }] }
}

describe('Durable drive permanent cleanup', () => {
  const upload = (ctx: Context, name: string, bytes: Buffer, space: 'private' | 'shared' = 'private',
    folderId: OfficeDriveId | null = null, actor = lin) => ctx.office.uploadDriveFile(actor,
    { name, space, folderId, requestId: randomUUID(), mediaType: 'text/plain', byteLength: bytes.length,
      dataBase64: bytes.toString('base64') })
  const confirmation = (ctx: Context, id: OfficeDriveId, actor = lin) => {
    const plan = ctx.office.drivePurgePlan(actor, id)
    return { id, revision: plan.entry.revision, digest: plan.digest,
      requestId: brandString<OfficeDrivePurgeRequestId>(randomUUID()) }
  }
  const query = { space: 'private', folderId: null, search: '' } as const
  const object = (root: string, id: string) => join(root, 'office/drive/v1/objects', `${id}.bin`)

  it('keeps cleanup scope digests independent of the process locale collation', async () => {
    const ctx = await boot(await directory())
    let folder = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Locale scope' })
    folder = await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision,
      defaultAccess: 'view', grants: [{ memberId: chen, access: 'view' }, { memberId: lin, access: 'edit' }] })
    await ctx.office.changeDriveLifecycle(admin, { id: folder.id, revision: folder.revision, action: 'trash' })
    const input = confirmation(ctx, folder.id, admin)
    const collation = vi.spyOn(String.prototype, 'localeCompare').mockReturnValue(-1)
    expect(ctx.office.drivePurgePlan(admin, folder.id).digest).toBe(input.digest)
    collation.mockRestore()
    expect(await ctx.office.purgeDrive(admin, input)).toMatchObject({ status: 'completed', folders: 1, files: 0 })
  })

  it('binds every version to a durable approval, releases only completed quota and keeps Native paths untouched', async () => {
    const root = await directory()
    const ctx = await boot(root, { ...config, driveOwnerQuotaBytes: 12 })
    const bytes = Buffer.from('first')
    const file = await upload(ctx, 'owned.txt', bytes)
    const old = await ctx.office.driveFileInfo(lin, file.id)
    const next = Buffer.from('second')
    const declaration = { space: file.space, folderId: file.parentId, name: file.name,
      requestId: randomUUID(), mediaType: 'text/plain', byteLength: next.length,
      sha256: createHash('sha256').update(next).digest('hex'), target: { id: file.id, revision: file.revision } }
    const ticket = await ctx.office.beginDriveUpload(lin, declaration)
    await ctx.office.appendDriveUpload(lin, { uploadId: ticket.id, index: 0, sha256: declaration.sha256,
      dataBase64: next.toString('base64') })
    await ctx.office.completeDriveUpload(lin, ticket.id)
    const current = ctx.office.driveHistory(lin, file.id)
    const newest = current.versions[0]!
    await ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: current.entry.revision, action: 'trash' })
    const input = confirmation(ctx, file.id)
    expect(ctx.office.drivePurgePlan(lin, file.id)).toMatchObject({ files: 1, folders: 0, versions: 2, byteLength: 11 })
    expect(ctx.office.drive(lin, query).quota).toMatchObject({ usedBytes: 11, reservedBytes: 0, limitBytes: 12 })
    const nativeFile = join(root, 'native-deliverable-sentinel.txt')
    await writeFile(nativeFile, bytes)
    const diskPath = join(root, 'data/enterprise_office_drive.json')
    const before = await readFile(diskPath)
    const remove = vi.spyOn(OfficeDriveBlobStore.prototype, 'remove')
    vi.spyOn(ctx.storageDomain.get('enterprise_office_drive')!.global, 'set')
      .mockRejectedValueOnce(new Error('Cleanup decision write failed'))
    await expect(ctx.office.purgeDrive(lin, input)).rejects.toThrow('Cleanup decision write failed')
    expect(remove).not.toHaveBeenCalled()
    expect(await readFile(diskPath)).toEqual(before)
    expect(await readFile(object(root, old.versionId))).toEqual(bytes)
    const receipt = await ctx.office.purgeDrive(lin, input)
    expect(receipt).toMatchObject({ id: file.id, requestId: input.requestId, status: 'completed', versions: 2, byteLength: 11 })
    expect(await ctx.office.purgeDrive(lin, input)).toEqual(receipt)
    expect(await ctx.office.retryDrivePurge(lin, file.id)).toEqual(receipt)
    expect(remove).toHaveBeenCalledTimes(2)
    await expect(readFile(object(root, old.versionId))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(object(root, newest.versionId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ctx.office.drive(lin, query).quota).toMatchObject({ usedBytes: 0 })
    expect(ctx.office.driveTrash(lin).entries).toEqual([])
    expect(ctx.office.drivePurgeStatus(lin, file.id)).toEqual(receipt)
    expect(await ctx.office.getDriveUpload(lin, ticket.id)).toMatchObject({ status: 'completed', fileId: file.id })
    expect(await readFile(nativeFile)).toEqual(bytes)
    const saved = officeDriveDomain.global.schema.parse(ctx.storageDomain.get('enterprise_office_drive')!.global.get())
    expect(saved.audit.slice(-2).map(entry => entry.action)).toEqual(['purge_requested', 'purged'])
    await upload(ctx, 'quota-reused.txt', Buffer.alloc(12))
  }, 30_000)

  it('keeps approved failures irreversible and charged, recovers on restart and tolerates a failed completion commit', async () => {
    const root = await directory()
    let ctx = await boot(root)
    const file = await upload(ctx, 'pending.txt', Buffer.from('pending'))
    const info = await ctx.office.driveFileInfo(lin, file.id)
    const deleted = await ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: file.revision, action: 'trash' })
    const input = confirmation(ctx, file.id)
    const remove = vi.spyOn(OfficeDriveBlobStore.prototype, 'remove').mockRejectedValueOnce(new Error('Owned object is busy'))
    expect(await ctx.office.purgeDrive(lin, input)).toMatchObject({ status: 'pending', completedAt: null })
    expect(ctx.office.driveTrash(lin).entries[0]).toMatchObject({ canTrash: false, canPurge: false, purge: { status: 'pending' } })
    expect(ctx.office.drive(lin, query).quota?.usedBytes).toBe(7)
    await expect(ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: deleted.revision + 1, action: 'restore' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(object(root, info.versionId))).toEqual(Buffer.from('pending'))
    remove.mockRestore()
    await ctx.fiber.dispose()
    ctx = await boot(root)
    expect(ctx.office.drivePurgeStatus(lin, file.id)).toMatchObject({ status: 'completed' })
    expect(ctx.office.drive(lin, query).quota?.usedBytes).toBe(0)
    await expect(readFile(object(root, info.versionId))).rejects.toMatchObject({ code: 'ENOENT' })
    const second = await upload(ctx, 'completion.txt', Buffer.from('retain quota'))
    const secondInfo = await ctx.office.driveFileInfo(lin, second.id)
    await ctx.office.changeDriveLifecycle(lin, { id: second.id, revision: second.revision, action: 'trash' })
    const secondInput = confirmation(ctx, second.id)
    const domain = ctx.storageDomain.get('enterprise_office_drive')!
    const set = domain.global.set.bind(domain.global)
    vi.spyOn(domain.global, 'set').mockImplementationOnce(value => set(value))
      .mockRejectedValueOnce(new Error('Completion record failed'))
    expect(await ctx.office.purgeDrive(lin, secondInput)).toMatchObject({ status: 'pending' })
    await expect(readFile(object(root, secondInfo.versionId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ctx.office.drive(lin, query).quota?.usedBytes).toBe(12)
    expect(await ctx.office.retryDrivePurge(lin, second.id)).toMatchObject({ status: 'completed' })
    expect(ctx.office.drive(lin, query).quota?.usedBytes).toBe(0)
  }, 30_000)

  it('rejects stale approval, revoked parent permissions and another employee subtree without removing bytes', async () => {
    const root = await directory()
    const ctx = await boot(root)
    let folder = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Shared parent' })
    folder = await ctx.office.saveDrivePermissions(admin,
      { id: folder.id, revision: folder.revision, defaultAccess: 'edit', grants: [] })
    const file = await upload(ctx, 'reviewed.txt', Buffer.from('reviewed'), 'shared', folder.id)
    const info = await ctx.office.driveFileInfo(lin, file.id)
    let deleted = await ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: file.revision, action: 'trash' })
    const stale = confirmation(ctx, file.id)
    const restored = await ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: deleted.revision, action: 'restore' })
    deleted = await ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: restored.revision, action: 'trash' })
    await expect(ctx.office.purgeDrive(lin, stale)).rejects.toMatchObject({ code: 'conflict' })
    const current = confirmation(ctx, file.id)
    await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision, defaultAccess: 'view', grants: [] })
    await expect(ctx.office.purgeDrive(lin, current)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.purgeDrive(chen, current)).rejects.toMatchObject({ code: 'not_found' })
    expect(ctx.office.drivePurgeStatus(lin, file.id)).toBeNull()
    expect(await readFile(object(root, info.versionId))).toEqual(Buffer.from('reviewed'))
    let owned = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Mixed ownership' })
    owned = await ctx.office.saveDrivePermissions(admin,
      { id: owned.id, revision: owned.revision, defaultAccess: 'edit', grants: [] })
    await upload(ctx, 'colleague.txt', Buffer.from('other owner'), 'shared', owned.id, chen)
    await ctx.office.changeDriveLifecycle(admin, { id: owned.id, revision: owned.revision, action: 'trash' })
    expect(() => ctx.office.drivePurgePlan(admin, owned.id)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(ctx.office.driveTrash(admin).entries.find(entry => entry.id === owned.id)?.canPurge).toBe(false)
  }, 30_000)

  it('clears nested owned scope while preserving prior receipts and rejects corrupted approval metadata', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const folder = await ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: 'Owned folder' })
    const earlier = await upload(ctx, 'earlier.txt', Buffer.from('earlier'), 'private', folder.id)
    await ctx.office.changeDriveLifecycle(lin, { id: earlier.id, revision: earlier.revision, action: 'trash' })
    const earlierReceipt = await ctx.office.purgeDrive(lin, confirmation(ctx, earlier.id))
    await upload(ctx, 'remaining.txt', Buffer.from('remaining'), 'private', folder.id)
    await ctx.office.changeDriveLifecycle(lin, { id: folder.id, revision: folder.revision, action: 'trash' })
    expect(ctx.office.drivePurgePlan(lin, folder.id)).toMatchObject({ files: 1, folders: 1, versions: 1, byteLength: 9 })
    const input = confirmation(ctx, folder.id)
    vi.spyOn(OfficeDriveBlobStore.prototype, 'remove').mockRejectedValueOnce(new Error('Recover later'))
    expect(await ctx.office.purgeDrive(lin, input)).toMatchObject({ status: 'pending' })
    expect(ctx.office.drivePurgeStatus(lin, earlier.id)).toEqual(earlierReceipt)
    const saved = officeDriveDomain.global.schema.parse(ctx.storageDomain.get('enterprise_office_drive')!.global.get())
    expect(officeDriveDomain.global.schema.safeParse({ ...saved, nodes: saved.nodes.map(entry => entry.id === folder.id
      ? { ...entry, name: 'Corrupted approved scope' } : entry) }).success).toBe(false)
    await expect(ctx.office.purgeDrive(lin, { ...input, requestId: brandString<OfficeDrivePurgeRequestId>(randomUUID()) }))
      .rejects.toMatchObject({ code: 'conflict' })
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    const reopened = await boot(root)
    expect(reopened.office.drivePurgeStatus(lin, folder.id)).toMatchObject({ status: 'completed' })
    expect(reopened.office.drivePurgeStatus(lin, earlier.id)).toEqual(earlierReceipt)
    expect(reopened.office.drive(lin, query).quota?.usedBytes).toBe(0)
  }, 30_000)
})

describe('Drive content versions and recycle bin', () => {
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const upload = (ctx: Context, actor: OfficeMemberId, name: string, bytes: Buffer,
    space: 'private' | 'shared' = 'private', folderId: OfficeDriveId | null = null) =>
    ctx.office.uploadDriveFile(actor, { space, folderId, name, requestId: randomUUID(), mediaType: 'text/plain',
      byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const replace = (file: Awaited<ReturnType<typeof upload>>, bytes: Buffer): OfficeDriveUploadDeclaration => ({
    space: file.space, folderId: file.parentId, name: file.name, target: { id: file.id, revision: file.revision },
    requestId: randomUUID(), mediaType: 'application/octet-stream', byteLength: bytes.length, sha256: digest(bytes),
  })
  const append = (ctx: Context, actor: OfficeMemberId, ticket: OfficeDriveUploadTicket, bytes: Buffer, index: number) => {
    const part = bytes.subarray(index * ticket.chunkBytes, (index + 1) * ticket.chunkBytes)
    return ctx.office.appendDriveUpload(actor, { uploadId: ticket.id, index, sha256: digest(part), dataBase64: part.toString('base64') })
  }

  it('resumes a large reviewed replacement, recovers failed publication and retains original version bytes after restart', async () => {
    const root = await directory()
    let ctx = await boot(root)
    const original = Buffer.from('Original retained version\n')
    const file = await upload(ctx, lin, 'versioned.txt', original)
    const old = await ctx.office.driveFileInfo(lin, file.id)
    const officeFile = await readFile(join(root, 'data/enterprise_office.json'))
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 7).fill(Buffer.from('Actual replacement\0\n'))
    const input = replace(file, bytes)
    let ticket = await ctx.office.beginDriveUpload(lin, input)
    expect(ticket.target).toEqual(input.target)
    await append(ctx, lin, ticket, bytes, 0)
    await ctx.fiber.dispose()
    ctx = await boot(root)
    ticket = await ctx.office.getDriveUpload(lin, ticket.id)
    expect(ticket.received).toEqual([0])
    for (let index = 1; index < Math.ceil(bytes.length / ticket.chunkBytes); index++) await append(ctx, lin, ticket, bytes, index)
    const disk = await readFile(join(root, 'data/enterprise_office_drive.json'))
    const changed: number[] = []
    ctx.on('office/drive-changed', () => { changed.push(1) })
    vi.spyOn(ctx.storageDomain.get('enterprise_office_drive')!.global, 'set').mockRejectedValueOnce(new Error('Directory storage failed'))
    await expect(ctx.office.completeDriveUpload(lin, ticket.id)).rejects.toThrow('Directory storage failed')
    expect(await readFile(join(root, 'data/enterprise_office_drive.json'))).toEqual(disk)
    expect(ctx.office.driveHistory(lin, file.id).versions).toHaveLength(1)
    expect(changed).toEqual([])
    const completed = await ctx.office.completeDriveUpload(lin, ticket.id)
    expect(completed).toMatchObject({ status: 'completed', fileId: file.id })
    expect(await ctx.office.beginDriveUpload(lin, input)).toEqual(completed)
    const history = ctx.office.driveHistory(lin, file.id)
    expect(history.entry).toMatchObject({ id: file.id, revision: file.revision + 1, name: file.name, ownerId: lin })
    expect(history.versions).toHaveLength(2)
    expect(history.versions[0]).toMatchObject({ current: true, sha256: input.sha256, mediaType: input.mediaType, actorId: lin })
    expect(history.versions[1]).toMatchObject({ current: false, versionId: old.versionId, sha256: digest(original), mediaType: 'text/plain' })
    expect(JSON.stringify(history)).not.toContain('requestFingerprint')
    expect(await ctx.office.driveVersionInfo(lin, file.id, old.versionId)).toMatchObject({ ...old, mediaType: 'text/plain' })
    expect(Buffer.from((await ctx.office.downloadDriveRange(lin,
      { id: file.id, versionId: old.versionId, offset: 0, byteLength: original.length })).dataBase64, 'base64')).toEqual(original)
    const current = await ctx.office.driveFileInfo(lin, file.id)
    const parts: Buffer[] = []
    for (let offset = 0; offset < bytes.length; offset += current.chunkBytes) {
      parts.push(Buffer.from((await ctx.office.downloadDriveRange(lin, { id: file.id, versionId: current.versionId,
        offset, byteLength: Math.min(current.chunkBytes, bytes.length - offset) })).dataBase64, 'base64'))
    }
    expect(Buffer.concat(parts)).toEqual(bytes)
    await expect(ctx.office.beginDriveUpload(lin, replace(file, Buffer.from('stale')))).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(root, 'data/enterprise_office.json'))).toEqual(officeFile)
    await ctx.fiber.dispose()
    const reopened = await boot(root)
    expect(reopened.office.driveHistory(lin, file.id)).toEqual(history)
    expect(await reopened.office.driveVersionInfo(lin, file.id, old.versionId)).toMatchObject({ sha256: old.sha256 })
  }, 30_000)

  it('hides deleted directory descendants, retains bytes and restores an unchanged tree under a reviewed conflict-free name', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const folder = await ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: 'Retained folder' })
    const bytes = Buffer.from('Keep child bytes')
    const child = await upload(ctx, lin, 'child.txt', bytes, 'private', folder.id)
    const info = await ctx.office.driveFileInfo(lin, child.id)
    const deleted = await ctx.office.changeDriveLifecycle(lin, { id: folder.id, revision: folder.revision, action: 'trash' })
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: 'child' }).entries).toEqual([])
    expect(ctx.office.driveTrash(lin).entries).toMatchObject([{ id: folder.id, revision: deleted.revision }])
    expect(ctx.office.driveTrash(admin).entries).toEqual([])
    expect(() => ctx.office.driveHistory(lin, child.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
    await expect(ctx.office.driveVersionInfo(lin, child.id, info.versionId)).rejects.toMatchObject({ code: 'not_found' })
    await ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: folder.name })
    const before = await readFile(join(root, 'data/enterprise_office_drive.json'))
    await expect(ctx.office.changeDriveLifecycle(lin, { id: folder.id, revision: deleted.revision, action: 'restore' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(root, 'data/enterprise_office_drive.json'))).toEqual(before)
    const restored = await ctx.office.changeDriveLifecycle(lin,
      { id: folder.id, revision: deleted.revision, action: 'restore', name: 'Restored folder' })
    expect(restored).toMatchObject({ id: folder.id, name: 'Restored folder', ownerId: lin, revision: deleted.revision + 1 })
    expect(ctx.office.driveTrash(lin).entries).toEqual([])
    expect(ctx.office.drive(lin, { space: 'private', folderId: folder.id, search: '' }).entries).toEqual([child])
    expect(await ctx.office.driveFileInfo(lin, child.id)).toEqual(info)
    const stored: unknown = JSON.parse(await readFile(join(root, 'data/enterprise_office_drive.json'), 'utf8'))
    expect(stored).toMatchObject({ global: { audit: [{ action: 'folder_created' }, { action: 'file_uploaded' },
      { action: 'trashed' }, { action: 'folder_created' }, { action: 'restored' }] } })
    await ctx.fiber.dispose()
    const resumed = await boot(root)
    expect(resumed.office.driveTrash(lin).entries).toEqual([])
    expect(await resumed.office.driveVersionInfo(lin, child.id, info.versionId)).toEqual(info)
  })

  it('charges editor reservations to the file owner and rejects stale or changed declarations without leaking history', async () => {
    const ctx = await boot(await directory(), { ...config, driveOwnerQuotaBytes: 20 })
    let folder = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Editable' })
    folder = await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision, defaultAccess: 'edit', grants: [] })
    const file = await upload(ctx, admin, 'shared.txt', Buffer.alloc(6), 'shared', folder.id)
    const input = replace(file, Buffer.alloc(8, 1))
    const ticket = await ctx.office.beginDriveUpload(lin, input)
    await expect(ctx.office.beginDriveUpload(chen, replace(file, Buffer.alloc(8, 2)))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.beginDriveUpload(lin, { ...input, target: { id: file.id, revision: file.revision + 1 } }))
      .rejects.toMatchObject({ code: 'conflict' })
    await append(ctx, lin, ticket, Buffer.alloc(8, 1), 0)
    const completed = await ctx.office.completeDriveUpload(lin, ticket.id)
    expect(completed.fileId).toBe(file.id)
    expect(ctx.office.driveHistory(chen, file.id).versions[0]).toMatchObject({ actorId: lin })
    await expect(ctx.office.beginDriveUpload(chen, replace(file, Buffer.alloc(1)))).rejects.toMatchObject({ code: 'conflict' })
    const current = ctx.office.driveHistory(lin, file.id).entry
    await expect(ctx.office.beginDriveUpload(chen, replace(current, Buffer.alloc(7)))).rejects.toMatchObject({ code: 'invalid_input' })
    const pending = await ctx.office.beginDriveUpload(chen, replace(current, Buffer.alloc(6)))
    await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision, defaultAccess: 'deny', grants: [] })
    expect(() => ctx.office.driveHistory(lin, file.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
    await expect(append(ctx, chen, pending, Buffer.alloc(6), 0)).rejects.toMatchObject({ code: 'not_found' })
    expect(await ctx.office.cancelDriveUpload(chen, pending.id)).toMatchObject({ status: 'cancelled' })
  })

  it('requires owner identity and current parent edit access for deletion and restoration and contains failed commits', async () => {
    const root = await directory()
    const ctx = await boot(root)
    let folder = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Conditions' })
    folder = await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision, defaultAccess: 'edit', grants: [] })
    const file = await upload(ctx, lin, 'owned.txt', Buffer.from('owned'), 'shared', folder.id)
    await expect(ctx.office.changeDriveLifecycle(chen, { id: file.id, revision: file.revision, action: 'trash' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    const before = await readFile(join(root, 'data/enterprise_office_drive.json'))
    vi.spyOn(ctx.storageDomain.get('enterprise_office_drive')!.global, 'set').mockRejectedValueOnce(new Error('Lifecycle storage failed'))
    await expect(ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: file.revision, action: 'trash' }))
      .rejects.toThrow('Lifecycle storage failed')
    expect(await readFile(join(root, 'data/enterprise_office_drive.json'))).toEqual(before)
    expect(ctx.office.driveTrash(lin).entries).toEqual([])
    const trashed = await ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: file.revision, action: 'trash' })
    folder = await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision, defaultAccess: 'deny', grants: [] })
    expect(ctx.office.driveTrash(lin).entries).toEqual([])
    await expect(ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: trashed.revision, action: 'restore' }))
      .rejects.toMatchObject({ code: 'not_found' })
    folder = await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision, defaultAccess: 'view', grants: [] })
    expect(ctx.office.driveTrash(lin).entries[0]).toMatchObject({ id: file.id, canTrash: false })
    await expect(ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: trashed.revision, action: 'restore' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision, defaultAccess: 'edit', grants: [] })
    expect(await ctx.office.changeDriveLifecycle(lin, { id: file.id, revision: trashed.revision, action: 'restore' }))
      .toMatchObject({ id: file.id, name: file.name })
  })
})

describe('Confirmed work lifecycle', () => {
  it.each(['task', 'todo'] as const)('archives, deletes and restores %s without losing work fields or history', async (kind) => {
    const root = await directory()
    const ctx = await boot(root)
    const created = await ctx.office.createWork(lin, { ...work, kind })
    const content = await ctx.office.updateWork(lin, created.id, created.revision,
      { title: created.title, date: created.date, time: created.time, description: 'Retain full work content', priority: 'high' })
    const parent = await ctx.office.updateWorkSubtasks(lin, created.id, content.revision,
      { subtasks: [{ id: null, title: 'Retained checklist', completed: true }] })
    const archived = await ctx.office.changeWorkLifecycle(lin, parent.id, parent.revision, { kind: 'archive', reason: ' Reviewed archive ' })
    expect(archived).toMatchObject({ lifecycle: 'archived', revision: parent.revision + 1,
      lifecycleActions: [{ kind: 'archive', reason: 'Reviewed archive', previous: 'active', actorId: lin }] })
    expect(ctx.office.view(chen, day).items).toEqual([])
    expect(ctx.office.view(chen, day).inactiveWork).toEqual([archived])
    expect(ctx.office.view(chen, day).day).toMatchObject({ items: [], work: 0 })
    expect(() => ctx.office.getItem(lin, parent.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
    await expect(ctx.office.updateWork(chen, parent.id, archived.revision, { title: 'Hidden edit', date: day }))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.setStatus(lin, parent.id, archived.revision, 'completed')).rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.updateWorkSubtasks(lin, parent.id, archived.revision, { subtasks: [] }))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.changeWorkLifecycle(chen, parent.id, archived.revision, { kind: 'restore', reason: 'Assignee cannot restore' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    const path = join(root, 'data/enterprise_office.json')
    const before = await readFile(path)
    expect(await ctx.office.changeWorkLifecycle(lin, parent.id, archived.revision, { kind: 'archive', reason: 'Already archived' }))
      .toEqual(archived)
    expect(await readFile(path)).toEqual(before)
    const deleted = await ctx.office.changeWorkLifecycle(admin, parent.id, archived.revision, { kind: 'delete', reason: 'Move to recycle bin' })
    expect(deleted.lifecycle).toBe('deleted')
    expect(ctx.office.view(xu).inactiveWork).toEqual([])
    await expect(ctx.office.changeWorkLifecycle(lin, parent.id, deleted.revision, { kind: 'archive', reason: 'Invalid transition' }))
      .rejects.toMatchObject({ code: 'conflict' })
    const restored = await ctx.office.changeWorkLifecycle(admin, parent.id, deleted.revision, { kind: 'restore', reason: 'Restore original work' })
    expect(restored.lifecycle).toBeUndefined()
    expect(restored).toMatchObject({ id: parent.id, kind, title: parent.title, description: parent.description,
      status: parent.status, date: parent.date, time: parent.time, ownerId: chen, creatorId: lin, priority: 'high', subtasks: parent.subtasks })
    expect(restored.lifecycleActions?.map(entry => [entry.kind, entry.previous])).toEqual([
      ['archive', 'active'], ['delete', 'archived'], ['restore', 'deleted'],
    ])
    expect(ctx.office.view(chen, day).items).toEqual([restored])
    expect(ctx.office.view(chen, day).inactiveWork).toEqual([])
    expect(ctx.office.view(chen, day).notifications.filter(entry =>
      ['work_archived', 'work_deleted', 'work_restored'].includes(entry.kind) && entry.itemTitle === parent.title))
      .toHaveLength(3)
    expect(ctx.office.audit(admin).slice(-3).map(entry => entry.action)).toEqual(['work_archived', 'work_deleted', 'work_restored'])
    await ctx.fiber.dispose()
    const reopened = await boot(root)
    expect(reopened.office.getItem(lin, parent.id)).toEqual(restored)
  })

  it('contains failed writes and rejects stale, denied, inactive and invalid lifecycle actions', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const parent = await ctx.office.createWork(lin, work)
    const input = { kind: 'delete', reason: 'Confirmed removal' } as const
    const path = join(root, 'data/enterprise_office.json')
    const before = await readFile(path)
    const domain = ctx.storageDomain.get('enterprise_office')!
    const failure = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected lifecycle commit failure'))
    await expect(ctx.office.changeWorkLifecycle(lin, parent.id, parent.revision, input)).rejects.toThrow('Expected lifecycle commit failure')
    failure.mockRestore()
    expect(await readFile(path)).toEqual(before)
    expect(ctx.office.getItem(chen, parent.id)).toEqual(parent)
    await expect(ctx.office.changeWorkLifecycle(chen, parent.id, parent.revision, input)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.changeWorkLifecycle(xu, parent.id, parent.revision, input)).rejects.toMatchObject({ code: 'not_found' })
    for (const reason of [' ', 'x'.repeat(2001)])
      await expect(ctx.office.changeWorkLifecycle(lin, parent.id, parent.revision, { ...input, reason }))
        .rejects.toMatchObject({ code: 'invalid_input' })
    const results = await Promise.allSettled([
      ctx.office.changeWorkLifecycle(lin, parent.id, parent.revision, input),
      ctx.office.changeWorkLifecycle(admin, parent.id, parent.revision, { kind: 'archive', reason: 'Competing update' }),
    ])
    expect(results.map(entry => entry.status)).toEqual(['fulfilled', 'rejected'])
    expect(results[1]).toMatchObject({ reason: { code: 'conflict' } })
    const deleted = ctx.office.view(lin).inactiveWork![0]!
    const committed = await readFile(path)
    expect(await ctx.office.changeWorkLifecycle(lin, parent.id, deleted.revision, input)).toEqual(deleted)
    expect(await readFile(path)).toEqual(committed)
    const event = await ctx.office.createSchedule(lin, meeting)
    await expect(ctx.office.changeWorkLifecycle(lin, event.id, event.revision, input)).rejects.toMatchObject({ code: 'invalid_input' })
    const member = ctx.office.view(lin).me
    await ctx.office.saveMember(admin, { ...member, active: false }, member)
    await expect(ctx.office.changeWorkLifecycle(lin, parent.id, deleted.revision, { kind: 'restore', reason: 'Inactive creator' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    const closed = await ctx.office.createWork(admin, { ...work, ownerId: admin, status: 'completed' })
    const archived = await ctx.office.changeWorkLifecycle(admin, closed.id, closed.revision, { kind: 'archive', reason: 'Archive completed work' })
    expect((await ctx.office.changeWorkLifecycle(admin, closed.id, archived.revision, { kind: 'restore', reason: 'Recover history' })).status)
      .toBe('completed')
  })

  it('invalidates pending delivery through archive and restore while keeping authorized Drive material intact', async () => {
    const ctx = await boot(await directory())
    const bytes = Buffer.from('Retained attachment bytes\0', 'utf8')
    const file = await ctx.office.uploadDriveFile(admin, { space: 'shared', folderId: null, name: 'Retained.bin', requestId: randomUUID(),
      mediaType: 'application/octet-stream', byteLength: bytes.length, dataBase64: bytes.toString('base64') })
    const info = await ctx.office.driveFileInfo(lin, file.id)
    const parent = await ctx.office.createWork(lin, work)
    const linked = await ctx.office.updateWorkAttachments(lin, parent.id, parent.revision,
      { files: [{ id: file.id, versionId: info.versionId }] })
    const running = await ctx.office.decideTask(chen, parent.id, linked.revision, { kind: 'accept' })
    const submitted = await ctx.office.reviewTaskDelivery(chen, parent.id, running.revision, { kind: 'submit', reason: 'Ready for review' })
    const archived = await ctx.office.changeWorkLifecycle(lin, parent.id, submitted.revision, { kind: 'archive', reason: 'Review later' })
    expect(await ctx.office.workAttachmentInfo(chen, parent.id, file.id)).toEqual(info)
    await expect(ctx.office.reviewTaskDelivery(lin, parent.id, archived.revision, { kind: 'accept', reason: 'Inactive work' }))
      .rejects.toMatchObject({ code: 'not_found' })
    const restored = await ctx.office.changeWorkLifecycle(lin, parent.id, archived.revision, { kind: 'restore', reason: 'Resume work' })
    expect(restored.attachments).toEqual(linked.attachments)
    await expect(ctx.office.reviewTaskDelivery(lin, parent.id, restored.revision, { kind: 'accept', reason: 'Stale delivery' }))
      .rejects.toMatchObject({ code: 'conflict' })
    const resubmitted = await ctx.office.reviewTaskDelivery(chen, parent.id, restored.revision, { kind: 'submit', reason: 'Rechecked materials' })
    expect((await ctx.office.reviewTaskDelivery(lin, parent.id, resubmitted.revision, { kind: 'accept', reason: 'Confirmed' })).status)
      .toBe('completed')
    expect((await ctx.office.driveFileInfo(lin, file.id)).sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
})

describe('Reviewed work attachments', () => {
  const bytes = Buffer.from('attachment\0binary\n资料', 'utf8')
  async function upload(ctx: Context, space: 'private' | 'shared', name = 'reviewed.bin') {
    let folderId: OfficeDriveId | null = null
    if (space === 'shared') {
      const folder = await ctx.office.createDriveFolder(admin, { space, folderId: null, name: randomUUID() })
      await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision,
        defaultAccess: 'view', grants: [{ memberId: lin, access: 'edit' }] })
      folderId = folder.id
    }
    const entry = await ctx.office.uploadDriveFile(lin, { space, folderId, name, requestId: randomUUID(),
      mediaType: 'application/octet-stream', byteLength: bytes.length, dataBase64: bytes.toString('base64') })
    const info = await ctx.office.driveFileInfo(lin, entry.id)
    return { entry, file: { id: entry.id, versionId: info.versionId } }
  }

  it('links reviewed versions without granting private access, preserves parent fields and survives restart', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const parent = await ctx.office.createWork(lin, work)
    const privateFile = await upload(ctx, 'private', 'Private name.bin')
    const shared = await upload(ctx, 'shared')
    const linked = await ctx.office.updateWorkAttachments(lin, parent.id, parent.revision,
      { files: [privateFile.file, shared.file] })
    expect(linked).toMatchObject({ ...parent, revision: parent.revision + 1, updatedAt: linked.updatedAt,
      attachments: [privateFile.file, shared.file] })
    expect(ctx.office.workAttachments(chen, parent.id).files).toEqual([
      { ...privateFile.file, available: false }, { ...shared.file, available: true,
        name: shared.entry.name, mediaType: 'application/octet-stream', byteLength: bytes.length }])
    await expect(ctx.office.workAttachmentInfo(chen, parent.id, privateFile.file.id)).rejects.toMatchObject({ code: 'not_found' })
    const info = await ctx.office.workAttachmentInfo(chen, parent.id, shared.file.id)
    const range = await ctx.office.downloadDriveRange(chen,
      { id: info.id, versionId: info.versionId, offset: 0, byteLength: info.byteLength })
    expect(Buffer.from(range.dataBase64, 'base64')).toEqual(bytes)
    const path = join(root, 'data/enterprise_office.json')
    const before = await readFile(path)
    expect(await ctx.office.updateWorkAttachments(chen, parent.id, linked.revision, { files: linked.attachments! })).toEqual(linked)
    expect(await readFile(path)).toEqual(before)
    const reduced = await ctx.office.updateWorkAttachments(chen, parent.id, linked.revision, { files: [privateFile.file] })
    await expect(ctx.office.workAttachmentInfo(lin, parent.id, shared.file.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await ctx.office.driveFileInfo(lin, shared.file.id)).versionId).toBe(shared.file.versionId)
    expect(ctx.office.audit(admin).filter(entry => entry.action === 'work_attachments_updated')).toHaveLength(2)
    await ctx.fiber.dispose()
    const restored = await boot(root)
    expect(restored.office.getItem(lin, parent.id)).toEqual(reduced)
    const todo = await restored.office.createWork(lin, { ...work, kind: 'todo' })
    expect((await restored.office.updateWorkAttachments(lin, todo.id, todo.revision, { files: [shared.file] })).kind).toBe('todo')
  })

  it('rejects invalid, denied, stale and closed references and keeps failed or concurrent updates atomic', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const parent = await ctx.office.createWork(lin, work)
    const { file } = await upload(ctx, 'private')
    const path = join(root, 'data/enterprise_office.json')
    const before = await readFile(path)
    const domain = ctx.storageDomain.get('enterprise_office')!
    const failed = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected attachment commit failure'))
    await expect(ctx.office.updateWorkAttachments(lin, parent.id, parent.revision, { files: [file] }))
      .rejects.toThrow('Expected attachment commit failure')
    failed.mockRestore()
    for (const input of [{ files: [file, file] }, { files: [{ ...file, name: 'Forged' }] },
      { files: Array.from({ length: 21 }, () => ({ ...file, id: brandString<typeof file.id>(randomUUID()) })) }])
      await expect(ctx.office.updateWorkAttachments(lin, parent.id, parent.revision, input)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.updateWorkAttachments(chen, parent.id, parent.revision, { files: [file] })).rejects.toMatchObject({ code: 'not_found' })
    expect(() => ctx.office.workAttachments(xu, parent.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(await readFile(path)).toEqual(before)
    const results = await Promise.allSettled([
      ctx.office.updateWorkAttachments(lin, parent.id, parent.revision, { files: [file] }),
      ctx.office.updateWorkAttachments(lin, parent.id, parent.revision, { files: [file] }),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(results[1]).toMatchObject({ reason: { code: 'conflict' } })
    const current = ctx.office.getItem(lin, parent.id)
    const closed = await ctx.office.setStatus(lin, parent.id, current.revision, 'cancelled')
    await expect(ctx.office.updateWorkAttachments(lin, parent.id, closed.revision, { files: [] })).rejects.toMatchObject({ code: 'conflict' })
    const employee = ctx.office.view(chen).me
    await ctx.office.saveMember(admin, { ...employee, active: false }, employee)
    await expect(ctx.office.workAttachmentInfo(chen, parent.id, file.id)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('requires currently readable reviewed versions for delivery, but allows return and explicit removal', async () => {
    const ctx = await boot(await directory())
    const parent = await ctx.office.createWork(lin, work)
    const shared = await upload(ctx, 'shared')
    const linked = await ctx.office.updateWorkAttachments(lin, parent.id, parent.revision, { files: [shared.file] })
    const running = await ctx.office.decideTask(chen, parent.id, linked.revision, { kind: 'accept' })
    const submitted = await ctx.office.reviewTaskDelivery(chen, parent.id, running.revision, { kind: 'submit', reason: 'Ready' })
    const denied = await ctx.office.saveDrivePermissions(lin,
      { id: shared.entry.id, revision: shared.entry.revision, defaultAccess: 'deny', grants: [] })
    expect(ctx.office.workAttachments(chen, parent.id).files).toEqual([{ ...shared.file, available: false }])
    await expect(ctx.office.workAttachmentInfo(chen, parent.id, shared.file.id)).rejects.toMatchObject({ code: 'not_found' })
    const returned = await ctx.office.reviewTaskDelivery(lin, parent.id, submitted.revision, { kind: 'return', reason: 'Fix access' })
    await expect(ctx.office.reviewTaskDelivery(chen, parent.id, returned.revision, { kind: 'submit', reason: 'No access' }))
      .rejects.toMatchObject({ code: 'not_found' })
    await ctx.office.saveDrivePermissions(lin, { id: shared.entry.id, revision: denied.revision, defaultAccess: 'view', grants: [] })
    const resubmitted = await ctx.office.reviewTaskDelivery(chen, parent.id, returned.revision, { kind: 'submit', reason: 'Shared' })
    // Version replacement uses the authoritative repository fixture; public version CRUD is separate work.
    const drive = ctx.storageDomain.get('enterprise_office_drive')! as Domain<typeof officeDriveDomain>
    const state = drive.global.get()
    const nextVersion = brandString<OfficeDriveVersionId>(randomUUID())
    await drive.global.set({ ...state, nodes: state.nodes.map(node => node.id === shared.file.id ? {
      ...node, versions: [...node.versions, { ...node.versions.at(-1)!, id: nextVersion, requestId: randomUUID() }],
    } : node) })
    expect(ctx.office.workAttachments(lin, parent.id).files[0]).toEqual({ ...shared.file, available: false })
    await expect(ctx.office.reviewTaskDelivery(lin, parent.id, resubmitted.revision, { kind: 'accept', reason: 'Stale file' }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.updateWorkAttachments(lin, parent.id, resubmitted.revision,
      { files: [{ ...shared.file, versionId: brandString<OfficeDriveVersionId>(randomUUID()) }] }))
      .rejects.toMatchObject({ code: 'conflict' })
    const cleared = await ctx.office.updateWorkAttachments(lin, parent.id, resubmitted.revision, { files: [] })
    await expect(ctx.office.reviewTaskDelivery(lin, parent.id, cleared.revision, { kind: 'accept', reason: 'Old submission' }))
      .rejects.toMatchObject({ code: 'conflict' })
    const final = await ctx.office.reviewTaskDelivery(chen, parent.id, cleared.revision, { kind: 'submit', reason: 'Removed obsolete file' })
    expect((await ctx.office.reviewTaskDelivery(lin, parent.id, final.revision, { kind: 'accept', reason: 'Verified' })).status).toBe('completed')
  })
})

describe('Work priority changes', () => {
  it.each(['task', 'todo'] as const)('retains %s metadata, history and legacy priority omissions across restart', async (kind) => {
    const root = await directory()
    const ctx = await boot(root)
    let original = await ctx.office.createWork(lin, { ...work, kind })
    if (kind === 'task') original = await ctx.office.decideTask(chen, original.id, original.revision, { kind: 'accept' })
    else original = await ctx.office.decideTask(lin, original.id, original.revision,
      { kind: 'transfer', ownerId: xu, reason: '交接后安排优先级' })
    const input = { title: original.title, description: original.description, date: original.date, time: original.time }
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    expect(await ctx.office.updateWork(lin, original.id, original.revision, { ...input, priority: 'normal' })).toEqual(original)
    expect(await readFile(path)).toEqual(before)
    const high = await ctx.office.updateWork(lin, original.id, original.revision, { ...input, priority: 'high' })
    expect(high).toMatchObject({ priority: 'high', ownerId: original.ownerId, creatorId: lin, status: original.status, date: original.date })
    expect(high.taskActions).toEqual(original.taskActions)
    expect(high.todoAssignments).toEqual(original.todoAssignments)
    const legacy = await ctx.office.updateWork(admin, original.id, high.revision, { ...input, description: '旧调用仍保留优先级' })
    expect(legacy.priority).toBe('high')
    const unchanged = await readFile(path)
    expect(await ctx.office.updateWork(lin, original.id, legacy.revision,
      { ...input, description: legacy.description, priority: 'high' })).toEqual(legacy)
    expect(await readFile(path)).toEqual(unchanged)
    const cleared = await ctx.office.updateWork(lin, original.id, legacy.revision,
      { ...input, description: legacy.description, priority: 'normal' })
    expect(cleared.priority).toBeUndefined()
    expect(ctx.office.view(original.ownerId).notifications.filter(entry => entry.kind === 'work_prioritized')).toHaveLength(2)
    expect(ctx.office.audit(admin).filter(entry => entry.action === 'work_prioritized')).toHaveLength(2)
    await ctx.fiber.dispose()
    const restored = await boot(root)
    expect(restored.office.getItem(lin, original.id)).toEqual(cleared)
    expect(restored.office.getItem(lin, original.id).taskActions).toEqual(original.taskActions)
    expect(restored.office.getItem(lin, original.id).todoAssignments).toEqual(original.todoAssignments)
  })

  it('rejects unauthorized, stale and closed priorities and publishes no result after failed storage', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const item = await ctx.office.createWork(lin, work)
    const input = { title: item.title, date: item.date, time: item.time, priority: 'urgent' as const }
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    await expect(ctx.office.updateWork(xu, item.id, item.revision, input)).rejects.toMatchObject({ code: 'not_found' })
    const domain = ctx.storageDomain.get('enterprise_office')!
    const failure = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected priority commit failure'))
    await expect(ctx.office.updateWork(lin, item.id, item.revision, input)).rejects.toThrow('Expected priority commit failure')
    failure.mockRestore()
    expect(await readFile(path)).toEqual(before)
    const updated = await ctx.office.updateWork(lin, item.id, item.revision, input)
    const committed = await readFile(path)
    await expect(ctx.office.updateWork(chen, item.id, item.revision, { ...input, priority: 'low' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(path)).toEqual(committed)
    const closed = await ctx.office.setStatus(lin, item.id, updated.revision, 'completed')
    const closedBytes = await readFile(path)
    await expect(ctx.office.updateWork(chen, item.id, closed.revision, { ...input, priority: 'low' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(path)).toEqual(closedBytes)
  })
})

describe('To-do reassignment', () => {
  it('retains content, deadlines and assignment history through transfers, metadata edits and restart', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const original = await ctx.office.createWork(lin, { ...work, kind: 'todo', status: 'in_progress' })
    const moved = await ctx.office.decideTask(chen, original.id, original.revision,
      { kind: 'transfer', ownerId: xu, reason: '由财务核对' })
    expect(moved).toMatchObject({ id: original.id, kind: 'todo', title: original.title, date: original.date, time: original.time,
      creatorId: lin, ownerId: xu, status: 'pending', revision: original.revision + 1 })
    expect(moved.taskActions).toBeUndefined()
    expect(moved.todoAssignments).toEqual([expect.objectContaining({ kind: 'transfer', actorId: chen,
      fromOwnerId: chen, toOwnerId: xu, reason: '由财务核对', revision: moved.revision })])
    expect(() => ctx.office.getItem(chen, original.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
    const edited = await ctx.office.updateWork(xu, original.id, moved.revision,
      { title: moved.title, description: '保留交接记录', date: moved.date, time: moved.time })
    expect(edited.todoAssignments).toEqual(moved.todoAssignments)
    const returned = await ctx.office.decideTask(lin, original.id, edited.revision,
      { kind: 'transfer', ownerId: chen, reason: '复核完毕' })
    expect(returned.todoAssignments).toHaveLength(2)
    expect(ctx.office.view(xu).notifications.filter(entry => entry.kind === 'todo_reassigned')).toHaveLength(2)
    expect(ctx.office.view(xu).notifications.at(-1)).toMatchObject({ itemId: original.id, itemTitle: original.title, actorId: lin })
    expect(ctx.office.audit(admin).filter(entry => entry.action === 'todo_reassigned').map(entry => entry.actorId)).toEqual([chen, lin])
    await ctx.fiber.dispose()
    const restored = await boot(root)
    expect(restored.office.getItem(chen, original.id)).toEqual(returned)
  })

  it('rejects non-transfer decisions, hidden callers, same or inactive targets, stale versions and closed to-dos', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const original = await ctx.office.createWork(lin, { ...work, kind: 'todo' })
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    for (const input of [{ kind: 'accept' } as const, { kind: 'reject', reason: '不支持拒绝待办' } as const])
      await expect(ctx.office.decideTask(chen, original.id, original.revision, input)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.decideTask(xu, original.id, original.revision, { kind: 'transfer', ownerId: xu, reason: '越权' }))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.decideTask(chen, original.id, original.revision, { kind: 'transfer', ownerId: chen, reason: '相同' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.decideTask(chen, original.id, original.revision, { kind: 'transfer', ownerId: xu, reason: '  ' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(await readFile(path)).toEqual(before)
    const member = ctx.office.view(admin).managedMembers?.find(entry => entry.id === xu)
    if (!member) throw new Error('Expected configured to-do recipient')
    await ctx.office.saveMember(admin, { ...member, active: false }, member)
    const inactive = await readFile(path)
    await expect(ctx.office.decideTask(lin, original.id, original.revision, { kind: 'transfer', ownerId: xu, reason: '目标停用' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(await readFile(path)).toEqual(inactive)
    const closed = await ctx.office.setStatus(lin, original.id, original.revision, 'completed')
    const closedBytes = await readFile(path)
    await expect(ctx.office.decideTask(chen, original.id, original.revision, { kind: 'transfer', ownerId: lin, reason: '过期' }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.decideTask(chen, original.id, closed.revision, { kind: 'transfer', ownerId: lin, reason: '已结束' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(path)).toEqual(closedBytes)
  })

  it('withholds assignment history, notifications and audit after a failed transfer commit', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const original = await ctx.office.createWork(lin, { ...work, kind: 'todo' })
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    const domain = ctx.storageDomain.get('enterprise_office')!
    const failure = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected to-do transfer failure'))
    await expect(ctx.office.decideTask(chen, original.id, original.revision, { kind: 'transfer', ownerId: xu, reason: '不能发布' }))
      .rejects.toThrow('Expected to-do transfer failure')
    failure.mockRestore()
    expect(await readFile(path)).toEqual(before)
    expect(ctx.office.getItem(chen, original.id)).toEqual(original)
    expect(ctx.office.view(lin).notifications).toEqual([])
  })
})

describe('Work content editing', () => {
  it('edits task content and deadline without changing decisions, assignment or state across restart', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const task = await ctx.office.createWork(lin, work)
    const accepted = await ctx.office.decideTask(chen, task.id, task.revision, { kind: 'accept' })
    const changed = await ctx.office.updateWork(chen, task.id, accepted.revision,
      { title: '修订周报', description: '补充统计口径', date: '2026-10-21', time: '14:30' })
    expect(changed).toMatchObject({ id: task.id, kind: 'task', ownerId: chen, creatorId: lin, status: 'in_progress',
      title: '修订周报', description: '补充统计口径', date: '2026-10-21', time: '14:30', revision: accepted.revision + 1 })
    expect(changed.taskActions).toEqual(accepted.taskActions)
    const cleared = await ctx.office.updateWork(lin, task.id, changed.revision,
      { title: changed.title, description: changed.description, date: changed.date })
    expect(cleared.time).toBeUndefined()
    expect(cleared.taskActions).toEqual(accepted.taskActions)
    expect(ctx.office.view(lin).notifications.filter(entry => entry.kind === 'work_updated')).toHaveLength(1)
    expect(ctx.office.view(chen).notifications.filter(entry => entry.kind === 'work_updated')).toHaveLength(1)
    await ctx.fiber.dispose()
    const restored = await boot(root)
    expect(restored.office.getItem(chen, task.id)).toEqual(cleared)
  })

  it('preserves bytes for unchanged, invalid, stale, unauthorized and closed work edits', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const todo = await ctx.office.createWork(lin, { ...work, kind: 'todo' })
    const input = { title: todo.title, description: todo.description, date: todo.date, time: todo.time }
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    expect(await ctx.office.updateWork(admin, todo.id, todo.revision, input)).toEqual(todo)
    await expect(ctx.office.updateWork(xu, todo.id, todo.revision, input)).rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.updateWork(lin, todo.id, todo.revision, { ...input, date: '2026-02-30' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(await readFile(path)).toEqual(before)
    const edited = await ctx.office.updateWork(admin, todo.id, todo.revision, { ...input, title: '管理员修订待办' })
    const changed = await readFile(path)
    await expect(ctx.office.updateWork(chen, todo.id, todo.revision, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(path)).toEqual(changed)
    const closed = await ctx.office.setStatus(lin, todo.id, edited.revision, 'cancelled')
    const closedBytes = await readFile(path)
    await expect(ctx.office.updateWork(lin, todo.id, closed.revision, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(path)).toEqual(closedBytes)
  })

  it('publishes no metadata or notifications after an edit write fails and rejects meeting input', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const task = await ctx.office.createWork(lin, work)
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    const domain = ctx.storageDomain.get('enterprise_office')!
    const failure = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected work edit failure'))
    await expect(ctx.office.updateWork(chen, task.id, task.revision, { title: '不能发布', date: day }))
      .rejects.toThrow('Expected work edit failure')
    failure.mockRestore()
    expect(await readFile(path)).toEqual(before)
    expect(ctx.office.getItem(chen, task.id)).toEqual(task)
    expect(ctx.office.view(lin).notifications).toEqual([])
    const event = await ctx.office.createSchedule(lin, meeting)
    await expect(ctx.office.updateWork(lin, event.id, event.revision, { title: '不是普通事项', date: day }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('Task assignee decisions', () => {
  it('commits one concurrent acceptance and rechecks a queued transfer target after deactivation', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const task = await ctx.office.createWork(lin, work)
    const attempts = await Promise.allSettled([ctx.office.decideTask(chen, task.id, task.revision, { kind: 'accept' }),
      ctx.office.decideTask(chen, task.id, task.revision, { kind: 'accept' })])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }])
    const accepted = ctx.office.getItem(chen, task.id)
    expect(accepted.taskActions).toHaveLength(1)
    expect(ctx.office.view(lin).notifications.filter(entry => entry.kind === 'task_accepted')).toHaveLength(1)
    const target = ctx.office.view(admin).managedMembers?.find(member => member.id === xu)
    if (!target) throw new Error('Expected configured transfer target')
    const disabling = ctx.office.saveMember(admin, { ...target, active: false }, target)
    const transfer = expect(ctx.office.decideTask(chen, task.id, accepted.revision,
      { kind: 'transfer', ownerId: xu, reason: '排队时目标已停用' })).rejects.toMatchObject({ code: 'forbidden' })
    await disabling
    const bytes = await readFile(join(root, 'data', 'enterprise_office.json'))
    await transfer
    expect(ctx.office.getItem(chen, task.id)).toEqual(accepted)
    expect(await readFile(join(root, 'data', 'enterprise_office.json'))).toEqual(bytes)
  })

  it('retains task identity, reasons, ownership and notifications through acceptance, transfer, rejection and restart', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const created = await ctx.office.createWork(lin, work)
    const accepted = await ctx.office.decideTask(chen, created.id, created.revision, { kind: 'accept' })
    expect(accepted).toMatchObject({ id: created.id, creatorId: lin, ownerId: chen, status: 'in_progress', revision: 2 })
    const transferred = await ctx.office.decideTask(chen, created.id, accepted.revision,
      { kind: 'transfer', ownerId: xu, reason: '  需要财务核对  ' })
    expect(transferred).toMatchObject({ id: created.id, creatorId: lin, ownerId: xu, status: 'pending', revision: 3 })
    expect(() => ctx.office.getItem(chen, created.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
    const rejected = await ctx.office.decideTask(xu, created.id, transferred.revision,
      { kind: 'reject', reason: '缺少原始单据' })
    expect(rejected).toMatchObject({ id: created.id, creatorId: lin, ownerId: xu, status: 'cancelled', revision: 4,
      createdAt: created.createdAt, title: created.title })
    expect(rejected.taskActions).toEqual([
      expect.objectContaining({ kind: 'accept', actorId: chen, fromOwnerId: chen, toOwnerId: chen, reason: '', revision: 2 }),
      expect.objectContaining({ kind: 'transfer', actorId: chen, fromOwnerId: chen, toOwnerId: xu, reason: '需要财务核对', revision: 3 }),
      expect.objectContaining({ kind: 'reject', actorId: xu, fromOwnerId: xu, toOwnerId: xu, reason: '缺少原始单据', revision: 4 }),
    ])
    expect(rejected.taskActions?.every(action => action.time >= created.createdAt)).toBe(true)
    expect(ctx.office.view(lin).notifications.filter(entry => entry.itemId === created.id).map(entry => entry.kind))
      .toEqual(['task_accepted', 'task_transferred', 'task_rejected'])
    expect(ctx.office.view(xu).notifications.find(entry => entry.kind === 'task_transferred'))
      .toMatchObject({ itemId: created.id, itemTitle: created.title, actorId: chen })
    expect(ctx.office.audit(admin).filter(entry => entry.targetId === created.id).map(entry => entry.action))
      .toEqual(['work_created', 'task_accepted', 'task_transferred', 'task_rejected'])
    await ctx.fiber.dispose()
    const restored = await boot(root)
    expect(restored.office.getItem(xu, created.id)).toEqual(rejected)
    expect(restored.office.view(lin).notifications).toHaveLength(3)
  })

  it('rejects unauthorized, stale, invalid-target and closed decisions without changing durable bytes', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const created = await ctx.office.createWork(lin, work)
    const statePath = join(root, 'data', 'enterprise_office.json')
    const baseline = await readFile(statePath)
    for (const actor of [lin, admin]) {
      await expect(ctx.office.decideTask(actor, created.id, created.revision, { kind: 'accept' })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(ctx.office.decideTask(actor, created.id, created.revision, { kind: 'reject', reason: '不能代替负责人拒绝' }))
        .rejects.toMatchObject({ code: 'forbidden' })
    }
    await expect(ctx.office.decideTask(xu, created.id, created.revision, { kind: 'transfer', ownerId: xu, reason: '越权转交' }))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.decideTask(chen, created.id, created.revision, { kind: 'reject', reason: '  ' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.decideTask(chen, created.id, created.revision, { kind: 'transfer', ownerId: chen, reason: '无变化' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.decideTask(chen, created.id, created.revision, { kind: 'transfer', ownerId: brandString<OfficeMemberId>('missing'), reason: '目标不存在' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(await readFile(statePath)).toEqual(baseline)
    const accepted = await ctx.office.decideTask(chen, created.id, created.revision, { kind: 'accept' })
    const after = await readFile(statePath)
    await expect(ctx.office.decideTask(chen, created.id, created.revision, { kind: 'transfer', ownerId: xu, reason: '过期' }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.decideTask(chen, created.id, accepted.revision, { kind: 'accept' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(statePath)).toEqual(after)
    const closed = await ctx.office.setStatus(lin, created.id, accepted.revision, 'completed')
    const closedBytes = await readFile(statePath)
    await expect(ctx.office.decideTask(chen, created.id, closed.revision, { kind: 'transfer', ownerId: xu, reason: '已经结束' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(statePath)).toEqual(closedBytes)
  })

  it('allows reviewed creator or administrator transfers, not acceptance, and retains the former owner notification', async () => {
    const ctx = await boot(await directory())
    const created = await ctx.office.createWork(lin, work)
    const moved = await ctx.office.decideTask(lin, created.id, created.revision, { kind: 'transfer', ownerId: xu, reason: '调整分工' })
    const again = await ctx.office.decideTask(admin, created.id, moved.revision, { kind: 'transfer', ownerId: chen, reason: '管理员调整' })
    expect(again.taskActions?.map(action => action.actorId)).toEqual([lin, admin])
    expect(ctx.office.view(xu).notifications.filter(entry => entry.kind === 'task_transferred')).toHaveLength(2)
    expect(() => ctx.office.getItem(xu, created.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(ctx.office.view(xu).notifications.at(-1)).toMatchObject({ itemId: created.id, itemTitle: created.title, actorId: admin })
    expect(ctx.office.getItem(chen, created.id)).toEqual(again)
  })

  it('publishes no decision history, notifications or audit after storage failure and preserves original status edits', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const created = await ctx.office.createWork(lin, work)
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    const domain = ctx.storageDomain.get('enterprise_office')!
    const failure = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected task decision failure'))
    await expect(ctx.office.decideTask(chen, created.id, created.revision, { kind: 'accept' })).rejects.toThrow('Expected task decision failure')
    failure.mockRestore()
    expect(await readFile(path)).toEqual(before)
    expect(ctx.office.getItem(chen, created.id)).toEqual(created)
    expect(ctx.office.view(lin).notifications).toEqual([])
    const accepted = await ctx.office.decideTask(chen, created.id, created.revision, { kind: 'accept' })
    const completed = await ctx.office.setStatus(chen, created.id, accepted.revision, 'completed')
    expect(completed.taskActions).toEqual(accepted.taskActions)
    expect(completed.status).toBe('completed')
    const todo = await ctx.office.createWork(lin, { ...work, kind: 'todo' })
    await expect(ctx.office.decideTask(chen, todo.id, todo.revision, { kind: 'accept' })).rejects.toMatchObject({ code: 'invalid_input' })
    const event = await ctx.office.createSchedule(lin, meeting)
    await expect(ctx.office.decideTask(lin, event.id, event.revision, { kind: 'accept' })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('Task deliveries', () => {
  it('retains reasoned submission, return and acceptance across restart with atomic recipient notices', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const parent = await ctx.office.createWork(lin, work)
    const running = await ctx.office.decideTask(chen, parent.id, parent.revision, { kind: 'accept' })
    const submitted = await ctx.office.reviewTaskDelivery(chen, parent.id, running.revision,
      { kind: 'submit', reason: 'Initial report attached to the working record' })
    expect(submitted.status).toBe('in_progress')
    expect(submitted.deliveries).toEqual([{ kind: 'submit', actorId: chen, ownerId: chen,
      reason: 'Initial report attached to the working record', time: submitted.updatedAt, revision: submitted.revision }])
    await expect(ctx.office.setStatus(chen, parent.id, submitted.revision, 'completed')).rejects.toMatchObject({ code: 'conflict' })
    const returned = await ctx.office.reviewTaskDelivery(lin, parent.id, submitted.revision,
      { kind: 'return', reason: 'Add the missing totals' })
    expect(returned.status).toBe('in_progress')
    const revised = await ctx.office.reviewTaskDelivery(chen, parent.id, returned.revision,
      { kind: 'submit', reason: 'Totals verified and added' })
    const accepted = await ctx.office.reviewTaskDelivery(admin, parent.id, revised.revision,
      { kind: 'accept', reason: 'Reviewed totals and confirmed delivery' })
    expect(accepted.status).toBe('completed')
    expect(accepted.deliveries?.map(entry => entry.kind)).toEqual(['submit', 'return', 'submit', 'accept'])
    expect(accepted).toMatchObject({ id: parent.id, creatorId: lin, ownerId: chen, date: parent.date, time: parent.time })
    expect(ctx.office.view(lin).notifications).toContainEqual(expect.objectContaining({ itemId: parent.id, kind: 'delivery_submitted' }))
    expect(ctx.office.view(chen).notifications).toContainEqual(expect.objectContaining({ itemId: parent.id, kind: 'delivery_returned' }))
    expect(ctx.office.view(chen).notifications).toContainEqual(expect.objectContaining({ itemId: parent.id, kind: 'delivery_accepted' }))
    await ctx.fiber.dispose()
    const reopened = await boot(root)
    expect(reopened.office.getItem(chen, parent.id)).toEqual(accepted)
  })

  it('rejects unstarted work, unauthorized decisions, malformed reasons and closed/non-task items without writes', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const parent = await ctx.office.createWork(lin, work)
    await expect(ctx.office.reviewTaskDelivery(chen, parent.id, parent.revision, { kind: 'submit', reason: 'Not accepted yet' }))
      .rejects.toMatchObject({ code: 'conflict' })
    const running = await ctx.office.decideTask(chen, parent.id, parent.revision, { kind: 'accept' })
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    await expect(ctx.office.reviewTaskDelivery(lin, parent.id, running.revision, { kind: 'submit', reason: 'Not the assignee' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.reviewTaskDelivery(chen, parent.id, running.revision, { kind: 'accept', reason: 'Self review' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.reviewTaskDelivery(xu, parent.id, running.revision, { kind: 'return', reason: 'Hidden task' }))
      .rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.reviewTaskDelivery(chen, parent.id, running.revision, { kind: 'submit', reason: ' ' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(await readFile(path)).toEqual(before)
    const legacy = await ctx.office.setStatus(chen, parent.id, running.revision, 'completed')
    expect(legacy.status).toBe('completed')
    await expect(ctx.office.reviewTaskDelivery(chen, parent.id, legacy.revision, { kind: 'submit', reason: 'Closed work' }))
      .rejects.toMatchObject({ code: 'conflict' })
    const todo = await ctx.office.createWork(lin, { ...work, kind: 'todo' })
    await expect(ctx.office.reviewTaskDelivery(chen, todo.id, todo.revision, { kind: 'submit', reason: 'Not a task' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    const target = ctx.office.view(admin).members.find(member => member.id === chen)!
    await ctx.office.saveMember(admin, { ...target, active: false }, target)
    await expect(ctx.office.reviewTaskDelivery(chen, parent.id, legacy.revision, { kind: 'submit', reason: 'Inactive actor' }))
      .rejects.toMatchObject({ code: 'forbidden' })
  })

  it('contains failed writes and invalidates review after work edits or transfer before a new assignee resubmits', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const parent = await ctx.office.createWork(lin, work)
    const running = await ctx.office.decideTask(chen, parent.id, parent.revision, { kind: 'accept' })
    const input = { kind: 'submit' as const, reason: 'Ready for review' }
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    const domain = ctx.storageDomain.get('enterprise_office')!
    const failed = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected delivery commit failure'))
    await expect(ctx.office.reviewTaskDelivery(chen, parent.id, running.revision, input)).rejects.toThrow('Expected delivery commit failure')
    failed.mockRestore()
    expect(await readFile(path)).toEqual(before)
    expect(ctx.office.getItem(chen, parent.id)).toEqual(running)
    const results = await Promise.allSettled([ctx.office.reviewTaskDelivery(chen, parent.id, running.revision, input),
      ctx.office.reviewTaskDelivery(chen, parent.id, running.revision, input)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }])
    const submitted = ctx.office.getItem(chen, parent.id)
    const edited = await ctx.office.updateWork(lin, parent.id, submitted.revision, { title: 'Changed report', date: day })
    await expect(ctx.office.reviewTaskDelivery(lin, parent.id, edited.revision, { kind: 'accept', reason: 'Stale submission' }))
      .rejects.toMatchObject({ code: 'conflict' })
    const resubmitted = await ctx.office.reviewTaskDelivery(chen, parent.id, edited.revision, input)
    const transferred = await ctx.office.decideTask(lin, parent.id, resubmitted.revision,
      { kind: 'transfer', ownerId: xu, reason: 'Review the handoff' })
    await expect(ctx.office.reviewTaskDelivery(lin, parent.id, transferred.revision, { kind: 'accept', reason: 'Old owner submission' }))
      .rejects.toMatchObject({ code: 'conflict' })
    const acceptedWork = await ctx.office.decideTask(xu, parent.id, transferred.revision, { kind: 'accept' })
    const newDelivery = await ctx.office.reviewTaskDelivery(xu, parent.id, acceptedWork.revision, input)
    const confirmed = await ctx.office.reviewTaskDelivery(lin, parent.id, newDelivery.revision, { kind: 'accept', reason: 'New owner verified' })
    expect(confirmed.status).toBe('completed')
    expect(confirmed.deliveries?.at(-1)).toMatchObject({ kind: 'accept', ownerId: xu, actorId: lin })
  })
})

describe('Work subtask lists', () => {
  it.each(['task', 'todo'] as const)('retains %s subtask identities, work metadata and current-owner access through restart', async (kind) => {
    const root = await directory()
    const ctx = await boot(root)
    const parent = await ctx.office.createWork(lin, { ...work, kind })
    const added = await ctx.office.updateWorkSubtasks(lin, parent.id, parent.revision,
      { subtasks: [{ id: null, title: 'Collect figures', completed: false }, { id: null, title: 'Draft report', completed: false }] })
    expect(added.subtasks).toHaveLength(2)
    expect(new Set(added.subtasks?.map(entry => entry.id)).size).toBe(2)
    expect(added).toMatchObject({ id: parent.id, creatorId: lin, ownerId: chen, kind, status: parent.status,
      date: parent.date, time: parent.time, createdAt: parent.createdAt, revision: parent.revision + 1 })
    const first = added.subtasks![0]!
    const second = added.subtasks![1]!
    const changed = await ctx.office.updateWorkSubtasks(chen, parent.id, added.revision,
      { subtasks: [{ ...first, completed: true }, { ...second, title: 'Review report' }] })
    expect(changed.subtasks?.map(entry => entry.id)).toEqual([first.id, second.id])
    expect(changed.subtasks?.[0]?.completed).toBe(true)
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    expect(await ctx.office.updateWorkSubtasks(chen, parent.id, changed.revision, { subtasks: changed.subtasks! })).toEqual(changed)
    expect(await readFile(path)).toEqual(before)
    const content = await ctx.office.updateWork(lin, parent.id, changed.revision,
      { title: changed.title, date: changed.date, time: changed.time, priority: 'high' })
    expect(content.subtasks).toEqual(changed.subtasks)
    const transferred = await ctx.office.decideTask(lin, parent.id, content.revision,
      { kind: 'transfer', ownerId: xu, reason: 'Continue the checklist' })
    expect(() => ctx.office.getItem(chen, parent.id)).toThrow()
    const removed = await ctx.office.updateWorkSubtasks(xu, parent.id, transferred.revision, { subtasks: [{ ...first, completed: true }] })
    expect(removed.subtasks).toEqual([{ ...first, completed: true }])
    expect(removed.priority).toBe('high')
    expect(ctx.office.view(lin).notifications).toContainEqual(expect.objectContaining({ itemId: parent.id, kind: 'work_subtasks_updated' }))
    await ctx.fiber.dispose()
    const reopened = await boot(root)
    expect(reopened.office.getItem(xu, parent.id)).toEqual(removed)
    const cleared = await reopened.office.updateWorkSubtasks(admin, parent.id, removed.revision, { subtasks: [] })
    expect(cleared.subtasks).toEqual([])
  })

  it('publishes no subtask or notice after a failed write and commits only one reviewed concurrent update', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const parent = await ctx.office.createWork(lin, work)
    const input = { subtasks: [{ id: null, title: 'Atomic subtask', completed: false }] }
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    const previous = ctx.office.view(chen)
    const domain = ctx.storageDomain.get('enterprise_office')!
    const failed = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected subtask write failure'))
    await expect(ctx.office.updateWorkSubtasks(lin, parent.id, parent.revision, input)).rejects.toThrow('Expected subtask write failure')
    failed.mockRestore()
    expect(await readFile(path)).toEqual(before)
    expect(ctx.office.view(chen)).toEqual(previous)
    const results = await Promise.allSettled([ctx.office.updateWorkSubtasks(lin, parent.id, parent.revision, input),
      ctx.office.updateWorkSubtasks(lin, parent.id, parent.revision, input)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }])
    expect(ctx.office.view(chen).notifications.filter(notice => notice.kind === 'work_subtasks_updated')).toHaveLength(1)
  })

  it('rejects foreign or duplicate ids, malformed lists, hidden work, closed items and inactive actors without writes', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const parent = await ctx.office.createWork(lin, work)
    const child = { id: null, title: 'Existing subtask', completed: false }
    const added = await ctx.office.updateWorkSubtasks(lin, parent.id, parent.revision, { subtasks: [child] })
    const existing = added.subtasks![0]!
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    for (const input of [{ subtasks: [{ ...existing, id: randomUUID() as OfficeSubtaskId }] }, { subtasks: [existing, existing] },
      { subtasks: [{ ...child, title: ' ' }] }, { subtasks: Array.from({ length: 101 }, () => child) },
      { subtasks: [existing], ownerId: xu }]) {
      await expect(ctx.office.updateWorkSubtasks(lin, parent.id, added.revision, input)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(ctx.office.updateWorkSubtasks(xu, parent.id, added.revision, { subtasks: [] })).rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.updateWorkSubtasks(lin, parent.id, parent.revision, { subtasks: [] })).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(path)).toEqual(before)
    const meetingItem = await ctx.office.createSchedule(lin, meeting)
    await expect(ctx.office.updateWorkSubtasks(lin, meetingItem.id, meetingItem.revision, { subtasks: [] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    const closed = await ctx.office.setStatus(lin, parent.id, added.revision, 'completed')
    const after = await readFile(path)
    await expect(ctx.office.updateWorkSubtasks(lin, parent.id, closed.revision, { subtasks: [] })).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(path)).toEqual(after)
    const actor = ctx.office.view(admin).members.find(member => member.id === chen)!
    await ctx.office.saveMember(admin, { ...actor, active: false }, actor)
    await expect(ctx.office.updateWorkSubtasks(chen, parent.id, closed.revision, { subtasks: [] })).rejects.toMatchObject({ code: 'forbidden' })
    const service = ctx.office
    await ctx.fiber.dispose()
    await expect(service.updateWorkSubtasks(lin, parent.id, closed.revision, { subtasks: [] })).rejects.toMatchObject({ code: 'closed' })
  })
})

describe('Internal meeting availability', () => {
  const query = { date: day, startTime: '10:15', endTime: '10:45', memberIds: [lin, chen, xu, chen] }

  it('returns only busy flags for private meetings after explicit deployment consent without writes', async () => {
    const root = await directory()
    const ctx = await boot(root, { ...config, scheduleAvailabilityEnabled: true })
    const privateMeeting = await ctx.office.createSchedule(chen, { ...meeting, title: 'Private finance review', inviteeIds: [xu] })
    expect(() => ctx.office.getItem(lin, privateMeeting.id)).toThrow()
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    const changed = vi.fn()
    ctx.on('office/changed', changed)
    expect(ctx.office.view(lin).scheduleAvailabilityEnabled).toBe(true)
    const result = ctx.office.scheduleAvailability(lin, query)
    const { checkedAt, ...observation } = result
    expect(typeof checkedAt).toBe('number')
    expect(observation).toEqual({ date: day, startTime: query.startTime, endTime: query.endTime, timeZone: 'Asia/Shanghai',
      members: [{ memberId: lin, busy: false }, { memberId: chen, busy: true }, { memberId: xu, busy: true }] })
    expect(JSON.stringify(result)).not.toContain(privateMeeting.title)
    expect(JSON.stringify(result)).not.toContain(privateMeeting.id)
    expect(await readFile(path)).toEqual(before)
    expect(changed).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
    const reopened = await boot(root, { ...config, scheduleAvailabilityEnabled: true })
    expect(reopened.office.scheduleAvailability(lin, query).members).toEqual(result.members)
  })

  it('treats declined, adjacent, other-day and closed meetings as free and excludes only readable meetings', async () => {
    const ctx = await boot(await directory(), { ...config, scheduleAvailabilityEnabled: true })
    const privateMeeting = await ctx.office.createSchedule(chen, { ...meeting, inviteeIds: [xu] })
    expect(() => ctx.office.scheduleAvailability(lin, { ...query, excludeItemId: privateMeeting.id }))
      .toThrow(expect.objectContaining({ code: 'not_found' }))
    const own = await ctx.office.createSchedule(lin, { ...meeting, inviteeIds: [] })
    expect(ctx.office.scheduleAvailability(lin, { ...query, excludeItemId: own.id }).members)
      .toEqual([{ memberId: lin, busy: false }, { memberId: chen, busy: true }, { memberId: xu, busy: true }])
    const declined = await ctx.office.reply(xu, privateMeeting.id, privateMeeting.revision, 'declined')
    expect(ctx.office.scheduleAvailability(lin, query).members.find(member => member.memberId === xu)?.busy).toBe(false)
    expect(ctx.office.scheduleAvailability(lin, { ...query, startTime: '11:00', endTime: '12:00' }).members.every(member => !member.busy)).toBe(true)
    expect(ctx.office.scheduleAvailability(lin, { ...query, date: '2026-10-16' }).members.every(member => !member.busy)).toBe(true)
    await ctx.office.setStatus(chen, declined.id, declined.revision, 'cancelled')
    await ctx.office.setStatus(lin, own.id, own.revision, 'completed')
    await ctx.office.createWork(chen, { ...work, ownerId: chen, time: '10:30' })
    expect(ctx.office.scheduleAvailability(lin, query).members.every(member => !member.busy)).toBe(true)
  })

  it('denies sharing by default, validates bounded queries and rechecks active members and service lifetime', async () => {
    const root = await directory()
    const disabled = await boot(root)
    expect(disabled.office.view(lin).scheduleAvailabilityEnabled).toBeUndefined()
    expect(() => disabled.office.scheduleAvailability(lin, query)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    await disabled.fiber.dispose()
    const ctx = await boot(root, { ...config, scheduleAvailabilityEnabled: true })
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    for (const input of [{ ...query, memberIds: [] }, { ...query, memberIds: Array.from({ length: 501 }, () => lin) },
      { ...query, endTime: query.startTime }, { ...query, date: '2026-02-30' }, { ...query, actorId: admin }]) {
      expect(() => ctx.office.scheduleAvailability(lin, input)).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    }
    const missing = 'missing' as OfficeMemberId
    expect(() => ctx.office.scheduleAvailability(missing, query)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(() => ctx.office.scheduleAvailability(lin, { ...query, memberIds: [missing] }))
      .toThrow(expect.objectContaining({ code: 'forbidden' }))
    const workItem = await ctx.office.createWork(lin, work)
    expect(() => ctx.office.scheduleAvailability(lin, { ...query, excludeItemId: workItem.id }))
      .toThrow(expect.objectContaining({ code: 'invalid_input' }))
    const target = ctx.office.view(admin).members.find(member => member.id === xu)!
    await ctx.office.saveMember(admin, { ...target, active: false }, target)
    const after = await readFile(path)
    expect(after).not.toEqual(before)
    expect(() => ctx.office.scheduleAvailability(lin, query)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(() => ctx.office.scheduleAvailability(xu, { ...query, memberIds: [lin] }))
      .toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(await readFile(path)).toEqual(after)
    const service = ctx.office
    await ctx.fiber.dispose()
    expect(() => service.scheduleAvailability(lin, query)).toThrow(expect.objectContaining({ code: 'closed' }))
  })
})

describe('Meeting member updates', () => {
  const fields = { title: meeting.title, date: meeting.date, startTime: meeting.startTime, endTime: meeting.endTime }

  it('keeps the organizer during administrator edits, retains inactive invitees and supports an empty roster', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const item = await ctx.office.createSchedule(lin, meeting)
    const accepted = await ctx.office.reply(chen, item.id, item.revision, 'accepted')
    const target = ctx.office.view(admin).members.find(member => member.id === chen)!
    await ctx.office.saveMember(admin, { ...target, active: false }, target)
    const notes = await ctx.office.updateSchedule(admin, item.id, accepted.revision,
      { ...fields, description: 'Keep historical attendee', inviteeIds: [chen] })
    expect(notes.participants).toEqual(accepted.participants)
    expect(notes).toMatchObject({ creatorId: lin, ownerId: lin, createdAt: item.createdAt })
    const alone = await ctx.office.updateSchedule(admin, item.id, notes.revision, { ...fields, inviteeIds: [] })
    expect(alone.participants).toEqual([{ memberId: lin, reply: 'accepted' }])
    expect(ctx.office.view(lin).notifications.filter(notice => notice.kind === 'schedule_updated')).toHaveLength(2)
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    await expect(ctx.office.updateSchedule(admin, item.id, alone.revision, { ...fields, inviteeIds: [chen] }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(await readFile(path)).toEqual(before)
  })

  it('retains replies, invites added members, removes access and preserves readable notices across restart', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const created = await ctx.office.createSchedule(lin, meeting)
    const accepted = await ctx.office.reply(chen, created.id, created.revision, 'accepted')
    const added = await ctx.office.updateSchedule(lin, created.id, accepted.revision,
      { ...fields, inviteeIds: [chen, xu, lin, chen] })
    expect(added.participants).toEqual([{ memberId: lin, reply: 'accepted' },
      { memberId: chen, reply: 'accepted' }, { memberId: xu, reply: 'pending' }])
    expect(ctx.office.view(xu).notifications.filter(notice => notice.kind === 'invited')).toHaveLength(1)
    expect(ctx.office.view(chen).notifications.filter(notice => notice.kind === 'invited')).toHaveLength(1)
    const removed = await ctx.office.updateSchedule(lin, created.id, added.revision,
      { ...fields, title: '移除后新的保密标题', inviteeIds: [xu] })
    expect(removed).toMatchObject({ creatorId: lin, ownerId: lin, createdAt: created.createdAt, status: created.status })
    expect(() => ctx.office.getItem(chen, created.id)).toThrow()
    const former = ctx.office.view(chen)
    expect(former.items.some(item => item.id === created.id)).toBe(false)
    expect(former.notifications).toContainEqual(expect.objectContaining({ itemId: created.id, kind: 'schedule_removed', itemTitle: created.title }))
    expect(JSON.stringify(former)).not.toContain(removed.title)
    const replied = await ctx.office.reply(xu, created.id, removed.revision, 'accepted')
    const legacy = await ctx.office.updateSchedule(lin, created.id, replied.revision,
      { ...fields, title: removed.title, location: '旧调用只改地点' })
    expect(legacy.participants).toEqual(replied.participants)
    const reinvited = await ctx.office.updateSchedule(lin, created.id, legacy.revision,
      { ...fields, title: removed.title, startTime: '11:00', endTime: '12:00', inviteeIds: [xu, chen] })
    expect(reinvited.participants).toEqual([{ memberId: lin, reply: 'accepted' },
      { memberId: xu, reply: 'pending' }, { memberId: chen, reply: 'pending' }])
    expect(ctx.office.view(chen).notifications.filter(notice => notice.kind === 'invited')).toHaveLength(2)
    await ctx.fiber.dispose()
    const reopened = await boot(root)
    expect(reopened.office.getItem(xu, created.id)).toEqual(reinvited)
    expect(reopened.office.view(chen).notifications).toContainEqual(expect.objectContaining({ kind: 'schedule_removed', itemTitle: created.title }))
  })

  it('keeps roster no-ops write-free and rejects invitee edits, inactive additions and closed meetings', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const item = await ctx.office.createSchedule(lin, meeting)
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    expect(await ctx.office.updateSchedule(lin, item.id, item.revision, { ...fields, inviteeIds: [chen, lin, chen] })).toEqual(item)
    expect(await readFile(path)).toEqual(before)
    await expect(ctx.office.updateSchedule(chen, item.id, item.revision, { ...fields, inviteeIds: [xu] }))
      .rejects.toMatchObject({ code: 'forbidden' })
    const immutable = { ...fields, inviteeIds: [chen], ownerId: chen }
    await expect(ctx.office.updateSchedule(lin, item.id, item.revision, immutable)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await readFile(path)).toEqual(before)
    const target = ctx.office.view(admin).members.find(member => member.id === xu)!
    await ctx.office.saveMember(admin, { ...target, active: false }, target)
    const disabled = await readFile(path)
    await expect(ctx.office.updateSchedule(lin, item.id, item.revision, { ...fields, inviteeIds: [chen, xu] }))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(await readFile(path)).toEqual(disabled)
    const closed = await ctx.office.setStatus(lin, item.id, item.revision, 'completed')
    const completed = await readFile(path)
    await expect(ctx.office.updateSchedule(lin, item.id, closed.revision, { ...fields, inviteeIds: [chen] }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(path)).toEqual(completed)
  })

  it('publishes no roster or notices after a failed write and admits one reviewed concurrent change', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const item = await ctx.office.createSchedule(lin, meeting)
    const input = { ...fields, inviteeIds: [chen, xu] }
    const path = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(path)
    const domain = ctx.storageDomain.get('enterprise_office')!
    const failed = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Expected roster commit failure'))
    await expect(ctx.office.updateSchedule(lin, item.id, item.revision, input)).rejects.toThrow('Expected roster commit failure')
    failed.mockRestore()
    expect(await readFile(path)).toEqual(before)
    expect(ctx.office.view(xu).items).toEqual([])
    expect(ctx.office.view(xu).notifications).toEqual([])
    const results = await Promise.allSettled([ctx.office.updateSchedule(lin, item.id, item.revision, input),
      ctx.office.updateSchedule(lin, item.id, item.revision, input)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }])
    expect(ctx.office.view(xu).notifications.filter(notice => notice.kind === 'invited')).toHaveLength(1)
    expect(ctx.office.getItem(lin, item.id).revision).toBe(item.revision + 1)
  })

  it.each(['invitee', 'actor'] as const)('rechecks a queued member edit after its %s is disabled', async (change) => {
    const root = await directory()
    const ctx = await boot(root)
    const item = await ctx.office.createSchedule(lin, meeting)
    const target = ctx.office.view(admin).members.find(member => member.id === (change === 'invitee' ? xu : lin))!
    const domain = ctx.storageDomain.get('enterprise_office')!
    const write = domain.global.set.bind(domain.global)
    const ready = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const held = vi.spyOn(domain.global, 'set').mockImplementationOnce(async (...args) => {
      ready.resolve(undefined)
      await release.promise
      return write(...args)
    })
    const disabling = ctx.office.saveMember(admin, { ...target, active: false }, target)
    try {
      await ready.promise
      const pending = Promise.allSettled([ctx.office.updateSchedule(lin, item.id, item.revision, { ...fields, inviteeIds: [chen, xu] })])
      release.resolve(undefined)
      await disabling
      expect(await pending).toMatchObject([{ status: 'rejected', reason: { code: 'forbidden' } }])
      expect(ctx.office.getItem(admin, item.id).participants).toEqual(item.participants)
    } finally { release.resolve(undefined); held.mockRestore() }
  })
})

describe('Meeting content updates', () => {
  it('preserves accepted replies for notes and resets invitees after a time change across restart', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const created = await ctx.office.createSchedule(lin, meeting)
    const accepted = await ctx.office.reply(chen, created.id, created.revision, 'accepted')
    const notes = await ctx.office.updateSchedule(lin, created.id, accepted.revision,
      { title: '更新周会', description: '更新后的说明', date: day, startTime: '10:00', endTime: '11:00', location: '一号会议室' })
    expect(notes.participants).toEqual(accepted.participants)
    const edited = await ctx.office.updateSchedule(lin, created.id, notes.revision,
      { title: notes.title, description: notes.description, date: '2026-10-16', startTime: '14:00', endTime: '15:00', location: notes.location })
    expect(edited).toMatchObject({ id: created.id, creatorId: lin, ownerId: lin, createdAt: created.createdAt,
      status: created.status, revision: notes.revision + 1, date: '2026-10-16', time: '14:00', endTime: '15:00' })
    expect(edited.participants).toEqual([{ memberId: lin, reply: 'accepted' }, { memberId: chen, reply: 'pending' }])
    expect(ctx.office.view(chen).notifications.filter(entry => entry.kind === 'schedule_updated')).toHaveLength(2)
    expect(ctx.office.view(lin).notifications.filter(entry => entry.kind === 'schedule_updated')).toHaveLength(0)
    await ctx.fiber.dispose()
    const reopened = await boot(root)
    expect(reopened.office.getItem(chen, created.id)).toEqual(edited)
    expect(reopened.office.view(chen).notifications.filter(entry => entry.kind === 'schedule_updated')).toHaveLength(2)
  })

  it('rejects invitee-authored changes, stale edits, invalid intervals and closed meetings without writes', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const created = await ctx.office.createSchedule(lin, meeting)
    const input = { title: '评审后的新标题', date: day, startTime: '10:00', endTime: '11:00' }
    const statePath = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(statePath)
    await expect(ctx.office.updateSchedule(chen, created.id, created.revision, input)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.updateSchedule(lin, created.id, created.revision, { ...input, endTime: '09:00' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(await readFile(statePath)).toEqual(before)
    const accepted = await ctx.office.reply(chen, created.id, created.revision, 'accepted')
    const afterReply = await readFile(statePath)
    await expect(ctx.office.updateSchedule(lin, created.id, created.revision, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(statePath)).toEqual(afterReply)
    const cancelled = await ctx.office.setStatus(lin, created.id, accepted.revision, 'cancelled')
    const afterCancel = await readFile(statePath)
    await expect(ctx.office.updateSchedule(lin, created.id, cancelled.revision, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(statePath)).toEqual(afterCancel)
  })

  it('lets an administrator edit without becoming organizer and keeps an unchanged update write-free', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const created = await ctx.office.createSchedule(lin, meeting)
    const input = { title: created.title, description: created.description, date: created.date,
      startTime: created.time!, endTime: created.endTime!, location: created.location }
    const statePath = join(root, 'data', 'enterprise_office.json')
    const before = await readFile(statePath)
    expect(await ctx.office.updateSchedule(admin, created.id, created.revision, input)).toEqual(created)
    expect(await readFile(statePath)).toEqual(before)
    const edited = await ctx.office.updateSchedule(admin, created.id, created.revision, { ...input, location: '二号会议室' })
    expect(edited.creatorId).toBe(lin)
    expect(edited.ownerId).toBe(lin)
    expect(edited.participants).toEqual(created.participants)
    for (const member of [lin, chen]) expect(ctx.office.view(member).notifications)
      .toContainEqual(expect.objectContaining({ itemId: created.id, actorId: admin, kind: 'schedule_updated' }))
  })
})

describe('Durable private contact file drafts', () => {
  const selection = (content = Buffer.from('未发送的真实文件\0\n')): OfficeChatFileDraftInput => ({
    peerId: chen, revision: 0, requestId: randomUUID(), files: fileMessage(content).files,
  })

  it('restores actual eight-MiB draft bytes only for their owner without changing original chat or text drafts', async () => {
    const root = await directory()
    const ctx = await boot(root)
    await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '既有聊天' })
    await ctx.office.saveChatDraft(lin, { peerId: chen, revision: 0, requestId: randomUUID(), text: '既有文字草稿' })
    const names = ['enterprise_office.json', 'enterprise_office_chat.json', 'enterprise_office_chat_drafts.json']
    const original = await Promise.all(names.map(name => readFile(join(root, 'data', name))))
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x4b)
    bytes.write('真实持久化文件草稿\0\n')
    const input = { ...selection(bytes), files: [...selection(bytes).files,
      { name: 'empty.txt', mediaType: 'text/plain', byteLength: 0, dataBase64: '' }] }
    const saved = await ctx.office.saveChatFileDraft(lin, input)
    expect(saved.files).toHaveLength(2)
    expect(JSON.stringify(ctx.office.chatFileDrafts(lin))).not.toContain('dataBase64')
    expect(ctx.office.chatFileDrafts(lin)).toMatchObject({ meId: lin, ownerUsedBytes: bytes.length, drafts: [saved] })
    expect(ctx.office.chatFileDrafts(chen).drafts).toEqual([])
    expect(ctx.office.chatFileDrafts(admin).drafts).toEqual([])
    const coordinates = { peerId: chen, revision: saved.revision, attachmentId: saved.files[0]!.id }
    expect(Buffer.compare(Buffer.from((await ctx.office.downloadChatFileDraft(lin, coordinates)).dataBase64, 'base64'), bytes)).toBe(0)
    for (const actor of [chen, admin, xu])
      await expect(ctx.office.downloadChatFileDraft(actor, coordinates)).rejects.toMatchObject({ code: 'not_found' })
    expect((await ctx.office.downloadChatFileDraft(lin, { ...coordinates, attachmentId: saved.files[1]!.id })).dataBase64).toBe('')
    expect(await Promise.all(names.map(name => readFile(join(root, 'data', name))))).toEqual(original)
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.chatFileDrafts(lin).drafts).toEqual([saved])
    expect((await restarted.office.downloadChatFileDraft(lin, coordinates)).sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    await restarted.office.saveMember(admin, { ...restarted.office.view(lin).me, active: false })
    expect(() => restarted.office.chatFileDrafts(lin)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    await expect(restarted.office.downloadChatFileDraft(lin, coordinates)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('keeps reviewed versions, exact retries, empty tombstones and per-owner/office quota consistent', async () => {
    const ctx = await boot(await directory(), { ...config, chatMaxFileBytes: 3, chatMaxMessageBytes: 5, chatFilesPerMessage: 2,
      chatFileDraftOwnerQuotaBytes: 5, chatFileDraftTotalQuotaBytes: 7 })
    const input = selection(Buffer.from('abc'))
    const saved = await ctx.office.saveChatFileDraft(lin, input)
    expect(await ctx.office.saveChatFileDraft(lin, input)).toEqual(saved)
    await expect(ctx.office.saveChatFileDraft(lin, { ...input, files: fileMessage(Buffer.from('abd')).files })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.saveChatFileDraft(lin, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.saveChatFileDraft(lin, { ...selection(Buffer.from('abc')), peerId: xu })).rejects.toMatchObject({ code: 'invalid_input' })
    const changed = await ctx.office.saveChatFileDraft(lin, { ...selection(Buffer.from('ab')), revision: 1 })
    expect(changed.revision).toBe(2)
    const two = fileMessage(Buffer.from('ab')).files[0]!
    await ctx.office.saveChatFileDraft(chen, { ...selection(), peerId: lin, files: [two, { ...two, name: 'second.bin' }] })
    await expect(ctx.office.saveChatFileDraft(admin, selection(Buffer.from('ab')))).rejects.toMatchObject({ code: 'invalid_input' })
    const cleared = await ctx.office.saveChatFileDraft(lin, { ...selection(), revision: 2, files: [] })
    expect(cleared).toMatchObject({ revision: 3, files: [] })
    expect(ctx.office.chatFileDrafts(lin).ownerUsedBytes).toBe(0)
    await expect(ctx.office.saveChatFileDraft(lin, { ...selection(), revision: 2 })).rejects.toMatchObject({ code: 'conflict' })
    await ctx.office.saveChatFileDraft(admin, selection(Buffer.from('ab')))
    await expect(ctx.office.downloadChatFileDraft(lin, { peerId: chen, revision: 1, attachmentId: saved.files[0]!.id }))
      .rejects.toMatchObject({ code: 'not_found' })
  })

  it('keeps a failed save unchanged and recovers a committed save after its reply is lost', async () => {
    const ctx = await boot(await directory())
    const input = selection()
    const domain = ctx.storageDomain.get('enterprise_office_chat_file_drafts')!
    const store = domain.global.set.bind(domain.global)
    const writes = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Draft write refused'))
    await expect(ctx.office.saveChatFileDraft(lin, input)).rejects.toThrow('Draft write refused')
    expect(ctx.office.chatFileDrafts(lin).drafts).toEqual([])
    writes.mockImplementationOnce(async (next) => { await store(next); throw new Error('Committed draft reply lost') })
    await expect(ctx.office.saveChatFileDraft(lin, input)).rejects.toThrow('Committed draft reply lost')
    const saved = ctx.office.chatFileDrafts(lin).drafts[0]!
    expect(await ctx.office.saveChatFileDraft(lin, input)).toEqual(saved)
    expect(writes).toHaveBeenCalledTimes(2)
  })

  it('retains exact send recovery across a failed original header and blocks both unrelated send operations', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const input = selection()
    const saved = await ctx.office.saveChatFileDraft(lin, input)
    const send: OfficeChatFileDraftSendInput = { id: brandString<OfficeMessageId>(randomUUID()), peerId: chen, revision: saved.revision, text: '' }
    await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '原有文字' })
    const header = ctx.storageDomain.get('enterprise_office_chat')!
    const writes = vi.spyOn(header.global, 'set').mockRejectedValueOnce(new Error('Header failed'))
    await expect(ctx.office.sendChatFileDraft(lin, send)).rejects.toThrow('Header failed')
    writes.mockRestore()
    expect(ctx.office.chatFileDrafts(lin).drafts[0]).toMatchObject({ ...saved, pendingSend: send })
    await expect(ctx.office.saveChatFileDraft(lin, { ...input, requestId: randomUUID(), revision: saved.revision }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.sendMessage(lin, { id: send.id, recipientId: chen, text: '绕过文件' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.sendMessageFiles(lin, { ...fileMessage(), id: send.id })).rejects.toMatchObject({ code: 'conflict' })
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.chatFileDrafts(lin).drafts[0]?.pendingSend).toEqual(send)
    const published = await restarted.office.sendChatFileDraft(lin, send)
    expect(restarted.office.chatFileDrafts(lin).drafts[0]).toMatchObject({ revision: 2, files: [], pendingSend: null })
    expect(await restarted.office.sendChatFileDraft(lin, send)).toEqual(published)
    expect(restarted.office.chat(lin, chen).messages).toHaveLength(2)
    expect(Buffer.from((await restarted.office.downloadChatFile(chen,
      { messageId: published.id, attachmentId: published.attachments![0]!.id })).dataBase64, 'base64').toString()).toContain('未发送的真实文件')
  })

  it('reconciles a published message after draft clearing fails, including on restart without a duplicate send', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const saved = await ctx.office.saveChatFileDraft(lin, selection())
    const input = { id: brandString<OfficeMessageId>(randomUUID()), peerId: chen, revision: saved.revision, text: '已发布的说明' }
    const domain = ctx.storageDomain.get('enterprise_office_chat_file_drafts')!
    const store = domain.global.set.bind(domain.global)
    const writes = vi.spyOn(domain.global, 'set').mockImplementationOnce(next => store(next))
      .mockRejectedValueOnce(new Error('Draft clear failed'))
    await expect(ctx.office.sendChatFileDraft(lin, input)).rejects.toThrow('Draft clear failed')
    writes.mockRestore()
    const published = ctx.office.chat(lin, chen).messages[0]!
    expect(ctx.office.chatFileDrafts(lin).drafts[0]?.pendingSend).toEqual(input)
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.chatFileDrafts(lin).drafts[0]).toMatchObject({ files: [], revision: 2, pendingSend: null })
    expect(await restarted.office.sendChatFileDraft(lin, input)).toEqual(published)
    expect(restarted.office.chat(lin, chen).messages).toEqual([published])
    await restarted.office.saveChatFileDraft(lin, { ...selection(Buffer.from('新草稿')), revision: 2 })
    await expect(restarted.office.sendChatFileDraft(lin, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(restarted.office.chatFileDrafts(lin).drafts[0]?.files).toHaveLength(1)
  })

  it('refuses malformed bytes, self drafts, occupied message identities and a lost original directory', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const input = selection()
    await expect(ctx.office.saveChatFileDraft(lin, { ...input, files: [{ ...input.files[0]!, dataBase64: '%%%bad' }] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.saveChatFileDraft(lin, { ...input, peerId: lin })).rejects.toMatchObject({ code: 'invalid_input' })
    const saved = await ctx.office.saveChatFileDraft(lin, input)
    const text = await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '已有标识' })
    await expect(ctx.office.sendChatFileDraft(lin, { id: text.id, peerId: chen, revision: saved.revision, text: '' }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.chatFileDrafts(lin).drafts[0]?.pendingSend).toBeNull()
    await ctx.fiber.dispose()
    await rm(join(root, 'data', 'enterprise_office.json'))
    await expect(boot(root)).rejects.toThrow()
    expect((await readFile(join(root, 'data', 'enterprise_office_chat_file_drafts.json'), 'utf8'))).toContain(input.files[0]!.dataBase64)
  })
})

describe('File draft persistence failure containment', () => {
  const selection = (): OfficeChatFileDraftInput => ({ peerId: chen, revision: 0, requestId: randomUUID(), files: fileMessage().files })

  it('projects a readonly inactive own contact with no message history without granting an unrelated employee access', async () => {
    const ctx = await boot(await directory())
    const saved = await ctx.office.saveChatFileDraft(lin, selection())
    const member = ctx.office.view(admin).members.find(value => value.id === chen)!
    await ctx.office.saveMember(admin, { ...member, active: false })
    expect(ctx.office.chat(lin, chen)).toMatchObject({ peer: { id: chen, name: member.name, active: false }, messages: [] })
    expect(() => ctx.office.chat(admin, chen)).toThrow(expect.objectContaining({ code: 'not_found' }))
    await expect(ctx.office.saveChatFileDraft(admin, { peerId: chen, revision: 0, requestId: randomUUID(), files: [] }))
      .rejects.toMatchObject({ code: 'not_found' })
    await ctx.office.saveChatFileDraft(lin, { peerId: chen, revision: saved.revision, requestId: randomUUID(), files: [] })
    expect(ctx.office.chat(lin, chen)).toMatchObject({ peer: { id: chen, active: false }, messages: [] })
  })

  it('allows owners to clear retained drafts when deployment quotas are reduced below their current usage', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const first = await ctx.office.saveChatFileDraft(lin, selection())
    const second = await ctx.office.saveChatFileDraft(lin, { ...selection(), peerId: xu })
    await ctx.fiber.dispose()
    const restarted = await boot(root, { ...config, chatFileDraftOwnerQuotaBytes: 1, chatFileDraftTotalQuotaBytes: 1 })
    expect(restarted.office.chatFileDrafts(lin).ownerUsedBytes).toBeGreaterThan(1)
    await restarted.office.saveChatFileDraft(lin, { peerId: chen, revision: first.revision, requestId: randomUUID(), files: [] })
    expect(restarted.office.chatFileDrafts(lin).ownerUsedBytes).toBeGreaterThan(1)
    await restarted.office.saveChatFileDraft(lin, { peerId: xu, revision: second.revision, requestId: randomUUID(), files: [] })
    expect(restarted.office.chatFileDrafts(lin).ownerUsedBytes).toBe(0)
  })

  it('clears an unpublished admitted selection after its recipient is deactivated and prevents a late old draft send', async () => {
    const ctx = await boot(await directory())
    const saved = await ctx.office.saveChatFileDraft(lin, selection())
    await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '已有历史' })
    const domain = ctx.storageDomain.get('enterprise_office_chat')!
    const writes = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Header rejected'))
    const send = { id: brandString<OfficeMessageId>(randomUUID()), peerId: chen, revision: saved.revision, text: '未送达' }
    await expect(ctx.office.sendChatFileDraft(lin, send)).rejects.toThrow('Header rejected')
    writes.mockRestore()
    const member = ctx.office.view(admin).members.find(value => value.id === chen)!
    await ctx.office.saveMember(admin, { ...member, active: false })
    expect(ctx.office.chatFileDrafts(lin).drafts[0]?.peer).toEqual({ id: chen, name: member.name, active: false })
    const clear = { peerId: chen, revision: saved.revision, requestId: randomUUID(), files: [] }
    const cleared = await ctx.office.saveChatFileDraft(lin, clear)
    expect(cleared).toMatchObject({ revision: 2, files: [], pendingSend: null })
    expect(await ctx.office.saveChatFileDraft(lin, clear)).toEqual(cleared)
    await expect(ctx.office.sendChatFileDraft(lin, send)).rejects.toMatchObject({ code: 'not_found' })
    await ctx.office.saveMember(admin, member)
    await expect(ctx.office.sendChatFileDraft(lin, send)).rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.chat(lin, chen).messages.map(value => value.text)).toEqual(['已有历史'])
    expect(ctx.office.chatFileDrafts(lin).ownerUsedBytes).toBe(0)
  })

  it('clears a pending selection against an already committed message without reporting that message as unsent', async () => {
    const ctx = await boot(await directory())
    const saved = await ctx.office.saveChatFileDraft(lin, selection())
    const domain = ctx.storageDomain.get('enterprise_office_chat_file_drafts')!
    const store = domain.global.set.bind(domain.global)
    const writes = vi.spyOn(domain.global, 'set').mockImplementationOnce(next => store(next)).mockRejectedValueOnce(new Error('Clear failed'))
    const send = { id: brandString<OfficeMessageId>(randomUUID()), peerId: chen, revision: saved.revision, text: '实际已发' }
    await expect(ctx.office.sendChatFileDraft(lin, send)).rejects.toThrow('Clear failed')
    writes.mockRestore()
    const message = ctx.office.chat(lin, chen).messages[0]!
    const clear = { peerId: chen, revision: saved.revision, requestId: randomUUID(), files: [] }
    const cleared = await ctx.office.saveChatFileDraft(lin, clear)
    expect(cleared).toMatchObject({ revision: 2, files: [], pendingSend: null })
    expect(await ctx.office.saveChatFileDraft(lin, clear)).toEqual(cleared)
    expect(await ctx.office.sendChatFileDraft(lin, send)).toEqual(message)
    expect(ctx.office.chat(lin, chen).messages).toEqual([message])
  })

  it('reserves an unresolved send identity across contacts without locking an unrelated selection', async () => {
    const ctx = await boot(await directory())
    const first = await ctx.office.saveChatFileDraft(lin, selection())
    const second = await ctx.office.saveChatFileDraft(lin, { ...selection(), peerId: xu })
    await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '已有水位' })
    const domain = ctx.storageDomain.get('enterprise_office_chat')!
    const writes = vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Header rejected'))
    const send = { id: brandString<OfficeMessageId>(randomUUID()), peerId: chen, revision: first.revision, text: '原联系人' }
    await expect(ctx.office.sendChatFileDraft(lin, send)).rejects.toThrow('Header rejected')
    writes.mockRestore()
    await expect(ctx.office.sendChatFileDraft(lin, { ...send, peerId: xu, revision: second.revision }))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.chatFileDrafts(lin).drafts.find(entry => entry.peerId === xu)?.pendingSend).toBeNull()
    expect(ctx.office.chatFileDrafts(lin).drafts.find(entry => entry.peerId === chen)?.pendingSend).toEqual(send)
    expect((await ctx.office.sendChatFileDraft(lin, send)).recipientId).toBe(chen)
  })

  it('drains an accepted private file save before closing storage during root unload', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const office = ctx.office
    const domain = ctx.storageDomain.get('enterprise_office_chat_file_drafts')!
    const store = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const writes = vi.spyOn(domain.global, 'set').mockImplementationOnce(async (next) => {
      entered.resolve(undefined)
      await release.promise
      return store(next)
    })
    const saving = office.saveChatFileDraft(lin, selection())
    await entered.promise
    const closing = ctx.fiber.dispose()
    await vi.waitFor(() => { expect(() => office.chatFileDrafts(lin)).toThrow(expect.objectContaining({ code: 'closed' })) })
    release.resolve(undefined)
    const saved = await saving
    await closing
    writes.mockRestore()
    const restarted = await boot(root)
    expect(restarted.office.chatFileDrafts(lin).drafts).toEqual([saved])
  })

  it('rejects corrupt durable draft bytes without replacing the original storage unit', async () => {
    const root = await directory()
    const ctx = await boot(root)
    await ctx.office.saveChatFileDraft(lin, selection())
    await ctx.fiber.dispose()
    const path = join(root, 'data', 'enterprise_office_chat_file_drafts.json')
    const contents = JSON.parse(await readFile(path, 'utf8')) as { global: { drafts: Array<{ files: Array<{ dataBase64: string }> }> } }
    contents.global.drafts[0]!.files[0]!.dataBase64 = '%invalid%'
    const corrupted = JSON.stringify(contents)
    await writeFile(path, corrupted)
    await expect(boot(root)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(corrupted)
  })

  it('refuses a lost chat even when file publication failed before creating the sent-file ledger', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const saved = await ctx.office.saveChatFileDraft(lin, selection())
    const files = ctx.storageDomain.get('enterprise_office_chat_files')!
    const writes = vi.spyOn(files.global, 'set').mockRejectedValueOnce(new Error('File declaration not saved'))
    await expect(ctx.office.sendChatFileDraft(lin,
      { id: brandString<OfficeMessageId>(randomUUID()), peerId: chen, revision: saved.revision, text: '待恢复' }))
      .rejects.toThrow('File declaration not saved')
    writes.mockRestore()
    await ctx.fiber.dispose()
    await rm(join(root, 'data', 'enterprise_office_chat.json'))
    await expect(boot(root)).rejects.toThrow()
  })
})

describe('Private chat files through the real office composition', () => {
  it('stores exact binary and empty files, retains old text headers and authorizes only participants after restart', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const officeBytes = await readFile(join(root, 'data', 'enterprise_office.json'))
    const old = await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '旧文字消息' })
    const bytes = Buffer.alloc(1024 * 1024 + 19, 0x7b)
    bytes.write('真实二进制\0\n')
    const input = fileMessage(bytes, '')
    const message = await ctx.office.sendMessageFiles(lin, { ...input, files: [...input.files,
      { name: 'empty.txt', mediaType: 'text/plain', byteLength: 0, dataBase64: '' }] })
    expect(message.text).toBe('合同资料.bin\nempty.txt')
    expect(message.attachments).toHaveLength(2)
    expect(ctx.office.chat(chen, lin).messages).toEqual([old, message])
    expect(ctx.office.chat(admin, lin).messages).toEqual([])
    const coordinates = { messageId: message.id, attachmentId: message.attachments![0]!.id }
    const file = await ctx.office.downloadChatFile(chen, coordinates)
    expect(Buffer.compare(Buffer.from(file.dataBase64, 'base64'), bytes)).toBe(0)
    expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect((await ctx.office.downloadChatFile(lin, { ...coordinates, attachmentId: message.attachments![1]!.id })).dataBase64).toBe('')
    for (const actor of [admin, xu]) await expect(ctx.office.downloadChatFile(actor, coordinates)).rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.downloadChatFile(chen, { ...coordinates, messageId: old.id })).rejects.toMatchObject({ code: 'not_found' })
    expect(JSON.stringify(ctx.storageDomain.get('enterprise_office_chat')!.global.get())).not.toContain('attachments')
    expect(JSON.stringify(ctx.storageDomain.get('enterprise_office_chat_files')!.global.get())).not.toContain('dataBase64')
    expect(ctx.office.chatFileLimitsFor(lin).ownerUsedBytes).toBe(bytes.length)
    expect(ctx.office.chatFileLimitsFor(chen).ownerUsedBytes).toBe(0)
    expect(Buffer.compare(await readFile(join(root, 'data', 'enterprise_office.json')), officeBytes)).toBe(0)
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.chat(chen, lin).messages).toEqual([old, message])
    expect((await restarted.office.downloadChatFile(chen, coordinates)).dataBase64).toBe(file.dataBase64)
    const sender = restarted.office.view(admin).members.find(member => member.id === lin)!
    await restarted.office.saveMember(admin, { ...sender, active: false }, sender)
    await expect(restarted.office.downloadChatFile(lin, coordinates)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await restarted.office.downloadChatFile(chen, coordinates)).sha256).toBe(file.sha256)
  })

  it('rejects changed retries, invalid bytes and current file/message/quota limits without extra publication', async () => {
    const ctx = await boot(await directory(), { ...config, chatMaxFileBytes: 4, chatMaxMessageBytes: 5,
      chatFilesPerMessage: 2, chatFileOwnerQuotaBytes: 6 })
    const input = fileMessage(Buffer.from('abc'))
    const message = await ctx.office.sendMessageFiles(lin, input)
    expect(await ctx.office.sendMessageFiles(lin, input)).toEqual(message)
    await expect(ctx.office.sendMessageFiles(lin, { ...input, text: 'changed caption' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.sendMessageFiles(lin, { ...input, files: [{ ...input.files[0]!, dataBase64: 'eHl6' }] }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.sendMessageFiles(xu, input)).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.sendMessageFiles(lin, fileMessage(Buffer.from('1234')))).rejects.toMatchObject({ code: 'invalid_input' })
    const overflow = fileMessage(Buffer.from('abc'))
    await expect(ctx.office.sendMessageFiles(lin, { ...overflow, files: [...overflow.files, ...overflow.files] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    const empty = { name: 'empty.txt', mediaType: 'text/plain', byteLength: 0, dataBase64: '' }
    await expect(ctx.office.sendMessageFiles(lin, { ...fileMessage(), files: [empty, empty, empty] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.sendMessageFiles(lin, { ...fileMessage(Buffer.from('a')), files: [{ ...empty, byteLength: 1, dataBase64: '$$' }] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.sendMessageFiles(lin, { ...fileMessage(Buffer.from('a')), recipientId: lin }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.office.chat(lin, chen).messages).toEqual([message])
    expect(ctx.office.chatFileLimitsFor(lin).ownerUsedBytes).toBe(3)
  })

  it('recovers ready files after failed header commit and restart without overwriting legacy chat or office bytes', async () => {
    const root = await directory()
    const ctx = await boot(root)
    await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '保留旧消息' })
    const path = join(root, 'data', 'enterprise_office_chat.json')
    const chatBytes = await readFile(path)
    const officeBytes = await readFile(join(root, 'data', 'enterprise_office.json'))
    const input = fileMessage()
    vi.spyOn(ctx.storageDomain.get('enterprise_office_chat')!.global, 'set').mockRejectedValueOnce(new Error('Header commit fixture'))
    await expect(ctx.office.sendMessageFiles(lin, input)).rejects.toThrow('Header commit fixture')
    expect(ctx.office.chat(chen, lin).messages).toHaveLength(1)
    expect(Buffer.compare(await readFile(path), chatBytes)).toBe(0)
    await expect(ctx.office.sendMessage(lin, { id: input.id, recipientId: chen, text: input.text })).rejects.toMatchObject({ code: 'conflict' })
    const objects = join(root, 'office', 'chat', 'v1', 'objects')
    const before = (await readdir(objects)).filter(name => name.endsWith('.bin'))
    expect(before).toHaveLength(1)
    await ctx.fiber.dispose()
    const restarted = await boot(root, { ...config, chatFileChunkBytes: 2 * 1024 * 1024 })
    const message = await restarted.office.sendMessageFiles(lin, input)
    expect(restarted.office.chat(chen, lin).messages).toHaveLength(2)
    expect((await readdir(objects)).filter(name => name.endsWith('.bin'))).toEqual(before)
    expect((await restarted.office.downloadChatFile(chen, { messageId: message.id, attachmentId: message.attachments![0]!.id })).dataBase64)
      .toBe(input.files[0]!.dataBase64)
    expect(Buffer.compare(await readFile(join(root, 'data', 'enterprise_office.json')), officeBytes)).toBe(0)
  })

  it('reconciles a published message after its separate file receipt fails and rejects forged download coordinates', async () => {
    const ctx = await boot(await directory())
    const domain = ctx.storageDomain.get('enterprise_office_chat_files')!
    const set = domain.global.set.bind(domain.global)
    vi.spyOn(domain.global, 'set').mockImplementationOnce(set).mockImplementationOnce(set)
      .mockRejectedValueOnce(new Error('Published file receipt fixture'))
    const input = fileMessage()
    await expect(ctx.office.sendMessageFiles(lin, input)).rejects.toThrow('Published file receipt fixture')
    const first = ctx.office.chat(chen, lin).messages[0]!
    expect(first.attachments).toHaveLength(1)
    const chatBytes = JSON.stringify(ctx.storageDomain.get('enterprise_office_chat')!.global.get())
    expect(await ctx.office.sendMessageFiles(lin, input)).toEqual(first)
    expect(JSON.stringify(ctx.storageDomain.get('enterprise_office_chat')!.global.get())).toBe(chatBytes)
    expect(ctx.office.chat(chen, lin).messages).toHaveLength(1)
    await expect(ctx.office.downloadChatFile(chen, { messageId: first.id,
      attachmentId: brandString<OfficeChatAttachmentId>(randomUUID()) })).rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.downloadChatFile(chen, { messageId: first.id, attachmentId: '../../outside' as OfficeChatAttachmentId }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('retries a ready-metadata failure after actual byte merge without leaving extra immutable objects', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const domain = ctx.storageDomain.get('enterprise_office_chat_files')!
    const set = domain.global.set.bind(domain.global)
    vi.spyOn(domain.global, 'set').mockImplementationOnce(set).mockRejectedValueOnce(new Error('Ready receipt fixture'))
    const input = fileMessage(Buffer.alloc(1024 * 1024 + 3, 0x42))
    await expect(ctx.office.sendMessageFiles(lin, input)).rejects.toThrow('Ready receipt fixture')
    expect(ctx.office.chat(chen, lin).messages).toEqual([])
    const objects = join(root, 'office', 'chat', 'v1', 'objects')
    const before = (await readdir(objects)).filter(name => name.endsWith('.bin'))
    expect(before).toHaveLength(1)
    const message = await ctx.office.sendMessageFiles(lin, input)
    expect((await readdir(objects)).filter(name => name.endsWith('.bin'))).toEqual(before)
    expect((await ctx.office.downloadChatFile(chen, { messageId: message.id, attachmentId: message.attachments![0]!.id })).dataBase64)
      .toBe(input.files[0]!.dataBase64)
  })

  it('collects only expired unpublished files using the actual timer and releases their reservations', async () => {
    const root = await directory()
    const ctx = await boot(root, { ...config, chatFilePendingTtlMs: 60000, chatFileSweepMs: 1000 })
    const plain = await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '保留消息' })
    const input = fileMessage()
    vi.spyOn(ctx.storageDomain.get('enterprise_office_chat')!.global, 'set').mockRejectedValueOnce(new Error('Unpublished header fixture'))
    await expect(ctx.office.sendMessageFiles(lin, input)).rejects.toThrow('Unpublished header fixture')
    expect(ctx.office.chatFileLimitsFor(lin).ownerUsedBytes).toBe(input.files[0]!.byteLength)
    const objects = join(root, 'office', 'chat', 'v1', 'objects')
    expect((await readdir(objects)).filter(name => name.endsWith('.bin'))).toHaveLength(1)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 60001)
    await vi.waitFor(() => { expect(ctx.office.chatFileLimitsFor(lin).ownerUsedBytes).toBe(0) }, { timeout: 5000 })
    expect((await readdir(objects)).filter(name => name.endsWith('.bin'))).toEqual([])
    expect(ctx.office.chat(chen, lin).messages).toEqual([plain])
  })

  it('refuses a lost original chat instead of deleting published files or reseeding their history', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const message = await ctx.office.sendMessageFiles(lin, fileMessage())
    const objects = join(root, 'office', 'chat', 'v1', 'objects')
    const bytes = await readFile(join(objects, `${message.attachments![0]!.id}.bin`))
    await ctx.fiber.dispose()
    await rm(join(root, 'data', 'enterprise_office_chat.json'))
    await expect(boot(root)).rejects.toThrow()
    expect(Buffer.compare(await readFile(join(objects, `${message.attachments![0]!.id}.bin`)), bytes)).toBe(0)
  })

  it('drains an accepted file message across whole-Host unload before closing any dependent domain', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const domain = ctx.storageDomain.get('enterprise_office_chat_files')!
    const set = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(set).mockImplementationOnce(async (value) => {
      entered.resolve(undefined); await release.promise; await set(value)
    })
    const service = ctx.office
    const sending = service.sendMessageFiles(lin, fileMessage())
    await entered.promise
    const closing = ctx.fiber.dispose()
    try { await expect(service.sendMessageFiles(lin, fileMessage())).rejects.toMatchObject({ code: 'closed' }) }
    finally { release.resolve(undefined) }
    const message = await sending
    await closing
    const restarted = await boot(root)
    expect(restarted.office.chat(chen, lin).messages).toEqual([message])
    expect((await restarted.office.downloadChatFile(chen, { messageId: message.id, attachmentId: message.attachments![0]!.id })).byteLength)
      .toBe(message.attachments![0]!.byteLength)
  })
})

type IntegrationFile = { global: {
  entries: Array<{ fingerprint: string; importedBy: string }>
  audit: Array<{ actorId: string }>
} }
type IdentityFile = { global: {
  credentials: Array<{ salt: string; digest: string }>
  sessions: Array<{ tokenHash: string }>
} }
type OrganizationFile = { global: { units: Array<{ id: string; parentId: string | null }> } }
type DriveFile = { global: { nodes: Array<{ parentId: string | null }> } }

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-'))
  roots.push(root)
  return root
}

async function boot(root: string, seed: Config = config, officeEnabled = true): Promise<Context> {
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'data') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { id: 'office', name: '@deepseek-ai/dsh-enterprise-office', disabled: !officeEnabled, config: { ...seed, dshHome: root } },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-enterprise-office', OfficeService],
  ])
  const internal = ctx.loader.internal
  if (!internal) throw new Error('The composition test requires the Node internal Loader')
  ctx.loader.internal = new Proxy(internal, {
    get(target, key) {
      if (key === 'import') return async (specifier: string) => {
        if (!modules.has(specifier)) throw new Error(`Unexpected composition module: ${specifier}`)
        return modules.get(specifier)
      }
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (officeEnabled && !ctx.get('office')) throw new Error('Office composition did not activate')
  return ctx
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-')) throw new Error('Unexpected temporary directory')
    await rm(absolute, { recursive: true, force: true })
  }
})

describe('resumable office drive', () => {
  const mib = 1024 * 1024
  const declaration = (bytes: Buffer, name = '分块文件.bin'): OfficeDriveUploadDeclaration => ({
    space: 'private', folderId: null, name, requestId: randomUUID(), mediaType: 'application/octet-stream',
    byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  })
  const append = (ctx: Context, actor: OfficeMemberId, ticket: OfficeDriveUploadTicket, bytes: Buffer, index: number) => {
    const part = bytes.subarray(index * ticket.chunkBytes, (index + 1) * ticket.chunkBytes)
    return ctx.office.appendDriveUpload(actor, { uploadId: ticket.id, index,
      sha256: createHash('sha256').update(part).digest('hex'), dataBase64: part.toString('base64') })
  }

  it('cold-resumes a file above eight MiB using its original chunk negotiation and downloads exactly one immutable version', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const bytes = Buffer.alloc(9 * mib + 19).fill(Buffer.from('私有真实分块内容\n'))
    const input = declaration(bytes)
    const originalOffice = await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')
    let ticket = await ctx.office.beginDriveUpload(lin, input)
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' })).toMatchObject({
      entries: [], maxFileBytes: 8 * mib, transfers: { protocol: 1, maxFileBytes: 64 * mib, chunkBytes: mib },
    })
    ticket = await append(ctx, lin, ticket, bytes, 0)
    expect(ticket.received).toEqual([0])
    await expect(ctx.office.getDriveUpload(chen, ticket.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.cancelDriveUpload(admin, ticket.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(await ctx.office.driveUploads(chen)).toEqual([])
    await ctx.fiber.dispose()
    const resumed = await boot(root, { ...config, driveChunkBytes: 2 * mib })
    ticket = await resumed.office.getDriveUpload(lin, ticket.id)
    expect(ticket.chunkBytes).toBe(mib)
    expect(ticket.received).toEqual([0])
    for (let index = 1; index < Math.ceil(bytes.length / ticket.chunkBytes); index++) {
      ticket = await append(resumed, lin, ticket, bytes, index)
    }
    const completed = await resumed.office.completeDriveUpload(lin, ticket.id)
    expect(completed).toMatchObject({ status: 'completed', receivedBytes: bytes.length, received: [] })
    expect(await resumed.office.beginDriveUpload(lin, input)).toEqual(completed)
    expect(await resumed.office.completeDriveUpload(lin, ticket.id)).toEqual(completed)
    const listing = resumed.office.drive(lin, { space: 'private', folderId: null, search: '' })
    expect(listing.entries).toHaveLength(1)
    const info = await resumed.office.driveFileInfo(lin, completed.fileId!)
    expect(info).toMatchObject({ byteLength: bytes.length, sha256: input.sha256, chunkBytes: 2 * mib })
    const chunks: Buffer[] = []
    for (let offset = 0; offset < bytes.length; offset += info.chunkBytes) {
      const part = await resumed.office.downloadDriveRange(lin, {
        id: info.id, versionId: info.versionId, offset, byteLength: Math.min(info.chunkBytes, bytes.length - offset),
      })
      const data = Buffer.from(part.dataBase64, 'base64')
      expect(createHash('sha256').update(data).digest('hex')).toBe(part.sha256)
      chunks.push(data)
    }
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
    await expect(resumed.office.driveFileInfo(chen, info.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(resumed.office.downloadDriveRange(lin, { id: info.id,
      versionId: brandString<OfficeDriveVersionId>(randomUUID()), offset: 0, byteLength: 1 })).rejects.toMatchObject({ code: 'not_found' })
    await expect(resumed.office.downloadDriveFile(lin, info.id)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')).toBe(originalOffice)
  })

  it('shares quota reservations with whole uploads and prevents cancelled identities from restarting through that endpoint', async () => {
    const root = await directory()
    const ctx = await boot(root, { ...config, driveOwnerQuotaBytes: 3 * mib, driveMaxFileBytes: 3 * mib })
    const bytes = Buffer.alloc(2 * mib, 9)
    const input = declaration(bytes)
    let ticket = await ctx.office.beginDriveUpload(lin, input)
    ticket = await append(ctx, lin, ticket, bytes, 0)
    await expect(ctx.office.beginDriveUpload(lin, declaration(bytes, 'second.bin'))).rejects.toMatchObject({ code: 'invalid_input' })
    const whole = { space: input.space, folderId: input.folderId, name: input.name, requestId: input.requestId,
      mediaType: input.mediaType, byteLength: input.byteLength, dataBase64: bytes.toString('base64') }
    await expect(ctx.office.uploadDriveFile(lin, whole)).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.uploadDriveFile(lin, { ...whole, requestId: randomUUID(), name: 'whole.bin' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await ctx.office.cancelDriveUpload(lin, ticket.id)).status).toBe('cancelled')
    expect(await readdir(join(root, 'office', 'drive', 'v1', 'objects', 'uploads'))).toEqual([])
    await expect(ctx.office.uploadDriveFile(lin, whole)).rejects.toMatchObject({ code: 'conflict' })
    const saved = await ctx.office.uploadDriveFile(lin, { ...whole, requestId: randomUUID(), name: 'whole.bin' })
    expect(saved.byteLength).toBe(bytes.length)
    await expect(ctx.office.beginDriveUpload(lin, declaration(bytes, 'third.bin'))).rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).maxFileBytes).toBe(3 * mib)
  })

  it('retries durable chunks and uncertain metadata commits without duplicate publication or deleting a committed file', async () => {
    const ctx = await boot(await directory(), { ...config, driveChunkBytes: 64 * 1024 })
    const bytes = Buffer.alloc(96 * 1024, 11)
    const ticket = await ctx.office.beginDriveUpload(lin, declaration(bytes))
    const receipts = ctx.storageDomain.get('enterprise_office_uploads')!
    const failReceipt = vi.spyOn(receipts.global, 'set')
    failReceipt.mockRejectedValueOnce(new Error('Chunk receipt storage unavailable'))
    await expect(append(ctx, lin, ticket, bytes, 0)).rejects.toThrow('receipt storage unavailable')
    expect((await ctx.office.getDriveUpload(lin, ticket.id)).received).toEqual([])
    expect((await append(ctx, lin, ticket, bytes, 0)).received).toEqual([0])
    await append(ctx, lin, ticket, bytes, 1)
    const driveDomain = ctx.storageDomain.get('enterprise_office_drive')!
    vi.spyOn(driveDomain.global, 'set').mockRejectedValueOnce(new Error('Directory write unavailable'))
    await expect(ctx.office.completeDriveUpload(lin, ticket.id)).rejects.toThrow('Directory write unavailable')
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toEqual([])
    failReceipt.mockRejectedValueOnce(new Error('Completion receipt unavailable'))
    await expect(ctx.office.completeDriveUpload(lin, ticket.id)).rejects.toThrow('Completion receipt unavailable')
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toHaveLength(1)
    const confirmed = await ctx.office.getDriveUpload(lin, ticket.id)
    expect(confirmed.status).toBe('completed')
    const resolved = await ctx.office.cancelDriveUpload(lin, ticket.id)
    expect(resolved).toEqual(confirmed)
    expect(resolved.status).toBe('completed')
    expect((await ctx.office.completeDriveUpload(lin, ticket.id))).toEqual(resolved)
    expect((await ctx.office.downloadDriveFile(lin, resolved.fileId!)).dataBase64).toBe(bytes.toString('base64'))
  })

  it('rechecks destination permissions and membership while allowing the owner to cancel revoked staging', async () => {
    const ctx = await boot(await directory(), { ...config, driveChunkBytes: 64 * 1024 })
    const folder = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: '受控上传' })
    const editable = await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: folder.revision,
      defaultAccess: 'deny', grants: [{ memberId: lin, access: 'edit' }] })
    const bytes = Buffer.alloc(128 * 1024, 12)
    const input = { ...declaration(bytes), space: 'shared' as const, folderId: folder.id }
    const ticket = await ctx.office.beginDriveUpload(lin, input)
    await append(ctx, lin, ticket, bytes, 0)
    await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: editable.revision, defaultAccess: 'deny', grants: [] })
    await expect(append(ctx, lin, ticket, bytes, 1)).rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.completeDriveUpload(lin, ticket.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await ctx.office.cancelDriveUpload(lin, ticket.id)).status).toBe('cancelled')
    const pending = await ctx.office.beginDriveUpload(lin, declaration(bytes, '停用前.bin'))
    const member = ctx.office.view(admin).members.find(member => member.id === lin)!
    await ctx.office.saveMember(admin, { ...member, active: false }, member)
    await expect(append(ctx, lin, pending, bytes, 0)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.getDriveUpload(lin, pending.id)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('expires real staging on its configured timer and releases reservations and retained outcomes', async () => {
    const root = await directory()
    const ctx = await boot(root, { ...config, driveChunkBytes: 64 * 1024, driveUploadTtlMs: 60000,
      driveUploadRetentionMs: 60000, driveUploadsPerMember: 1, driveUploadSweepMs: 1000 })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const bytes = Buffer.alloc(128 * 1024, 13)
    const ticket = await ctx.office.beginDriveUpload(lin, declaration(bytes))
    await append(ctx, lin, ticket, bytes, 0)
    const objectPath = join(root, 'office', 'drive', 'v1', 'objects', 'uploads', ticket.id)
    clock.mockReturnValue(now + 60001)
    await expect.poll(async () => {
      try { await readdir(objectPath); return false }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true; throw error }
    }, { timeout: 5000 }).toBe(true)
    expect((await ctx.office.getDriveUpload(lin, ticket.id)).status).toBe('expired')
    await expect(ctx.office.completeDriveUpload(lin, ticket.id)).rejects.toMatchObject({ code: 'conflict' })
    const replacement = await ctx.office.beginDriveUpload(lin, declaration(bytes, 'after-expiry.bin'))
    await ctx.office.cancelDriveUpload(lin, replacement.id)
    clock.mockReturnValue(now + 120002)
    await ctx.office.driveUploads(lin)
    await expect(ctx.office.getDriveUpload(lin, ticket.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(ctx.office.getDriveUpload(lin, replacement.id)).rejects.toMatchObject({ code: 'not_found' })
    clock.mockRestore()
  })

  it('drains an accepted chunk and its receipt before root disposal and restores that receipt', async () => {
    const root = await directory()
    const ctx = await boot(root, { ...config, driveChunkBytes: 64 * 1024 })
    const service = ctx.office
    const bytes = Buffer.alloc(128 * 1024, 14)
    const ticket = await service.beginDriveUpload(lin, declaration(bytes))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const uploads = ctx.storageDomain.get('enterprise_office_uploads')!
    const set = uploads.global.set.bind(uploads.global)
    vi.spyOn(uploads.global, 'set').mockImplementationOnce(async (value) => {
      entered.resolve(undefined); await release.promise
      await set(value)
    })
    const accepted = append(ctx, lin, ticket, bytes, 0)
    await entered.promise
    const disposing = ctx.fiber.dispose()
    try { await expect(service.completeDriveUpload(lin, ticket.id)).rejects.toMatchObject({ code: 'closed' }) }
    finally { release.resolve(undefined) }
    expect((await accepted).received).toEqual([0])
    await disposing
    const restarted = await boot(root)
    expect((await restarted.office.getDriveUpload(lin, ticket.id)).received).toEqual([0])
  })
})

describe('company announcements', () => {
  const publication = () => ({ requestId: randomUUID(), title: '办公通知', body: '第一行\n<script>plain text</script>', audience: 'members' as const, recipientIds: [lin] })

  it('retains scoped deliveries, private read receipts and exact retries across process restarts', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const original = await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')
    const request = publication()
    const item = await ctx.office.publishAnnouncement(admin, request)
    expect(item).toMatchObject({
      title: request.title, body: request.body, recipient: false, read: true, withdrawn: false, recipientCount: 1,
    })
    expect(ctx.office.view(chen).announcements?.entries).toEqual([])
    const received = ctx.office.view(lin).announcements!.entries[0]!
    expect(received).toMatchObject({ id: item.id, recipient: true, read: false })
    expect(received).not.toHaveProperty('recipients')
    expect(received).not.toHaveProperty('readBy')
    expect(received).not.toHaveProperty('requestId')
    expect(await ctx.office.publishAnnouncement(admin, request)).toEqual(item)
    await expect(ctx.office.publishAnnouncement(admin, { ...request, body: 'changed' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.markAnnouncementRead(chen, item.id)).rejects.toMatchObject({ code: 'not_found' })
    await ctx.office.markAnnouncementRead(lin, item.id)
    const revision = ctx.office.view(lin).announcements!.revision
    await ctx.office.markAnnouncementRead(lin, item.id)
    expect(ctx.office.view(lin).announcements!.revision).toBe(revision)
    expect(await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')).toBe(original)
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.view(lin).announcements!.entries[0]).toMatchObject({ id: item.id, read: true, body: request.body })
    expect(await restarted.office.publishAnnouncement(admin, request)).toEqual(item)
  })

  it('checks current authors and recipients, freezes company delivery, and withdraws without erasing history', async () => {
    const ctx = await boot(await directory())
    await expect(ctx.office.publishAnnouncement(lin, publication())).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.publishAnnouncement(admin, { ...publication(), recipientIds: [] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.publishAnnouncement(admin, { ...publication(), recipientIds: [lin, lin] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.publishAnnouncement(admin, { ...publication(), title: '   ' })).rejects.toMatchObject({ code: 'invalid_input' })
    const peer = ctx.office.view(chen).me
    await ctx.office.saveMember(admin, { ...peer, active: false }, peer)
    await expect(ctx.office.publishAnnouncement(admin, { ...publication(), recipientIds: [chen] })).rejects.toMatchObject({ code: 'invalid_input' })
    const record = await ctx.office.publishAnnouncement(admin, { ...publication(), audience: 'company', recipientIds: [] })
    expect(record.recipientCount).toBe(3)
    await ctx.office.saveMember(admin, { id: 'new-hire' as OfficeMemberId, name: 'New hire', department: 'Office', jobTitle: 'Employee', role: 'employee', active: true, email: '', phone: '' }, null)
    expect(ctx.office.view('new-hire' as OfficeMemberId).announcements!.entries).toEqual([])
    await expect(ctx.office.withdrawAnnouncement(lin, record.id, record.revision)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.withdrawAnnouncement(admin, record.id, record.revision + 1)).rejects.toMatchObject({ code: 'conflict' })
    await ctx.office.withdrawAnnouncement(admin, record.id, record.revision)
    await ctx.office.withdrawAnnouncement(admin, record.id, record.revision)
    expect(ctx.office.view(lin).announcements!.entries).toEqual([])
    expect(ctx.office.view(admin).announcements!.entries[0])
      .toMatchObject({ id: record.id, body: record.body, withdrawn: true, revision: 2 })
    await expect(ctx.office.markAnnouncementRead(lin, record.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('publishes no success after write failures and retries publication, acknowledgement and withdrawal', async () => {
    const ctx = await boot(await directory(), { ...config, maxAnnouncements: 1, announcementRotationMs: 2000 })
    const domain = ctx.storageDomain.get('enterprise_office_announcements')!
    const changed = vi.fn()
    ctx.on('office/announcements-changed', changed)
    const request = publication()
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Announcement write failed'))
    await expect(ctx.office.publishAnnouncement(admin, request)).rejects.toThrow('Announcement write failed')
    expect(ctx.office.view(lin).announcements).toMatchObject({ revision: 0, entries: [], maxEntries: 1, rotationMs: 2000 })
    expect(changed).not.toHaveBeenCalled()
    ctx.on('office/announcements-changed', () => { throw new Error('Expected observer failure') })
    const record = await ctx.office.publishAnnouncement(admin, request)
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Receipt write failed'))
    await expect(ctx.office.markAnnouncementRead(lin, record.id)).rejects.toThrow('Receipt write failed')
    expect(ctx.office.view(lin).announcements!.entries[0]?.read).toBe(false)
    await ctx.office.markAnnouncementRead(lin, record.id)
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Withdrawal write failed'))
    await expect(ctx.office.withdrawAnnouncement(admin, record.id, 1)).rejects.toThrow('Withdrawal write failed')
    expect(ctx.office.view(lin).announcements!.entries[0]?.withdrawn).toBe(false)
    await ctx.office.withdrawAnnouncement(admin, record.id, 1)
    expect(changed).toHaveBeenCalledTimes(3)
    await expect(ctx.office.publishAnnouncement(admin, publication())).rejects.toMatchObject({ code: 'conflict' })
    expect(await ctx.office.publishAnnouncement(admin, request)).toMatchObject({ id: record.id, withdrawn: true })
  })

  it('rechecks queued administrator authority and retains an admitted publication during root unload', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const other = ctx.office.view(xu).me
    await ctx.office.saveMember(admin, { ...other, role: 'admin' }, other)
    const domain = ctx.storageDomain.get('enterprise_office_announcements')!
    const write = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { entered.resolve(undefined); await release.promise; await write(value) })
    const publishing = ctx.office.publishAnnouncement(admin, publication())
    await entered.promise
    const current = ctx.office.view(admin).me
    const demotion = ctx.office.saveMember(xu, { ...current, role: 'employee' }, current)
    const denied = ctx.office.publishAnnouncement(admin, publication())
    const deniedResult = denied.catch((error: unknown) => error)
    const closing = ctx.fiber.dispose()
    release.resolve(undefined)
    const record = await publishing
    await demotion
    expect(await deniedResult).toMatchObject({ code: 'forbidden' })
    await closing
    const restarted = await boot(root)
    expect(restarted.office.view(lin).announcements!.entries).toMatchObject([{ id: record.id }])
  })
})

describe('company integration registrations', () => {
  const manifest = { name: 'company-oa', system: 'Company OA', version: '1.0', provider: 'Example vendor', description: 'Approval catalog', capabilities: ['Read approvals'] }
  const input = (value: unknown = manifest) => ({ requestId: randomUUID(), json: JSON.stringify(value) })

  it('persists a descriptive catalog and exact retry receipts without changing native or office work records', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const events: number[] = []
    ctx.on('office/integrations-changed', () => { events.push(1) })
    const initial = ctx.office.view(lin, day)
    const request = input()
    const record = await ctx.office.importIntegration(admin, request)
    expect(record).toMatchObject({ ...manifest, owner: '', importedBy: admin })
    expect(ctx.office.view(lin, day).integrations).toEqual({ revision: 1, maxImportBytes: 262144, entries: [record] })
    expect(ctx.office.view(lin, day).revision).toBe(initial.revision)
    expect(ctx.office.view(lin, day).items).toEqual(initial.items)
    expect(JSON.stringify(record)).not.toMatch(/fingerprint|requestId|password|address/)
    expect(await ctx.office.importIntegration(admin, request)).toEqual(record)
    expect(events).toEqual([1])
    const document = JSON.parse(await readFile(join(root, 'data', 'enterprise_office_integrations.json'), 'utf8')) as IntegrationFile
    const saved = document.global
    expect(saved.entries.at(0)!.fingerprint).toBe(createHash('sha256').update(request.json).digest('hex'))
    expect(saved.audit).toEqual([{ actorId: admin, targetId: record.id, revision: 1, time: record.importedAt }])
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.view(chen, day).integrations?.entries).toEqual([record])
    expect(await restarted.office.importIntegration(admin, request)).toEqual(record)
  })

  it('checks current administrator authority and rejects changed retries or normalized duplicate names', async () => {
    const ctx = await boot(await directory())
    for (const actor of [lin, xu]) await expect(ctx.office.importIntegration(actor, input())).rejects.toMatchObject({ code: 'forbidden' })
    const request = input()
    await ctx.office.importIntegration(admin, request)
    await expect(ctx.office.importIntegration(admin, { ...request, json: JSON.stringify({ ...manifest, version: '2.0' }) })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.importIntegration(admin, input({ ...manifest, name: ' COMPANY-OA ' }))).rejects.toMatchObject({ code: 'duplicate_name' })
    await ctx.office.importIntegration(admin, input({ ...manifest, name: 'caf\u0065\u0301' }))
    await expect(ctx.office.importIntegration(admin, input({ ...manifest, name: 'caf\u00e9' }))).rejects.toMatchObject({ code: 'duplicate_name' })
    expect(ctx.office.view(lin).integrations?.entries).toHaveLength(2)
  })

  it('rejects malformed manifests, unknown executable/secret fields and duplicate capabilities without publishing', async () => {
    const ctx = await boot(await directory())
    const before = ctx.office.view(lin)
    for (const value of [null, [], 'text', {}, { ...manifest, capabilities: [] }, { ...manifest, capabilities: ['A', ' a '] }, { ...manifest, capabilities: Array(31).fill('Capability') }, { ...manifest, owner: 4 }, { ...manifest, address: 'https://example.test/' }, { ...manifest, password: 'synthetic-secret' }, { ...manifest, code: 'node script.js' }, { ...manifest, name: 'bad\nname' }]) {
      await expect(ctx.office.importIntegration(admin, input(value))).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(ctx.office.importIntegration(admin, { requestId: randomUUID(), json: '{ broken' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.office.view(lin)).toEqual(before)
  })

  it('measures UTF-8 bytes and admits an exact 256 KiB JSON envelope', async () => {
    const ctx = await boot(await directory())
    const base = JSON.stringify({ ...manifest, name: 'utf8-catalog', description: '含中文的系统' })
    const maximum = 256 * 1024
    const tooLarge = ' '.repeat(maximum - Buffer.byteLength(base) - 1) + '  ' + base
    expect(tooLarge.length).toBeLessThan(maximum)
    expect(Buffer.byteLength(tooLarge)).toBe(maximum + 1)
    await expect(ctx.office.importIntegration(admin, { requestId: randomUUID(), json: tooLarge })).rejects.toMatchObject({ code: 'invalid_input' })
    const exact = ' '.repeat(maximum - Buffer.byteLength(base)) + base
    expect(Buffer.byteLength(exact)).toBe(maximum)
    expect(await ctx.office.importIntegration(admin, { requestId: randomUUID(), json: exact })).toMatchObject({ name: 'utf8-catalog' })
  })

  it('publishes neither catalog nor event after failed storage and safely retries the original input', async () => {
    const ctx = await boot(await directory())
    const domain = ctx.storageDomain.get('enterprise_office_integrations')!
    const before = ctx.office.view(lin).integrations
    const listener = vi.fn()
    ctx.on('office/integrations-changed', listener)
    const request = input()
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Integration storage unavailable'))
    await expect(ctx.office.importIntegration(admin, request)).rejects.toThrow('Integration storage unavailable')
    expect(ctx.office.view(lin).integrations).toEqual(before)
    expect(listener).not.toHaveBeenCalled()
    ctx.on('office/integrations-changed', () => { throw new Error('Expected catalog observer failure') })
    const record = await ctx.office.importIntegration(admin, request)
    expect(ctx.office.view(lin).integrations?.entries).toEqual([record])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rechecks a queued import after an administrator is demoted', async () => {
    const ctx = await boot(await directory())
    const member = ctx.office.view(xu).me
    await ctx.office.saveMember(admin, { ...member, role: 'admin' }, member)
    const domain = ctx.storageDomain.get('enterprise_office_integrations')!
    const write = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { entered.resolve(undefined); await release.promise; await write(value) })
    const creating = ctx.office.importIntegration(admin, input())
    await entered.promise
    const original = ctx.office.view(admin).me
    const demotion = ctx.office.saveMember(xu, { ...original, role: 'employee' }, original)
    const denied = ctx.office.importIntegration(admin, input({ ...manifest, name: 'queued' }))
    release.resolve(undefined)
    await creating
    await demotion
    await expect(denied).rejects.toMatchObject({ code: 'forbidden' })
    expect(ctx.office.view(lin).integrations?.entries).toHaveLength(1)
  })

  it('drains an admitted catalog write on whole-Host shutdown and rejects late imports', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const office = ctx.office
    const domain = ctx.storageDomain.get('enterprise_office_integrations')!
    const write = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { entered.resolve(undefined); await release.promise; await write(value) })
    const creating = office.importIntegration(admin, input())
    await entered.promise
    const closing = ctx.fiber.dispose()
    try { await expect(office.importIntegration(admin, input({ ...manifest, name: 'late' }))).rejects.toMatchObject({ code: 'closed' }) }
    finally { release.resolve(undefined) }
    const record = await creating
    await closing
    expect((await boot(root)).office.view(lin).integrations?.entries).toEqual([record])
  })

  it('fails closed on a missing directory or corrupted retained catalog without overwriting it', async () => {
    const root = await directory()
    const ctx = await boot(root)
    await ctx.office.importIntegration(admin, input())
    await ctx.fiber.dispose()
    const path = join(root, 'data', 'enterprise_office_integrations.json')
    const saved = await readFile(path, 'utf8')
    await rm(join(root, 'data', 'enterprise_office.json'))
    await expect(boot(root)).rejects.toThrow('Office composition did not activate')
    expect(await readFile(path, 'utf8')).toBe(saved)
    const second = await directory()
    const other = await boot(second)
    await other.office.importIntegration(admin, input())
    await other.fiber.dispose()
    const secondPath = join(second, 'data', 'enterprise_office_integrations.json')
    const corrupted = JSON.parse(await readFile(secondPath, 'utf8')) as IntegrationFile
    corrupted.global.entries.at(0)!.importedBy = 'missing_employee'
    corrupted.global.audit.at(0)!.actorId = 'missing_employee'
    await writeFile(secondPath, JSON.stringify(corrupted))
    await expect(boot(second)).rejects.toThrow('Office composition did not activate')
    expect(JSON.parse(await readFile(secondPath, 'utf8'))).toEqual(corrupted)
  })
})

describe('office sign-in through real storage', () => {
  const password = 'Office test password 2026!'
  const replacement = 'Replacement office password!'

  it('persists salted credentials and token hashes while keeping secrets out of business views', async () => {
    const root = await directory()
    const ctx = await boot(root)
    expect(await ctx.office.initializeIdentity(admin, password)).toBe(true)
    await ctx.office.setIdentityPassword(admin, lin, password)
    const receipt = await ctx.office.login({ memberId: lin, password })
    expect(ctx.office.authenticate(receipt.token).id).toBe(lin)
    expect(receipt.expiresAt - Date.now()).toBeGreaterThan(7 * 60 * 60 * 1000)
    const serialized = await readFile(join(root, 'data', 'enterprise_office_identity.json'), 'utf8')
    expect(serialized).not.toContain(password)
    expect(serialized).not.toContain(receipt.token)
    const saved = (JSON.parse(serialized) as IdentityFile).global
    expect(saved.credentials.at(0)!.salt).not.toBe(saved.credentials.at(1)!.salt)
    expect(saved.credentials.at(0)!.digest).not.toBe(saved.credentials.at(1)!.digest)
    expect(saved.sessions.at(0)!.tokenHash).toBe(createHash('sha256').update(receipt.token).digest('hex'))
    expect(JSON.stringify(ctx.office.view(admin))).not.toMatch(/salt|digest|tokenHash/)
    expect(ctx.office.identityOverview(admin)).toEqual({ initialized: true, enrolledMemberIds: [admin, lin] })
    expect(() => ctx.office.identityOverview(lin)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.authenticate(receipt.token).id).toBe(lin)
    expect(await restarted.office.initializeIdentity(admin, replacement)).toBe(false)
    await expect(restarted.office.login({ memberId: admin, password: replacement })).rejects.toMatchObject({ code: 'unauthenticated' })
    expect((await restarted.office.login({ memberId: admin, password })).member.id).toBe(admin)
  })

  it('uses one denial for wrong credentials, unknown employees and inactive members', async () => {
    const ctx = await boot(await directory())
    await expect(ctx.office.login({ memberId: admin, password })).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.office.initializeIdentity(lin, password)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.initializeIdentity(admin, 'short')).rejects.toMatchObject({ code: 'invalid_input' })
    await ctx.office.initializeIdentity(admin, password)
    await ctx.office.setIdentityPassword(admin, lin, password)
    await expect(ctx.office.setIdentityPassword(lin, chen, password)).rejects.toMatchObject({ code: 'forbidden' })
    for (const input of [{ memberId: admin, password: replacement }, { memberId: brandString<OfficeMemberId>('missing'), password }, { memberId: admin, password, role: 'admin' }]) {
      await expect(ctx.office.login(input)).rejects.toMatchObject({ code: 'unauthenticated' })
    }
    const employee = ctx.office.view(lin).me
    await ctx.office.saveMember(admin, { ...employee, active: false }, employee)
    await expect(ctx.office.login({ memberId: lin, password })).rejects.toMatchObject({ code: 'unauthenticated' })
    for (const token of ['', 'invalid', 'x'.repeat(43)]) expect(() => ctx.office.authenticate(token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  })

  it('publishes no credentials or sessions when the durable write fails', async () => {
    const ctx = await boot(await directory())
    const domain = ctx.storageDomain.get('enterprise_office_identity')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Identity disk unavailable'))
    await expect(ctx.office.initializeIdentity(admin, password)).rejects.toThrow('Identity disk unavailable')
    expect(ctx.office.identityOverview(admin)).toEqual({ initialized: false, enrolledMemberIds: [] })
    await ctx.office.initializeIdentity(admin, password)
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Session disk unavailable'))
    await expect(ctx.office.login({ memberId: admin, password })).rejects.toThrow('Session disk unavailable')
    expect(domain.global.get()).toMatchObject({ sessions: [] })
    const receipt = await ctx.office.login({ memberId: admin, password })
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Logout disk unavailable'))
    await expect(ctx.office.logout(receipt.token)).rejects.toThrow('Logout disk unavailable')
    expect(ctx.office.authenticate(receipt.token).id).toBe(admin)
    await ctx.office.logout(receipt.token)
    await ctx.office.logout(receipt.token)
    expect(() => ctx.office.authenticate(receipt.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  })

  it('limits device sessions, expires tokens and only permits revoking an own session', async () => {
    const ctx = await boot(await directory())
    await ctx.office.initializeIdentity(admin, password)
    await ctx.office.setIdentityPassword(admin, lin, password)
    const first = await ctx.office.login({ memberId: admin, password })
    let current = first
    for (let index = 0; index < 5; index++) current = await ctx.office.login({ memberId: admin, password })
    expect(() => ctx.office.authenticate(first.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    const sessions = ctx.office.identitySessions(current.token)
    expect(sessions).toHaveLength(5)
    expect(sessions.filter(entry => entry.current)).toHaveLength(1)
    expect(JSON.stringify(sessions)).not.toMatch(/token|salt|digest/)
    const other = await ctx.office.login({ memberId: lin, password })
    const own = ctx.office.identitySessions(other.token)[0]!
    await expect(ctx.office.revokeIdentitySession(current.token, own.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(ctx.office.authenticate(other.token).id).toBe(lin)
    await ctx.office.revokeIdentitySession(other.token, own.id)
    expect(() => ctx.office.authenticate(other.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    vi.spyOn(Date, 'now').mockReturnValue(current.expiresAt)
    expect(() => ctx.office.authenticate(current.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  })

  it('rechecks current roles and requires an enrolled administrator to remain active', async () => {
    const ctx = await boot(await directory())
    await ctx.office.initializeIdentity(admin, password)
    const receipt = await ctx.office.login({ memberId: admin, password })
    const employee = ctx.office.view(lin).me
    await ctx.office.saveMember(admin, { ...employee, role: 'admin' }, employee)
    const original = ctx.office.view(admin).me
    await expect(ctx.office.saveMember(admin, { ...original, role: 'employee' }, original)).rejects.toMatchObject({ code: 'invalid_input' })
    await ctx.office.setIdentityPassword(admin, lin, password)
    await ctx.office.saveMember(admin, { ...original, role: 'employee' }, original)
    expect(ctx.office.authenticate(receipt.token).role).toBe('employee')
    await expect(ctx.office.setIdentityPassword(admin, chen, password)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('rejects offboarded tokens and never revives them on reactivation', async () => {
    const ctx = await boot(await directory())
    await ctx.office.initializeIdentity(admin, password)
    await ctx.office.setIdentityPassword(admin, lin, password)
    const receipt = await ctx.office.login({ memberId: lin, password })
    const employee = ctx.office.view(lin).me
    const disabled = await ctx.office.saveMember(admin, { ...employee, active: false }, employee)
    expect(() => ctx.office.authenticate(receipt.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    await ctx.office.saveMember(admin, { ...disabled, active: true }, disabled)
    expect(() => ctx.office.authenticate(receipt.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    expect((await ctx.office.login({ memberId: lin, password })).member.id).toBe(lin)
  })

  it('atomically replaces passwords and revokes every previous device session', async () => {
    const ctx = await boot(await directory())
    await ctx.office.initializeIdentity(admin, password)
    await ctx.office.setIdentityPassword(admin, lin, password)
    const first = await ctx.office.login({ memberId: lin, password })
    const second = await ctx.office.login({ memberId: lin, password })
    await expect(ctx.office.changeIdentityPassword(first.token, { currentPassword: replacement, newPassword: replacement })).rejects.toMatchObject({ code: 'unauthenticated' })
    await ctx.office.changeIdentityPassword(first.token, { currentPassword: password, newPassword: replacement })
    for (const receipt of [first, second]) expect(() => ctx.office.authenticate(receipt.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    await expect(ctx.office.login({ memberId: lin, password })).rejects.toMatchObject({ code: 'unauthenticated' })
    const fresh = await ctx.office.login({ memberId: lin, password: replacement })
    await ctx.office.setIdentityPassword(admin, lin, password)
    expect(() => ctx.office.authenticate(fresh.token)).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
    expect((await ctx.office.login({ memberId: lin, password })).member.id).toBe(lin)
  })

  it('rechecks membership after password hashing and refuses late login writes after unload', async () => {
    const ctx = await boot(await directory())
    await ctx.office.initializeIdentity(admin, password)
    await ctx.office.setIdentityPassword(admin, lin, password)
    const employee = ctx.office.view(lin).me
    const pending = ctx.office.login({ memberId: lin, password })
    const denied = expect(pending).rejects.toMatchObject({ code: 'unauthenticated' })
    await ctx.office.saveMember(admin, { ...employee, active: false }, employee)
    await denied
    const domain = ctx.storageDomain.get('enterprise_office_identity')!
    const writes = vi.spyOn(domain.global, 'set')
    const office = ctx.office
    const signingIn = expect(office.login({ memberId: admin, password })).rejects.toMatchObject({ code: 'closed' })
    await ctx.fiber.dispose()
    await signingIn
    expect(writes).not.toHaveBeenCalled()
  })

  it('refuses credential corruption and directory loss without overwriting saved identities', async () => {
    const root = await directory()
    const ctx = await boot(root)
    await ctx.office.initializeIdentity(admin, password)
    await ctx.fiber.dispose()
    const path = join(root, 'data', 'enterprise_office_identity.json')
    const original = await readFile(path, 'utf8')
    await rm(join(root, 'data', 'enterprise_office.json'))
    await expect(boot(root, { ...config, companyName: 'Replacement company' })).rejects.toThrow('Office composition did not activate')
    expect(await readFile(path, 'utf8')).toBe(original)
    const secondRoot = await directory()
    const second = await boot(secondRoot)
    await second.office.initializeIdentity(admin, password)
    await second.fiber.dispose()
    const secondPath = join(secondRoot, 'data', 'enterprise_office_identity.json')
    const document = JSON.parse(await readFile(secondPath, 'utf8')) as IdentityFile
    document.global.credentials.at(0)!.digest = 'corrupted'
    const corrupted = JSON.stringify(document)
    await writeFile(secondPath, corrupted)
    await expect(boot(secondRoot)).rejects.toThrow('Office composition did not activate')
    expect(await readFile(secondPath, 'utf8')).toBe(corrupted)
  })
})

describe('employee office composition', () => {
  it('initializes formal organization only after an administrator reviews the current directory', async () => {
    const ctx = await boot(await directory())
    expect(ctx.office.organization(lin)).toMatchObject({ initialized: false, units: [], positions: [], assignments: [] })
    expect(ctx.office.view(lin).organization).toBeUndefined()
    await expect(ctx.office.initializeOrganization(lin, 0)).rejects.toMatchObject({ code: 'forbidden' })
    const member = ctx.office.view(lin).me
    await ctx.office.updateProfile(lin, { name: member.name, department: member.department, jobTitle: member.jobTitle, email: 'lin@example.test', phone: '' })
    await expect(ctx.office.initializeOrganization(admin, 0)).rejects.toMatchObject({ code: 'conflict' })
    const org = await ctx.office.initializeOrganization(admin, ctx.office.view(admin).revision)
    expect(org.initialized).toBe(true)
    expect(org.units.map(entry => entry.name)).toEqual(['行政', '运营', '财务'])
    expect(org.assignments).toHaveLength(config.members.length)
    expect(ctx.office.view(lin).organization?.revision).toBe(1)
    const snapshot = JSON.stringify(org)
    await ctx.office.updateProfile(lin, { name: member.name, department: 'Self-chosen department', jobTitle: 'Self-chosen CEO title', email: '', phone: '' })
    expect(ctx.office.organization(admin)).toEqual(org)
    expect(JSON.stringify(await ctx.office.initializeOrganization(admin, 0))).toBe(snapshot)
    expect(ctx.office.view(lin).me.role).toBe('employee')
  })

  it('persists department hierarchy, scoped positions and reviewed assignments without changing roles', async () => {
    const root = await directory()
    const ctx = await boot(root)
    await ctx.office.initializeOrganization(admin, 0)
    const parent = await ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: null, name: 'Company', active: true })
    const child = await ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: parent.id, name: 'Research / Product', active: true })
    const position = await ctx.office.savePosition(admin, { id: null, revision: 0, unitId: child.id, name: 'Administrator title', active: true })
    const original = ctx.office.organization(admin).assignments.find(entry => entry.memberId === lin)!
    const assigned = await ctx.office.assignOrganization(admin, {
      memberId: lin, revision: original.revision, unitId: child.id, positionId: position.id,
    })
    expect(assigned.revision).toBe(original.revision + 1)
    expect(ctx.office.view(lin).me.role).toBe('employee')
    await expect(ctx.office.assignOrganization(lin, { ...assigned, unitId: parent.id, positionId: null })).rejects.toMatchObject({ code: 'forbidden' })
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.organization(lin).units).toContainEqual(child)
    expect(restarted.office.organization(lin).positions).toContainEqual(position)
    expect(restarted.office.organization(lin).assignments).toContainEqual(assigned)
    expect(restarted.office.view(lin).me).toMatchObject({ role: 'employee', department: '运营', jobTitle: '员工' })
  })

  it('rejects duplicate departments, hierarchy cycles and stale edits without publishing a revision', async () => {
    const ctx = await boot(await directory())
    await ctx.office.initializeOrganization(admin, 0)
    const parent = await ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: null, name: 'Operations', active: true })
    const child = await ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: parent.id, name: 'Nested', active: true })
    const before = ctx.office.organization(admin)
    await expect(ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: null, name: 'operations', active: true })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.saveOrganizationUnit(admin, { ...parent, parentId: child.id })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.saveOrganizationUnit(admin, { ...parent, parentId: parent.id })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.office.organization(admin)).toEqual(before)
    const renamed = await ctx.office.saveOrganizationUnit(admin, { ...child, name: 'Renamed' })
    await expect(ctx.office.saveOrganizationUnit(admin, { ...child, name: 'Stale overwrite' })).rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.organization(admin).units).toContainEqual(renamed)
    await expect(ctx.office.saveOrganizationUnit(lin, { ...parent, name: 'Employee overwrite' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('rejects incompatible positions and in-use deactivation, retaining explicit unassignment versions', async () => {
    const ctx = await boot(await directory())
    await ctx.office.initializeOrganization(admin, 0)
    const unit = await ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: null, name: 'New department', active: true })
    const position = await ctx.office.savePosition(admin, { id: null, revision: 0, unitId: unit.id, name: 'Approver', active: true })
    const original = ctx.office.organization(admin).assignments.find(entry => entry.memberId === lin)!
    await expect(ctx.office.assignOrganization(admin, { ...original, positionId: position.id })).rejects.toMatchObject({ code: 'invalid_input' })
    const assigned = await ctx.office.assignOrganization(admin, { ...original, unitId: unit.id, positionId: position.id })
    await expect(ctx.office.assignOrganization(admin, { ...original, unitId: unit.id, positionId: null })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.savePosition(admin, { ...position, active: false })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.saveOrganizationUnit(admin, { ...unit, active: false })).rejects.toMatchObject({ code: 'conflict' })
    const cleared = await ctx.office.assignOrganization(admin, { ...assigned, unitId: null, positionId: null })
    await ctx.office.savePosition(admin, { ...position, active: false })
    const inactive = await ctx.office.saveOrganizationUnit(admin, { ...unit, active: false })
    expect(ctx.office.organization(lin).units.some(entry => entry.id === inactive.id)).toBe(false)
    expect(ctx.office.organization(lin).positions.some(entry => entry.id === position.id)).toBe(false)
    expect(ctx.office.organization(lin).assignments).toContainEqual(cleared)
    await expect(ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: inactive.id, name: 'Invalid new child', active: true })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('hides inactive affiliations from employee views and retains administrator history through reactivation', async () => {
    const ctx = await boot(await directory())
    await ctx.office.initializeOrganization(admin, 0)
    const original = ctx.office.view(chen).me
    const disabled = await ctx.office.saveMember(admin, { ...original, active: false }, original)
    expect(ctx.office.organization(lin).assignments.some(entry => entry.memberId === chen)).toBe(false)
    const retained = ctx.office.organization(admin).assignments.find(entry => entry.memberId === chen)!
    expect(retained).toBeDefined()
    await expect(ctx.office.assignOrganization(admin, retained)).rejects.toMatchObject({ code: 'invalid_input' })
    const cleared = await ctx.office.assignOrganization(admin, { ...retained, unitId: null, positionId: null })
    await ctx.office.saveMember(admin, { ...disabled, active: true }, disabled)
    expect(ctx.office.organization(chen).assignments).toContainEqual(cleared)
  })

  it('retains editable inactive hierarchy and hides inactive affiliations after an employee returns', async () => {
    const ctx = await boot(await directory())
    await ctx.office.initializeOrganization(admin, 0)
    const parent = await ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: null, name: 'Archived division', active: true })
    const child = await ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: parent.id, name: 'Archived department', active: true })
    const position = await ctx.office.savePosition(admin, { id: null, revision: 0, unitId: child.id, name: 'Archived position', active: true })
    const original = ctx.office.organization(admin).assignments.find(entry => entry.memberId === chen)!
    await ctx.office.assignOrganization(admin, { ...original, unitId: child.id, positionId: position.id })
    const member = ctx.office.view(chen).me
    const disabled = await ctx.office.saveMember(admin, { ...member, active: false }, member)
    const inactivePosition = await ctx.office.savePosition(admin, { ...position, active: false })
    const inactiveChild = await ctx.office.saveOrganizationUnit(admin, { ...child, active: false })
    await ctx.office.saveOrganizationUnit(admin, { ...parent, active: false })
    await ctx.office.saveMember(admin, { ...disabled, active: true }, disabled)
    const renamedChild = await ctx.office.saveOrganizationUnit(admin, { ...inactiveChild, name: 'Renamed archived department' })
    const renamedPosition = await ctx.office.savePosition(admin, { ...inactivePosition, name: 'Renamed archived position' })
    expect(ctx.office.organization(admin).units).toContainEqual(renamedChild)
    expect(ctx.office.organization(admin).positions).toContainEqual(renamedPosition)
    expect(ctx.office.organization(chen).assignments.find(entry => entry.memberId === chen))
      .toMatchObject({ unitId: null, positionId: null })
    await expect(ctx.office.saveOrganizationUnit(admin, { ...renamedChild, active: true })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('leaves first configuration untouched on a failed write and contains observer failures after commit', async () => {
    const ctx = await boot(await directory())
    const domain = ctx.storageDomain.get('enterprise_office_organization')!
    const seen = vi.fn()
    ctx.on('office/organization-changed', seen)
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Organization storage unavailable'))
    await expect(ctx.office.initializeOrganization(admin, 0)).rejects.toThrow('Organization storage unavailable')
    expect(ctx.office.organization(admin)).toMatchObject({ initialized: false, revision: 0, units: [] })
    expect(seen).not.toHaveBeenCalled()
    ctx.on('office/organization-changed', () => { throw new Error('Observer unavailable') })
    const initialized = await ctx.office.initializeOrganization(admin, 0)
    expect(initialized.initialized).toBe(true)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(ctx.office.view(lin).organization).toBeDefined()
  })

  it('rechecks administrator authority in the shared queue and drains an admitted organization write at unload', async () => {
    const root = await directory()
    const ctx = await boot(root)
    await ctx.office.initializeOrganization(admin, 0)
    const promoted = ctx.office.view(admin).managedMembers!.find(entry => entry.id === xu)!
    await ctx.office.saveMember(admin, { ...promoted, role: 'admin' }, promoted)
    const oldAdmin = ctx.office.view(admin).me
    const demotion = ctx.office.saveMember(xu, { ...oldAdmin, role: 'employee' }, oldAdmin)
    const denied = ctx.office.saveOrganizationUnit(admin, { id: null, revision: 0, parentId: null, name: 'Queued unauthorized edit', active: true })
    await demotion
    await expect(denied).rejects.toMatchObject({ code: 'forbidden' })
    const domain = ctx.storageDomain.get('enterprise_office_organization')!
    const original = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { entered.resolve(undefined); await release.promise; await original(value) })
    const office = ctx.office
    const pending = office.saveOrganizationUnit(xu, { id: null, revision: 0, parentId: null, name: 'Admitted before unload', active: true })
    await entered.promise
    const disposing = ctx.fiber.dispose()
    try {
      await expect(office.saveOrganizationUnit(xu, { id: null, revision: 0, parentId: null, name: 'Late edit', active: true })).rejects.toMatchObject({ code: 'closed' })
    } finally { release.resolve(undefined) }
    const saved = await pending
    await disposing
    const restarted = await boot(root)
    expect(restarted.office.organization(xu).units).toContainEqual(saved)
    expect(restarted.office.organization(xu).units.some(entry => entry.name === 'Queued unauthorized edit')).toBe(false)
  })

  it('fails closed on corrupted ancestry and refuses directory reseeding over retained organization', async () => {
    const root = await directory()
    const ctx = await boot(root)
    await ctx.office.initializeOrganization(admin, 0)
    await ctx.fiber.dispose()
    const path = join(root, 'data', 'enterprise_office_organization.json')
    const document = JSON.parse(await readFile(path, 'utf8')) as OrganizationFile
    document.global.units.at(0)!.parentId = document.global.units.at(0)!.id
    const corrupted = JSON.stringify(document)
    await writeFile(path, corrupted)
    await expect(boot(root)).rejects.toThrow('Office composition did not activate')
    expect(await readFile(path, 'utf8')).toBe(corrupted)
    const secondRoot = await directory()
    const second = await boot(secondRoot)
    await second.office.initializeOrganization(admin, 0)
    await second.fiber.dispose()
    const saved = await readFile(join(secondRoot, 'data', 'enterprise_office_organization.json'), 'utf8')
    await rm(join(secondRoot, 'data', 'enterprise_office.json'))
    await expect(boot(secondRoot)).rejects.toThrow('Office composition did not activate')
    expect(await readFile(join(secondRoot, 'data', 'enterprise_office_organization.json'), 'utf8')).toBe(saved)
  })

  it('retains legal prototype-named employee identities, messages, drafts and grants across restart', async () => {
    const root = await directory()
    const ids = ['constructor', '__proto__', 'toString'].map(value => brandString<OfficeMemberId>(value))
    const ctx = await boot(root, { ...config, members: [...config.members, ...ids.map(id => ({ id, name: `Employee ${id}`, department: 'Office', jobTitle: 'Employee', role: 'employee' as const }))] })
    const folder = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Reserved identity grants' })
    await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: 1, defaultAccess: 'deny', grants: ids.map(memberId => ({ memberId, access: 'view' })) })
    for (const id of ids) {
      await ctx.office.sendMessage(lin, { id: randomUUID() as OfficeMessageId, recipientId: id, text: `Message for ${id}` })
      await ctx.office.saveChatDraft(lin, { peerId: id, text: `Draft for ${id}`, revision: 0, requestId: randomUUID() })
    }
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    for (const id of ids) {
      expect(restarted.office.view(id).me.id).toBe(id)
      expect(restarted.office.chat(id, lin).messages.map(entry => entry.text)).toEqual([`Message for ${id}`])
      expect(restarted.office.drive(id, { space: 'shared', folderId: null, search: '' }).entries.map(entry => entry.id)).toEqual([folder.id])
    }
    expect(restarted.office.chatDrafts(lin).drafts).toEqual(ids.map(peerId => ({ peerId, text: `Draft for ${peerId}`, revision: 1 })))
  })

  it('closes a late-opened domain when the plugin unloads during initialization', async () => {
    const root = await directory()
    const ctx = await boot(root, config, false)
    const original = ctx.storageDomain.open.bind(ctx.storageDomain)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const held = async <S extends DomainSpec>(spec: S): Promise<Domain<S>> => {
      const domain = await original(spec)
      entered.resolve(undefined)
      await release.promise
      return domain
    }
    vi.spyOn(ctx.storageDomain, 'open').mockImplementationOnce(held)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'office')!
    const activating = ctx.loader.update(entry.id, { disabled: false })
    await entered.promise
    const disposing = entry.fiber!.dispose()
    release.resolve(undefined)
    await Promise.all([activating, disposing])
    expect(ctx.storageDomain.get('enterprise_office')).toBeUndefined()
    expect(ctx.storageDomain.get('enterprise_office_chat')).toBeUndefined()
    expect(ctx.get('office')).toBeUndefined()
    await ctx.loader.create({ name: '@deepseek-ai/dsh-enterprise-office', config: { ...config, dshHome: root } })
    await ctx.loader.await()
    expect(ctx.office.view(lin).me.id).toBe(lin)
  })

  it('stores actual binary file bytes and preserves authorized downloads across a real restart', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
    const input = { space: 'private' as const, folderId: null, name: '二进制资料.bin', requestId: randomUUID(), byteLength: bytes.byteLength, mediaType: 'application/octet-stream', dataBase64: bytes.toString('base64') }
    const file = await ctx.office.uploadDriveFile(lin, input)
    expect(file).toMatchObject({ kind: 'file', name: input.name, byteLength: 256, ownerId: lin })
    const download = await ctx.office.downloadDriveFile(lin, file.id)
    expect(Buffer.from(download.dataBase64, 'base64')).toEqual(bytes)
    expect(download.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    for (const other of [chen, admin]) await expect(ctx.office.downloadDriveFile(other, file.id)).rejects.toMatchObject({ code: 'not_found' })
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(await restarted.office.downloadDriveFile(lin, file.id)).toEqual(download)
    expect(restarted.office.drive(lin, { space: 'private', folderId: null, search: '.bin' }).entries.map(entry => entry.id)).toEqual([file.id])
  })

  it('deduplicates an exact upload retry and rejects changes without publishing another object', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const input = { space: 'private' as const, folderId: null, name: 'retry.txt', requestId: randomUUID(), byteLength: 3, mediaType: 'text/plain', dataBase64: Buffer.from('one').toString('base64') }
    const file = await ctx.office.uploadDriveFile(lin, input)
    const before = ctx.office.drive(lin, { space: 'private', folderId: null, search: '' })
    expect(await ctx.office.uploadDriveFile(lin, input)).toEqual(file)
    await expect(ctx.office.uploadDriveFile(lin, { ...input, dataBase64: Buffer.from('two').toString('base64') })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.uploadDriveFile(lin, { ...input, name: 'different.txt' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.uploadDriveFile(chen, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' })).toEqual(before)
    const renamed = await ctx.office.renameDriveEntry(lin, { id: file.id, revision: file.revision, name: 'renamed.txt' })
    expect(await ctx.office.uploadDriveFile(lin, input)).toEqual(renamed)
    expect(await readdir(join(root, 'office', 'drive', 'v1', 'objects'))).toHaveLength(1)
  })

  it('rejects malformed, oversized or path-like uploads and accepts a real empty file', async () => {
    const ctx = await boot(await directory())
    const input = { space: 'private' as const, folderId: null, name: 'empty.txt', requestId: randomUUID(), byteLength: 0, mediaType: 'text/plain', dataBase64: '' }
    for (const patch of [
      { byteLength: 8 * 1024 * 1024 + 1 }, { byteLength: 1 }, { dataBase64: '???' },
      { byteLength: 1, dataBase64: 'Zh==' }, { byteLength: 1, dataBase64: 'Zg==\n' },
      { mediaType: 'text/plain\r\nInjected: yes' }, { name: '../outside.txt' }, { requestId: 'not-a-uuid' },
    ]) await expect(ctx.office.uploadDriveFile(lin, { ...input, ...patch })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toEqual([])
    const file = await ctx.office.uploadDriveFile(lin, input)
    expect(await ctx.office.downloadDriveFile(lin, file.id)).toMatchObject({ byteLength: 0, dataBase64: '', sha256: createHash('sha256').digest('hex') })
    await expect(ctx.office.createDriveFolder(lin, { space: 'private', folderId: file.id, name: '文件不是目录' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rechecks both file and ancestor permissions before returning any downloaded bytes', async () => {
    const ctx = await boot(await directory())
    const folder = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: '授权下载' })
    const input = { space: 'shared' as const, folderId: folder.id, name: 'report.txt', requestId: randomUUID(), byteLength: 6, mediaType: 'text/plain', dataBase64: Buffer.from('report').toString('base64') }
    await expect(ctx.office.uploadDriveFile(lin, input)).rejects.toMatchObject({ code: 'forbidden' })
    const file = await ctx.office.uploadDriveFile(admin, input)
    const limited = await ctx.office.saveDrivePermissions(admin, { id: file.id, revision: 1, defaultAccess: 'deny', grants: [{ memberId: chen, access: 'view' }] })
    expect((await ctx.office.downloadDriveFile(chen, file.id)).dataBase64).toBe(input.dataBase64)
    await expect(ctx.office.downloadDriveFile(lin, file.id)).rejects.toMatchObject({ code: 'not_found' })
    await ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: 1, defaultAccess: 'deny', grants: [] })
    await expect(ctx.office.downloadDriveFile(chen, file.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(ctx.office.drive(chen, { space: 'shared', folderId: null, search: 'report' }).entries).toEqual([])
    expect(limited.grants).toEqual([{ memberId: chen, access: 'view' }])
  })

  it('never exposes an object from a failed metadata commit and retries safely after restart', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const input = { space: 'private' as const, folderId: null, name: 'atomic.txt', requestId: randomUUID(), byteLength: 4, mediaType: 'text/plain', dataBase64: Buffer.from('real').toString('base64') }
    const domain = ctx.storageDomain.get('enterprise_office_drive')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Metadata commit failed'))
    await expect(ctx.office.uploadDriveFile(lin, input)).rejects.toThrow('Metadata commit failed')
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toEqual([])
    // Keep an unreachable object after uncertain metadata failure; never delete bytes that a commit might reference.
    expect(await readdir(join(root, 'office', 'drive', 'v1', 'objects'))).toHaveLength(1)
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    const file = await restarted.office.uploadDriveFile(lin, input)
    expect((await restarted.office.downloadDriveFile(lin, file.id)).dataBase64).toBe(input.dataBase64)
    expect(restarted.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toHaveLength(1)
  })

  it('refuses corrupted stored bytes while retaining the original metadata for recovery', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const file = await ctx.office.uploadDriveFile(lin, { space: 'private', folderId: null, name: 'integrity.txt', requestId: randomUUID(), byteLength: 4, mediaType: 'text/plain', dataBase64: Buffer.from('good').toString('base64') })
    const objects = join(root, 'office', 'drive', 'v1', 'objects')
    const [object] = await readdir(objects)
    if (!object) throw new Error('Missing committed object')
    await writeFile(join(objects, object), 'evil')
    await expect(ctx.office.downloadDriveFile(lin, file.id)).rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toEqual([file])
  })

  it('isolates private drive roots, opaque navigation and search across employees and administrators', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const personal = await ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: '个人资料' })
    const nested = await ctx.office.createDriveFolder(lin, { space: 'private', folderId: personal.id, name: '工资单' })
    await ctx.office.createDriveFolder(chen, { space: 'private', folderId: null, name: '个人资料' })
    expect(ctx.office.drive(lin, { space: 'private', folderId: personal.id, search: '' }).path.map(entry => entry.name)).toEqual(['个人资料'])
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '工资' }).entries.map(entry => entry.id)).toEqual([nested.id])
    for (const other of [chen, admin]) {
      expect(ctx.office.drive(other, { space: 'private', folderId: null, search: '工资' }).entries).toEqual([])
      expect(() => ctx.office.drive(other, { space: 'private', folderId: personal.id, search: '' })).toThrow(expect.objectContaining({ code: 'not_found' }))
      await expect(ctx.office.createDriveFolder(other, { space: 'private', folderId: personal.id, name: '越权' })).rejects.toMatchObject({ code: 'not_found' })
      await expect(ctx.office.renameDriveEntry(other, { id: nested.id, revision: 1, name: '越权' })).rejects.toMatchObject({ code: 'not_found' })
    }
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.drive(lin, { space: 'private', folderId: personal.id, search: '' }).entries.map(entry => entry.id)).toEqual([nested.id])
    expect(restarted.office.drive(admin, { space: 'private', folderId: null, search: '' }).entries).toEqual([])
  })

  it('inherits shared conditions and blocks explicit child grants and ownership behind a hidden ancestor', async () => {
    const ctx = await boot(await directory())
    const parent = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: '共享部门' })
    expect(ctx.office.drive(lin, { space: 'shared', folderId: null, search: '' }).entries[0]).toMatchObject({ access: 'view', canRename: false, canManageAccess: false })
    expect(ctx.office.drive(lin, { space: 'shared', folderId: null, search: '' }).entries[0]).not.toHaveProperty('grants')
    await expect(ctx.office.createDriveFolder(lin, { space: 'shared', folderId: parent.id, name: '只读不能创建' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.renameDriveEntry(lin, { id: parent.id, revision: parent.revision, name: '只读不能改名' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.saveDrivePermissions(lin, { id: parent.id, revision: parent.revision, defaultAccess: 'edit', grants: [] })).rejects.toMatchObject({ code: 'forbidden' })
    const permitted = await ctx.office.saveDrivePermissions(admin, { id: parent.id, revision: 1, defaultAccess: 'view', grants: [{ memberId: chen, access: 'edit' }] })
    const child = await ctx.office.createDriveFolder(chen, { space: 'shared', folderId: parent.id, name: '同事所有的子目录' })
    await ctx.office.saveDrivePermissions(chen, { id: child.id, revision: 1, defaultAccess: 'deny', grants: [{ memberId: lin, access: 'edit' }] })
    expect(ctx.office.drive(lin, { space: 'shared', folderId: child.id, search: '' }).canCreate).toBe(true)
    expect(ctx.office.drive(lin, { space: 'shared', folderId: parent.id, search: '' }).entries[0]?.canRename).toBe(false)
    await ctx.office.createDriveFolder(lin, { space: 'shared', folderId: child.id, name: '显式编辑授权' })
    // Administrator role does not bypass the child's owner-defined visibility.
    expect(ctx.office.drive(admin, { space: 'shared', folderId: parent.id, search: '' }).entries).toEqual([])
    await ctx.office.saveDrivePermissions(admin, { id: parent.id, revision: permitted.revision, defaultAccess: 'deny', grants: [] })
    for (const actor of [lin, chen]) {
      expect(ctx.office.drive(actor, { space: 'shared', folderId: null, search: '子目录' }).entries).toEqual([])
      expect(() => ctx.office.drive(actor, { space: 'shared', folderId: child.id, search: '' })).toThrow(expect.objectContaining({ code: 'not_found' }))
      await expect(ctx.office.createDriveFolder(actor, { space: 'shared', folderId: child.id, name: '隐藏后不能写入' })).rejects.toMatchObject({ code: 'not_found' })
    }
    await expect(ctx.office.saveDrivePermissions(chen, { id: child.id, revision: 2, defaultAccess: 'view', grants: [] })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects stale drive changes, duplicate conditions, private sharing and case-insensitive sibling collisions', async () => {
    const ctx = await boot(await directory())
    const folder = await ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'Reports' })
    const before = ctx.office.drive(admin, { space: 'shared', folderId: null, search: '' })
    await expect(ctx.office.createDriveFolder(admin, { space: 'shared', folderId: null, name: 'reports' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: 1, defaultAccess: 'view', grants: [{ memberId: lin, access: 'view' }, { memberId: lin, access: 'edit' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: 1, defaultAccess: 'view', grants: [{ memberId: admin, access: 'deny' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.office.drive(admin, { space: 'shared', folderId: null, search: '' })).toEqual(before)
    const changed = await ctx.office.renameDriveEntry(admin, { id: folder.id, revision: 1, name: '资料' })
    await expect(ctx.office.renameDriveEntry(admin, { id: folder.id, revision: 1, name: '旧窗口' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: 1, defaultAccess: 'edit', grants: [] })).rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.drive(admin, { space: 'shared', folderId: null, search: '' }).entries).toEqual([changed])
    const personal = await ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: '私有' })
    await expect(ctx.office.saveDrivePermissions(lin, { id: personal.id, revision: 1, defaultAccess: 'view', grants: [{ memberId: chen, access: 'edit' }] })).rejects.toMatchObject({ code: 'forbidden' })
    const employee = ctx.office.view(chen).me
    await ctx.office.saveMember(admin, { ...employee, active: false }, employee)
    await expect(ctx.office.saveDrivePermissions(admin, { id: folder.id, revision: changed.revision, defaultAccess: 'view', grants: [{ memberId: chen, access: 'edit' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(() => ctx.office.drive(chen, { space: 'shared', folderId: null, search: '' })).toThrow(expect.objectContaining({ code: 'forbidden' }))
  })

  it('normalizes directory names without crossing sibling or employee boundaries and preserves no-op bytes', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const folder = await ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: '  Cafe\u0301  ' })
    expect(folder.name).toBe('Café')
    const largest = await ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: 'x'.repeat(255) })
    expect(largest.name).toHaveLength(255)
    const nested = await ctx.office.createDriveFolder(lin, { space: 'private', folderId: folder.id, name: 'CAFÉ' })
    const other = await ctx.office.createDriveFolder(chen, { space: 'private', folderId: null, name: 'CAFÉ' })
    expect(nested.parentId).toBe(folder.id)
    expect(other.ownerId).toBe(chen)
    const path = join(root, 'data', 'enterprise_office_drive.json')
    const bytes = await readFile(path)
    await expect(ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: 'CAFE\u0301' }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: 'x'.repeat(256) }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.renameDriveEntry(lin, { id: folder.id, revision: folder.revision, name: 'NUL.txt' }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(await ctx.office.renameDriveEntry(lin, { id: folder.id, revision: folder.revision, name: '  Cafe\u0301  ' })).toEqual(folder)
    expect(await readFile(path)).toEqual(bytes)
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toHaveLength(2)
    expect(ctx.office.drive(chen, { space: 'private', folderId: null, search: '' }).entries).toEqual([other])
  })

  it.each(['', '.', '..', '../secret', 'a\\b', 'a/b', 'a:b', 'bad?', 'bad*', 'bad.', 'NUL.txt', 'COM1', 'Lpt9.pdf', '\u0000hidden'])('rejects unsafe drive names without creating metadata: %j', async (name) => {
    const ctx = await boot(await directory())
    await expect(ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toEqual([])
  })

  it('does not publish failed drive writes, survives observer errors and drains a queued write at unload', async () => {
    const ctx = await boot(await directory())
    const service = ctx.office
    const domain = ctx.storageDomain.get('enterprise_office_drive')!
    let changes = 0
    ctx.on('office/drive-changed', () => { changes++ })
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Drive disk failure'))
    await expect(service.createDriveFolder(lin, { space: 'private', folderId: null, name: '失败不创建' })).rejects.toThrow('Drive disk failure')
    expect(changes).toBe(0)
    expect(service.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toEqual([])
    ctx.on('office/drive-changed', () => { throw new Error('Drive observer failure') })
    const folder = await service.createDriveFolder(lin, { space: 'private', folderId: null, name: '持久目录' })
    expect(changes).toBe(1)
    const write = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { entered.resolve(undefined); await release.promise; await write(value) })
    const renaming = service.renameDriveEntry(lin, { id: folder.id, revision: 1, name: '已接收的修改' })
    await entered.promise
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'office')!
    const disposing = entry.fiber!.dispose()
    try { await expect(service.createDriveFolder(lin, { space: 'private', folderId: null, name: '关闭后拒绝' })).rejects.toMatchObject({ code: 'closed' }) }
    finally { release.resolve(undefined) }
    const renamed = await renaming
    await disposing
    await ctx.loader.create({ name: '@deepseek-ai/dsh-enterprise-office', config })
    await ctx.loader.await()
    expect(ctx.office.drive(lin, { space: 'private', folderId: null, search: '' }).entries).toEqual([renamed])
  })

  it('fails closed on corrupted persisted drive ancestry without resetting the directory', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const folder = await ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: '不能覆盖' })
    await ctx.fiber.dispose()
    const path = join(root, 'data', 'enterprise_office_drive.json')
    const document = JSON.parse(await readFile(path, 'utf8')) as DriveFile
    document.global.nodes.at(0)!.parentId = folder.id
    const corrupted = JSON.stringify(document)
    await writeFile(path, corrupted)
    await expect(boot(root)).rejects.toThrow('Office composition did not activate')
    expect(await readFile(path, 'utf8')).toBe(corrupted)
  })

  it('refuses to reseed a company over saved drive metadata when the employee directory is missing', async () => {
    const root = await directory()
    const ctx = await boot(root)
    await ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: '旧企业资料' })
    await ctx.fiber.dispose()
    const path = join(root, 'data', 'enterprise_office_drive.json')
    const previous = await readFile(path, 'utf8')
    await rm(join(root, 'data', 'enterprise_office.json'))
    await expect(boot(root, { ...config, companyName: '另一家企业' })).rejects.toThrow('Office composition did not activate')
    expect(await readFile(path, 'utf8')).toBe(previous)
  })

  it('rejects drive mutations queued behind employee deactivation', async () => {
    const ctx = await boot(await directory())
    const employee = ctx.office.view(lin).me
    const disabling = ctx.office.saveMember(admin, { ...employee, active: false }, employee)
    const creating = ctx.office.createDriveFolder(lin, { space: 'private', folderId: null, name: '停用后不能排队创建' })
    await disabling
    await expect(creating).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('persists private contact drafts and tombstones without granting administrators access', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const input = { peerId: chen, text: '  未发送\n下一行  ', revision: 0, requestId: randomUUID() }
    const saved = await ctx.office.saveChatDraft(lin, input)
    expect(saved).toEqual({ peerId: chen, text: input.text, revision: 1 })
    expect(ctx.office.chatDrafts(lin)).toEqual({ meId: lin, drafts: [saved] })
    expect(ctx.office.chatDrafts(chen).drafts).toEqual([])
    expect(ctx.office.chatDrafts(admin).drafts).toEqual([])
    expect(ctx.office.chat(lin, chen).messages).toEqual([])
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.chatDrafts(lin).drafts).toEqual([saved])
    const cleared = await restarted.office.saveChatDraft(lin, { ...input, text: '', revision: 1, requestId: randomUUID() })
    expect(cleared.revision).toBe(2)
    await expect(restarted.office.saveChatDraft(lin, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
    expect(restarted.office.chatDrafts(lin).drafts).toEqual([cleared])
  })

  it('serializes competing draft versions and retries only the exact committed payload', async () => {
    const ctx = await boot(await directory())
    const input = { peerId: chen, text: '窗口一', revision: 0, requestId: randomUUID() }
    let changed = 0
    ctx.on('office/chat-drafts-changed', () => { changed++ })
    const first = ctx.office.saveChatDraft(lin, input)
    const other = ctx.office.saveChatDraft(lin, { ...input, text: '窗口二', requestId: randomUUID() })
    const [saved] = await Promise.all([first, expect(other).rejects.toMatchObject({ code: 'conflict' })])
    expect(await ctx.office.saveChatDraft(lin, input)).toEqual(saved)
    expect(changed).toBe(1)
    await expect(ctx.office.saveChatDraft(lin, { ...input, text: '更换重试内容' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.saveChatDraft(lin, { ...input, revision: 1 })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.saveChatDraft(lin, { ...input, peerId: lin })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.saveChatDraft(lin, { ...input, text: 'x'.repeat(16_001) })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.saveChatDraft(lin, { ...input, requestId: 'invalid' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.office.chatDrafts(lin).drafts).toEqual([saved])
  })

  it('keeps failed draft writes private and rejects an employee disabled ahead of a queued save', async () => {
    const ctx = await boot(await directory())
    const domain = ctx.storageDomain.get('enterprise_office_chat_drafts')!
    const input = { peerId: chen, text: '不能假保存', revision: 0, requestId: randomUUID() }
    let changed = 0
    ctx.on('office/chat-drafts-changed', () => { changed++ })
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Disk full'))
    await expect(ctx.office.saveChatDraft(lin, input)).rejects.toThrow('Disk full')
    expect(ctx.office.chatDrafts(lin).drafts).toEqual([])
    expect(changed).toBe(0)
    ctx.on('office/chat-drafts-changed', () => { throw new Error('Draft observer failed') })
    expect((await ctx.office.saveChatDraft(lin, input)).revision).toBe(1)
    expect(changed).toBe(1)
    const employee = ctx.office.view(lin).me
    const disable = ctx.office.saveMember(admin, { ...employee, active: false }, employee)
    const write = ctx.office.saveChatDraft(lin, { ...input, text: '排队写入', revision: 1, requestId: randomUUID() })
    await disable
    await expect(write).rejects.toMatchObject({ code: 'forbidden' })
    expect(() => ctx.office.chatDrafts(lin)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(ctx.office.chatDrafts(admin).drafts).toEqual([])
  })

  it('drains admitted draft writes before closing every office domain at unload', async () => {
    const ctx = await boot(await directory())
    const service = ctx.office
    const domain = ctx.storageDomain.get('enterprise_office_chat_drafts')!
    const write = domain.global.set.bind(domain.global)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { entered.resolve(undefined); await release.promise; await write(value) })
    const input = { peerId: chen, text: '卸载前已接收', revision: 0, requestId: randomUUID() }
    const saving = service.saveChatDraft(lin, input)
    await entered.promise
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'office')!
    const disposing = entry.fiber!.dispose()
    try { await expect(service.saveChatDraft(lin, input)).rejects.toMatchObject({ code: 'closed' }) }
    finally { release.resolve(undefined) }
    const saved = await saving
    await disposing
    expect(() => service.chatDrafts(lin)).toThrow(expect.objectContaining({ code: 'closed' }))
    await ctx.loader.create({ name: '@deepseek-ai/dsh-enterprise-office', config })
    await ctx.loader.await()
    expect(ctx.office.chatDrafts(lin).drafts).toEqual([saved])
  })

  it('persists private messages and receipts for both participants without an administrator history bypass', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const input: OfficeChatInput = { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '  保留格式\n下一行  ' }
    const sent = await ctx.office.sendMessage(lin, input)
    const reply = await ctx.office.sendMessage(chen, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: lin, text: '收到' })
    expect(ctx.office.chat(chen, lin).messages).toEqual([sent, reply])
    expect(ctx.office.chat(chen).threads[0]?.unread).toBe(1)
    expect(ctx.office.chat(admin, chen).messages).toEqual([])
    expect(ctx.office.chat(xu).threads).toEqual([])
    await expect(ctx.office.readChat(xu, chen, sent.sequence)).rejects.toMatchObject({ code: 'not_found' })
    await ctx.office.readChat(chen, lin, reply.sequence)
    expect(ctx.office.chat(chen).threads[0]?.unread).toBe(0)
    expect(ctx.office.chat(lin, chen).peerReadThrough).toBe(reply.sequence)
    const revision = ctx.office.chat(lin, chen).revision
    await ctx.office.readChat(chen, lin, sent.sequence)
    expect(await ctx.office.sendMessage(lin, input)).toEqual(sent)
    expect(ctx.office.chat(lin, chen).revision).toBe(revision)
    await expect(ctx.office.sendMessage(lin, { ...input, text: 'Changed retry' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.office.sendMessage(admin, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.chat(admin, chen).messages).toEqual([])
    const before = ctx.office.chat(lin, chen)
    await ctx.fiber.dispose()
    const restarted = await boot(root)
    expect(restarted.office.chat(lin, chen)).toEqual(before)
  })

  it('publishes no private-message success or unread count when storage fails', async () => {
    const ctx = await boot(await directory())
    const input: OfficeChatInput = { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '原子消息' }
    const revisions: number[] = []
    ctx.on('office/chat-changed', () => { revisions.push(ctx.office.chat(lin).revision) })
    const domain = ctx.storageDomain.get('enterprise_office_chat')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Chat storage unavailable'))
    await expect(ctx.office.sendMessage(lin, input)).rejects.toThrow('Chat storage unavailable')
    expect(ctx.office.chat(lin).threads).toEqual([])
    expect(ctx.office.chat(chen).threads).toEqual([])
    expect(revisions).toEqual([])
    await ctx.office.sendMessage(lin, input)
    expect(revisions).toEqual([1])
    await expect(ctx.office.sendMessage(lin, { ...input, senderId: admin } as OfficeChatInput)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.sendMessage(lin, { ...input, id: brandString<OfficeMessageId>(randomUUID()), text: '  \n ' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('drains an admitted message before closing both office domains and fences retained handles', async () => {
    const ctx = await boot(await directory())
    const service = ctx.office
    const domain = ctx.storageDomain.get('enterprise_office_chat')!
    const set = domain.global.set.bind(domain.global)
    const started = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { started.resolve(undefined); await gate.promise; await set(value) })
    const sending = service.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '卸载前已受理' })
    await started.promise
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'office')!
    const disposing = entry.fiber!.dispose()
    try {
      await expect(service.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '卸载期间拒绝' })).rejects.toMatchObject({ code: 'closed' })
      expect(() => service.chat(lin, chen)).toThrow(expect.objectContaining({ code: 'closed' }))
    } finally { gate.resolve(undefined) }
    const message = await sending
    await disposing
    await ctx.loader.create({ name: '@deepseek-ai/dsh-enterprise-office', config })
    await ctx.loader.await()
    expect(ctx.office.chat(chen, lin).messages).toEqual([message])
  })

  it('does not reject a committed message when one chat observer fails', async () => {
    const ctx = await boot(await directory())
    ctx.on('office/chat-changed', () => { throw new Error('Private chat observer failed') })
    const observed: number[] = []
    ctx.on('office/chat-changed', () => { observed.push(ctx.office.chat(lin).revision) })
    const message = await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '已提交消息' })
    expect(ctx.office.chat(chen, lin).messages).toEqual([message])
    expect(observed).toEqual([1])
  })

  it('keeps authorized chat history after offboarding and rejects queued sends from or to inactive employees', async () => {
    const ctx = await boot(await directory())
    const input = { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: '留存历史' }
    await ctx.office.sendMessage(lin, input)
    const original = ctx.office.view(chen).me
    const disabling = ctx.office.saveMember(admin, { ...original, active: false }, original)
    const senderDenied = ctx.office.sendMessage(chen, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: lin, text: '停用后发送' })
    const recipientDenied = ctx.office.sendMessage(lin, { ...input, id: brandString<OfficeMessageId>(randomUUID()) })
    await disabling
    await expect(senderDenied).rejects.toMatchObject({ code: 'forbidden' })
    await expect(recipientDenied).rejects.toMatchObject({ code: 'not_found' })
    expect(() => ctx.office.chat(chen, lin)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(ctx.office.chat(lin, chen)).toMatchObject({ peer: { name: original.name, active: false }, messages: [{ text: '留存历史' }] })
    expect(() => ctx.office.chat(xu, chen)).toThrow(expect.objectContaining({ code: 'not_found' }))
  })

  it('pages private history by an exclusive sequence without hiding messages after they are read', async () => {
    const ctx = await boot(await directory())
    for (let index = 0; index < 105; index++) {
      await ctx.office.sendMessage(lin, { id: brandString<OfficeMessageId>(randomUUID()), recipientId: chen, text: `Message ${index}` })
    }
    const current = ctx.office.chat(chen, lin)
    expect(current.messages).toHaveLength(100)
    expect(current.messages[0]?.text).toBe('Message 5')
    expect(current.hasMore).toBe(true)
    const older = ctx.office.chat(chen, lin, current.messages[0]!.sequence)
    expect(older.messages.map(entry => entry.text)).toEqual(['Message 0', 'Message 1', 'Message 2', 'Message 3', 'Message 4'])
    expect(older.hasMore).toBe(false)
    await ctx.office.readChat(chen, lin, current.messages.at(-1)!.sequence)
    expect(ctx.office.chat(chen).threads[0]?.unread).toBe(0)
    expect(ctx.office.chat(chen, lin).messages).toHaveLength(100)
    expect(() => ctx.office.chat(chen, lin, 0)).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() => ctx.office.chat(lin, lin)).toThrow(expect.objectContaining({ code: 'invalid_input' }))
  }, 15_000)

  it('persists assignments, distinct invitations, replies, notifications and profile changes across restart', async () => {
    const root = await directory()
    const first = await boot(root)
    const task = await first.office.createWork(lin, work)
    const event = await first.office.createSchedule(lin, meeting)
    expect(event.participants).toEqual([{ memberId: lin, reply: 'accepted' }, { memberId: chen, reply: 'pending' }])
    const accepted = await first.office.reply(chen, event.id, event.revision, 'accepted')
    await first.office.setStatus(chen, task.id, task.revision, 'completed')
    const original = first.office.view(lin, day).me
    await first.office.updateProfile(lin, { name: '林晓同事', department: original.department, jobTitle: '运营专员', email: 'lin@example.test', phone: '123' })
    const before = first.office.view(chen, day)
    expect(before.notifications.map(entry => entry.kind)).toEqual(['assigned', 'invited'])
    await first.office.markRead(chen, before.notifications[0]!.id)
    const audit = first.office.audit(admin)
    await first.fiber.dispose()
    const restarted = await boot(root, { ...config, companyName: '不得覆盖已有公司' })
    expect(restarted.office.view(lin, day).companyName).toBe('远山科技')
    expect(restarted.office.view(lin, day).me).toMatchObject({ name: '林晓同事', jobTitle: '运营专员', role: 'employee' })
    expect(restarted.office.getItem(chen, event.id)).toEqual(accepted)
    expect(restarted.office.audit(admin)).toEqual(audit)
    const result = restarted.office.view(chen, day)
    expect(result.notifications.map(entry => entry.read)).toEqual([true, false])
    expect({
      items: result.day.items.map(item => ({ title: item.title, status: item.status, time: item.time, participants: item.participants })),
      pending: result.day.pending, completed: result.day.completed, completionRate: result.day.completionRate,
    }).toMatchSnapshot()
  })

  it('checks read, mutation, inbox and administration authority in the service itself', async () => {
    const ctx = await boot(await directory())
    const task = await ctx.office.createWork(lin, work)
    expect(ctx.office.view(xu, day).items).toEqual([])
    expect(() => ctx.office.getItem(xu, task.id)).toThrow(expect.objectContaining({ code: 'not_found' }))
    await expect(ctx.office.setStatus(xu, task.id, task.revision, 'completed')).rejects.toMatchObject({ code: 'not_found' })
    const notification = ctx.office.view(chen, day).notifications[0]!
    await expect(ctx.office.markRead(lin, notification.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(() => ctx.office.audit(lin)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    await expect(ctx.office.saveMember(lin, { ...ctx.office.view(lin, day).me, role: 'admin' })).rejects.toMatchObject({ code: 'forbidden' })
    const calendar = await ctx.office.createSchedule(lin, meeting)
    await expect(ctx.office.setStatus(chen, calendar.id, calendar.revision, 'cancelled')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(ctx.office.reply(lin, calendar.id, calendar.revision, 'declined')).rejects.toMatchObject({ code: 'forbidden' })
    expect(ctx.office.getItem(lin, calendar.id).status).toBe('pending')
  })

  it('rejects impossible dates, blank input, reversed intervals and unknown invitees without partial delivery', async () => {
    const ctx = await boot(await directory())
    const before = ctx.office.view(lin, day)
    for (const patch of [{ title: ' ' }, { date: '2026-02-30' }, { time: '24:00' }]) {
      await expect(ctx.office.createWork(lin, { ...work, ...patch })).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(ctx.office.createSchedule(lin, { ...meeting, endTime: '09:59' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.createSchedule(lin, { ...meeting, inviteeIds: [brandString<OfficeMemberId>('absent')] })).rejects.toMatchObject({ code: 'forbidden' })
    expect(ctx.office.view(lin, day)).toEqual(before)
    expect(ctx.office.view(chen, day).notifications).toEqual([])
  })

  it('serializes creations and rejects a stale concurrent edit without losing another update', async () => {
    const ctx = await boot(await directory())
    const created = await Promise.all(Array.from({ length: 10 }, (_, index) => ctx.office.createWork(lin, { ...work, title: `工作 ${index}` })))
    expect(ctx.office.view(chen, day).items).toHaveLength(10)
    expect(ctx.office.view(chen, day).notifications).toHaveLength(10)
    const target = created[0]!
    const changes = await Promise.allSettled([
      ctx.office.setStatus(chen, target.id, target.revision, 'in_progress'),
      ctx.office.setStatus(lin, target.id, target.revision, 'completed'),
    ])
    expect(changes.map(entry => entry.status)).toEqual(['fulfilled', 'rejected'])
    expect(changes[1]).toMatchObject({ reason: { code: 'conflict' } })
    expect(ctx.office.getItem(lin, target.id)).toMatchObject({ status: 'in_progress', revision: 2 })
  })

  it('keeps cancelled/completed work visible, sorts untimed work last and calculates from authorized data', async () => {
    const ctx = await boot(await directory())
    await ctx.office.createWork(lin, { kind: 'todo', title: '无时间', date: day, ownerId: lin })
    await ctx.office.createWork(lin, { ...work, title: '已取消', time: '08:00', status: 'cancelled' })
    await ctx.office.createWork(lin, { ...work, title: '已完成', status: 'completed' })
    await ctx.office.createSchedule(lin, meeting)
    await ctx.office.createWork(xu, { ...work, ownerId: xu, title: '无关工作' })
    const result = ctx.office.view(lin, day).day
    expect(result.items.map(item => item.title)).toEqual(['已取消', '已完成', '周会', '无时间'])
    expect(result).toMatchObject({ pending: 2, completed: 1, cancelled: 1, work: 3, schedules: 1, completionRate: 33 })
    expect(ctx.office.view(lin, '2026-10-16').day.items).toEqual([])
  })

  it('revokes a disabled employee before later queued work and preserves the last administrator', async () => {
    const ctx = await boot(await directory())
    const before = ctx.office.view(chen, day).me
    const disabling = ctx.office.saveMember(admin, { ...before, active: false })
    const queued = ctx.office.createWork(chen, work)
    await disabling
    await expect(queued).rejects.toMatchObject({ code: 'forbidden' })
    expect(() => ctx.office.view(chen, day)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    await expect(ctx.office.saveMember(admin, { ...ctx.office.view(admin, day).me, active: false })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.office.view(admin, day).me.active).toBe(true)
  })

  it('protects employee creation and reviewed edits from duplicate or concurrent changes', async () => {
    const ctx = await boot(await directory())
    const original = ctx.office.view(chen, day).me
    const revision = ctx.office.view(admin, day).revision
    await expect(ctx.office.saveMember(admin, { ...original, name: 'Duplicate' }, null)).rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.view(admin, day).revision).toBe(revision)
    expect(ctx.office.view(chen, day).me).toEqual(original)

    await ctx.office.updateProfile(chen, { name: 'Changed by employee', department: original.department, jobTitle: original.jobTitle, email: original.email, phone: original.phone })
    const audit = ctx.office.audit(admin)
    await expect(ctx.office.saveMember(admin, { ...original, role: 'manager' }, original)).rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.audit(admin)).toEqual(audit)
    expect(ctx.office.view(chen, day).me).toMatchObject({ name: 'Changed by employee', role: 'employee' })

    const current = ctx.office.view(chen, day).me
    await ctx.office.saveMember(admin, { ...current, role: 'manager' }, current)
    expect(ctx.office.view(chen, day).me.role).toBe('manager')
    await expect(ctx.office.saveMember(admin, current, { ...current, id: lin })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(ctx.office.saveMember(lin, { ...current, name: 'Forbidden' }, null)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('persists new and inactive members while exposing the management directory only to administrators', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const member = { ...ctx.office.view(chen, day).me, id: brandString<OfficeMemberId>('new_employee'), name: 'New employee' }
    await ctx.office.saveMember(admin, member, null)
    expect(ctx.office.view(lin, day).members).toContainEqual(member)
    expect(ctx.office.view(lin, day)).not.toHaveProperty('managedMembers')
    const offboarded = await ctx.office.saveMember(admin, { ...member, active: false }, member)
    expect(ctx.office.view(lin, day).members).not.toContainEqual(offboarded)
    expect(ctx.office.view(admin, day).managedMembers).toContainEqual(offboarded)
    await expect(ctx.office.createWork(member.id, work)).rejects.toMatchObject({ code: 'forbidden' })
    expect(() => ctx.office.view(member.id)).toThrow(expect.objectContaining({ code: 'forbidden' }))
    await ctx.fiber.dispose()

    const restarted = await boot(root)
    expect(restarted.office.view(admin, day).managedMembers).toContainEqual(offboarded)
    await expect(restarted.office.saveMember(admin, { ...member, name: 'Duplicate inactive' }, null)).rejects.toMatchObject({ code: 'conflict' })
    const soleAdmin = restarted.office.view(admin, day).me
    await expect(restarted.office.saveMember(admin, { ...soleAdmin, role: 'employee' }, soleAdmin)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('does not publish an item, notification or successful revision when its storage write fails', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const before = ctx.office.view(lin, day)
    const disk = await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')
    const changes: number[] = []
    ctx.on('office/changed', (revision) => { changes.push(revision) })
    const domain = ctx.storageDomain.get('enterprise_office')!
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('Storage unavailable before commit'))
    await expect(ctx.office.createSchedule(lin, meeting)).rejects.toThrow('Storage unavailable')
    expect(ctx.office.view(lin, day)).toEqual(before)
    expect(ctx.office.view(chen, day).notifications).toEqual([])
    expect(changes).toEqual([])
    expect(await readFile(join(root, 'data', 'enterprise_office.json'), 'utf8')).toBe(disk)
    await ctx.office.createWork(lin, work)
    expect(changes).toEqual([1])
  })

  it('rejects profile privilege fields and denies replies after meeting cancellation', async () => {
    const ctx = await boot(await directory())
    const profile = { name: '林晓', department: '运营', jobTitle: '员工', email: '', phone: '' }
    const untrusted = { ...profile, role: 'admin' }
    await expect(ctx.office.updateProfile(lin, untrusted)).rejects.toMatchObject({ code: 'invalid_input' })
    const event = await ctx.office.createSchedule(lin, meeting)
    const cancelled = await ctx.office.setStatus(lin, event.id, event.revision, 'cancelled')
    const before = ctx.office.view(chen, day)
    await expect(ctx.office.reply(chen, event.id, cancelled.revision, 'accepted')).rejects.toMatchObject({ code: 'conflict' })
    expect(ctx.office.view(chen, day)).toEqual(before)
    expect(ctx.office.view(lin, day).me.role).toBe('employee')
  })

  it('reports a notification observer failure without rejecting a committed operation', async () => {
    const ctx = await boot(await directory())
    ctx.on('office/changed', () => { throw new Error('Observer failed') })
    const observed: number[] = []
    ctx.on('office/changed', (revision) => { observed.push(revision) })
    const task = await ctx.office.createWork(lin, work)
    expect(ctx.office.getItem(chen, task.id).title).toBe(work.title)
    expect(ctx.office.view(chen, day).notifications).toHaveLength(1)
    expect(observed).toEqual([1])
  })

  it('waits for an admitted write during unload and rejects new work while draining', async () => {
    const root = await directory()
    const ctx = await boot(root)
    const service = ctx.office
    const domain = ctx.storageDomain.get('enterprise_office')!
    const set = domain.global.set.bind(domain.global)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(domain.global, 'set').mockImplementationOnce(async (value) => { entered(); await gate; await set(value) })
    const creating = service.createWork(lin, work)
    await started
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'office')!
    const disposing = entry.fiber!.dispose()
    try {
      await expect(service.createWork(lin, work)).rejects.toMatchObject({ code: 'closed' })
    } finally { release() }
    const task = await creating
    await disposing
    expect(ctx.get('office')).toBeUndefined()
    await ctx.loader.create({ name: '@deepseek-ai/dsh-enterprise-office', config })
    await ctx.loader.await()
    expect(ctx.office.getItem(chen, task.id).title).toBe(work.title)
    expect(ctx.office.view(lin, day).items).toHaveLength(1)
  })

  it('unloads and remounts without duplicate domain handles or lost data', async () => {
    const ctx = await boot(await directory())
    const old = ctx.office
    const task = await old.createWork(lin, work)
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'office')!
    await entry.fiber!.dispose()
    expect(ctx.get('office')).toBeUndefined()
    expect(() => old.view(lin, day)).toThrow(expect.objectContaining({ code: 'closed' }))
    await expect(old.createWork(lin, work)).rejects.toMatchObject({ code: 'closed' })
    await ctx.loader.create({ name: '@deepseek-ai/dsh-enterprise-office', config })
    await ctx.loader.await()
    expect(ctx.office.getItem(chen, task.id)).toEqual(task)
    expect(ctx.office.view(chen, day).notifications).toHaveLength(1)
  })
})
