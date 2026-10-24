// @vitest-environment jsdom
/** Office GUI drafts and file-reading admission survive unrelated configuration updates. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { OfficeExperienceSettings } from '../src/client/experience/Settings.tsx'
import { OfficeScenes } from '../src/client/experience/Scenes.tsx'
import { OfficeExperienceClient } from '../src/client/experience/model.ts'
import { experienceEn, experienceZh } from '../src/client/experience/locales.ts'
import type { ExperienceKey } from '../src/client/experience/locales.ts'
import { exportOfficeAssistant, officeAppearanceDefaults } from '../src/experience/validation.ts'
import type { OfficeAssistant, OfficeExperienceView } from '../src/experience/types.ts'

afterEach(cleanup)

const view: OfficeExperienceView = { revision: 1, appearance: officeAppearanceDefaults(), assistants: [],
  presets: [{ id: 'standard', name: 'Standard', available: true }] }
const assistant: OfficeAssistant = { id: 'b092f12c-dea0-4c4e-a56e-8e7aca1300db' as OfficeAssistant['id'],
  name: 'Sales helper', scene: 'sales', basePreset: 'standard', instructions: 'Ask for material first' }

function props(current = view, copy: Record<ExperienceKey, string> = experienceEn): ComponentProps<typeof OfficeExperienceSettings> {
  return { t: key => key in copy ? copy[key as ExperienceKey] : key, close: vi.fn(),
    useExperience: select => select({ view: current, loading: false, busy: false, error: null, saved: false, epoch: 1 }),
    useMaintenance: select => select({ desktop: false, connected: true, busy: false, failed: false }),
    loadExperience: vi.fn(async () => {}), startScene: vi.fn(async () => true), saveAssistant: vi.fn(async () => false),
    saveAppearance: vi.fn(async () => false), importAssistant: vi.fn(async () => false), exportAssistant: vi.fn(),
    openDesktopUpdate: vi.fn(), reconnect: vi.fn(), downloadDiagnostics: vi.fn() }
}

it('07 GUI retains an unsaved appearance and its focused field when an assistant changes the revision', () => {
  const input = props()
  const page = render(<OfficeExperienceSettings {...input} />)
  const company = screen.getByRole('textbox', { name: experienceEn.companyName })
  fireEvent.change(company, { target: { value: 'Uncommitted company' } })
  company.focus()
  page.rerender(<OfficeExperienceSettings {...props({ ...view, revision: 2,
    assistants: [{ ...assistant, presetId: `office.assistant.${assistant.id}`, available: true }] })} />)
  expect(screen.getByRole('textbox', { name: experienceEn.companyName })).toBe(company)
  expect((company as HTMLInputElement).value).toBe('Uncommitted company')
  expect(document.activeElement).toBe(company)
  expect(input.saveAppearance).not.toHaveBeenCalled()
})

it.each([['English', experienceEn], ['Chinese', experienceZh]] as const)(
  '07 GUI previews appearance and explicitly restores saved settings without writing in %s', (_language, copy) => {
    const input = props(view, copy)
    render(<OfficeExperienceSettings {...input} />)
    const form = screen.getByRole('form', { name: copy.appearance })
    const company = within(form).getByRole('textbox', { name: copy.companyName })
    fireEvent.change(company, { target: { value: 'GUI Company' } })
    fireEvent.change(within(form).getByRole('textbox', { name: copy.monogram }), { target: { value: 'GC' } })
    fireEvent.click(within(form).getByRole('radio', { name: copy.dark }))
    fireEvent.click(within(form).getByRole('radio', { name: copy.compact }))
    const preview = within(form).getByRole('region', { name: copy.appearancePreview })
    expect(within(preview).getByText('GUI Company')).toBeDefined()
    expect(within(preview).getByText('GC')).toBeDefined()
    expect(within(form).getByRole('status').textContent).toBe(copy.unsavedChanges)
    expect(input.saveAppearance).not.toHaveBeenCalled()
    fireEvent.click(within(form).getByRole('button', { name: copy.restoreSaved }))
    expect((company as HTMLInputElement).value).toBe('')
    expect((within(form).getByRole('radio', { name: copy.inherit }) as HTMLInputElement).checked).toBe(true)
    expect((within(form).getByRole('button', { name: copy.save }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.activeElement).toBe(company)
    expect(input.saveAppearance).not.toHaveBeenCalled()
  },
)

it('07 GUI keeps appearance edits through a failed save and an explicit retry', async () => {
  const input = props()
  const page = render(<OfficeExperienceSettings {...input} />)
  const form = screen.getByRole('form', { name: experienceEn.appearance })
  const company = within(form).getByRole('textbox', { name: experienceEn.companyName })
  fireEvent.change(company, { target: { value: 'Keep this company' } })
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: experienceEn.save })) })
  expect(input.saveAppearance).toHaveBeenCalledWith({ ...view.appearance, companyName: 'Keep this company' }, 1)
  input.useExperience = select => select({ view, loading: false, busy: false, error: 'conflict', saved: false, epoch: 1 })
  page.rerender(<OfficeExperienceSettings {...input} />)
  expect(screen.getByRole('alert').textContent).toContain(experienceEn.conflict)
  fireEvent.click(screen.getByRole('button', { name: experienceEn.retry }))
  expect(input.loadExperience).toHaveBeenCalledTimes(1)
  page.rerender(<OfficeExperienceSettings {...props({ ...view, revision: 2 })} />)
  expect(screen.getByRole('textbox', { name: experienceEn.companyName })).toBe(company)
  expect((company as HTMLInputElement).value).toBe('Keep this company')
})

it('07 GUI blocks a local-only phone address with a labelled error before any save', async () => {
  const input = props()
  render(<OfficeExperienceSettings {...input} />)
  const form = screen.getByRole('form', { name: experienceEn.appearance })
  const address = within(form).getByRole('textbox', { name: experienceEn.mobileUrl })
  fireEvent.change(address, { target: { value: 'https://localhost/office' } })
  fireEvent.blur(address)
  expect(address.getAttribute('aria-invalid')).toBe('true')
  expect(within(form).getByRole('alert').textContent).toBe(experienceEn.mobileInvalid)
  expect(address.getAttribute('aria-describedby')).toContain(within(form).getByRole('alert').id)
  expect((within(form).getByRole('button', { name: experienceEn.save }) as HTMLButtonElement).disabled).toBe(true)
  expect(input.saveAppearance).not.toHaveBeenCalled()
  fireEvent.change(address, { target: { value: 'https://office.example.test/mobile' } })
  expect(within(form).queryByRole('alert')).toBeNull()
  await act(async () => { fireEvent.click(within(form).getByRole('button', { name: experienceEn.save })) })
  expect(input.saveAppearance).toHaveBeenCalledWith({ ...view.appearance, mobileUrl: 'https://office.example.test/mobile' }, 1)
})

it('07 GUI withdraws an unavailable assistant choice without silently starting another Preset', async () => {
  const input = props({ ...view, assistants: [{ ...assistant, presetId: `office.assistant.${assistant.id}`, available: true }] })
  const page = render(<OfficeScenes {...input} />)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(experienceEn.sales) }))
  const dialog = screen.getByRole('dialog', { name: experienceEn.sales })
  fireEvent.click(within(dialog).getByRole('radio', { name: assistant.name }))
  const unavailable = { ...view, revision: 2, assistants: [{ ...assistant, presetId: `office.assistant.${assistant.id}`, available: false }] }
  page.rerender(<OfficeScenes {...props(unavailable)} startScene={input.startScene} />)
  expect(within(dialog).getByRole('alert').textContent).toBe(experienceEn.not_found)
  expect((within(dialog).getByRole('button', { name: experienceEn.start }) as HTMLButtonElement).disabled).toBe(true)
  expect(input.startScene).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('radio', { name: experienceEn.nativeDefault }))
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: experienceEn.start })) })
  expect(input.startScene).toHaveBeenCalledWith('sales', undefined)
})

it('07 GUI explains missing configuration and keeps all scene commands unavailable until retry succeeds', () => {
  const input = props()
  input.useExperience = select => select({ view: null, loading: false, busy: false, error: 'unavailable', saved: false, epoch: 1 })
  render(<OfficeScenes {...input} />)
  expect(screen.getByRole('alert').textContent).toContain(experienceEn.unavailable)
  expect(screen.getByText(experienceEn.configurationUnavailableHint)).toBeDefined()
  const entries = screen.getAllByRole('button').filter(button => button.getAttribute('aria-haspopup') === 'dialog')
  expect(entries).toHaveLength(6)
  expect(entries.every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: experienceEn.retry }))
  expect(input.loadExperience).toHaveBeenCalledTimes(1)
  expect(input.startScene).not.toHaveBeenCalled()
})

it('07 GUI disables retained configuration actions during an explicit reload', () => {
  const input = props()
  input.useExperience = select => select({ view, loading: true, busy: false, error: null, saved: false, epoch: 1 })
  const page = render(<OfficeExperienceSettings {...input} />)
  expect((screen.getByRole('textbox', { name: experienceEn.companyName }) as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: experienceEn.newAssistant }) as HTMLButtonElement).disabled).toBe(true)
  page.rerender(<OfficeScenes {...input} />)
  expect(screen.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true)
})

it('07 GUI discards an in-progress file read on logout before admitting a write', async () => {
  const fileRead = Promise.withResolvers<string>()
  const saveAssistant = vi.fn(async () => assistant)
  const model = new OfficeExperienceClient({ view: async () => view, saveAssistant,
    saveAppearance: async () => {}, prepare: async () => true,
    t: key => experienceEn[key], download: () => {} })
  model.bind('gui-review')
  await vi.waitFor(() => { expect(model.state.getSnapshot().view).not.toBeNull() })
  const file = new File([], 'assistant.json')
  Object.defineProperty(file, 'text', { value: () => fileRead.promise })
  const importing = model.importAssistant(file)
  model.bind(null)
  fileRead.resolve(exportOfficeAssistant(assistant))
  expect(await importing).toBe(false)
  expect(saveAssistant).not.toHaveBeenCalled()
  expect(model.state.getSnapshot()).toMatchObject({ view: null, busy: false, saved: false })
  model.dispose()
})

it('07 GUI locks import admission while the selected file is being read', async () => {
  const fileRead = Promise.withResolvers<string>()
  let committed = structuredClone(view)
  const saveAssistant = vi.fn(async () => {
    committed = { ...committed, revision: 2, assistants: [{ ...assistant, available: true,
      presetId: `office.assistant.${assistant.id}` }] }
    return assistant
  })
  const model = new OfficeExperienceClient({ view: async () => committed, saveAssistant,
    saveAppearance: async () => {}, prepare: async () => true,
    t: key => experienceEn[key], download: () => {} })
  model.bind('gui-review')
  await vi.waitFor(() => { expect(model.state.getSnapshot().view).not.toBeNull() })
  const file = new File([], 'assistant.json')
  Object.defineProperty(file, 'text', { value: () => fileRead.promise })
  const importing = model.importAssistant(file)
  try {
    expect(model.state.getSnapshot().busy).toBe(true)
    expect(await model.importAssistant(file)).toBe(false)
    expect(saveAssistant).not.toHaveBeenCalled()
    fileRead.resolve(exportOfficeAssistant(assistant))
    expect(await importing).toBe(true)
    expect(saveAssistant).toHaveBeenCalledTimes(1)
    expect(model.state.getSnapshot()).toMatchObject({ busy: false, saved: true, view: committed })
  } finally {
    model.dispose()
    fileRead.resolve(exportOfficeAssistant(assistant))
    await importing
  }
})
