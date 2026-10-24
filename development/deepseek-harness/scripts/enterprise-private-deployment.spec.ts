/** Private configuration is composed by the real profile and Loader; HTTP probes use owned loopback servers. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Office from '@deepseek-ai/dsh-enterprise-office'
import LLM from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import Web from '@deepseek-ai/dsh-web'
import * as WebSearch from '@deepseek-ai/dsh-web-search-deepseek'
import * as WebFetch from '@deepseek-ai/dsh-web-fetch-http'
import Sessions from '@deepseek-ai/dsh-session'
import OTel from '@deepseek-ai/dsh-otel'
import SessionTelemetry from '@deepseek-ai/dsh-session-telemetry-otel'
import { listenHttp } from '@deepseek-ai/dsh-host-webserver'
import yaml from 'js-yaml'
import { runPrivateDeployment } from './enterprise-private-deployment.ts'
import { DeploymentError, parsePrivateDeployment, privateDeploymentArtifacts, privateDeploymentPatches,
  privateDeploymentReport, probePrivateDeployment, verifyPrivateDeployment, writePrivateDeployment,
} from './enterprise-private-deployment-config.ts'
import type { PrivateDeployment } from './enterprise-private-deployment-config.ts'

const repo = resolve(import.meta.dirname, '..')
const example = join(repo, 'apps/cli/config/examples/enterprise-private-deployment.json')
const roots: string[] = []
const servers: Server[] = []
const contexts: Context[] = []

async function fixture(): Promise<{ root: string; config: PrivateDeployment }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-private-deploy-'))
  roots.push(root)
  return { root, config: parsePrivateDeployment(await readFile(example, 'utf8'), join(root, 'config.json')) }
}

async function system(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  const port = await listenHttp(server, { host: '127.0.0.1', port: 0, maxAttempts: 16 })
  return { server, origin: `http://127.0.0.1:${port}` }
}

async function boot(config: PrivateDeployment, root: string) {
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain], ['@deepseek-ai/dsh-enterprise-office', Office],
    ['@deepseek-ai/dsh-llm', LLM], ['@deepseek-ai/dsh-llm-pi-ai', PiAi], ['@deepseek-ai/dsh-web', Web],
    ['@deepseek-ai/dsh-web-search-deepseek', WebSearch], ['@deepseek-ai/dsh-web-fetch-http', WebFetch],
    ['@deepseek-ai/dsh-session', Sessions], ['@deepseek-ai/dsh-otel', OTel],
    ['@deepseek-ai/dsh-session-telemetry-otel', SessionTelemetry],
  ])
  const base = loadOptionalPatches('fixture', join(repo, 'packages/bundle/base/cordis.patch.yml'))
  const web = loadOptionalPatches('fixture', join(repo, 'packages/bundle/web-app/cordis.patch.yml'))
  if (!base || !web) throw new Error('Shipped profile patches are required')
  const patches = privateDeploymentPatches(config)
  const composed = composeEntries([base, web, patches])
  for (const patch of patches) expect(composed.some(row => row.id === patch.id), patch.id).toBe(true)
  const rows = composed.filter(row => modules.has(row.name) || patches.some(patch => patch.id === row.id && row.disabled === true))
  const storage = rows.find(row => row.id === 'storage-json')
  if (!storage) throw new Error('Shipped storage row is required')
  storage.config = { root: join(config.home, 'storages') }
  const path = join(root, 'loader.yml')
  await writeFile(path, JSON.stringify(rows))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const imported: string[] = []
  const internal = ctx.loader.internal
  if (!internal) throw new Error('Node Loader is required')
  ctx.loader.internal = new Proxy(internal, { get(target, key) {
    if (key === 'import') return async (specifier: string) => {
      imported.push(specifier)
      if (!modules.has(specifier)) throw new Error('Unexpected deployment fixture module')
      return modules.get(specifier)
    }
    const value: unknown = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
  } })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  return { ctx, imported }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((done, reject) => server.close((error) => { if (error) reject(error); else done() }))
  }
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(resolve(tmpdir()))
    expect(basename(root).startsWith('dsh-private-deploy-')).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})

describe('private deployment configuration', () => {
  it('uses explicit local locations and real plugin switches without reading environment values', async () => {
    const { root, config } = await fixture()
    const report = await privateDeploymentReport(config)
    expect(report['homeStatus']).toBe('missing')
    expect(report['locations']).toMatchObject({ home: join(root, 'private-office-data'),
      credentials: join(root, 'private-office-data', '.credentials.yaml') })
    const artifacts = privateDeploymentArtifacts(config, join(root, 'artifacts'))
    const launch = JSON.parse(artifacts['launch.json'] ?? '') as { environment: object; args: string[] }
    expect(launch.environment).toEqual({ DSH_HOME: config.home })
    expect(launch.args).toEqual(['dsh', 'web', '--patch', join(root, 'artifacts', 'private-office.patch.yml'), '--no-open'])
    expect(report['remainingNetworkCapabilities']).toContain('Other installed model and account routes')
  })

  it.each([
    ['inline model credential', (config: PrivateDeployment) => Object.assign(config.model, { apiKey: 'do-not-log-this' })],
    ['credential URL', (config: PrivateDeployment) => { config.model.baseURL = 'https://user:do-not-log-this@localhost/v1' }],
    ['query credential', (config: PrivateDeployment) => { config.model.baseURL = 'https://localhost/v1?token=do-not-log-this' }],
    ['unsupported protocol', (config: PrivateDeployment) => Object.assign(config.model, { api: 'unsupported' })],
    ['noncanonical origin', (config: PrivateDeployment) => { config.office.connectorAllowedOrigins = ['https://oa.invalid/'] }],
    ['missing principal', (config: PrivateDeployment) => { config.office.principalId = 'absent' }],
    ['duplicate member', (config: PrivateDeployment) => { config.office.members.push({ ...config.office.members[0]! }) }],
    ['invalid time zone', (config: PrivateDeployment) => { config.office.timeZone = 'invalid/timezone' }],
    ['arbitrary probe', (config: PrivateDeployment) => { config.diagnostics.probes[0]!.url = 'https://unapproved.invalid/health' }],
    ['inline connector credential', (config: PrivateDeployment) => { config.office.connectorCredentials['company-oa'] = 'do-not-log-this!' }],
  ])('rejects %s with a sanitized, actionable error', async (_name, change) => {
    const { config } = await fixture()
    change(config)
    try { parsePrivateDeployment(JSON.stringify(config), example); throw new Error('Invalid input was admitted') }
    catch (error) {
      expect(error).toBeInstanceOf(DeploymentError)
      expect(String(error)).not.toContain('do-not-log-this')
    }
  })

  it('writes exclusively, detects changed artifacts and leaves application data untouched', async () => {
    const { root, config } = await fixture()
    const target = join(root, 'artifacts')
    await writePrivateDeployment(config, target)
    await verifyPrivateDeployment(config, target)
    await expect(writePrivateDeployment(config, target)).rejects.toMatchObject({ code: 'output_exists' })
    await writeFile(join(target, 'private-office.patch.yml'), '[]\n')
    await expect(verifyPrivateDeployment(config, target)).rejects.toMatchObject({ code: 'artifact_mismatch' })
    expect((await privateDeploymentReport(config))['homeStatus']).toBe('missing')
  })

  it('boots generated choices through the actual Loader and registers the private model while disabled exporters stay unmounted', async () => {
    const { root, config } = await fixture()
    const { ctx, imported } = await boot(config, root)
    expect(ctx.get('office')).toBeDefined()
    expect(ctx.llm.listProviders()).toContainEqual(expect.objectContaining({ id: config.model.route }))
    expect(await ctx.llm.listModels(config.model.route)).toContainEqual(expect.objectContaining({ id: 'company-model' }))
    expect(ctx.get('sessionTelemetry')).toBeUndefined()
    expect(imported).not.toContain('@deepseek-ai/dsh-session-telemetry-otel')
    expect(imported).not.toContain('@deepseek-ai/dsh-web-search-deepseek')
    expect(imported).not.toContain('@deepseek-ai/dsh-web-fetch-http')
    expect(imported).not.toContain('@deepseek-ai/dsh-host-product-telemetry-otel')
    expect(imported).not.toContain('@deepseek-ai/dsh-client-product-analytics')
    const llm = ctx.llm
    await ctx.fiber.dispose()
    expect(llm.listProviders()).toEqual([])
    contexts.splice(contexts.indexOf(ctx), 1)
  })

  it('mounts explicit internal search, fetch and feedback telemetry choices without sending ordinary activity', async () => {
    let requests = 0
    const remote = await system((_req, res) => { requests++; res.end('{}') })
    const { root, config } = await fixture()
    config.privacy.sessionTelemetry = { mode: 'feedback-only', endpoint: remote.origin + '/v1/logs' }
    config.privacy.webSearch = { enabled: true, baseURL: remote.origin + '/anthropic', model: 'private-search', apiKeyEnv: 'PRIVATE_SEARCH_KEY' }
    config.privacy.webFetch = true
    const { ctx, imported } = await boot(config, root)
    expect(ctx.get('sessionTelemetry')).toBeDefined()
    expect(imported).toContain('@deepseek-ai/dsh-web-search-deepseek')
    expect(imported).toContain('@deepseek-ai/dsh-web-fetch-http')
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    expect(requests).toBe(0)
  })

  it('composes the example through the supported dsh profile command without booting external services', async () => {
    const { root, config } = await fixture()
    const target = join(root, 'artifacts')
    await writePrivateDeployment(config, target)
    const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
      '--patch', join(target, 'private-office.patch.yml'), '--dump-config'], {
      cwd: repo, env: { ...process.env, DSH_HOME: config.home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    // Do not print composed config or inherited environment values when subprocess validation fails.
    child.stderr.resume()
    const timer = setTimeout(() => { child.kill() }, 20000)
    let exitCode: number | null
    try { exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }) }
    finally { clearTimeout(timer); if (child.exitCode === null) child.kill() }
    expect(exitCode).toBe(0)
    const rows = yaml.load(output, { schema: entryListSchema }) as Array<{ id: string; disabled?: unknown; config?: object }>
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'enterprise-office')?.config).toMatchObject({ dshHome: config.home,
      connectorAllowedOrigins: config.office.connectorAllowedOrigins })
    expect(rows.find(row => row.id === 'llm-pi-ai')?.config).toMatchObject({ providers: { [config.model.route]: { baseURL: config.model.baseURL } } })
    expect(rows.some(row => row.id === 'tool-bash')).toBe(true)
    expect(rows.some(row => row.id === 'plugin-manager')).toBe(true)
  }, 30000)
})

describe('explicit private endpoint checks', () => {
  it('reports offline, then recovers with the same configuration and never sends credentials', async () => {
    const remote = await system((req, res) => {
      expect(req.headers['authorization']).toBeUndefined()
      expect(req.headers['cookie']).toBeUndefined()
      res.end('a response body that must not be included in diagnostics')
    })
    const { root, config } = await fixture()
    config.model.baseURL = remote.origin + '/v1'
    config.diagnostics.probes = [{ name: 'model-health', url: remote.origin + '/health' }]
    const target = join(root, 'artifacts')
    await writePrivateDeployment(config, target)
    await new Promise<void>((done, reject) => remote.server.close((error) => { if (error) reject(error); else done() }))
    expect(await probePrivateDeployment(config)).toEqual([{ name: 'model-health', status: 'unreachable' }])
    const port = Number(new URL(remote.origin).port)
    await new Promise<void>((done, reject) => { remote.server.once('error', reject); remote.server.listen(port, '127.0.0.1', done) })
    expect(await probePrivateDeployment(config)).toEqual([{ name: 'model-health', status: 'reachable', httpStatus: 200 }])
    await verifyPrivateDeployment(config, target)
  })

  it('distinguishes authentication and HTTP errors, and refuses redirected destinations', async () => {
    let redirected = 0
    const target = await system((_req, res) => { redirected++; res.end() })
    const remote = await system((req, res) => {
      res.statusCode = req.url === '/auth' ? 401 : req.url === '/http' ? 503 : 302
      res.setHeader('location', target.origin)
      res.end('do-not-log-this')
    })
    const { config } = await fixture()
    config.model.baseURL = remote.origin
    config.diagnostics.probes = [{ name: 'auth', url: remote.origin + '/auth' },
      { name: 'http', url: remote.origin + '/http' }, { name: 'redirect', url: remote.origin + '/redirect' }]
    expect(await probePrivateDeployment(config)).toEqual([
      { name: 'auth', status: 'authentication-required', httpStatus: 401 },
      { name: 'http', status: 'http-error', httpStatus: 503 },
      { name: 'redirect', status: 'redirect-blocked', httpStatus: 302 },
    ])
    expect(redirected).toBe(0)
  })

  it('bounds a hung endpoint and cancels subsequent requests without retrying', async () => {
    let requests = 0
    const remote = await system(() => { requests++ })
    const { config } = await fixture()
    config.model.baseURL = remote.origin
    config.diagnostics.timeoutMs = 100
    config.diagnostics.probes = [{ name: 'hung', url: remote.origin + '/health' }]
    expect(await probePrivateDeployment(config)).toEqual([{ name: 'hung', status: 'timeout' }])
    const controller = new AbortController()
    controller.abort()
    expect(await probePrivateDeployment(config, controller.signal)).toEqual([{ name: 'hung', status: 'cancelled' }])
    expect(requests).toBe(1)
  })

  it('performs no network request by default and surfaces degraded explicit checks with a recoverable exit code', async () => {
    const { root, config } = await fixture()
    let requests = 0
    const remote = await system((_req, res) => { requests++; res.statusCode = 503; res.end('do-not-log-this') })
    config.model.baseURL = remote.origin
    config.diagnostics.probes = [{ name: 'model', url: remote.origin + '/health' }]
    const path = join(root, 'config.json')
    await writeFile(path, JSON.stringify(config))
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await runPrivateDeployment(['--config', path])).toBe(0)
    expect(requests).toBe(0)
    expect(await runPrivateDeployment(['--config', path, '--probe'])).toBe(2)
    expect(requests).toBe(1)
    expect(stdout.mock.calls.join('')).not.toContain('do-not-log-this')
    expect(stderr).not.toHaveBeenCalled()
  })
})
