/** Browser delivery rechecks the current administrator immediately before dispatching the reviewed audit file. */
import type { OfficeCollaborationModel } from './collaboration-model.ts'
import type { OfficeKey } from './locales.ts'

/** Download ports reuse the owning Office file saver and shared operation feedback. */
export interface OfficeAuditDownloadPorts {
  save(this: void, file: { readonly name: string }, data: Blob): void
  notify(this: void, key: OfficeKey, success: boolean): void
}

/**
 * Dispatch a single complete, reauthorized metadata file and report only an actual dispatch.
 * @param model - Current employee-owned query model; its export returns null on any partial failure.
 * @param ports - Existing browser file saver and Office feedback owner.
 * @returns Whether a file was dispatched; closing, role changes and failed saves produce no success feedback.
 */
export async function downloadOfficeAudit(model: Pick<OfficeCollaborationModel, 'state' | 'exportAudit'>,
  ports: OfficeAuditDownloadPorts): Promise<boolean> {
  const snapshot = model.state.getSnapshot()
  const current = () => {
    const latest = model.state.getSnapshot()
    return latest.visible && latest.epoch === snapshot.epoch && latest.principal?.id === snapshot.principal?.id &&
      latest.principal?.role === 'admin' && latest.principal.active
  }
  if(!current()) return false
  let file: Awaited<ReturnType<OfficeCollaborationModel['exportAudit']>>
  try { file = await model.exportAudit() }
  catch(_error) { if(current()) ports.notify('unavailable', false); return false }
  if(!file || !current()) return false
  try { ports.save({ name: 'office-governance.ndjson' }, new Blob([file.content], { type: file.mediaType })) }
  catch(_error) { if(current()) ports.notify('unavailable', false); return false }
  if(current()) ports.notify('auditDownloadStarted', true)
  return true
}
