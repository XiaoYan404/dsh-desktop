/** All seven shared durable waits and final collection against a real independent MySQL provider. */
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import MysqlRuntime from '@deepseek-ai/dsh-mysql'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionHandleClosedError } from '@deepseek-ai/dsh-session-persistence'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { runScenario, type InputScript } from '@deepseek-ai/dsh-session-snapshot'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import type { RowDataPacket } from 'mysql2/promise'
import MysqlSessionPersistence from '../src/index.ts'
import { canonical, corpusServerUuid, json, object, ownedCorpusInstance, text } from './fixtures/mysql-corpus/owned-instance.ts'

const repo = resolve(import.meta.dirname, '../../../..')
const fixtures = join(import.meta.dirname, 'fixtures/mysql-corpus')
const waits = ['waitForTurnStart', 'waitForTurnEnd', 'waitForSubagentTurnEnd', 'waitForGoalPhase',
  'waitForInboxMessage', 'waitForTitleAfterTurnEnd', 'waitForEventAfterTurnEnd'] as const
const input: InputScript = { steps: [
  { op: 'initialize' }, { op: 'newSession' },
  { op: 'waitForTurnStart', minimumTurn: 1 },
  { op: 'waitForFile', path: '.corpus-model-ready' }, { op: 'cancel' },
  { op: 'waitForTurnEnd' },
  { op: 'waitForSubagentTurnEnd', child: 1, minimumTurn: 1 },
  { op: 'waitForGoalPhase', phase: 'paused' },
  { op: 'waitForInboxMessage', text: 'mysql-corpus-inbox 完整😀' },
  { op: 'waitForTitleAfterTurnEnd' },
  { op: 'waitForEventAfterTurnEnd', type: 'goal/change' },
] }

function cleanEnvironment(root: string): NodeJS.ProcessEnv {
  // The shared launcher layers over process.env; undefined explicitly removes ambient secrets/settings.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
  const paths = [dirname(process.execPath)]
  if (process.env['SystemRoot']) paths.push(join(process.env['SystemRoot'], 'System32'))
  Object.assign(env, { PATH: paths.join(process.platform === 'win32' ? ';' : ':'), HOME: root, USERPROFILE: root,
    APPDATA: root, LOCALAPPDATA: root, DSH_TELEMETRY_DISABLED: '1', DSH_EXAMPLE_MODE: 'lib',
    DSH_PRIMARY_RUNTIME: '', DSH_BUNDLED_OFFICE_CLI: '' })
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT']) env[key] = process.env[key]
  return env
}

async function installedProfile(cwd: string): Promise<void> {
  const profile = join(cwd, '.dsh/profiles/acp')
  await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
  const dependencies: Record<string, string> = {}
  for (const path of ['packages/storage/mysql', 'packages/session/session-persistence-mysql']) {
    const dir = join(repo, path), pkg = await json(join(dir, 'package.json'))
    if (!existsSync(join(dir, 'lib/index.js'))) throw new Error('The explicitly selected optional artifact is absent.')
    dependencies[text(pkg['name'])] = text(pkg['version'])
    await symlink(dir, join(profile, 'node_modules', text(pkg['name'])), process.platform === 'win32' ? 'junction' : 'dir')
  }
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-owned-mysql-corpus', version: '1.0.0',
    private: true, dependencies, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } } }))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
}

function restore(content: string) {
  const values: unknown[] = content.trim().split('\n').map((line): unknown => JSON.parse(line))
  const decoder = sessionFormatCatalog.createRestore(values[0], { recovery: 'strict', validation: 'current' })
  for (const value of values.slice(1)) decoder.decodeRow(value)
  return decoder.finish()
}
function parse(source: string): unknown { return JSON.parse(source) }
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(row => !object(row))) throw new Error('Invalid owned Native corpus evidence rows.')
  return value as Record<string, unknown>[]
}

