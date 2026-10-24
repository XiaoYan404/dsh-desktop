/** Safe office responses; transport failures remain in the outer RemoteResult. */
export type { OfficePromptContextSource, OfficeFilesPromptContextSource } from './native-context-types.ts'
export type { OfficeMemberInviteCapability } from '@deepseek-ai/dsh-enterprise-office/types'
export type { OfficeAppearance, OfficeAssistant, OfficeAssistantInput, OfficeExperienceView, ExperienceOutcome } from './experience/types.ts'
import type {
  OfficeErrorCode,
  OfficeMember,
} from '@deepseek-ai/dsh-enterprise-office/types'
/** Expected business denial is distinct from an unavailable transport or storage failure. */
export type OfficeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: OfficeErrorCode }

/** Public connection state never contains a password, bearer token or credential reference value. */
export interface OfficeConnection {
  readonly mode: 'local' | 'gateway'
  readonly gateway: string | null
  readonly connected: boolean
  readonly member: OfficeMember | null
  readonly expiresAt: number | null
}

/** Deployment-owned relationship to one package in this employee Host's existing plugin manager. */
export interface OfficeIntegrationPlugin {
  readonly adapterId: string
  readonly packageName: string
  /** Null when this Host cannot inspect persistent profile management. */
  readonly bundle: {
    readonly installed: boolean
    readonly availability: 'installation' | 'profile' | 'missing'
    readonly enabled: boolean
    readonly version: string | null
    readonly problem: boolean
    readonly activeRows: number
    readonly pendingRows: number
    readonly failedRows: number
    readonly totalRows: number
  } | null
}

/** Current local profile observation, separate from company connection readiness and remote server deployment. */
export interface OfficeIntegrationPlugins {
  readonly meId: OfficeMember['id']
  readonly mode: OfficeConnection['mode']
  readonly managementAvailable: boolean
  readonly packages: readonly OfficeIntegrationPlugin[]
}
