/** Company login and own-account controls use injected callbacks, never Host services or secret storage. */
import { useEffect } from 'react'
import type { FormEvent } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  OfficeMember,
  OfficeMemberId,
} from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import { formText } from './values.ts'
import css from './OfficePage.module.css'

/** Login form retains failed input in the form and removes passwords when authentication succeeds. */
export function OfficeLogin(props: OfficeProps) {
  const { t } = props
  const { busy, error, memberInvitations, invitedMemberId } = props.useConnection(value => value)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    if (
      await props.signIn({
        memberId: formText(data, 'memberId') as OfficeMemberId,
        password: formText(data, 'password'),
      })
    )
      form.reset()
  }
  return (
    <section
      className={`${css.card} ${css.login}`}
      aria-label={t('officeSignIn')}
    >
      <h2>{t('officeSignIn')}</h2>
      <p className={css.accountHint}>{t('officeSignInHint')}</p>
      <form
        className={css.form}
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <label>
          {t('memberId')}
          <Input
            key={invitedMemberId}
            name="memberId"
            defaultValue={invitedMemberId ?? undefined}
            autoComplete="username"
            required
            maxLength={128}
            pattern={'[a-zA-Z0-9_\\-]+'}
            disabled={busy}
          />
        </label>
        <label>
          {t('password')}
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            disabled={busy}
          />
        </label>
        {error && (
          <p role="alert">
            {t(error === 'unauthenticated' ? 'signInDenied' : error)}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {t('signIn')}
        </Button>
      </form>
      {memberInvitations?.protocol === 1 && props.openMemberInvites && <Button variant="ghost" disabled={busy}
        onClick={() => { props.openMemberInvites?.(null) }}>{t('memberInviteActivate')}</Button>}
    </section>
  )
}

/** Own password and device sessions are available only in authenticated central-office mode. */
export function OfficeAccount(
  props: OfficeProps & { onClose(this: void): void },
) {
  const { t, loadSessions, onClose } = props
  const { busy, error, sessions } = props.useConnection(value => value)
  useEffect(() => {
    loadSessions()
  }, [loadSessions])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const next = formText(data, 'newPassword')
    if (
      !matching(
        form,
        next,
        formText(data, 'confirmPassword'),
        t('passwordMismatch'),
      )
    )
      return
    if (
      await props.changePassword({
        currentPassword: formText(data, 'currentPassword'),
        newPassword: next,
      })
    ) {
      form.reset()
      onClose()
    }
  }
  return (
    <Modal
      open
      title={t('account')}
      closeLabel={t('close')}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <div className={css.form}>
        <form
          className={css.form}
          onSubmit={(event) => {
            void submit(event)
          }}
        >
          <label>
            {t('currentPassword')}
            <Input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1024}
              disabled={busy}
            />
          </label>
          <label>
            {t('newPassword')}
            <Input
              name="newPassword"
              onInput={(event) => { clearConfirmation(event.currentTarget.form) }}
              type="password"
              autoComplete="new-password"
              required
              minLength={15}
              maxLength={1024}
              disabled={busy}
            />
          </label>
          <label>
            {t('confirmPassword')}
            <Input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={15}
              maxLength={1024}
              disabled={busy}
              onInput={(event) => {
                event.currentTarget.setCustomValidity('')
              }}
            />
          </label>
          <small className={css.accountHint}>
            {t('passwordHint')}
            <br />
            {t('passwordRevokesSessions')}
          </small>
          <Button type="submit" disabled={busy}>
            {t('changePassword')}
          </Button>
        </form>
        <section aria-label={t('deviceSessions')}>
          <div className={css.row}>
            <h2>{t('deviceSessions')}</h2>
            <Button size="sm" onClick={loadSessions} disabled={busy}>
              {t('retry')}
            </Button>
          </div>
          {error && <p role="alert">{t(error)}</p>}
          {sessions === null ? (
            !error && <progress aria-label={t('loading')} />
          ) : sessions.length === 0 ? (
            <p>{t('noSessions')}</p>
          ) : (
            <ul className={css.sessions}>
              {sessions.map(session => (
                <li key={session.id} className={css.session}>
                  <div>
                    {session.current && <span>{t('currentSession')}</span>}
                    <small>
                      {t('sessionCreated')} ·{' '}
                      {new Date(session.createdAt).toLocaleString()}
                    </small>
                    <small>
                      {t('sessionExpires')} ·{' '}
                      {new Date(session.expiresAt).toLocaleString()}
                    </small>
                  </div>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void props.revokeSession(session.id)
                    }}
                  >
                    {t('revokeSession')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className={css.row}>
          <Button
            disabled={busy}
            onClick={() => {
              void props.signOut()
            }}
          >
            {t('signOut')}
          </Button>
          <Button disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Administrator form operates on a retained directory identity and shows credential presence only. */
export function OfficeCredentials(
  props: OfficeProps & { member: OfficeMember; onClose(this: void): void },
) {
  const { t, member, onClose, loadEnrollment } = props
  const { busy, enrollment, error, memberInvitations } = props.useConnection(value => value)
  useEffect(() => {
    loadEnrollment()
  }, [loadEnrollment])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const password = formText(data, 'newPassword')
    if (
      !matching(
        form,
        password,
        formText(data, 'confirmPassword'),
        t('passwordMismatch'),
      )
    )
      return
    if (await props.enrollMember(member.id, password)) {
      form.reset()
      onClose()
    }
  }
  return (
    <Modal
      open
      title={t('managePassword')}
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
          {member.name} · {member.id}
        </p>
        {enrollment && (
          <small>
            {t(
              enrollment.enrolledMemberIds.includes(member.id)
                ? 'credentialEnrolled'
                : 'credentialNotEnrolled',
            )}
          </small>
        )}
        <label>
          {t('newPassword')}
          <Input
            name="newPassword"
            onInput={(event) => { clearConfirmation(event.currentTarget.form) }}
            type="password"
            autoComplete="new-password"
            required
            minLength={15}
            maxLength={1024}
            disabled={busy}
            data-modal-autofocus
          />
        </label>
        <label>
          {t('confirmPassword')}
          <Input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={15}
            maxLength={1024}
            disabled={busy}
            onInput={(event) => {
              event.currentTarget.setCustomValidity('')
            }}
          />
        </label>
        <small className={css.accountHint}>
          {t('passwordHint')}
          <br />
          {t('resetPasswordHint')}
        </small>
        {error && <p role="alert">{t(error)}</p>}
        {memberInvitations?.protocol === 1 && props.openMemberInvites && member.active && <Button disabled={busy}
          onClick={() => { onClose(); props.openMemberInvites?.(member.id) }}>{t('memberInvites')}</Button>}
        <div className={css.row}>
          <Button onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !member.active}
          >
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function clearConfirmation(form: HTMLFormElement | null): void {
  const field = form?.elements.namedItem('confirmPassword')
  if (field instanceof HTMLInputElement) field.setCustomValidity('')
}

function matching(
  form: HTMLFormElement,
  password: string,
  confirmation: string,
  message: string,
): boolean {
  const field = form.elements.namedItem('confirmPassword')
  if (!(field instanceof HTMLInputElement)) return false
  field.setCustomValidity(password === confirmation ? '' : message)
  return form.reportValidity()
}
