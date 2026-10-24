import { spawn } from 'node:child_process'
import { mkdir, readdir, stat, lstat, readFile, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Copy the Windows development snapshot without the builder's long-path copy failure. */
export async function copyEnterprisePayload(context) {
  const owner = resolve(context.packager.config.directories.output)
  if (![join(repository, 'dist-enterprise'), join(tmpdir(), 'enterprise-office-builder-r2')].includes(owner)) {
    throw new Error('The configured Windows build directory has no recorded owner')
  }
  const target = join(resolve(context.appOutDir), 'resources', 'enterprise-development')
  const child = relative(owner, target)
  if (child.startsWith('..') || isAbsolute(child)) throw new Error('Installer payload target escaped its owner')
  const source = join(repository, '.build', 'enterprise-payload')
  const input = JSON.parse(await readFile(join(source, 'development-build.json'), 'utf8'))
  if (!input || input.completeReleaseBuild !== false) throw new Error('Missing development payload receipt')
  await mkdir(target, { recursive: true })
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'robocopy.exe')
  const code = await new Promise((accept, reject) => {
    const process = spawn(executable, [source, target, '/E', '/COPY:DAT', '/DCOPY:DAT',
      '/R:0', '/W:0', '/MT:8', '/XJ', '/NFL', '/NDL', '/NP', '/NJH'], { windowsHide: true, stdio: 'inherit' })
    process.once('error', reject)
    process.once('exit', accept)
  })
  if (code === null || code < 0 || code > 7) throw new Error(`Windows payload copy failed (${code})`)
  let files = 0
  let bytes = 0
  async function verify(path) {
    for (const entry of await readdir(join(source, path), { withFileTypes: true })) {
      const next = join(path, entry.name)
      if (entry.isSymbolicLink()) throw new Error('An installer payload must not contain machine-specific links')
      if (entry.isDirectory()) await verify(next)
      else if (entry.isFile()) {
        const actual = await lstat(join(target, next))
        const expected = await stat(join(source, next))
        if (!actual.isFile() || actual.size !== expected.size) throw new Error('Installed resource inventory differs from its input')
        files++
        bytes += actual.size
      }
    }
  }
  await verify('')
  await writeFile(join(repository, '.build', 'enterprise-checks', 'windows-payload-copy.json'),
    JSON.stringify({ passed: true, mechanism: 'Windows robocopy with long paths', files, bytes, exitCode: code }, null, 2) + '\n')
  console.log(JSON.stringify({ windowsPayloadCopied: true, files, bytes }))
}
