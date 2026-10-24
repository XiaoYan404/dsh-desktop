import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { LocalTerminalHandle } from '@deepseek-ai/dsh-subprocess-local/src/terminal.ts'
import type { ProcessInspector } from '@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts'
import {
  createWindowsProcessInspector,
  isInvalidHandle,
  windowsProcessTree,
  WindowsProcessInspector,
} from '@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts'
import type {
  NativePtr,
  ProcessEntry,
  WindowsProcessInspectorInternals,
  WindowsProcessState,
} from '@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

function fakeInternals() {
  const entries: ProcessEntry[] = []
  const states = new Map<number, WindowsProcessState>()
  const kills: Array<[number, boolean]> = []
  const counts = { enumerations: 0, stateReads: 0 }
  return {
    counts,
    internals: {
      snapshot: () => { counts.enumerations += 1; return [...entries] },
      processState: (pid) => { counts.stateReads += 1; return states.get(pid) },
      taskkill: (pid: number, force: boolean) => { kills.push([pid, force]) },
    } satisfies WindowsProcessInspectorInternals,
    add(entry: ProcessEntry, started?: string, active = true): void {
      entries.push(entry)
      if (started !== undefined) states.set(entry.pid, { started, active })
    },
    kills,
  }
}

describe('WindowsProcessInspector table enumeration', () => {
  it('enumerates the process table only for questions that need it', () => {
    const fake = fakeInternals()
    fake.add({ pid: 10, parentPid: 0 }, 't10')
    fake.add({ pid: 11, parentPid: 10 }, 't11')
    const inspector = new WindowsProcessInspector(fake.internals)

    // Liveness is a per-handle question on Windows, so a snapshot asked only
    // for liveness must not pay a Toolhelp32 walk. The terminal's Windows
    // teardown polls exactly this way, every 25 ms.
    const observed = inspector.snapshot()
    expect(observed.alive({ pid: 11, started: 't11' })).toBe(true)
    expect(fake.counts.enumerations).toBe(0)

    expect(observed.tree(10)).toHaveLength(2)
    expect(fake.counts.enumerations).toBe(1)

    // A second tree question reuses the same observation.
    observed.tree(10)
    expect(fake.counts.enumerations).toBe(1)
  })
})

describe('windowsProcessTree', () => {
  it('walks a table children-first with readable identities only', () => {
    const started = (pid: number): string | undefined => pid === 12 ? undefined : `t${pid}`
    expect(windowsProcessTree([
      { pid: 10, parentPid: 0 },
      { pid: 11, parentPid: 10 },
      { pid: 12, parentPid: 11 },
      { pid: 13, parentPid: 11 },
      { pid: 14, parentPid: 10 },
    ], 10, started)).toEqual([
      { pid: 13, started: 't13' },
      { pid: 11, started: 't11' },
      { pid: 14, started: 't14' },
      { pid: 10, started: 't10' },
    ])
  })

  it('returns an empty walk for an absent root', () => {
    expect(windowsProcessTree([{ pid: 10, parentPid: 0 }], 99, () => 't')).toEqual([])
  })

  it('terminates on a parent cycle instead of recursing forever', () => {
    const entries = [
      { pid: 10, parentPid: 11 },
      { pid: 11, parentPid: 10 },
    ]
    expect(windowsProcessTree(entries, 10, () => 't')).toHaveLength(2)
  })
})

