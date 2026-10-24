/** Live employee ownership cannot be removed by steering, cross-account claims or delegated scopes. */
import { expect, it } from 'vitest'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { OfficeRunOwnership, type OfficeRunClaim } from '../src/native-ownership.ts'

const lin = 'lin' as OfficeMemberId
const chen = 'chen' as OfficeMemberId
const claim: OfficeRunClaim = { memberId: lin, role: 'employee', matchesConversation: true }

it('leaves original unassociated Native scopes without office ownership', () => {
  const owners = new OfficeRunOwnership()
  const root = {}
  const child = {}
  bindScopeParent(child, root)
  owners.claim(root, [])
  expect(owners.get(root)).toBeUndefined()
  expect(owners.get(child)).toBeUndefined()
})

it('retains employee ownership across unassociated steering and repeated identical claims', () => {
  const owners = new OfficeRunOwnership()
  const agent = {}
  owners.claim(agent, [claim])
  const original = owners.get(agent)
  owners.claim(agent, [])
  owners.claim(agent, [{ ...claim }])
  expect(owners.get(agent)).toBe(original)
})

it('pins the first employee, refuses another employee and only recovers through the original employee', () => {
  const owners = new OfficeRunOwnership()
  const agent = {}
  owners.claim(agent, [claim])
  owners.claim(agent, [{ ...claim, memberId: chen }])
  expect(owners.get(agent)).toEqual({ memberId: lin, role: 'employee', invalid: true })
  owners.claim(agent, [{ ...claim, memberId: chen }])
  expect(owners.get(agent)).toMatchObject({ memberId: lin, invalid: true })
  owners.claim(agent, [claim])
  expect(owners.get(agent)).toMatchObject({ memberId: lin, invalid: false })
})

it('requires both submitted contexts to agree on employee, role and exact Native conversation', () => {
  for (const other of [{ ...claim, memberId: chen }, { ...claim, role: 'manager' as const },
    { ...claim, matchesConversation: false }]) {
    const owners = new OfficeRunOwnership()
    const agent = {}
    owners.claim(agent, [claim, other])
    expect(owners.get(agent)).toMatchObject({ memberId: lin, invalid: true })
  }
})

it('fences earlier asynchronous checks when the same employee explicitly claims a new role', () => {
  const owners = new OfficeRunOwnership()
  const agent = {}
  owners.claim(agent, [claim])
  const before = owners.get(agent)
  owners.claim(agent, [{ ...claim, role: 'manager' }])
  expect(owners.get(agent)).not.toBe(before)
  expect(owners.get(agent)).toEqual({ memberId: lin, role: 'manager', invalid: false })
})

it('retains delegated ownership after the parent ends and cannot adopt another employee', () => {
  const owners = new OfficeRunOwnership()
  const root = {}
  const child = {}
  const nested = {}
  bindScopeParent(child, root)
  bindScopeParent(nested, child)
  owners.claim(root, [claim])
  expect(owners.get(child)).toEqual(owners.get(root))
  expect(owners.get(nested)).toEqual(owners.get(root))
  owners.delete(root)
  owners.claim(child, [])
  expect(owners.get(child)).toMatchObject({ memberId: lin, invalid: false })
  owners.claim(child, [{ ...claim, memberId: chen }])
  expect(owners.get(child)).toMatchObject({ memberId: lin, invalid: true })
  expect(owners.get(nested)).toMatchObject({ memberId: lin, invalid: false })
})

it('inherits the explicit runtime parent when an SDK creates a child through the global service', () => {
  const owners = new OfficeRunOwnership()
  const root = {}
  const child = {}
  owners.claim(root, [claim])
  owners.inherit(child, root)
  owners.delete(root)
  expect(owners.get(child)).toEqual({ memberId: lin, role: 'employee', invalid: false })
  owners.claim(child, [])
  owners.claim(child, [{ ...claim, memberId: chen }])
  expect(owners.get(child)).toMatchObject({ memberId: lin, invalid: true })
})

it('keeps a child role snapshot separate from the parent new submission and unrelated scopes', () => {
  const owners = new OfficeRunOwnership()
  const root = {}
  const child = {}
  bindScopeParent(child, root)
  owners.claim(root, [claim])
  owners.get(child)
  owners.claim(root, [{ ...claim, role: 'manager' }])
  expect(owners.get(child)).toMatchObject({ role: 'employee' })
  expect(owners.get({})).toBeUndefined()
})

it('releases disposed scopes and all private runtime state on plugin unload', () => {
  const owners = new OfficeRunOwnership()
  const one = {}
  const two = {}
  owners.claim(one, [claim])
  owners.claim(two, [{ ...claim, memberId: chen }])
  owners.delete(one)
  expect(owners.get(one)).toBeUndefined()
  owners.clear()
  expect(owners.get(two)).toBeUndefined()
})
