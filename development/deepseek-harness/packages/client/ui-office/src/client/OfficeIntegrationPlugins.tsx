/** Package installation and Loader execution remain distinct from company connection readiness. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

/** Deployment declarations link to the existing Native management flows without installing on page load. */
export function OfficeIntegrationPlugins(props: OfficeProps & { adapterId?: string }) {
  const { t, adapterId } = props
  const snapshot = props.useIntegrationPlugins(state => state)
  const view = snapshot.view
  const packages = view?.packages.filter(entry => !adapterId || entry.adapterId === adapterId) ?? []
  return <section className={css.connectionSummary} aria-label={t('integrationPluginPackages')}>
    <h2>{t('integrationPluginPackages')}</h2>
    <Button disabled={snapshot.loading} onClick={() => { void props.loadIntegrationPlugins() }}>
      {t(view ? 'integrationPluginRefresh' : 'integrationPluginInspect')}
    </Button>
    {snapshot.loading && <progress aria-label={t('loading')} />}
    {snapshot.error && <p role="alert">{t(snapshot.error)}</p>}
    {view?.mode === 'gateway' ? <p role="status">{t('integrationPluginGateway')}</p> : view && <>
      <p className={css.accountHint}>{t('integrationPluginLocalHint')}</p>
      {!view.managementAvailable && <p role="status">{t('integrationPluginManagerUnavailable')}</p>}
      {!packages.length && <p role="status">{t('integrationPluginNoDeclaration')}</p>}
      <ul className={css.executionList}>{packages.map(entry => <li key={entry.adapterId} data-office-plugin={entry.adapterId}>
        <strong>{entry.adapterId}</strong> · <span>{entry.packageName}</span>
        {entry.bundle ? <>
          <p>{t(entry.bundle.availability === 'missing' ? 'integrationPluginMissing'
            : entry.bundle.installed ? 'integrationPluginInstalled' : 'integrationPluginShipped')}
          {entry.bundle.version ? ` · ${entry.bundle.version}` : ''}</p>
          <p>{t(entry.bundle.enabled ? 'integrationPluginSelected' : 'integrationPluginNotSelected')}</p>
          {entry.bundle.problem && <p role="status">{t('integrationPluginProblem')}</p>}
          <p>{t('integrationPluginRuntime').replace('{active}', String(entry.bundle.activeRows))
            .replace('{pending}', String(entry.bundle.pendingRows)).replace('{failed}', String(entry.bundle.failedRows))
            .replace('{total}', String(entry.bundle.totalRows))}</p>
        </> : <p role="status">{t('integrationPluginUnknown')}</p>}
        <Button disabled={!view.managementAvailable}
          aria-label={t('integrationPluginManagePackage').replace('{name}', entry.packageName)}
          onClick={() => { props.manageIntegrationPlugin(entry.adapterId) }}>
          {t(entry.bundle?.availability === 'missing' ? 'integrationPluginInstall' : 'integrationPluginManage')}
        </Button>
      </li>)}</ul>
    </>}
  </section>
}
