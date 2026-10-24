// @vitest-environment jsdom
/** Real atomic configuration writes and GUI review must not replay a stale create draft. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
import { afterEach, expect, it } from 'vitest'
import { OfficeExperienceClient } from '../src/client/experience/model.ts'
import { OfficeExperienceSettings } from '../src/client/experience/Settings.tsx'
import { experienceEn } from '../src/client/experience/locales.ts'
import type { ExperienceKey } from '../src/client/experience/locales.ts'
import { OfficeExperienceService } from '../src/experience/service.ts'
import { parseOfficeExperienceDocument } from '../src/experience/validation.ts'
import type { OfficeAppearance, OfficeAssistantInput, OfficeExperienceView } from '../src/experience/types.ts'

afterEach(cleanup)
const newAssistant: OfficeAssistantInput = { id: null, name: 'Recovery assistant', scene: 'sales', basePreset: 'standard', instructions: 'Keep reviewed material' }

async function backend(ackLost = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-07-save-review-'))
  const filename = join(directory, 'office-experience.v1.json')
  const roster = new Map([['standard', { id: 'standard', name: 'Standard' }]])
  const service = new OfficeExperienceService({ filename, principal: async () => 'save-review-employee',
    roster: async () => [...roster.values()], register: async (_assistant, id) => {
      roster.set(id, { id, name: id })
      return async () => { roster.delete(id) }
    } })
  let readFailures = 0
  let heldRead: Promise<OfficeExperienceView> | undefined
  let writes = 0
  const model = new OfficeExperienceClient({ view: async () => {
    if (heldRead) return heldRead
    if (readFailures > 0) { readFailures--; throw new Error('unavailable') }
    return service.view()
  }, saveAssistant: async (revision, input) => {
    writes++
    const saved = await service.saveAssistant(revision, input)
    readFailures = 1
    if (ackLost) throw new Error('unavailable')
    return saved
  }, saveAppearance: async (revision, input) => {
    writes++
    await service.saveAppearance(revision, input)
    readFailures = 1
    if (ackLost) throw new Error('unavailable')
  }, prepare: async () => false, t: key => experienceEn[key], download: () => {} })
  model.bind('save-review-employee')
  await waitFor(() => { expect(model.state.getSnapshot().view).not.toBeNull() })
  return { model, service, filename, writes: () => writes, failRead: () => { readFailures = 1 },
    acknowledge: () => { ackLost = false }, holdRead: (value: Promise<OfficeExperienceView>) => { heldRead = value },
    close: async () => {
      model.dispose()
      await service.dispose()
      const absolute = resolve(directory)
      assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('dsh-07-save-review-'))
      await rm(absolute, { recursive: true, force: true })
    } }
}

it('07 save review fences confirmed and uncertain real writes until an explicit read, including a late account change', async () => {
  for (const confirmation of ['confirmed', 'uncertain'] as const) {
    const state = await backend(confirmation === 'uncertain')
    try {
      expect(await state.model.saveAssistant(newAssistant)).toBe(false)
      const raw = await readFile(state.filename, 'utf8')
      const committed = parseOfficeExperienceDocument(JSON.parse(raw))
      expect(committed.accounts[0]?.assistants).toHaveLength(1)
      expect(state.model.state.getSnapshot().saveReview).toEqual({ kind: 'assistant', confirmation })
      expect(await state.model.saveAssistant(newAssistant)).toBe(false)
      expect(state.writes()).toBe(1)
      state.failRead()
      await state.model.load()
      expect(state.model.state.getSnapshot().saveReview).toEqual({ kind: 'assistant', confirmation })
      expect(state.writes()).toBe(1)
      await state.model.load()
      expect(state.model.state.getSnapshot().saveReview).toBeUndefined()
      expect(state.model.state.getSnapshot().view?.assistants).toHaveLength(1)
      expect(state.writes()).toBe(1)

      state.acknowledge()
      const view = state.model.state.getSnapshot().view!
      expect(await state.model.saveAppearance({ ...view.appearance, companyName: 'Committed appearance' }, view.revision)).toBe(false)
      expect(state.model.state.getSnapshot().saveReview).toEqual({ kind: 'appearance', confirmation: 'confirmed' })
      const held = Promise.withResolvers<OfficeExperienceView>()
      state.holdRead(held.promise)
      const reviewing = state.model.load()
      state.model.bind(null)
      held.resolve(await state.service.view())
      await reviewing
      expect(state.model.state.getSnapshot()).toMatchObject({ view: null, busy: false, saved: false })
      expect(state.model.state.getSnapshot().saveReview).toBeUndefined()
    } finally { await state.close() }
  }
})

it('07 GUI keeps a committed create draft locked until review succeeds, then returns to the saved list without replay', async () => {
  const state = await backend()
  try {
    function Harness() {
      const current = useSyncExternalStore(state.model.state.subscribe, state.model.state.getSnapshot)
      const input: ComponentProps<typeof OfficeExperienceSettings> = {
        t: key => key in experienceEn ? experienceEn[key as ExperienceKey] : key,
        useExperience: select => select(current),
        useMaintenance: select => select({ desktop: false, connected: true, busy: false, failed: false }),
        loadExperience: () => state.model.load(), saveAssistant: value => state.model.saveAssistant(value),
        saveAppearance: (value: OfficeAppearance, revision: number) => state.model.saveAppearance(value, revision),
        startScene: async () => false, importAssistant: async () => false, exportAssistant: () => {}, close: () => {},
        openDesktopUpdate: () => {}, reconnect: () => {}, downloadDiagnostics: () => {},
      }
      return <OfficeExperienceSettings {...input} />
    }
    render(<Harness />)
    const company = screen.getByRole('textbox', { name: experienceEn.companyName })
    fireEvent.change(company, { target: { value: 'Unrelated appearance draft' } })
    const opener = screen.getByRole('button', { name: experienceEn.newAssistant })
    opener.focus(); fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: experienceEn.newAssistant })
    const name = within(dialog).getByRole('textbox', { name: experienceEn.name })
    fireEvent.change(name, { target: { value: newAssistant.name } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: experienceEn.save })) })
    await waitFor(() => { expect(state.model.state.getSnapshot().busy).toBe(false) })
    expect((within(dialog).getByRole('button', { name: experienceEn.save }) as HTMLButtonElement).disabled).toBe(true)
    expect((name as HTMLInputElement).value).toBe(newAssistant.name)
    expect(within(dialog).getByRole('alert').textContent).toContain(experienceEn.saveConfirmedReview)
    state.failRead()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: experienceEn.reviewSavedConfiguration })) })
    expect(screen.getByRole('dialog', { name: experienceEn.newAssistant })).toBe(dialog)
    expect((name as HTMLInputElement).value).toBe(newAssistant.name)
    expect(state.writes()).toBe(1)
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: experienceEn.reviewSavedConfiguration })) })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: experienceEn.newAssistant })).toBeNull() })
    expect(screen.getByRole('article').textContent).toContain(newAssistant.name)
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: experienceEn.title, exact: true }))
    expect((company as HTMLInputElement).value).toBe('Unrelated appearance draft')
    expect(state.writes()).toBe(1)
    expect(parseOfficeExperienceDocument(JSON.parse(await readFile(state.filename, 'utf8'))).accounts[0]?.assistants).toHaveLength(1)
  } finally { cleanup(); await state.close() }
})
