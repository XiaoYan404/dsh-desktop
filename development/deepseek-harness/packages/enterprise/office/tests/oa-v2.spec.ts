/** New OA v2 real-HTTP protocol cases; no already-green v1 scenarios are rerun. */
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { onTestFinished, expect, it } from 'vitest'
import { z } from 'zod'
import { createOaV2Adapter } from '../src/oa-v2.ts'
import type { OfficeOaV2Config, OfficeOaMaterialReader } from '../src/oa-v2.ts'
import type { OfficeConnectorWriteRequest } from '../src/connector-http.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { OfficeConnectorExecutionId } from '../src/types.ts'
import { bootConnector03, connect03, lin, wei, admin } from './fixtures/connector-03.ts'

const limits = { actionMaxCount: 100, actionMaxBytes: 262144 }
const config: OfficeOaV2Config = { members: { lin: 'oa-lin' }, maxMaterialBytes: 1024, actions: [
  { operation: 'submit', scope: 'purchases', materials: false, declaration: { id: 'submit', kind: 'write', label: 'Submit',
    description: 'Accepted submission is not approval.', allowedRoles: ['employee'],
    fields: [{ name: 'title', label: 'Title', required: true, maxLength: 200 }] } },
  { operation: 'status', scope: 'purchases', materials: false, declaration: { id: 'status', kind: 'read', label: 'Status',
    description: 'Observe current business status.', allowedRoles: ['employee'] } },
  ...(['supplement', 'withdraw', 'approve', 'reject'] as const).map(operation => ({ operation, scope: 'purchases', materials: false,
    declaration: { id: operation, kind: 'write' as const, label: operation, description: 'Reviewed versioned OA mutation.',
      allowedRoles: ['employee' as const], fields: [
        { name: 'approval_id', label: 'Approval', required: true, maxLength: 256 },
        { name: 'expected_revision', label: 'Version', required: true, maxLength: 16 },
      ] } })),
] }

async function server() {
  const calls: { method: string; path: string; body: Record<string, unknown> | null; authorization: string }[] = []
  let drop = false
  let mismatch = false
  let state = 'pending'
  const retained = new Map<string, Record<string, unknown>>()
  const listener = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const raw: unknown = body ? JSON.parse(body) : null
      const value = raw === null ? null : z.record(z.string(), z.unknown()).parse(raw)
      calls.push({ method: request.method ?? '', path: request.url ?? '', body: value, authorization: request.headers.authorization ?? '' })
      response.setHeader('content-type', 'application/json')
      if (request.url === '/oa/v2/health') { response.end('{"protocol":2}'); return }
      const actor = decodeURIComponent(String(request.headers['x-oa-actor'] ?? ''))
      if (request.url === '/oa/v2/actions/status/read') {
        response.end(JSON.stringify({ protocol: 2, actor, action: 'status', scope: 'purchases', operation: 'status',
          observedAt: new Date().toISOString(), approvals: [{ id: 'OA-1', revision: 3, state, requirements: ['Verified invoice'] }] })); return
      }
      if (request.method === 'POST' && value) {
        expect(value.executionId).toBe(request.headers['idempotency-key'])
        const receipt = { protocol: 2, actor, action: value.action, operation: value.operation, scope: value.scope,
          executionId: value.executionId, outcome: { status: 'succeeded', acceptance: 'accepted', reference: 'OA-1' } }
        retained.set(String(value.executionId), receipt)
        if (drop) { response.destroy(); return }
        response.end(JSON.stringify(receipt)); return
      }
      const receipt = retained.get((request.url ?? '').split('/').at(-1) ?? '')
      if (!receipt) { response.statusCode = 404; response.end('{}'); return }
      response.end(JSON.stringify({ ...receipt, ...mismatch ? { actor: 'oa-wei' } : {} }))
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : new Error('Local bridge fixture failed')) })
  })
  await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done) })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('No local bridge port')
  onTestFinished(async () => {
    listener.closeAllConnections()
    await new Promise<void>((done, reject) => listener.close((error) => { if (error) reject(error); else done() }))
  })
  return { calls, origin: `http://127.0.0.1:${address.port}`, setDrop(value: boolean) { drop = value },
    setMismatch(value: boolean) { mismatch = value }, setState(value: string) { state = value } }
}

function request(origin: string, values: Record<string, string> = { title: 'reviewed' }): OfficeConnectorWriteRequest {
  return { baseUrl: origin + '/oa/', actionId: 'submit', member: { id: lin, role: 'employee' }, values,
    executionId: brandString<OfficeConnectorExecutionId>(randomUUID()), headers: { authorization: 'Bearer local-test-only' },
    signal: new AbortController().signal, maxResponseBytes: 65536, maxResultBytes: 65536, maxEntries: 100 }
}

