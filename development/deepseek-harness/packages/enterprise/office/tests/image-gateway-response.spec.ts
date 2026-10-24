/** One new full-response check through the real Gateway; old image authority and Native suites are not selected. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import OfficeService from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeConversationImageRead } from '@deepseek-ai/dsh-enterprise-office/types'
import { resolveOfficeImagePolicy } from '../src/image-authority.ts'
import { imagePolicy, officeConfig, paddedPng, submit, withGateway } from './image-gateway-fixture.ts'

it('keeps the complete image envelope within the real Gateway limit including metadata and base64', async () => {
  const limit = 16 * 1024 * 1024
  const config = officeConfig(join(import.meta.dirname, 'schema-only-home'))
  expect(OfficeService.Config(config).imageRead).toBeUndefined()
  expect(resolveOfficeImagePolicy(undefined)).toBeUndefined()
  expect(() => OfficeService.Config({ ...config, imageRead: { ...imagePolicy, maxResponseBytes: limit + 1 } })).toThrow()
  expect(() => resolveOfficeImagePolicy({ ...imagePolicy, maxResponseBytes: limit + 1 }))
    .toThrow(expect.objectContaining({ code: 'invalid_input' }))
  for (const key of ['maxSourceBytes', 'maxSourcePixels', 'maxSourceDimension', 'maxResponseBytes'] as const) {
    expect(() => OfficeService.Config({ ...config, imageRead: { ...imagePolicy, [key]: 0 } })).toThrow()
    expect(() => OfficeService.Config({ ...config, imageRead: { ...imagePolicy, [key]: 1.5 } })).toThrow()
  }
  const acceptedSource = await paddedPng(12 * 1024 * 1024 - 1024)
  const oversizedSource = await paddedPng(12 * 1024 * 1024)
  await withGateway(async (office, gateway) => {
    const accepted = await submit(office, acceptedSource)
    const result = await gateway.operation<OfficeConversationImageRead>('readConversationImage', [accepted.input])
    if (result.kind !== 'read') throw new Error('Gateway did not deliver the full image response')
    const responseBytes = Buffer.byteLength(JSON.stringify({ ok: true, value: result }))
    expect(responseBytes).toBeLessThanOrEqual(limit)
    expect(responseBytes).toBeGreaterThan(limit - 2048)
    expect(result.file).toEqual(accepted.file)
    const digest = createHash('sha256').update(Buffer.from(result.dataBase64, 'base64')).digest('hex')
    expect(digest).toBe(accepted.file.sha256)
    const oversized = await submit(office, oversizedSource)
    const empty = { ok: true, value: { kind: 'read', file: oversized.file, dataBase64: '' } }
    const rejectedEnvelopeBytes = Buffer.byteLength(JSON.stringify(empty)) + 4 * Math.ceil(oversizedSource.length / 3)
    expect(4 * Math.ceil(oversizedSource.length / 3)).toBe(limit)
    expect(rejectedEnvelopeBytes).toBeGreaterThan(limit)
    await expect(gateway.operation('readConversationImage', [oversized.input]))
      .rejects.toMatchObject({ code: 'context_too_large' })
    await writeFile(new URL('../../../../.artifacts/parallel-handoff/02/gateway-response-evidence.json', import.meta.url), JSON.stringify({
      status: 'passed', acceptedSourceBytes: acceptedSource.length, acceptedResponseBytes: responseBytes,
      rejectedSourceBytes: oversizedSource.length, rejectedExpectedResponseBytes: rejectedEnvelopeBytes,
      gatewayClientLimitBytes: limit, denial: 'context_too_large', sourceDigestRetained: true,
      realComponents: ['formal source OfficeService existing queue', 'JSON storage', 'Drive resumable upload',
        'immutable conversation capture', 'attachment-local prepareImageFile Sharp decoding',
        'actual OfficeGateway HTTP allowlist', 'existing OfficeGatewayClient'],
      sourcePlaneOnly: true, formalSourceWritten: true, nativeToolRun: false,
      credentialsOrEndpointRecorded: false,
    }, null, 2) + '\n')
  })
}, 30_000)
