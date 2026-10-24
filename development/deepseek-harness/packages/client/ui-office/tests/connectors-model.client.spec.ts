/** Connection forms receive confirmed versions and explicit failures across account, role and response races. */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeConnectorEntry, OfficeConnectorInput, OfficeConnectorProbe, OfficeConnectorView,
  OfficeConnectorActionsView, OfficeConnectorReadReceipt, OfficeIntegrationId, OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeOutcome } from '../src/types.ts'
import { OfficeConnectorsModel } from '../src/client/connectors-model.ts'

const id = '47e66e79-2894-49eb-bb17-c512de55c7dc' as OfficeIntegrationId
const admin = { id: 'admin' as OfficeMemberId, role: 'admin' as const }
const input: OfficeConnectorInput = { integrationId: id, revision: 0, requestId: 'a9594fe0-2fb2-4d4a-9f1e-12624ae97619',
  adapterId: 'http-json', baseUrl: 'https://oa.company.invalid/api/', probePath: 'health', enabled: true,
  authentication: { kind: 'bearer', credential: 'oa-key' } }
const entry: OfficeConnectorEntry = { integrationId: id, revision: 1, adapterId: 'http-json', status: 'unverified',
  updatedAt: 1, configuration: input }
const check: OfficeConnectorProbe = { integrationId: id, revision: 1, checkedAt: 2, status: 'connected', httpStatus: 200 }
const view: OfficeConnectorView = { revision: 1, adapters: ['http-json'], entries: [entry],
  allowedOrigins: ['https://oa.company.invalid'], credentialAliases: ['oa-key'] }
const employeeView: OfficeConnectorView = { revision: 1, adapters: ['http-json'], entries: [{
  integrationId: id, revision: 1, adapterId: 'http-json', status: 'unverified', updatedAt: 1,
}] }
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const catalogue: OfficeConnectorActionsView = { integrationId: id, connectionRevision: 1,
  adapterRevision: 'c3dc94c2-3213-4892-b501-5cd2d4bd1e90', status: 'unverified',
  actions: [{ id: 'read-own', label: 'Read own requests', description: 'Current permitted declaration', kind: 'read' }] }
const supported: OfficeConnectorView = { ...view, actionCatalog: { protocol: 1, maxCount: 100, maxBytes: 262144 } }
type Api = ConstructorParameters<typeof OfficeConnectorsModel>[0]
const remote = () => ({
  connections: vi.fn<Api['connections']>().mockResolvedValue(success(view)),
  saveConnection: vi.fn<Api['saveConnection']>().mockResolvedValue(success(entry)),
  probeConnection: vi.fn<Api['probeConnection']>().mockResolvedValue(success(check)),
  connectorActions: vi.fn<Api['connectorActions']>().mockResolvedValue(success(catalogue)),
  readConnectorAction: vi.fn<Api['readConnectorAction']>(),
})
async function mounted(api = remote()) {
  const notify = vi.fn()
  const model = new OfficeConnectorsModel(api, notify)
  model.bind(admin)
  await vi.waitFor(() => { expect(model.state.getSnapshot().view).toEqual(view) })
  return { api, model, notify }
}

