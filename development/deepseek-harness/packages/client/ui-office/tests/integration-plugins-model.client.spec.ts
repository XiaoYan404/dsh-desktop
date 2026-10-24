/** Local plugin metadata is explicitly read and fenced from later employees or roles. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeIntegrationPlugins, OfficeOutcome } from '../src/types.ts'
import { OfficeIntegrationPluginsModel } from '../src/client/integration-plugins-model.ts'

const member = { id: 'lin' as OfficeMemberId, role: 'employee' as const }
const view: OfficeIntegrationPlugins = { meId: member.id, mode: 'local', managementAvailable: true, packages: [] }
const ok = (value: OfficeIntegrationPlugins): RemoteResult<OfficeOutcome<OfficeIntegrationPlugins>> =>
  ({ ok: true, value: { ok: true, value } })

function fixture() {
  const api = { integrationPlugins: vi.fn<ConstructorParameters<typeof OfficeIntegrationPluginsModel>[0]['integrationPlugins']>()
    .mockResolvedValue(ok(view)) }
  const notify = vi.fn()
  const model = new OfficeIntegrationPluginsModel(api, notify)
  model.bind(member)
  return { api, model, notify }
}

it('reads only on request and clears an unavailable observation instead of claiming a package is absent', async () => {
  const { api, model } = fixture()
  expect(api.integrationPlugins).not.toHaveBeenCalled()
  await model.load()
  expect(model.state.getSnapshot().view).toEqual(view)
  api.integrationPlugins.mockRejectedValueOnce(new Error('Profile unavailable'))
  await model.load()
  expect(model.state.getSnapshot()).toEqual({ view: null, loading: false, error: 'unavailable' })
})

it.each(['account', 'role', 'unload'] as const)('discards a late package observation after %s changes', async (kind) => {
  const { api, model } = fixture()
  const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeIntegrationPlugins>>>()
  api.integrationPlugins.mockReturnValueOnce(pending.promise)
  const read = model.load()
  if (kind === 'account') model.bind({ ...member, id: 'other' as OfficeMemberId })
  if (kind === 'role') model.bind({ ...member, role: 'manager' })
  if (kind === 'unload') model.dispose()
  pending.resolve(ok(view))
  await read
  expect(model.state.getSnapshot()).toEqual({ view: null, loading: false, error: null })
})

it('rejects another employee response and releases observations after an expired sign-in', async () => {
  const { api, model, notify } = fixture()
  api.integrationPlugins.mockResolvedValueOnce(ok({ ...view, meId: 'other' as OfficeMemberId }))
  await model.load()
  expect(model.state.getSnapshot().error).toBe('conflict')
  api.integrationPlugins.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
  await model.load()
  expect(notify).toHaveBeenCalledWith('unauthenticated')
  await model.load()
  expect(api.integrationPlugins).toHaveBeenCalledTimes(2)
})
