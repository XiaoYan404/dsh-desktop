/** Shutdown-only acceptance on the explicitly identified existing database; no schema writes. */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(import.meta.dirname, '../../../tsconfig.base.json')] }), standardDecoratorPlugin()],
  test: { include: ['packages/session/session-persistence-mysql/tests/mysql-shutdown.acceptance.ts'], execArgv: vitestExecArgv,
    testTimeout: 30000, hookTimeout: 30000, fileParallelism: false, retry: 0 },
})
