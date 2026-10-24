/** Account changes fence private metadata and preserve confirmed identity on ordinary network failures. */
import { describe, expect, it, vi } from 'vitest'
import type { OfficeConnection, OfficeOutcome } from '../src/types.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { OfficeIdentityOverview, OfficeMemberId, OfficeSessionId, OfficeSessionInfo } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeConnectionModel } from '../src/client/connection-model.ts'

const me = 'lin' as OfficeMemberId
const other = 'chen' as OfficeMemberId
const id = 'c16ef32e-a4d3-4197-80e3-3ca761981f29' as OfficeSessionId
const disconnected: OfficeConnection = { mode: 'gateway', gateway: 'https://office.example/', connected: false, member: null, expiresAt: null }
const connected: OfficeConnection = { ...disconnected, connected: true, member: { id: me, name: 'Lin', active: true, role: 'employee', department: 'Office', jobTitle: 'Employee', email: '', phone: '' }, expiresAt: 123456 }
const own: OfficeSessionInfo = { id, createdAt: 1, expiresAt: 123456, current: true }
const success = <T>(value: T): RemoteResult<OfficeOutcome<T>> => ({ ok: true, value: { ok: true, value } })
const remote = () => ({
  connection: vi.fn<() => Promise<RemoteResult<OfficeOutcome<OfficeConnection>>>>().mockResolvedValue(success(disconnected)),
  signIn: vi.fn<() => Promise<RemoteResult<OfficeOutcome<OfficeConnection>>>>().mockResolvedValue(success(connected)),
  signOut: vi.fn<() => Promise<RemoteResult<OfficeOutcome<null>>>>().mockResolvedValue(success(null)),
  identitySessions: vi.fn<() => Promise<RemoteResult<OfficeOutcome<readonly OfficeSessionInfo[]>>>>().mockResolvedValue(success([own])),
  revokeIdentitySession: vi.fn<() => Promise<RemoteResult<OfficeOutcome<null>>>>().mockResolvedValue(success(null)),
  changeIdentityPassword: vi.fn<() => Promise<RemoteResult<OfficeOutcome<null>>>>().mockResolvedValue(success(null)),
  identityOverview: vi.fn<() => Promise<RemoteResult<OfficeOutcome<OfficeIdentityOverview>>>>()
    .mockResolvedValue(success({ initialized: true, enrolledMemberIds: [me] })),
  setIdentityPassword: vi.fn<() => Promise<RemoteResult<OfficeOutcome<null>>>>().mockResolvedValue(success(null)),
})
function create(api = remote()) {
  const changed = vi.fn()
  const notify = vi.fn()
  const model = new OfficeConnectionModel(api, changed, notify)
  return { api, model, changed, notify }
}

