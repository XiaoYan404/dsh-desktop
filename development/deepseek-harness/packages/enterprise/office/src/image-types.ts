/** Submitted-image source identities and explicit authority limits; Native attachment normalization remains separate. */
import type {
  OfficeConversationFileReference, OfficeConversationFilesCaptureId, OfficeDriveId, OfficeDriveVersionId, OfficeErrorCode,
} from './types.ts'

/** Source content is fetched once; the second operation rechecks the same submitted immutable selection. */
export type OfficeConversationImageReadInput =
  | { readonly kind: 'read'; readonly captureId: OfficeConversationFilesCaptureId; readonly fileId: OfficeDriveId }
  | { readonly kind: 'recheck'; readonly captureId: OfficeConversationFilesCaptureId; readonly fileId: OfficeDriveId;
    readonly versionId: OfficeDriveVersionId; readonly sha256: string }

/** Successful source bytes passed central raster admission; Native must independently normalize and recheck before publishing an image block. */
export type OfficeConversationImageRead =
  | { readonly kind: 'read'; readonly file: OfficeConversationFileReference; readonly dataBase64: string }
  | { readonly kind: 'recheck'; readonly file: OfficeConversationFileReference }

/** Authenticated BFF business result, after the Native transport envelope is unwrapped. */
export type OfficeConversationImageResult =
  | { readonly ok: true; readonly value: OfficeConversationImageRead }
  | { readonly ok: false; readonly code: OfficeErrorCode }

/** Raster media admitted by the version-one source reader. */
export type OfficeImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Required explicit limits when Office imageRead is enabled; omission of that field keeps it disabled. */
export interface OfficeImagePolicy {
  /** Positive integer encoded source bytes, 1..20 MiB, checked before source allocation; response expansion has a separate limit. */
  readonly maxSourceBytes: number
  /** Positive integer intrinsic width times height, 1..67,108,864 pixels; this does not limit process RSS. */
  readonly maxSourcePixels: number
  /** Positive integer maximum intrinsic width or height, 1..8192 pixels per side. */
  readonly maxSourceDimension: number
  /** Positive integer bytes, 128..16 MiB, for the complete UTF-8 JSON success envelope including metadata and base64. */
  readonly maxResponseBytes: number
  /** Explicit accepted formats; at least one, no duplicates. */
  readonly mediaTypes: OfficeImageMediaType[]
}
