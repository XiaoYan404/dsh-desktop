/** Start only the office composition; employee Agent capabilities remain in their own Hosts. */
import { parseArgs } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

const { values } = parseArgs({ options: { config: { type: 'string' } } })
const config = resolve(values.config ?? fileURLToPath(new URL('./office.cordis.example.yml', import.meta.url)))
const ctx = new Context()
ctx.baseUrl = pathToFileURL(dirname(config)).href + '/'
try {
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  // Loader joins configured entries. Adapters can also mount async descendant fibers after entry activation.
  for (;;) {
    await ctx.loader.await()
    const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
    await Promise.all(fibers.map(fiber => fiber.await()))
    const current = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
    if (current.length === fibers.length && current.every(fiber => fibers.includes(fiber) && !fiber.inertia)) break
  }
  for (const entry of ctx.loader.entries()) {
    if (!entry.fiber) throw new Error(`Office plugin did not load: ${entry.options.name}`)
    await entry.fiber.await()
  }
  const gateway = ctx.get('officeGateway')
  if (!gateway) {
    const waiting = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => ({
      plugin: runtime.name,
      missing: Object.keys(fiber.inject).filter(name => !fiber.ctx.get(name)),
    }))).filter(entry => entry.missing.length)
    const entries = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => ({ plugin: runtime.name, state: fiber.state, provides: Object.keys(fiber.store ?? {}) })))
    throw new Error(`Office gateway did not activate; entries: ${JSON.stringify(entries)}; missing dependencies: ${JSON.stringify(waiting)}`)
  }
  console.log(`Office gateway listening on ${gateway.address}`)
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await ctx.fiber.dispose()
  }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
} catch (error) {
  await ctx.fiber.dispose()
  console.error(error instanceof Error ? error.message : 'Office server startup failed')
  process.exitCode = 1
}
