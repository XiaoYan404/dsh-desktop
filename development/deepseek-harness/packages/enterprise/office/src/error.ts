import type { OfficeErrorCode } from './types.ts'
export type { OfficeErrorCode } from './types.ts'

/** Expected office denials have stable handling identities. Backend failures retain their original cause. */
export class OfficeError extends Error {
  /**
   * @param code - Handling identity.
   * @param message - Diagnostic without credentials.
   * @param options - Optional private diagnostic cause, never projected to an employee response.
   */
  constructor(
    readonly code: OfficeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'OfficeError'
  }
}