describe('Reviewed company business queries', () => {
  const receipt: OfficeConnectorReadReceipt = { integrationId: id, actionId: 'read-own', connectionRevision: 1,
    adapterRevision: 'c3dc94c2-3213-4892-b501-5cd2d4bd1e90', checkedAt: 2, status: 'read',
    data: { summary: 'Employee-only result', entries: [{ label: 'Pending', value: '3' }] } }
  async function ready() {
    const api = remote()
    api.connections.mockResolvedValue(success(supported))
    api.connectorActions.mockResolvedValue(success({ ...catalogue, readSupported: true }))
    api.readConnectorAction.mockResolvedValue(success(receipt))
    const model = new OfficeConnectorsModel(api, vi.fn())
    model.bind(admin)
    await vi.waitFor(() => { expect(model.state.getSnapshot().view).toEqual(supported) })
    await model.loadActions(id)
    return { api, model }
  }

  it('queries only an explicitly selected read implementation and checks every returned coordinate', async () => {
    const { api, model } = await ready()
    expect(api.readConnectorAction).not.toHaveBeenCalled()
    await model.readAction('missing')
    expect(api.readConnectorAction).not.toHaveBeenCalled()
    await model.readAction('read-own')
    expect(api.readConnectorAction).toHaveBeenCalledWith({ integrationId: id, actionId: 'read-own',
      connectionRevision: 1, adapterRevision: receipt.adapterRevision })
    expect(model.state.getSnapshot().catalogue?.result).toMatchObject({ loading: false, error: null, receipt })
    api.readConnectorAction.mockResolvedValueOnce(success({ ...receipt, connectionRevision: 2 }))
    await model.readAction('read-own')
    expect(model.state.getSnapshot().catalogue?.result).toMatchObject({ receipt: null, error: 'conflict' })
    expect(api.probeConnection).not.toHaveBeenCalled()
    expect(api.saveConnection).not.toHaveBeenCalled()
  })

  it.each(['account', 'role', 'refresh', 'directory', 'dispose'] as const)('fences a pending private result after %s changes', async (change) => {
    const { api, model } = await ready()
    const pending = Promise.withResolvers<Awaited<ReturnType<Api['readConnectorAction']>>>()
    api.readConnectorAction.mockReturnValueOnce(pending.promise)
    const reading = model.readAction('read-own')
    expect(model.state.getSnapshot().catalogue?.result?.loading).toBe(true)
    if (change === 'account') model.bind({ ...admin, id: 'second' as OfficeMemberId })
    else if (change === 'role') model.bind({ ...admin, role: 'employee' })
    else if (change === 'refresh') await model.load(true)
    else if (change === 'directory') await model.loadActions(id)
    else model.dispose()
    pending.resolve(success(receipt))
    await reading
    expect(model.state.getSnapshot().catalogue?.result?.receipt).toBeUndefined()
    model.dispose()
  })

  it('clears prior data before a failed retry and keeps only the latest query result', async () => {
    const { api, model } = await ready()
    await model.readAction('read-own')
    const pending = Promise.withResolvers<Awaited<ReturnType<Api['readConnectorAction']>>>()
    api.readConnectorAction.mockReturnValueOnce(pending.promise)
    const old = model.readAction('read-own')
    expect(model.state.getSnapshot().catalogue?.result?.receipt).toBeNull()
    api.readConnectorAction.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
    await model.readAction('read-own')
    pending.resolve(success(receipt))
    await old
    expect(model.state.getSnapshot().catalogue?.result).toMatchObject({ loading: false, receipt: null, error: 'forbidden' })
  })

  it('clears a private result when passive readiness reports a different connection revision or disabled state', async () => {
    const { api, model } = await ready()
    await model.readAction('read-own')
    api.connections.mockResolvedValueOnce(success({ ...supported, revision: 2,
      entries: [{ ...entry, revision: 2, status: 'disabled' }] }))
    await model.load()
    expect(model.state.getSnapshot().catalogue).toBeNull()
  })

  it('keeps metadata-only and write-only actions uncallable from the query control', async () => {
    const { api, model } = await ready()
    for (const directory of [catalogue, { ...catalogue, readSupported: true,
      actions: [{ ...catalogue.actions[0]!, kind: 'write' as const }] }]) {
      api.connectorActions.mockResolvedValueOnce(success(directory))
      await model.loadActions(id)
      await model.readAction('read-own')
    }
    expect(api.readConnectorAction).not.toHaveBeenCalled()
  })
})

