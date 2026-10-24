/** Published text travels through real central HTTP and Native approval into the original model history. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { imageNativeFixture } from './image-native-fixture.ts'
import { pptxAdministrator as admin } from '../../office/tests/pptx-office-fixture.ts'
import type { OfficeConversationId, OfficeKnowledgeSearch } from '@deepseek-ai/dsh-enterprise-office/types'

it('logs real current knowledge citations and the same text in the next controlled model request after native read approval', async () => {
  const subject = await imageNativeFixture({ image: false, knowledge: true, office: { knowledge: {
    maxDocuments: 10, maxIndexBytes: 1048576, maxSourceBytes: 1048576, maxDocumentCharacters: 65536,
    maxSections: 20, chunkCharacters: 512, maxChunksPerDocument: 256, maxResults: 10, maxResponseBytes: 16384, timeoutMs: 10000,
  } } })
  const bytes = Buffer.from('可引用的企业差旅制度：住宿每晚500元。🙂')
  const file = await subject.central.office.uploadDriveFile(admin, { space: 'shared', folderId: subject.parent.id,
    name: '差旅制度.txt', mediaType: 'text/plain', requestId: randomUUID(), byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const info = await subject.central.office.driveFileInfo(admin, file.id)
  await subject.central.office.publishKnowledge(admin, { fileId: file.id, versionId: info.versionId, revision: 0, requestId: randomUUID() })
  const events = await subject.run('office_search_knowledge', { query: '住宿', max_results: 1 })
  const result = events.findLast(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result' || result.data.message.isError) throw new Error('Real knowledge tool did not succeed')
  const block = result.data.message.content[0]
  if (block?.type !== 'text') throw new Error('Knowledge tool did not retain text')
  const parsed = JSON.parse(block.text) as OfficeKnowledgeSearch
  expect(parsed.entries[0]?.text).toBe(bytes.toString('utf8'))
  expect(parsed.entries[0]?.file.sha256).toBe(info.sha256)
  expect(parsed.entries[0]?.location).toEqual({ kind: 'text', part: 1, offset: 0, label: '' })
  expect(subject.reviews[0]).toContain('Search authorized company knowledge')
  expect(subject.adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
  const selected = await subject.host.officeController.conversationFiles(String(subject.agent.id) as OfficeConversationId)
  expect(selected.ok).toBe(true)
  expect(subject.host.tools.get('office_search_knowledge', subject.agent)).toBeUndefined()
})
