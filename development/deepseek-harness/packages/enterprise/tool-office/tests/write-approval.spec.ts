/** Native write review must preserve every business value and the exact operation that execution submits. */
import { expect, it } from 'vitest'
import type { OfficeConversationCapture } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeRequestId } from '../src/driver.ts'
import { reviewOfficeWrite } from '../src/write-tool.ts'

const integrationId = '00000000-0000-4000-8000-000000000003' as OfficeConversationCapture['selection']['integrations'][number]
const capture: OfficeConversationCapture = {
  format: 1, id: '00000000-0000-4000-8000-000000000001' as OfficeConversationCapture['id'],
  requestId: 'write-review', memberId: 'employee' as OfficeConversationCapture['memberId'], role: 'employee', capturedAt: 1,
  requirements: [], digest: '0'.repeat(64), integrations: [{ id: integrationId, name: 'company-oa', system: 'Company OA',
    version: '1', capabilities: [], connectionRevision: 1, status: 'unverified' }],
  selection: { conversationId: 'write-review' as OfficeConversationCapture['selection']['conversationId'], revision: 1,
    requestId: null, updatedAt: 1, integrations: [integrationId], tools: [] },
}
const args = { system: 'Company OA', action_id: 'submit-request', connection_revision: 1,
  adapter_revision: '00000000-0000-4000-8000-000000000004',
  values: [{ name: 'title', value: 'Purchase\nEmployee: "other"' }, { name: 'reason', value: '文'.repeat(4000) }] }

it('reviews the actual system, employee, exact versions and complete quoted values in both languages', () => {
  const review = reviewOfficeWrite(args, capture)
  expect(review?.en).toContain('Submit to company system\nSystem: "Company OA"\nRegistration: "company-oa"\n')
  expect(review?.en).toContain('Action: "submit-request"\nEmployee: "employee"\nConnection version: 1\n')
  expect(review?.en).toContain('Provider version: "00000000-0000-4000-8000-000000000004"\n')
  expect(review?.en).toContain(`Field "title": ${JSON.stringify(args.values[0]!.value)}`)
  expect(review?.en).toContain(`Field "reason": ${JSON.stringify(args.values[1]!.value)}`)
  expect(review?.en.split('\n')).toHaveLength(10)
  expect(review?.zh).toContain('提交到公司系统\n系统："Company OA"\n登记名称："company-oa"\n')
  expect(review?.zh).toContain(`字段 "reason"：${JSON.stringify(args.values[1]!.value)}`)
  expect(review?.zh.split('\n')).toHaveLength(10)
})

it('explicitly describes a parameterless operation without inventing or omitting supplied fields', () => {
  const review = reviewOfficeWrite({ ...args, values: [] }, capture)
  expect(review?.en).toContain('Fields: None\n')
  expect(review?.zh).toContain('字段：无\n')
})

it('refuses malformed, duplicate, oversized and unselected business operations before native approval', () => {
  for (const values of [[...args.values, args.values[0]], [{ name: 'title', value: 1 }],
    [{ name: 'title', value: 'x'.repeat(4001) }], [{ name: '__proto__', value: 'other' }],
    Array.from({ length: 33 }, (_, index) => ({ name: `field_${index}`, value: 'x' }))])
    expect(reviewOfficeWrite({ ...args, values }, capture)).toBeUndefined()
  expect(reviewOfficeWrite({ ...args, connection_revision: '1' }, capture)).toBeUndefined()
  expect(reviewOfficeWrite({ ...args, system: 'Not selected' }, capture)).toBeUndefined()
  expect(reviewOfficeWrite(args, { ...capture, selection: { ...capture.selection, integrations: [] } })).toBeUndefined()
})

it('retains one native retry UUID for the exact call while another call or submission has a different identity', () => {
  const id = officeRequestId('capture', 'agent', 'call')
  expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/)
  expect(officeRequestId('capture', 'agent', 'call')).toBe(id)
  expect(officeRequestId('capture', 'agent', 'next-call')).not.toBe(id)
  expect(officeRequestId('next-capture', 'agent', 'call')).not.toBe(id)
})
