/** Additional failures discovered while reviewing GUI requests, retained views and confirmation lifetimes. */
import { expect, it } from 'vitest'
import { collaborationGuiFixture, guiDeferred, guiDenied, guiGroup, guiOk, guiPeer } from './collaboration-gui-fixture.ts'
import type { OfficeCollaborationRemote } from '../src/client/collaboration-model.ts'

it('contains a synchronously unavailable service call and leaves the GUI retryable', async () => {
  const { model, remote } = collaborationGuiFixture()
  remote.unifiedInbox.mockImplementationOnce(() => { throw new TypeError('Old Host has no method') })
  await expect(model.open()).resolves.toBeUndefined()
  expect(model.state.getSnapshot()).toMatchObject({ visible: true, pending: false, error: 'collaborationNetwork' })
  model.dispose()
})

it('retains loaded inbox and selected group when a refresh loses its connection', async () => {
  const { model, remote } = collaborationGuiFixture()
  await model.open()
  await model.loadGroup(guiGroup.id)
  remote.unifiedInbox.mockRejectedValueOnce(new Error('Offline'))
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({ pending: false, error: 'collaborationNetwork',
    group: { group: guiGroup }, inbox: { entries: [{ title: 'Existing authorized notice' }] } })
  model.dispose()
})

it('keeps filter and refresh gestures from replacing an in-flight confirmed write', async () => {
  const { model, remote } = collaborationGuiFixture()
  await model.open()
  const pending = guiDeferred<Awaited<ReturnType<OfficeCollaborationRemote['saveMessagePreferences']>>>()
  remote.saveMessagePreferences.mockReturnValueOnce(pending.promise)
  const preferences = model.state.getSnapshot().preferences!
  const saving = model.savePreferences(preferences)
  await model.filter('group', true)
  await model.refresh()
  expect(model.state.getSnapshot()).toMatchObject({ source: null, unreadOnly: false, pending: true })
  pending.resolve(guiOk({ ...preferences, revision: 2 }))
  expect(await saving).toBe(true)
  expect(model.state.getSnapshot().feedback).toMatchObject({ key: 'collaborationSaved', success: true })
  model.dispose()
})

it('unlocks a definitively rejected group draft so its input can be corrected', async () => {
  const { model, remote } = collaborationGuiFixture()
  await model.open()
  remote.sendGroupMessage.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'invalid_input' } })
  expect(await model.send(guiGroup.id, 'Invalid draft', [], [])).toBe(false)
  expect(model.state.getSnapshot().pendingMessages).toEqual([])
  expect(await model.send(guiGroup.id, 'Corrected draft', [], [])).toBe(true)
  expect(remote.sendGroupMessage.mock.calls[0]?.[0].id).not.toBe(remote.sendGroupMessage.mock.calls[1]?.[0].id)
  model.dispose()
})

it('removes retained retry text and resets mounted forms after an executor denies access', async () => {
  const { model, remote } = collaborationGuiFixture()
  await model.open()
  remote.sendGroupMessage.mockRejectedValueOnce(new Error('Response lost'))
  await model.send(guiGroup.id, 'Private retry text', [], [])
  const epoch = model.state.getSnapshot().epoch
  remote.groupPage.mockResolvedValueOnce(guiDenied())
  await model.loadGroup(guiGroup.id)
  expect(model.state.getSnapshot()).toMatchObject({ pendingMessages: [], group: null, inbox: null, error: 'collaborationDenied' })
  expect(model.state.getSnapshot().epoch).toBeGreaterThan(epoch)
  model.dispose()
})

it('contains notification permission failures and ignores permission resolved after closing and reopening', async () => {
  const { model, desktop, remote } = collaborationGuiFixture()
  await model.open()
  desktop.requestPermission.mockRejectedValueOnce(new Error('OS permission dialog unavailable'))
  await expect(model.allowDesktop()).resolves.toBe(false)
  expect(model.state.getSnapshot().feedback?.key).toBe('collaborationDesktopDenied')
  const permission = guiDeferred<string>()
  desktop.requestPermission.mockReturnValueOnce(permission.promise)
  const allowing = model.allowDesktop()
  model.close()
  await model.open()
  permission.resolve('granted')
  expect(await allowing).toBe(false)
  expect(remote.saveMessagePreferences).not.toHaveBeenCalled()
  model.dispose()
})

