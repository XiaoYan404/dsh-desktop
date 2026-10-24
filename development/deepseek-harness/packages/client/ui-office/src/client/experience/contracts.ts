/** Derived props for additive office Slots and the native Settings section. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import type { OfficeAppearance, OfficeAssistantInput, OfficeScene } from '../../experience/types.ts'
import type { OfficeExperienceClient } from './model.ts'
import type { ExperienceKey } from './locales.ts'
import type { OfficeMaintenanceModel } from './maintenance.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'office.experience': ExperienceKey }
  interface SlotMap {
    /**
     * Register a single, root-scoped experience entry between the Office home
     * dashboard grid and its native conversation input.
     * Pass `name: 'office.home.experience'` to `slots.register`; there are no
     * additional registration parameters or caller-supplied runtime props (`{}`).
     * Declare locale and inject options to receive their generated props and
     * hooks; the slot does not supply a Session scope.
     * Replacing this registration replaces only the default scene entry, while
     * Office continues to render the dashboard and native conversation input.
     * Without a registration, this position renders nothing and both remain usable.
     */
    'office.home.experience': { kind: 'single'; scope: 'root' }
  }
}

/** All sources are bound by the renderer; UI receives only callbacks and standard hooks. */
export interface OfficeExperienceInjected {
  readonly hooks: {
    readonly experience: OfficeExperienceClient['state']
    readonly maintenance: OfficeMaintenanceModel['state']
  }
  loadExperience(): Promise<void>
  startScene(scene: OfficeScene, assistantId?: string): Promise<boolean>
  saveAssistant(input: OfficeAssistantInput): Promise<boolean>
  /** @param input - Reviewed draft. @param reviewedRevision - The rendered appearance's revision; never replace with a newer snapshot.
   * @returns Whether the save and authoritative refresh succeeded.
   */
  saveAppearance(input: OfficeAppearance, reviewedRevision: number): Promise<boolean>
  importAssistant(file: File | null): Promise<boolean>
  exportAssistant(id: string): void
  openDesktopUpdate(): void
  reconnect(): void
  downloadDiagnostics(): void
}

/** Additive home entry without replacing any native composer or dashboard. */
export type OfficeScenesProps = PropsRuntime<'office.home.experience'> & PropsLocale<'office.experience'> & InjectFace<OfficeExperienceInjected>
/** The native Settings shell supplies its close action and modal lifetime. */
export type OfficeExperienceSettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'office.experience'> & InjectFace<OfficeExperienceInjected>
