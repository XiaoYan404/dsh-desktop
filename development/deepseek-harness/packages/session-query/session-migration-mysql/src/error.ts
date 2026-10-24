/** Typed failures preserve source bytes and forbid dependent activation. */
export type MigrationErrorCode = 'FREEZE_UNAVAILABLE' | 'SOURCE_CHANGED' | 'INVALID_ARCHIVE' | 'FUTURE_FORMAT'
  | 'UNREPRESENTABLE' | 'CAPACITY' | 'DIFFERENCE' | 'TARGET_CONFLICT' | 'IMPORT_UNKNOWN' | 'ROLLBACK_REQUIRED'

/** Expected migration failures have no raw path, payload or database descriptor in their message. */
export class MigrationError extends Error {
  constructor(readonly code: MigrationErrorCode, options?: ErrorOptions) {
    super(`Store migration stopped (${code}); retain the source and archive before resolving this condition.`, options)
    this.name = 'MigrationError'
  }
}
