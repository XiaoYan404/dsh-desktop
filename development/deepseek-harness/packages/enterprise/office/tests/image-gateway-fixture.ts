/** Owned JSON Office/Gateway composition and decodable PNG padding for complete-response byte checks. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { crc32 } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import type { Config as OfficeConfig } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeConversationId, OfficeImagePolicy, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import OfficeGateway from '../../office-gateway/src/index.ts'
import { OfficeGatewayClient } from '../../../client/ui-office/src/gateway-client.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const own = import.meta.dirname
const administrator = brandString<OfficeMemberId>('reviewed-image-admin')
/** Real decoder/source limits; the complete result shares the existing Gateway client's 16 MiB maximum. */
export const imagePolicy: OfficeImagePolicy = { maxSourceBytes: 20 * 1024 * 1024,
  maxSourcePixels: 64 * 1024 * 1024, maxSourceDimension: 8192,
  maxResponseBytes: 16 * 1024 * 1024, mediaTypes: ['image/png'] }

/**
 * Build the minimal Office configuration without changing the default-disabled image capability.
 * @param dshHome - Owned temporary application directory.
 * @returns Required seed membership and isolated home; no imageRead field is present.
 */
export function officeConfig(dshHome: string): OfficeConfig {
  return { companyName: 'Reviewed image response', timeZone: 'Asia/Shanghai', dshHome,
    members: [{ id: administrator, name: 'Image administrator', department: 'Office', jobTitle: 'Administrator', role: 'admin' }] }
}

/**
 * Pad a committed real PNG using one ancillary chunk with its actual CRC, preserving the raster pixels.
 * @param byteLength - Complete encoded file length, including the added chunk framing.
 * @returns A real PNG decoded by the unmodified attachment-local implementation in the candidate reader.
 */
export async function paddedPng(byteLength: number): Promise<Buffer> {
  const original = await readFile(new URL('../../../../snapshots/session/read-image/workspace/red.png', import.meta.url))
  if (original.toString('ascii', original.length - 8, original.length - 4) !== 'IEND')
    throw new Error('Owned PNG fixture has no final IEND chunk')
  const payloadLength = byteLength - original.length - 12
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) throw new Error('PNG padding requires a larger integer file length')
  const chunk = Buffer.alloc(payloadLength + 12)
  chunk.writeUInt32BE(payloadLength, 0)
  chunk.write('paDd', 4, 'ascii')
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4)
  return Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)])
}

/**
 * Keep acquisition, credential ownership, HTTP lifetime and JSON-directory removal under the same fixture owner.
 * @param run - One new response-size scenario using the actual candidate service and HTTP Gateway.
 * @returns Completion after every owned Context closes; original and cleanup failures are preserved together.
 */
export async function withGateway(run: (office: OfficeService, gateway: OfficeGatewayClient) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(own, 'runtime-'))
  const central = new Context()
  const employee = new Context()
  const lifetime = new AbortController()
  const failures: unknown[] = []
  try {
    await central.plugin(Storage)
    await central.plugin(StorageJson, { root: join(root, 'data') })
    await central.plugin(StorageDomain, { backend: 'json' })
    await central.plugin(OfficeService, { ...officeConfig(root), imageRead: imagePolicy })
    const password = 'Owned gateway image response scenario 2026!'
    await central.office.initializeIdentity(administrator, password)
    await central.plugin(OfficeGateway, { host: '127.0.0.1', port: 0,
      administratorId: administrator, loginRequestsPerMinute: 20 })
    await employee.plugin(MemoryCredentials)
    const gateway = new OfficeGatewayClient(employee.credentials, central.officeGateway.address, lifetime.signal)
    await gateway.signIn({ memberId: administrator, password })
    await run(central.office, gateway)
  } catch (error) { failures.push(error) }
  lifetime.abort(new Error('Owned image response fixture closed'))
  const closed = await Promise.allSettled([central.fiber.dispose(), employee.fiber.dispose()])
  for (const result of closed) if (result.status === 'rejected') failures.push(result.reason)
  if (closed.every(result => result.status === 'fulfilled')) {
    try {
      const target = resolve(root)
      if (!target.startsWith(resolve(own) + sep) || !/^runtime-[a-zA-Z0-9]+$/u.test(basename(target)))
        throw new Error('Owned image response cleanup path escaped its artifact directory')
      await rm(target, { recursive: true })
    } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Image response scenario and resource cleanup failed')
}

/**
 * Use real resumable Drive uploads and capture APIs, keeping large source bytes out of the legacy whole-file protocol.
 * @param office - Candidate Office service whose existing queue owns the complete read operation.
 * @param bytes - Actual PNG bytes with a reviewed complete file digest.
 * @returns Real immutable capture/file coordinates and metadata for the HTTP read.
 */
export async function submit(office: OfficeService, bytes: Buffer) {
  const ticket = await office.beginDriveUpload(administrator, { space: 'private', folderId: null,
    name: `reviewed-${randomUUID()}.png`, mediaType: 'image/png', byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID() })
  for (let offset = 0; offset < bytes.length; offset += ticket.chunkBytes) {
    const chunk = bytes.subarray(offset, offset + ticket.chunkBytes)
    await office.appendDriveUpload(administrator, { uploadId: ticket.id, index: offset / ticket.chunkBytes,
      sha256: createHash('sha256').update(chunk).digest('hex'), dataBase64: chunk.toString('base64') })
  }
  const completed = await office.completeDriveUpload(administrator, ticket.id)
  if (completed.status !== 'completed' || !completed.fileId) throw new Error('Real PNG upload did not complete')
  const info = await office.driveFileInfo(administrator, completed.fileId)
  const conversationId = brandString<OfficeConversationId>(`reviewed-image-${randomUUID()}`)
  const selection = await office.saveConversationFiles(administrator, { conversationId,
    revision: 0, requestId: randomUUID(), files: [{ id: completed.fileId, versionId: info.versionId }] })
  const capture = await office.captureConversationFiles(administrator, { conversationId,
    revision: selection.revision, requestId: randomUUID() })
  const file = capture.selection.files[0]
  if (!file) throw new Error('Real image capture did not retain its source metadata')
  return { file, input: { kind: 'read' as const, captureId: capture.id, fileId: completed.fileId } }
}
