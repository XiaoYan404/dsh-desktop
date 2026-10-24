/** Administrator-reviewed first configuration and versioned formal organization forms. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  Button,
  Checkbox,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  OfficeAssignmentInput,
  OfficeMember,
  OfficeOrganizationUnit,
  OfficeOrganizationView,
  OfficePosition,
  OfficePositionId,
  OfficeUnitId,
  OfficeView,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import { organizationMembers } from './organization.ts'
import css from './OfficePage.module.css'

type OrganizationProps = OfficeProps & { view: OfficeView }
type ConfiguredProps = OrganizationProps & {
  organization: OfficeOrganizationView
}

/** Formal entities have independent identities and versions; contact labels remain available until setup. */
export function OfficeOrganization(props: OrganizationProps) {
  const { t, view } = props
  const [setup, setSetup] = useState(false)
  const [unit, setUnit] = useState<OfficeOrganizationUnit | null | undefined>(
    undefined,
  )
  const [position, setPosition] = useState<OfficePosition | null | undefined>(
    undefined,
  )
  const organization = view.organization
  return (
    <section className={css.card} aria-label={t('organization')}>
      <h2>{t('organization')}</h2>
      {!organization ? (
        <>
          <p>{t('organizationSetupHint')}</p>
          <Button
            onClick={() => {
              setSetup(true)
            }}
          >
            {t('organizationSetup')}
          </Button>
          {setup && (
            <OrganizationSetup
              {...props}
              onClose={() => {
                setSetup(false)
              }}
            />
          )}
        </>
      ) : (
        <>
          <div className={css.organizationColumns}>
            <section aria-label={t('departments')}>
              <div className={css.row}>
                <h3>{t('departments')}</h3>
                <Button
                  onClick={() => {
                    setUnit(null)
                  }}
                >
                  {t('newDepartment')}
                </Button>
              </div>
              {organization.units.length === 0 && (
                <p>{t('organizationEmpty')}</p>
              )}
              <ul className={css.entityList}>
                {organization.units.map(entry => (
                  <li key={entry.id} data-office-unit={entry.id}>
                    <div>
                      <span>{entry.name}</span>
                      <small>
                        {entry.parentId
                          ? organization.units.find(
                            parent => parent.id === entry.parentId,
                          )?.name
                          : t('rootDepartment')}
                        {!entry.active && ` · ${t('inactive')}`}
                      </small>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        setUnit(entry)
                      }}
                    >
                      {t('editDepartment')}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-label={t('positions')}>
              <div className={css.row}>
                <h3>{t('positions')}</h3>
                <Button
                  onClick={() => {
                    setPosition(null)
                  }}
                >
                  {t('newPosition')}
                </Button>
              </div>
              {organization.positions.length === 0 && (
                <p>{t('organizationEmpty')}</p>
              )}
              <ul className={css.entityList}>
                {organization.positions.map(entry => (
                  <li key={entry.id} data-office-position={entry.id}>
                    <div>
                      <span>{entry.name}</span>
                      <small>
                        {entry.unitId
                          ? organization.units.find(
                            parent => parent.id === entry.unitId,
                          )?.name
                          : t('globalPosition')}
                        {!entry.active && ` · ${t('inactive')}`}
                      </small>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        setPosition(entry)
                      }}
                    >
                      {t('editPosition')}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <p className={css.accountHint}>{t('inUseOrganizationHint')}</p>
          {unit !== undefined && (
            <OrganizationEntityForm
              {...props}
              organization={organization}
              kind="unit"
              entry={unit}
              onClose={() => {
                setUnit(undefined)
              }}
            />
          )}
          {position !== undefined && (
            <OrganizationEntityForm
              {...props}
              organization={organization}
              kind="position"
              entry={position}
              onClose={() => {
                setPosition(undefined)
              }}
            />
          )}
        </>
      )}
    </section>
  )
}

function OrganizationSetup(
  props: OrganizationProps & { onClose(this: void): void },
) {
  const { view, t, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const [review, setReview] = useState<OfficeView | null>(null)
  const stale = review !== null && review.revision !== view.revision
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || stale || !review) return
    if (await props.initializeOrganization(review.revision)) onClose()
  }
  return (
    <Modal
      open
      title={t('organizationSetup')}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className={css.form}
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        {!review ? (
          <>
            <label>
              {t('companyName')}
              <Input value={view.companyName} readOnly />
            </label>
            <label>
              {t('timeZone')}
              <Input value={view.timeZone} readOnly />
            </label>
            <p>{t('organizationSetupHint')}</p>
            <div className={css.row}>
              <Button onClick={onClose}>{t('cancel')}</Button>
              <Button
                variant="primary"
                onClick={(event) => {
                  // This node becomes a submit button after the step changes.
                  event.preventDefault()
                  setReview(view)
                }}
              >
                {t('reviewOrganization')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p>{t('organizationReviewHint')}</p>
            <div className={css.organizationReview}>
              <table>
                <thead>
                  <tr>
                    <th>{t('name')}</th>
                    <th>{t('department')}</th>
                    <th>{t('jobTitle')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(review.managedMembers ?? review.members).map(member => (
                    <tr key={member.id}>
                      <td>
                        {member.name}
                        {!member.active && ` · ${t('inactive')}`}
                      </td>
                      <td>{member.department || t('unassigned')}</td>
                      <td>{member.jobTitle || t('unassigned')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {stale && (
              <div role="alert">
                <p>{t('organizationChanged')}</p>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setReview(view)
                  }}
                >
                  {t('loadLatestMember')}
                </Button>
              </div>
            )}
            <div className={css.row}>
              <Button
                disabled={busy}
                onClick={() => {
                  setReview(null)
                }}
              >
                {t('backToCompany')}
              </Button>
              <Button variant="primary" type="submit" disabled={busy || stale}>
                {t('confirmOrganization')}
              </Button>
            </div>
          </>
        )}
      </form>
    </Modal>
  )
}

function OrganizationEntityForm(
  props:
    | (ConfiguredProps & {
      kind: 'unit'
      entry: OfficeOrganizationUnit | null
      onClose(this: void): void
    })
    | (ConfiguredProps & {
      kind: 'position'
      entry: OfficePosition | null
      onClose(this: void): void
    }),
) {
  const { t, organization, kind, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const [original, setOriginal] = useState(props.entry)
  const [name, setName] = useState(props.entry?.name ?? '')
  const [active, setActive] = useState(props.entry?.active ?? true)
  const [parent, setParent] = useState<OfficeUnitId | null>(
    props.kind === 'unit'
      ? (props.entry?.parentId ?? null)
      : (props.entry?.unitId ?? null),
  )
  const latest =
    kind === 'unit'
      ? organization.units.find(entry => entry.id === original?.id)
      : organization.positions.find(entry => entry.id === original?.id)
  const stale =
    original !== null && (!latest || latest.revision !== original.revision)
  const descendants = new Set<OfficeUnitId>()
  if (kind === 'unit' && original) {
    const queue = [original.id as OfficeUnitId]
    for (let id = queue.pop(); id; id = queue.pop()) {
      if (descendants.has(id)) continue
      descendants.add(id)
      for (const child of organization.units)
        if (child.parentId === id) queue.push(child.id)
    }
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || stale || !name.trim()) return
    const values = { revision: original?.revision ?? 0, name, active }
    const result =
      kind === 'unit'
        ? await props.saveOrganizationUnit({
          ...values,
          id: original ? (original.id as OfficeUnitId) : null,
          parentId: parent,
        })
        : await props.savePosition({
          ...values,
          id: original ? (original.id as OfficePositionId) : null,
          unitId: parent,
        })
    if (result) onClose()
  }
  const titleKey =
    kind === 'unit'
      ? original
        ? 'editDepartment'
        : 'newDepartment'
      : original
        ? 'editPosition'
        : 'newPosition'
  return (
    <Modal
      open
      title={t(titleKey)}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className={css.form}
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        {stale && (
          <div role="alert">
            <p>{t('organizationChanged')}</p>
            <Button
              disabled={busy || !latest}
              onClick={() => {
                if (!latest) return
                setOriginal(latest)
                setName(latest.name)
                setActive(latest.active)
                setParent(
                  'parentId' in latest ? latest.parentId : latest.unitId,
                )
              }}
            >
              {t('loadLatestMember')}
            </Button>
          </div>
        )}
        <label>
          {t(kind === 'unit' ? 'departmentName' : 'positionName')}
          <Input
            value={name}
            required
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </label>
        <label>
          {t(kind === 'unit' ? 'parentDepartment' : 'positionDepartment')}
          <select
            aria-label={t(kind === 'unit' ? 'parentDepartment' : 'positionDepartment')}
            value={parent ?? ''}
            onChange={(event) => {
              setParent((event.target.value as OfficeUnitId) || null)
            }}
          >
            <option value="">
              {t(kind === 'unit' ? 'rootDepartment' : 'globalPosition')}
            </option>
            {organization.units
              .filter(
                entry =>
                  (entry.active || entry.id === parent) &&
                  !descendants.has(entry.id),
              )
              .map(entry => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                  {!entry.active && ` · ${t('inactive')}`}
                </option>
              ))}
          </select>
        </label>
        <Checkbox
          label={t('organizationActive')}
          checked={active}
          onChange={setActive}
        />
        <div className={css.row}>
          <Button disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || stale || !name.trim()}
          >
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** Assignment versions are separate from contact profiles, department names and account roles. */
export function OfficeAffiliationForm(
  props: ConfiguredProps & { member: OfficeMember; onClose(this: void): void },
) {
  const { t, view, organization, member, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const latest: OfficeAssignmentInput = organization.assignments.find(
    entry => entry.memberId === member.id,
  ) ?? { memberId: member.id, unitId: null, positionId: null, revision: 0 }
  const [original, setOriginal] = useState(latest)
  const [draft, setDraft] = useState(latest)
  const stale = latest.revision !== original.revision
  const current = view.managedMembers?.find(entry => entry.id === member.id)
  const active = current?.active === true
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (
      busy ||
      stale ||
      !current ||
      (!active && (draft.unitId !== null || draft.positionId !== null))
    )
      return
    if (await props.assignOrganization(draft)) onClose()
  }
  return (
    <Modal
      open
      title={t('affiliation')}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        className={css.form}
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <p>
          {current?.name ?? member.name} · {t('affiliationHint')}
        </p>
        {stale && (
          <div role="alert">
            <p>{t('organizationChanged')}</p>
            <Button
              disabled={busy}
              onClick={() => {
                setOriginal(latest)
                setDraft(latest)
              }}
            >
              {t('loadLatestMember')}
            </Button>
          </div>
        )}
        {!active && <p>{t('inactiveAffiliationHint')}</p>}
        <label>
          {t('department')}
          <select
            aria-label={t('department')}
            value={draft.unitId ?? ''}
            disabled={!active}
            onChange={(event) => {
              const unitId = (event.target.value as OfficeUnitId) || null
              const position = organization.positions.find(
                entry => entry.id === draft.positionId,
              )
              setDraft({
                ...draft,
                unitId,
                positionId:
                  position?.unitId && position.unitId !== unitId
                    ? null
                    : draft.positionId,
              })
            }}
          >
            <option value="">{t('unassigned')}</option>
            {organization.units
              .filter(entry => entry.active || entry.id === draft.unitId)
              .map(entry => (
                <option
                  key={entry.id}
                  value={entry.id}
                  disabled={!entry.active}
                >
                  {entry.name}
                  {!entry.active && ` · ${t('inactive')}`}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t('jobTitle')}
          <select
            aria-label={t('jobTitle')}
            value={draft.positionId ?? ''}
            disabled={!active}
            onChange={(event) => {
              setDraft({
                ...draft,
                positionId: (event.target.value as OfficePositionId) || null,
              })
            }}
          >
            <option value="">{t('unassigned')}</option>
            {organization.positions
              .filter(
                entry =>
                  (entry.active &&
                    (entry.unitId === null || entry.unitId === draft.unitId)) ||
                  entry.id === draft.positionId,
              )
              .map(entry => (
                <option
                  key={entry.id}
                  value={entry.id}
                  disabled={!entry.active}
                >
                  {entry.name}
                  {!entry.active && ` · ${t('inactive')}`}
                </option>
              ))}
          </select>
        </label>
        <Button
          disabled={busy}
          onClick={() => {
            setDraft({ ...draft, unitId: null, positionId: null })
          }}
        >
          {t('clearAffiliation')}
        </Button>
        <div className={css.row}>
          <Button disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={
              busy ||
              stale ||
              !current ||
              (!active && (draft.unitId !== null || draft.positionId !== null))
            }
          >
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** Hierarchical department filters include descendants and preserve explicit unassigned members. */
export function OfficeOrganizationTree(props: {
  organization: OfficeOrganizationView
  selected: OfficeUnitId | 'all' | 'unassigned'
  onSelect(this: void, id: OfficeUnitId | 'all' | 'unassigned'): void
  t: OfficeProps['t']
}) {
  const { organization, selected, onSelect, t } = props
  const render = (parentId: OfficeUnitId | null) => (
    <ul>
      {organization.units
        .filter(entry => entry.parentId === parentId)
        .map(entry => (
          <li key={entry.id}>
            <button
              type="button"
              aria-pressed={selected === entry.id}
              onClick={() => {
                onSelect(entry.id)
              }}
            >
              {entry.name}
              {!entry.active && ` · ${t('inactive')}`}{' '}
              <small>{organizationMembers(organization, entry.id).size}</small>
            </button>
            {render(entry.id)}
          </li>
        ))}
    </ul>
  )
  return (
    <nav className={css.organizationTree} aria-label={t('organization')}>
      <Button
        aria-pressed={selected === 'all'}
        onClick={() => {
          onSelect('all')
        }}
      >
        {t('allDepartments')}
      </Button>
      {render(null)}
      <Button
        aria-pressed={selected === 'unassigned'}
        onClick={() => {
          onSelect('unassigned')
        }}
      >
        {t('unassignedMembers')}
      </Button>
    </nav>
  )
}
