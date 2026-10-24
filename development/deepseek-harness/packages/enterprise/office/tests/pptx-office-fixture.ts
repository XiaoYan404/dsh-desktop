/** Actual Loader and JSON-domain composition for presentation authority and native-tool tests. */
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { OfficeMemberId, OfficeConversationId, OfficeConversationPptxConfig,
  OfficeConversationPptxReadInput } from '../src/types.ts'
import { submittedPptxFixture } from './pptx-fixture.ts'

/** Isolated presentation fixture administrator. */
export const pptxAdministrator = brandString<OfficeMemberId>('pptx-administrator')
/** Authenticated employee owning submitted presentation evidence. */
export const pptxEmployee = brandString<OfficeMemberId>('pptx-employee')
/** Another active employee cannot read the original employee's capture. */
export const pptxOtherEmployee = brandString<OfficeMemberId>('pptx-other-employee')
/** Every presentation limit is an explicit fixture deployment choice. */
export const pptxTestPolicy: OfficeConversationPptxConfig = { maxBytes: 8 * 1024 * 1024, maxArchiveEntries: 2048,
  maxInflatedBytes: 32 * 1024 * 1024, maxXmlBytes: 8 * 1024 * 1024, maxNodes: 500000, maxSlides: 200,
  maxTextCharacters: 1024 * 1024, maxOutputBytes: 65536, timeoutMs: 5000, workerMemoryMb: 128 }

/**
 * Mount the real office service and JSON storage from an isolated cordis.yml without customer credentials.
 * @param ctx - Actual running Loader.
 * @param root - Fixture-owned temporary directory.
 * @param config - Explicit deployment override; omission leaves presentation reading disabled.
 * @returns Completion after the real Office authority activates.
 */
export async function installPptxFixtureOffice(ctx: Context, root: string, config: Partial<Config> = {}): Promise<void> {
  await mkdir(root, { recursive: true })
  Object.assign(ctx.loader.builtins, { pptxStorage: Storage, pptxJson: StorageJson, pptxDomain: StorageDomain, pptxOffice: OfficeService })
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:pptxStorage' },
    { name: 'cordis:pptxJson', config: { root: join(root, 'data') } },
    { name: 'cordis:pptxDomain', config: { backend: 'json' } },
    { name: 'cordis:pptxOffice', config: { companyName: 'Presentation fixture company', timeZone: 'Asia/Shanghai', dshHome: root,
      members: [pptxAdministrator, pptxEmployee, pptxOtherEmployee].map(id => ({ id, name: id, department: 'Office', jobTitle: 'Member',
        role: id === pptxAdministrator ? 'admin' : 'employee' })), ...config } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (!ctx.get('office')) throw new Error('Submitted presentation authority did not activate')
}

/**
 * Upload actual deflated PPTX bytes and capture their exact verified version for one employee conversation.
 * @param ctx - Running real Office authority.
 * @param conversationId - Native or fixture logical conversation; not an authorization credential.
 * @returns Real parent/file metadata, immutable capture and first slide-body read coordinates.
 */
export async function submitPptxFixture(ctx: Context, conversationId: OfficeConversationId) {
  const parent = await ctx.office.createDriveFolder(pptxAdministrator, { name: 'Presentation parent', folderId: null, space: 'shared' })
  const bytes = Buffer.from(submittedPptxFixture())
  const file = await ctx.office.uploadDriveFile(pptxAdministrator, { name: 'reviewed.pptx', space: 'shared', folderId: parent.id,
    requestId: randomUUID(), mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const info = await ctx.office.driveFileInfo(pptxEmployee, file.id)
  await ctx.office.saveConversationFiles(pptxEmployee, { conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  const capture = await ctx.office.captureConversationFiles(pptxEmployee, { conversationId, revision: 1, requestId: randomUUID() })
  const input: OfficeConversationPptxReadInput = { captureId: capture.id, fileId: file.id, slideNumber: 1,
    section: 'slide', offset: 0, maxCharacters: 16384 }
  return { parent, file, info, bytes, capture, input }
}
