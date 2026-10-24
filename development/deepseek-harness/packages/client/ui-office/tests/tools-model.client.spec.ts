/** Native skill freshness, exact unsent requests and ownership across navigation/account races. */
import { expect, it, vi } from 'vitest'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { OfficeToolsModel } from '../src/client/tools-model.ts'

const member = { id: 'lin' as OfficeMemberId, role: 'employee' as const }
const first = 'first' as SessionId
const second = 'second' as SessionId
const skill: SkillEntry = { name: 'office-docx', description: 'Document authoring', modelInvocable: true }

function fixture() {
  const list = vi.fn<ConstructorParameters<typeof OfficeToolsModel>[0]>().mockResolvedValue([skill])
  const prepare = vi.fn<ConstructorParameters<typeof OfficeToolsModel>[1]>().mockResolvedValue(true)
  const notify = vi.fn()
  const model = new OfficeToolsModel(list, prepare, notify)
  model.bind(member)
  return { model, list, prepare, notify }
}

it('discovers the chosen Session and verifies a skill again before preparing its exact unsent invocation', async () => {
  const { model, list, prepare, notify } = fixture()
  await model.load(first)
  expect(model.state.getSnapshot()).toMatchObject({ sessionId: first, skills: [skill], loading: false, error: null })
  expect(await model.use({ kind: 'skill', name: skill.name, requirements: '  Revise the attached contract  ' })).toBe(true)
  expect(list).toHaveBeenCalledTimes(2)
  expect(list.mock.calls.every(([id]) => id === first)).toBe(true)
  expect(prepare).toHaveBeenCalledWith(first, '/office-docx Revise the attached contract', expect.any(AbortSignal),
    { kind: 'skill', name: skill.name })
  expect(notify).toHaveBeenCalledWith('toolsPrepared', true)
  expect(model.state.getSnapshot().preparing).toBe(false)
})

it('refuses a removed skill and retains fresh discovery rather than invoking stale metadata', async () => {
  const { model, list, prepare } = fixture()
  await model.load(first)
  list.mockResolvedValueOnce([])
  expect(await model.use({ kind: 'skill', name: skill.name, requirements: 'Revise the contract' })).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ skills: [], error: 'toolsSkillUnavailable', preparing: false })
  model.cancel()
  expect(model.state.getSnapshot().error).toBeNull()
})

it('prepares a template without a selected Session and never invents a native skill installation', async () => {
  const { model, list, prepare } = fixture()
  await model.load(null)
  expect(list).not.toHaveBeenCalled()
  expect(await model.use({ kind: 'skill', name: skill.name, requirements: 'Document' })).toBe(false)
  expect(await model.use({ kind: 'template', name: 'minutes', prompt: '  Summarize this meeting\nOwners and dates  ' })).toBe(true)
  expect(prepare).toHaveBeenCalledWith(null, 'Summarize this meeting\nOwners and dates', expect.any(AbortSignal),
    { kind: 'template', name: 'minutes' })
  expect(list).not.toHaveBeenCalled()
})

it('keeps the last usable catalog on a failed refresh and drops it before showing a different target', async () => {
  const { model, list } = fixture()
  await model.load(first)
  list.mockRejectedValueOnce(new Error('Offline'))
  await model.load(first)
  expect(model.state.getSnapshot()).toMatchObject({ skills: [skill], error: 'toolsCatalogUnavailable' })
  const next = Promise.withResolvers<readonly SkillEntry[]>()
  list.mockReturnValueOnce(next.promise)
  const loading = model.load(second)
  expect(model.state.getSnapshot()).toMatchObject({ skills: [], sessionId: second, loading: true })
  next.resolve([])
  await loading
  expect(model.state.getSnapshot()).toMatchObject({ skills: [], sessionId: second, error: null })
})

it('supersedes discovery and fences late results after account changes, role changes and unload', async () => {
  const { model, list } = fixture()
  const stale = Promise.withResolvers<readonly SkillEntry[]>()
  list.mockReturnValueOnce(stale.promise)
  const oldRead = model.load(first)
  await model.load(second)
  expect(list.mock.calls[0]![1].aborted).toBe(true)
  stale.resolve([{ ...skill, name: 'old-private-catalog' }])
  await oldRead
  expect(model.state.getSnapshot()).toMatchObject({ sessionId: second, skills: [skill] })
  for (const next of [{ ...member, role: 'admin' as const }, { id: 'other' as OfficeMemberId, role: 'employee' as const }, null]) {
    const held = Promise.withResolvers<readonly SkillEntry[]>()
    list.mockReturnValueOnce(held.promise)
    const read = model.load(first)
    model.bind(next)
    held.resolve([skill])
    await read
    expect(model.state.getSnapshot()).toMatchObject({ sessionId: null, skills: [], loading: false })
  }
  model.bind(member)
  const held = Promise.withResolvers<readonly SkillEntry[]>()
  list.mockReturnValueOnce(held.promise)
  const read = model.load(first)
  model.dispose()
  held.resolve([skill])
  await read
  expect(model.state.getSnapshot().skills).toEqual([])
  expect(await model.use({ kind: 'template', name: 'minutes', prompt: 'After unload' })).toBe(false)
})

it('admits one preparation, keeps the failed request editable and supports explicit retry', async () => {
  const { model, prepare, notify } = fixture()
  const held = Promise.withResolvers<boolean>()
  prepare.mockReturnValueOnce(held.promise)
  const request = { kind: 'template' as const, name: 'minutes', prompt: 'Meeting material\nKeep the existing draft' }
  const preparing = model.use(request)
  expect(model.state.getSnapshot().preparing).toBe(true)
  expect(await model.use(request)).toBe(false)
  held.resolve(false)
  expect(await preparing).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ error: 'toolsDraftUnavailable', preparing: false })
  expect(notify).not.toHaveBeenCalled()
  expect(await model.use(request)).toBe(true)
  expect(prepare.mock.calls.map(([, prompt]) => prompt)).toEqual([request.prompt, request.prompt])
})

it('cancels in-flight skill validation before draft mutation and ignores late preparation success', async () => {
  const { model, list, prepare, notify } = fixture()
  await model.load(first)
  const held = Promise.withResolvers<readonly SkillEntry[]>()
  list.mockReturnValueOnce(held.promise)
  const validation = model.use({ kind: 'skill', name: skill.name, requirements: 'Confidential request' })
  model.cancel()
  held.resolve([skill])
  expect(await validation).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  const adoption = Promise.withResolvers<boolean>()
  prepare.mockReturnValueOnce(adoption.promise)
  const preparing = model.use({ kind: 'template', name: 'minutes', prompt: 'Confidential draft' })
  model.bind(null)
  expect(prepare.mock.calls[0]![2].aborted).toBe(true)
  adoption.resolve(true)
  expect(await preparing).toBe(false)
  expect(notify).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ preparing: false, skills: [], sessionId: null })
})
