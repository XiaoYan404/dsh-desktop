/** Pack a local-only Desktop runtime from verified repository Client artifacts without changing public build values. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readClientBuildRecord, repositoryClientBuildEnvironment } from '../../../scripts/client-build-environment.ts'
import { releaseFamily } from '../../../scripts/release/families.ts'
import { packMembers } from '../../../scripts/release/pack.ts'
import { PUBLISH_ORDER_FILE } from '../../../scripts/release/tarball.ts'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'

if (process.env.DSH_DESKTOP_LOCAL !== '1' || process.env.DSH_DESKTOP_UNSIGNED !== '1') {
  throw new Error('local runtime packing requires an explicit unsigned local Desktop invocation')
}
const root = resolve(import.meta.dirname, '../../..')
const destination = desktopTargetBuildPaths('win-x64').packedDsh
const record = readClientBuildRecord(root, repositoryClientBuildEnvironment(root))
const family = releaseFamily('dsh')
const members = family.publishOrder(family.members(root)).order
family.verifyVersions(members)
mkdirSync(resolve(destination, '..'), { recursive: true })
// A failed local pack remains available for inspection; retries never erase it.
mkdirSync(destination)
const order = await packMembers(family, members, destination, 4)
writeFileSync(join(destination, 'LOCAL-ONLY.json'), `${JSON.stringify({ local: true, unsigned: true,
  publicBuildEnvironment: record.environment, clientArtifacts: record.artifacts })}\n`, { flag: 'wx' })
writeFileSync(join(destination, PUBLISH_ORDER_FILE), `${order.join('\n')}\n`, { flag: 'wx' })
process.stdout.write(`Local Desktop runtime: ${order.length} verified tarballs; no release completion record.\n`)
