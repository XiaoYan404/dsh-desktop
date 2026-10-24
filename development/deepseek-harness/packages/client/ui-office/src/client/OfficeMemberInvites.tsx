/** First-password codes and passwords stay in this dialog's transient component state and native form controls. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Input, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeMemberInvitesProps } from './contracts.ts'
import type { OfficeMemberInvitesModel } from './member-invites-model.ts'
import { formText } from './values.ts'
import css from './OfficePage.module.css'

type Snapshot = ReturnType<OfficeMemberInvitesModel['state']['getSnapshot']>
type Controls = Pick<OfficeMemberInvitesProps, 't' | 'closeMemberInvites' | 'refreshMemberInvites'
  | 'issueMemberInvite' | 'revokeMemberInvite' | 'acceptMemberInvite'>

/** Mount a fresh secret-free boundary for each dialog epoch, including a rapid close and reopen. */
export function OfficeMemberInvites(props: Controls & Pick<OfficeMemberInvitesProps, 'useMemberInvites'>) {
  const snapshot = props.useMemberInvites(value => value)
  if (snapshot.mode === 'closed') return null
  return <InvitationDialog key={snapshot.epoch} {...props} snapshot={snapshot} />
}

function InvitationDialog(props: Controls & { snapshot: Snapshot }) {
  const { t, snapshot } = props
  return <Modal open title={t(snapshot.mode === 'activate' ? 'memberInviteActivate' : 'memberInvites')}
    closeLabel={t('close')} onClose={() => { if (!snapshot.busy) props.closeMemberInvites() }}>
    {snapshot.mode === 'activate' ? <ActivationForm {...props} /> : <ManagementForm {...props} />}
  </Modal>
}

function ManagementForm(props: Controls & { snapshot: Snapshot }) {
  const { t, snapshot } = props
  const { view, member } = snapshot
  const [receipt, setReceipt] = useState<{ code?: string } | null>(null)
  const [copied, setCopied] = useState<boolean | null>(null)
  const expiry = localDateTime(Date.now() + Math.min(snapshot.maxTtlMs, 86400000) / 2)
  const issue = async (expiresAt: number, retry = false) => {
    setReceipt(null)
    setCopied(null)
    const value = await props.issueMemberInvite(expiresAt, retry)
    if (value) setReceipt(value.code === undefined ? {} : { code: value.code })
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const expiresAt = new Date(formText(new FormData(event.currentTarget), 'expiresAt')).getTime()
    void issue(expiresAt)
  }
  const status = view?.credentialPresent ? 'memberInviteEnrolled' : view?.revoked ? 'memberInviteRevoked'
    : view?.expired ? 'memberInviteExpired' : view?.requiresReview ? 'memberInviteReview'
      : view?.invitation ? 'memberInviteActive' : 'memberInviteNone'
  return <div className={css.form}>
    <p>{member?.name} · {member?.id}</p>
    <p className={css.accountHint}>{t('memberInviteHint')}</p>
    {snapshot.loading && !view && <p role="status">{t('loading')}</p>}
    {view && <>
      <p role="status">{t(status)}</p>
      {view.invitation && <p>{t('memberInviteExpiry')}: {new Date(view.invitation.expiresAt).toLocaleString()}</p>}
      {!view.credentialPresent && <form className={css.form} onSubmit={submit}>
        <label>{t('memberInviteExpiry')}<Input name="expiresAt" type="datetime-local" step="1" required defaultValue={expiry}
          disabled={snapshot.busy || snapshot.pending !== null} data-modal-autofocus /></label>
        {view.invitation && <small className={css.accountHint}>{t('memberInviteReplace')}</small>}
        <Button type="submit" variant="primary" disabled={snapshot.busy || snapshot.pending !== null}>{t('memberInviteIssue')}</Button>
      </form>}
      {view.invitation && !view.revoked && !view.credentialPresent && <div className={css.form}>
        <small className={css.accountHint}>{t('memberInviteRevokeHint')}</small>
        <Button disabled={snapshot.busy || snapshot.pending === 'issue'} onClick={() => {
          void props.revokeMemberInvite().then((confirmed) => { if (confirmed) { setReceipt(null); setCopied(null) } })
        }}>{t('memberInviteRevoke')}</Button>
      </div>}
    </>}
    {receipt && <section aria-label={t('memberInviteCurrent')}>
      {receipt.code ? <div className={css.form}>
        <p>{t('memberInviteCodeOnce')}</p>
        <label>{t('memberInviteCode')}<Input readOnly value={receipt.code} autoComplete="off" spellCheck={false} /></label>
        <Button onClick={() => { void writeClipboard(receipt.code ?? '').then(setCopied) }}>{t('memberInviteCopy')}</Button>
        {copied !== null && <p role={copied ? 'status' : 'alert'}>{t(copied ? 'memberInviteCopied' : 'memberInviteCopyFailed')}</p>}
      </div> : <p role="status">{t('memberInviteNoCode')}</p>}
    </section>}
    {snapshot.error && <p role="alert">{t(snapshot.error)}</p>}
    <div className={css.row}>
      {snapshot.pending === 'issue' && <Button disabled={snapshot.busy}
        onClick={() => { void issue(0, true) }}>{t('memberInviteRetry')}</Button>}
      <Button disabled={snapshot.busy} onClick={props.refreshMemberInvites}>{t('refresh')}</Button>
      <Button disabled={snapshot.busy} onClick={props.closeMemberInvites}>{t('close')}</Button>
    </div>
  </div>
}

