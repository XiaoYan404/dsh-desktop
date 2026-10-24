/** Test-only Native producers loaded by the ordinary built acp profile. */
import { writeFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Stable test plugin identity. */
export const name = 'mysql-corpus-producer'
/** Real services required before the ACP input is admitted. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'goals', 'subagents', 'sessionTitle']

/**
 * Drive one real root turn, its post-turn domain changes, and a real local child.
 * @param {import('@deepseek-ai/cordis').Context} ctx - caller-owned plugin scope.
 * @param {{ evidenceFile: string }} config - exclusively owned evidence path.
 */
export function apply(ctx, config) {
  const records = new Map()
  const failures = []
  const controller = new AbortController()
  let root
  let activation
  let producing
  let postTurnStarted = false
  const statuses = []
  const emit = () => writeFileSync(config.evidenceFile, JSON.stringify({
    pid: process.pid, execArgv: process.execArgv,
    llmModule: import.meta.resolve('@deepseek-ai/dsh-llm'),
    statuses, postTurnStarted, childId: activation?.childId,
    failures: failures.map(error => error instanceof Error ? error.name : 'NonErrorFailure'),
    records: [...records.values()],
  }) + '\n', { mode: 0o600 })
  const afterTurn = async (agent) => {
    // Pause synchronously before another lifecycle edge can arm continuation.
    const goal = ctx.goals.create(agent, { objective: 'Observe this isolated MySQL corpus', maxGoalRounds: 1 })
    ctx.goals.pause(agent, { id: goal.id, revision: goal.revision })
    agent.inject(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'mysql-corpus-inbox 完整😀' }] }))
    ctx.sessionTitle.rename(agent.session, 'MySQL corpus 完整😀')
    await ctx.sessions.flush(agent.session)
    controller.signal.throwIfAborted()
    activation = await ctx.subagents.startActivation({ provider: 'spawn', label: 'MySQL corpus child',
      request: { parent: agent, prompt: [{ type: 'text', text: 'Return the deterministic child answer.' }] },
      signal: controller.signal, delivery: 'caller' })
    emit()
    const result = await activation.result
    if (result.stopReason !== 'completed') throw new Error('The real corpus child did not finish its model turn.')
    emit()
  }
  ctx.effect(function* () {
    yield ctx.on('session/created', (session) => {
      records.set(session.id, { header: structuredClone(session.header), events: structuredClone(session.snapshotEvents()) })
      emit()
    })
    yield ctx.on('session/event', (session, event) => {
      const record = records.get(session.id)
      if (!record) throw new Error('A Native corpus event preceded its Session creation.')
      if (record.events.length !== event.seq) throw new Error('The Native corpus prefix is not contiguous.')
      record.events.push(structuredClone(event))
      emit()
    })
    yield ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession !== undefined) return
      if (root) throw new Error('The corpus fixture accepts exactly one root Agent.')
      root = agent
      // The ACP client already connected and initialized before session/new.
      // AgentLoop holds this input until all serial creation listeners settle.
      agent.followup(createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: 'Keep the first real request open until the ACP client cancels it.' }] }))
    })
    yield ctx.on('agent/status', ({ agent, status }) => {
      if (agent !== root) return
      statuses.push(status)
      emit()
      if (status !== 'idle' || postTurnStarted) return
      postTurnStarted = true
      producing = afterTurn(agent).catch((error) => { failures.push(error); emit() })
    })
    yield async () => {
      controller.abort(new Error('The owned corpus producer is closing.'))
      if (producing) await producing
      if (activation) {
        try { await activation.dispose() }
        catch (error) { failures.push(error) }
      }
      // This is the complete prefix observed while this scope was live. The
      // independent SQL reader verifies any later Native disposal records too.
      emit()
      if (failures.length) throw new AggregateError(failures, 'Native corpus production or cleanup failed.')
    }
  }, 'mysql-corpus.native-producers')
  ctx.provide('mysqlCorpusProducer', { ready: true })
}
