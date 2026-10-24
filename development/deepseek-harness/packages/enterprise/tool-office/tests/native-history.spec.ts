/** Office affiliation survives replay without authorizing current work from future queue input. */
import { expect, it } from 'vitest'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { foldOfficeRunHistory, foldOfficeRunInheritance, officeRunHistoryProjection, officeRunHistorySchema } from '../src/native-history.ts'
import type { OfficeRunClaim } from '../src/native-claims.ts'
import { OfficeRunOwnership } from '../src/native-ownership.ts'

const lin = 'lin' as OfficeMemberId
const chen = 'chen' as OfficeMemberId
const employee: OfficeRunClaim = { memberId: lin, role: 'employee', matchesConversation: true }
const manager: OfficeRunClaim = { ...employee, role: 'manager' }
const empty = () => officeRunHistoryProjection.init()
const inherited = { parentSession: SessionId('parent'), owner: { memberId: lin, role: 'employee' as const }, mixed: false, invalid: false }

it('restores inherited affiliation from its required child record without a parent object', () => {
  const state = officeRunHistoryProjection.apply(empty(), {
    type: 'office/run-inherited', seq: SessionSeq(0), time: 1, data: inherited,
  })
  expect(state).toEqual({ owner: inherited.owner, mixed: false, invalid: false, inherited: true })
  expect(foldOfficeRunHistory(state, [], true)).toBe(state)
})

it('does not let later inherited or pending evidence replace an explicitly claimed role', () => {
  const state = foldOfficeRunInheritance(empty(), inherited)
  expect(foldOfficeRunHistory(state, [manager], false)).toBe(state)
  const reviewed = foldOfficeRunHistory(state, [manager], true)
  expect(foldOfficeRunInheritance(reviewed, inherited)).toBe(reviewed)
  expect(reviewed.owner?.role).toBe('manager')
})

it('retains inherited mixed-employee quarantine through later same-employee review', () => {
  const state = foldOfficeRunInheritance(empty(), { ...inherited, mixed: true, invalid: true })
  const reviewed = foldOfficeRunHistory(state, [manager], true)
  expect(reviewed).toMatchObject({ owner: { memberId: lin, role: 'manager' }, mixed: true })
  const owners = new OfficeRunOwnership()
  const scope = {}
  owners.restore(scope, reviewed)
  owners.claim(scope, [manager])
  expect(owners.get(scope)?.invalid).toBe(true)
})

it('rejects inherited conflicts and malformed stored evidence instead of clearing ownership', () => {
  expect(foldOfficeRunInheritance(foldOfficeRunHistory(empty(), [employee], true),
    { ...inherited, owner: { memberId: chen, role: 'employee' } })).toMatchObject({ mixed: true })
  for (const input of [null, {}, { ...inherited, owner: null }, { ...inherited, parentSession: '' },
    { ...inherited, owner: { memberId: lin, role: 'superuser' } }, { ...inherited, extra: true }]) {
    expect(() => foldOfficeRunInheritance(empty(), input)).toThrow()
  }
})

it('captures restriction values without retaining a disposed parent or omitting its quarantine', () => {
  const owners = new OfficeRunOwnership()
  const parent = {}
  owners.restore(parent, { owner: inherited.owner, mixed: true, invalid: false })
  const snapshot = owners.snapshot(parent)
  owners.delete(parent)
  expect(snapshot).toEqual({ owner: inherited.owner, mixed: true, invalid: true })
  expect(owners.snapshot(parent)).toEqual(empty())
})

it('leaves original Native histories unassociated and reuses state for unrelated inputs', () => {
  const state = empty()
  expect(foldOfficeRunHistory(state, [], false)).toBe(state)
  expect(foldOfficeRunHistory(state, [], true)).toBe(state)
})

it('pins the first admitted employee but changes the role only for claimed input', () => {
  const admitted = foldOfficeRunHistory(empty(), [employee], false)
  expect(admitted).toEqual({ owner: { memberId: lin, role: 'employee' }, mixed: false, invalid: false, pendingRole: true })
  expect(foldOfficeRunHistory(admitted, [manager], false)).toBe(admitted)
  const reviewed = foldOfficeRunHistory(admitted, [manager], true)
  expect(reviewed).toMatchObject({ owner: { role: 'manager' } })
  expect(foldOfficeRunHistory(reviewed, [], true)).toBe(reviewed)
})

it('retains cross-employee history conflicts even after a new input from the first employee', () => {
  const admitted = foldOfficeRunHistory(empty(), [employee], false)
  const mixed = foldOfficeRunHistory(admitted, [{ ...employee, memberId: chen }], false)
  expect(mixed).toMatchObject({ owner: { memberId: lin }, mixed: true })
  expect(foldOfficeRunHistory(mixed, [manager], true)).toMatchObject({ owner: { memberId: lin, role: 'manager' }, mixed: true })
})

it('requires a consistent role review while allowing the same employee to correct it explicitly', () => {
  const invalid = foldOfficeRunHistory(empty(), [employee, manager], true)
  expect(invalid.invalid).toBe(true)
  expect(foldOfficeRunHistory(invalid, [manager], false).invalid).toBe(true)
  expect(foldOfficeRunHistory(invalid, [manager], true)).toMatchObject({ invalid: false, owner: { role: 'manager' } })
})

it('restores a fresh live scope and preserves its newer claimed role across historical replay', () => {
  const owners = new OfficeRunOwnership()
  const scope = {}
  const history = foldOfficeRunHistory(empty(), [employee], true)
  owners.restore(scope, history)
  expect(owners.get(scope)).toEqual({ memberId: lin, role: 'employee', invalid: false })
  owners.claim(scope, [manager])
  const reviewed = owners.get(scope)
  owners.restore(scope, history)
  expect(owners.get(scope)).toBe(reviewed)
  expect(reviewed).toMatchObject({ role: 'manager', invalid: false })
})

it('does not let a new claim clear a mixed restored history or its delegated restriction', () => {
  const owners = new OfficeRunOwnership()
  const scope = {}
  const child = {}
  owners.restore(scope, { owner: { memberId: lin, role: 'employee' }, mixed: true, invalid: false })
  owners.claim(scope, [employee])
  expect(owners.get(scope)?.invalid).toBe(true)
  owners.inherit(child, scope)
  owners.claim(child, [employee])
  expect(owners.get(child)?.invalid).toBe(true)
})

it('rejects malformed stored projection state rather than treating it as an empty affiliation', () => {
  for (const state of [
    { owner: null, mixed: true, invalid: false },
    { owner: { memberId: '', role: 'employee' }, mixed: false, invalid: false },
    { owner: { memberId: lin, role: 'superuser' }, mixed: false, invalid: false },
    { owner: null, mixed: false, invalid: false, extra: true },
  ]) expect(officeRunHistorySchema.safeParse(state).success).toBe(false)
  expect(officeRunHistorySchema.parse(empty())).toEqual(empty())
})
