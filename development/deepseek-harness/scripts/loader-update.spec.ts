/** Include persistence must observe updated options before reporting a configuration change. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Schema from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished } from 'vitest'

it.each([false, true])('persists updated options before config notification and restart (move=%s)', async (move) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-loader-update-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    const absolute = resolve(directory)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-loader-update-')) throw new Error('Unexpected temporary directory')
    await rm(absolute, { recursive: true, force: true })
  })
  const left = join(directory, 'left.json')
  const right = join(directory, 'right.json')
  await writeFile(left, JSON.stringify([{ id: 'leaf', name: 'cordis:leaf', config: { tag: 'before' } }]))
  await writeFile(right, JSON.stringify([{ id: 'sibling', name: 'cordis:leaf', config: { tag: 'untouched' } }]))
  const boot = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    const active = new Set<string>()
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.leaf = {
      Config: Schema.object({ tag: Schema.string().required() }),
      apply(owner: Context, config: { tag: string }) {
        owner.effect(() => { active.add(config.tag); return () => { active.delete(config.tag) } })
      },
    }
    await ctx.loader.root.update([
      { id: 'left', name: 'cordis:include', config: { path: pathToFileURL(left).href } },
      { id: 'right', name: 'cordis:include', config: { path: pathToFileURL(right).href } },
    ])
    await ctx.loader.await()
    return { ctx, active }
  }
  const first = await boot()
  const observed: unknown[] = []
  first.ctx.on('loader/config-update', () => {
    const entry = [...first.ctx.loader.entries()].find(entry => entry.options.id === 'leaf')
    observed.push(entry?.options.config)
  })
  await first.ctx.loader.update('left:leaf', { config: { tag: 'after' } }, move ? 'right' : undefined)
  await first.ctx.loader.await()
  await expect.poll(async () => JSON.parse(await readFile(move ? right : left, 'utf8')) as unknown)
    .toContainEqual({ id: 'leaf', name: 'cordis:leaf', config: { tag: 'after' } })
  expect(observed).toContainEqual({ tag: 'after' })
  if (move) await expect.poll(async () => JSON.parse(await readFile(left, 'utf8')) as unknown).toEqual([])
  expect(JSON.parse(await readFile(right, 'utf8'))).toContainEqual({ id: 'sibling', name: 'cordis:leaf', config: { tag: 'untouched' } })
  await first.ctx.fiber.dispose()
  const restarted = await boot()
  expect([...restarted.active].sort()).toEqual(['after', 'untouched'])
})
