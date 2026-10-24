/** Inspect and prepare deployment files; applications still launch only through dsh profiles. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { DeploymentError, parsePrivateDeployment, privateDeploymentReport, probePrivateDeployment,
  verifyPrivateDeployment, writePrivateDeployment } from './enterprise-private-deployment-config.ts'

/** Validate public deployment JSON, optionally write/verify artifacts, then explicitly probe reviewed endpoints.
 * @param argv - CLI options; --probe alone authorizes the listed unauthenticated GET requests.
 * @returns Zero for local validation/successful reachability, two for degraded probes, one for configuration or file errors.
 */
export async function runPrivateDeployment(argv: string[]): Promise<number> {
  try {
    let options: ReturnType<typeof parseOptions>
    try { options = parseOptions(argv) }
    catch (_error) { throw new DeploymentError('invalid_config', 'Use --config <file> [--write <new-directory> | --verify <directory>] [--probe].') }
    if (options.help) {
      process.stdout.write('Usage: pnpm exec tsx scripts/enterprise-private-deployment.ts --config <file> [--write <new-directory> | --verify <directory>] [--probe]\n')
      return 0
    }
    if (!options.config || (options.write && options.verify)) {
      throw new DeploymentError('invalid_config', 'Provide --config <file> and at most one of --write or --verify.')
    }
    let source: string
    try { source = await readFile(resolve(options.config), 'utf8') }
    catch (_error) { throw new DeploymentError('io_error', 'Could not read the deployment JSON. Check its path and read permissions.') }
    const config = parsePrivateDeployment(source, resolve(options.config))
    const report = await privateDeploymentReport(config)
    if (report['homeStatus'] === 'not-directory' || report['homeStatus'] === 'unreadable') {
      throw new DeploymentError('invalid_config', 'The configured data home is not an accessible directory. Choose a directory path and check its permissions.')
    }
    if (options.write) await writePrivateDeployment(config, resolve(options.write))
    if (options.verify) await verifyPrivateDeployment(config, resolve(options.verify))
    const controller = new AbortController()
    const stop = (): void => { controller.abort() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    let probes: Awaited<ReturnType<typeof probePrivateDeployment>> = []
    try { if (options.probe) probes = await probePrivateDeployment(config, controller.signal) }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
    process.stdout.write(JSON.stringify({ ...report, artifacts: options.write ? 'written' : options.verify ? 'verified' : 'not-written',
      probeResults: options.probe ? probes : 'not-requested' }, null, 2) + '\n')
    return probes.some(probe => probe.status !== 'reachable') ? 2 : 0
  } catch (error) {
    const failure = error instanceof DeploymentError ? error
      : new DeploymentError('io_error', 'Deployment preparation failed. Inspect local permissions and keep existing application data unchanged.')
    process.stderr.write(JSON.stringify({ ok: false, code: failure.code, message: failure.message }) + '\n')
    return 1
  }
}

function parseOptions(argv: string[]) {
  return parseArgs({ args: argv, options: { config: { type: 'string' }, write: { type: 'string' },
    verify: { type: 'string' }, probe: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  strict: true, allowPositionals: false }).values
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runPrivateDeployment(process.argv.slice(2))
}
