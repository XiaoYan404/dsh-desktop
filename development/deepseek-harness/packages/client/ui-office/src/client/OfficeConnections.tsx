/** Administrator-reviewed connections and explicit point-in-time checks, separate from catalog registration. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Checkbox, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { OfficeConnectorConfiguration, OfficeConnectorInput, OfficeConnectorProbeStatus, OfficeConnectorView,
  OfficeIntegrationId } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import type { OfficeKey } from './locales.ts'
import { OfficeIntegrationPlugins } from './OfficeIntegrationPlugins.tsx'
import css from './OfficePage.module.css'

/** Locale-owned readiness labels shared by connection management and private conversation choices. */
export const officeConnectorStatusKeys: Record<OfficeConnectorProbeStatus, OfficeKey> = {
  disabled: 'connectorDisabled', adapter_unavailable: 'connectorAdapterUnavailable', policy_blocked: 'connectorPolicyBlocked',
  credential_missing: 'connectorCredentialMissing', credential_unavailable: 'connectorCredentialUnavailable',
  unverified: 'connectorReady', connected: 'connectorConnected', unauthorized: 'connectorUnauthorized',
  rate_limited: 'connectorRateLimited', timed_out: 'connectorTimedOut', unreachable: 'connectorUnreachable',
  invalid_response: 'connectorInvalidResponse', http_error: 'connectorHttpError',
}

/** Current readiness never reuses a previous network check as a permanent availability claim. */
export function OfficeConnectionSummary(props: OfficeProps & {
  id: OfficeIntegrationId
  administrator: boolean
  detailed?: boolean
}) {
  const { t, id, administrator, detailed } = props
  const snapshot = props.useConnectors(state => state)
  const entry = snapshot.view?.entries.find(value => value.integrationId === id)
  const check = snapshot.checks[id]
  const checking = snapshot.busy === 'probing' && snapshot.target === id
  const catalogue = snapshot.catalogue?.integrationId === id ? snapshot.catalogue : null
  const query = catalogue?.result
  const receipt = query?.receipt
  return (
    <div className={css.connectionSummary}>
      <p className={css.accountHint} role="status">
        {snapshot.view ? t(entry ? officeConnectorStatusKeys[entry.status] : 'connectorUnconfigured')
          : t(snapshot.loading ? 'loading' : 'connectorUnavailable')}
      </p>
      {detailed && entry && (
        <>
          <p>{t(snapshot.view?.adapters.includes(entry.adapterId) ? 'integrationPluginCodeRegistered' : 'integrationPluginCodeMissing')}
            {' · '}{entry.adapterId}</p>
          <OfficeIntegrationPlugins {...props} adapterId={entry.adapterId} />
          {entry.configuration && <p className={css.connectionAddress}>{entry.configuration.baseUrl}</p>}
          {check && (
            <p role="status">
              {t('connectorLastCheck')} · <time dateTime={new Date(check.checkedAt).toISOString()}>
                {new Date(check.checkedAt).toLocaleString()}
              </time> · <span>{t(officeConnectorStatusKeys[check.status])}</span>
            </p>
          )}
          {administrator && (
            <Button disabled={snapshot.busy !== null || entry.status !== 'unverified'}
              onClick={() => { void props.probeConnection(id, entry.revision) }}>
              {t(checking ? 'connectorChecking' : 'connectorCheck')}
            </Button>
          )}
        </>
      )}
      {detailed && snapshot.view?.actionCatalog?.protocol === 1 && (
        <section aria-label={t('connectorActions')}>
          <h2>{t('connectorActions')}</h2>
          <Button disabled={catalogue?.loading || snapshot.busy !== null}
            onClick={() => { void props.loadConnectorActions(id) }}>
            {t(catalogue?.loading ? 'loading' : catalogue ? 'connectorActionsRefresh' : 'connectorActionsView')}
          </Button>
          {catalogue?.error && <p role="alert">{t(catalogue.error)}</p>}
          {catalogue?.view && (catalogue.view.status !== 'unverified'
            ? <p role="status">{t(catalogue.view.status === 'unconfigured' ? 'connectorUnconfigured'
              : officeConnectorStatusKeys[catalogue.view.status])}</p>
            : catalogue.view.actions.length ? <ul>{catalogue.view.actions.map(action => (
              <li key={action.id}><strong>{action.label}</strong> · {t(action.kind === 'read' ? 'connectorActionRead' : 'connectorActionWrite')}
                {action.description && <p>{action.description}</p>}
                {action.kind === 'read' && catalogue.view?.readSupported && (
                  <span className={css.row}>
                    <Button disabled={query?.loading || snapshot.busy !== null}
                      aria-label={t('connectorQueryAction').replace('{name}', action.label)}
                      onClick={() => { void props.readConnectorAction(action.id) }}>{t('connectorQuery')}</Button>
                    {snapshot.view?.synchronization?.protocol === 1 && <Button disabled={snapshot.busy !== null}
                      aria-label={t('syncAction').replace('{name}', action.label)}
                      onClick={() => { props.beginConnectorSync(action.id) }}>{t('syncStart')}</Button>}
                  </span>
                )}
                {action.kind === 'write' && catalogue.view?.writeSupported && <Button
                  disabled={snapshot.busy !== null} aria-label={t('submissionAction').replace('{name}', action.label)}
                  onClick={() => { props.beginConnectorSubmission(action.id) }}>{t('submissionStart')}</Button>}
              </li>
            ))}</ul> : <p>{t('connectorActionsEmpty')}</p>)}
          {query && (
            <section className={css.connectionRead} aria-label={t('connectorQueryResult')} aria-busy={query.loading}>
              <h3>{t('connectorQueryResult')}</h3>
              {query.loading && <p role="status">{t('loading')}</p>}
              {query.error && <p role="alert">{t(query.error)}</p>}
              {receipt && <p role="status">{t(receipt.status === 'read' ? 'connectorQuerySucceeded'
                : officeConnectorStatusKeys[receipt.status])} · <time dateTime={new Date(receipt.checkedAt).toISOString()}>
                {new Date(receipt.checkedAt).toLocaleString()}</time></p>}
              {receipt?.status === 'read' && <>
                <p>{receipt.data.summary}</p>
                <dl>{receipt.data.entries.map((field, index) => <div key={index}>
                  <dt>{field.label}</dt><dd>{field.value}</dd>
                </div>)}</dl>
              </>}
            </section>
          )}
        </section>
      )}
      {detailed && snapshot.view?.executionHistory?.protocol === 1 && <Button
        onClick={() => { void props.openExecutionRecords(id) }}>{t('executionRecords')}</Button>}
      {detailed && snapshot.view?.synchronization?.protocol === 1 && <Button
        onClick={() => { void props.openConnectorSyncHistory(id) }}>{t('syncHistory')}</Button>}
    </div>
  )
}

