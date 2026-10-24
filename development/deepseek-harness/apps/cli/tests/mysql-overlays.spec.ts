/** Ordinary Include replacement and Loader injection merge preserve the shipped AgentLoop prerequisites. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Inject } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'
import { Config as SessionConfig } from '@deepseek-ai/dsh-session-persistence-mysql'

const repo = resolve(import.meta.dirname, '../../..')
async function patches(path: string): Promise<PatchOptions[]> {
  const value: unknown = yaml.load(await readFile(resolve(repo, path), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(value)) throw new Error('An owned patch must be a list.')
  return value as PatchOptions[]
}

it.each(['headless', 'sdk', 'sdk-minimal'])('MySQL overlay keeps %s static injections and requires the selected backend', async (profile) => {
  const warnings: string[] = []
  const warn = (message: string): void => { warnings.push(message) }
  let base: EntryOptions[] = []
  if (profile !== 'sdk-minimal') base = applyEntryPatches(base, await patches('packages/bundle/base/cordis.patch.yml'), warn)
  base = applyEntryPatches(base, await patches('packages/bundle/' + (profile === 'sdk' ? 'sdk-app' : profile) + '/cordis.patch.yml'), warn)
  const before = base.find(row => row.id === 'agent-loop')
  if (!before) throw new Error('The shipped AgentLoop row is absent.')
  // A new upstream metadata injection requires explicit preservation in this example.
  expect(before.inject).toBeUndefined()
  const original = Inject.resolve(AgentLoop.inject)
  const after = applyEntryPatches(base, await patches('apps/cli/config/examples/mysql-session/'
    + (profile === 'sdk-minimal' ? 'sdk-minimal' : 'base') + '.cordis.yml'), warn)
  const loop = after.find(row => row.id === 'agent-loop')
  if (!loop) throw new Error('The overlay removed AgentLoop.')
  expect(loop).toEqual({ ...before, inject: ['sessionPersistence'] })
  const merged = Inject.resolve(loop.inject, Inject.resolve(AgentLoop.inject))
  expect(merged).toEqual({ ...original, sessionPersistence: null })
  expect(after.find(row => row.id === (profile === 'sdk-minimal' ? 'sessions' : 'session-persistence-jsonl'))?.disabled).toBe(true)
  expect(warnings).toEqual([])
  expect(await MysqlConfig['~standard'].validate({ host: '127.0.0.1', port: 11406, database: 'approved_schema',
    user: 'approved_user', passwordRef: 'DSH_MYSQL_PASSWORD', schemaMode: 'verify' })).not.toHaveProperty('issues')
  expect(await SessionConfig['~standard'].validate({ storeKey: 'approved-store' })).not.toHaveProperty('issues')
  const mysql = after.find(row => row.id === 'mysql')
  const sessions = after.find(row => row.id === 'session-persistence-mysql')
  expect(mysql?.config).toEqual({ host: { __jsExpr: 'process.env.DSH_MYSQL_HOST' },
    port: { __jsExpr: 'Number(process.env.DSH_MYSQL_PORT)' }, database: { __jsExpr: 'process.env.DSH_MYSQL_DATABASE' },
    user: { __jsExpr: 'process.env.DSH_MYSQL_USER' }, passwordRef: 'DSH_MYSQL_PASSWORD', schemaMode: 'verify' })
  expect(sessions?.config).toEqual({ storeKey: { __jsExpr: 'process.env.DSH_MYSQL_STORE_KEY' } })
})
