/** Abrupt owned built-profile death leaves an open Native tail until database-clock lease expiry and public resume. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import MysqlRuntime from '@deepseek-ai/dsh-mysql'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { launchAcpTestAgent, type LaunchedAcpTestAgent } from '@deepseek-ai/dsh-session-snapshot'
import MysqlSessionPersistence from '../src/index.ts'
import { crashDeadline, crashEnvironment, crashOwnedChild, crashServerUuid, crashSnapshot, crashUntil,
  installCrashProfile, ownedCrashInstance, readCrashNative, removeCrashHome } from './fixtures/mysql-crash-owned.ts'

const repo = resolve(import.meta.dirname, '../../../..')
const settings = { leaseTtlMs: 4000, heartbeatIntervalMs: 250, batchDelayMs: 0 }
const reply = 'Native crash recovery 完整😀'

function parse(source: string): unknown { return JSON.parse(source) }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

function sameIdentity(before: Awaited<ReturnType<typeof crashSnapshot>>, after: Awaited<ReturnType<typeof crashSnapshot>>): void {
  expect(after.metadata.id).toBe(before.metadata.id)
  expect(after.metadata.slot).toBe(before.metadata.slot)
  expect(after.metadata.lifecycle).toBe(before.metadata.lifecycle)
  expect(after.metadata.version).toBe(before.metadata.version)
  expect(after.metadata.headerText).toBe(before.metadata.headerText)
  expect(after.metadata.inherited).toBe(before.metadata.inherited)
}

function continuous(saved: Awaited<ReturnType<typeof crashSnapshot>>): void {
  expect(saved.events.map(event => event.seq)).toEqual(Array.from({ length: saved.events.length }, (_, index) => index))
  expect(saved.metadata.eventCount).toBe(saved.events.length)
  let next = 0
  const batches = new Set<string>()
  for (const receipt of saved.receipts) {
    expect(Number(receipt['first_seq'])).toBe(next)
    expect(Number(receipt['batch_event_count'])).toBeGreaterThan(0)
    const id = String(receipt['batch_id'])
    expect(batches.has(id)).toBe(false)
    batches.add(id)
    next += Number(receipt['batch_event_count'])
  }
  expect(next).toBe(saved.events.length)
}

it('recovers an abruptly killed owned Native producer only after natural lease expiry and continues its exact log', async () => {
  const cli = join(repo, 'apps/cli/lib/bin.js')
  if (!existsSync(cli)) throw new Error('The ordinary built CLI is required; this scenario never builds it.')
  const root = await mkdtemp(resolve(repo, '../.local-run/enterprise-mysql-crash-'))
  const workspace = join(root, 'workspace'), bootA = join(root, 'process-a'), bootB = join(root, 'process-b')
  const failures: unknown[] = []
  let target: Awaited<ReturnType<typeof ownedCrashInstance>> | undefined
  let observer: Context | undefined
  let model: Awaited<ReturnType<typeof startMockLlmServer>> | undefined
  let first: LaunchedAcpTestAgent | undefined, second: LaunchedAcpTestAgent | undefined
  let firstClosed = false, secondClosed = false
  let stalled: Promise<{ ok: true } | { error: unknown }> | undefined
  let expectedCrashFailure: unknown
  let evidence: Record<string, unknown> | undefined
  let phase = 'isolated setup'
  const observations: Record<string, unknown> = {}
  try {
    for (const path of [workspace, bootA, bootB]) await mkdir(path)
    await installCrashProfile(repo, bootA)
    await installCrashProfile(repo, bootB)
    target = await ownedCrashInstance(repo)
    const owned = target
    observations['storeKey'] = owned.storeKey
    const patch = join(root, 'crash.cordis.yml')
    await writeFile(patch, JSON.stringify([{ id: 'session-persistence-mysql', config: { storeKey: owned.storeKey, ...settings } }]))
    observer = new Context()
    await observer.plugin(CredentialsLocal, { dshHome: join(root, 'observer-home'), watch: false })
    const ref = 'CRASH_' + randomUUID().replaceAll('-', '').toUpperCase()
    await owned.seedCredential(observer, ref)
    await observer.plugin(MysqlRuntime, owned.mysqlConfig(ref))
    await observer.plugin(MysqlSessionPersistence, { storeKey: owned.storeKey, ...settings })
    const persistence = observer.sessionPersistence
    if (!persistence) throw new Error('The independent real MySQL observer did not activate.')
    expect(await persistence.list()).toEqual([])
    model = await startMockLlmServer({ sequence: ['reasoning_success', 'stall', 'reasoning_success'],
      apiKey: 'owned-crash-dummy-key', successText: reply, reasoningText: 'Controlled HTTP/SSE crash inference.' })
    const server = model
    vi.stubEnv('DSH_EXAMPLE_MODE', 'lib')
    const launch = (cwd: string): LaunchedAcpTestAgent => launchAcpTestAgent({ cwd, configPath: patch,
      agent: { binScript: join(repo, 'apps/cli/src/bin.ts'), libBinScript: cli, profile: 'acp',
        configPath: join(repo, 'apps/cli/config/examples/mysql-session/base.cordis.yml'), tsconfigPath: join(repo, 'tsconfig.json') },
      env: { ...crashEnvironment(cwd), ...owned.environment(), DEEPSEEK_API_KEY: 'owned-crash-dummy-key', DEEPSEEK_BASE_URL: server.baseURL },
    })
    first = launch(bootA)
    phase = 'first built process and completed first turn'
    await crashDeadline(first.spawned, 'first process spawn')
    expect(first.child.spawnargs.slice(0, 2)).toEqual([process.execPath, cli])
    await crashDeadline(first.client.initialize({ protocolVersion: 1, clientCapabilities: {} }), 'first ACP initialization')
    const { sessionId } = await crashDeadline(first.client.newSession({ cwd: workspace, mcpServers: [] }), 'Native creation')
    const id = SessionId(sessionId)
    await crashDeadline(first.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'persist-before-crash 完整😀' }] }), 'completed first Native turn')
    await crashUntil(() => readCrashNative(persistence, id), log => log.events.some(event => event.type === 'turn/end' && event.data.turn === 1), 'durable first turn')
    let promptSettled = false
    stalled = first.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'leave-open-second-turn 完整😀' }] }).then(
      () => { promptSettled = true; return { ok: true } as const },
      (error: unknown) => { promptSettled = true; return { error } },
    )
    await crashUntil(async () => server.requests.length, count => count === 2, 'second real HTTP model request')
    const liveNative = await crashUntil(() => readCrashNative(persistence, id), log =>
      log.events.some(event => event.type === 'step/start' && event.data.turn === 2)
      && !log.events.some(event => event.type === 'turn/end' && event.data.turn === 2), 'durable open second turn')
    expect(promptSettled).toBe(false)
    expect(liveNative.header.id).toBe(id)
    expect(liveNative.header.version).toBe(SESSION_FORMAT_VERSION)
    expect(liveNative.header.cwd).toBe(workspace)
    expect(liveNative.inherited).toBe(0)
    expect(liveNative.events.some(event => event.type === 'request/header')).toBe(true)
    expect(liveNative.events.some(event => event.type === 'tool/call')).toBe(false)
    phase = 'actual heartbeat and live writer competition'
    const beforeHeartbeat = await crashSnapshot(owned.observer, owned.storeId)
    const renewed = await crashUntil(() => crashSnapshot(owned.observer, owned.storeId), saved =>
      saved.lease.expiresAt !== beforeHeartbeat.lease.expiresAt, 'actual database-clock heartbeat renewal')
    sameIdentity(beforeHeartbeat, renewed)
    // Native delivery acknowledgements may append during renewal; every earlier record remains an exact prefix.
    expect(renewed.events.slice(0, beforeHeartbeat.events.length)).toEqual(beforeHeartbeat.events)
    expect(renewed.receipts.slice(0, beforeHeartbeat.receipts.length)).toEqual(beforeHeartbeat.receipts)
    expect(renewed.events.slice(0, liveNative.events.length).map(event => parse(event.text))).toEqual(liveNative.events)
    expect(parse(renewed.metadata.headerText)).toEqual(liveNative.header)
    expect(renewed.lease.owner !== null).toBe(true)
    expect(renewed.lease.valid).toBe(true)
    expect(renewed.lease.fence).toBe(beforeHeartbeat.lease.fence)
    expect(renewed.lease.owner === beforeHeartbeat.lease.owner).toBe(true)
    continuous(renewed)
    await expect(persistence.open(id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    observations['heartbeatObserved'] = true
    const killedPid = first.child.pid
    phase = 'abrupt owned child exit and refusal before expiry'
    const exit = await crashOwnedChild(first)
    observations['crashedPid'] = killedPid
    observations['actualExit'] = exit
    expect(first.child.killed).toBe(true)
    expect(exit.signal === 'SIGKILL' || (exit.code !== null && exit.code !== 0)).toBe(true)
    const afterDeath = await crashSnapshot(owned.observer, owned.storeId)
    expect(afterDeath.lease.owner === renewed.lease.owner).toBe(true)
    expect(afterDeath.lease.valid).toBe(true)
    expect(afterDeath.lease.fence).toBe(renewed.lease.fence)
    expect(afterDeath.events.slice(0, renewed.events.length)).toEqual(renewed.events)
    expect(afterDeath.receipts.slice(0, renewed.receipts.length)).toEqual(renewed.receipts)
    await expect(persistence.open(id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await crashDeadline(first.close(), 'dead child stdio and ACP drain')
    firstClosed = true
    const interruptedPrompt = await crashDeadline(stalled, 'pending prompt rejection after abrupt child death')
    if (!('error' in interruptedPrompt)) throw new Error('The abruptly interrupted prompt falsely completed.')
    expectedCrashFailure = interruptedPrompt.error
    phase = 'freeze complete post-exit Native prefix and natural expiry'
    // Freeze only after the owned process, SDK callbacks, stdio and pending prompt have all settled.
    const prefix = await crashSnapshot(owned.observer, owned.storeId)
    const native = await readCrashNative(persistence, id)
    sameIdentity(renewed, prefix)
    expect(prefix.events.slice(0, renewed.events.length)).toEqual(renewed.events)
    expect(prefix.events.map(event => parse(event.text))).toEqual(native.events)
    expect(native.header).toEqual(liveNative.header)
    expect(native.events.some(event => event.type === 'step/start' && event.data.turn === 2)).toBe(true)
    expect(native.events.some(event => event.type === 'turn/end' && event.data.turn === 2)).toBe(false)
    expect(native.events.some(event => event.type === 'tool/call')).toBe(false)
    expect(prefix.lease.owner === afterDeath.lease.owner).toBe(true)
    expect(prefix.lease.fence).toBe(afterDeath.lease.fence)
    expect(prefix.lease.expiresAt).toBe(afterDeath.lease.expiresAt)
    observations['postExitPrefixEvents'] = prefix.events.length
    observations['postExitPrefixSha256'] = digest(prefix.events)
    const expired = await crashUntil(() => crashSnapshot(owned.observer, owned.storeId), saved => !saved.lease.valid, 'natural lease expiry according to UTC_TIMESTAMP(6)')
    expect(expired.lease.owner === prefix.lease.owner).toBe(true)
    expect(expired.lease.expiresAt).toBe(afterDeath.lease.expiresAt)
    expect(expired.lease.remainingMs !== null && expired.lease.remainingMs <= 0).toBe(true)
    expect(expired.lease.fence).toBe(prefix.lease.fence)
    expect(expired.events).toEqual(prefix.events)
    expect(expired.receipts).toEqual(prefix.receipts)
    observations['naturalExpiryFromDatabaseClock'] = true
    observations['oldFence'] = prefix.lease.fence
    const last = native.events.at(-1)
    const openStep = native.events.findLast(event => event.type === 'step/start' && event.data.turn === 2)
    if (!last || !openStep || openStep.type !== 'step/start') throw new Error('The actual crash prefix has no open second step.')
    const closers: SessionEvent[] = [
      { type: 'step/end', seq: SessionSeq(last.seq + 1), time: last.time, data: { turn: 2, step: openStep.data.step } },
      { type: 'turn/end', seq: SessionSeq(last.seq + 2), time: last.time, data: { turn: 2, reason: { kind: 'interrupted' } } },
    ]
    second = launch(bootB)
    phase = 'fresh built profile public resume and interrupted closers'
    await crashDeadline(second.spawned, 'new recovery process spawn')
    expect(second.child.pid === killedPid).toBe(false)
    expect(second.child.spawnargs.slice(0, 2)).toEqual([process.execPath, cli])
    await crashDeadline(second.client.initialize({ protocolVersion: 1, clientCapabilities: {} }), 'new ACP initialization')
    await crashDeadline(second.client.resumeSession({ sessionId, cwd: workspace, mcpServers: [] }), 'public Native resume after lease expiry')
    const resumed = await crashSnapshot(owned.observer, owned.storeId)
    sameIdentity(prefix, resumed)
    expect(BigInt(resumed.lease.fence) === BigInt(prefix.lease.fence) + 1n).toBe(true)
    expect(resumed.lease.owner !== null && resumed.lease.owner !== prefix.lease.owner).toBe(true)
    expect(resumed.lease.valid).toBe(true)
    expect(resumed.events.slice(0, prefix.events.length)).toEqual(prefix.events)
    const repairedSuffix = resumed.events.slice(prefix.events.length, prefix.events.length + closers.length)
    expect(repairedSuffix.map(event => parse(event.text))).toEqual(closers)
    expect(resumed.receipts.slice(0, prefix.receipts.length)).toEqual(prefix.receipts)
    const recovered = await readCrashNative(persistence, id)
    expect(recovered.header).toEqual(native.header)
    expect(recovered.inherited).toBe(native.inherited)
    expect(recovered.events.slice(0, native.events.length + closers.length)).toEqual([...native.events, ...closers])
    observations['recoveredPid'] = second.child.pid
    observations['newFence'] = resumed.lease.fence
    phase = 'continued third turn and normal shutdown'
    await crashDeadline(second.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'continue-after-natural-expiry 完整😀' }] }), 'continued Native turn in fresh process')
    await crashUntil(() => readCrashNative(persistence, id), log => log.events.some(event => event.type === 'turn/end' && event.data.turn === 3), 'durable continued third turn')
    await crashDeadline(second.close(), 'normal recovery process shutdown')
    secondClosed = true
    expect(second.child.exitCode).toBe(0)
    const final = await crashSnapshot(owned.observer, owned.storeId)
    sameIdentity(prefix, final)
    expect(final.events.slice(0, resumed.events.length)).toEqual(resumed.events)
    expect(final.receipts.slice(0, resumed.receipts.length)).toEqual(resumed.receipts)
    expect(final.lease.owner === null).toBe(true)
    expect(final.lease.fence).toBe(resumed.lease.fence)
    const finalNative = await readCrashNative(persistence, id)
    expect(finalNative.header).toEqual(native.header)
    expect(finalNative.events).toEqual(final.events.map(event => parse(event.text)))
    expect(finalNative.events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2, 3])
    expect(finalNative.events.filter(event => event.type === 'turn/end').map(event => [event.data.turn, event.data.reason.kind]))
      .toEqual([[1, 'completed'], [2, 'interrupted'], [3, 'completed']])
    expect(finalNative.events.filter(event => event.type === 'assistant/message').length).toBe(2)
    expect(finalNative.events.filter(event => event.type === 'assistant/message')
      .every(event => JSON.stringify(event.data.message).includes(reply))).toBe(true)
    continuous(final)
    expect(server.requests.map(request => request.behavior)).toEqual(['reasoning_success', 'stall', 'reasoning_success'])
    expect(server.requests[0]?.outcome).toBe('completed')
    expect(server.requests[1]?.outcome).toBe('stalled')
    expect(server.requests[2]?.outcome).toBe('completed')
    expect(JSON.stringify(server.requests[2]?.body).includes('persist-before-crash 完整😀')).toBe(true)
    expect(JSON.stringify(server.requests[2]?.body).includes(reply)).toBe(true)
    expect(JSON.stringify(server.requests[2]?.body).includes('leave-open-second-turn 完整😀')).toBe(true)
    expect(await owned.receipts()).toEqual(owned.before)
    phase = 'completed behavior'
    evidence = { serverUuid: crashServerUuid, upstreamPort: 11406, storeKey: owned.storeKey, schemaMode: 'verify', settings,
      model: 'controlled-real-loopback-HTTP-SSE; no external model', normalBuiltProfiles: true,
      crashedPid: killedPid, actualExit: exit, recoveredPid: second.child.pid, sessionId,
      activeWriterRefused: true, deadWriterBeforeExpiryRefused: true, heartbeatObserved: true,
      naturalExpiryFromDatabaseClock: true, expiryUnchangedAfterDeath: true,
      oldFence: prefix.lease.fence, newFence: resumed.lease.fence, exactSingleFenceIncrement: true,
      headerSha256: digest(native.header), originalPrefixSha256: digest(prefix.events),
      originalPrefixEvents: prefix.events.length,
      originalReceipts: prefix.receipts.length,
      recoveredClosers: closers.map(event => ({ type: event.type, seq: event.seq, time: event.time })),
      finalEvents: final.events.length, finalReceipts: final.receipts.length, completeNativePrefixPreserved: true,
      oldReceiptsUnchanged: true, contiguousSeqAndReceiptCoverage: true, pendingPromptRejected: true,
      oldStoreUntouched: true, observerSqlReadOnly: true, leaseReleasedAfterNormalRecoveryClose: true,
      schemaReceiptsUnchanged: true, excluded: ['mysqld restart', 'manual lease edits', 'DDL', 'tool execution', 'search watermark'] }
  } catch (error) { failures.push(error) }

  const clean = async (work: () => Promise<unknown>): Promise<void> => {
    try { await work() } catch (error) { failures.push(error) }
  }
  for (const [child, closed] of [[first, firstClosed], [second, secondClosed]] as const) {
    if (child && !closed) await clean(async () => {
      if (child.child.exitCode === null && child.child.signalCode === null) await crashOwnedChild(child)
      await crashDeadline(child.close(), 'owned child cleanup and stdio drain')
    })
  }
  if (stalled) await clean(async () => {
    const outcome = await crashDeadline(stalled, 'pending prompt cleanup')
    if ('error' in outcome && outcome.error !== expectedCrashFailure && !failures.includes(outcome.error)) failures.push(outcome.error)
  })
  if (observer) await clean(() => observer.fiber.dispose())
  if (model) await clean(() => model.close())
  if (target) await clean(() => target.observer.end())
  vi.unstubAllEnvs()
  for (const home of [bootA, bootB, join(root, 'observer-home')]) await clean(() => removeCrashHome(root, home))
  await clean(() => writeFile(join(root, 'outcome.json'), JSON.stringify({ phase, ...observations,
    outcome: failures.length === 0 ? 'passed' : 'failed',
    firstChildExited: !!first && (first.child.exitCode !== null || first.child.signalCode !== null),
    secondChildStarted: !!second, secondChildExited: !!second && (second.child.exitCode !== null || second.child.signalCode !== null),
    failures: failures.map(error => error instanceof Error ? error.name : typeof error),
    credentialHomesRemoved: [bootA, bootB, join(root, 'observer-home')].every(home => !existsSync(home)),
  }, null, 2) + '\n', { flag: 'wx' }))
  if (failures.length > 1) throw new AggregateError(failures, 'Process-crash recovery retained its original and cleanup failures.')
  if (failures.length === 1) throw failures[0]
  if (!evidence) throw new Error('The process-crash recovery scenario produced no complete evidence.')
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ ...evidence, allOwnedChildrenAndObserversClosed: true,
    credentialHomesRemoved: true, cleanupCompleted: true }, null, 2) + '\n', { flag: 'wx' })
  console.log('Owned MySQL process-crash evidence: ' + basename(root) + '/evidence.json')
})
