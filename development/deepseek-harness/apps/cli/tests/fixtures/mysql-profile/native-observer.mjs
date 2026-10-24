/** Test-only evidence through ordinary profile resolution; this observer never writes SQL. */
import { writeFileSync } from 'node:fs'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'

export const name = 'mysql-profile-observer'
export const inject = ['sessions', 'mysql', 'sessionPersistence']

export function apply(ctx, config) {
  const records = new Map()
  const modules = Object.fromEntries(['@deepseek-ai/dsh-mysql', '@deepseek-ai/dsh-session-persistence-mysql']
    .map(name => [name, import.meta.resolve(name)]))
  const emit = () => writeFileSync(config.evidenceFile, JSON.stringify({
    pid: process.pid, execArgv: process.execArgv, modules, records: [...records.values()],
  }) + '\n', { mode: 0o600 })
  ctx.effect(function* () {
    yield ctx.on('session/event', (session, event) => {
      const record = records.get(session.id)
      if (!record) return
      if (event.seq !== record.events.length) throw new Error('Native observer received a noncontiguous event.')
      record.events.push(structuredClone(event))
      emit()
    })
    yield ctx.on('session/created', session => {
      records.set(session.id, { header: structuredClone(session.header), events: structuredClone(session.snapshotEvents()) })
      appendPluginRecord(session, 'plugin:mysql-profile/evidence', { phase: config.phase, text: 'complete Native 插件😀' })
      emit()
    })
  }, 'mysql-profile.test-evidence')
}
