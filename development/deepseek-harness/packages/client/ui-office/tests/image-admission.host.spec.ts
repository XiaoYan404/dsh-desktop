/** Authenticated preparation hints stay independent of immutable capture history and source read authority. */
import { expect, it } from 'vitest'
import type { OfficeConversationFilesCapture, OfficeConversationFilesView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeConnection } from '../src/types.ts'
import { OfficeImageAdmissions } from '../src/image-admission.ts'

const connection: OfficeConnection = { mode: 'local', gateway: null, connected: true, expiresAt: null,
  member: { id: 'image-member', name: 'Image member', department: 'Office', jobTitle: 'Member', role: 'employee',
    active: true, email: '', phone: '' } } as OfficeConnection
const capture = { memberId: 'image-member', role: 'employee', selection: { conversationId: 'image-conversation' } } as OfficeConversationFilesCapture
const view = { meId: 'image-member', role: 'employee', conversationId: 'image-conversation', limits: { image: {
  protocol: 1, maxBytes: 1024, maxPixels: 4096, maxDimension: 128, maxResponseBytes: 8192,
  mediaTypes: ['image/png'], firstFrame: true,
} } } as OfficeConversationFilesView

it('keeps unknown hints absent and drops prepared image capability on account or role withdrawal', () => {
  const hints = new OfficeImageAdmissions()
  expect(hints.forCapture(capture)).toBeUndefined()
  expect(hints.prepare(hints.generation, connection, capture, view)).toBe(true)
  expect(hints.forCapture(capture)).toEqual(view.limits.image)
  expect(hints.forCapture({ ...capture, role: 'manager' })).toBeUndefined()
  hints.observe({ ...connection, connected: false, member: null })
  expect(hints.forCapture(capture)).toBeUndefined()
  expect(hints.prepare(hints.generation, connection, capture, view)).toBe(true)
  hints.observe({ ...connection, member: connection.member ? { ...connection.member, role: 'manager' } : null })
  expect(hints.forCapture(capture)).toBeUndefined()
})

it('does not publish a delayed preparation after an identity operation and withdraws an absent authority capability', () => {
  const hints = new OfficeImageAdmissions()
  const old = hints.generation
  hints.clear()
  expect(hints.prepare(old, connection, capture, view)).toBe(false)
  expect(hints.prepare(hints.generation, connection, capture, view)).toBe(true)
  expect(hints.prepare(hints.generation, connection, capture, { ...view, limits: { ...view.limits, image: undefined } })).toBe(false)
  expect(hints.forCapture(capture)).toBeUndefined()
})
