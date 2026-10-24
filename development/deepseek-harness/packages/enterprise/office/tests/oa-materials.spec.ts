/** Actual Office uploads and immutable object reads exercise material authorization and byte integrity independently of a customer OA. */
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createOfficeOaMaterialReader } from '../src/oa-materials.ts'
import { OfficeDriveTransferFiles } from '../src/drive-transfer-files.ts'
import type { OfficeConnectorWriteRequest } from '../src/connector-http.ts'
import type { OfficeConnectorExecutionId, OfficeDriveId } from '../src/types.ts'
import { bootConnector03, lin, wei } from './fixtures/connector-03.ts'

async function fixture() {
  const { ctx, root } = await bootConnector03()
  const bytes = Buffer.from('Actual reviewed invoice 原始凭证')
  const uploaded = await ctx.office.uploadDriveFile(lin, { space: 'private', folderId: null, requestId: randomUUID(),
    name: 'invoice.txt', mediaType: 'text/plain', byteLength: bytes.byteLength, dataBase64: bytes.toString('base64') })
  const info = await ctx.office.driveFileInfo(lin, uploaded.id)
  const directory = join(root, 'office', 'drive', 'v1', 'objects')
  const files = new OfficeDriveTransferFiles(directory, { maxFileBytes: 1024, chunkBytes: 4 })
  let authorizations = 0
  const reader = createOfficeOaMaterialReader((request, reference) => {
    const history = ctx.office.driveHistory(request.member.id, brandString<OfficeDriveId>(reference.id))
    authorizations++
    if (!history.versions.some(version => version.versionId === reference.version)) throw new Error('Version unavailable')
    return { blob: { id: info.versionId, byteLength: info.byteLength, sha256: info.sha256 },
      name: history.entry.name, mediaType: info.mediaType }
  }, () => files, { maxFileBytes: 1024, chunkBytes: 4 })
  const reference = { id: info.id, version: info.versionId, sha256: info.sha256 }
  const request: OfficeConnectorWriteRequest = { actionId: 'submit', member: { id: lin, role: 'employee' },
    baseUrl: 'http://127.0.0.1:49031/oa/', executionId: brandString<OfficeConnectorExecutionId>(randomUUID()), values: {},
    headers: {}, signal: new AbortController().signal, maxResponseBytes: 65536, maxResultBytes: 65536, maxEntries: 100 }
  return { reader, bytes, reference, request, directory, get authorizations() { return authorizations } }
}

it('reads actual uploaded bytes through original Drive ownership and rechecks authorization for every chunk', async () => {
  const f = await fixture()
  const file = await f.reader.read(f.request, f.reference)
  expect(Buffer.from(file.bytes)).toEqual(f.bytes)
  expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(f.reference.sha256)
  expect(f.authorizations).toBeGreaterThan(Math.ceil(f.bytes.byteLength / 4))
  await expect(f.reader.read({ ...f.request, member: { id: wei, role: 'employee' } }, f.reference)).rejects.toThrow()
})

it('returns no material on a changed review digest, corrupt object or cancelled request', async () => {
  const f = await fixture()
  await expect(f.reader.read(f.request, { ...f.reference, sha256: '0'.repeat(64) })).rejects.toThrow()
  await writeFile(join(f.directory, f.reference.version + '.bin'), Buffer.alloc(f.bytes.byteLength))
  await expect(f.reader.read(f.request, f.reference)).rejects.toThrow()
  const cancellation = new AbortController()
  cancellation.abort()
  await expect(f.reader.read({ ...f.request, signal: cancellation.signal }, f.reference)).rejects.toThrow()
})
