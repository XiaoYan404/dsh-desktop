// @vitest-environment jsdom
/** Keyboard users reach scene/configuration actions and return to the opener after Modal dismissal. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { OfficeScenes, OfficeAssistantSettings } from '../src/client/experience/Scenes.tsx'
import { OfficeExperienceSettings } from '../src/client/experience/Settings.tsx'
import { experienceEn, experienceZh } from '../src/client/experience/locales.ts'
import type { ExperienceKey } from '../src/client/experience/locales.ts'
import { officeAppearanceDefaults } from '../src/experience/validation.ts'
import type { OfficeExperienceView } from '../src/experience/types.ts'

afterEach(cleanup)
const view: OfficeExperienceView = { revision: 1, appearance: officeAppearanceDefaults(), assistants: [], presets: [{ id: 'standard', name: 'Standard', available: true }] }
function props(copy: Record<ExperienceKey, string> = experienceEn): ComponentProps<typeof OfficeExperienceSettings> {
  return { t: key => key in copy ? copy[key as ExperienceKey] : key, close: vi.fn(),
    useExperience: select => select({ view, loading: false, busy: false, error: null, saved: false, epoch: 1 }),
    useMaintenance: select => select({ desktop: false, connected: true, busy: false, failed: false }),
    loadExperience: vi.fn(async () => {}), startScene: vi.fn(async () => true), saveAssistant: vi.fn(async () => false),
    saveAppearance: vi.fn(async () => true), importAssistant: vi.fn(async () => true), exportAssistant: vi.fn(),
    openDesktopUpdate: vi.fn(), reconnect: vi.fn(), downloadDiagnostics: vi.fn() }
}

it.each([['English', experienceEn], ['Chinese', experienceZh]] as const)('opens a scene with labelled choices and restores keyboard focus in %s', async (_language, copy) => {
  const input = props(copy)
  render(<OfficeScenes {...input} />)
  const opener = screen.getByRole('button', { name: new RegExp(copy.sales) })
  opener.focus()
  fireEvent.click(opener)
  const dialog = screen.getByRole('dialog', { name: copy.sales })
  const choice = within(dialog).getByRole('radio', { name: copy.nativeDefault })
  await waitFor(() => { expect(document.activeElement).toBe(choice) })
  fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener) })
  fireEvent.click(opener)
  fireEvent.click(within(screen.getByRole('dialog', { name: copy.sales })).getByRole('button', { name: copy.start }))
  await waitFor(() => { expect(input.startScene).toHaveBeenCalledWith('sales', undefined) })
})

it('keeps assistant draft and field labels after a rejected save, then restores the trigger on cancel', async () => {
  const input = props()
  render(<OfficeAssistantSettings {...input} view={view} busy={false} error="conflict" />)
  const opener = screen.getByRole('button', { name: experienceEn.newAssistant })
  opener.focus(); fireEvent.click(opener)
  const dialog = screen.getByRole('dialog', { name: experienceEn.newAssistant })
  const name = within(dialog).getByRole('textbox', { name: experienceEn.name })
  await waitFor(() => { expect(document.activeElement).toBe(name) })
  fireEvent.change(name, { target: { value: 'Private assistant' } })
  fireEvent.change(within(dialog).getByRole('textbox', { name: experienceEn.instructions }), { target: { value: 'Retain this draft' } })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: experienceEn.save })) })
  expect(input.saveAssistant).toHaveBeenCalledWith({ id: null, name: 'Private assistant', instructions: 'Retain this draft', scene: 'sales', basePreset: 'standard' })
  expect(within(dialog).getByRole('alert').textContent).toBe(experienceEn.conflict)
  expect((name as HTMLInputElement).value).toBe('Private assistant')
  fireEvent.click(within(dialog).getByRole('button', { name: experienceEn.cancel }))
  await waitFor(() => { expect(document.activeElement).toBe(opener) })
})

it('labels appearance and phone constraints, disables unsupported desktop actions, and invokes existing commands', () => {
  const input = props()
  render(<OfficeExperienceSettings {...input} />)
  expect(screen.getByRole('textbox', { name: experienceEn.companyName })).toBeDefined()
  expect(screen.getByRole('group', { name: experienceEn.scheme })).toBeDefined()
  expect(screen.getByRole('radio', { name: experienceEn.inherit })).toBeDefined()
  expect(screen.getByRole('group', { name: experienceEn.density })).toBeDefined()
  expect(screen.getByText(experienceEn.mobileLimit)).toBeDefined()
  expect(screen.getByRole('button', { name: experienceEn.desktopUpdate }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: experienceEn.reconnect }))
  fireEvent.click(screen.getByRole('button', { name: experienceEn.diagnostics }))
  expect(input.reconnect).toHaveBeenCalledTimes(1)
  expect(input.downloadDiagnostics).toHaveBeenCalledTimes(1)
})
