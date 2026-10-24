/** Real Office authority and Loader-composed terminals with a delayed, test-owned process allocation. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import TerminalController from '@deepseek-ai/dsh-api-terminal-controller'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessOutcome, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { nativeJobsFixture } from './native-jobs-harness.host.ts'

class DelayedTerminalRuntime extends LocalSubprocess {
  readonly allocated = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  handle: SubprocessTerminalHandle | undefined
  terminations = 0
  private closing: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.release.resolve(undefined)
      await this.handle?.terminate()
    }, 'native-terminal-allocation.fixture')
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.handle !== undefined) throw new Error('Fixture already allocated its process')
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ALLOCATION_READY\\n');process.stdin.resume()"], {
      cwd: spec.cwd, env: scrubbedParentEnv(), windowsHide: true, stdio: 'pipe',
    })
    const completion = Promise.withResolvers<SubprocessOutcome>()
    child.once('error', completion.reject)
    child.once('close', (exitCode, signal) => { completion.resolve({ exitCode, signal }) })
    await once(child, 'spawn')
    const pid = child.pid
    if (pid === undefined) throw new Error('Fixture process has no identity')
    this.handle = {
      pid, output: child.stdout, done: completion.promise,
      write: async (data) => { await new Promise<void>((resolve, reject) => {
        child.stdin.write(data, (error) => { if (error) reject(error); else resolve() })
      }) },
      resize: async () => {},
      inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
      inspectForeground: async () => undefined,
      signalForeground: async () => { throw new Error('Fixture has no foreground terminal group') },
      terminate: () => {
        this.closing ??= (async () => {
          if (child.exitCode === null && child.signalCode === null) {
            this.terminations++
            child.kill()
          }
          await completion.promise
        })()
        return this.closing
      },
    }
    // The external allocator may finish after cancellation; the consumer still owns the returned process.
    await once(child.stdout, 'data')
    this.allocated.resolve(undefined)
    await this.release.promise
    return this.handle
  }
}

/** @returns Actual Office HTTP/SQLite authority and a terminal allocator with an explicit settlement barrier. */
export async function nativeTerminalFixture() {
  const fixture = await nativeJobsFixture('manager')
  const { ctx } = fixture
  const baseUrl = ctx.baseUrl
  if (baseUrl === undefined) throw new Error('Native terminal fixture has no Loader base URL')
  const cwd = fileURLToPath(baseUrl)
  Object.assign(ctx.loader.builtins, {
    'fixture-terminal-fs': FileSystem,
    'fixture-terminal-prompt': SystemPrompt,
    'fixture-terminal-directory': WorkingDirectory,
    'fixture-terminal-policy': SandboxPolicy,
    'fixture-terminal-runtime': DelayedTerminalRuntime,
    'fixture-terminal-controller': TerminalController,
  })
  for (const entry of [
    { name: 'fixture-terminal-fs', config: { cwd } },
    { name: 'fixture-terminal-prompt' },
    { name: 'fixture-terminal-directory', config: { defaultDirectory: cwd } },
    { name: 'fixture-terminal-policy', config: { defaultMode: 'danger-full-access', workspaceRoot: cwd } },
    { name: 'fixture-terminal-runtime' },
    { name: 'fixture-terminal-controller', config: {
      shell: { path: process.execPath, name: 'Fixture process', args: [] }, unattendedTimeoutMs: 0,
    } },
  ]) await ctx.loader.create({ ...entry, name: `cordis:${entry.name}` })
  await ctx.loader.await()
  const runtime = ctx.get('subprocess')
  if (!(runtime instanceof DelayedTerminalRuntime) || ctx.get('terminalController') === undefined) {
    throw new Error('Native terminal Loader composition did not activate')
  }
  return { ...fixture, runtime, cwd }
}
