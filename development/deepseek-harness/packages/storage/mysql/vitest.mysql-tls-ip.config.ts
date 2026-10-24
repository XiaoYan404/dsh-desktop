/** Explicit IP dial/TLS name cases only; previously accepted DNS and database suites are excluded. */
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: [resolve(import.meta.dirname, '../../../tsconfig.base.json')] }), standardDecoratorPlugin()],
  test: { include: ['packages/storage/mysql/tests/mysql-tls-ip.acceptance.ts'], execArgv: vitestExecArgv,
    testTimeout: 30000, hookTimeout: 15000, retry: 0, fileParallelism: false },
})
