import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, stat, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = join(repository, '.build', 'enterprise-checks')
await mkdir(checks, { recursive: true })
const node = join(repository, 'development', '.local-run', 'node-v24.22.0-win-x64', 'node.exe')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This installer requires Windows x64')
const environment = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  PATH: dirname(node) + ';' + process.env.PATH }
const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY
if (proxy) {
  environment.HTTPS_PROXY = proxy
  environment.HTTP_PROXY = proxy
  environment.NODE_USE_ENV_PROXY = '1'
}
function run(executable, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: repository, windowsHide: true, env: environment,
      stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Packaging phase exited with code ${code}`)))
  })
}
async function gate(name, inputs, args) {
  const hash = createHash('sha256')
  for (const input of inputs) hash.update(await readFile(join(repository, input)))
  const fingerprint = hash.digest('hex')
  const path = join(checks, name + '.json')
  let previous
  try { previous = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (previous?.passed && previous.fingerprint === fingerprint) return
  const attempts = (previous?.attempts ?? 0) + 1
  if (attempts > 3) throw new Error(`${name} reached its three-check limit`)
  try {
    await run(node, args)
    await writeFile(path, JSON.stringify({ fingerprint, attempts, passed: true }, null, 2) + '\n')
  } catch (error) {
    await writeFile(path, JSON.stringify({ fingerprint, attempts, passed: false }, null, 2) + '\n')
    throw error
  }
}
await gate('stock-electron-target', ['scripts/verify-target.mjs', 'node_modules/electron/dist/electron.exe'],
  ['scripts/verify-target.mjs', 'win32', 'x64'])
await run(node, ['scripts/prepare-enterprise-app.mjs'])
try { await stat(join(repository, '.build', 'enterprise-payload', 'development-build.json')) }
catch (error) {
  if (error?.code !== 'ENOENT') throw error
  await run(node, ['scripts/stage-enterprise-payload.mjs'])
}
const payload = join(repository, '.build', 'enterprise-payload')
for (const name of ['link-enterprise-runtime.mjs', 'prepare-enterprise-baseline.mjs']) {
  await copyFile(join(repository, 'scripts', name), join(payload, name))
}
await copyFile(join(repository, 'development', 'deepseek-harness', 'scripts', 'gui-hot-development.ps1'),
  join(payload, 'deepseek-harness', 'scripts', 'gui-hot-development.ps1'))
await run(node, ['scripts/electron-builder-windows.mjs', '--win', '--x64', '--publish', 'never',
  '--projectDir', join(repository, '.build', 'enterprise-app'),
  '--config', join(repository, 'electron-builder.enterprise.cjs')])
if (environment.DSH_ENTERPRISE_FAST_BUILD === '1') {
  const output = join(repository, 'dist-enterprise')
  await mkdir(output, { recursive: true })
  const name = 'EnterpriseOfficeAgent-Dev-20261025-r2-x64-Setup.exe'
  for (const file of [name, name + '.blockmap']) await copyFile(join(tmpdir(), 'enterprise-office-builder-r2', file),
    join(output, file), constants.COPYFILE_EXCL)
}
console.log(JSON.stringify({ installerCreated: true, edition: 'enterprise-development',
  completeReleaseBuild: false, officeTaskAcceptanceChanged: false }))