it('separates authoritative business state from acceptance and enforces all v2 fixed operation coordinates', async () => {
  const bridge = await server()
  const adapter = createOaV2Adapter(config, limits)
  const input = request(bridge.origin)
  expect(await adapter.probe({ ...input, url: bridge.origin + '/oa/v2/health' })).toMatchObject({ status: 'connected' })
  const accepted = await adapter.write!(input)
  expect(accepted).toMatchObject({ status: 'succeeded', result: { summary: 'OA 操作已受理；审批决定须另行查询' } })
  const pending = await adapter.read!({ ...input, actionId: 'status' })
  expect(pending.status).toBe('read')
  if (pending.status !== 'read') throw new Error('Expected current OA status')
  expect(pending.data.entries).toContainEqual({ label: '审批状态', value: 'pending' })
  bridge.setState('approved')
  const approved = await adapter.read!({ ...input, actionId: 'status' })
  expect(approved.status).toBe('read')
  if (approved.status !== 'read') throw new Error('Expected current OA status')
  expect(approved.data.entries).toContainEqual({ label: '审批状态', value: 'approved' })
  for (const operation of ['supplement', 'withdraw', 'approve', 'reject']) {
    expect(await adapter.write!({ ...input, executionId: brandString<OfficeConnectorExecutionId>(randomUUID()), actionId: operation,
      values: { approval_id: 'OA-1', expected_revision: '3' } })).toMatchObject({ status: 'succeeded' })
    expect(bridge.calls.at(-1)?.body).toMatchObject({ protocol: 2, scope: 'purchases', operation, values: { approval_id: 'OA-1', expected_revision: '3' } })
  }
  const count = bridge.calls.length
  expect(await adapter.write!({ ...input, actionId: 'withdraw', values: { approval_id: 'OA-1', expected_revision: '0' } }))
    .toEqual({ status: 'rejected', rejection: 'invalid_input' })
  expect(await adapter.write!({ ...input, member: { id: admin, role: 'admin' } })).toMatchObject({ status: 'rejected' })
  expect(await adapter.read!({ ...input, member: { id: wei, role: 'employee' }, actionId: 'status' })).toMatchObject({ status: 'unauthorized' })
  expect(bridge.calls).toHaveLength(count)
})

it('keeps dropped POST outcomes unknown and only GETs the original UUID with fresh credentials', async () => {
  const bridge = await server()
  const adapter = createOaV2Adapter(config, limits)
  const input = request(bridge.origin)
  bridge.setDrop(true)
  expect(await adapter.write!(input)).toEqual({ status: 'unknown' })
  bridge.setMismatch(true)
  expect(await adapter.reconcile!(input)).toEqual({ status: 'unknown' })
  bridge.setMismatch(false)
  expect(await adapter.reconcile!({ ...input, headers: { authorization: 'Bearer rotated-local-only' } })).toMatchObject({ status: 'succeeded' })
  expect(bridge.calls.map(value => value.method)).toEqual(['POST', 'GET', 'GET'])
  expect(bridge.calls.at(-1)).toMatchObject({ path: '/oa/v2/executions/' + input.executionId, authorization: 'Bearer rotated-local-only', body: null })
})

it('checks reviewed immutable material bytes, digest, cumulative bound and permission again before sending', async () => {
  const bridge = await server()
  const bytes = Buffer.from('invoice-凭证')
  const reference = { id: randomUUID(), version: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex') }
  let reads = 0
  let current = true
  const files: OfficeOaMaterialReader = { async read() { reads++; return { bytes, name: 'invoice.txt', mediaType: 'text/plain' } },
    async assertCurrent() { if (!current) throw new Error('Current material permission denied') } }
  const configured: OfficeOaV2Config = { ...config, actions: [{ ...config.actions[0]!, materials: true,
    declaration: { ...config.actions[0]!.declaration, fields: [...config.actions[0]!.declaration.fields!,
      { name: 'materials', label: 'Reviewed immutable materials', required: true, maxLength: 4000 }] } }] }
  expect(() => createOaV2Adapter(configured, limits)).toThrow()
  const adapter = createOaV2Adapter(configured, limits, files)
  const input = request(bridge.origin, { title: 'Reviewed', materials: JSON.stringify([reference]) })
  expect(await adapter.write!(input)).toMatchObject({ status: 'succeeded' })
  expect(bridge.calls[0]?.body?.attachments).toEqual([{ ...reference, name: 'invoice.txt', mediaType: 'text/plain', contentBase64: bytes.toString('base64') }])
  current = false
  await expect(adapter.write!({ ...input, executionId: brandString<OfficeConnectorExecutionId>(randomUUID()) })).rejects.toThrow('permission denied')
  const tooSmall = createOaV2Adapter({ ...configured, maxMaterialBytes: 1 }, limits, files)
  expect(await tooSmall.write!(input)).toEqual({ status: 'rejected', rejection: 'invalid_input' })
  expect(await adapter.write!({ ...input, values: { ...input.values, materials: JSON.stringify([{ ...reference, sha256: '0'.repeat(64) }]) } }))
    .toEqual({ status: 'rejected', rejection: 'invalid_input' })
  expect(bridge.calls).toHaveLength(1)
  expect(reads).toBe(4)
})

it('uses actual Loader and existing execution storage while v1 stays independently available', async () => {
  const bridge = await server()
  const { ctx, root } = await bootConnector03(undefined, [bridge.origin])
  const configured = createOaV2Adapter(config, limits)
  const write = await connect03(ctx, configured, bridge.origin)
  const receipt = await ctx.office.writeConnectorAction(lin, write)
  expect(await ctx.office.writeConnectorAction(lin, write)).toEqual(receipt)
  expect(bridge.calls.filter(value => value.method === 'POST')).toHaveLength(1)
  expect((await ctx.office.connections(admin)).adapters).toContain('oa-bridge-v2')
  expect(await readFile(join(root, 'data', 'enterprise_office_connector_executions.json'), 'utf8')).toContain(receipt.id)
  expect(await readFile(join(root, 'data', 'enterprise_office_connector_executions.json'), 'utf8')).not.toContain('local-fixture-only')
})
