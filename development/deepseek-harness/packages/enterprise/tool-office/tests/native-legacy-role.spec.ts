/** A legacy child's future queued role cannot precede recovery of its actual inherited role. */
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { OfficeMemberId } from '@deepseek-ai/dsh-enterprise-office/types'
import { foldOfficeRunHistory, foldOfficeRunInheritance, officeRunHistoryProjection } from '../src/native-history.ts'
import { OfficeRunOwnership } from '../src/native-ownership.ts'

const memberId = 'lin' as OfficeMemberId
const manager = { memberId, role: 'manager' as const, matchesConversation: true }
const inherited = { parentSession: SessionId('original-parent'), owner: { memberId, role: 'employee' as const }, mixed: false, invalid: false }

it('replaces a merely pending role with the proven creation role before its queued review is claimed', () => {
  const pending = foldOfficeRunHistory(officeRunHistoryProjection.init(), [manager], false)
  const recovered = foldOfficeRunInheritance(pending, inherited)
  expect(recovered).toEqual({ owner: inherited.owner, mixed: false, invalid: false, inherited: true })
  const reviewed = foldOfficeRunHistory(recovered, [manager], true)
  expect(reviewed.owner?.role).toBe('manager')
  expect(reviewed.inherited).toBe(true)
  expect(reviewed.pendingRole).toBeUndefined()
})

it('retains an explicitly claimed child role when legacy inheritance is recovered later', () => {
  const reviewed = foldOfficeRunHistory(officeRunHistoryProjection.init(), [manager], true)
  expect(foldOfficeRunInheritance(reviewed, inherited)).toMatchObject({ owner: { role: 'manager' }, inherited: true })
})

it('updates a cached pending role after ancestry recovery but preserves an actually claimed live role', () => {
  const pending = foldOfficeRunHistory(officeRunHistoryProjection.init(), [manager], false)
  const recovered = foldOfficeRunInheritance(pending, inherited)
  for (const claimed of [false, true]) {
    const scope = {}
    const owners = new OfficeRunOwnership()
    owners.restore(scope, pending)
    if (claimed) owners.claim(scope, [manager])
    owners.restore(scope, recovered)
    expect(owners.get(scope)?.role).toBe(claimed ? 'manager' : 'employee')
  }
})
