/** Plain Node consumer of the built SDK; the SDK alone constructs dsh argv. */
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [configPath] = process.argv.slice(2)
const config = JSON.parse(await readFile(configPath, 'utf8'))
const { DeepSeekHarness } = await import(pathToFileURL(config.sdk).href)
const harness = new DeepSeekHarness({ profile: config.profile, patches: config.patches,
  dshHome: config.home, processCwd: config.workspace, cwd: config.workspace,
  provider: 'deepseek-official', model: 'deepseek-v4-pro', initializeTimeoutMs: 60000,
  requestTimeoutMs: 60000, shutdownTimeoutMs: 15000 })
try {
  const result = await harness.run(config.prompt, { sessionId: config.sessionId })
  await writeFile(config.output, JSON.stringify(result) + '\n', { mode: 0o600 })
} finally { await harness.close() }