describe('office connection projections', () => {
  it('keeps configuration readiness distinct from a manual versioned check and removes obsolete check results', async () => {
    const { api, model } = await mounted()
    expect(model.state.getSnapshot().checks).toEqual({})
    await model.probe(id, 1)
    expect(model.state.getSnapshot().checks[id]).toEqual(check)
    expect(model.state.getSnapshot().view?.entries[0]?.status).toBe('unverified')
    api.connections.mockResolvedValueOnce(success({ ...view, revision: 2, entries: [{ ...entry, revision: 2 }] }))
    await model.load(true)
    expect(model.state.getSnapshot().checks).toEqual({})
    expect(api.probeConnection).toHaveBeenCalledWith(id, 1)
  })

  it('reports unknown saves explicitly, accepts an exact retry and retains a confirmed commit when refresh fails', async () => {
    const { api, model, notify } = await mounted()
    api.saveConnection.mockRejectedValueOnce(new Error('Lost save response'))
    expect(await model.save(input)).toEqual({ ok: false, error: 'unavailable' })
    expect(model.state.getSnapshot()).toMatchObject({ busy: null, error: 'unavailable' })
    api.connections.mockRejectedValueOnce(new Error('Refresh unavailable after commit'))
    expect(await model.save(input)).toEqual({ ok: true })
    expect(api.saveConnection.mock.calls.map(args => args[0])).toEqual([input, input])
    expect(notify).toHaveBeenCalledWith('connectorSaved', true)
    expect(model.state.getSnapshot()).toMatchObject({ view: null, error: 'unavailable' })
  })

  it('loads the competing version after conflict without retrying or overwriting it', async () => {
    const { api, model } = await mounted()
    const latest = { ...view, revision: 2, entries: [{ ...entry, revision: 2 }] }
    api.saveConnection.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'conflict' } })
    api.connections.mockResolvedValueOnce(success(latest))
    expect(await model.save(input)).toEqual({ ok: false, error: 'conflict' })
    expect(model.state.getSnapshot()).toMatchObject({ view: latest, error: 'conflict', busy: null })
    expect(api.saveConnection).toHaveBeenCalledTimes(1)
  })

  it('ignores older reads and returns only the fresh view requested for explicit form replacement', async () => {
    const { api, model } = await mounted()
    const old = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorView>>>()
    api.connections.mockReturnValueOnce(old.promise)
    const reading = model.load(true)
    const latest = { ...view, revision: 3, entries: [{ ...entry, revision: 3 }] }
    api.connections.mockResolvedValueOnce(success(latest))
    expect(await model.load(true)).toEqual(latest)
    old.resolve(success(view))
    expect(await reading).toBeNull()
    expect(model.state.getSnapshot().view).toEqual(latest)
    api.connections.mockResolvedValueOnce(success(view))
    expect(await model.load(true)).toBeNull()
    expect(model.state.getSnapshot().view).toEqual(latest)
  })

  it('releases administrator configuration on same-account demotion and ignores the earlier save acknowledgement', async () => {
    const { api, model, notify } = await mounted()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorEntry>>>()
    api.saveConnection.mockReturnValueOnce(pending.promise)
    const saving = model.save(input)
    const reading = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorView>>>()
    api.connections.mockReturnValueOnce(reading.promise)
    model.bind({ ...admin, role: 'employee' })
    expect(model.state.getSnapshot()).toMatchObject({ view: null, checks: {}, busy: null })
    expect(JSON.stringify(model.state.getSnapshot())).not.toContain('oa.company.invalid')
    pending.resolve(success(entry))
    expect(await saving).toEqual({ ok: false, error: null })
    expect(notify).not.toHaveBeenCalledWith('connectorSaved', true)
    reading.resolve(success(employeeView))
    await vi.waitFor(() => { expect(model.state.getSnapshot().view).toEqual(employeeView) })
    await model.probe(id, 1)
    expect(api.probeConnection).not.toHaveBeenCalled()
  })

  it.each(['account', 'dispose'] as const)('fences a late network check after %s changes', async (change) => {
    const { api, model, notify } = await mounted()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorProbe>>>()
    api.probeConnection.mockReturnValueOnce(pending.promise)
    const checking = model.probe(id, 1)
    await model.probe(id, 1)
    expect(api.probeConnection).toHaveBeenCalledOnce()
    if (change === 'dispose') model.dispose()
    else {
      api.connections.mockResolvedValueOnce(success(employeeView))
      model.bind({ id: 'lin' as OfficeMemberId, role: 'employee' })
    }
    pending.resolve(success(check))
    await checking
    expect(model.state.getSnapshot().checks).toEqual({})
    expect(model.state.getSnapshot().busy).toBeNull()
    expect(notify).not.toHaveBeenCalled()
  })

  it('shows read outages persistently without repeated toasts and clears them after a fresh successful read', async () => {
    const { api, model, notify } = await mounted()
    api.connections.mockRejectedValueOnce(new Error('Offline'))
    expect(await model.load(true)).toBeNull()
    expect(model.state.getSnapshot().error).toBe('unavailable')
    expect(notify).not.toHaveBeenCalled()
    expect(await model.load(true)).toEqual(view)
    expect(model.state.getSnapshot().error).toBeNull()
    api.probeConnection.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
    await model.probe(id, 1)
    expect(model.state.getSnapshot()).toMatchObject({ view: null, checks: {}, loading: false })
    expect(notify).toHaveBeenCalledWith('unauthenticated', false)
  })
})

