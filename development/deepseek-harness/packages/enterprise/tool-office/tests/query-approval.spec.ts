/** A read review describes the actual selected company system and frozen query coordinates. */
import { expect, it } from 'vitest'
import type { OfficeConversationCapture } from '@deepseek-ai/dsh-enterprise-office/types'
import { reviewOfficeRead } from '../src/query-tools.ts'

const integrationId = '00000000-0000-4000-8000-000000000003' as OfficeConversationCapture['selection']['integrations'][number]
const capture: OfficeConversationCapture = {
  format: 1, id: '00000000-0000-4000-8000-000000000001' as OfficeConversationCapture['id'],
  requestId: 'query-review', memberId: 'employee' as OfficeConversationCapture['memberId'], role: 'employee', capturedAt: 1,
  requirements: [], digest: '0'.repeat(64), integrations: [{ id: integrationId, name: 'company-oa', system: 'Company OA',
    version: '1', capabilities: [], connectionRevision: 1, status: 'unverified' }],
  selection: { conversationId: 'query-review' as OfficeConversationCapture['selection']['conversationId'], revision: 1,
    requestId: null, updatedAt: 1, integrations: [integrationId], tools: [] },
}
const args = { system: 'Company OA', action_id: 'read-own', connection_revision: 1,
  adapter_revision: '00000000-0000-4000-8000-000000000004' }

it('reviews both languages using the actual registration, employee and exact connection/provider versions', () => {
  const review = reviewOfficeRead(args, capture)
  expect(review?.en).toBe('Read company system records\nSystem: "Company OA"\nRegistration: "company-oa"\n'
    + 'Action: "read-own"\nEmployee: "employee"\nConnection version: 1\n'
    + 'Provider version: "00000000-0000-4000-8000-000000000004"')
  expect(review?.zh).toContain('系统："Company OA"\n登记名称："company-oa"\n动作："read-own"\n员工："employee"')
  expect(review?.zh).toContain('连接版本：1\n提供方版本："00000000-0000-4000-8000-000000000004"')
})

it('quotes requested fields so embedded newlines cannot impersonate review labels', () => {
  const review = reviewOfficeRead({ ...args, action_id: 'read-own\nEmployee: "other"' }, capture)
  expect(review?.en).toContain('Action: "read-own\\nEmployee: \\"other\\""\nEmployee: "employee"')
  expect(review?.en?.split('\n')).toHaveLength(7)
})

it('refuses malformed, unknown, unavailable and ambiguous system selections', () => {
  expect(reviewOfficeRead({ ...args, connection_revision: '1' }, capture)).toBeUndefined()
  expect(reviewOfficeRead({ ...args, system: 'Not submitted' }, capture)).toBeUndefined()
  expect(reviewOfficeRead(args, { ...capture, selection: { ...capture.selection, integrations: [] } })).toBeUndefined()
  expect(reviewOfficeRead(args, { ...capture, integrations: capture.integrations.map(row => ({ ...row, status: 'disabled' })) }))
    .toBeUndefined()
  const secondId = '00000000-0000-4000-8000-000000000005' as typeof integrationId
  const duplicate = { ...capture.integrations[0]!, id: secondId, name: 'second-company-oa' }
  expect(reviewOfficeRead(args, { ...capture, integrations: [...capture.integrations, duplicate],
    selection: { ...capture.selection, integrations: [integrationId, secondId] } })).toBeUndefined()
})
