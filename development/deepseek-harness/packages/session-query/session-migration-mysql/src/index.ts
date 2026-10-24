/** Explicit frozen export, resumable import, full differences and guarded provider selection. */
export { MigrationError } from './error.ts'
export type { MigrationErrorCode } from './error.ts'
export { captureArchive, readArchive, retainReceipt } from './archive.ts'
export { assertRepresentable, diffLogical, sha256, validateLogical } from './logical.ts'
export { importArchive } from './import.ts'
export { activateMysql, rollbackMysql } from './switch.ts'
export type { SelectionControl } from './switch.ts'
export type * from './types.ts'
