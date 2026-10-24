/** Real Native turns must retain their original login through model streaming and tool settlement. */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { imageNativeFixture } from './image-native-fixture.ts'
import { pptxEmployee } from '../../office/tests/pptx-office-fixture.ts'

async function replaceLogin(fixture: Awaited<ReturnType<typeof imageNativeFixture>>): Promise<void> {
  expect((await fixture.host.officeController.signOut()).ok).toBe(true)
  expect((await fixture.host.officeController.signIn({ memberId: pptxEmployee,
    password: 'Owned integration identity 2026!' })).ok).toBe(true)
}

it('withholds late model chunks after the original employee establishes a new login', async () => {
  const fixture = await imageNativeFixture({ image: false })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let closed = false
  const stream = vi.spyOn(fixture.adapter, 'stream').mockImplementation(async function* (): AsyncIterable<StreamChunk> {
    try {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'LEGALLY_DISCLOSED_PREFIX' }
      entered.resolve()
      await release.promise
      yield { type: 'text-delta', index: 0, text: 'PRIVATE_MODEL_AFTER_RELOGIN' }
      yield { type: 'block-end', index: 0, block: { type: 'text',
        text: 'LEGALLY_DISCLOSED_PREFIXPRIVATE_MODEL_AFTER_RELOGIN' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { closed = true }
  })
  const pending = fixture.run('unused-model-probe', {})
  const settled = Promise.allSettled([pending])
  try {
    await entered.promise
    await replaceLogin(fixture)
    release.resolve()
    const events = await pending
    expect(JSON.stringify(events)).toContain('LEGALLY_DISCLOSED_PREFIX')
    expect(JSON.stringify(events)).not.toContain('PRIVATE_MODEL_AFTER_RELOGIN')
    expect(closed).toBe(true)
  } finally { release.resolve(); await settled; stream.mockRestore() }
})

it('withholds an admitted tool result from the previous login while retaining its real completed file', async () => {
  const fixture = await imageNativeFixture({ image: false })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const path = join(fixture.root, 'admitted-native-output.txt')
  const marker = 'PRIVATE_TOOL_FROM_PREVIOUS_LOGIN'
  fixture.host.tools.register(defineTool({ name: 'native_login_file_probe', description: 'Write an admitted native fixture file',
    parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      await writeFile(path, 'ACTUAL_ADMITTED_NATIVE_FILE')
      entered.resolve()
      await release.promise
      return marker
    } }))
  const pending = fixture.run('native_login_file_probe', {})
  const settled = Promise.allSettled([pending])
  try {
    await entered.promise
    await replaceLogin(fixture)
    release.resolve()
    const events = await pending
    expect(await readFile(path, 'utf8')).toBe('ACTUAL_ADMITTED_NATIVE_FILE')
    expect(JSON.stringify(events)).not.toContain(marker)
    expect(JSON.stringify(fixture.adapter.requests)).not.toContain(marker)
    fixture.adapter.responses.splice(0)
    const resumed = await fixture.run('native_login_file_probe', {})
    expect(resumed.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(resumed.findLast(event => event.type === 'tool/result')).toMatchObject({ data: { message: { isError: false } } })
  } finally { release.resolve(); await settled }
})

it('keeps an unassociated Native model turn running across an Office credential replacement', async () => {
  const fixture = await imageNativeFixture({ image: false })
  const native = await fixture.host.agentLoop.create(SessionId(randomUUID()),
    { provider: 'image-integration-fixture', model: 'fixture' }, { cwd: join(fixture.root, 'workspace') })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const stream = vi.spyOn(fixture.adapter, 'stream').mockImplementation(async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    entered.resolve()
    await release.promise
    yield { type: 'text-delta', index: 0, text: 'UNASSOCIATED_NATIVE_COMPLETED' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'UNASSOCIATED_NATIVE_COMPLETED' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  native.followup(createUserMessage({ content: [{ type: 'text', text: 'An ordinary Native request.' }], source: { kind: 'user' } }))
  try {
    await entered.promise
    await replaceLogin(fixture)
    release.resolve()
    await native.whenIdle()
    await fixture.host.sessionPersistence.flush()
    const reader = await fixture.host.sessionPersistence.open(native.id, 'read')
    try {
      const events = (await reader.read()).events
      expect(JSON.stringify(events)).toContain('UNASSOCIATED_NATIVE_COMPLETED')
      expect(events.findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
    } finally { await reader.close() }
  } finally { release.resolve(); await native.whenIdle(); stream.mockRestore() }
})
