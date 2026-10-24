/** Meeting edits keep the reviewed version separate from the draft and current server view. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OfficeItem, OfficeScheduleUpdateInput, OfficeView } from '@deepseek-ai/dsh-enterprise-office/types'
import type { OfficeProps } from './contracts.ts'
import css from './OfficePage.module.css'
import { OfficeScheduleOverlaps } from './OfficeScheduleOverlaps.tsx'
import { OfficeScheduleAvailability } from './OfficeScheduleAvailability.tsx'

type EditProps = OfficeProps & { view: OfficeView; item: OfficeItem; onClose(this: void): void }

function fields(item: OfficeItem): OfficeScheduleUpdateInput {
  return { title: item.title, description: item.description, date: item.date,
    startTime: item.time ?? '', endTime: item.endTime ?? '', location: item.location,
    inviteeIds: item.participants.filter(participant => participant.memberId !== item.creatorId).map(participant => participant.memberId) }
}

/** Only an explicit latest-record action replaces an edited draft after a conflict. */
export function OfficeScheduleEditForm(props: EditProps) {
  const { t, view, item, onClose } = props
  const busy = props.useOffice(state => state.busy)
  const [original, setOriginal] = useState(item)
  const [draft, setDraft] = useState<OfficeScheduleUpdateInput>(() => fields(item))
  const latest = view.items.find(entry => entry.id === original.id)
  const stale = !latest || latest.revision !== original.revision
  const closed = latest?.status === 'completed' || latest?.status === 'cancelled'
  const allowed = view.me.role === 'admin' || original.creatorId === view.me.id
  const invitees = draft.inviteeIds ?? []
  const memberOptions = [...view.members.map(member => ({ id: member.id, name: member.name })),
    ...original.participants.filter(participant => !view.members.some(member => member.id === participant.memberId))
      .map(participant => ({ id: participant.memberId, name: participant.memberId }))]
  const invalidTime = draft.endTime <= draft.startTime
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || stale || closed || !allowed || invalidTime || !draft.title.trim()) return
    if (await props.updateSchedule(original, draft)) { props.load(draft.date); onClose() }
  }
  return (
    <Modal open title={t('editSchedule')} closeLabel={t('close')}
      className={css.detailDialog ?? ''} contentClassName={css.detailContent ?? ''}
      onClose={() => { if (!busy) onClose() }}>
      <form className={css.form} onSubmit={(event) => { void submit(event) }}>
        {stale && <div role="alert">
          <p>{t('scheduleChanged')}</p>
          <Button disabled={busy || !latest} onClick={() => {
            if (latest) { setOriginal(latest); setDraft(fields(latest)) }
          }}>{t('loadLatestSchedule')}</Button>
        </div>}
        {closed && <p role="alert">{t('scheduleClosed')}</p>}
        <label>{t('title')}<Input value={draft.title} required maxLength={200} data-modal-autofocus
          onChange={(event) => { setDraft({ ...draft, title: event.target.value }) }} /></label>
        <label>{t('date')}<Input value={draft.date} type="date" required
          onChange={(event) => { setDraft({ ...draft, date: event.target.value }) }} /></label>
        <div className={css.row}>
          <label>{t('startTime')}<Input value={draft.startTime} type="time" required
            onChange={(event) => { setDraft({ ...draft, startTime: event.target.value }) }} /></label>
          <label>{t('endTime')}<Input value={draft.endTime} type="time" required
            onChange={(event) => { setDraft({ ...draft, endTime: event.target.value }) }} /></label>
        </div>
        {invalidTime && <p role="alert">{t('scheduleInvalidInterval')}</p>}
        <label>{t('location')}<Input value={draft.location ?? ''} maxLength={500}
          onChange={(event) => { setDraft({ ...draft, location: event.target.value }) }} /></label>
        <label>{t('description')}<textarea value={draft.description ?? ''} maxLength={16_000}
          onChange={(event) => { setDraft({ ...draft, description: event.target.value }) }} /></label>
        <fieldset disabled={busy || stale || closed || !allowed}>
          <legend>{t('participants')}</legend>
          {memberOptions.map(member => <Checkbox key={member.id} label={member.name}
            checked={member.id === original.creatorId || invitees.includes(member.id)}
            disabled={member.id === original.creatorId}
            onChange={(checked) => { setDraft({ ...draft, inviteeIds: checked
              ? [...invitees, member.id] : invitees.filter(id => id !== member.id) }) }} />)}
        </fieldset>
        <p>{t('scheduleMembersChangedHint')}</p>
        <p>{t('scheduleTimeChangedHint')}</p>
        <OfficeScheduleOverlaps t={t} view={view} date={draft.date} startTime={draft.startTime} endTime={draft.endTime}
          memberIds={[original.creatorId, ...invitees]} excludeId={original.id} />
        <OfficeScheduleAvailability t={t} view={view} checkScheduleAvailability={props.checkScheduleAvailability}
          date={draft.date} startTime={draft.startTime} endTime={draft.endTime}
          memberIds={[original.creatorId, ...invitees]} excludeItemId={original.id} />
        <div className={css.row}>
          <Button disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" type="submit" disabled={busy || stale || closed || !allowed || invalidTime || !draft.title.trim()}>
            {t('save')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
