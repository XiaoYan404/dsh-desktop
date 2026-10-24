/** Administrator form keeps a reviewed snapshot separate from the editable draft. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeMember, OfficeMemberId, OfficeRole, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'

type MemberFormProps = OfficeProps & { view: OfficeView; member: OfficeMember | null; onClose(this: void): void }
const fields = ['name', 'department', 'jobTitle', 'email', 'phone'] as const
const memberFields = ['id', ...fields, 'role', 'active'] as const
const roles = ['employee', 'manager', 'admin'] as const

/** Submit only the record the administrator reviewed; Host rechecks both authority and concurrency. */
export function OfficeMemberForm(props: MemberFormProps) {
  const { t, view, member, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const [original, setOriginal] = useState(member)
  const [draft, setDraft] = useState<OfficeMember>(
    member ?? {
      id: '' as OfficeMemberId,
      name: '',
      department: '',
      jobTitle: '',
      email: '',
      phone: '',
      role: 'employee',
      active: true,
    },
  )
  const members = view.managedMembers ?? []
  const latest = original && members.find(entry => entry.id === original.id)
  const stale = original !== null && (!latest || memberFields.some(key => latest[key] !== original[key]))
  const duplicate = original === null && members.some(entry => entry.id === draft.id)
  const mustKeepAdmin =
    original?.active &&
    original.role === 'admin' &&
    !members.some(entry => entry.id !== original.id && entry.active && entry.role === 'admin')
  const invalidAdmin = mustKeepAdmin && (!draft.active || draft.role !== 'admin')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || stale || duplicate || invalidAdmin) return
    if (await props.saveMember(draft, original)) onClose()
  }
  return (
    <Modal
      open
      title={t(original ? 'editMember' : 'newMember')}
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
            <p>{t('memberChanged')}</p>
            <Button
              disabled={busy || !latest}
              onClick={() => {
                if (latest) {
                  setOriginal(latest)
                  setDraft(latest)
                }
              }}
            >
              {t('loadLatestMember')}
            </Button>
          </div>
        )}
        <label>
          {t('memberId')}
          <Input
            value={draft.id}
            required
            readOnly={original !== null}
            maxLength={128}
            pattern={'[a-zA-Z0-9_\\-]+'}
            aria-describedby="office-member-id-hint"
            onChange={(event) => {
              setDraft({ ...draft, id: event.target.value as OfficeMemberId })
            }}
          />
        </label>
        <small id="office-member-id-hint">{t('memberIdHint')}</small>
        {duplicate && <p role="alert">{t('duplicateMember')}</p>}
        {fields.filter(key => !view.organization || (key !== 'department' && key !== 'jobTitle')).map(key => (
          <label key={key}>
            {t(key)}
            <Input
              value={draft[key]}
              required={key === 'name'}
              maxLength={key === 'name' ? 100 : key === 'email' ? 320 : key === 'phone' ? 80 : 200}
              type={key === 'email' ? 'email' : 'text'}
              onChange={(event) => {
                setDraft({ ...draft, [key]: event.target.value })
              }}
            />
          </label>
        ))}
        {view.organization && <p className={css.accountHint}>{t('organizationManaged')}</p>}
        <label>
          {t('memberRole')}
          <select
            aria-label={t('memberRole')}
            value={draft.role}
            onChange={(event) => {
              setDraft({ ...draft, role: event.target.value as OfficeRole })
            }}
          >
            {roles.map(role => (
              <option key={role} value={role} disabled={Boolean(mustKeepAdmin && role !== 'admin')}>
                {t(role)}
              </option>
            ))}
          </select>
        </label>
        <Checkbox
          label={t('memberActive')}
          checked={draft.active}
          disabled={Boolean(mustKeepAdmin && draft.active)}
          onChange={(active) => {
            setDraft({ ...draft, active })
          }}
        />
        {mustKeepAdmin && <p>{t('lastAdmin')}</p>}
        <div className={css.row}>
          <Button disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={Boolean(busy || stale || duplicate || invalidAdmin)}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
