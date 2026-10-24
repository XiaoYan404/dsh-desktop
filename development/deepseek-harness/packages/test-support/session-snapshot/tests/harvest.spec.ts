/** Backend-independent collection preserves durable artifacts and settles every read handle. */

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { harvestSessionLogs, type SessionLogPersistence } from '../src/harvest.ts'
import { runScenario, type AgentUnderTest } from '../src/harness.ts'

interface Observation {
  opened: number
  closed: number
  reads: number
  readError?: Error
  closeError?: Error
}

function observe(persistence: SessionPersistence, state: Observation): SessionLogPersistence {
  return {
    async list(options) { return [...await persistence.list(options)].reverse() },
    async open(id, access, options): Promise<SessionHandle> {
      expect(access).toBe('read')
      const handle = await persistence.open(id, access, options)
      state.opened++
      const close = async (): Promise<void> => {
        state.closed++
        await handle.close()
        if (state.closeError !== undefined) throw state.closeError
      }
      return {
        id: handle.id,
        header: handle.header,
        inheritedEventCount: handle.inheritedEventCount,
        access: handle.access,
        async read(...args) {
          state.reads++
          if (state.readError !== undefined) throw state.readError
          const result = await handle.read(...args)
          return {
            ...result,
            // SQL JSON may return another key order; durable wait records must remain type-first.
            events: result.events.map(event => Object.fromEntries(Object.entries(event).toReversed()) as SessionEvent),
          }
        },
        append: handle.append.bind(handle),
        flush: handle.flush.bind(handle),
        close,
        [Symbol.asyncDispose]: close,
      }
    },
  }
}

function restore(content: string) {
  const [header, ...events] = content.trim().split('\n').map(line => JSON.parse(line) as unknown)
  const decoder = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const event of events) decoder.decodeRow(event)
  return decoder.finish()
}

