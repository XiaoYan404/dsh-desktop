/** Real CLI, TypeScript and Python SDK compatibility with an optional office service and cold Session recovery. */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished } from 'vitest'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const bin = join(repo, 'apps/cli/lib/bin.js')
const pythonDriver = fileURLToPath(new URL('./fixtures/enterprise-client.py', import.meta.url))
const firstReply = 'SDK_FIRST_TURN_COMPLETE'
const secondReply = 'SDK_RESTORED_TURN_COMPLETE'
const bytes = 'SDK_NATIVE_BYTES\n真实文件内容。\n'

interface ModelRequest { tools?: { name: string }[]; messages?: unknown[] }
interface ObservedRun { sessionId: string; finalResponse: string; events: SessionEvent[]; cwd: string }

/** Frame an actual Messages-protocol response; only model inference is controlled. */
function response(text: string, tool?: { path: string }): string {
  const block = tool === undefined ? { type: 'text', text: '' }
    : { type: 'tool_use', id: 'sdk-native-write', name: 'write', input: {} }
  const delta = tool === undefined ? { type: 'text_delta', text }
    : { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: tool.path, content: bytes }) }
  return [
    { type: 'message_start', message: { id: 'sdk-compat-response', model: 'deepseek-v4-flash', usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool === undefined ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

describe.each(['typescript', 'python'] as const)('public %s SDK through the CLI profile', (language) => {
  it.each([false, true])('executes real file tools and restores a Session after closing (office=%s)', async (office) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh sdk office '))
    const home = join(root, 'home')
    const workspace = join(root, '工作目录 with spaces')
    const output = join(workspace, '生成文件.txt')
    const sessionId = 'sdk-compat-session'
    const requests: ModelRequest[] = []
    const failures: string[] = []
    const server = createServer((request, reply) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        try {
          requests.push(JSON.parse(body) as ModelRequest)
          reply.writeHead(200, { 'content-type': 'text/event-stream' })
          reply.end(requests.length === 1 ? response('', { path: output })
            : response(requests.length === 2 ? firstReply : secondReply))
        } catch (error) {
          failures.push(String(error))
          reply.writeHead(500)
          reply.end()
        }
      })
    })
    onTestFinished(async () => {
      if (server.listening) await new Promise<void>((done) => { server.close(() => { done() }); server.closeAllConnections() })
      const target = resolve(root)
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('dsh sdk office ')) throw new Error('Unexpected SDK fixture cleanup root')
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    await mkdir(workspace)
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('SDK fixture has no listener')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const patch = join(root, '企业配置.json')
    await writeFile(patch, JSON.stringify([
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      ...(office ? [{ insert: [{
        id: 'enterprise-office', name: pathToFileURL(join(repo, 'packages/enterprise/office/lib/index.js')).href,
        config: { companyName: 'SDK integration company', timeZone: 'Asia/Shanghai', members: [
          { id: 'admin', name: 'SDK admin', department: 'Operations', jobTitle: 'Admin', role: 'admin' },
          { id: 'employee', name: 'SDK employee', department: 'Operations', jobTitle: 'Employee', role: 'employee' },
        ] },
      }] }] : []),
    ]))
    const env = {
      ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access', DSH_TOOLS_MODE: 'native',
      DSH_PRIMARY_RUNTIME: '', DEEPSEEK_API_KEY: 'sdk-compat-local-fixture', DEEPSEEK_BASE_URL: baseUrl,
      PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: [join(repo, 'python/sdk/src'), join(repo, 'python/sdk-runtime/src')].join(delimiter),
    }
    const run = async (prompt: string): Promise<ObservedRun> => {
      if (language === 'python') {
        const config = join(root, 'python-options.json')
        await writeFile(config, JSON.stringify({ bin, home, workspace, patches: [patch], sessionId, prompt, baseUrl }))
        const child = await execa('python', [pythonDriver, config], { cwd: repo, env, timeout: 45_000 })
        return JSON.parse(child.stdout) as ObservedRun
      }
      const harness = new DeepSeekHarness({
        dshBin: bin, dshHome: home, cwd: workspace, patches: [patch], provider: 'deepseek-official',
        model: 'deepseek-v4-flash', env, initializeTimeoutMs: 20_000, requestTimeoutMs: 30_000,
      })
      try {
        const session = harness.session(sessionId)
        const result = await session.run(prompt)
        const cwd = await session.getWorkingDirectory()
        return { ...result, cwd }
      } finally { await harness.close() }
    }
    const first = await run('Create the native SDK acceptance file.')
    expect(first).toMatchObject({ sessionId, cwd: workspace, finalResponse: firstReply })
    expect(first.events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['write'])
    const results = first.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data.message.isError).toBe(false)
    expect(await readFile(output, 'utf8')).toBe(bytes)
    expect(requests[0]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'skill']))
    const storageRoot = join(home, 'storages')
    const officeFiles = (await readdir(storageRoot)).filter(name => name.startsWith('enterprise_office'))
    expect(officeFiles.length > 0).toBe(office)
    const officeBefore = await Promise.all(officeFiles.map(name => readFile(join(storageRoot, name), 'utf8')))
    if (office) expect(officeBefore.join('')).toContain('SDK integration company')
    const second = await run('Continue the existing SDK acceptance session.')
    expect(second).toMatchObject({ sessionId, cwd: workspace, finalResponse: secondReply })
    expect(second.events.filter(event => event.type === 'tool/call')).toEqual([])
    expect(requests).toHaveLength(3)
    const recovered = JSON.stringify(requests[2]?.messages)
    expect(recovered).toContain('Create the native SDK acceptance file.')
    expect(recovered).toContain(firstReply)
    expect(recovered).toContain('Continue the existing SDK acceptance session.')
    expect(await readFile(output, 'utf8')).toBe(bytes)
    expect(await Promise.all(officeFiles.map(name => readFile(join(storageRoot, name), 'utf8')))).toEqual(officeBefore)
    const profile = JSON.parse(await readFile(join(home, 'profiles/sdk/package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(profile.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'])
    expect(failures).toEqual([])
  }, 90_000)
})
