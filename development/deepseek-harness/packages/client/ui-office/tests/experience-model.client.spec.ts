/** Account switches fence pending scene preparation, configuration reads and local imports. */
import { expect, it, vi } from 'vitest'
import { OfficeExperienceClient } from '../src/client/experience/model.ts'
import { OfficeMaintenanceModel } from '../src/client/experience/maintenance.ts'
import { experienceEn } from '../src/client/experience/locales.ts'
import { officeAppearanceDefaults, exportOfficeAssistant } from '../src/experience/validation.ts'
import type { OfficeAssistant, OfficeAssistantInput, OfficeExperienceView, OfficeScene } from '../src/experience/types.ts'

const saved: OfficeAssistant = { id: '45929fa3-bd88-47ed-8b78-a00b1e1d39b8' as OfficeAssistant['id'],
  name: 'Sales helper', scene: 'sales', basePreset: 'standard', instructions: 'Ask for source material first' }
const view: OfficeExperienceView = { revision: 1, appearance: officeAppearanceDefaults(),
  assistants: [{ ...saved, presetId: `office.assistant.${saved.id}`, available: true }],
  presets: [{ id: 'standard', name: 'Standard', available: true }] }
function setup() {
  const api = { view: vi.fn(async () => structuredClone(view)),
    saveAssistant: vi.fn(async (_revision: number, _input: OfficeAssistantInput) => saved),
    saveAppearance: vi.fn(async (_revision: number, _input: OfficeExperienceView['appearance']) => {}),
    prepare: vi.fn(async (_prompt: string, _presetId: string | undefined, _signal: AbortSignal) => true),
    t: (key: keyof typeof experienceEn) => experienceEn[key], download: vi.fn<(filename: string, text: string) => void>() }
  const model = new OfficeExperienceClient(api)
  return { model, api }
}

it('prepares all six categories without auto-sending and uses the selected saved native Preset', async () => {
  const { model, api } = setup()
  model.bind('lin')
  await vi.waitFor(() => { expect(model.state.getSnapshot().view).not.toBeNull() })
  for (const scene of ['sales', 'documents', 'presentations', 'knowledge', 'quotes', 'projects'] as OfficeScene[])
    expect(await model.start(scene)).toBe(true)
  expect(api.prepare.mock.calls.map(value => value[0])).toEqual([experienceEn.salesPrompt, experienceEn.documentsPrompt,
    experienceEn.presentationsPrompt, experienceEn.knowledgePrompt, experienceEn.quotesPrompt, experienceEn.projectsPrompt])
  expect(api.prepare.mock.calls.every(value => value[1] === undefined)).toBe(true)
  expect(await model.start('sales', saved.id)).toBe(true)
  expect(api.prepare.mock.lastCall?.[0]).toBe(`${experienceEn.salesPrompt}\n\n${saved.instructions}`)
  expect(api.prepare.mock.lastCall?.[1]).toBe(`office.assistant.${saved.id}`)
  model.dispose()
})

it('blocks permission/configuration changes before native preparation and clears private state on account switch', async () => {
  const { model, api } = setup()
  model.bind('lin')
  await vi.waitFor(() => { expect(model.state.getSnapshot().view).not.toBeNull() })
  api.view.mockResolvedValueOnce({ ...view, assistants: [{ ...view.assistants[0]!, available: false }] })
  expect(await model.start('sales', saved.id)).toBe(false)
  expect(api.prepare).not.toHaveBeenCalled()
  expect(model.state.getSnapshot().error).toBe('conflict')
  const pending = Promise.withResolvers<OfficeExperienceView>()
  api.view.mockImplementationOnce(() => pending.promise)
  const opening = model.start('sales', saved.id)
  model.bind(null)
  pending.resolve(view)
  expect(await opening).toBe(false)
  expect(api.prepare).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ view: null, busy: false, saved: false })
  model.dispose()
})

it('keeps rejected edits visible, makes import cancellation inert and never imports an exported identity', async () => {
  const { model, api } = setup()
  model.bind('lin')
  await vi.waitFor(() => { expect(model.state.getSnapshot().view).not.toBeNull() })
  api.saveAssistant.mockRejectedValueOnce(new Error('conflict'))
  expect(await model.saveAssistant({ ...saved, name: 'Edited' })).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ error: 'conflict', view })
  expect(await model.importAssistant(null)).toBe(false)
  expect(api.saveAssistant).toHaveBeenCalledTimes(1)
  expect(await model.importAssistant(new File(['invalid'], 'invalid.json'))).toBe(false)
  expect(model.state.getSnapshot().error).toBe('invalid')
  expect(api.saveAssistant).toHaveBeenCalledTimes(1)
  expect(await model.importAssistant(new File([exportOfficeAssistant(saved)], 'assistant.json'))).toBe(true)
  expect(api.saveAssistant.mock.lastCall).toEqual([view.revision, { ...saved, id: null }])
  model.exportAssistant(saved.id)
  expect(api.download.mock.lastCall?.[1]).not.toContain('presetId')
  expect(JSON.parse(api.download.mock.lastCall?.[1] ?? '{}')).toEqual({ format: 'office-assistant.v1', assistant: saved })
  model.dispose()
})

it('opens only the real protocol-v1 update bridge and exports diagnostics without private material', async () => {
  const reconnect = vi.fn()
  const open = vi.fn(async () => {})
  const browser = new OfficeMaintenanceModel(undefined, reconnect)
  browser.openUpdate()
  expect(browser.state.getSnapshot().desktop).toBe(false)
  browser.reconnect()
  expect(reconnect).toHaveBeenCalledTimes(1)
  const wrongProtocol = new OfficeMaintenanceModel({ protocolVersion: 2, updates: { open } }, reconnect)
  wrongProtocol.openUpdate()
  expect(open).not.toHaveBeenCalled()
  const desktop = new OfficeMaintenanceModel({ protocolVersion: 1, updates: { open } }, reconnect)
  desktop.connected(true)
  desktop.openUpdate()
  await vi.waitFor(() => { expect(desktop.state.getSnapshot().busy).toBe(false) })
  expect(open).toHaveBeenCalledTimes(1)
  expect(JSON.parse(desktop.diagnostics(3))).toEqual({ format: 'office-diagnostics.v1', connection: 'connected', desktopUpdateBridge: true, phonePairing: false, savedAssistants: 3 })
  open.mockRejectedValueOnce(new Error('private diagnostic'))
  desktop.openUpdate()
  await vi.waitFor(() => { expect(desktop.state.getSnapshot().failed).toBe(true) })
  expect(desktop.diagnostics(3)).not.toContain('private diagnostic')
  browser.dispose(); wrongProtocol.dispose(); desktop.dispose()
})
