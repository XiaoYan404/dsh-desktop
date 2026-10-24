/** Formal affiliations take precedence over legacy, self-editable contact labels. */
import type {
  OfficeMember,
  OfficeMemberId,
  OfficeOrganizationView,
  OfficeUnitId,
} from '@deepseek-ai/dsh-enterprise-office/types'

/**
 * Resolve display labels without changing the member record used for concurrency checks.
 * @param organization - Confirmed formal organization, absent before first configuration.
 * @param member - Contact with retained legacy labels.
 * @returns Formal names, or legacy labels until the organization is explicitly initialized.
 */
export function affiliation(
  organization: OfficeOrganizationView | undefined,
  member: Pick<OfficeMember, 'id' | 'department' | 'jobTitle'>,
): { department: string; jobTitle: string } {
  if (!organization)
    return { department: member.department, jobTitle: member.jobTitle }
  const assignment = organization.assignments.find(
    entry => entry.memberId === member.id,
  )
  return {
    department:
      organization.units.find(entry => entry.id === assignment?.unitId)
        ?.name ?? '',
    jobTitle:
      organization.positions.find(
        entry => entry.id === assignment?.positionId,
      )?.name ?? '',
  }
}

/**
 * Select a department and all its descendants using opaque identities rather than names.
 * @param organization - Authorized hierarchy.
 * @param selected - Department identity selected in the directory.
 * @returns Employee identities assigned anywhere in that branch.
 */
export function organizationMembers(
  organization: OfficeOrganizationView,
  selected: OfficeUnitId,
): ReadonlySet<OfficeMemberId> {
  const units = new Set<OfficeUnitId>([selected])
  const children = new Map<OfficeUnitId, OfficeUnitId[]>()
  for (const unit of organization.units) {
    if (unit.parentId === null) continue
    const entries = children.get(unit.parentId) ?? []
    entries.push(unit.id)
    children.set(unit.parentId, entries)
  }
  const pending = [selected]
  for (let id = pending.pop(); id; id = pending.pop()) {
    for (const child of children.get(id) ?? []) {
      if (units.has(child)) continue
      units.add(child)
      pending.push(child)
    }
  }
  return new Set(
    organization.assignments
      .filter(entry => entry.unitId !== null && units.has(entry.unitId))
      .map(entry => entry.memberId),
  )
}
