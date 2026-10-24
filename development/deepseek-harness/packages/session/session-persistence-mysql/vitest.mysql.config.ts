/** Explicit provider acceptance; this lane never initializes or resets a database schema. */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(import.meta.dirname, '../../../tsconfig.base.json')] }), standardDecoratorPlugin()],
  test: { include: ['packages/session/session-persistence-mysql/tests/mysql.acceptance.ts'], execArgv: vitestExecArgv,
    testTimeout: 120000, hookTimeout: 30000, fileParallelism: false, retry: 0 },
})
