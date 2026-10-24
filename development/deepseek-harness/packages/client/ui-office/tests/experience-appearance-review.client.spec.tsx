// @vitest-environment jsdom
/** A retained GUI draft must not adopt an unreviewed appearance revision. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { OfficeExperienceSettings } from '../src/client/experience/Settings.tsx'
import { OfficeExperienceClient } from '../src/client/experience/model.ts'
import { experienceEn } from '../src/client/experience/locales.ts'
import type { ExperienceKey } from '../src/client/experience/locales.ts'
import { officeAppearanceDefaults } from '../src/experience/validation.ts'
import type { OfficeAppearance, OfficeExperienceView } from '../src/experience/types.ts'

afterEach(cleanup)

const initial: OfficeExperienceView = { revision: 1, appearance: officeAppearanceDefaults(), assistants: [],
  presets: [{ id: 'standard', name: 'Standard', available: true }] }
function props(view: OfficeExperienceView): ComponentProps<typeof OfficeExperienceSettings> {
  return { t: key => key in experienceEn ? experienceEn[key as ExperienceKey] : key, close: vi.fn(),
    useExperience: select => select({ view, loading: false, busy: false, error: null, saved: false, epoch: 1 }),
    useMaintenance: select => select({ desktop: false, connected: true, busy: false, failed: false }),
    loadExperience: vi.fn(async () => {}), startScene: vi.fn(async () => false), saveAssistant: vi.fn(async () => false),
    saveAppearance: vi.fn(async () => false), importAssistant: vi.fn(async () => false), exportAssistant: vi.fn(),
    openDesktopUpdate: vi.fn(), reconnect: vi.fn(), downloadDiagnostics: vi.fn() }
}

it('07 appearance draft preserves assistant-only updates but fences changed appearance and a late render', async () => {
  const input = props(initial)
  const page = render(<OfficeExperienceSettings {...input} />)
  const form = screen.getByRole('form', { name: experienceEn.appearance })
  const company = within(form).getByRole('textbox', { name: experienceEn.companyName })
  fireEvent.change(company, { target: { value: 'My retained draft' } })
  company.focus()

  const assistantOnly = { ...initial, revision: 2 }
  page.rerender(<OfficeExperienceSettings {...props(assistantOnly)} />)
  expect((company as HTMLInputElement).value).toBe('My retained draft')
  expect(document.activeElement).toBe(company)
  expect((within(form).getByRole('button', { name: experienceEn.save }) as HTMLButtonElement).disabled).toBe(false)

  const latest = { ...initial, revision: 3, appearance: { ...initial.appearance, companyName: 'Other window', brand: 'green' as const } }
  const current = props(latest)
  page.rerender(<OfficeExperienceSettings {...current} />)
  expect((within(form).getByRole('button', { name: experienceEn.save }) as HTMLButtonElement).disabled).toBe(true)
  expect((company as HTMLInputElement).value).toBe('My retained draft')
  expect(document.activeElement).toBe(company)
  expect(within(form).getByRole('alert').textContent).toContain('Company appearance changed in another window')
  fireEvent.submit(form)
  expect(current.saveAppearance).not.toHaveBeenCalled()
  fireEvent.click(within(form).getByRole('button', { name: 'Load latest settings', exact: true }))
  expect((company as HTMLInputElement).value).toBe('Other window')
  expect((within(form).getByRole('radio', { name: experienceEn.green }) as HTMLInputElement).checked).toBe(true)
  expect(document.activeElement).toBe(company)

  let server = latest
  let writes = 0
  const save = vi.fn(async (revision: number, _appearance: OfficeAppearance) => {
    if (revision !== server.revision) throw new Error('conflict')
    writes++
  })
  const model = new OfficeExperienceClient({ view: async () => server, saveAppearance: save,
    saveAssistant: async () => { throw new Error('unused') }, prepare: async () => false,
    t: key => experienceEn[key], download: () => {} })
  model.bind('appearance-review')
  try {
    await vi.waitFor(() => { expect(model.state.getSnapshot().view?.revision).toBe(3) })
    fireEvent.change(company, { target: { value: 'Explicitly reviewed edit' } })
    current.saveAppearance = (appearance, reviewedRevision) => model.saveAppearance(appearance, reviewedRevision)
    page.rerender(<OfficeExperienceSettings {...current} />)
    // The data layer advances before this render receives its next snapshot.
    server = { ...latest, revision: 4, appearance: { ...latest.appearance, companyName: 'Changed after review' } }
    await model.load()
    await act(async () => { fireEvent.click(within(form).getByRole('button', { name: experienceEn.save })) })
    expect(save).toHaveBeenCalledWith(3, { ...latest.appearance, companyName: 'Explicitly reviewed edit' })
    expect(writes).toBe(0)
    expect(server.appearance.companyName).toBe('Changed after review')
    expect(model.state.getSnapshot().error).toBe('conflict')
    expect((company as HTMLInputElement).value).toBe('Explicitly reviewed edit')
  } finally { model.dispose() }
})
