/** Package association is deployment data; actual Loader phases remain independent of installation and selection. */
import { expect, it } from 'vitest'
import type { BundleInfo, PluginEntryId, PluginInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { integrationPluginDeclarations, integrationPluginRows } from '../src/integration-plugins.ts'

it('accepts npm package roots but refuses install specs, paths and invalid adapter ids before activation', () => {
  expect(integrationPluginDeclarations({ 'company-oa': '@company/office-oa', payroll: 'payroll-agent' }))
    .toEqual({ 'company-oa': '@company/office-oa', payroll: 'payroll-agent' })
  for (const value of ['C:\\plugins\\oa', '../oa', 'https://company.invalid/oa', '@company/oa@latest', 'oa/subpath', 'oa\n']) {
    expect(() => integrationPluginDeclarations({ 'company-oa': value })).toThrow()
  }
  expect(() => integrationPluginDeclarations({ 'invalid adapter': '@company/oa' })).toThrow()
})

it('reports actual active, pending and failed rows without treating selection as execution or exposing diagnostics', () => {
  const ids = ['active', 'pending', 'failed'].map(value => value as PluginEntryId)
  const bundle: BundleInfo = { name: '@company/oa', official: false, availability: 'profile', enabled: true,
    installed: true, version: '1.0.0', optional: false, removable: true, overrides: [],
    source: 'file:C:/private/install', error: { code: 'operation-error', diagnostic: 'private failure diagnostic' },
    rows: ids.map((entryId, index) => ({ rowId: String(index), moduleName: '@company/oa', entryId })) }
  const plugins: PluginInfo[] = ids.map((entryId, index) => ({ entryId, moduleName: '@company/oa', enabled: true,
    fiberPhase: index === 0 ? 'active' : index === 1 ? 'pending' : 'failed', patchId: String(index) }))
  const packages = { 'company-oa': '@company/oa', absent: '@company/not-installed' }
  const result = integrationPluginRows(packages, [bundle], plugins)
  expect(result[0]?.bundle).toEqual({ installed: true, availability: 'profile', enabled: true, version: '1.0.0',
    problem: true, activeRows: 1, pendingRows: 1, failedRows: 1, totalRows: 3 })
  expect(result[1]?.bundle).toMatchObject({ installed: false, availability: 'missing', enabled: false, activeRows: 0 })
  expect(JSON.stringify(result)).not.toContain('private')
  expect(integrationPluginRows(packages, null, []).map(entry => entry.bundle)).toEqual([null, null])
  expect(integrationPluginRows(packages, [{ ...bundle, enabled: false,
    rows: bundle.rows.map(({ entryId: _entryId, ...row }) => row) }], [])
    [0]?.bundle).toMatchObject({ installed: true, enabled: false, activeRows: 0 })
})