describe('Current connector action directory', () => {
  async function ready() {
    const api = remote()
    api.connections.mockResolvedValue(success(supported))
    const notify = vi.fn()
    const model = new OfficeConnectorsModel(api, notify)
    model.bind(admin)
    await vi.waitFor(() => { expect(model.state.getSnapshot().view).toEqual(supported) })
    return { api, model, notify }
  }

  it('leaves older servers on their original connection flow', async () => {
    const { api, model } = await mounted()
    await model.loadActions(id)
    expect(api.connectorActions).not.toHaveBeenCalled()
    expect(model.state.getSnapshot().catalogue).toBeNull()
  })

  it('reads only on request and never turns directory discovery into a probe', async () => {
    const { api, model } = await ready()
    expect(api.connectorActions).not.toHaveBeenCalled()
    await model.loadActions(id)
    expect(api.connectorActions).toHaveBeenCalledWith(id)
    expect(api.probeConnection).not.toHaveBeenCalled()
    expect(api.saveConnection).not.toHaveBeenCalled()
    expect(model.state.getSnapshot().catalogue).toEqual({ integrationId: id, loading: false, error: null, view: catalogue })
  })

  it.each(['account', 'role', 'refresh', 'dispose'] as const)('fences directory replies after %s changes', async (change) => {
    const { api, model } = await ready()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorActionsView>>>()
    api.connectorActions.mockReturnValueOnce(pending.promise)
    const reading = model.loadActions(id)
    expect(model.state.getSnapshot().catalogue?.loading).toBe(true)
    if (change === 'dispose') model.dispose()
    else if (change === 'refresh') await model.load(true)
    else model.bind({ id: change === 'account' ? 'lin' as OfficeMemberId : admin.id, role: 'employee' })
    pending.resolve(success(catalogue))
    await reading
    expect(model.state.getSnapshot().catalogue).toBeNull()
  })

  it('retains only the latest requested system and rejects a mismatched response', async () => {
    const { api, model } = await ready()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnectorActionsView>>>()
    api.connectorActions.mockReturnValueOnce(pending.promise)
    const reading = model.loadActions(id)
    const other = '62bfde8f-0b8a-4a4d-af08-a314ec8bcb5a' as OfficeIntegrationId
    const otherView = { ...catalogue, integrationId: other, actions: [] }
    api.connectorActions.mockResolvedValueOnce(success(otherView))
    await model.loadActions(other)
    pending.resolve(success(catalogue))
    await reading
    expect(model.state.getSnapshot().catalogue?.view).toEqual(otherView)
    api.connectorActions.mockResolvedValueOnce(success(otherView))
    await model.loadActions(id)
    expect(model.state.getSnapshot().catalogue).toMatchObject({ integrationId: id, view: null, error: 'conflict' })
  })

  it('shows read failure without retaining a stale directory and clears sensitive views on denial', async () => {
    const { api, model } = await ready()
    await model.loadActions(id)
    api.connectorActions.mockRejectedValueOnce(new Error('Directory unavailable'))
    await model.loadActions(id)
    expect(model.state.getSnapshot().catalogue).toMatchObject({ view: null, error: 'unavailable', loading: false })
    api.connectorActions.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'forbidden' } })
    await model.loadActions(id)
    expect(model.state.getSnapshot()).toMatchObject({ view: null, catalogue: null, error: 'forbidden' })
  })
})
