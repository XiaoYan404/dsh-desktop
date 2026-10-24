/** Existing shell overlay composition for private automation rules, immutable reviews and explicit recovery. */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { OfficeAutomationRule } from '@deepseek-ai/dsh-enterprise-office'
import type { OfficeAutomationModel } from './automation-model.ts'
import type { OfficeModel } from './model.ts'
import { translateOfficeAutomation } from './automation-copy.ts'
import type { OfficeAutomationCopyKey } from './automation-copy.ts'
import { OfficeAutomations } from './OfficeAutomations.tsx'
import { OfficeAutomationEditor } from './OfficeAutomationEditor.tsx'
import css from './OfficeAutomations.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { officeAutomation: OfficeAutomationCopyKey }
}

/** Injected controller callbacks and observable data; components receive no credentials or raw Remote. */
export interface OfficeAutomationInjected {
  readonly hooks: { readonly automations: OfficeAutomationModel['state']
    readonly office: OfficeModel['state'] }
  closeAutomation(this: void): void
  createAutomation(this: void): void
  editAutomation(this: void, rule: OfficeAutomationRule): void
  readonly selectAutomationSystem: OfficeAutomationModel['edit']
  readonly saveAutomation: OfficeAutomationModel['save']
  closeAutomationEditor(this: void): void
  readonly toggleAutomation: OfficeAutomationModel['toggle']
  readonly triggerAutomationForm: OfficeAutomationModel['triggerForm']
  readonly refreshAutomations: OfficeAutomationModel['refresh']
  readonly reviewAutomation: OfficeAutomationModel['review']
  readonly confirmAutomation: OfficeAutomationModel['confirm']
  closeAutomationReview(this: void): void
  readonly manageAutomation: OfficeAutomationModel['manage']
  readonly recoverAutomation: OfficeAutomationModel['recover']
}
type Props = PropsRuntime<'shell.overlay'> & PropsLocale<'officeAutomation'> & InjectFace<OfficeAutomationInjected>

/**
 * Adapt framework snapshot hooks to the data-only editor and run list.
 * @param props - Existing Slot/Locale data and authenticated controller callbacks.
 * @returns Closed presentation while inactive; no read or mutation starts merely by rendering.
 */
export function OfficeAutomationOverlay(props: Props) {
  const snapshot = props.useAutomations(value => value)
  const systems = props.useOffice(value => value.view?.integrations?.entries ?? [])
  const labels = translateOfficeAutomation(props.t)
  if (!snapshot.opened) return null
  return <Modal open title={labels.title} closeLabel={labels.close} onClose={props.closeAutomation}
    className={css.dialog ?? ''} contentClassName={css.content ?? ''}
    footer={<Button onClick={props.closeAutomation}>{labels.close}</Button>}>
    <OfficeAutomations labels={labels} rules={snapshot.rules} runs={snapshot.runs} busy={snapshot.busy}
      error={snapshot.error === 'unavailable' && !snapshot.loaded ? labels.serviceUnavailable
        : snapshot.error ? labels[snapshot.error] : null} review={snapshot.review}
      systems={systems} needsRefresh={snapshot.needsRefresh} available={snapshot.loaded}
      createRule={props.createAutomation} editRule={props.editAutomation}
      toggleRule={(rule) => { void props.toggleAutomation(rule) }}
      triggerForm={(rule) => { void props.triggerAutomationForm(rule) }} refresh={() => { void props.refreshAutomations() }}
      reviewRun={(id, part) => { void props.reviewAutomation(id, part) }}
      confirmReview={(review) => { void props.confirmAutomation(review) }} closeReview={props.closeAutomationReview}
      manageRun={(run, command) => { void props.manageAutomation(run, command) }}
      recoverRun={(id, part) => { void props.recoverAutomation(id, part) }} />
    {snapshot.editor && snapshot.directory && <OfficeAutomationEditor key={JSON.stringify([snapshot.editor, snapshot.directory])}
      initial={snapshot.editor} directory={snapshot.directory} systems={systems} labels={labels} busy={snapshot.busy}
      error={snapshot.error ? labels[snapshot.error] : null} saveUncertain={snapshot.saveUncertain}
      refresh={() => { void props.refreshAutomations() }}
      close={props.closeAutomationEditor} selectSystem={(id, draft) => { void props.selectAutomationSystem(id, draft) }}
      save={(draft) => { void props.saveAutomation(draft) }} />}
  </Modal>
}
