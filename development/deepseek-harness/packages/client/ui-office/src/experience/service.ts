/** Persistent assistants activate genuine registry compositions, retaining native model/tool/permission policy. */
import { randomUUID } from 'node:crypto'
import type { OfficeAppearance, OfficeAssistant, OfficeAssistantInput, OfficeExperienceDocument, OfficeExperienceView } from './types.ts'
import { OfficeExperienceRepository } from './repository.ts'
import { officeAppearanceDefaults, parseOfficeAppearance, parseOfficeAssistant } from './validation.ts'

interface NativePreset {
  readonly id: string
  readonly name?: string
  readonly broken?: string
}

/** The assembly supplies real registry operations, while this leaf owns durability and account fences. */
export interface OfficeExperienceDependencies {
  readonly filename: string
  principal(): Promise<string>
  roster(): Promise<readonly NativePreset[]>
  register(assistant: OfficeAssistant, presetId: string): Promise<() => Promise<void>>
}

/** Owns one profile's serialized assistant revisions and registry disposers. */
export class OfficeExperienceService {
  private readonly repository: OfficeExperienceRepository
  private readonly mounted = new Map<string, { assistant: OfficeAssistant; dispose: () => Promise<void> }>()
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  /** @param dependencies - Account checks, atomic destination and native registry adapter. */
  constructor(private readonly dependencies: OfficeExperienceDependencies) {
    this.repository = new OfficeExperienceRepository(dependencies.filename)
  }

  /** Restore saved native declarations before permitting assistant selection.
   * @returns Completion after all usable base compositions have been registered.
   */
  initialize(): Promise<void> {
    return this.serialize(async () => { await this.synchronize(await this.repository.read()) })
  }

  /** @returns Only the authenticated account's configuration and current native roster. */
  view(): Promise<OfficeExperienceView> {
    return this.serialize(async () => {
      const principal = await this.principal()
      const document = await this.repository.read()
      await this.synchronize(document)
      const presets = await this.dependencies.roster()
      await this.checkPrincipal(principal)
      const account = document.accounts.find(value => value.principal === principal)
      return { revision: document.revision, appearance: account?.appearance ?? officeAppearanceDefaults(),
        assistants: (account?.assistants ?? []).map(assistant => ({ ...assistant, presetId: this.presetId(assistant),
          available: this.mounted.has(assistant.id) && presets.some(preset => preset.id === assistant.basePreset && !preset.broken)
            && presets.some(preset => preset.id === this.presetId(assistant) && !preset.broken) })),
        presets: presets.filter(preset => !preset.id.startsWith('office.assistant.')).map(preset => ({
          id: preset.id, name: preset.name ?? preset.id, available: !preset.broken,
        })) }
    })
  }

  /**
   * Save a new or edited native assistant; native history never changes.
   * @param revision - Observed document revision.
   * @param input - Fields; null id requests a fresh server-minted identity.
   * @returns Saved assistant after durable commit and registry activation.
   */
  saveAssistant(revision: number, input: OfficeAssistantInput): Promise<OfficeAssistant> {
    return this.serialize(async () => {
      const principal = await this.principal()
      let assistant: OfficeAssistant
      try { assistant = parseOfficeAssistant({ ...input, id: input.id ?? randomUUID() }) }
      catch (_error) { throw new Error('invalid') }
      const roster = await this.dependencies.roster()
      if (!roster.some(row => row.id === assistant.basePreset && !row.broken)) throw new Error('not_found')
      const document = await this.repository.update(revision, (current) => {
        const account = current.accounts.find(value => value.principal === principal)
          ?? { principal, appearance: officeAppearanceDefaults(), assistants: [] }
        if (input.id !== null && !account.assistants.some(value => value.id === input.id)) throw new Error('not_found')
        return { ...current, accounts: [...current.accounts.filter(value => value.principal !== principal), {
          ...account, assistants: [...account.assistants.filter(value => value.id !== assistant.id), assistant],
        }] }
      }, () => this.checkPrincipal(principal))
      await this.synchronize(document)
      await this.checkPrincipal(principal)
      if (!this.mounted.has(assistant.id)) throw new Error('unavailable')
      return assistant
    })
  }

  /** @param revision - Observed revision. @param input - Office-only appearance. @returns After durable acceptance. */
  saveAppearance(revision: number, input: OfficeAppearance): Promise<void> {
    return this.serialize(async () => {
      const principal = await this.principal()
      let appearance: OfficeAppearance
      try { appearance = parseOfficeAppearance(input) }
      catch (_error) { throw new Error('invalid') }
      await this.repository.update(revision, (current) => {
        const account = current.accounts.find(value => value.principal === principal) ?? { principal, assistants: [] }
        return { ...current, accounts: [...current.accounts.filter(value => value.principal !== principal), { ...account, appearance }] }
      }, () => this.checkPrincipal(principal))
      await this.checkPrincipal(principal)
    })
  }

  /** Drain admitted operations and retire declarations; in-flight native generations remain registry-owned. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.queue
    for (const value of this.mounted.values()) await value.dispose()
    this.mounted.clear()
  }

  private presetId(assistant: OfficeAssistant): string { return `office.assistant.${assistant.id}` }

  private async principal(): Promise<string> {
    if (this.disposed) throw new Error('unavailable')
    const principal = await this.dependencies.principal()
    if (!principal) throw new Error('unauthenticated')
    return principal
  }

  private async checkPrincipal(expected: string): Promise<void> {
    if (await this.principal() !== expected) throw new Error('unauthenticated')
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(() => {
      if (this.disposed) throw new Error('unavailable')
      return operation()
    })
    this.queue = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async synchronize(document: OfficeExperienceDocument): Promise<void> {
    const identities = new Set<string>(document.accounts.flatMap(account => account.assistants.map(assistant => assistant.id)))
    for (const [id, mounted] of this.mounted) {
      if (identities.has(id)) continue
      await mounted.dispose()
      this.mounted.delete(id)
    }
    for (const assistant of document.accounts.flatMap(account => account.assistants)) {
      if (this.disposed) throw new Error('unavailable')
      const previous = this.mounted.get(assistant.id)
      if (previous && JSON.stringify(previous.assistant) === JSON.stringify(assistant)) continue
      if (previous) { await previous.dispose(); this.mounted.delete(assistant.id) }
      try {
        const dispose = await this.dependencies.register(assistant, this.presetId(assistant))
        this.mounted.set(assistant.id, { assistant, dispose })
      } catch (_error) {
        // A removed or broken base remains saved and visibly unavailable; unrelated accounts still load.
      }
    }
  }
}
