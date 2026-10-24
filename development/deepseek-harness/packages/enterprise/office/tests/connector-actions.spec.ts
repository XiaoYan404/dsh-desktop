/** Complete declaration frames, including multibyte text and version coordinates, have a finite admission budget. */
import { expect, it } from 'vitest'
import { snapshotConnectorActions, validateConnectorWriteValues } from '../src/connector-actions.ts'
import type { OfficeConnectorActionDeclaration } from '../src/types.ts'

it('admits the exact complete-frame limit and rejects one byte less without dropping fields', () => {
  const input: OfficeConnectorActionDeclaration = { id: 'read-self', label: 'Employee requests', description: '文'.repeat(400),
    kind: 'read', allowedRoles: ['employee'] }
  const publicFields = { id: input.id, label: input.label, description: input.description, kind: input.kind }
  const maximumFrame = { integrationId: '00000000-0000-4000-8000-000000000000', connectionRevision: Number.MAX_SAFE_INTEGER,
    adapterRevision: '00000000-0000-4000-8000-000000000000', status: 'credential_unavailable', actions: [publicFields],
    readSupported: false, writeSupported: false }
  const bytes = Buffer.byteLength(JSON.stringify(maximumFrame), 'utf8')
  expect(bytes).toBeGreaterThan(JSON.stringify(maximumFrame).length)
  expect(snapshotConnectorActions([input], { count: 1, bytes })).toEqual([input])
  expect(() => snapshotConnectorActions([input], { count: 1, bytes: bytes - 1 }))
    .toThrow('Connector action directory exceeds its configured byte limit')
})

it('freezes exact write field declarations and rejects duplicate names, read fields and unknown business keys', () => {
  const input: OfficeConnectorActionDeclaration = { id: 'submit', label: 'Submit', description: '', kind: 'write',
    allowedRoles: ['employee'], fields: [{ name: 'title', label: 'Title', required: true, maxLength: 8 }] }
  const snapshot = snapshotConnectorActions([input], { count: 1, bytes: 4096 })[0]!
  expect(Object.isFrozen(snapshot.fields?.[0])).toBe(true)
  expect(validateConnectorWriteValues(snapshot, { title: '文 '.repeat(4) })).toEqual({ title: '文 '.repeat(4) })
  expect(() => validateConnectorWriteValues(snapshot, { title: 'x', member_id: 'admin' })).toThrow()
  expect(() => snapshotConnectorActions([{ ...input, kind: 'read' }], { count: 1, bytes: 4096 })).toThrow()
  expect(() => snapshotConnectorActions([{ ...input, fields: [...input.fields!, ...input.fields!] }], { count: 1, bytes: 4096 })).toThrow()
})