function ConnectionChoice(props: {
  label: string
  value: string
  choices: readonly { readonly id: string; readonly label: string }[]
  disabled: boolean
  empty: string
  onChange(this: void, id: string): void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.connectionChoice}>
      <span>{props.label}</span>
      <Menu open={open && !props.disabled} portal autoFocus items={props.choices} selectedId={props.value}
        onClose={() => { setOpen(false) }} onSelect={(id) => { props.onChange(id); setOpen(false) }}
        anchor={<Button aria-label={props.label} aria-haspopup="menu" aria-expanded={open && !props.disabled}
          disabled={props.disabled || props.choices.length === 0} onClick={() => { setOpen(value => !value) }}>
          {(props.choices.find(choice => choice.id === props.value)?.label ?? props.value) || props.empty}
        </Button>} />
    </div>
  )
}

/** A failed or competing save retains the reviewed form until an explicit retry, reload or close. */
export function OfficeConnectionForm(props: OfficeProps & {
  id: OfficeIntegrationId
  initial: OfficeConnectorView
  onClose(this: void): void
}) {
  const { t, id, initial, onClose } = props
  const initialEntry = initial.entries.find(entry => entry.integrationId === id)
  const [revision, setRevision] = useState(initialEntry?.revision ?? 0)
  const [draft, setDraft] = useState<OfficeConnectorConfiguration>(initialEntry?.configuration ?? {
    adapterId: 'http-json', baseUrl: initial.allowedOrigins?.[0] ? initial.allowedOrigins[0] + '/' : '', probePath: 'health',
    authentication: { kind: 'none' }, enabled: Boolean(initial.allowedOrigins?.length),
  })
  const [pending, setPending] = useState<OfficeConnectorInput | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<OfficeKey | null>(null)
  const [reloading, setReloading] = useState(false)
  const snapshot = props.useConnectors(state => state)
  const view = snapshot.view ?? initial
  const latest = view.entries.find(entry => entry.integrationId === id)
  const stale = (latest?.revision ?? 0) !== revision
  const busy = snapshot.busy !== null || reloading
  const frozen = busy || stale || uncertain
  const aliases = view.credentialAliases ?? []
  const change = (value: Partial<OfficeConnectorConfiguration>) => {
    setDraft(previous => ({ ...previous, ...value }))
    setPending(null)
    setError(null)
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || (!uncertain && stale)) return
    const input = pending ?? { ...draft, integrationId: id, revision, requestId: randomUUID() }
    setPending(input)
    setError(null)
    const result = await props.saveConnection(input)
    if (result.ok) { onClose(); return }
    if (result.error) {
      setError(result.error)
      setUncertain(result.error === 'unavailable')
      if (result.error !== 'unavailable') setPending(null)
    }
  }
  const invalidAuthentication = draft.enabled && draft.authentication.kind !== 'none' && !aliases.includes(draft.authentication.credential)
  return (
    <Modal open title={t('connectorConfigure')} closeLabel={t('close')} onClose={() => { if (!busy) onClose() }}>
      <form className={css.form} onSubmit={(event) => { void submit(event) }}>
        {(stale || error === 'conflict' || uncertain) && (
          <div role="alert" className={css.connectionSummary}>
            <p>{t(uncertain ? 'connectorUnknownSave' : 'connectorChanged')}</p>
            <Button disabled={busy} onClick={() => {
              setReloading(true)
              void props.loadConnections().then((fresh) => {
                if (!fresh) return
                const current = fresh.entries.find(entry => entry.integrationId === id)
                setRevision(current?.revision ?? 0)
                if (current?.configuration) setDraft(current.configuration)
                setPending(null); setUncertain(false); setError(null)
              }).catch(() => { setError('unavailable') }).finally(() => { setReloading(false) })
            }}>{t('connectorLoadLatest')}</Button>
          </div>
        )}
        {error && error !== 'conflict' && <p role="alert">{t(error)}</p>}
        <div>
          <p>{t('connectorAllowedOrigins')}</p>
          {view.allowedOrigins?.length ? <ul>{view.allowedOrigins.map(origin => <li key={origin}>{origin}</li>)}</ul>
            : <p>{t('connectorNoOrigins')}</p>}
        </div>
        <ConnectionChoice label={t('connectorAdapter')} value={draft.adapterId} disabled={frozen} empty={t('unassigned')}
          choices={view.adapters.map(adapter => ({ id: adapter, label: adapter }))}
          onChange={(adapterId) => { change({ adapterId }) }} />
        <label>{t('connectorAddress')}
          <Input type="url" required maxLength={2000} value={draft.baseUrl} disabled={frozen}
            onChange={(event) => { change({ baseUrl: event.target.value }) }} />
        </label>
        <label>{t('connectorProbePath')}
          <Input required maxLength={1000} value={draft.probePath} disabled={frozen}
            onChange={(event) => { change({ probePath: event.target.value }) }} />
        </label>
        <ConnectionChoice label={t('connectorAuthentication')} value={draft.authentication.kind} disabled={frozen}
          empty={t('unassigned')} choices={[
            { id: 'none', label: t('connectorNoAuth') }, { id: 'bearer', label: t('connectorBearer') },
            { id: 'header', label: t('connectorHeader') },
          ]} onChange={(kind) => {
            if (kind === 'none') change({ authentication: { kind } })
            else if (kind === 'bearer') change({ authentication: { kind, credential: aliases[0] ?? '' } })
            else if (kind === 'header') change({ authentication: { kind, credential: aliases[0] ?? '', header: 'X-API-Key' } })
          }} />
        {draft.authentication.kind !== 'none' && (
          <>
            <ConnectionChoice label={t('connectorCredential')} value={draft.authentication.credential}
              choices={aliases.map(alias => ({ id: alias, label: alias }))} disabled={frozen} empty={t('unassigned')}
              onChange={(credential) => {
                if (draft.authentication.kind !== 'none') change({ authentication: { ...draft.authentication, credential } })
              }} />
            <p className={css.accountHint}>{t(aliases.length ? 'connectorCredentialHint' : 'connectorNoCredentials')}</p>
          </>
        )}
        {draft.authentication.kind === 'header' && (
          <label>{t('connectorHeaderName')}
            <Input required maxLength={62} value={draft.authentication.header} disabled={frozen} onChange={(event) => {
              if (draft.authentication.kind === 'header') change({ authentication: { ...draft.authentication, header: event.target.value } })
            }} />
          </label>
        )}
        <Checkbox label={t('connectorEnabled')} checked={draft.enabled} disabled={frozen}
          onChange={(enabled) => { change({ enabled }) }} />
        <div className={css.row}>
          <Button disabled={busy} onClick={onClose}>{t('close')}</Button>
          <Button variant="primary" type="submit" disabled={busy || (!uncertain && (stale || invalidAuthentication))}>
            {t(uncertain ? 'retry' : 'save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
