/** Unreachable services and missing credentials fail activation without touching any installed database. */
import { createServer } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import MysqlRuntime, { MysqlError } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const context of contexts.splice(0)) await context.fiber.dispose() })

it('reports missing referenced credentials before opening a connection', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  await expect(ctx.plugin(MysqlRuntime, { host: '127.0.0.1', port: 33306, database: 'dsh_no_connect',
    user: 'unused', passwordRef: 'DSH_MYSQL_MISSING_TEST' })).rejects.toMatchObject({ code: 'credential_missing' })
  expect(ctx.get('mysql')).toBeUndefined()
})

it('reports a controlled closed loopback port as unavailable and does not retain the service', async () => {
  const server = createServer()
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('An owned loopback port is required')
  await new Promise<void>((done, reject) => { server.close((error) => { if (error) reject(error); else done() }) })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials, { DSH_MYSQL_CONNECTION_TEST: 'local test value' })
  try {
    await ctx.plugin(MysqlRuntime, { host: '127.0.0.1', port: address.port, database: 'dsh_no_connect',
      user: 'unused', passwordRef: 'DSH_MYSQL_CONNECTION_TEST', connectTimeoutMs: 1000 })
    throw new Error('An unavailable database activated')
  } catch (error) {
    expect(error).toBeInstanceOf(MysqlError)
    expect(error).toMatchObject({ code: 'connection_unavailable', outcome: 'not-started' })
    expect(String(error)).not.toContain('local test value')
  }
  expect(ctx.get('mysql')).toBeUndefined()
})
