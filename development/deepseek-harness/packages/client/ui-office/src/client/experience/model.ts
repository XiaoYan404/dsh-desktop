/** Account-fenced Client adapter over durable configuration and native conversation preparation. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { OfficeAppearance, OfficeAssistant, OfficeAssistantInput, OfficeExperienceView, OfficeScene } from '../../experience/types.ts'
import { exportOfficeAssistant, importOfficeAssistant } from '../../experience/validation.ts'
import type { ExperienceKey } from './locales.ts'

/** Remote methods are supplied by the entry; components never receive transports or services. */
export interface ExperienceClientDependencies {
  view(): Promise<OfficeExperienceView>
  saveAssistant(revision: number, input: OfficeAssistantInput): Promise<OfficeAssistant>
  saveAppearance(revision: number, input: OfficeAppearance): Promise<void>
  prepare(prompt: string, presetId: string | undefined, signal: AbortSignal): Promise<boolean>
  t(key: ExperienceKey): string
  download(filename: string, text: string): void
}

/** A write awaits an authoritative read before another operation may be admitted. */
export interface ExperienceSaveReview {
  readonly kind: 'assistant' | 'appearance'
  readonly confirmation: 'confirmed' | 'uncertain'
}

/** One employee lifetime owns pending saves and unsent scene navigation. */
export class OfficeExperienceClient {
  /** Plain snapshots become standard renderer hooks at registration. */
  readonly state = createSnapshotStore<{
    readonly view: OfficeExperienceView | null
    readonly loading: boolean
    readonly busy: boolean
    readonly error: ExperienceKey | null
    readonly saved: boolean
    readonly epoch: number
    readonly saveReview?: ExperienceSaveReview | undefined
  }>({ view: null, loading: false, busy: false, error: null, saved: false, epoch: 0 })
  private principal: string | null = null
  private lifetime = new AbortController()
  private sequence = 0
  private disposed = false

  /** @param dependencies - Durable commands, native preparation and localized draft text. */
  constructor(private readonly dependencies: ExperienceClientDependencies) {}

  /** @param principal - Confirmed account; switching clears private data and cancels navigation. */
  bind(principal: string | null): void {
    if (this.disposed || this.principal === principal) return
    this.principal = principal
    this.sequence++
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.state.set({ view: null, loading: false, busy: false, error: null, saved: false, epoch: this.state.getSnapshot().epoch + 1 })
    if (principal) void this.load()
  }

  /** @returns After an explicit current-account read; successful review releases the write fence. */
  async load(): Promise<void> {
    const review = this.state.getSnapshot().saveReview
    const signal = this.lifetime.signal
    if (await this.refresh() && review && this.current(signal) && this.state.getSnapshot().saveReview === review)
      this.set({ saveReview: undefined })
  }

  private async refresh(): Promise<boolean> {
    if (!this.principal || this.disposed) return false
    const sequence = ++this.sequence
    const signal = this.lifetime.signal
    this.set({ loading: true, error: null })
    try {
      const view = await this.dependencies.view()
      if (this.current(signal) && sequence === this.sequence) { this.set({ view, error: null }); return true }
      return false
    } catch (error) {
      if (this.current(signal) && sequence === this.sequence) this.set({ error: errorKey(error) })
      return false
    } finally {
      if (this.current(signal) && sequence === this.sequence) this.set({ loading: false })
    }
  }

  /** @param scene - Stable category. @param assistantId - Optional saved assistant. @returns True only after native input adoption. */
  async start(scene: OfficeScene, assistantId?: string): Promise<boolean> {
    const view = this.state.getSnapshot().view
    if (!view) return false
    const assistant = assistantId ? view.assistants.find(value => value.id === assistantId && value.scene === scene) : undefined
    if (assistantId && !assistant?.available) { this.set({ error: 'not_found' }); return false }
    const promptKey: Record<OfficeScene, ExperienceKey> = { sales: 'salesPrompt', documents: 'documentsPrompt',
      presentations: 'presentationsPrompt', knowledge: 'knowledgePrompt', quotes: 'quotesPrompt', projects: 'projectsPrompt' }
    return this.operation(async (signal) => {
      // Recheck authorization and activation before preparing any native draft.
      const current = await this.dependencies.view()
      signal.throwIfAborted()
      const selected = assistant ? current.assistants.find(value => value.id === assistant.id && value.available) : undefined
      if (assistant && (!selected || JSON.stringify(selected) !== JSON.stringify(assistant))) throw new Error('conflict')
      const prompt = [this.dependencies.t(promptKey[scene]), selected?.instructions].filter(Boolean).join('\n\n')
      const opened = await this.dependencies.prepare(prompt, selected?.presetId, signal)
      signal.throwIfAborted()
      if (!opened) throw new Error('unavailable')
    }, false)
  }

