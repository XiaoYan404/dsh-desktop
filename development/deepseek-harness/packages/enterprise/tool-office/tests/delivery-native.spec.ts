/** Actual delivery-check bytes pass the fixed HTTP operation and Native manual approval into original history. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { OfficeConversationId } from '@deepseek-ai/dsh-enterprise-office/types'
import { imageNativeFixture } from './image-native-fixture.ts'
import { pptxAdministrator as admin } from '../../office/tests/pptx-office-fixture.ts'
import { submittedDocxFixture } from '../../office/tests/docx-fixture.ts'

it('checks a finished real DOCX through approved Native HTTP and persists its actual structural evidence for the next model', async () => {
  const subject = await imageNativeFixture({ image: false, deliveries: true, office: { deliveryChecks: {
    maxSourceBytes: 1048576, maxDocumentCharacters: 65536, maxSections: 20, timeoutMs: 10000,
    maxResultBytes: 16384, maxExpectedTexts: 10, maxExpectedTextCharacters: 256,
  } } })
  const bytes = submittedDocxFixture()
  const file = await subject.central.office.uploadDriveFile(admin, { space: 'shared', folderId: subject.parent.id,
    name: 'finished.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    requestId: randomUUID(), byteLength: bytes.length, dataBase64: bytes.toString('base64') })
  const info = await subject.central.office.driveFileInfo(admin, file.id)
  const selected = await subject.host.officeController.saveConversationFiles({
    conversationId: String(subject.agent.id) as OfficeConversationId,
    revision: 1, requestId: randomUUID(), files: [{ id: file.id, versionId: info.versionId }] })
  expect(selected.ok).toBe(true)
  const events = await subject.run('office_check_deliverable', { file_id: file.id, template: 'document', expected_text: ['真实 Word'] })
  const result = events.findLast(event => event.type === 'tool/result')
  if (result?.type !== 'tool/result' || result.data.message.isError) throw new Error('Actual checked delivery tool did not settle successfully')
  expect(JSON.stringify(result.data.message.content)).toContain(info.sha256)
  expect(JSON.stringify(result.data.message.content)).toContain(info.versionId)
  expect(JSON.stringify(result.data.message.content)).toContain('structure_and_text')
  expect(JSON.stringify(result.data.message.content)).toContain('not_checked')
  expect(subject.reviews[0]).toContain('Check submitted office deliverable')
  expect(subject.adapter.requests[1]?.messages.at(-1)?.content).toEqual(result.data.message.content)
  expect(subject.host.tools.get('office_check_deliverable', subject.agent)).toBeUndefined()
})