it('collects raw JSONL and live persistence with the same full history and closes failed reads', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-harvest-provider-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      // This directory is the unique mkdtemp result allocated by this test.
      await rm(root, { recursive: true, force: true })
    }
  })
  const storageRoot = join(root, 'sessions')
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot, compression: 'none' })
  const persistence = ctx.sessionPersistence
  const parent: SessionHeader = {
    id: SessionId('harvest-parent'), version: SESSION_FORMAT_VERSION, createdAt: 300,
    isSeeded: false, delegationDepth: 0,
  }
  const rows = [
    { type: 'plugin:harvest/opaque', ignorable: true, data: { text: '归档 Ω', nested: { retained: true } } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', surfaceOp: 'append', data: {
      turn: 1, step: 1, message: { id: 'system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'System' }] },
    } },
    { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'test', model: 'test' } } } },
    { type: 'user/message', surfaceOp: 'append', sourceEventSeqs: [0, 1], data: {
      id: 'user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Retain everything' }],
    } },
    { type: 'assistant/message', surfaceOp: 'append', data: {
      turn: 1, step: 1,
      message: { id: 'answer', role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'text', text: '你好 Ω' }] },
      stream: [
        { type: 'chunk', time: 10, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: 10, index: 0, dt: [2], texts: ['你好', ' Ω'] },
        { type: 'chunk', time: 12, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: '你好 Ω' } } },
        { type: 'chunk', time: 12, chunk: { type: 'finish', reason: { kind: 'stop' } } },
      ],
    } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: 1000 + seq }))
  // Native JSONL admission validates this durable JSON payload, including the opaque record.
  const events = JSON.parse(JSON.stringify(rows)) as SessionEvent[]
  const parentWriter = await persistence.create(parent)
  try {
    await parentWriter.append(events)
  } finally {
    await parentWriter.close()
  }
  for (const id of ['harvest-child-b', 'harvest-child-a']) {
    const child = await persistence.create({
      ...parent, id: SessionId(id), parentSession: parent.id, createdAt: 100, isSeeded: true,
      origin: 'subagent', delegationDepth: 1,
    }, { inheritedEventCount: SessionLogOffset(events.length) })
    try {
      const seed = JSON.parse(JSON.stringify([
        ...events, { type: 'session/end-seed', seq: events.length, time: 1100, data: { inherited: true } },
      ])) as SessionEvent[]
      await child.append(seed)
    } finally {
      await child.close()
    }
  }

  const raw = await harvestSessionLogs(storageRoot)
  expect(raw.map(log => log.id)).toEqual(['harvest-parent', 'harvest-child-a', 'harvest-child-b'])
  const names = await readdir(storageRoot, { recursive: true })
  const currentPath = names.find(name => name.endsWith(`harvest-parent/session.v${SESSION_FORMAT_VERSION}.jsonl`)
    || name.endsWith(`harvest-parent\\session.v${SESSION_FORMAT_VERSION}.jsonl`))
  if (currentPath === undefined) throw new Error('The test writer did not materialize its parent artifact')
  const parentPath = join(storageRoot, currentPath)
  expect(raw[0]?.content).toBe(await readFile(parentPath, 'utf8'))
  const historicalPath = join(dirname(parentPath), 'session.jsonl')
  const historical = '{"type":"session","version":0,"id":"harvest-parent","createdAt":1}\n'
  await writeFile(historicalPath, historical)
  expect(await harvestSessionLogs(storageRoot)).toEqual(raw)
  const state: Observation = { opened: 0, closed: 0, reads: 0 }
  const observer = observe(persistence, state)
  const collected = await harvestSessionLogs(observer)
  expect(collected.map(log => log.id)).toEqual(raw.map(log => log.id))
  expect(collected.map(log => restore(log.content))).toEqual(raw.map(log => restore(log.content)))
  expect(restore(collected[1]!.content).inheritedEventCount).toBe(events.length)
  const restored = restore(collected[0]!.content)
  expect(restored.events).toEqual(events)
  expect(restored.events[5]?.['sourceEventSeqs']).toEqual([0, 1])
  expect(restored.events[0]?.data).toEqual(rows[0]?.data)
  expect(collected[0]?.content).toContain('\n{"type":"turn/end",')

  // The child has no JSONL logs; final collection must use the explicitly selected observer.
  const fixtureFile = join(root, 'scenario', 'session.jsonl')
  await mkdir(dirname(fixtureFile))
  await writeFile(join(dirname(fixtureFile), 'behavior.json'), '{}')
  const fakeAgent = fileURLToPath(new URL('./fixtures/fake-acp-agent.ts', import.meta.url))
  const agent: AgentUnderTest = {
    binScript: fakeAgent, libBinScript: fakeAgent, configPath: fakeAgent,
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
  }
  const result = await runScenario({ steps: [{ op: 'initialize' }] }, {
    agent, mode: 'replay', fixtureFile, sessionPersistence: observer,
  })
  expect(result.sessionLogs.map(log => restore(log.content))).toEqual(raw.map(log => restore(log.content)))
  expect(state.closed).toBe(state.opened)
  expect(state.reads).toBe(state.opened)

  const readError = new Error('observer read failed')
  const closeError = new Error('observer close failed')
  for (const fault of [{ readError }, { closeError }, { readError, closeError }]) {
    const failed: Observation = { opened: 0, closed: 0, reads: 0, ...fault }
    const outcome = await harvestSessionLogs(observe(persistence, failed)).catch((error: unknown) => error)
    if ('readError' in fault && 'closeError' in fault) {
      expect(outcome).toBeInstanceOf(AggregateError)
      if (!(outcome instanceof AggregateError)) throw new Error('Both failures must remain observable')
      expect(outcome.errors).toEqual([readError, closeError])
    } else {
      expect(outcome).toBe('readError' in fault ? readError : closeError)
    }
    expect(failed.opened).toBe(1)
    expect(failed.closed).toBe(1)
  }
  expect(await readFile(historicalPath, 'utf8')).toBe(historical)
  expect(await readFile(parentPath, 'utf8')).toBe(raw[0]?.content)
})