it('harvests all seven durable waits and final Native artifacts through an isolated MySQL observer', async () => {
  const cli = join(repo, 'apps/cli/lib/bin.js')
  if (!existsSync(cli)) throw new Error('The current ordinary built CLI is required; this lane never builds it.')
  const root = await mkdtemp(resolve(repo, '../.local-run/enterprise-mysql-corpus-'))
  const evidenceFile = join(root, 'native.json')
  const primaryFailures: unknown[] = []
  let target: Awaited<ReturnType<typeof ownedCorpusInstance>> | undefined
  let observer: Context | undefined
  let model: Awaited<ReturnType<typeof startMockLlmServer>> | undefined
  let workspace: string | undefined
  let evidence: Record<string, unknown> | undefined
  try {
    target = await ownedCorpusInstance(repo)
    const owned = target
    observer = new Context()
    await observer.plugin(CredentialsLocal, { dshHome: join(root, 'observer-home'), watch: false })
    const ref = 'CORPUS_' + randomUUID().replaceAll('-', '').toUpperCase()
    await owned.seedCredential(observer, ref)
    await observer.plugin(MysqlRuntime, owned.mysqlConfig(ref))
    await observer.plugin(MysqlSessionPersistence, { storeKey: owned.storeKey })
    const persistence = observer.sessionPersistence
    if (!persistence) throw new Error('The real independent MySQL Session observer did not activate.')
    const opening = vi.spyOn(persistence, 'open')
    const creating = vi.spyOn(persistence, 'create')
    const flushing = vi.spyOn(persistence, 'flush')
    expect(await persistence.list()).toEqual([])
    model = await startMockLlmServer({ sequence: ['stall', 'reasoning_success'], apiKey: 'corpus-dummy-key',
      successText: 'MySQL child 完整😀', reasoningText: 'Independent real MySQL corpus.',
      onEvent(event) {
        if (event.type === 'request' && event.attempt === 1) {
          if (!workspace) throw new Error('The model ran before corpus workspace preparation.')
          writeFileSync(join(workspace, '.corpus-model-ready'), 'ready\n', { flag: 'wx' })
        }
      } })
    // Launch mode is selected in the parent; RunOptions.env configures only the child environment.
    vi.stubEnv('DSH_EXAMPLE_MODE', 'lib')
    const result = await runScenario(input, {
      agent: { binScript: join(repo, 'apps/cli/src/bin.ts'), libBinScript: cli, profile: 'acp',
        configPath: join(repo, 'apps/cli/config/examples/mysql-session/base.cordis.yml'), tsconfigPath: join(repo, 'tsconfig.json') },
      mode: 'record', fixtureFile: join(root, 'session.v4.jsonl'), configPath: join(fixtures, 'cordis.yml'),
      sessionPersistence: persistence,
      env: { ...cleanEnvironment(root), ...owned.environment(), DEEPSEEK_API_KEY: 'corpus-dummy-key',
        DEEPSEEK_BASE_URL: model.baseURL, DSH_MYSQL_CORPUS_EVIDENCE: evidenceFile },
      async prepareWorkspace(cwd) { workspace = cwd; await installedProfile(cwd) },
    })
    expect(input.steps.filter(step => waits.some(wait => wait === step.op)).map(step => step.op)).toEqual(waits)
    expect(result.sessionId).toBeDefined()
    expect(result.sessionLogs).toHaveLength(2)
    const primary = result.sessionLogs[0], child = result.sessionLogs[1]
    if (!primary || !child) throw new Error('The actual MySQL corpus lacks its parent or child artifact.')
    expect(primary.id).toBe(result.sessionId)
    expect(primary.parentSession).toBeUndefined()
    expect(child.parentSession).toBe(primary.id)
    const native = await json(evidenceFile)
    expect(native['execArgv']).toEqual([])
    expect(native['failures']).toEqual([])
    expect(native['statuses']).toEqual(['running', 'idle'])
    expect(native['postTurnStarted']).toBe(true)
    expect(native['childId']).toBe(child.id)
    expect(canonical(fileURLToPath(text(native['llmModule'])))).toBe(canonical(join(repo, 'packages/llm/llm/lib/index.js')))
    expect(model.requests.map(request => request.behavior)).toEqual(['stall', 'reasoning_success'])
    expect(model.requests[1]?.outcome).toBe('completed')
    const prefixes = records(native['records'])
    expect(prefixes).toHaveLength(2)
    const [slots] = await owned.observer.execute<RowDataPacket[]>(
      'SELECT s.external_session_id AS id,l.slot_id,HEX(l.lifecycle_id) AS lifecycle,l.format_version,l.header_json,l.event_count,l.inherited_event_count,(w.owner_token IS NULL) AS released FROM dsh_session_slots s JOIN dsh_session_logs l ON l.store_id=s.store_id AND l.slot_id=s.slot_id AND l.lifecycle_id=s.current_lifecycle_id AND l.format_version=s.current_format_version JOIN dsh_writer_leases w ON w.store_id=s.store_id AND w.slot_id=s.slot_id WHERE s.store_id=?', [owned.storeId])
    expect(slots).toHaveLength(2)
    const summaries = []
    for (const log of result.sessionLogs) {
      const slot = slots.find(row => row['id'] === log.id)
      if (!slot) throw new Error('A harvested Session is absent from its isolated SQL store.')
      expect(Number(slot['format_version'])).toBe(SESSION_FORMAT_VERSION)
      expect(Number(slot['released'])).toBe(1)
      const [rows] = await owned.observer.execute<RowDataPacket[]>(
        'SELECT seq,event_json FROM dsh_session_events WHERE store_id=? AND slot_id=? AND lifecycle_id=UNHEX(?) AND format_version=? ORDER BY seq',
        [owned.storeId, text(slot['slot_id']), text(slot['lifecycle']), slot['format_version']])
      const sqlEvents = rows.map(row => parse(text(row['event_json'])))
      expect(rows.map(row => Number(row['seq']))).toEqual(Array.from({ length: rows.length }, (_, index) => index))
      expect(rows.length).toBe(Number(slot['event_count']))
      const restored = restore(log.content)
      expect(restored.events).toEqual(sqlEvents)
      expect(restored.inheritedEventCount).toBe(Number(slot['inherited_event_count']))
      const handle = await persistence.open(SessionId(log.id), 'read')
      const reading = await (async () => {
        expect(restored.events).toEqual((await handle.read()).events)
        expect(restored.header).toEqual({ ...handle.header, delegationDepth: handle.header.delegationDepth ?? 0 })
      })().then(() => ({ ok: true } as const), (error: unknown) => ({ error }))
      const [closing] = await Promise.allSettled([handle.close()])
      if ('error' in reading) {
        if (closing.status === 'rejected') throw new AggregateError([reading.error, closing.reason], 'Corpus read and close failed.')
        throw reading.error
      }
      if (closing.status === 'rejected') throw closing.reason
      const prefix = prefixes.find(value => object(value['header']) && value['header']['id'] === log.id)
      if (!prefix) throw new Error('A real child-process Native Session prefix was not captured.')
      expect(prefix['header']).toEqual(parse(text(slot['header_json'])))
      const prefixEvents = records(prefix['events'])
      expect(sqlEvents.slice(0, prefixEvents.length)).toEqual(prefixEvents)
      const eventTypes = restored.events.map(event => event.type)
      expect(eventTypes).toContain('turn/start')
      expect(eventTypes).toContain('turn/end')
      expect(eventTypes).toContain('request/header')
      if (log.id === child.id) {
        expect(eventTypes).toContain('subagent/descriptor')
        expect(restored.events.some(event => event.type === 'assistant/message')).toBe(true)
      } else {
        expect(eventTypes).toContain('goal/change')
        expect(eventTypes).toContain('agent/inbox/spliced')
        expect(eventTypes).toContain('session/title')
      }
      summaries.push({ id: log.id, events: rows.length, nativePrefix: prefixEvents.length,
        inheritedEventCount: restored.inheritedEventCount })
    }
    expect(creating).not.toHaveBeenCalled()
    expect(flushing).not.toHaveBeenCalled()
    expect(opening.mock.calls.length).toBeGreaterThan(9)
    expect(opening.mock.calls.every(call => call[1] === 'read')).toBe(true)
    for (const call of opening.mock.results) {
      if (call.type !== 'return') throw new Error('A real corpus observer open failed synchronously.')
      const handle = await call.value
      await expect(handle.read()).rejects.toBeInstanceOf(SessionHandleClosedError)
    }
    expect(await owned.receipts()).toEqual(owned.before)
    evidence = { serverUuid: corpusServerUuid, upstreamPort: 11406, storeKey: owned.storeKey, schemaMode: 'verify',
      waits, finalCollection: 'after-real-built-ACP-child-exit', summaries, observerAccess: 'read',
      observerOpenCalls: opening.mock.calls.length, observerCreateCalls: creating.mock.calls.length,
      observerFlushCalls: flushing.mock.calls.length, allReadHandlesClosed: true, schemaReceiptsUnchanged: true,
      actualModelRequests: model.requests.length, normalBuiltProfileResolution: true,
      scope: 'one-new-MySQL-corpus; existing JSONL corpus/defaults are not changed or rerun' }
  } catch (error) { primaryFailures.push(error) }

  const clean = async (work: () => Promise<unknown>): Promise<void> => {
    try { await work() } catch (error) { primaryFailures.push(error) }
  }
  if (observer) await clean(() => observer.fiber.dispose())
  if (model) await clean(() => model.close())
  if (target) await clean(() => target.observer.end())
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  // Keep the unique corpus store and whitelisted evidence; remove only this newly created observer home.
  await clean(async () => {
    const home = join(root, 'observer-home')
    if (existsSync(home)) {
      if (dirname(home) !== root || !basename(root).startsWith('enterprise-mysql-corpus-')) throw new Error('Unexpected observer home.')
      await rm(home, { recursive: true, force: true })
    }
  })
  if (primaryFailures.length > 1) throw new AggregateError(primaryFailures, 'MySQL corpus scenario and cleanup retained every failure.')
  if (primaryFailures.length === 1) throw primaryFailures[0]
  if (!evidence) throw new Error('The real MySQL corpus completed without evidence.')
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ ...evidence, cleanupCompleted: true }, null, 2) + '\n', { flag: 'wx' })
  console.log('Owned MySQL corpus evidence: ' + basename(root) + '/evidence.json')
})
