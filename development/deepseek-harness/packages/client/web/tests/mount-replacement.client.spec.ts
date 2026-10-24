// @vitest-environment jsdom
/** A live entry replacement may temporarily withdraw the root registration. */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ClientEntryState } from '@deepseek-ai/dsh-client-modules/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountClient } from '../src/mount.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin({ apply: (scope: Context) => { new SlotRegistry(scope) } })
  const entries = createSnapshotStore<ClientEntryState>({ syncing: false, failures: [] })
  const failed = vi.fn((_reason: unknown) => {})
  const container = document.createElement('div')
  const mount = vi.fn((element: HTMLElement) => {
    if (ctx.slots.entries('root').length === 0) throw new Error('root not registered')
    const input = document.createElement('input')
    element.replaceChildren(input)
    return () => { element.replaceChildren() }
  })
  await ctx.plugin({ apply: (scope: Context) => { scope.reflect.provide('uiRenderer', { mount }) } })
  const root = ctx.slots.register({ name: 'root' }, () => null)
  await mountClient(ctx, container, { entries, failed })
  return { ctx, entries, failed, container, mount, root }
}

it('suspends mounting while a controlled replacement withdraws the root', async () => {
  const current = await fixture()
  expect(current.mount).toHaveBeenCalledTimes(1)
  current.entries.set({ syncing: true, failures: [] })
  current.root()
  await vi.waitFor(() => { expect(current.container.childElementCount).toBe(0) })
  expect(current.mount).toHaveBeenCalledTimes(1)
  current.ctx.slots.register({ name: 'root' }, () => null)
  await Promise.resolve()
  expect(current.mount).toHaveBeenCalledTimes(1)
  current.entries.set({ syncing: false, failures: [] })
  await vi.waitFor(() => { expect(current.mount).toHaveBeenCalledTimes(2) })
  expect(current.failed).not.toHaveBeenCalled()
})

it('preserves the mounted draft during an unrelated entry replacement', async () => {
  const current = await fixture()
  const input = current.container.querySelector('input')
  if (!input) throw new Error('Fixture input missing')
  input.value = 'unsaved local draft'
  current.entries.set({ syncing: true, failures: [] })
  current.entries.set({ syncing: false, failures: [] })
  await Promise.resolve()
  expect(current.container.querySelector('input')).toBe(input)
  expect(input.value).toBe('unsaved local draft')
  expect(current.mount).toHaveBeenCalledTimes(1)
})

it('reports a missing root after replacement and recovers when the root returns', async () => {
  const current = await fixture()
  current.entries.set({ syncing: true, failures: [] })
  current.root()
  await Promise.resolve()
  current.entries.set({ syncing: false, failures: [{ id: 'layout', message: 'replacement failed' }] })
  await vi.waitFor(() => { expect(current.failed).toHaveBeenCalledWith(expect.any(Error)) })
  expect(current.mount).toHaveBeenCalledTimes(1)
  current.ctx.slots.register({ name: 'root' }, () => null)
  await vi.waitFor(() => { expect(current.container.childElementCount).toBe(1) })
  expect(current.mount).toHaveBeenCalledTimes(2)
})
