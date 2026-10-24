/** Compose durable assistants with the existing native registry, without exposing private instructions in its roster. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { OfficeExperienceService } from './service.ts'
import type { OfficeAppearance, OfficeAssistant, OfficeAssistantInput, OfficeExperienceView, ExperienceOutcome } from './types.ts'
export type { ExperienceOutcome } from './types.ts'

/** Methods delegated by the office BFF; generated Remotes retain the existing authenticated carrier. */
export interface OfficeExperienceHost {
  view(): Promise<ExperienceOutcome<OfficeExperienceView>>
  saveAssistant(revision: number, input: OfficeAssistantInput): Promise<ExperienceOutcome<OfficeAssistant>>
  saveAppearance(revision: number, input: OfficeAppearance): Promise<ExperienceOutcome<null>>
}

/**
 * Install one profile-owned lifetime; readiness never blocks the Loader's own activation.
 * @param ctx - Controller context; dependencies are resolved through optional service lookup.
 * @param principal - Re-read the existing office connection and reject inactive or missing identities.
 * @returns Sanitized methods; unavailable dependencies produce explicit unavailable outcomes.
 */
export function installOfficeExperienceHost(ctx: Context, principal: () => Promise<string>): OfficeExperienceHost {
  const profile = ctx.get('profileContext') as ProfileContext | undefined
  const registry = ctx.get('agentPresets') as AgentPresetRegistry | undefined
  if (!profile || !registry) return {
    view: () => Promise.resolve({ ok: false, code: 'unavailable' }),
    saveAssistant: () => Promise.resolve({ ok: false, code: 'unavailable' }),
    saveAppearance: () => Promise.resolve({ ok: false, code: 'unavailable' }),
  }
  const service = new OfficeExperienceService({
    filename: join(profile.dir, 'office-experience.v1.json'), principal,
    roster: () => registry.list(),
    register: (assistant, id) => registry.derive(id, assistant.basePreset),
  })
  let active = true
  const ready = ctx.root.loader.await().then(async () => {
    if (active) await service.initialize()
  }).catch((_error: unknown) => {
    // Commands still perform a strict fresh read, so repairing the file makes Retry useful.
    ctx.logger.warn('Office experience configuration is unavailable')
  })
  ctx.effect(() => async () => { active = false; await service.dispose() }, 'office.experience')
  async function outcome<T>(action: () => Promise<T>): Promise<ExperienceOutcome<T>> {
    try {
      await ready
      if (!active) throw new Error('unavailable')
      return { ok: true, value: await action() }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      return { ok: false, code: code === 'invalid' || code === 'conflict' || code === 'unauthenticated' || code === 'not_found' ? code : 'unavailable' }
    }
  }
  return {
    view: () => outcome(() => service.view()),
    saveAssistant: (revision, input) => outcome(() => service.saveAssistant(revision, input)),
    saveAppearance: (revision, input) => outcome(async () => { await service.saveAppearance(revision, input); return null }),
  }
}
