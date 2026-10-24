/** Three artifact-only public launch paths selecting optional profile-installed MySQL plugins. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { ownedProfileInstance, profileEnvironmentWithoutCredential, profileReceipts, profileServerUuid } from '../../../packages/session/session-persistence-mysql/tests/fixtures/owned-profile-instance.ts'

const repo = resolve(import.meta.dirname, '../../..')
const fixture = join(repo, 'apps/cli/tests/fixtures/mysql-profile')
const cli = join(repo, 'apps/cli/lib/bin.js')
const sdk = join(repo, 'packages/sdk/client/lib/index.js')
const runFile = promisify(execFile)
const answer = 'MySQL preserves Native history 完整😀'
const reasoning = 'Checking the explicitly selected profile.'
const marker = 'MYSQL_PROFILE_ACCEPTANCE'

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
async function json(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!record(value)) throw new Error('Expected an owned evidence object.')
  return value
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected owned evidence text.')
  return value
}
function cleanEnvironment(workspace: string): Record<string, string> {
  const paths = [dirname(process.execPath)]
  if (process.env['SystemRoot']) paths.push(join(process.env['SystemRoot'], 'System32'))
  const env: Record<string, string> = { PATH: paths.join(process.platform === 'win32' ? ';' : ':'), DSH_TELEMETRY_DISABLED: '1',
    DSH_PRIMARY_RUNTIME: '', DSH_BUNDLED_OFFICE_CLI: '', HOME: workspace, USERPROFILE: workspace,
    APPDATA: workspace, LOCALAPPDATA: workspace, PYTHONIOENCODING: 'utf-8' }
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

interface Trace {
  pid: number
  execArgv: string[]
  modules: Record<string, string>
  records: Array<{ header: Record<string, unknown>; events: Array<Record<string, unknown>> }>
}
async function trace(path: string): Promise<Trace> {
  const { pid, records, modules, execArgv } = await json(path)
  if (typeof pid !== 'number' || !Array.isArray(records) || !record(modules)
    || !Array.isArray(execArgv)) throw new Error('Missing Native artifact observer evidence.')
  return { pid, execArgv: execArgv.map(text),
    modules: Object.fromEntries(Object.entries(modules).map(([key, value]) => [key, text(value)])),
    records: records.map((value: unknown) => {
      if (!record(value) || !record(value['header']) || !Array.isArray(value['events'])) throw new Error('Invalid Native history evidence.')
      return { header: value['header'], events: value['events'].map((event: unknown) => {
        if (!record(event)) throw new Error('Invalid Native event evidence.')
        return event
      }) }
    }),
  }
}

async function installedProfile(home: string, profile: string) {
  const dir = join(home, 'profiles', profile)
  await mkdir(join(dir, 'node_modules/@deepseek-ai'), { recursive: true })
  const dependencies: Record<string, string> = {}
  const paths = ['packages/storage/mysql', 'packages/session/session-persistence-mysql',
    ...(profile === 'sdk-minimal' ? ['packages/credentials/credentials-local'] : [])]
  for (const path of paths) {
    const pkg = await json(join(repo, path, 'package.json'))
    const name = pkg['name'], version = pkg['version']
    if (typeof name !== 'string' || typeof version !== 'string') throw new Error('Missing optional package metadata.')
    if (!existsSync(join(repo, path, 'lib/index.js'))) throw new Error('Required optional plugin artifact is absent.')
    dependencies[name] = version
    await symlink(join(repo, path), join(dir, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const observer = 'dsh-mysql-profile-observer'
  const observerDir = join(dir, 'node_modules', observer)
  await mkdir(observerDir)
  await copyFile(join(fixture, 'native-observer.mjs'), join(observerDir, 'index.mjs'))
  await writeFile(join(observerDir, 'package.json'), JSON.stringify({ name: observer, version: '1.0.0', type: 'module',
    exports: './index.mjs', peerDependencies: { '@deepseek-ai/dsh-session': dependencies['@deepseek-ai/dsh-mysql'] } }))
  dependencies[observer] = '1.0.0'
  const bundles = profile === 'sdk-minimal' ? ['@deepseek-ai/dsh-sdk-minimal']
    : ['@deepseek-ai/dsh-base', profile === 'headless' ? '@deepseek-ai/dsh-headless' : '@deepseek-ai/dsh-sdk-app']
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-owned-mysql-profile', version: '1.0.0',
    private: true, dependencies, dsh: { profile: { bundles } } }, null, 2))
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n')
  return observer
}

async function execute(command: string, args: string[], env: Record<string, string>, cwd: string): Promise<string> {
  try {
    const result = await runFile(command, args, { env, cwd, timeout: 90000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    return result.stdout
  } catch (error) {
    let detail = error instanceof Error ? error.message : 'Unknown subprocess failure'
    for (const key of ['DSH_MYSQL_PASSWORD', 'DEEPSEEK_API_KEY']) {
      const value = env[key]
      if (value) detail = detail.replaceAll(value, '[redacted]')
    }
    throw new Error('Built profile process failed: ' + detail)
  }
}

it.each(['CLI', 'TypeScript SDK', 'Python SDK'] as const)('%s restores MySQL history through installed profile artifacts', async (surface) => {
  if (!existsSync(cli) || !existsSync(sdk)) throw new Error('Build the ordinary CLI and SDK artifacts before this explicit lane.')
  const instance = await ownedProfileInstance(repo)
  const model = await startMockLlmServer({ sequence: ['reasoning_success', 'reasoning_success'],
    apiKey: 'owned-profile-dummy-key', successText: answer, reasoningText: reasoning })
  try {
    const root = await mkdtemp(resolve(repo, '../.local-run/enterprise-round152-mysql-profiles-'))
    const home = join(root, 'home'), workspace = join(root, 'workspace')
    await mkdir(workspace)
    const profile = surface === 'CLI' ? 'headless' : surface === 'Python SDK' ? 'sdk-minimal' : 'sdk'
    const observer = await installedProfile(home, profile)
    const legacyDir = join(home, 'sessions/legacy/unchanged')
    await mkdir(legacyDir, { recursive: true })
    const legacy = join(legacyDir, 'session.v3.jsonl')
    await copyFile(join(repo, 'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/session.1.v3.jsonl'), legacy)
    const legacyHash = hash(await readFile(legacy))
    const env = { ...cleanEnvironment(workspace), ...instance.environment(), DSH_HOME: home,
      DEEPSEEK_API_KEY: 'owned-profile-dummy-key', DEEPSEEK_BASE_URL: model.baseURL,
      PYTHONPATH: join(repo, 'python/sdk/src') }
    let sessionId = 'mysql-profile-' + randomUUID()
    let first: Awaited<ReturnType<typeof instance.read>> | undefined
    let firstPid: number | undefined
    const pids: number[] = []
    for (const phase of [1, 2]) {
      const evidenceFile = join(root, 'native-' + String(phase) + '.json')
      const testPatch = join(root, 'test-' + String(phase) + '.json')
      await writeFile(testPatch, JSON.stringify([
        ...(profile === 'headless' ? [{ id: 'session-title-llm', disabled: true }] : []),
        { insert: [{ id: 'mysql-profile-observer', name: observer, config: { evidenceFile, phase } }] },
      ]))
      const overlay = join(repo, 'apps/cli/config/examples/mysql-session', profile === 'sdk-minimal' ? 'sdk-minimal.cordis.yml' : 'base.cordis.yml')
      const patches = [overlay, testPatch]
      const prompt = marker + ' phase ' + String(phase)
      let result: Record<string, unknown> | undefined
      if (surface === 'CLI') {
        const stdout = await execute(process.execPath, [cli, '--profile', profile, ...patches.flatMap(path => ['--patch', path]),
          '--json', ...(phase === 2 ? ['--session-id', sessionId] : []), prompt], env, workspace)
        const lines = stdout.trim().split(/\r?\n/u).map((line) => { const value: unknown = JSON.parse(line); return value })
        const opening = lines[0]
        if (!record(opening) || typeof opening['sessionId'] !== 'string') throw new Error('Missing headless Session identity.')
        sessionId = opening['sessionId']
        expect(lines.at(-1)).toEqual({ type: 'final', text: answer })
        expect(lines.some(value => record(value) && value['type'] === 'thinking' && value['text'] === reasoning)).toBe(true)
      } else {
        const config = join(root, 'client-' + String(phase) + '.json'), output = join(root, 'result-' + String(phase) + '.json')
        await writeFile(config, JSON.stringify({ cli, sdk, profile, patches, home, workspace, sessionId, prompt, output }))
        if (surface === 'TypeScript SDK') await execute(process.execPath, [join(fixture, 'typescript-client.mjs'), config], env, workspace)
        else {
          const python = process.env['DSH_MYSQL_TEST_PYTHON']
          if (!python || !existsSync(python)) throw new Error('Set DSH_MYSQL_TEST_PYTHON to the prepared Python interpreter.')
          await execute(python, [join(repo, 'python/sdk/tests/fixtures/mysql_profile_client.py'), config], env, workspace)
        }
        result = await json(output)
        expect(result['sessionId']).toBe(sessionId)
        expect(result['finalResponse']).toBe(answer)
      }
      const native = await trace(evidenceFile)
      expect(native.execArgv).toEqual([])
      expect(native.records).toHaveLength(1)
      const retained = native.records[0]
      if (!retained) throw new Error('The Native observer recorded no Session.')
      for (const [name, path] of [['@deepseek-ai/dsh-mysql', 'packages/storage/mysql/lib/index.js'],
        ['@deepseek-ai/dsh-session-persistence-mysql', 'packages/session/session-persistence-mysql/lib/index.js']] as const) {
        const url = native.modules[name]
        if (!url) throw new Error('Missing ordinary optional-module resolution.')
        expect(realpathSync.native(fileURLToPath(url)).toLowerCase()).toBe(realpathSync.native(join(repo, path)).toLowerCase())
      }
      const stored = await instance.read()
      expect(stored.row['id']).toBe(sessionId)
      expect(stored.header).toEqual(retained.header)
      expect(stored.events).toEqual(retained.events)
      expect(stored.events).toHaveLength(Number(stored.row['event_count']))
      expect(stored.row).toMatchObject({ owner_token: null, lease_lifecycle: null, expires_at: null })
      expect(retained.events.some(event => event['type'] === 'plugin:mysql-profile/evidence')).toBe(true)
      expect(retained.events.some(event => event['type'] === 'assistant/message' && record(event['data'])
        && Array.isArray(event['data']['stream']) && event['data']['stream'].length > 0)).toBe(true)
      expect(retained.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      if (result) {
        const events = result['events']
        if (!Array.isArray(events) || !events.length) throw new Error('The public SDK lost its interval events.')
        for (const event of events) {
          if (!record(event) || typeof event['seq'] !== 'number') throw new Error('Invalid SDK event envelope.')
          expect(event).toEqual(stored.events[event['seq']])
        }
      }
      if (first) {
        expect(stored.header).toEqual(first.header)
        for (const key of ['slot_id', 'lifecycle', 'version']) expect(stored.row[key]).toBe(first.row[key])
        expect(stored.events.slice(0, first.events.length)).toEqual(first.events)
        expect(stored.events.length).toBeGreaterThan(first.events.length)
        expect(BigInt(String(stored.row['fence_token']))).toBeGreaterThan(BigInt(String(first.row['fence_token'])))
        expect(native.pid).not.toBe(firstPid)
      } else { first = stored; firstPid = native.pid }
      pids.push(native.pid)
    }
    expect(model.requests).toHaveLength(2)
    expect(model.requests.every(request => request.path === '/v1/messages')).toBe(true)
    const continued = JSON.stringify(model.requests[1]?.body)
    expect(continued).toContain(marker + ' phase 1')
    expect(continued).toContain(answer)
    expect(continued).toContain(marker + ' phase 2')
    expect(hash(await readFile(legacy))).toBe(legacyHash)
    expect((await readdir(join(home, 'sessions'), { recursive: true })).filter(path => path.endsWith('.jsonl'))).toEqual(['legacy' + (process.platform === 'win32' ? '\\' : '/') + 'unchanged' + (process.platform === 'win32' ? '\\' : '/') + 'session.v3.jsonl'])
    expect(await profileReceipts(instance.connection)).toEqual(instance.receipts)
    const evidence = { surface, serverUuid: profileServerUuid, host: '127.0.0.1', port: 11406,
      storeKey: instance.storeKey, sessionId, pids, fixtureRoot: root, legacySha256: legacyHash,
      installation: 'profile-declared built artifact links; no installer or registry run',
      checks: ['empty-environment', 'ordinary-profile-resolution', 'two-process-resume', 'complete-native-prefix',
        'reasoning-stream', 'plugin-record', 'stable-generation', 'increasing-fence', 'released-lease', 'unchanged-schema-receipts'] }
    await writeFile(resolve(repo, '../.local-run/enterprise-round152-mysql-profile-' + surface.replaceAll(' ', '-').toLowerCase() + '.json'),
      JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  } finally { await model.close(); await instance.connection.end() }
})

it.each(['headless', 'sdk-minimal'])('missing MySQL credential refuses memory-only startup in %s', async (profile) => {
  const approved = await profileEnvironmentWithoutCredential(repo)
  const model = await startMockLlmServer({ sequence: ['success'], apiKey: 'owned-refusal-dummy-key' })
  try {
    const root = await mkdtemp(resolve(repo, '../.local-run/enterprise-round152-mysql-refusal-'))
    const workspace = join(root, 'workspace'), home = join(root, 'home')
    await mkdir(workspace)
    await installedProfile(home, profile)
    const createdFile = join(root, 'unexpected-session.txt'), patch = join(root, 'observer.json')
    await writeFile(patch, JSON.stringify([{ insert: [{ id: 'refusal-observer',
      name: pathToFileURL(join(fixture, 'refusal-observer.mjs')).href, config: { createdFile } }] }]))
    const env = { ...cleanEnvironment(workspace), ...approved, DSH_HOME: home,
      DEEPSEEK_API_KEY: 'owned-refusal-dummy-key', DEEPSEEK_BASE_URL: model.baseURL }
    expect(env).not.toHaveProperty('DSH_MYSQL_PASSWORD')
    let failure: unknown
    try {
      await runFile(process.execPath, [cli, '--profile', profile,
        '--patch', join(repo, 'apps/cli/config/examples/mysql-session', profile === 'headless' ? 'base.cordis.yml' : 'sdk-minimal.cordis.yml'),
        '--patch', patch, ...(profile === 'headless' ? [marker + ' must not run'] : [])],
      { env, cwd: workspace, timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 })
    } catch (error) { failure = error }
    if (!record(failure) || typeof failure['code'] !== 'number' || typeof failure['stderr'] !== 'string') {
      throw new Error('Expected an actual nonzero startup refusal, not a timeout or successful memory-only run.')
    }
    expect(failure['code']).not.toBe(0)
    expect(failure['stderr']).toContain('password reference is unavailable')
    expect(failure['stderr']).toContain('agent-loop')
    expect(model.requests).toHaveLength(0)
    expect(existsSync(createdFile)).toBe(false)
    expect(existsSync(join(home, 'sessions'))).toBe(false)
    await writeFile(resolve(repo, '../.local-run/enterprise-round152-mysql-refusal-' + profile + '.json'), JSON.stringify({
      profile, exitCode: failure['code'], modelRequests: 0, nativeSessions: 0, databaseConnections: 0,
      checks: ['missing-credential-before-pool', 'required-agent-loop-pending', 'no-memory-only-session', 'no-local-history'],
    }, null, 2) + '\n', { mode: 0o600 })
  } finally { await model.close() }
})
