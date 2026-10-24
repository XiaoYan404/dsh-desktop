import { mkdir, readFile, writeFile, cp, copyFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const development = join(repository, 'development')
const project = join(development, 'deepseek-harness')
const nodeDirectory = join(development, '.local-run', 'node-v24.22.0-win-x64')
const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
const manager = /^pnpm@([\d.]+)/.exec(manifest.packageManager)?.[1]
if (!manager) throw new Error('The imported project must declare an exact pnpm version')
const cached = join(process.env.LOCALAPPDATA, 'node', 'corepack', 'v1', 'pnpm', manager)
const pnpmTarget = join(nodeDirectory, 'node_modules', 'pnpm')
let ready = false
try { ready = JSON.parse(await readFile(join(pnpmTarget, 'package.json'), 'utf8')).version === manager }
catch (error) { if (error?.code !== 'ENOENT') throw error }
if (!ready) {
  const cachedManifest = JSON.parse(await readFile(join(cached, 'package.json'), 'utf8'))
  if (cachedManifest.name !== 'pnpm' || cachedManifest.version !== manager) throw new Error('Cached pnpm does not match the declared version')
  await cp(cached, pnpmTarget, { recursive: true, errorOnExist: true, force: false })
}
const pnpmManifest = JSON.parse(await readFile(join(pnpmTarget, 'package.json'), 'utf8'))
const entry = typeof pnpmManifest.bin === 'string' ? pnpmManifest.bin : pnpmManifest.bin.pnpm
await writeFile(join(nodeDirectory, 'pnpm.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\pnpm\\'
  + entry.replaceAll('/', '\\') + '" %*\r\n')
await copyFile(join(repository, 'scripts', 'link-enterprise-runtime.mjs'), join(development, 'link-enterprise-runtime.mjs'))
await copyFile(join(repository, 'scripts', 'prepare-enterprise-baseline.mjs'), join(development, 'prepare-enterprise-baseline.mjs'))

const stage = join(repository, '.build', 'enterprise-app')
const desktopManifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
await mkdir(stage, { recursive: true })
for (const [source, target] of [
  ['enterprise-development.mjs', 'main.mjs'], ['enterprise-startup.html', 'startup.html'],
  ['enterprise-startup.js', 'startup.js'], ['enterprise-startup.css', 'startup.css'],
]) await copyFile(join(repository, 'build', source), join(stage, target))
await writeFile(join(stage, 'package.json'), JSON.stringify({
  name: 'enterprise-office-agent-development', version: '0.1.1-enterprise.20261025.2',
  productName: 'Enterprise Office Agent Dev', private: true, type: 'module', main: 'main.mjs',
  dependencies: {},
  description: 'Enterprise workbench with the preserved GUI hot-development runtime',
  author: desktopManifest.author, license: desktopManifest.license,
}, null, 2) + '\n')
await copyFile(join(repository, 'LICENSE'), join(stage, 'LICENSE'))
await copyFile(join(repository, 'build', 'app-icon.png'), join(stage, 'icon.png'))
await writeFile(join(development, 'toolchain.json'), JSON.stringify({ node: '24.22.0', pnpm: manager,
  pnpmManifestSha256: createHash('sha256').update(await readFile(join(pnpmTarget, 'package.json'))).digest('hex'),
  managedVersion: manifest.packageManager, completeReleaseBuild: false,
}, null, 2) + '\n')
console.log(JSON.stringify({ prepared: true, node: '24.22.0', pnpm: manager,
  edition: 'enterprise-development', completeReleaseBuild: false }))