  /** @param input - Reviewed draft, with null id for creation. @returns True after save and authoritative refresh. */
  saveAssistant(input: OfficeAssistantInput): Promise<boolean> {
    const view = this.state.getSnapshot().view
    if (!view) return Promise.resolve(false)
    return this.operation(async (signal) => {
      await this.commitAssistant(view.revision, input, signal)
    }, true)
  }

  /** @param input - Reviewed appearance draft. @param reviewedRevision - Revision displayed with its reviewed appearance.
   * @returns True after durable write and authoritative refresh; a newer model revision never replaces the reviewed revision.
   */
  saveAppearance(input: OfficeAppearance, reviewedRevision: number): Promise<boolean> {
    const view = this.state.getSnapshot().view
    if (!view) return Promise.resolve(false)
    return this.operation(async (signal) => {
      await this.write('appearance', async () => { await this.dependencies.saveAppearance(reviewedRevision, input) }, signal)
    }, true)
  }

  /** @param file - Selected file; null means user cancellation and performs no write. @returns Whether import committed. */
  async importAssistant(file: File | null): Promise<boolean> {
    if (!file) return false
    const view = this.state.getSnapshot().view
    if (!view) return false
    return this.operation(async (signal) => {
      let imported: OfficeAssistant
      try {
        if (file.size > 65536) throw new Error('invalid')
        imported = importOfficeAssistant(await file.text())
      } catch (_error) { throw new Error('invalid') }
      signal.throwIfAborted()
      await this.commitAssistant(view.revision, { ...imported, id: null }, signal)
    }, true)
  }

  /** @param id - Current account's saved assistant. */
  exportAssistant(id: string): void {
    const assistant = this.state.getSnapshot().view?.assistants.find(value => value.id === id)
    if (!assistant || !this.principal) return
    try {
      const { presetId: _presetId, available: _available, ...fields } = assistant
      this.dependencies.download(`office-assistant-${assistant.id}.json`, exportOfficeAssistant(fields))
    } catch (error) { this.set({ error: errorKey(error) }) }
  }

  /** Fence current account data and navigation on plugin teardown. */
  dispose(): void { this.bind(null); this.disposed = true; this.lifetime.abort() }

  private current(signal: AbortSignal): boolean {
    return !this.disposed && !signal.aborted && signal === this.lifetime.signal && Boolean(this.principal)
  }
  private set(patch: Partial<ReturnType<typeof this.state.getSnapshot>>): void { this.state.set({ ...this.state.getSnapshot(), ...patch }) }

  private async commitAssistant(revision: number, input: OfficeAssistantInput, signal: AbortSignal): Promise<void> {
    await this.write('assistant', async () => { await this.dependencies.saveAssistant(revision, input) }, signal)
  }

  private async write(kind: ExperienceSaveReview['kind'], action: () => Promise<void>, signal: AbortSignal): Promise<void> {
    try { await action() }
    catch (error) {
      const code = errorKey(error)
      // These Host denials precede persistence; other failures do not establish rollback.
      if (this.current(signal) && code !== 'invalid' && code !== 'conflict' && code !== 'not_found')
        this.set({ saveReview: { kind, confirmation: 'uncertain' } })
      throw error
    }
    signal.throwIfAborted()
    if (!await this.refresh()) {
      if (this.current(signal)) this.set({ saveReview: { kind, confirmation: 'confirmed' } })
      throw new Error(this.state.getSnapshot().error ?? 'unavailable')
    }
  }

  private async operation(action: (signal: AbortSignal) => Promise<void>, save: boolean): Promise<boolean> {
    const state = this.state.getSnapshot()
    if (!this.principal || this.disposed || state.busy || state.loading || state.saveReview) return false
    const signal = this.lifetime.signal
    this.set({ busy: true, error: null, saved: false })
    try { await action(signal); if (!this.current(signal)) return false; this.set({ saved: save }); return true }
    catch (error) { if (this.current(signal)) this.set({ error: errorKey(error) }); return false }
    finally { if (this.current(signal)) this.set({ busy: false }) }
  }
}

function errorKey(error: unknown): ExperienceKey {
  const code = error instanceof Error ? error.message : ''
  return code === 'conflict' || code === 'unauthenticated' || code === 'not_found' || code === 'invalid' ? code : 'unavailable'
}
