/** Exact native approval includes immutable run coordinates and all original business fields. */
import { expect, it } from 'vitest'
import type { OfficeConversationCapture } from '@deepseek-ai/dsh-enterprise-office/types'
import { reviewOfficeAutomation } from '../src/automation-tool.ts'

const integrationId = '00000000-0000-4000-8000-000000000003' as OfficeConversationCapture['selection']['integrations'][number]
const capture: OfficeConversationCapture = {
  format: 1, id: '00000000-0000-4000-8000-000000000001' as OfficeConversationCapture['id'],
  requestId: 'automation-review', memberId: 'lin' as OfficeConversationCapture['memberId'], role: 'employee', capturedAt: 1,
  requirements: [], digest: '0'.repeat(64), integrations: [{ id: integrationId, name: 'company-oa', system: 'Company OA',
    version: '2', capabilities: [], connectionRevision: 1, status: 'unverified' }],
  selection: { conversationId: 'automation-review' as OfficeConversationCapture['selection']['conversationId'], revision: 1,
    requestId: null, updatedAt: 1, integrations: [integrationId], tools: [] },
}
const args = { system: 'Company OA', action_id: 'withdraw', connection_revision: 1,
  adapter_revision: '00000000-0000-4000-8000-000000000004',
  values: [{ name: 'reason', value: 'Reviewed\n撤回原因' }], run_id: '00000000-0000-4000-8000-000000000005', run_revision: 3,
  part: 'compensation' }

it('describes the exact compensation run, revision, selected system and complete quoted business values', () => {
  const result = reviewOfficeAutomation(args, capture)
  expect(result?.en).toContain('Phase: compensation')
  expect(result?.en).toContain('Run revision: 3')
  expect(result?.en).toContain('Automation run: ' + args.run_id)
  expect(result?.zh).toContain(`字段 "reason"：${JSON.stringify(args.values[0]?.value)}`)
  expect(result?.zh).toContain('结果未知时，应先核查')
})

it('refuses invalid run revisions, phases, duplicate fields and unselected systems before native approval', () => {
  for (const input of [{ ...args, run_revision: 0 }, { ...args, part: 'automatic' },
    { ...args, values: [...args.values, ...args.values] }, { ...args, system: 'Not selected' }])
    expect(reviewOfficeAutomation(input, capture)).toBeUndefined()
})