function ActivationForm(props: Controls & { snapshot: Snapshot }) {
  const { t, snapshot } = props
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const password = formText(data, 'newPassword')
    const confirmation = form.elements.namedItem('confirmPassword')
    if (!(confirmation instanceof HTMLInputElement)) return
    confirmation.setCustomValidity(password === formText(data, 'confirmPassword') ? '' : t('passwordMismatch'))
    if (!form.reportValidity()) return
    if (await props.acceptMemberInvite(formText(data, 'code').trim(), password)) form.reset()
  }
  return <form className={css.form} onSubmit={(event) => { void submit(event) }}>
    <p className={css.accountHint}>{t('memberInviteAcceptHint')}</p>
    <label>{t('memberInviteCode')}<Input name="code" required autoComplete="one-time-code" maxLength={43} minLength={43}
      pattern={'[A-Za-z0-9_\\-]{43}'} disabled={snapshot.busy} data-modal-autofocus /></label>
    <label>{t('newPassword')}<Input name="newPassword" type="password" required minLength={15} maxLength={1024}
      autoComplete="new-password" disabled={snapshot.busy} onInput={(event) => {
        const confirmation = event.currentTarget.form?.elements.namedItem('confirmPassword')
        if (confirmation instanceof HTMLInputElement) confirmation.setCustomValidity('')
      }} /></label>
    <label>{t('confirmPassword')}<Input name="confirmPassword" type="password" required minLength={15} maxLength={1024}
      autoComplete="new-password" disabled={snapshot.busy} onInput={(event) => { event.currentTarget.setCustomValidity('') }} /></label>
    <small className={css.accountHint}>{t('passwordHint')}</small>
    {snapshot.error && <p role="alert">{t(snapshot.error)}</p>}
    <div className={css.row}>
      <Button disabled={snapshot.busy} onClick={props.closeMemberInvites}>{t('memberInviteBack')}</Button>
      <Button type="submit" variant="primary" disabled={snapshot.busy}>{t('memberInviteConfirm')}</Button>
    </div>
  </form>
}

function localDateTime(time: number): string {
  const date = new Date(time)
  const wall = new Date(time - date.getTimezoneOffset() * 60000)
  return wall.toISOString().slice(0, 19)
}
