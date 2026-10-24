/** New experience configuration uses real files, account fences and native registry composition. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { OfficeExperienceRepository } from '../src/experience/repository.ts'
import { OfficeExperienceService } from '../src/experience/service.ts'
import { installOfficeExperienceHost } from '../src/experience/host.ts'
import { officeAppearanceDefaults, importOfficeAssistant, exportOfficeAssistant,
  parseOfficeAppearance, parseOfficeExperienceDocument } from '../src/experience/validation.ts'
import type { OfficeAssistant } from '../src/experience/types.ts'
import { harness as registryHarness } from '../../../preset/agent-preset-registry/tests/harness.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('office-experience-07-')) throw new Error('Unexpected test cleanup path')
    await rm(absolute, { recursive: true, force: true })
  }
})
async function directory() { const root = await mkdtemp(join(tmpdir(), 'office-experience-07-')); roots.push(root); return root }
const assistant: OfficeAssistant = { id: 'b36780ca-0077-4c99-ae68-108126b10b01' as OfficeAssistant['id'],
  name: '销售助理', scene: 'sales', basePreset: 'standard', instructions: '先确认事实' }

it('persists new/edit/import configuration across service restart and prevents cross-account updates', async () => {
  const filename = join(await directory(), 'office-experience.v1.json')
  let principal = 'lin'
  const registered = new Set<string>()
  const dependencies = { filename, principal: async () => principal,
    roster: async () => [{ id: 'standard' }, ...[...registered].map(id => ({ id }))],
    register: async (_fields: OfficeAssistant, id: string) => { registered.add(id); return async () => { registered.delete(id) } } }
  const first = new OfficeExperienceService(dependencies)
  await first.initialize()
  const created = await first.saveAssistant(0, { ...assistant, id: null })
  expect(created.id).not.toBe(assistant.id)
  await first.saveAppearance(1, { ...officeAppearanceDefaults(), companyName: '本地企业', monogram: '企', brand: 'violet', scheme: 'dark', density: 'compact' })
  await first.saveAssistant(2, { ...created, name: '编辑后的助手' })
  const imported = importOfficeAssistant(exportOfficeAssistant(created))
  const duplicate = await first.saveAssistant(3, { ...imported, id: null })
  expect(duplicate.id).not.toBe(created.id)
  const original = await readFile(filename, 'utf8')
  principal = 'other'
  expect((await first.view()).assistants).toEqual([])
  await expect(first.saveAssistant(4, { ...created, name: '被拒绝' })).rejects.toThrow('not_found')
  expect(await readFile(filename, 'utf8')).toBe(original)
  principal = 'lin'
  await first.dispose()
  expect(registered.size).toBe(0)
  const second = new OfficeExperienceService(dependencies)
  await second.initialize()
  const restored = await second.view()
  expect(restored.appearance).toMatchObject({ companyName: '本地企业', brand: 'violet', scheme: 'dark', density: 'compact' })
  expect(restored.assistants.map(value => value.name)).toEqual(['编辑后的助手', '销售助理'])
  expect(restored.assistants.every(value => value.available)).toBe(true)
  await second.dispose()
})

it('fences concurrent writers and rechecks account authority after the durable read', async () => {
  const filename = join(await directory(), 'office-experience.v1.json')
  const one = new OfficeExperienceRepository(filename)
  const two = new OfficeExperienceRepository(filename)
  const edit = (current: Awaited<ReturnType<typeof one.read>>) => ({ ...current, accounts: [{ principal: 'lin', appearance: officeAppearanceDefaults(), assistants: [assistant] }] })
  const writes = await Promise.allSettled([one.update(0, edit, async () => {}), two.update(0, edit, async () => {})])
  expect(writes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
  expect(writes.filter(value => value.status === 'rejected').map((value) => {
    const reason: unknown = value.reason
    return reason instanceof Error ? reason.message : null
  })).toEqual(['conflict'])
  const original = await readFile(filename, 'utf8')
  await expect(one.update(1, edit, async () => { throw new Error('unauthenticated') })).rejects.toThrow('unauthenticated')
  expect(await readFile(filename, 'utf8')).toBe(original)
  await writeFile(filename, '{"format":9,"revision":1,"accounts":[]}')
  await expect(one.update(1, edit, async () => {})).rejects.toThrow()
  expect(await readFile(filename, 'utf8')).toBe('{"format":9,"revision":1,"accounts":[]}')
})

it('rejects malformed exports, duplicate identities, excessive input and credential-bearing phone links', () => {
  expect(() => importOfficeAssistant('not json')).toThrow()
  expect(() => importOfficeAssistant(JSON.stringify({ format: 'office-assistant.v2', assistant }))).toThrow()
  expect(() => importOfficeAssistant(' '.repeat(65537))).toThrow()
  for (const mobileUrl of ['http://office.example/', 'https://name:password@office.example/', 'https://office.example/?token=private',
    'https://office.example/#private', 'https://localhost:3081', 'https://127.0.0.1', 'javascript:alert(1)'])
    expect(() => parseOfficeAppearance({ ...officeAppearanceDefaults(), mobileUrl })).toThrow()
  expect(parseOfficeAppearance({ ...officeAppearanceDefaults(), mobileUrl: 'https://office.example/company' }).mobileUrl).toBe('https://office.example/company')
})

it('marks removed bases unavailable and retires aliases removed from the durable file', async () => {
  const filename = join(await directory(), 'office-experience.v1.json')
  let baseAvailable = true
  const mounted = new Set<string>()
  const service = new OfficeExperienceService({ filename, principal: async () => 'evidence-employee',
    roster: async () => [...(baseAvailable ? [{ id: 'standard' }] : []), ...[...mounted].map(id => ({ id }))],
    register: async (_assistant, id) => { mounted.add(id); return async () => { mounted.delete(id) } },
  })
  await service.initialize()
  const saved = await service.saveAssistant(0, { ...assistant, id: null })
  const raw = await readFile(filename, 'utf8')
  const evidence = resolve('.artifacts/parallel-handoff/07')
  if (basename(evidence) !== '07' || basename(resolve(evidence, '..')) !== 'parallel-handoff') throw new Error('Unexpected evidence destination')
  await writeFile(join(evidence, 'actual-persisted-configuration.json'), raw)
  baseAvailable = false
  expect((await service.view()).assistants.find(value => value.id === saved.id)?.available).toBe(false)
  const repository = new OfficeExperienceRepository(filename)
  await repository.update(1, current => ({ ...current, accounts: current.accounts.map(account => ({ ...account, assistants: [] })) }), async () => {})
  expect((await service.view()).assistants).toEqual([])
  expect(mounted.size).toBe(0)
  await service.dispose()
})

it('keeps corrupt startup configuration untouched and permits Retry after an administrator repairs it', async () => {
  const root = await directory()
  const filename = join(root, 'office-experience.v1.json')
  await writeFile(filename, 'damaged configuration')
  const ctx = await registryHarness()
  contexts.push(ctx)
  ctx.provide('profileContext', { name: 'experience-recovery', dir: root, patchPath: join(root, 'cordis.patch.yml'),
    installAnchor: join(root, 'package.json'), cwd: root, home: root, overlays: [], startedBundles: [], telemetryDisabledEnv: undefined })
  const host = installOfficeExperienceHost(ctx, async () => 'recovery-employee')
  expect(await host.view()).toEqual({ ok: false, code: 'unavailable' })
  expect(await readFile(filename, 'utf8')).toBe('damaged configuration')
  await writeFile(filename, JSON.stringify({ format: 1, revision: 0, accounts: [] }))
  expect(await host.view()).toMatchObject({ ok: true, value: { revision: 0, assistants: [], appearance: officeAppearanceDefaults() } })
})

it('boots a Loader composition, selects the saved native Preset, and preserves old native generations on edit', async () => {
  const root = await directory()
  const path = join(root, 'cordis.yml')
  const contribute = new URL('../../../preset/agent-preset-registry/tests/fixtures/plugins/contribute.js', import.meta.url).href
  const rows = [
    ['llm', LlmRuntime, {}], ['sessions', SessionStore, {}], ['projections', SessionProjectionRegistry, {}],
    ['prompt', SystemPrompt, { personaPrefix: '' }], ['tools', ToolRuntime, {}], ['agents', AgentRegistry, {}],
    ['loop', AgentLoop, { agents: [] }], ['presets', AgentPresets, { default: 'standard' }],
    ['base', AgentPreset, { id: 'standard', plugins: [{ name: contribute, config: { tool: 'original_tool' } }] }],
  ] as const
  await writeFile(path, JSON.stringify(rows.map(([id, _module, config]) => ({ id, name: `test:${id}`, config }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>(rows.map(([id, module]) => [`test:${id}`, module]))
  const internal = ctx.loader.internal
  if (!internal) throw new Error('Node Loader is required')
  ctx.loader.internal = new Proxy(internal, { get(target, key) {
    if (key === 'import') return async (...args: Parameters<typeof target.import>) => modules.has(args[0]) ? modules.get(args[0]) : target.import(...args)
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
  } })
  ctx.provide('profileContext', { name: 'experience-test', dir: root, patchPath: join(root, 'cordis.patch.yml'),
    installAnchor: join(root, 'package.json'), cwd: root, home: root, overlays: [], startedBundles: [], telemetryDisabledEnv: undefined })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const host = installOfficeExperienceHost(ctx, async () => 'lin')
  const result = await host.saveAssistant(0, { ...assistant, id: null })
  expect(result).toMatchObject({ ok: true })
  if (!result.ok) throw new Error(result.code)
  const presetId = `office.assistant.${result.value.id}`
  expect(await ctx.agentPresets.resolve(presetId)).toEqual({ id: presetId })
  const handle = await ctx.agents.create({ sessionId: SessionId('office-experience-native'),
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'standard') } })
  expect(await ctx.agentPresets.select(handle.agent, presetId)).toBe(presetId)
  expect(ctx.tools.schemas(handle.agent).map(value => value.name)).toEqual(['original_tool'])
  expect((await ctx.agentPresets.readDocument(presetId)).content).not.toContain(assistant.instructions)
  expect((await ctx.agentPresets.list()).find(value => value.id === presetId)?.name).toBeUndefined()
  const revised = await host.saveAssistant(1, { ...result.value, name: 'Revised' })
  expect(revised.ok).toBe(true)
  expect(ctx.tools.schemas(handle.agent).map(value => value.name)).toEqual(['original_tool'])
  const document = parseOfficeExperienceDocument(JSON.parse(await readFile(join(root, 'office-experience.v1.json'), 'utf8')))
  expect(document.accounts[0]?.assistants[0]?.name).toBe('Revised')
})
