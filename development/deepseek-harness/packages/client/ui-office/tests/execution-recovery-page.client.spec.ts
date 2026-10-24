/** A late older page preserves the confirmed original outcome already visible in the current employee's execution history. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnectorExecutionId, OfficeConnectorExecutionPage, OfficeConnectorExecutionReceipt,
  OfficeIntegrationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeExecutionsModel } from '../src/client/executions-model.ts'

const integrationId = brandString<OfficeIntegrationId>('00000000-0000-4000-8000-000000000001')
const executionId = brandString<OfficeConnectorExecutionId>('00000000-0000-4000-8000-000000000002')
const olderId = brandString<OfficeConnectorExecutionId>('00000000-0000-4000-8000-000000000003')
const member = { id: brandString<OfficeMemberId>('lin'), role: 'employee' as const }
const original: OfficeConnectorExecutionReceipt = { id: executionId, integrationId, memberId: member.id,
  requestId: '00000000-0000-4000-8000-000000000004', roleAtAdmission: 'employee', actionId: 'send_message',
  connectionRevision: 1, adapterRevision: '00000000-0000-4000-8000-000000000005',
  stage: 'unknown', status: 'unknown', revision: 3, admittedAt: 1, updatedAt: 3,
  history: [{ stage: 'reserved', at: 1 }, { stage: 'dispatched', at: 2 }, { stage: 'unknown', at: 3 }] }
const { history: _history, result: _result, ...summary } = original
const ok = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
type Api = ConstructorParameters<typeof OfficeExecutionsModel>[0]

it.each(['succeeded', 'rejected'] as const)(
  'retains a checked %s row when an earlier older-page request finishes after returning to the list', async (status) => {
    const page: OfficeConnectorExecutionPage = { integrationId, entries: [summary], next: executionId }
    const checked: OfficeConnectorExecutionReceipt = { ...original, stage: status, status, revision: 4, updatedAt: 4,
      history: [...original.history, { stage: status, at: 4 }],
      ...status === 'succeeded' ? { result: { summary: 'Accepted operation fixture, no delivery claim',
        entries: [{ label: 'Private detail', value: 'Visible only in the explicitly selected receipt' }] } } : { rejection: 'denied' } }
    const api = { connectorExecutionPage: vi.fn<Api['connectorExecutionPage']>().mockResolvedValue(ok(page)),
      connectorExecutionDetail: vi.fn<Api['connectorExecutionDetail']>().mockResolvedValue(ok(original)),
      checkConnectorExecution: vi.fn<Api['checkConnectorExecution']>().mockResolvedValue(ok({ status: 'updated', receipt: checked })) }
    const model = new OfficeExecutionsModel(api, vi.fn())
    model.bind(member)
    await model.open(integrationId)
    const older = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorExecutionPage>>>()
    api.connectorExecutionPage.mockReturnValueOnce(older.promise)
    const loading = model.more()
    await model.detail(executionId)
    await model.check()
    expect(model.state.getSnapshot().entries[0]).toMatchObject({ id: executionId, status, revision: 4 })
    model.closeDetail()
    older.resolve(ok({ integrationId, entries: [{ ...summary, id: olderId,
      requestId: '00000000-0000-4000-8000-000000000006', admittedAt: 0 }], next: null }))
    await loading
    const current = model.state.getSnapshot()
    expect(current.entries).toMatchObject([{ id: executionId, status, revision: 4, updatedAt: 4 }, { id: olderId }])
    expect(current.detail).toBeNull()
    expect(current.next).toBeNull()
    expect(current.loading).toBe(false)
    expect(JSON.stringify(current.entries)).not.toContain('Private detail')
    expect(current.entries[0]).not.toHaveProperty('history')
    expect(api.connectorExecutionPage.mock.calls.map(([input]) => input)).toEqual([
      { integrationId }, { integrationId, before: executionId },
    ])
    expect(api.checkConnectorExecution).toHaveBeenCalledExactlyOnceWith(executionId)
    expect(api.connectorExecutionDetail).toHaveBeenCalledExactlyOnceWith(executionId)
    model.dispose()
  })
