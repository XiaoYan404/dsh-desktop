/** The office assistant must retain its installed base's declaring URL, even when derived from another plugin. */
import { afterEach, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { harness, declare } from '../../../preset/agent-preset-registry/tests/harness.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

it('derives a customer Preset with a relative plugin URL while keeping native scopes and disposal intact', async () => {
  const ctx = await harness()
  contexts.push(ctx)
  const base = ctx.extend({ baseUrl: new URL('../../../preset/agent-preset-registry/tests/fixtures/', import.meta.url).href })
  const declaring = await declare(base, { id: 'relative-customer-base', plugins: [
    { name: './plugins/contribute.js', config: { tool: 'customer_authorized_tool' } },
  ] })
  const office = ctx.extend({ baseUrl: new URL('../src/experience/', import.meta.url).href })
  const retire = await office.agentPresets.derive('office.assistant.relative-test', 'relative-customer-base')
  expect(await ctx.agentPresets.resolve('office.assistant.relative-test')).toEqual({ id: 'office.assistant.relative-test' })
  const handle = await ctx.agents.create({ sessionId: SessionId('07-relative-inheritance'),
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'office.assistant.relative-test') } })
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).toEqual(['customer_authorized_tool'])
  expect(ctx.tools.schemas()).toEqual([])
  await declaring.dispose()
  await retire()
  expect((await ctx.agentPresets.list()).some(preset => preset.id === 'office.assistant.relative-test')).toBe(false)
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).toEqual(['customer_authorized_tool'])
  await expect(office.agentPresets.derive('office.assistant.missing', 'relative-customer-base')).rejects.toThrow()
})

it('refuses a base unregistered while derivation awaits its diagnostic', async () => {
  const ctx = await harness()
  contexts.push(ctx)
  const base = ctx.extend({ baseUrl: new URL('../../../preset/agent-preset-registry/tests/fixtures/', import.meta.url).href })
  const declaring = await declare(base, { id: 'base-unloaded-during-derive', plugins: [
    { name: './plugins/contribute.js', config: { tool: 'old_tool' } },
  ] })
  const pending = ctx.agentPresets.derive('office.assistant.stale-base', 'base-unloaded-during-derive')
  const refusal = expect(pending).rejects.toThrow('Base agent preset is unavailable')
  await declaring.dispose()
  await refusal
  expect((await ctx.agentPresets.list()).some(preset => preset.id === 'office.assistant.stale-base')).toBe(false)
})
