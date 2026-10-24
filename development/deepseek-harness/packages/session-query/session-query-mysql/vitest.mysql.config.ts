/** Only the new 06 verify-only database scenario; no historical acceptance tests run. */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  cacheDir: resolve(import.meta.dirname, '../../../.artifacts/parallel-handoff/06/.mysql-cache'),
  plugins: [tsconfigPaths({ projects: [resolve(import.meta.dirname, '../../../tsconfig.base.json')] }), standardDecoratorPlugin()],
  test: { include: ['packages/session-query/session-query-mysql/tests/mysql-search.acceptance.ts'], execArgv: vitestExecArgv,
    retry: 0, fileParallelism: false, testTimeout: 60000, hookTimeout: 30000 },
})
