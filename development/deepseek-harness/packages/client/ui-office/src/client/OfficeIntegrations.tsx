/** Descriptive company catalog and reviewed imports; native plugin installation remains separate. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type {
  OfficeIntegrationId,
  OfficeConnectorView,
  OfficeView,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import { OfficeConnectionForm, OfficeConnectionSummary } from './OfficeConnections.tsx'
import { OfficeExecutionHistory } from './OfficeExecutions.tsx'
import { OfficeSubmission } from './OfficeSubmission.tsx'
import { OfficeConnectorSync } from './OfficeConnectorSync.tsx'
import { OfficeIntegrationPlugins } from './OfficeIntegrationPlugins.tsx'
import css from './OfficePage.module.css'

function integrationExample(t: OfficeProps['t']): string {
  return JSON.stringify({
    name: 'company-oa-adapter',
    system: 'OA',
    version: '1.0.0',
    provider: t('integrationExampleProvider'),
    description: t('integrationExampleDescription'),
    owner: t('integrationExampleOwner'),
    capabilities: [t('integrationExampleQueryApprovals'), t('integrationExampleQueryWork')],
  }, null, 2)
}

function downloadExample(example: string): void {
  const url = URL.createObjectURL(
    new Blob([example + '\n'], { type: 'application/json;charset=utf-8' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = 'integration-manifest.example.json'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 1000)
}

/** Shared company records are readable by employees; only current administrators can import. */
export function OfficeIntegrations(
  props: OfficeProps & { office: OfficeView },
) {
  const { t, office } = props
  const example = integrationExample(t)
  const catalog = office.integrations
  const connections = props.useConnectors(state => state)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<OfficeIntegrationId | null>(null)
  const [help, setHelp] = useState(false)
  const [importing, setImporting] = useState(false)
  const [editing, setEditing] = useState<{ id: OfficeIntegrationId; initial: OfficeConnectorView } | null>(null)
  const current = catalog?.entries.find(record => record.id === selected)
  const term = query.trim().normalize('NFC').toLowerCase()
  const entries = (catalog?.entries ?? []).filter(record =>
    [
      record.name,
      record.system,
      record.provider,
      record.owner,
      record.description,
      ...record.capabilities,
    ]
      .join('\n')
      .toLowerCase()
      .includes(term),
  )
  return (
    <>
      <OfficeExecutionHistory {...props} office={office} />
      <OfficeSubmission {...props} />
      <OfficeConnectorSync {...props} office={office} />
      <div className={`${css.row} ${css.integrationHeader}`}>
        <h2>{t('companyIntegrations')}</h2>
        {office.customizations?.protocol === 1 && <>
          <Button onClick={() => { props.openCustomization() }}>{t('customizationCompany')}</Button>
          <Button onClick={() => { void props.openCustomizationRequests() }}>{t('customizationRequests')}</Button>
        </>}
        <Button
          onClick={() => {
            setHelp(true)
          }}
        >
          {t('integrationImportHelp')}
        </Button>
        {office.me.role === 'admin' && (
          <Button
            variant="primary"
            disabled={!catalog}
            onClick={() => {
              setImporting(true)
            }}
          >
            {t('importIntegration')}
          </Button>
        )}
      </div>
      <p className={css.accountHint}>{t('integrationCatalogHint')}</p>
      <div className={css.row}>
        <Input
          className={css.integrationSearch ?? ''}
          type="search"
          aria-label={t('integrationSearch')}
          placeholder={t('integrationSearch')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
        <Button onClick={props.openPlugins}>{t('plugins')}</Button>
        <Button disabled={connections.loading} onClick={() => { void props.loadConnections() }}>
          {t('connectorRefresh')}
        </Button>
      </div>
      {connections.error && <p role="alert">{t('connectorUnavailable')}</p>}
      <OfficeIntegrationPlugins {...props} />
      {!catalog ? (
        <p role="status">{t('integrationCatalogUnavailable')}</p>
      ) : entries.length === 0 ? (
        <div className={css.empty}>
          <p>{t(query ? 'integrationNoResults' : 'integrationEmpty')}</p>
        </div>
      ) : (
        <div className={css.integrationGrid}>
          {entries.map(record => (
            <article
              key={record.id}
              className={css.card}
              data-office-integration={record.id}
            >
              <h3>{record.system}</h3>
              <p className={css.accountHint}>
                {record.name} · {record.version}
              </p>
              <p>{record.description}</p>
              <p className={css.accountHint}>
                {record.capabilities.slice(0, 3).join(' · ')}
              </p>
              <p className={css.accountHint}>{t('integrationRegistered')}</p>
              <OfficeConnectionSummary {...props} id={record.id} administrator={office.me.role === 'admin'} />
              <Button
                onClick={() => {
                  setSelected(record.id)
                }}
              >
                {t('integrationDetails')}
              </Button>
              {office.me.role === 'admin' && connections.view && (
                <Button disabled={connections.busy !== null} onClick={() => {
                  if (connections.view) setEditing({ id: record.id, initial: connections.view })
                }}>{t('connectorConfigure')}</Button>
              )}
            </article>
          ))}
        </div>
      )}
      <p className={css.accountHint} role="status">
        {t('integrationCount')} · {entries.length}
      </p>
      {current && (
        <Modal
          open
          title={t('integrationDetails')}
          closeLabel={t('close')}
          className={css.detailDialog ?? ''}
          contentClassName={css.detailContent ?? ''}
          footer={<Button aria-label={t('integrationClose')} onClick={() => { setSelected(null) }}>{t('close')}</Button>}
          onClose={() => {
            setSelected(null)
          }}
        >
          <div className={css.form}>
            <h2>{current.system}</h2>
            <p>{current.description}</p>
            <dl>
              <dt>{t('integrationName')}</dt>
              <dd>{current.name}</dd>
              <dt>{t('integrationVersion')}</dt>
              <dd>{current.version}</dd>
              <dt>{t('integrationProvider')}</dt>
              <dd>{current.provider}</dd>
              <dt>{t('integrationOwner')}</dt>
              <dd>{current.owner || t('unassigned')}</dd>
              <dt>{t('status')}</dt>
              <dd>{t('integrationRegistered')}</dd>
              <dt>{t('integrationImportedAt')}</dt>
              <dd>
                {new Date(current.importedAt).toLocaleString(undefined, {
                  timeZone: office.timeZone,
                })}
              </dd>
            </dl>
            <section>
              <h2>{t('integrationCapabilities')}</h2>
              <ul>
                {current.capabilities.map(value => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            </section>
            <p className={css.accountHint}>{t('integrationCatalogHint')}</p>
            <OfficeConnectionSummary {...props} id={current.id} detailed administrator={office.me.role === 'admin'} />
            <Button
              onClick={() => {
                setSelected(null)
                props.openPlugins()
              }}
            >
              {t('plugins')}
            </Button>
          </div>
        </Modal>
      )}
      {help && (
        <Modal
          open
          title={t('integrationImportHelp')}
          closeLabel={t('close')}
          onClose={() => {
            setHelp(false)
          }}
        >
          <div className={css.form}>
            <p>{t('integrationFormatHint')}</p>
            <pre className={css.manifestExample}>{example}</pre>
            <p className={css.accountHint}>{t('integrationCatalogHint')}</p>
            <Button onClick={() => { downloadExample(example) }}>
              {t('integrationExportExample')}
            </Button>
          </div>
        </Modal>
      )}
      {importing && catalog && office.me.role === 'admin' && (
        <IntegrationImport
          {...props}
          limit={catalog.maxImportBytes}
          onClose={() => {
            setImporting(false)
          }}
        />
      )}
      {editing && office.me.role === 'admin' && (
        <OfficeConnectionForm {...props} id={editing.id} initial={editing.initial} onClose={() => { setEditing(null) }} />
      )}
    </>
  )
}

function IntegrationImport(
  props: OfficeProps & { limit: number; onClose(this: void): void },
) {
  const { t, limit, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const [json, setJson] = useState('')
  const [requestId, setRequestId] = useState(randomUUID)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<OfficeKey | null>(null)
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  const update = (text: string) => {
    generation.current++
    setReading(false)
    setJson(text)
    setRequestId(randomUUID())
    setError(
      new TextEncoder().encode(text).byteLength > limit
        ? 'integrationTooLarge'
        : null,
    )
  }
  const read = async (file: File) => {
    const current = ++generation.current
    setError(null)
    if (file.size > limit) {
      setReading(false)
      setError('integrationTooLarge')
      return
    }
    setReading(true)
    try {
      const text = await file.text()
      if (generation.current !== current) return
      setJson(text)
      setRequestId(randomUUID())
    } catch {
      if (generation.current === current) setError('fileReadFailed')
    } finally {
      if (generation.current === current) setReading(false)
    }
  }
  return (
    <Modal
      open
      title={t('importIntegration')}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className={css.form}
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && !reading && !error && json.trim()) {
            void props
              .importIntegration({ requestId, json })
              .then((success) => {
                if (success) onClose()
              })
          }
        }}
      >
        <p>{t('integrationFormatHint')}</p>
        <label>
          {t('integrationChooseFile')}
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void read(file)
            }}
          />
        </label>
        <label>
          {t('integrationJson')}
          <textarea
            aria-label={t('integrationJson')}
            rows={12}
            maxLength={limit + 1}
            value={json}
            disabled={busy}
            onChange={(event) => {
              update(event.target.value)
            }}
          />
        </label>
        {reading && <progress aria-label={t('loading')} />}
        {error && <p role="alert">{t(error)}</p>}
        <p className={css.accountHint}>{t('integrationReviewHint')}</p>
        <div className={css.row}>
          <Button disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || reading || !!error || !json.trim()}
          >
            {t('integrationConfirmImport')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
