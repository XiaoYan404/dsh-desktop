/** Separate reviewed migration acceptance; ordinary tests never alter a database. */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(import.meta.dirname, '../../../tsconfig.base.json')] }), standardDecoratorPlugin()],
  test: { include: ['packages/storage/mysql/tests/mysql-upgrade.acceptance.ts'], execArgv: vitestExecArgv,
    testTimeout: 120000, hookTimeout: 30000, retry: 0, fileParallelism: false },
})
