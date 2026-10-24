const path = require('node:path')
const os = require('node:os')

module.exports = {
  extends: null,
  appId: 'io.dsh.enterprise.development',
  productName: 'Enterprise Office Agent Dev',
  electronVersion: '43.0.0',
  electronDist: path.join(__dirname, 'node_modules', 'electron', 'dist'),
  directories: { app: path.join(__dirname, '.build', 'enterprise-app'),
    output: process.env.DSH_ENTERPRISE_FAST_BUILD === '1'
      ? path.join(os.tmpdir(), 'enterprise-office-builder-r2') : path.join(__dirname, 'dist-enterprise'),
    buildResources: path.join(__dirname, 'build') },
  files: ['main.mjs', 'startup.html', 'startup.js', 'startup.css', 'icon.png', 'package.json', 'LICENSE', '!node_modules{,/**/*}'],
  asar: true,
  afterPack: async context => {
    const { copyEnterprisePayload } = await import('./scripts/copy-enterprise-payload.mjs')
    await copyEnterprisePayload(context)
  },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: path.join(__dirname, 'build', 'icon.ico'),
    requestedExecutionLevel: 'asInvoker', signExecutable: false },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
    include: path.join(__dirname, 'build', 'installer.nsh'),
    createDesktopShortcut: true, createStartMenuShortcut: true,
    artifactName: 'EnterpriseOfficeAgent-Dev-20261025-r2-x64-Setup.${ext}' },
  npmRebuild: false,
  publish: null,
}
