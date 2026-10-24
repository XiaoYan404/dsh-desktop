/** Collaboration overlay props derive from Slots and current owner observables. */
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { OfficeCollaborationModel } from './collaboration-model.ts'
import type { OfficeDriveModel } from './drive-model.ts'
import type { CollaborationKey } from './collaboration-copy.ts'
import type { OfficeGroupAttachment, OfficeGroupId } from '@deepseek-ai/dsh-enterprise-office/src/collaboration-types.ts'
import type { OfficeDriveId } from '@deepseek-ai/dsh-enterprise-office/types'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'office.collaboration': CollaborationKey }
}
/** Only callbacks and observable sources cross the composition registration. */
export interface OfficeCollaborationInjected {
  readonly hooks: { readonly collaboration: OfficeCollaborationModel['state']; readonly groupDrive: OfficeDriveModel['state'] }
  closeCollaboration(this: void): void
  refreshCollaboration(this: void): void
  filterCollaboration: OfficeCollaborationModel['filter']
  moreCollaboration: OfficeCollaborationModel['moreInbox']
  saveCollaborationPreferences: OfficeCollaborationModel['savePreferences']
  enableCollaborationDesktop: OfficeCollaborationModel['allowDesktop']
  openCollaborationNotice: OfficeCollaborationModel['openNotice']
  retryCollaborationDesktop(this: void, key: string): Promise<boolean>
  createCollaborationGroup: OfficeCollaborationModel['createGroup']
  updateCollaborationGroup: OfficeCollaborationModel['updateGroup']
  loadCollaborationGroup: OfficeCollaborationModel['loadGroup']
  leaveCollaborationGroup: OfficeCollaborationModel['leaveGroup']
  sendCollaborationMessage: OfficeCollaborationModel['send']
  createCollaborationMeetings: OfficeCollaborationModel['createMeetings']
  loadCollaborationGovernance: OfficeCollaborationModel['loadGovernance']
  offboardCollaborationMember: OfficeCollaborationModel['offboard']
  saveCollaborationPolicy: OfficeCollaborationModel['savePolicy']
  restoreCollaborationMember: OfficeCollaborationModel['restore']
  resolveCollaborationFile(this: void, id: OfficeDriveId): Promise<OfficeGroupAttachment | null>
  downloadCollaborationFile(this: void, groupId: OfficeGroupId, messageId: string, file: OfficeGroupAttachment): Promise<void>
  fieldCollaborationAudit: OfficeCollaborationModel['fieldAudit']
  searchCollaborationAudit: OfficeCollaborationModel['searchAudit']
  moreCollaborationAudit: OfficeCollaborationModel['moreAudit']
  exportCollaborationAudit(this: void): Promise<void>
}
/** Renderer provides the subscription hooks and translated copy; the component receives no services. */
export type OfficeCollaborationProps = PropsRuntime<'shell.overlay'> & PropsLocale<'office.collaboration'> & InjectFace<OfficeCollaborationInjected>
