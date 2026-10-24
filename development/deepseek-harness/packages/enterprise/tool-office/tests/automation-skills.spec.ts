/** Bundled automation follows registry precedence and withdraws on office plugin unload. */
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'
import * as AutomationSkills from '../src/automation-skills.ts'

it('registers the actual bundled instructions and removes their catalog entry when the child plugin unloads', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    const plugin = await ctx.plugin(AutomationSkills)
    const skill = await ctx.skills.get('office-minutes')
    expect(skill).toMatchObject({ name: 'office-minutes', source: 'bundled', provider: 'dsh-office-automation',
      invocation: { modelInvocable: true, userInvocable: true } })
    expect(skill?.content).toContain('## Extract and review')
    expect(skill?.content).toContain('## Deliver and report')
    expect(skill?.content).not.toContain('LibreOffice Kit')
    await plugin.dispose()
    expect(await ctx.skills.list()).toEqual([])
    expect(await ctx.skills.get('office-minutes')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('retains existing skills and an overriding runtime contribution across office plugin unload', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    const removeExisting = ctx.skills.register({ name: 'office-docx', description: 'Existing Word skill',
      content: 'Existing document instructions', source: 'runtime' })
    const plugin = await ctx.plugin(AutomationSkills)
    const removeOverride = ctx.skills.register({ name: 'office-minutes', description: 'Company minutes',
      content: 'Company-specific minutes instructions', source: 'runtime' })
    expect((await ctx.skills.get('office-minutes'))?.content).toBe('Company-specific minutes instructions')
    await plugin.dispose()
    expect((await ctx.skills.get('office-minutes'))?.content).toBe('Company-specific minutes instructions')
    expect((await ctx.skills.get('office-docx'))?.content).toBe('Existing document instructions')
    removeOverride()
    removeExisting()
    expect(await ctx.skills.list()).toEqual([])
  } finally { await ctx.fiber.dispose() }
})