describe('WindowsProcessInspector (injected internals)', () => {
  it('hides the default taskkill helper window for both termination tiers', () => {
    const taskkill = vi.mocked(nodeSpawnSync)
    taskkill.mockReturnValueOnce({} as never).mockReturnValueOnce({} as never)
    const inspector = createWindowsProcessInspector()
    inspector.signalGroup(77, 'SIGKILL')
    inspector.signalGroup(78, 'SIGTERM')
    expect(taskkill).toHaveBeenNthCalledWith(
      1,
      'taskkill',
      ['/PID', '77', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    )
    expect(taskkill).toHaveBeenNthCalledWith(
      2,
      'taskkill',
      ['/PID', '78', '/T'],
      { stdio: 'ignore', windowsHide: true },
    )
  })

  it('exposes the shell pid as the pseudo foreground group and never proves stdin waits', () => {
    const fake = fakeInternals()
    const inspector = new WindowsProcessInspector(fake.internals)
    expect(inspector.foregroundPgid(77)).toBe(77)
    expect(inspector.isStdinWaiting(77, 10)).toBe(false)
    expect(inspector.snapshot().session(77)).toEqual([])
  })

  it('delegates tree walks and identity checks to the internals', () => {
    const fake = fakeInternals()
    fake.add({ pid: 10, parentPid: 0 }, 't10')
    fake.add({ pid: 11, parentPid: 10 }, 't11')
    const inspector = new WindowsProcessInspector(fake.internals)
    expect(inspector.snapshot().tree(10)).toEqual([
      { pid: 11, started: 't11' },
      { pid: 10, started: 't10' },
    ])
    expect(inspector.isAlive({ pid: 11, started: 't11' })).toBe(true)
    expect(inspector.isAlive({ pid: 11, started: 'stale' })).toBe(false)
    expect(inspector.isAlive({ pid: 99, started: 't99' })).toBe(false)

    fake.add({ pid: 12, parentPid: 10 }, 't12', false)
    expect(inspector.isAlive({ pid: 12, started: 't12' })).toBe(false)
  })

  it('maps SIGKILL to a forced taskkill and other signals to the grace form', () => {
    const fake = fakeInternals()
    const inspector = new WindowsProcessInspector(fake.internals)
    inspector.signalGroup(77, 'SIGKILL')
    inspector.signalGroup(77, 'SIGTERM')
    inspector.signalGroup(0, 'SIGKILL')
    expect(fake.kills).toEqual([[77, true], [77, false], [0, true]])
  })

  it('signals a process only while its start identity matches', () => {
    const fake = fakeInternals()
    fake.add({ pid: 10, parentPid: 0 }, 't10')
    fake.add({ pid: 11, parentPid: 10 }, 't11', false)
    const inspector = new WindowsProcessInspector(fake.internals)
    inspector.signalProcess({ pid: 10, started: 't10' }, 'SIGKILL')
    inspector.signalProcess({ pid: 11, started: 't11' }, 'SIGKILL')
    inspector.signalProcess({ pid: 10, started: 'stale' }, 'SIGTERM')
    expect(fake.kills).toEqual([[10, true]])
  })

  it('accepts an injected internals factory through the creator', () => {
    const fake = fakeInternals()
    expect(createWindowsProcessInspector(fake.internals)).toBeInstanceOf(WindowsProcessInspector)
    expect(createWindowsProcessInspector()).toBeInstanceOf(WindowsProcessInspector)
  })
})

describe('isInvalidHandle', () => {
  it('rejects null, zero, and the all-ones INVALID_HANDLE_VALUE forms', () => {
    const ptr = (value: bigint): NativePtr => value as NativePtr
    expect(isInvalidHandle(null)).toBe(true)
    expect(isInvalidHandle(undefined)).toBe(true)
    expect(isInvalidHandle(ptr(0n))).toBe(true)
    expect(isInvalidHandle(ptr(0xFFFFFFFFFFFFFFFFn))).toBe(true)
    expect(isInvalidHandle(ptr(-1n))).toBe(true)
    expect(isInvalidHandle(ptr(1234n))).toBe(false)
  })
})

const win32 = process.platform === 'win32' ? describe : describe.skip

it('latches a delayed Windows PTY PID for cleanup and never adopts a PID after exit', async () => {
  let data: ((value: string) => void) | undefined
  let exited: ((event: { exitCode: number; signal?: number }) => void) | undefined
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'pwsh', handleFlowControl: false,
    onData: (listener: (value: string) => void) => { data = listener; return { dispose: () => { data = undefined } } },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exited = listener
      return { dispose: () => { exited = undefined } }
    },
    pause: vi.fn(), resume: vi.fn(), resize: vi.fn(), write: vi.fn(), clear: vi.fn(),
    kill: vi.fn(() => { exited?.({ exitCode: 0 }) }),
  } satisfies IPty
  const identity = { pid: 123, started: 'original-shell' }
  let alive = true
  const signal = vi.fn(() => { alive = false })
  const inspector: ProcessInspector = {
    snapshot: () => ({
      tree: pid => alive && pid === identity.pid ? [identity] : [], session: () => [], complete: true,
      alive: member => alive && member.pid === identity.pid && member.started === identity.started,
    }),
    foregroundPgid: pid => pid, isStdinWaiting: () => false,
    isAlive: member => alive && member.pid === identity.pid && member.started === identity.started,
    signalGroup: vi.fn(), signalProcess: signal,
  }
  const handle = new LocalTerminalHandle(pty, inspector, 5, 'win32')
  expect(handle.pid).toBe(0)
  pty.pid = 123
  data?.('PS ready')
  expect(handle.pid).toBe(123)
  pty.pid = 999
  expect(handle.pid).toBe(123)
  await handle.terminate()
  expect(signal).toHaveBeenCalledWith(identity, 'SIGTERM')
  expect(pty.kill).not.toHaveBeenCalled()
  pty.pid = 0
  const finished = new LocalTerminalHandle(pty, inspector, 5, 'win32')
  pty.pid = 456
  exited?.({ exitCode: 0 })
  expect(finished.pid).toBe(0)
  await finished.terminate()
  expect(signal).toHaveBeenCalledTimes(1)
})

win32('WindowsProcessInspector over the real koffi bindings', () => {
  it('keeps independent module evaluations usable over the same native type registry', async () => {
    const first = createWindowsProcessInspector()
    const self = first.snapshot().tree(process.pid).find(member => member.pid === process.pid)
    expect(self).toBeDefined()
    vi.resetModules()
    const copy = await import('@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts')
    const second = copy.createWindowsProcessInspector()
    expect(second.snapshot().tree(process.pid).find(member => member.pid === process.pid)).toEqual(self)
    expect(first.isAlive(self!)).toBe(true)
    expect(second.isAlive(self!)).toBe(true)
  })

  it('walks the live process table from the test runner itself', () => {
    const inspector = createWindowsProcessInspector()
    const tree = inspector.snapshot().tree(process.pid)
    const self = tree.find(member => member.pid === process.pid)
    expect(self).toBeDefined()
    expect(inspector.snapshot().alive(self!)).toBe(true)
    expect(inspector.foregroundPgid(process.pid)).toBe(process.pid)
  })

  it('reports unreadable identities for absent processes and no-ops tree signalling', () => {
    const inspector = createWindowsProcessInspector()
    expect(inspector.isAlive({ pid: 0x7FFFFFFF, started: 'absent' })).toBe(false)
    expect(() => { inspector.signalGroup(0x7FFFFFFF, 'SIGKILL') }).not.toThrow()
    expect(() => { inspector.signalGroup(0x7FFFFFFF, 'SIGTERM') }).not.toThrow()
    expect(() => { inspector.signalGroup(0, 'SIGKILL') }).not.toThrow()
    expect(() => { inspector.signalProcess({ pid: 0x7FFFFFFF, started: 'absent' }, 'SIGKILL') }).not.toThrow()
  })
})
