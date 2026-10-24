/** Register the new office leaves through Slots while retaining the original office and native owners. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { OfficeModel } from '../model.ts'
import type { ExperienceClientDependencies } from './model.ts'
import { OfficeExperienceClient } from './model.ts'
import { OfficeMaintenanceModel } from './maintenance.ts'
import type { OfficeDesktopMaintenanceBridge } from './maintenance.ts'
import type { OfficeExperienceInjected } from './contracts.ts'
import { experienceEn, experienceZh } from './locales.ts'
import { OfficeScenes } from './Scenes.tsx'
import { OfficeExperienceSettings } from './Settings.tsx'

/** @param ctx - Client registration lifetime. @param dependencies - Existing BFF/native commands and office identity source.
 * @returns Account-fenced model for the office page's standard hook declaration.
 */
export function installOfficeExperienceClient(ctx: Context,
  dependencies: Omit<ExperienceClientDependencies, 't'> & { readonly office: OfficeModel['state'] }): OfficeExperienceClient {
  ctx.effect(() => ctx.locale.register('office.experience', { zh: experienceZh, en: experienceEn }), 'office.experience.locale')
  const model = new OfficeExperienceClient({ ...dependencies, t: ctx.locale.bind('office.experience') })
  const bridge = (globalThis as typeof globalThis & { dshDesktop?: OfficeDesktopMaintenanceBridge }).dshDesktop
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const maintenance = new OfficeMaintenanceModel(bridge, () => { connection?.reconnect() })
  ctx.effect(() => {
    const bind = () => { model.bind(dependencies.office.getSnapshot().view?.me.id ?? null) }
    const connected = () => { maintenance.connected(connection?.state.getSnapshot() === 'connected') }
    const stopOffice = dependencies.office.subscribe(bind)
    const stopConnection = connection?.state.subscribe(connected)
    bind(); connected()
    return () => { stopOffice(); stopConnection?.(); model.dispose(); maintenance.dispose() }
  }, 'office.experience.identity')
  const face = (): OfficeExperienceInjected => ({
    hooks: { experience: model.state, maintenance: maintenance.state },
    loadExperience: () => model.load(), startScene: (scene, id) => model.start(scene, id),
    saveAssistant: input => model.saveAssistant(input), saveAppearance: (input, reviewedRevision) => model.saveAppearance(input, reviewedRevision),
    importAssistant: file => model.importAssistant(file), exportAssistant: (id) => { model.exportAssistant(id) },
    openDesktopUpdate: () => { maintenance.openUpdate() }, reconnect: () => { maintenance.reconnect() },
    downloadDiagnostics: () => { dependencies.download('office-diagnostics.json', maintenance.diagnostics(model.state.getSnapshot().view?.assistants.length ?? 0)) },
  })
  ctx.slots.inject('office.home.experience', () => ctx.slots.register({
    name: 'office.home.experience', locale: 'office.experience', inject: face,
  }, OfficeScenes))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'office.experience', order: 55, locale: 'office.experience',
    label: () => ctx.locale.bind('office.experience')('appearance'), inject: face,
  }, OfficeExperienceSettings))
  return model
}
