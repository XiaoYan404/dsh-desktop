/** Observe unintended memory-only creation even when the MySQL service is unavailable. */
import { writeFileSync } from 'node:fs'

export const name = 'mysql-profile-refusal-observer'
export const inject = ['sessions']
export function apply(ctx, config) {
  ctx.on('session/created', () => writeFileSync(config.createdFile, 'unexpected Native Session\n'))
}