describe('OfficeConnectionModel', () => {
  it('defers identity reads while an admitted sign-in owns its public result', async () => {
    const { model, api, changed } = create()
    await model.load()
    changed.mockClear()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnection>>>()
    api.signIn.mockReturnValueOnce(pending.promise)
    const signingIn = model.signIn({ memberId: me, password: 'private test password' })
    api.connection.mockResolvedValueOnce(success(connected))
    await model.load()
    expect(api.connection).toHaveBeenCalledTimes(1)
    expect(model.state.getSnapshot()).toMatchObject({ busy: true, connection: disconnected })
    expect(changed).not.toHaveBeenCalled()
    pending.resolve(success(connected))
    expect(await signingIn).toBe(true)
    expect(model.state.getSnapshot()).toMatchObject({ busy: false, connection: connected })
    expect(changed).toHaveBeenCalledOnce()
  })

  it('publishes only confirmed public identity and never stores a password in snapshots', async () => {
    const { model, api, changed } = create()
    await model.load()
    changed.mockClear()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnection>>>()
    api.signIn.mockReturnValueOnce(pending.promise)
    const input = { memberId: me, password: 'private test password' }
    const signingIn = model.signIn(input)
    expect(model.state.getSnapshot()).toMatchObject({ connection: disconnected, busy: true })
    expect(changed).not.toHaveBeenCalled()
    expect(JSON.stringify(model.state.getSnapshot())).not.toContain(input.password)
    pending.resolve(success(connected))
    expect(await signingIn).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(model.state.getSnapshot()).toMatchObject({ connection: connected, busy: false })
    expect(api.signIn).toHaveBeenCalledWith(input)
    model.dispose()
  })

  it('keeps confirmed identity on transport failure and clears old account metadata after revocation', async () => {
    const { model, api, changed } = create()
    api.connection.mockResolvedValue(success(connected))
    await model.load()
    await model.loadSessions()
    await model.loadEnrollment()
    api.connection.mockRejectedValueOnce(new Error('Offline'))
    await model.load()
    expect(model.state.getSnapshot()).toMatchObject({ connection: connected, sessions: [own], error: 'unavailable' })
    api.connection.mockResolvedValueOnce(success(disconnected))
    await model.load()
    expect(model.state.getSnapshot()).toMatchObject({ connection: disconnected, sessions: null, enrollment: null })
    expect(changed).toHaveBeenCalledTimes(2)
    model.dispose()
  })

  it('fences old session and enrollment queries after signing out', async () => {
    const { model, api } = create()
    api.connection.mockResolvedValueOnce(success(connected)).mockResolvedValue(success(disconnected))
    await model.load()
    const sessions = Promise.withResolvers<RemoteResult<OfficeOutcome<readonly OfficeSessionInfo[]>>>()
    const enrollment = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeIdentityOverview>>>()
    api.identitySessions.mockReturnValueOnce(sessions.promise)
    api.identityOverview.mockReturnValueOnce(enrollment.promise)
    const first = model.loadSessions()
    const second = model.loadEnrollment()
    expect(await model.signOut()).toBe(true)
    sessions.resolve(success([own]))
    enrollment.resolve(success({ initialized: true, enrolledMemberIds: [me] }))
    await Promise.all([first, second])
    expect(model.state.getSnapshot()).toMatchObject({ connection: disconnected, sessions: null, enrollment: null, busy: false })
    model.dispose()
  })

  it('fences an old connection read after a successful replacement login', async () => {
    const { model, api } = create()
    const old = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnection>>>()
    api.connection.mockReturnValueOnce(old.promise)
    const reading = model.load()
    const replacement: OfficeConnection = { ...connected, member: { ...connected.member!, id: other } }
    api.signIn.mockResolvedValueOnce(success(replacement))
    expect(await model.signIn({ memberId: other, password: 'a private password' })).toBe(true)
    old.resolve(success(connected))
    await reading
    expect(model.state.getSnapshot().connection?.member?.id).toBe(other)
    model.dispose()
  })

  it('allows one account mutation and preserves identity when logout fails to commit', async () => {
    const { model, api, notify } = create()
    api.connection.mockResolvedValue(success(connected))
    await model.load()
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<null>>>()
    api.signOut.mockReturnValueOnce(pending.promise)
    const signingOut = model.signOut()
    expect(await model.changePassword({ currentPassword: 'old', newPassword: 'replacement password' })).toBe(false)
    expect(api.changeIdentityPassword).not.toHaveBeenCalled()
    pending.reject(new Error('Unavailable'))
    expect(await signingOut).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({ connection: connected, busy: false, error: 'unavailable' })
    expect(notify).toHaveBeenCalledWith('unavailable', false)
    model.dispose()
  })

  it('clears private metadata when its authenticated query is denied and ignores plugin-unload responses', async () => {
    const { model, api } = create()
    api.connection.mockResolvedValue(success(connected))
    await model.load()
    await model.loadSessions()
    api.identitySessions.mockResolvedValueOnce({ ok: true, value: { ok: false, code: 'unauthenticated' } })
    await model.loadSessions()
    expect(model.state.getSnapshot()).toMatchObject({ connection: disconnected, sessions: null, enrollment: null, error: 'unauthenticated' })
    const pending = Promise.withResolvers<RemoteResult<OfficeOutcome<OfficeConnection>>>()
    api.signIn.mockReturnValueOnce(pending.promise)
    const signingIn = model.signIn({ memberId: me, password: 'a private password' })
    model.dispose()
    pending.resolve(success(connected))
    expect(await signingIn).toBe(false)
    expect(model.state.getSnapshot()).toMatchObject({ connection: null, sessions: null, busy: false })
  })
})
