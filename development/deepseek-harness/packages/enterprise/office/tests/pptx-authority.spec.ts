/** Actual Loader, JSON storage and Office queue protect saved presentation text before and after the real worker. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import OfficeService from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { OfficeDriveTransferFiles } from '../src/drive-transfer-files.ts'
import { officeDriveDomain } from '../src/drive.ts'
import { officeDomain } from '../src/spec.ts'
import * as Pptx from '../src/pptx.ts'
import { executeOfficeRequest } from '../src/request.ts'
import type { OfficeConversationId } from '../src/types.ts'
import { installPptxFixtureOffice, pptxAdministrator, pptxEmployee, pptxOtherEmployee,
  pptxTestPolicy, submitPptxFixture } from './pptx-office-fixture.ts'

async function fixture(config: Partial<Config> = { conversationPptx: pptxTestPolicy }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pptx-authority-'))
  const ctx = new Context()
  onTestFinished(async () => {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-pptx-authority-'))
      throw new Error('Unexpected presentation authority fixture directory')
    await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await installPptxFixtureOffice(ctx, join(root, 'authority'), config)
  return { ctx, ...await submitPptxFixture(ctx, brandString<OfficeConversationId>('presentation-authority-fixture')) }
}

it('keeps PPTX deployment and capability absent by default and rejects incomplete explicit Loader limits', async () => {
  const { ctx, capture, input } = await fixture({})
  const view = await ctx.office.conversationFiles(pptxEmployee, capture.selection.conversationId)
  expect(Object.hasOwn(view.limits, 'pptx')).toBe(false)
  const reads = vi.spyOn(OfficeDriveTransferFiles.prototype, 'readRange')
  await expect(ctx.office.readConversationPptx(pptxEmployee, input)).rejects.toMatchObject({ code: 'forbidden' })
  expect(reads).not.toHaveBeenCalled()
  const seed = { companyName: 'Explicit presentation limits', timeZone: 'Asia/Shanghai', members: [] }
  const resolved: unknown = Schema.resolve(seed, OfficeService.Config, {})[0]
  expect(resolved).not.toHaveProperty('conversationPptx')
  const { timeoutMs: _timeout, ...incomplete } = pptxTestPolicy
  expect(() => Schema.resolve({ ...seed, conversationPptx: incomplete }, OfficeService.Config, {})).toThrow()
  expect(() => Schema.resolve({ ...seed,
    conversationPptx: { ...pptxTestPolicy, timeoutMs: 2147483648 } }, OfficeService.Config, {})).toThrow()
})

it('reads actual authorized PPTX slide or explicit notes with current capability and immutable verified metadata', async () => {
  const { ctx, input, info, capture } = await fixture()
  expect((await ctx.office.conversationFiles(pptxEmployee, capture.selection.conversationId)).limits.pptx)
    .toEqual({ maxBytes: pptxTestPolicy.maxBytes })
  const result = await ctx.office.readConversationPptx(pptxEmployee, input)
  expect(result.file).toMatchObject({ id: input.fileId, versionId: info.versionId, sha256: info.sha256 })
  expect(result.text).toBe('第二页🙂\n组合中文\n换行\nA1\tB1\nA2\tB2')
  expect(result.text).not.toContain('演讲者备注')
  expect(await ctx.office.readConversationPptx(pptxEmployee, { ...input, section: 'notes' }))
    .toMatchObject({ section: 'notes', text: '演讲者备注\n追加说明', eof: true })
})

it('denies another employee capture and a changed captured role before starting a PPTX worker', async () => {
  const { ctx, input } = await fixture()
  const parser = vi.spyOn(Pptx, 'extractOfficePptx')
  await expect(ctx.office.readConversationPptx(pptxOtherEmployee, input)).rejects.toMatchObject({ code: 'not_found' })
  const member = ctx.office.view(pptxAdministrator).members.find(row => row.id === pptxEmployee)
  if (!member) throw new Error('Missing presentation employee')
  await ctx.office.saveMember(pptxAdministrator, { ...member, role: 'manager' }, member)
  await expect(ctx.office.readConversationPptx(pptxEmployee, input)).rejects.toMatchObject({ code: 'forbidden' })
  expect(parser).not.toHaveBeenCalled()
})

it('dispatches PPTX through the authenticated strict request path and denies cross-account captures and revoked access', async () => {
  const { ctx, input, parent } = await fixture()
  const password = 'Presentation isolated fixture password 2026!'
  await ctx.office.initializeIdentity(pptxAdministrator, password)
  await ctx.office.setIdentityPassword(pptxAdministrator, pptxEmployee, password)
  await ctx.office.setIdentityPassword(pptxAdministrator, pptxOtherEmployee, password)
  const signed = await ctx.office.login({ memberId: pptxEmployee, password })
  const other = await ctx.office.login({ memberId: pptxOtherEmployee, password })
  const request = { method: 'readConversationPptx', args: [input] }
  await expect(executeOfficeRequest(ctx.office, signed.token, request)).resolves.toMatchObject({ section: 'slide', text:
    '第二页🙂\n组合中文\n换行\nA1\tB1\nA2\tB2' })
  await expect(executeOfficeRequest(ctx.office, other.token, request)).rejects.toMatchObject({ code: 'not_found' })
  for (const invalid of [{ ...input, section: 'automatic' }, { ...input, slideNumber: 0 },
    { ...input, url: 'https://example.invalid/no-arbitrary-url' }, { ...input, actorId: pptxAdministrator }]) {
    await expect(executeOfficeRequest(ctx.office, signed.token, { ...request, args: [invalid] }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  }
  const { section: _section, ...missingSection } = input
  await expect(executeOfficeRequest(ctx.office, signed.token, { ...request, args: [missingSection] }))
    .rejects.toMatchObject({ code: 'invalid_input' })
  await ctx.office.saveDrivePermissions(pptxAdministrator,
    { id: parent.id, revision: parent.revision, defaultAccess: 'deny', grants: [] })
  await expect(executeOfficeRequest(ctx.office, signed.token, request)).rejects.toMatchObject({ code: 'not_found' })
})

it('rejects oversized submitted PPTX metadata before full-byte storage reads or worker creation', async () => {
  const { ctx, input } = await fixture({ conversationPptx: { ...pptxTestPolicy, maxBytes: 1 } })
  const reads = vi.spyOn(OfficeDriveTransferFiles.prototype, 'readRange')
  const parser = vi.spyOn(Pptx, 'extractOfficePptx')
  await expect(ctx.office.readConversationPptx(pptxEmployee, input)).rejects.toMatchObject({ code: 'context_too_large' })
  expect(reads).not.toHaveBeenCalled()
  expect(parser).not.toHaveBeenCalled()
})

it.each(['acl', 'role', 'stop'] as const)('withholds actual parsed presentation text after a final %s change', async (action) => {
  const { ctx, parent, input } = await fixture()
  const original = Pptx.extractOfficePptx
  const controller = new AbortController()
  const stopped = new Error('Original presentation tool canceled after parsing')
  vi.spyOn(Pptx, 'extractOfficePptx').mockImplementationOnce(async (...args) => {
    const document = await original(...args)
    if (action === 'stop') controller.abort(stopped)
    else if (action === 'acl') {
      // Ordinary authority mutations share the queue; direct JSON-domain replacement exercises final revalidation.
      const domain = ctx.storageDomain.get('enterprise_office_drive')
      if (!domain) throw new Error('Missing real drive domain')
      const state = officeDriveDomain.global.schema.parse(domain.global.get())
      await domain.global.set({ ...state, nodes: state.nodes.map(node => node.id === parent.id
        ? { ...node, defaultAccess: 'deny' as const } : node) })
    } else {
      const domain = ctx.storageDomain.get('enterprise_office')
      if (!domain) throw new Error('Missing real office domain')
      const state = officeDomain.global.schema.parse(domain.global.get())
      await domain.global.set({ ...state, members: state.members.map(member => member.id === pptxEmployee
        ? { ...member, role: 'manager' as const } : member) })
    }
    return document
  })
  const pending = ctx.office.readConversationPptx(pptxEmployee, input, controller.signal)
  if (action === 'stop') await expect(pending).rejects.toBe(stopped)
  else await expect(pending).rejects.toMatchObject({ code: action === 'role' ? 'forbidden' : 'not_found' })
})
