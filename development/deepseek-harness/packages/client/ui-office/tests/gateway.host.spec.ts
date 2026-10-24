/** Employee Hosts retain native credential ownership while their office BFF uses a real central server. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import type { Config as OfficeConfig } from '@deepseek-ai/dsh-enterprise-office'
import OfficeGateway from '@deepseek-ai/dsh-enterprise-office-gateway'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { OfficeChatFilesInput, OfficeConversationId, OfficeConversationLinksInput,
  OfficeMemberId, OfficeMessageId } from '@deepseek-ai/dsh-enterprise-office/types'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import OfficePlugin, { OfficeController } from '../src/index.ts'
import { OfficeGatewayClient } from '../src/gateway-client.ts'
import { submittedPdfFixture } from '../../../enterprise/office/tests/pdf-fixture.ts'
import { submittedDocxFixture, submittedDocxText } from '../../../enterprise/office/tests/docx-fixture.ts'
import { submittedXlsxAmount, submittedXlsxFixture } from '../../../enterprise/office/tests/xlsx-fixture.ts'

const admin = 'admin' as OfficeMemberId
const lin = 'lin' as OfficeMemberId
const chen = 'chen' as OfficeMemberId
const password = 'Host connection test password!'
const key = credentialKey('client-ui-office', 'office-session')
const contexts: Context[] = []
const roots: string[] = []

it('reads actual XLSX through the gateway and withholds saved values after account replacement', async () => {
  const server = await central()
  const employee = await host(server.address)
  await employee.controller.signIn({ memberId: lin, password })
  const bytes = submittedXlsxFixture()
  const file = await server.ctx.office.uploadDriveFile(lin, { space: 'private', folderId: null, name: 'reviewed.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await server.ctx.office.driveFileInfo(lin, file.id)
  const id = 'gateway-submitted-xlsx' as OfficeConversationId
  const selected = await employee.controller.saveConversationFiles({ conversationId: id, revision: 0,
    requestId: randomUUID(), files: [{ id: file.id, versionId: info.versionId }] })
  if (!selected.ok) throw new Error('Expected actual spreadsheet selection')
  const capture = await employee.controller.captureConversationFiles({ conversationId: id,
    revision: selected.value.revision, requestId: randomUUID() })
  if (!capture.ok) throw new Error('Expected actual spreadsheet capture')
  const input = { captureId: capture.value.id, fileId: file.id, sheetNumber: 1, offset: 0, maxCells: 256 }
  const actual = await employee.controller.readConversationXlsx(input, new AbortController().signal)
  expect(actual).toMatchObject({ ok: true, value: { dateSystem: '1900', file: { versionId: info.versionId } } })
  if (!actual.ok) throw new Error('Expected actual spreadsheet values')
  expect(actual.value.cells.find(cell => cell.address === 'B1')?.rawValue).toBe(submittedXlsxAmount)
  const parsed = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const read = server.ctx.office.readConversationXlsx.bind(server.ctx.office)
  vi.spyOn(server.ctx.office, 'readConversationXlsx').mockImplementationOnce(async (...args) => {
    const result = await read(...args)
    parsed.resolve(undefined)
    await release.promise
    return result
  })
  const pending = employee.controller.readConversationXlsx(input, new AbortController().signal)
  const settled = Promise.allSettled([pending])
  try {
    await parsed.promise
    await employee.controller.signIn({ memberId: chen, password })
    release.resolve(undefined)
    expect(await pending).toEqual({ ok: false, code: 'unauthenticated' })
    expect(await employee.controller.readConversationXlsx(input, new AbortController().signal)).toEqual({ ok: false, code: 'not_found' })
  } finally { release.resolve(undefined); await settled }
})

it('reads actual DOCX through the gateway and withholds a parsed body after account replacement', async () => {
  const server = await central()
  const employee = await host(server.address)
  await employee.controller.signIn({ memberId: lin, password })
  const bytes = submittedDocxFixture()
  const file = await server.ctx.office.uploadDriveFile(lin, { space: 'private', folderId: null, name: 'reviewed.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await server.ctx.office.driveFileInfo(lin, file.id)
  const id = 'gateway-submitted-docx' as OfficeConversationId
  const selected = await employee.controller.saveConversationFiles({ conversationId: id, revision: 0,
    requestId: randomUUID(), files: [{ id: file.id, versionId: info.versionId }] })
  if (!selected.ok) throw new Error('Expected actual Word selection')
  const capture = await employee.controller.captureConversationFiles({ conversationId: id,
    revision: selected.value.revision, requestId: randomUUID() })
  if (!capture.ok) throw new Error('Expected actual Word capture')
  const input = { captureId: capture.value.id, fileId: file.id, offset: 0, maxCharacters: 16384 }
  expect(await employee.controller.readConversationDocx(input, new AbortController().signal)).toMatchObject({ ok: true,
    value: { text: submittedDocxText, paragraphCount: 7, tableCount: 1, file: { versionId: info.versionId } } })
  const parsed = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const actual = server.ctx.office.readConversationDocx.bind(server.ctx.office)
  vi.spyOn(server.ctx.office, 'readConversationDocx').mockImplementationOnce(async (...args) => {
    const result = await actual(...args)
    parsed.resolve(undefined)
    await release.promise
    return result
  })
  const pending = employee.controller.readConversationDocx(input, new AbortController().signal)
  const settled = Promise.allSettled([pending])
  try {
    await parsed.promise
    await employee.controller.signIn({ memberId: chen, password })
    release.resolve(undefined)
    expect(await pending).toEqual({ ok: false, code: 'unauthenticated' })
    expect(await employee.controller.readConversationDocx(input, new AbortController().signal)).toEqual({ ok: false, code: 'not_found' })
  } finally { release.resolve(undefined); await settled }
})

it('routes actual PDF text through the authenticated gateway and propagates native cancellation to its server operation', async () => {
  const server = await central()
  const employee = await host(server.address)
  await employee.controller.signIn({ memberId: lin, password })
  const bytes = submittedPdfFixture()
  const file = await server.ctx.office.uploadDriveFile(lin, { space: 'private', folderId: null, name: 'submitted.pdf',
    mediaType: 'application/pdf', byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await server.ctx.office.driveFileInfo(lin, file.id)
  const id = 'gateway-submitted-pdf' as OfficeConversationId
  const saved = await employee.controller.saveConversationFiles({ conversationId: id, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  if (!saved.ok) throw new Error('Expected reviewed PDF metadata')
  const capture = await employee.controller.captureConversationFiles({ conversationId: id,
    revision: saved.value.revision, requestId: randomUUID() })
  if (!capture.ok) throw new Error('Expected submitted PDF metadata')
  const input = { captureId: capture.value.id, fileId: file.id, pageNumber: 2, offset: 0, maxCharacters: 16384 }
  expect(await employee.controller.readConversationPdf(input, new AbortController().signal)).toMatchObject({ ok: true,
    value: { pageNumber: 2, pageCount: 2, text: 'Actual binary PDF page two', file: { versionId: info.versionId } } })
  const started = Promise.withResolvers<AbortSignal>()
  const actual = server.ctx.office.readConversationPdf.bind(server.ctx.office)
  vi.spyOn(server.ctx.office, 'readConversationPdf').mockImplementationOnce((actor, request, signal) => {
    if (!signal) throw new Error('PDF gateway did not forward transport cancellation')
    started.resolve(signal)
    return actual(actor, request, signal)
  })
  const controller = new AbortController()
  const pending = employee.controller.readConversationPdf(input, controller.signal)
  const settled = Promise.allSettled([pending])
  const serverSignal = await started.promise
  controller.abort(new Error('Original native PDF tool stopped'))
  await expect(pending).rejects.toBeInstanceOf(Error)
  await settled
  await vi.waitFor(() => { expect(serverSignal.aborted).toBe(true) })
})

async function central(overrides: Partial<OfficeConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-host-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'data') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  if (overrides.connectorCredentials) await ctx.plugin(MemoryCredentials)
  await ctx.plugin(OfficeService, { companyName: 'Central company', timeZone: 'Asia/Shanghai', dshHome: root, members: [
    { id: admin, name: 'Administrator', department: 'Office', jobTitle: 'Admin', role: 'admin' },
    { id: lin, name: 'Lin', department: 'Office', jobTitle: 'Employee', role: 'employee' },
    { id: chen, name: 'Chen', department: 'Office', jobTitle: 'Employee', role: 'employee' },
  ], ...overrides })
  await ctx.office.initializeIdentity(admin, password)
  await ctx.office.setIdentityPassword(admin, lin, password)
  await ctx.office.setIdentityPassword(admin, chen, password)
  await ctx.plugin(OfficeGateway, { host: '127.0.0.1', port: 0, administratorId: admin, loginRequestsPerMinute: 100 })
  return { ctx, address: ctx.officeGateway.address }
}

async function host(address: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(OfficePlugin, { gatewayUrl: address })
  const controller: unknown = ctx.get('officeController')
  if (!(controller instanceof OfficeController)) throw new Error('Office BFF did not activate')
  return { ctx, controller }
}

it('keeps integration package management on its actual Host instead of reporting local packages as central deployment', async () => {
  const server = await central()
  const employee = await host(server.address)
  expect(await employee.controller.integrationPlugins()).toEqual({ ok: false, code: 'unauthenticated' })
  await employee.controller.signIn({ memberId: lin, password })
  expect(await employee.controller.integrationPlugins()).toEqual({ ok: true,
    value: { meId: lin, mode: 'gateway', managementAvailable: false, packages: [] } })
  await server.ctx.plugin(OfficePlugin, { principalId: admin, connectorPackages: { 'company-oa': '@company/oa' } })
  expect(await server.ctx.officeController.integrationPlugins()).toEqual({ ok: true,
    value: { meId: admin, mode: 'local', managementAvailable: false,
      packages: [{ adapterId: 'company-oa', packageName: '@company/oa', bundle: null }] } })
})

it.each(['account', 'sign-out', 'renewed-session'] as const)(
  'withdraws a delayed connection identity after %s without clearing a replacement credential', async (change) => {
    const server = await central()
    const employee = await host(server.address)
    await employee.controller.signIn({ memberId: lin, password })
    const send = globalThis.fetch.bind(globalThis)
    const arrived = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let hold = true
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await send(input, init)
      const url = new URL(input instanceof Request ? input.url : input)
      if (hold && url.pathname.endsWith('/v1/session')) {
        hold = false
        arrived.resolve(undefined)
        await release.promise
      }
      return response
    })
    const pending = employee.controller.connection()
    const settled = Promise.allSettled([pending])
    try {
      await arrived.promise
      if (change === 'sign-out') await employee.controller.signOut()
      else await employee.controller.signIn({ memberId: change === 'account' ? chen : lin, password })
      release.resolve(undefined)
      expect(await pending).toMatchObject({ ok: true, value: { connected: false, member: null } })
      expect(await employee.controller.connection()).toMatchObject(change === 'sign-out'
        ? { ok: true, value: { connected: false, member: null } }
        : { ok: true, value: { connected: true, member: { id: change === 'account' ? chen : lin } } })
    } finally { release.resolve(undefined); await settled; fetch.mockRestore() }
  },
)

it('routes reviewed file APIs through the employee Host and withdraws a late body after account replacement', async () => {
  const server = await central()
  const employee = await host(server.address)
  await employee.controller.signIn({ memberId: lin, password })
  const bytes = Buffer.from('Only the original employee may receive this file body')
  const file = await server.ctx.office.uploadDriveFile(lin, { space: 'private', folderId: null, name: 'private-host-file.txt',
    mediaType: 'text/plain', byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await server.ctx.office.driveFileInfo(lin, file.id)
  const conversationId = 'native-file-bff' as OfficeConversationId
  expect(await employee.controller.conversationFiles(conversationId)).toMatchObject({ ok: true, value: { files: [], revision: 0 } })
  const saved = await employee.controller.saveConversationFiles({ conversationId, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  if (!saved.ok) throw new Error('Reviewed Host file selection failed')
  const captured = await employee.controller.captureConversationFiles({ conversationId, revision: saved.value.revision, requestId: 'native-input' })
  if (!captured.ok) throw new Error('Host file context preparation failed')
  expect(await employee.controller.conversationFilesCapture(captured.value.id)).toEqual(captured)
  const read = { captureId: captured.value.id, fileId: file.id, offset: 0, maxCharacters: 16384 }
  expect(await employee.controller.readConversationFile(read)).toMatchObject({ ok: true, value: { text: bytes.toString('utf8') } })
  const original = server.ctx.office.readConversationFile.bind(server.ctx.office)
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(server.ctx.office, 'readConversationFile').mockImplementationOnce(async (actor, input) => {
    const value = await original(actor, input)
    started.resolve(undefined)
    await release.promise
    return value
  })
  const pending = employee.controller.readConversationFile(read)
  try {
    await started.promise
    await employee.controller.signIn({ memberId: chen, password })
  } finally { release.resolve(undefined) }
  expect(await pending).toEqual({ ok: false, code: 'unauthenticated' })
  expect(await employee.controller.conversationFiles(conversationId)).toMatchObject({ ok: true, value: { files: [], revision: 0 } })
  expect(await employee.controller.conversationFilesCapture(captured.value.id)).toEqual({ ok: false, code: 'not_found' })
})

function prepare(ctx: Context, id = 'native-office-context', requestId = 'sdk-request-1', signal = new AbortController().signal) {
  return ctx.waterfall('api-session/prepare-context', {
    sessionId: SessionId(id), requestId: requestId as SessionRequestId, mode: 'queue', signal,
  }, () => Promise.resolve([]))
}

async function fileContextFixture() {
  const server = await central()
  const employee = await host(server.address)
  await employee.controller.signIn({ memberId: lin, password })
  const bytes = Buffer.from('PRIVATE_OFFICE_FILE_BYTES')
  const file = await server.ctx.office.uploadDriveFile(lin, { space: 'private', folderId: null, name: 'reviewed.txt',
    mediaType: 'text/plain', byteLength: bytes.length, dataBase64: bytes.toString('base64'), requestId: randomUUID() })
  const info = await server.ctx.office.driveFileInfo(lin, file.id)
  const id = 'native-file-context' as OfficeConversationId
  const saved = await employee.controller.saveConversationFiles({ conversationId: id, revision: 0, requestId: randomUUID(),
    files: [{ id: file.id, versionId: info.versionId }] })
  if (!saved.ok) throw new Error('Expected a reviewed file selection')
  return { server, employee, bytes, file, info, id }
}

it('prepares exact file metadata without copying contents and keeps a separately cleared submission explicit', async () => {
  const { employee, bytes, file, info, id } = await fileContextFixture()
  const view = await employee.controller.conversationFiles(id)
  expect(view).toMatchObject({ ok: true, value: { meId: lin, role: 'employee', revision: 1,
    limits: { protocol: 1, maxSelectedFiles: 20, maxTextBytes: 1048576, maxCharacters: 16384 } } })
  const prepared = await prepare(employee.ctx, id)
  expect(prepared).toHaveLength(1)
  const context = prepared[0]!
  if (context.source.kind !== 'office-files') throw new Error('File preparation was not attributed')
  expect(context.source.capture).toMatchObject({ memberId: lin, role: 'employee', requestId: 'sdk-request-1',
    selection: { conversationId: id, revision: 1, files: [{ id: file.id, versionId: info.versionId }] } })
  expect(context.text).not.toContain(bytes.toString())
  const normalized = context.text.replaceAll(file.id, '{{file_id}}').replaceAll(info.versionId, '{{version_id}}')
    .replaceAll(info.sha256, '{{sha256}}')
  expect(`${normalized}\n`).toBe(await readFile(new URL('./expected/file-context.expected.md', import.meta.url), 'utf8'))
  expect(await prepare(employee.ctx, id)).toEqual(prepared)
  await employee.controller.saveConversationFiles({ conversationId: id, revision: 1, requestId: randomUUID(), files: [] })
  const cleared = await prepare(employee.ctx, id, 'cleared-file-send')
  expect(cleared[0]?.text).toContain('No files selected.')
  expect(context.source.capture.selection.files).toHaveLength(1)
  expect(await employee.controller.conversationFilesCapture(context.source.capture.id)).toEqual({ ok: true, value: context.source.capture })
  await employee.controller.signOut()
  expect(await prepare(employee.ctx, id)).toEqual([])
})

it('skips file calls against an authority that does not advertise submitted-file support', async () => {
  const { employee, id } = await fileContextFixture()
  const original = employee.controller.conversationLinks.bind(employee.controller)
  vi.spyOn(employee.controller, 'conversationLinks').mockImplementationOnce(async (conversationId) => {
    const result = await original(conversationId)
    if (!result.ok) return result
    const legacy = { ...result.value }
    delete legacy.conversationFiles
    return { ok: true, value: legacy }
  })
  const reading = vi.spyOn(employee.controller, 'conversationFiles')
  expect(await prepare(employee.ctx, id)).toEqual([])
  expect(reading).not.toHaveBeenCalled()
})

it.each(['employee', 'role', 'cancellation'] as const)('withholds prepared files after an intervening %s change', async (change) => {
  const { server, employee, id } = await fileContextFixture()
  const original = employee.controller.captureConversationFiles.bind(employee.controller)
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  vi.spyOn(employee.controller, 'captureConversationFiles').mockImplementationOnce(async (input) => {
    started.resolve(undefined)
    await release.promise
    return original(input)
  })
  const lifetime = new AbortController()
  const pending = prepare(employee.ctx, id, `changed-file-${change}`, lifetime.signal)
  // Register rejection before releasing the controlled response.
  const rejected = expect(pending).rejects.toThrow()
  try {
    await started.promise
    if (change === 'employee') await employee.controller.signIn({ memberId: chen, password })
    else if (change === 'role') {
      const member = server.ctx.office.view(admin).members.find(row => row.id === lin)!
      await server.ctx.office.saveMember(admin, { ...member, role: 'manager' }, member)
    } else lifetime.abort(new Error('Cancelled file submission'))
  } finally { release.resolve(undefined) }
  await rejected
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-office-host-')) throw new Error('Unexpected temporary root')
    await rm(absolute, { recursive: true, force: true })
  }
})

describe('employee office gateway BFF', () => {
  it.each(['employee', 'manager'] as const)('creates one authorized Agent work item and recovers its receipt for %s', async (role) => {
    const server = await central()
    if (role === 'manager') {
      const member = server.ctx.office.view(admin).members.find(row => row.id === lin)!
      await server.ctx.office.saveMember(admin, { ...member, role }, member)
    }
    const employee = await host(server.address)
    const colleague = await host(server.address)
    await employee.controller.signIn({ memberId: lin, password })
    await colleague.controller.signIn({ memberId: chen, password })
    const id = 'agent-work-bff-conversation' as OfficeConversationId
    await employee.controller.saveConversationLinks({ conversationId: id, revision: 0, requestId: randomUUID(),
      kind: 'tools', tools: [{ kind: 'template', name: 'reminder' }] })
    const captured = await employee.controller.captureConversation({ conversationId: id, revision: 1, requestId: 'agent-work-send' })
    if (!captured.ok) throw new Error('Expected a captured reminder')
    const input = { captureId: captured.value.id, requestId: randomUUID(),
      work: { kind: 'task' as const, title: 'Real central Agent task', date: '2026-10-17', ownerId: chen } }
    const saved = await employee.controller.createWorkFromConversation(input)
    expect(saved).toMatchObject({ ok: true, value: { requestId: input.requestId, captureId: input.captureId,
      item: { title: input.work.title, creatorId: lin, ownerId: chen } } })
    expect(await employee.controller.createWorkFromConversation(input)).toEqual(saved)
    expect(await colleague.controller.createWorkFromConversation(input)).toEqual({ ok: false, code: 'not_found' })
    await employee.controller.signOut()
    expect(await employee.controller.createWorkFromConversation(input)).toEqual({ ok: false, code: 'unauthenticated' })
    const replacement = await host(server.address)
    await replacement.controller.signIn({ memberId: lin, password })
    expect(await replacement.controller.createWorkFromConversation(input)).toEqual(saved)
    expect(server.ctx.office.view(lin).items.filter(row => row.title === input.work.title)).toHaveLength(1)
  })

  it('captures explicit native sends once, retaining descriptive dependencies and historical selections without credentials', async () => {
    const server = await central({ conversationToolDependencies: {
      'skill:company-review': ['company-oa', 'not-registered'],
    } })
    const employee = await host(server.address)
    await employee.controller.signIn({ memberId: lin, password })
    const id = 'native-office-context' as OfficeConversationId
    expect(await prepare(employee.ctx)).toEqual([])
    const integration = await server.ctx.office.importIntegration(admin, { requestId: randomUUID(), json: JSON.stringify({
      name: 'company-oa', system: 'Company OA', version: '1.2.3', provider: 'Company',
      description: 'Registered company workflow', capabilities: ['Review office work'],
    }) })
    await employee.controller.saveConversationLinks({ conversationId: id, revision: 0, requestId: randomUUID(),
      kind: 'tools', tools: [{ kind: 'skill', name: 'company-review' }] })
    const prepared = await prepare(employee.ctx)
    expect(prepared).toHaveLength(1)
    const source = prepared[0]?.source
    if (source?.kind !== 'office') throw new Error('Office snapshot was not prepared')
    expect(source.capture).toMatchObject({ memberId: lin, requestId: 'sdk-request-1', selection: { revision: 1 },
      integrations: [{ id: integration.id, system: 'Company OA', status: 'unconfigured' }] })
    expect(prepared[0]?.text).toContain('System registration missing: not-registered')
    expect(prepared[0]?.text).toContain('skill: company-review')
    expect(prepared[0]?.text).toContain('It grants no execution authority.')
    expect(JSON.stringify(prepared)).not.toMatch(/"(?:credentialAlias|authorization|gatewayUrl)":/)
    expect(await prepare(employee.ctx)).toEqual(prepared)
    await employee.controller.saveConversationLinks({ conversationId: id, revision: 1, requestId: randomUUID(),
      kind: 'integrations', integrations: [] })
    const unlinked = await prepare(employee.ctx, id, 'next-send')
    expect(unlinked[0]?.text).toContain('Required system not linked: company-oa')
    expect(source.capture.selection.revision).toBe(1)
    expect(source.capture.integrations).toHaveLength(1)
    await expect(prepare(employee.ctx)).rejects.toMatchObject({ code: 'session/agent-busy', details: { reason: 'conflict' } })
  })

  it('records an explicit empty selection after unlinking and preserves opaque long native request identities', async () => {
    const server = await central()
    const employee = await host(server.address)
    await employee.controller.signIn({ memberId: lin, password })
    const id = 'native-office-context' as OfficeConversationId
    await employee.controller.saveConversationLinks({ conversationId: id, revision: 0, requestId: randomUUID(),
      kind: 'tools', tools: [{ kind: 'template', name: 'minutes' }] })
    await employee.controller.saveConversationLinks({ conversationId: id, revision: 1, requestId: randomUUID(),
      kind: 'tools', tools: [] })
    const request = 'opaque-sdk-request:'.repeat(70)
    const first = await prepare(employee.ctx, id, request)
    const source = first[0]?.source
    if (source?.kind !== 'office') throw new Error('Empty reviewed snapshot was not prepared')
    expect(source.capture.selection).toMatchObject({ revision: 2, integrations: [], tools: [] })
    expect(source.capture.requestId).toBe(`sha256:${createHash('sha256').update(request).digest('hex')}`)
    expect(first[0]?.text).toContain('None selected.')
    expect(await prepare(employee.ctx, id, request)).toEqual(first)
    for (const nativeRequest of ['', 'sdk\nrequest', source.capture.requestId]) {
      const escaped = await prepare(employee.ctx, id, nativeRequest)
      const escapedSource = escaped[0]?.source
      if (escapedSource?.kind !== 'office') throw new Error('Opaque native request was not prepared')
      expect(escapedSource.capture.requestId).toBe(`sha256:${createHash('sha256').update(nativeRequest).digest('hex')}`)
      expect(escapedSource.capture.id).not.toBe(source.capture.id)
      expect(await prepare(employee.ctx, id, nativeRequest)).toEqual(escaped)
    }
    expect(await prepare(employee.ctx, 'native-id-'.repeat(80))).toEqual([])
  })

  it('preserves original native use when signed out, but propagates transport and metadata failures before admission', async () => {
    const server = await central()
    const employee = await host(server.address)
    expect(await prepare(employee.ctx)).toEqual([])
    await employee.controller.signIn({ memberId: lin, password })
    const failure = vi.spyOn(employee.controller, 'conversationLinks').mockResolvedValueOnce({ ok: false, code: 'forbidden' })
    await expect(prepare(employee.ctx)).rejects.toMatchObject({ code: 'session/agent-busy', details: { reason: 'forbidden' } })
    failure.mockRejectedValueOnce(new Error('Expected office transport interruption'))
    await expect(prepare(employee.ctx)).rejects.toThrow('Expected office transport interruption')
    failure.mockRestore()
    expect(await prepare(employee.ctx)).toEqual([])
    await employee.controller.signOut()
    expect(await prepare(employee.ctx)).toEqual([])
  })

  it('rejects cancellation and a different employee capture returned after preparation began', async () => {
    const server = await central()
    const employee = await host(server.address)
    await employee.controller.signIn({ memberId: lin, password })
    const id = 'native-office-context' as OfficeConversationId
    await employee.controller.saveConversationLinks({ conversationId: id, revision: 0, requestId: randomUUID(),
      kind: 'tools', tools: [{ kind: 'template', name: 'minutes' }] })
    const own = await employee.controller.captureConversation({ conversationId: id, revision: 1, requestId: 'owned-capture' })
    if (!own.ok) throw new Error('Expected an owned capture')
    const capturing = vi.spyOn(employee.controller, 'captureConversation')
    capturing.mockResolvedValueOnce({ ok: true, value: { ...own.value, memberId: chen } })
    await expect(prepare(employee.ctx)).rejects.toMatchObject({ code: 'session/agent-busy', details: { reason: 'unauthenticated' } })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    capturing.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return own
    })
    const lifetime = new AbortController()
    const pending = prepare(employee.ctx, id, 'cancelled-send', lifetime.signal)
    await entered.promise
    lifetime.abort(new Error('Expected native cancellation'))
    release.resolve(undefined)
    await expect(pending).rejects.toThrow('Expected native cancellation')
  })

  it('keeps private conversation choices in the central owner across independent authenticated employee Hosts', async () => {
    const server = await central({ conversationToolDependencies: { 'skill:company-review': ['company-oa'] } })
    const employee = await host(server.address)
    const colleague = await host(server.address)
    await employee.controller.signIn({ memberId: lin, password })
    await colleague.controller.signIn({ memberId: chen, password })
    const id = 'native-bff-conversation' as OfficeConversationId
    const input: OfficeConversationLinksInput = { conversationId: id, revision: 0, requestId: randomUUID(), kind: 'tools',
      tools: [{ kind: 'skill', name: 'company-review' }] }
    const saved = await employee.controller.saveConversationLinks(input)
    expect(saved).toMatchObject({ ok: true, value: { revision: 1, tools: input.tools } })
    expect(await employee.controller.saveConversationLinks(input)).toEqual(saved)
    const own = await employee.controller.conversationLinks(id)
    expect(own).toMatchObject({ ok: true, value: { meId: lin, selection: { revision: 1, tools: input.tools },
      requirements: [{ tool: input.tools[0], missing: ['company-oa'] }] } })
    expect(await colleague.controller.conversationLinks(id))
      .toMatchObject({ ok: true, value: { meId: chen, selection: { revision: 0, tools: [], integrations: [] } } })
    expect(employee.ctx.get('office')).toBeUndefined()
    await employee.controller.signOut()
    expect(await employee.controller.conversationLinks(id)).toEqual({ ok: false, code: 'unauthenticated' })
    await employee.controller.signIn({ memberId: lin, password })
    expect(await employee.controller.conversationLinks(id)).toEqual(own)
    await employee.controller.signOut()
    const replacement = await host(server.address)
    await replacement.controller.signIn({ memberId: lin, password })
    expect(await replacement.controller.conversationLinks(id)).toEqual(own)
  })

  it('retains prepared contexts across authenticated Host replacement and denies another employee the same opaque id', async () => {
    const server = await central()
    const first = await host(server.address)
    const colleague = await host(server.address)
    await first.controller.signIn({ memberId: lin, password })
    await colleague.controller.signIn({ memberId: chen, password })
    const input = { conversationId: 'bff-prepared-conversation' as OfficeConversationId, revision: 0, requestId: randomUUID() }
    const prepared = await first.controller.captureConversation(input)
    if (!prepared.ok) throw new Error('Expected a prepared employee context')
    expect(prepared.value).toMatchObject({ memberId: lin, selection: { revision: 0 } })
    expect(await colleague.controller.conversationCapture(prepared.value.id)).toEqual({ ok: false, code: 'not_found' })
    await first.controller.signOut()
    expect(await first.controller.conversationCapture(prepared.value.id)).toEqual({ ok: false, code: 'unauthenticated' })
    const replacement = await host(server.address)
    await replacement.controller.signIn({ memberId: lin, password })
    expect(await replacement.controller.conversationCapture(prepared.value.id)).toEqual(prepared)
    expect(await replacement.controller.captureConversation(input)).toEqual(prepared)
    expect(replacement.ctx.get('office')).toBeUndefined()
  })

  it('projects the current role-admitted action directory through three independently authenticated Hosts', async () => {
    const server = await central({ connectorAllowedOrigins: ['https://actions.company.invalid'] })
    const probe = vi.fn(async () => ({ status: 'connected' as const, httpStatus: 200 }))
    server.ctx.effect(() => server.ctx.office.registerConnector({ id: 'company-actions', probe, actions: [
      { id: 'read-self', label: 'Read own records', description: 'Employee records', kind: 'read', allowedRoles: ['employee'] },
      { id: 'admin-report', label: 'Administrator report', description: 'Company report', kind: 'read', allowedRoles: ['admin'] },
    ], async read({ member }) {
      return { status: 'read', data: { summary: 'Current employee business records',
        entries: [{ label: 'Employee', value: member.id }] } }
    } }))
    const administrator = await host(server.address)
    const employee = await host(server.address)
    const colleague = await host(server.address)
    await administrator.controller.signIn({ memberId: admin, password })
    await employee.controller.signIn({ memberId: lin, password })
    await colleague.controller.signIn({ memberId: chen, password })
    const integration = await server.ctx.office.importIntegration(admin, { requestId: randomUUID(), json: JSON.stringify({
      name: 'central-actions', system: 'Company actions', version: '1', provider: 'Company', description: 'Declared actions',
      capabilities: ['Query company records'],
    }) })
    await server.ctx.office.saveConnection(admin, { integrationId: integration.id, revision: 0, requestId: randomUUID(),
      adapterId: 'company-actions', baseUrl: 'https://actions.company.invalid/api/', probePath: 'health',
      authentication: { kind: 'none' }, enabled: true })
    const own = await employee.controller.connectorActions(integration.id)
    expect(own).toMatchObject({ ok: true, value: { integrationId: integration.id, connectionRevision: 1,
      status: 'unverified', actions: [{ id: 'read-self' }] } })
    if (!own.ok) throw new Error('Expected the authenticated action directory')
    expect(own.value.actions).toHaveLength(1)
    expect(await colleague.controller.connectorActions(integration.id)).toEqual(own)
    expect(await administrator.controller.connectorActions(integration.id)).toMatchObject({ ok: true,
      value: { actions: [{ id: 'admin-report' }] } })
    if (!own.value.adapterRevision) throw new Error('Expected a read provider version')
    const query = { integrationId: integration.id, actionId: 'read-self', connectionRevision: 1,
      adapterRevision: own.value.adapterRevision }
    expect(await employee.controller.readConnectorAction(query)).toMatchObject({ ok: true,
      value: { status: 'read', data: { entries: [{ label: 'Employee', value: lin }] } } })
    expect(await colleague.controller.readConnectorAction(query)).toMatchObject({ ok: true,
      value: { status: 'read', data: { entries: [{ label: 'Employee', value: chen }] } } })
    expect(await administrator.controller.readConnectorAction(query)).toEqual({ ok: false, code: 'forbidden' })
    const conversationId = 'central-company-query' as OfficeConversationId
    await employee.controller.saveConversationLinks({ conversationId, revision: 0, requestId: randomUUID(),
      kind: 'integrations', integrations: [integration.id] })
    const capture = await employee.controller.captureConversation({ conversationId, revision: 1, requestId: 'native-central-query' })
    if (!capture.ok) throw new Error('Expected a private central query capture')
    const discovery = { captureId: capture.value.id, integrationId: integration.id }
    const native = { ...query, captureId: capture.value.id }
    expect(await employee.controller.conversationConnectorActions(discovery)).toEqual(own)
    expect(await employee.controller.readConnectorActionFromConversation(native)).toMatchObject({ ok: true,
      value: { status: 'read', data: { entries: [{ label: 'Employee', value: lin }] } } })
    for (const controller of [colleague.controller, administrator.controller]) {
      expect(await controller.conversationConnectorActions(discovery)).toEqual({ ok: false, code: 'not_found' })
      expect(await controller.readConnectorActionFromConversation(native)).toEqual({ ok: false, code: 'not_found' })
    }
    await employee.controller.saveConversationLinks({ conversationId, revision: 1, requestId: randomUUID(),
      kind: 'integrations', integrations: [] })
    expect(await employee.controller.readConnectorActionFromConversation(native)).toEqual({ ok: false, code: 'conflict' })
    expect(JSON.stringify(own)).not.toMatch(/allowedRoles|company\.invalid|authentication|credential/)
    expect(probe).not.toHaveBeenCalled()
    const member = server.ctx.office.view(admin).members.find(row => row.id === lin)!
    await server.ctx.office.saveMember(admin, { ...member, role: 'manager' }, member)
    expect(await employee.controller.connectorActions(integration.id)).toMatchObject({ ok: true, value: { actions: [] } })
    expect(await employee.controller.readConnectorAction(query)).toEqual({ ok: false, code: 'forbidden' })
    await employee.controller.signOut()
    expect(await employee.controller.connectorActions(integration.id)).toEqual({ ok: false, code: 'unauthenticated' })
    expect(await employee.controller.readConnectorAction(query)).toEqual({ ok: false, code: 'unauthenticated' })
    expect(await colleague.controller.connectorActions(integration.id)).toEqual(own)
  })

  it('keeps connector credentials in the central server across three authenticated employee Hosts', async () => {
    const ref = credentialRef('OFFICE_HOST_CONNECTOR_FIXTURE')
    const server = await central({ connectorAllowedOrigins: ['https://oa.company.invalid'],
      connectorCredentials: { 'oa-key': ref } })
    const observed: string[] = []
    server.ctx.effect(() => server.ctx.office.registerConnector({ id: 'company-oa', async probe({ headers }) {
      observed.push(headers.authorization ?? '')
      return { status: 'connected', httpStatus: 200 }
    } }))
    await server.ctx.credentials.set(ref, 'central-only-connector-secret')
    const administrator = await host(server.address)
    const employee = await host(server.address)
    const colleague = await host(server.address)
    await administrator.controller.signIn({ memberId: admin, password })
    await employee.controller.signIn({ memberId: lin, password })
    await colleague.controller.signIn({ memberId: chen, password })
    await administrator.ctx.credentials.set(ref, 'different-employee-host-value')
    const imported = await administrator.controller.importIntegration({ requestId: randomUUID(), json: JSON.stringify({
      name: 'central-oa', system: 'OA', version: '1.0.0', provider: 'Company', description: 'Central connection',
      capabilities: ['Read approvals'],
    }) })
    if (!imported.ok) throw new Error('Central integration import failed')
    const input = { integrationId: imported.value.id, revision: 0, requestId: randomUUID(), adapterId: 'company-oa',
      baseUrl: 'https://oa.company.invalid/api/', probePath: 'health',
      authentication: { kind: 'bearer' as const, credential: 'oa-key' }, enabled: true }
    expect(await employee.controller.saveConnection(input)).toEqual({ ok: false, code: 'forbidden' })
    const saved = await administrator.controller.saveConnection(input)
    expect(saved).toMatchObject({ ok: true, value: { revision: 1, status: 'unverified' } })
    expect(await administrator.controller.saveConnection(input)).toEqual(saved)
    expect(await employee.controller.connections()).toMatchObject({ ok: true, value: {
      entries: [expect.objectContaining({ integrationId: imported.value.id, revision: 1, status: 'unverified' })],
    } })
    expect(await colleague.controller.connections()).toEqual(await employee.controller.connections())
    expect(await employee.controller.probeConnection(imported.value.id, 1)).toEqual({ ok: false, code: 'forbidden' })
    const checked = await administrator.controller.probeConnection(imported.value.id, 1)
    expect(checked).toMatchObject({ ok: true, value: { status: 'connected', httpStatus: 200 } })
    expect(observed).toEqual(['Bearer central-only-connector-secret'])
    const projected = JSON.stringify({ saved, checked, employee: await employee.controller.connections(),
      administrator: await administrator.controller.connections() })
    expect(projected).not.toContain('central-only-connector-secret')
    expect(projected).not.toContain('different-employee-host-value')
    expect(projected).not.toContain(ref)
    expect(projected).not.toContain('Bearer')
    expect(await employee.ctx.credentials.describe(ref)).toMatchObject({ configured: false })
    await administrator.controller.signOut()
    expect(await administrator.controller.probeConnection(imported.value.id, 1)).toEqual({ ok: false, code: 'unauthenticated' })
    expect(observed).toHaveLength(1)
    expect((await server.ctx.credentials.resolve(ref))?.value).toBe('central-only-connector-secret')
  })

  it('saves private draft bytes through employee credentials and publishes the reviewed selection exactly once', async () => {
    const server = await central()
    const employee = await host(server.address)
    const colleague = await host(server.address)
    const administrator = await host(server.address)
    await employee.controller.signIn({ memberId: lin, password })
    await colleague.controller.signIn({ memberId: chen, password })
    await administrator.controller.signIn({ memberId: admin, password })
    const bytes = Buffer.alloc(1024 * 1024 + 19, 0x35)
    bytes.write('集中文件草稿真实内容\0\n')
    const input = { peerId: chen, revision: 0, requestId: randomUUID(),
      files: [{ name: '私有未发.bin', mediaType: 'application/octet-stream', byteLength: bytes.length, dataBase64: bytes.toString('base64') }] }
    const saved = await employee.controller.saveChatFileDraft(input)
    if (!saved.ok) throw new Error('Draft was not saved through the gateway')
    expect(await employee.controller.saveChatFileDraft(input)).toEqual(saved)
    expect(JSON.stringify(await employee.controller.chatFileDrafts())).not.toContain('dataBase64')
    expect(await colleague.controller.chatFileDrafts()).toMatchObject({ ok: true, value: { drafts: [] } })
    const coordinates = { peerId: chen, revision: saved.value.revision, attachmentId: saved.value.files[0]!.id }
    expect(await administrator.controller.downloadChatFileDraft(coordinates)).toEqual({ ok: false, code: 'not_found' })
    expect(await colleague.controller.downloadChatFileDraft(coordinates)).toEqual({ ok: false, code: 'not_found' })
    const restored = await employee.controller.downloadChatFileDraft(coordinates)
    if (!restored.ok) throw new Error('Owner could not restore private draft bytes')
    expect(Buffer.compare(Buffer.from(restored.value.dataBase64, 'base64'), bytes)).toBe(0)
    const forged = { ...input, ownerId: lin }
    expect(await colleague.controller.saveChatFileDraft(forged)).toEqual({ ok: false, code: 'invalid_input' })
    const send = { id: randomUUID() as OfficeMessageId, peerId: chen, revision: saved.value.revision, text: '' }
    const published = await employee.controller.sendChatFileDraft(send)
    if (!published.ok) throw new Error('Reviewed draft was not published')
    expect(await employee.controller.sendChatFileDraft(send)).toEqual(published)
    expect(await employee.controller.chatFileDrafts()).toMatchObject({ ok: true, value: { ownerUsedBytes: 0,
      drafts: [expect.objectContaining({ files: [], revision: 2, pendingSend: null })] } })
    expect(server.ctx.office.chat(lin, chen).messages).toHaveLength(1)
    const delivered = await colleague.controller.downloadChatFile({ messageId: published.value.id,
      attachmentId: published.value.attachments![0]!.id })
    if (!delivered.ok) throw new Error('Recipient could not download the published draft file')
    expect(Buffer.compare(Buffer.from(delivered.value.dataBase64, 'base64'), bytes)).toBe(0)
    await employee.controller.signOut()
    expect(await employee.controller.chatFileDrafts()).toEqual({ ok: false, code: 'unauthenticated' })
  }, 15000)

  it('delivers an actual eight-MiB private file through separate employee Hosts without an administrator bypass', async () => {
    const server = await central()
    const sender = await host(server.address)
    const recipient = await host(server.address)
    const administrator = await host(server.address)
    await sender.controller.signIn({ memberId: lin, password })
    await recipient.controller.signIn({ memberId: chen, password })
    await administrator.controller.signIn({ memberId: admin, password })
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61)
    bytes.write('通过集中网关实际送达\0\n')
    const input: OfficeChatFilesInput = { id: randomUUID() as OfficeMessageId, recipientId: chen, text: '',
      files: [{ name: '集中服务附件.bin', mediaType: 'application/octet-stream', byteLength: bytes.length, dataBase64: bytes.toString('base64') }] }
    const sent = await sender.controller.sendMessageFiles(input)
    expect(sent.ok).toBe(true)
    if (!sent.ok) throw new Error('Gateway did not publish the file message')
    expect(await sender.controller.sendMessageFiles(input)).toEqual(sent)
    const message = sent.value
    const coordinates = { messageId: message.id, attachmentId: message.attachments![0]!.id }
    const received = await recipient.controller.downloadChatFile(coordinates)
    expect(received.ok).toBe(true)
    if (!received.ok) throw new Error('Recipient could not download the published file')
    expect(Buffer.compare(Buffer.from(received.value.dataBase64, 'base64'), bytes)).toBe(0)
    expect(received.value.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await administrator.controller.downloadChatFile(coordinates)).toEqual({ ok: false, code: 'not_found' })
    expect((await recipient.controller.chat(lin))).toMatchObject({ ok: true, value: { messages: [message] } })
    expect(await sender.controller.chatFileLimits()).toMatchObject({ ok: true, value: { ownerUsedBytes: bytes.length } })
    expect(await recipient.controller.chatFileLimits()).toMatchObject({ ok: true, value: { ownerUsedBytes: 0 } })
    expect(await recipient.controller.sendMessageFiles({ ...input, senderId: lin } as OfficeChatFilesInput))
      .toEqual({ ok: false, code: 'invalid_input' })
    await sender.controller.signOut()
    expect(await sender.controller.downloadChatFile(coordinates)).toEqual({ ok: false, code: 'unauthenticated' })
    expect((await recipient.controller.downloadChatFile(coordinates))).toEqual(received)
  }, 15000)

  it('transfers a real file above eight MiB through authenticated Hosts and resumes after signing in again', async () => {
    const server = await central()
    const employee = await host(server.address)
    const other = await host(server.address)
    const administrator = await host(server.address)
    await employee.controller.signIn({ memberId: lin, password })
    await other.controller.signIn({ memberId: chen, password })
    await administrator.controller.signIn({ memberId: admin, password })
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 19).fill(Buffer.from('通过网关保存的真实文件\n'))
    const input = { space: 'private' as const, folderId: null, name: 'gateway-large.bin', requestId: randomUUID(),
      mediaType: 'application/octet-stream', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    const forged = { ...input, ownerId: chen }
    expect(await employee.controller.beginDriveUpload(forged)).toEqual({ ok: false, code: 'invalid_input' })
    const begun = await employee.controller.beginDriveUpload(input)
    if (!begun.ok) throw new Error('Employee upload did not begin: ' + begun.code)
    const ticket = begun.value
    expect(JSON.stringify(ticket)).not.toMatch(/ownerId|fingerprint|objectRoot/)
    for (const controller of [other.controller, administrator.controller]) {
      expect(await controller.getDriveUpload(ticket.id)).toEqual({ ok: false, code: 'not_found' })
      expect(await controller.cancelDriveUpload(ticket.id)).toEqual({ ok: false, code: 'not_found' })
      expect(await controller.driveUploads()).toEqual({ ok: true, value: [] })
    }
    for (let index = 0; index < Math.ceil(bytes.length / ticket.chunkBytes); index++) {
      const part = bytes.subarray(index * ticket.chunkBytes, (index + 1) * ticket.chunkBytes)
      const chunk = { uploadId: ticket.id, index, sha256: createHash('sha256').update(part).digest('hex'), dataBase64: part.toString('base64') }
      const received = await employee.controller.appendDriveUpload(chunk)
      if (!received.ok) throw new Error('Employee chunk failed: ' + received.code)
      expect(received.value.received).toContain(index)
      if (index === 0) {
        await employee.controller.signOut()
        expect(await employee.controller.getDriveUpload(ticket.id)).toEqual({ ok: false, code: 'unauthenticated' })
        await employee.controller.signIn({ memberId: lin, password })
        expect(await employee.controller.getDriveUpload(ticket.id)).toMatchObject({ ok: true, value: { received: [0] } })
        expect(await employee.controller.appendDriveUpload(chunk)).toEqual(received)
      }
    }
    const completed = await employee.controller.completeDriveUpload(ticket.id)
    if (!completed.ok) throw new Error('Employee completion failed: ' + completed.code)
    expect(completed.value.status).toBe('completed')
    expect(await employee.controller.completeDriveUpload(ticket.id)).toEqual(completed)
    const info = await employee.controller.driveFileInfo(completed.value.fileId!)
    if (!info.ok) throw new Error('Employee download metadata failed: ' + info.code)
    const ranges: Buffer[] = []
    for (let offset = 0; offset < bytes.length; offset += info.value.chunkBytes) {
      const result = await employee.controller.downloadDriveRange({ id: info.value.id, versionId: info.value.versionId,
        offset, byteLength: Math.min(info.value.chunkBytes, bytes.length - offset) })
      if (!result.ok) throw new Error('Employee range failed: ' + result.code)
      const part = Buffer.from(result.value.dataBase64, 'base64')
      expect(createHash('sha256').update(part).digest('hex')).toBe(result.value.sha256)
      ranges.push(part)
    }
    expect(Buffer.concat(ranges).equals(bytes)).toBe(true)
    expect(createHash('sha256').update(Buffer.concat(ranges)).digest('hex')).toBe(input.sha256)
    expect(await other.controller.driveFileInfo(info.value.id)).toEqual({ ok: false, code: 'not_found' })
    const listing = await employee.controller.drive({ space: 'private', folderId: null, search: '' })
    if (!listing.ok) throw new Error('Employee listing failed')
    expect(listing.value.entries).toHaveLength(1)
  })

  it('rechecks current ancestor access between ranged reads of an existing whole-upload object', async () => {
    const server = await central()
    const administrator = await host(server.address)
    const employee = await host(server.address)
    const other = await host(server.address)
    await administrator.controller.signIn({ memberId: admin, password })
    await employee.controller.signIn({ memberId: lin, password })
    await other.controller.signIn({ memberId: chen, password })
    const folder = await administrator.controller.createDriveFolder({ space: 'shared', folderId: null, name: 'Ranged shared folder' })
    if (!folder.ok) throw new Error('Shared folder creation failed')
    const allowed = await administrator.controller.saveDrivePermissions({ id: folder.value.id, revision: folder.value.revision,
      defaultAccess: 'deny', grants: [{ memberId: lin, access: 'edit' }, { memberId: chen, access: 'view' }] })
    if (!allowed.ok) throw new Error('Shared folder grants failed')
    const bytes = Buffer.from('Previous whole-upload bytes remain readable through the new bounded protocol.')
    const uploaded = await employee.controller.uploadDriveFile({ space: 'shared', folderId: folder.value.id, name: 'old.txt',
      requestId: randomUUID(), mediaType: 'text/plain', byteLength: bytes.length, dataBase64: bytes.toString('base64') })
    if (!uploaded.ok) throw new Error('Whole upload failed')
    const info = await other.controller.driveFileInfo(uploaded.value.id)
    if (!info.ok) throw new Error('Authorized shared file metadata failed')
    const input = { id: info.value.id, versionId: info.value.versionId, offset: 0, byteLength: 8 }
    const first = await other.controller.downloadDriveRange(input)
    if (!first.ok) throw new Error('Authorized shared range failed')
    expect(Buffer.from(first.value.dataBase64, 'base64').equals(bytes.subarray(0, 8))).toBe(true)
    const revoked = await administrator.controller.saveDrivePermissions({ id: folder.value.id, revision: allowed.value.revision,
      defaultAccess: 'deny', grants: [{ memberId: lin, access: 'edit' }] })
    expect(revoked.ok).toBe(true)
    expect(await other.controller.downloadDriveRange({ ...input, offset: 8 })).toEqual({ ok: false, code: 'not_found' })
  })

  it('delivers company announcements through separate authenticated Hosts without exposing other receipts', async () => {
    const server = await central()
    const administrator = await host(server.address)
    const employee = await host(server.address)
    const other = await host(server.address)
    await administrator.controller.signIn({ memberId: admin, password })
    await employee.controller.signIn({ memberId: lin, password })
    await other.controller.signIn({ memberId: chen, password })
    const input = { requestId: randomUUID(), title: 'Scoped office notice', body: 'Only Lin receives this publication', audience: 'members' as const, recipientIds: [lin] }
    expect(await employee.controller.publishAnnouncement(input)).toEqual({ ok: false, code: 'forbidden' })
    const published = await administrator.controller.publishAnnouncement(input)
    if (!published.ok) throw new Error('Administrator publication failed')
    const id = published.value.id
    expect(await employee.controller.view()).toMatchObject({ ok: true, value: { announcements: { entries: [{ id, read: false }] } } })
    expect(await other.controller.view()).toMatchObject({ ok: true, value: { announcements: { entries: [] } } })
    expect(await other.controller.markAnnouncementRead(id)).toEqual({ ok: false, code: 'not_found' })
    expect(await employee.controller.markAnnouncementRead(id)).toEqual({ ok: true, value: null })
    const confirmed = await employee.controller.view()
    expect(confirmed).toMatchObject({ ok: true, value: { announcements: { entries: [{ id, read: true }] } } })
    expect(JSON.stringify(confirmed)).not.toContain('readBy')
    expect(await employee.controller.withdrawAnnouncement(id, 1)).toEqual({ ok: false, code: 'forbidden' })
    expect(await administrator.controller.withdrawAnnouncement(id, 1)).toEqual({ ok: true, value: null })
    expect(await employee.controller.view()).toMatchObject({ ok: true, value: { announcements: { entries: [] } } })
    await employee.controller.signOut()
    expect(await employee.controller.markAnnouncementRead(id)).toEqual({ ok: false, code: 'unauthenticated' })
  })

  it('registers a shared catalog through central credentials without mounting a local office', async () => {
    const server = await central()
    const administrator = await host(server.address)
    const employee = await host(server.address)
    const request = { requestId: randomUUID(), json: JSON.stringify({ name: 'host-oa', system: 'OA', version: '1', provider: 'Vendor', description: 'Company OA', capabilities: ['Query approvals'] }) }
    await administrator.controller.signIn({ memberId: admin, password })
    await employee.controller.signIn({ memberId: lin, password })
    expect(await employee.controller.importIntegration(request)).toEqual({ ok: false, code: 'forbidden' })
    expect(await administrator.controller.importIntegration(request)).toMatchObject({ ok: true, value: { name: 'host-oa' } })
    expect(await employee.controller.view()).toMatchObject({ ok: true, value: { integrations: { entries: [{ name: 'host-oa' }] } } })
    expect(administrator.ctx.get('office')).toBeUndefined()
    expect(employee.ctx.get('office')).toBeUndefined()
  })

  it('never overwrites a replacement account when an old plugin login reaches the credential callback after unload', async () => {
    const server = await central()
    const employee = await host(server.address)
    const lifetime = new AbortController()
    const old = new OfficeGatewayClient(employee.ctx.credentials, server.address, lifetime.signal)
    const replacement = new OfficeGatewayClient(employee.ctx.credentials, server.address, new AbortController().signal)
    const modify = employee.ctx.credentials.modifyRecord.bind(employee.ctx.credentials)
    vi.spyOn(employee.ctx.credentials, 'modifyRecord').mockImplementationOnce(async (key, callback) => {
      await replacement.signIn({ memberId: chen, password })
      lifetime.abort()
      return modify(key, callback)
    })
    await expect(old.signIn({ memberId: lin, password })).rejects.toThrow()
    expect(await replacement.connection()).toMatchObject({ connected: true, member: { id: chen } })
  })

  it('uses central sign-in without mounting a local office or returning bearer material to the UI', async () => {
    const server = await central()
    const employee = await host(server.address)
    expect(employee.ctx.get('office')).toBeUndefined()
    expect(await employee.controller.connection()).toMatchObject({ ok: true, value: { mode: 'gateway', connected: false } })
    expect(await employee.controller.view()).toEqual({ ok: false, code: 'unauthenticated' })
    const signedIn = await employee.controller.signIn({ memberId: lin, password })
    expect(signedIn).toMatchObject({ ok: true, value: { connected: true, member: { id: lin } } })
    expect(JSON.stringify(signedIn)).not.toMatch(/token|salt|digest/)
    expect(await employee.controller.view()).toMatchObject({ ok: true, value: { companyName: 'Central company', me: { id: lin } } })
    const stored = await employee.ctx.credentials.readRecord(key)
    expect(stored?.kind).toBe('grant')
    expect(JSON.stringify(stored)).not.toContain(password)
    // A new transport instance reuses the Host-owned credential without another password prompt.
    const transport = new OfficeGatewayClient(employee.ctx.credentials, server.address, new AbortController().signal)
    expect(await transport.connection()).toMatchObject({ connected: true, member: { id: lin } })
    expect(await employee.controller.signOut()).toEqual({ ok: true, value: null })
    expect(await transport.connection()).toMatchObject({ connected: false, member: null })
    expect(await employee.controller.view()).toEqual({ ok: false, code: 'unauthenticated' })
  })

  it('isolates two employee Hosts and forwards actual work and private messages', async () => {
    const server = await central()
    const first = await host(server.address)
    const second = await host(server.address)
    await first.controller.signIn({ memberId: lin, password })
    await second.controller.signIn({ memberId: chen, password })
    expect(await first.controller.createWork({ kind: 'task', title: 'Actual central assignment', date: '2026-10-16', ownerId: chen })).toMatchObject({ ok: true, value: { creatorId: lin, ownerId: chen } })
    expect(await second.controller.view()).toMatchObject({ ok: true, value: { me: { id: chen }, items: [expect.objectContaining({ title: 'Actual central assignment' })] } })
    const id = '112f6703-85ae-4cb5-a5ef-d261c0c9615a' as Parameters<OfficeController['sendMessage']>[0]['id']
    expect(await first.controller.sendMessage({ id, recipientId: chen, text: 'Central private message' })).toMatchObject({ ok: true, value: { senderId: lin, recipientId: chen } })
    expect(await second.controller.chat(lin)).toMatchObject({ ok: true, value: { meId: chen, messages: [expect.objectContaining({ text: 'Central private message' })] } })
    expect(await first.controller.identityOverview()).toEqual({ ok: false, code: 'forbidden' })
    await first.controller.signOut()
    expect(await second.controller.view()).toMatchObject({ ok: true, value: { me: { id: chen } } })
  })

  it('compensates failed local secret writes and leaves no usable login session', async () => {
    const server = await central()
    const employee = await host(server.address)
    vi.spyOn(employee.ctx.credentials, 'modifyRecord').mockRejectedValueOnce(new Error('Local secret store failed'))
    await expect(employee.controller.signIn({ memberId: lin, password })).rejects.toThrow('Local secret store failed')
    expect(await employee.controller.connection()).toMatchObject({ ok: true, value: { connected: false } })
    const domain = server.ctx.storageDomain.get('enterprise_office_identity')!
    expect(domain.global.get()).toMatchObject({ sessions: [] })
  })

  it('removes the exact revoked credential and requires a new login after a central password reset', async () => {
    const server = await central()
    const employee = await host(server.address)
    await employee.controller.signIn({ memberId: lin, password })
    const replacement = 'Replacement office Host password!'
    await server.ctx.office.setIdentityPassword(admin, lin, replacement)
    expect(await employee.controller.view()).toEqual({ ok: false, code: 'unauthenticated' })
    const stored = await employee.ctx.credentials.readRecord(key)
    expect(stored).toMatchObject({ kind: 'grant', payload: { session: null } })
    expect(await employee.controller.signIn({ memberId: lin, password: replacement }))
      .toMatchObject({ ok: true, value: { connected: true } })
    expect(await employee.controller.changeIdentityPassword({ currentPassword: replacement, newPassword: password }))
      .toEqual({ ok: true, value: null })
    expect(await employee.controller.connection()).toMatchObject({ ok: true, value: { connected: false } })
    expect(await employee.controller.signIn({ memberId: lin, password })).toMatchObject({ ok: true, value: { member: { id: lin } } })
  })

  it('refuses insecure remote URLs and fences requests after Host unload', async () => {
    const server = await central()
    const employee = await host(server.address)
    for (const address of ['http://192.0.2.5/', 'https://user:password@office.example/', 'https://office.example/?token=secret', 'file:///office']) {
      expect(() => new OfficeGatewayClient(employee.ctx.credentials, address, new AbortController().signal)).toThrow()
    }
    const signal = new AbortController()
    const client = new OfficeGatewayClient(employee.ctx.credentials, server.address, signal.signal)
    await client.signIn({ memberId: lin, password })
    signal.abort()
    await expect(client.connection()).rejects.toThrow()
  })
})
