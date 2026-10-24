/** Deployment readiness never upgrades a message receipt into a native task, delivery or completed business action. */
import { z } from 'zod'

/** Verified capability states; card and native-task schemas are deliberately absent until primary documentation is supplied. */
export interface OfficeWeComCapabilityReadiness {
  readonly profile: 'pending_configuration' | 'configured_unverified'
  readonly textMessage: 'pending_configuration' | 'configured_unverified'
  readonly nativeTodo: 'primary_protocol_required'
  readonly interactiveCard: 'primary_protocol_required'
  readonly completionCallback: 'primary_protocol_and_customer_callback_required'
  readonly customerConnected: false
  readonly receiptEvidence: 'local_provider_only'
  readonly missing: readonly string[]
}

/**
 * Inspect nonsecret deployment prerequisites without probing or asserting a live customer connection.
 * @param input - Deployment inventory booleans; values are observations, never credential values or user-entered tokens.
 * @returns Exact pending configuration and protocol dependencies; this function performs no network request.
 */
export function wecomCapabilityReadiness(input: { readonly appIdentityConfigured: boolean
  readonly credentialReferenceConfigured: boolean
  readonly employeeMappingConfigured: boolean
  readonly originAllowed: boolean }): OfficeWeComCapabilityReadiness {
  const value = z.object({ appIdentityConfigured: z.boolean(), credentialReferenceConfigured: z.boolean(),
    employeeMappingConfigured: z.boolean(), originAllowed: z.boolean() }).strict().parse(input)
  const missing = Object.entries(value).filter(([, configured]) => !configured).map(([key]) => key)
  const readiness = missing.length ? 'pending_configuration' : 'configured_unverified'
  return { profile: readiness, textMessage: readiness, nativeTodo: 'primary_protocol_required',
    interactiveCard: 'primary_protocol_required', completionCallback: 'primary_protocol_and_customer_callback_required',
    customerConnected: false, receiptEvidence: 'local_provider_only', missing }
}
