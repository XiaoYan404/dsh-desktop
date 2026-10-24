/** Shared own-profile form; the Host retains role and formal organization authority. */
import type { FormEvent } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeProfile, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import { formText } from './values.ts'
import { affiliation } from './organization.ts'
import css from './OfficePage.module.css'

/** Edit contact fields from either an office page or the native Conversation header. */
export function OfficeProfileForm(
  props: Pick<OfficeProps, 't' | 'useOffice' | 'updateProfile' | 'openAudit'> & { view: OfficeView; onClose(this: void): void },
) {
  const { t, view, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const fields = ['name', 'department', 'jobTitle', 'email', 'phone'] as const
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const profile: OfficeProfile = {
      name: formText(data, 'name'),
      department: view.organization ? view.me.department : formText(data, 'department'),
      jobTitle: view.organization ? view.me.jobTitle : formText(data, 'jobTitle'),
      email: formText(data, 'email'),
      phone: formText(data, 'phone'),
    }
    if (await props.updateProfile(profile)) onClose()
  }
  return (
    <Modal
      open
      title={t('profile')}
      className={css.detailDialog ?? ''}
      contentClassName={css.detailContent ?? ''}
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
          {t('accountScope')} · {t(view.me.role)}
        </p>
        {fields.map(key => (
          <label key={key}>
            {t(key)}
            <Input
              name={key}
              defaultValue={view.organization && (key === 'department' || key === 'jobTitle') ? affiliation(view.organization, view.me)[key] : view.me[key]}
              readOnly={Boolean(view.organization && (key === 'department' || key === 'jobTitle'))}
              required={key === 'name'}
              type={key === 'email' ? 'email' : 'text'}
            />
          </label>
        ))}
        {view.organization && <p className={css.accountHint}>{t('organizationManaged')}</p>}
        {view.me.role === 'admin' && <Button disabled={busy} onClick={() => {
          onClose()
          void props.openAudit()
        }}>{t('auditTitle')}</Button>}
        <div className={css.row}>
          <Button disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={busy} variant="primary" type="submit">
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
