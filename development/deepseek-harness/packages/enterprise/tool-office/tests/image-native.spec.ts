/** New formal-composition image behavior; no staged green or capped compatibility suite is repeated. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { imageNativeFixture } from './image-native-fixture.ts'
import { pptxAdministrator as admin } from '../../office/tests/pptx-office-fixture.ts'

it('registers synchronously and manually approves the real central HTTP image into durable Native history and the next model request', async () => {
  const subject = await imageNativeFixture()
  const { central, host, agent, adapter, reviews, info } = subject
  const reads = vi.spyOn(central.office, 'readConversationImage')
  const events = await subject.run()
  const result = events.findLast(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('Native image tool did not settle')
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_image')
  expect(reviews).toHaveLength(1)
  expect(reviews[0]).toContain('Read submitted company image\n')
  expect(reviews[0]).toContain(`Version: ${JSON.stringify(info.versionId)}\nSHA-256: ${info.sha256}`)
  expect(events.some(event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once')).toBe(true)
  expect(result.data.message.isError).toBe(false)
  const image = result.data.message.content.find(block => block.type === 'image')
  if (image?.type !== 'image') throw new Error('Actual Native ImageBlock missing')
  const stored = await host.attachments.readImage(image.attachment)
  expect(stored.data.byteLength).toBe(image.attachment.bytes)
  const normalizedDigest = createHash('sha256').update(stored.data).digest('hex')
  expect(`sha256:${normalizedDigest}`).toBe(image.attachment.attachmentId)
  expect(JSON.stringify(result.data.message.content)).toContain(info.sha256)
  expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
  expect(reads.mock.calls.map(call => call[1].kind)).toEqual(['read', 'recheck'])
  expect(host.tools.get('office_read_image', agent)).toBeUndefined()
  expect(host.bail('office/image-reader-enabled')).toBe(true)
  await writeFile(new URL('../../../../.artifacts/parallel-handoff/02/image-native-evidence.json', import.meta.url),
    JSON.stringify({ node: process.version, sourceBytes: subject.bytes.length, sourceDigest: info.sha256,
      normalizedBytes: image.attachment.bytes, normalizedDigest, manualReview: true, allowedOnceEvent: true,
      authorityOperations: reads.mock.calls.map(call => call[1].kind), durableImage: true,
      nextControlledModelRequestMatches: true, registeredSynchronously: true, toolRemovedAtTurnEnd: true,
      real: ['Loader', 'central JSON Office', 'loopback HTTP Gateway', 'employee Host BFF', 'Native approval service',
        'AttachmentStore.saveImage', 'JSONL tool/result', 'next model request'],
      controlled: ['model inference', 'human approval answer'], formalBuild: false, realPageAcceptance: false }, null, 2) + '\n')
})

it.each(['default-off', 'review-rejected', 'text-model', 'hard-result-limit'] as const)(
  'enforces registered image consumer admission before publication (%s)', async (mode) => {
    const subject = await imageNativeFixture({ image: mode !== 'default-off', allow: mode !== 'review-rejected',
      modelImage: mode !== 'text-model', ...(mode === 'hard-result-limit' ? { maxResultBytes: 1 } : {}) })
    const reads = vi.spyOn(subject.central.office, 'readConversationImage')
    const saves = vi.spyOn(subject.host.attachments, 'saveImage')
    const events = await subject.run()
    const result = events.findLast(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Rejected image call did not settle')
    expect(result.data.message.isError).toBe(true)
    expect(result.data.message.content.some(block => block.type === 'image')).toBe(false)
    if (mode === 'default-off') expect(subject.adapter.requests[0]?.tools?.map(tool => tool.name)).not.toContain('office_read_image')
    else expect(subject.adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('office_read_image')
    expect(reads.mock.calls.map(call => call[1].kind)).toEqual(mode === 'hard-result-limit' ? ['read'] : [])
    expect(saves).toHaveBeenCalledTimes(mode === 'hard-result-limit' ? 1 : 0)
  })

it('denies a new image after ancestor withdrawal while retaining the earlier legally disclosed image log prefix', async () => {
  const subject = await imageNativeFixture()
  const before = await subject.run()
  const first = before.findLast(event => event.type === 'tool/result')
  if (first?.type !== 'tool/result' || first.data.message.isError) throw new Error('Initial legal disclosure failed')
  const initial = JSON.stringify(before)
  const save = subject.host.attachments.saveImage.bind(subject.host.attachments)
  vi.spyOn(subject.host.attachments, 'saveImage').mockImplementation(async (input) => {
    const image = await save(input)
    await subject.central.office.saveDrivePermissions(admin, { id: subject.parent.id, revision: subject.parent.revision,
      defaultAccess: 'deny', grants: [] })
    return image
  })
  const after = await subject.run()
  const last = after.findLast(event => event.type === 'tool/result')
  if (last?.type !== 'tool/result') throw new Error('Post-withdrawal read did not settle')
  expect(last.data.message.isError).toBe(true)
  expect(last.data.message.content.some(block => block.type === 'image')).toBe(false)
  expect(JSON.stringify(after.slice(0, before.length))).toBe(initial)
  const image = first.data.message.content.find(block => block.type === 'image')
  if (image?.type !== 'image') throw new Error('Prior legal image was lost')
  expect((await subject.host.attachments.readImage(image.attachment)).data.byteLength).toBe(image.attachment.bytes)
})