it('loads central policy and actual usage even when the separate audit query is denied', async () => {
  const { model, remote } = collaborationGuiFixture()
  await model.open()
  remote.governanceAudit.mockResolvedValueOnce(guiDenied())
  await model.loadGovernance()
  expect(model.state.getSnapshot()).toMatchObject({ governance: { revision: 0, policy: null }, usage: { settlements: 0 },
    audit: null, governanceErrors: { audit: 'collaborationAuditUnavailable', usage: null }, error: null })
  model.dispose()
})

it('keeps the selected group and its confirmed new revision after a membership update', async () => {
  const { model, remote } = collaborationGuiFixture()
  await model.open()
  await model.loadGroup(guiGroup.id)
  const updated = { ...guiGroup, revision: 4 }
  remote.updateGroup.mockResolvedValueOnce(guiOk(updated))
  remote.groupList.mockResolvedValueOnce(guiOk([updated]))
  expect(await model.updateGroup({ ...updated, revision: 3, memberIds: updated.members.map(member => member.memberId) })).toBe(true)
  expect(model.state.getSnapshot().group?.group.revision).toBe(4)
  model.dispose()
})

it('does not present a stale desktop claim after closing and reopening the same employee dialog', async () => {
  const { model, remote, desktop } = collaborationGuiFixture()
  desktop.permission.mockReturnValue('granted')
  await model.open()
  const pending = guiDeferred<Awaited<ReturnType<OfficeCollaborationRemote['claimDesktopDelivery']>>>()
  remote.claimDesktopDelivery.mockReturnValueOnce(pending.promise)
  const deviceId = '5e92f8b8-d5cc-4f28-ad64-38dfb1ec090a'
  const displaying = model.showDesktop('item:existing', deviceId)
  const memberId = model.state.getSnapshot().principal!.id
  model.close()
  await model.open()
  pending.resolve(guiOk({ id: 'ad8665f6-807b-4f2b-b9cd-7cc7065e160d', memberId, deviceId, key: 'item:existing',
    stage: 'pending', attempt: 1, claimedAt: 1, leaseUntil: 1000000, preferenceRevision: 1 }))
  expect(await displaying).toBe(false)
  expect(desktop.show).not.toHaveBeenCalled()
  expect(remote.settleDesktopDelivery).not.toHaveBeenCalled()
  model.dispose()
})

it('does not publish a late mutation after an independent desktop authorization denial', async () => {
  const { model, remote, desktop } = collaborationGuiFixture()
  desktop.permission.mockReturnValue('granted')
  await model.open()
  const pending = guiDeferred<Awaited<ReturnType<OfficeCollaborationRemote['saveMessagePreferences']>>>()
  remote.saveMessagePreferences.mockReturnValueOnce(pending.promise)
  const preferences = model.state.getSnapshot().preferences!
  const saving = model.savePreferences(preferences)
  remote.claimDesktopDelivery.mockResolvedValueOnce(guiDenied())
  await model.showDesktop('item:existing', '5e92f8b8-d5cc-4f28-ad64-38dfb1ec090a')
  pending.resolve(guiOk({ ...preferences, revision: 2 }))
  expect(await saving).toBe(false)
  expect(model.state.getSnapshot()).toMatchObject({ preferences: null, inbox: null, error: 'collaborationDenied' })
  model.dispose()
})

it('does not reload administrative views for a replacement identity when an older action settles', async () => {
  const { model, remote } = collaborationGuiFixture()
  await model.open()
  const pending = guiDeferred<Awaited<ReturnType<OfficeCollaborationRemote['offboardMember']>>>()
  remote.offboardMember.mockReturnValueOnce(pending.promise)
  const offboarding = model.offboard({ memberId: guiPeer.id, revision: 0,
    requestId: '2ef1f084-bef6-4cec-b452-b190edaa60ce' })
  model.bind(guiPeer, [guiPeer])
  await model.open()
  pending.resolve(guiDenied())
  expect(await offboarding).toBe(false)
  expect(remote.identityGovernance).not.toHaveBeenCalled()
  model.dispose()
})
