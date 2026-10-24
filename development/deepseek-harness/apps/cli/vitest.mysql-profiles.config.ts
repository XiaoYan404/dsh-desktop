/** Explicit artifact/profile database lane, independent of previously passed MySQL suites. */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(import.meta.dirname, '../../tsconfig.base.json')] }), standardDecoratorPlugin()],
  test: { include: ['apps/cli/tests/mysql-profiles.acceptance.ts'], execArgv: vitestExecArgv,
    testTimeout: 180000, hookTimeout: 30000, retry: 0, fileParallelism: false },
})
