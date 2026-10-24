/** Source capability gates image references without reading or copying image bytes. */
import { expect, it } from 'vitest'
import type { OfficeConversationFileLimits } from '@deepseek-ai/dsh-enterprise-office/types'
import { officeFileReferenceSupported } from '../src/client/file-associations-model.ts'

it('offers only nonempty advertised raster references within their source-byte limit', () => {
  const withoutImage: OfficeConversationFileLimits = { protocol: 1, maxSelectedFiles: 10,
    maxTextBytes: 1048576, maxCharacters: 16384 }
  const limits: OfficeConversationFileLimits = { ...withoutImage, image: { protocol: 1, maxBytes: 1024, maxPixels: 4096, maxDimension: 128,
      maxResponseBytes: 8192, mediaTypes: ['image/png'], firstFrame: true } }
  const file = { name: 'reviewed.png', mediaType: 'image/png', byteLength: 1024 }
  expect(officeFileReferenceSupported(file, limits)).toBe(true)
  expect(officeFileReferenceSupported(file, withoutImage)).toBe(false)
  expect(officeFileReferenceSupported({ ...file, byteLength: 1025 }, limits)).toBe(false)
  expect(officeFileReferenceSupported({ ...file, byteLength: 0 }, limits)).toBe(false)
  expect(officeFileReferenceSupported({ ...file, mediaType: 'image/svg+xml' }, limits)).toBe(false)
  expect(officeFileReferenceSupported({ ...file, mediaType: 'application/octet-stream' }, limits)).toBe(false)
})

it.each(['image/png; charset=utf-8', 'IMAGE/PNG'])('does not advertise a raster MIME spelling rejected by the authoritative allowlist (%s)', (mediaType) => {
  const limits: OfficeConversationFileLimits = { protocol: 1, maxSelectedFiles: 10, maxTextBytes: 1048576,
    maxCharacters: 16384, image: { protocol: 1, maxBytes: 1024, maxPixels: 4096, maxDimension: 128,
      maxResponseBytes: 8192, mediaTypes: ['image/png'], firstFrame: true } }
  expect(officeFileReferenceSupported({ name: 'reviewed.png', mediaType, byteLength: 512 }, limits)).toBe(false)
})
