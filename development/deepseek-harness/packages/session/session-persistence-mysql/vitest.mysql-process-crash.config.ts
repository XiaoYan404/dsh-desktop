/** One new owned-process crash and natural-lease recovery scenario; no previously accepted suites run. */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(import.meta.dirname, '../../../tsconfig.base.json')] }), standardDecoratorPlugin()],
  test: { include: ['packages/session/session-persistence-mysql/tests/mysql-process-crash.acceptance.ts'],
    execArgv: vitestExecArgv, testTimeout: 90000, hookTimeout: 30000, fileParallelism: false, retry: 0 },
})
