/** Full entry identities must be resolved before mutation of a subtree's local store. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Schema from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished } from 'vitest'

it('removes only the resolved nested entry, persists its removal and still handles root ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-loader-remove-'))
  const contexts: Context[] = []
  onTestFinished(async () => {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    const absolute = resolve(directory)
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('dsh-loader-remove-')) throw new Error('Unexpected temporary directory')
    await rm(absolute, { recursive: true, force: true })
  })
  const left = join(directory, 'left.json')
  const right = join(directory, 'right.json')
  await writeFile(left, JSON.stringify([{ id: 'same', name: 'cordis:leaf', config: { tag: 'left' } }]))
  await writeFile(right, JSON.stringify([{ id: 'same', name: 'cordis:leaf', config: { tag: 'right' } }]))
  const rows: EntryOptions[] = [
    { id: 'same', name: 'cordis:leaf', config: { tag: 'root' } },
    { id: 'left', name: 'cordis:include', config: { path: pathToFileURL(left).href } },
    { id: 'right', name: 'cordis:include', config: { path: pathToFileURL(right).href } },
  ]
  const boot = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    const active = new Set<string>()
    const disposed: string[] = []
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.leaf = {
      Config: Schema.object({ tag: Schema.string().required() }),
      apply(owner: Context, config: { tag: string }) {
        owner.effect(() => {
          active.add(config.tag)
          return () => { active.delete(config.tag); disposed.push(config.tag) }
        })
      },
    }
    await ctx.loader.root.update(structuredClone(rows))
    await ctx.loader.await()
    return { ctx, active, disposed }
  }
  const first = await boot()
  expect([...first.active].sort()).toEqual(['left', 'right', 'root'])
  first.ctx.loader.remove('left:same')
  await first.ctx.loader.await()
  expect(() => first.ctx.loader.resolve('left:same')).toThrow('cannot resolve entry')
  await expect.poll(() => [...first.active].sort()).toEqual(['right', 'root'])
  expect(first.disposed).toEqual(['left'])
  expect(first.ctx.loader.resolve('same').fiber?.state).toBe(2)
  expect(first.ctx.loader.resolve('right:same').fiber?.state).toBe(2)
  await expect.poll(async () => JSON.parse(await readFile(left, 'utf8')) as unknown).toEqual([])
  expect(JSON.parse(await readFile(right, 'utf8'))).toHaveLength(1)
  await first.ctx.fiber.dispose()
  const restarted = await boot()
  expect([...restarted.active].sort()).toEqual(['right', 'root'])
  expect(() => restarted.ctx.loader.resolve('left:same')).toThrow('cannot resolve entry')
  restarted.ctx.loader.remove('same')
  await expect.poll(() => [...restarted.active]).toEqual(['right'])
  expect(restarted.disposed).toEqual(['root'])
  expect(restarted.ctx.loader.resolve('right:same').fiber?.state).toBe(2)
})
