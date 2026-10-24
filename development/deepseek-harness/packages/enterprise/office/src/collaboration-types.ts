/** Opaque coordinates and wire projections for identity and collaboration extensions. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { OfficeMemberId, OfficeDriveId, OfficeDriveVersionId, OfficeItemId } from './types.ts'
import type { OfficeMember, OfficeSessionId } from './types.ts'

/** Current original session and monotonic owner revisions; this evidence is never an execution grant. */
export interface OfficeNativeAuthority {
  readonly member: OfficeMember
  readonly sessionId: OfficeSessionId
  readonly scope: 'office' | 'files' | 'connectors' | 'chat' | 'sessions'
  readonly permissionRevision: {
    readonly office: number
    readonly governance: number
  }
}

/** Group ids disclose no membership or message access. */
export type OfficeGroupId = Branded<'OfficeGroupId'>
/** Immutable group message retry identity. */
export type OfficeGroupMessageId = Branded<'OfficeGroupMessageId'>
/** Repeat-series identity is minted by its organizer for idempotent submission. */
export type OfficeMeetingSeriesId = Branded<'OfficeMeetingSeriesId'>
/** Server-validated delivery kinds reuse their original acknowledgement owners. */
export type OfficeInboxSource = 'item' | 'announcement' | 'reminder' | 'chat' | 'group' | 'mention'

/** Explicit limits apply to every newly added ledger; capacity failures never prune history. */
export interface OfficeCollaborationLimits {
  /** Maximum retained records across one ledger's collections (1–100000); overflow rejects the write without pruning history. */
  readonly maxEntries: number
  /** Maximum UTF-8 bytes for a complete ledger state (1024–268435456); overflow rejects the write without pruning history. */
  readonly maxBytes: number
  /** Maximum members in one group, including its owner (2–1000); larger membership changes are rejected. */
  readonly maxGroupMembers: number
  /** Maximum original schedule occurrences created by one repeat series (1–366); larger series are rejected. */
  readonly maxOccurrences: number
  /** Desktop attempt lease in milliseconds (1000–86400000); settlement after expiry becomes unknown and cannot replay automatically. */
  readonly deliveryLeaseMs: number
  /** Maximum desktop attempts per recipient, device and notice (1–10); only explicit retries after confirmed failure are allowed. */
  readonly maxDeliveryAttempts: number
}
/** Device-independent recipient preferences; revision zero denotes unsaved company defaults. */
export interface OfficeMessagePreferences {
  readonly revision: number
  readonly desktop: boolean
  readonly timeZone: string
  readonly sources: readonly OfficeInboxSource[]
  readonly quiet: { readonly start: string; readonly end: string } | null
}
/** An inbox entry carries an authorized link, never a second business payload snapshot. */
export interface OfficeUnifiedNotice {
  readonly key: string
  readonly source: OfficeInboxSource
  readonly targetId: string
  readonly title: string
  readonly time: number
  readonly read: boolean
}
/** One current group member; rejoining starts a new message visibility interval. */
export interface OfficeGroupMember {
  readonly memberId: OfficeMemberId
  readonly joinedAfter: number
}
/** Safe current group projection; platform administrators have no group-history bypass. */
export interface OfficeGroup {
  readonly id: OfficeGroupId
  readonly revision: number
  readonly name: string
  readonly ownerId: OfficeMemberId
  readonly members: readonly OfficeGroupMember[]
  readonly closed: boolean
}
/** Immutable references reuse current file permission and version checks on every download. */
export interface OfficeGroupAttachment {
  readonly fileId: OfficeDriveId
  readonly versionId: OfficeDriveVersionId
}
/** Group records preserve original authors and explicit member ids for mentions. */
export interface OfficeGroupMessage {
  readonly id: OfficeGroupMessageId
  readonly groupId: OfficeGroupId
  readonly sequence: number
  readonly senderId: OfficeMemberId
  readonly text: string
  readonly mentions: readonly OfficeMemberId[]
  readonly attachments: readonly OfficeGroupAttachment[]
  readonly createdAt: number
}
/** One bounded authorized group page and the recipient's monotonic read cursor. */
export interface OfficeGroupPage {
  readonly group: OfficeGroup
  readonly messages: readonly OfficeGroupMessage[]
  readonly next: number | null
  readonly readThrough: number
}
/** A committed series expands into original office schedules, invitations and reminder identities. */
export interface OfficeMeetingSeriesReceipt {
  readonly id: OfficeMeetingSeriesId
  readonly itemIds: readonly OfficeItemId[]
  readonly stage: 'reserved' | 'committed'
}
