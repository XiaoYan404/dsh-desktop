/** New audit workflow fixtures retain actual generated envelopes and the original employee-owned model. */
import { collaborationGuiFixture, guiMember, guiOk } from './collaboration-gui-fixture.ts'
import type { CollaborationAuditPage } from '../src/client/collaboration-audit.ts'

export function auditRows(count: number): CollaborationAuditPage['entries'] {
  const time = new Date('2026-10-25T12:00:00+08:00').getTime()
  return Array.from({ length: count }, (_, index) => ({ key: `execution:${index}`, source: 'execution', actorId: guiMember.id,
    targetId: 'reviewed-target', action: 'write_completed', time: time - index * 1000, decision: 'confirmed' as const }))
}
export function auditPage(entries: CollaborationAuditPage['entries'], total = entries.length, older = false): CollaborationAuditPage {
  const last = entries.at(-1)
  return { entries, total, next: older && last ? { time: last.time, key: last.key } : null,
    mediaType: 'application/x-ndjson', content: 'unreviewed-server-body\n' }
}
export async function auditWorkflowFixture(entries = auditRows(1), total = entries.length, older = false) {
  const fixture = collaborationGuiFixture()
  await fixture.model.open()
  fixture.remote.governanceAudit.mockResolvedValueOnce(guiOk(auditPage(entries, total, older)))
  await fixture.model.loadGovernance()
  return fixture
}
