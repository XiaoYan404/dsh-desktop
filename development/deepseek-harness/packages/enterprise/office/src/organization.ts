/** Formal organization is authoritative only after administrator review, separate from contact profile labels. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { OfficeError } from './error.ts'
import { officeMemberId } from './spec.ts'
import type {
  OfficeAssignmentInput,
  OfficeMember,
  OfficeOrganizationAssignment,
  OfficeOrganizationUnit,
  OfficeOrganizationView,
  OfficePosition,
  OfficePositionId,
  OfficePositionInput,
  OfficeUnitId,
  OfficeUnitInput,
} from './types.ts'

const unitId = z.uuid().transform(value => brandString<OfficeUnitId>(value))
const positionId = z
  .uuid()
  .transform(value => brandString<OfficePositionId>(value))
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const observed = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const name = z
  .string()
  .trim()
  .normalize('NFC')
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/)
const unit = z
  .object({
    id: unitId,
    parentId: unitId.nullable(),
    name,
    active: z.boolean(),
    revision,
  })
  .strict()
const position = z
  .object({
    id: positionId,
    unitId: unitId.nullable(),
    name,
    active: z.boolean(),
    revision,
  })
  .strict()
const assignment = z
  .object({
    memberId: officeMemberId,
    unitId: unitId.nullable(),
    positionId: positionId.nullable(),
    revision,
  })
  .strict()
const unitInput = unit
  .extend({ id: unitId.nullable(), revision: observed })
  .refine(value =>
    value.id === null ? value.revision === 0 : value.revision > 0,
  )
const positionInput = position
  .extend({ id: positionId.nullable(), revision: observed })
  .refine(value =>
    value.id === null ? value.revision === 0 : value.revision > 0,
  )
const assignmentInput = assignment.extend({ revision: observed })
const audit = z
  .object({
    revision,
    actorId: officeMemberId,
    action: z.enum([
      'initialized',
      'unit_saved',
      'position_saved',
      'assignment_saved',
    ]),
    targetId: z.string().min(1).max(128),
    time: z.number().int().nonnegative(),
  })
  .strict()
const state = z
  .object({
    initialized: z.boolean(),
    revision: observed,
    units: z.array(unit).max(1000).readonly(),
    positions: z.array(position).max(5000).readonly(),
    assignments: z.array(assignment).max(20_000).readonly(),
    audit: z.array(audit).max(1000).readonly(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const units = new Map(value.units.map(entry => [entry.id, entry]))
    const positions = new Map(
      value.positions.map(entry => [entry.id, entry]),
    )
    const sibling = (parent: string | null, label: string) =>
      JSON.stringify([parent, label.toLowerCase()])
    if (
      units.size !== value.units.length ||
      positions.size !== value.positions.length ||
      new Set(value.assignments.map(entry => entry.memberId)).size !==
        value.assignments.length ||
      new Set(value.units.map(entry => sibling(entry.parentId, entry.name)))
        .size !== value.units.length ||
      new Set(value.positions.map(entry => sibling(entry.unitId, entry.name)))
        .size !== value.positions.length ||
      value.positions.some(
        entry => entry.unitId !== null && !units.has(entry.unitId),
      ) ||
      value.assignments.some(
        entry =>
          (entry.unitId !== null && !units.has(entry.unitId)) ||
          (entry.positionId !== null && !positions.has(entry.positionId)),
      ) ||
      value.audit.some(entry => entry.revision > value.revision) ||
      (!value.initialized &&
        (value.revision > 0 ||
          value.units.length ||
          value.positions.length ||
          value.assignments.length ||
          value.audit.length)) ||
      (value.initialized && value.revision === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid formal organization references or initialization',
      })
    }
    for (const entry of value.units) {
      const seen = new Set([entry.id])
      let parent = entry.parentId
      while (parent !== null) {
        const ancestor = units.get(parent)
        if (!ancestor || seen.has(parent) || seen.size >= 64) {
          ctx.addIssue({
            code: 'custom',
            message: 'Department ancestry is missing, cyclic or too deep',
          })
          break
        }
        seen.add(parent)
        parent = ancestor.parentId
      }
    }
  })

/** Network and local adapters admit the same reviewed organization inputs. */
export const officeOrganizationSchemas = {
  unitInput,
  positionInput,
  assignmentInput,
}

/** Independent version 1 unit leaves existing office, identity and Agent history schemas intact. */
export const officeOrganizationDomain = defineDomain({
  name: 'enterprise_office_organization',
  version: 1,
  global: {
    schema: state,
    initial: {
      initialized: false,
      revision: 0,
      units: [],
      positions: [],
      assignments: [],
      audit: [],
    },
  },
  tables: {},
})

type OrganizationState = z.infer<typeof state>

/** Called only inside the shared office queue for writes; entity names never become paths or permissions. */
export class OfficeOrganizationRepository {
  constructor(
    private readonly domain: Domain<typeof officeOrganizationDomain>,
    private readonly changed: () => Promise<void>,
  ) {}

  /**
   * Check saved directory references without creating or replacing historical identities.
   * @param members - Complete retained office directory.
   */
  verifyDirectory(members: readonly OfficeMember[]): void {
    const ids = new Set(members.map(member => member.id))
    const state = this.domain.global.get()
    if (
      state.assignments.some(entry => !ids.has(entry.memberId)) ||
      state.audit.some(entry => !ids.has(entry.actorId))
    )
      throw new OfficeError(
        'conflict',
        'Saved organization requires its original employee directory',
      )
  }

  /**
   * Read formal structure without exposing inactive employee affiliations to ordinary members.
   * @param actor - Current authenticated active employee.
   * @param members - Complete retained directory for active-reference filtering.
   * @returns Authorized organization, or its explicit uninitialized state.
   */
  view(
    actor: OfficeMember,
    members: readonly OfficeMember[],
  ): OfficeOrganizationView {
    const state = this.domain.global.get()
    if (actor.role === 'admin')
      return {
        initialized: state.initialized,
        revision: state.revision,
        units: state.units,
        positions: state.positions,
        assignments: state.assignments,
      }
    const units = state.units.filter(entry =>
      this.assignableUnit(state, entry.id),
    )
    const ids = new Set(units.map(entry => entry.id))
    const positions = state.positions.filter(
      entry =>
        entry.active && (entry.unitId === null || ids.has(entry.unitId)),
    )
    const jobs = new Set(positions.map(entry => entry.id))
    const active = new Set(
      members.filter(member => member.active).map(member => member.id),
    )
    return {
      initialized: state.initialized,
      revision: state.revision,
      units,
      positions,
      assignments: state.assignments
        .filter(entry => active.has(entry.memberId))
        .map(entry => ({
          ...entry,
          unitId:
            entry.unitId !== null && ids.has(entry.unitId)
              ? entry.unitId
              : null,
          positionId:
            entry.positionId !== null && jobs.has(entry.positionId)
              ? entry.positionId
              : null,
        })),
    }
  }

  /**
   * Adopt reviewed contact labels once; later self-service contact edits cannot move formal affiliations.
   * @param actor - Administrator rechecked by the office queue.
   * @param members - Directory snapshot reviewed by the administrator.
   * @returns Committed organization or the existing initialized organization.
   */
  async initialize(
    actor: OfficeMember,
    members: readonly OfficeMember[],
  ): Promise<OfficeOrganizationView> {
    this.admin(actor)
    const current = this.domain.global.get()
    if (current.initialized) return this.view(actor, members)
    const units: OfficeOrganizationUnit[] = []
    const positions: OfficePosition[] = []
    const assignments: OfficeOrganizationAssignment[] = []
    for (const member of members) {
      let department: OfficeOrganizationUnit | undefined
      const departmentName = member.department.trim().normalize('NFC')
      if (departmentName) {
        department = units.find(
          entry => entry.name.toLowerCase() === departmentName.toLowerCase(),
        )
        if (!department) {
          department = {
            id: brandString<OfficeUnitId>(randomUUID()),
            parentId: null,
            name: departmentName,
            active: true,
            revision: 1,
          }
          units.push(department)
        }
      }
      let job: OfficePosition | undefined
      const positionName = member.jobTitle.trim().normalize('NFC')
      if (positionName) {
        job = positions.find(
          entry =>
            entry.unitId === (department?.id ?? null) &&
            entry.name.toLowerCase() === positionName.toLowerCase(),
        )
        if (!job) {
          job = {
            id: brandString<OfficePositionId>(randomUUID()),
            unitId: department?.id ?? null,
            name: positionName,
            active: true,
            revision: 1,
          }
          positions.push(job)
        }
      }
      assignments.push({
        memberId: member.id,
        unitId: department?.id ?? null,
        positionId: job?.id ?? null,
        revision: 1,
      })
    }
    await this.commit(
      current,
      { initialized: true, units, positions, assignments },
      actor,
      'initialized',
      'company',
    )
    return this.view(actor, members)
  }

  /**
   * Create or edit a department with a reviewed version and validated parent chain.
   * @param actor - Current administrator.
   * @param input - Department fields and reviewed identity/version.
   * @param members - Current directory for in-use checks.
   * @returns Committed department; stale, duplicate and cyclic writes change nothing.
   */
  async saveUnit(
    actor: OfficeMember,
    input: OfficeUnitInput,
    members: readonly OfficeMember[],
  ): Promise<OfficeOrganizationUnit> {
    this.admin(actor)
    const parsed = unitInput.safeParse(input)
    if (!parsed.success)
      throw new OfficeError('invalid_input', 'Department fields are invalid')
    const state = this.ready()
    const previous =
      parsed.data.id === null
        ? null
        : state.units.find(entry => entry.id === parsed.data.id)
    if (parsed.data.id !== null && !previous)
      throw new OfficeError('not_found', 'Department is unavailable')
    if (previous && previous.revision !== parsed.data.revision)
      throw new OfficeError('conflict', 'Department changed after review')
    if (
      parsed.data.parentId !== null &&
      parsed.data.active &&
      !this.assignableUnit(state, parsed.data.parentId)
    )
      throw new OfficeError(
        'invalid_input',
        'Choose an active parent department',
      )
    if (
      state.units.some(
        entry =>
          entry.id !== previous?.id &&
          entry.parentId === parsed.data.parentId &&
          entry.name.toLowerCase() === parsed.data.name.toLowerCase(),
      )
    )
      throw new OfficeError(
        'conflict',
        'A sibling department already has this name',
      )
    if (previous?.active && !parsed.data.active) {
      const active = new Set(
        members.filter(member => member.active).map(member => member.id),
      )
      if (
        state.units.some(
          entry => entry.parentId === previous.id && entry.active,
        ) ||
        state.positions.some(
          entry => entry.unitId === previous.id && entry.active,
        ) ||
        state.assignments.some(
          entry => entry.unitId === previous.id && active.has(entry.memberId),
        )
      )
        throw new OfficeError(
          'conflict',
          'Reassign active employees, positions and child departments before deactivation',
        )
    }
    const saved: OfficeOrganizationUnit = {
      ...parsed.data,
      id: previous?.id ?? brandString<OfficeUnitId>(randomUUID()),
      revision: this.next(previous?.revision ?? 0),
    }
    await this.commit(
      state,
      {
        units: previous
          ? state.units.map(entry => (entry.id === saved.id ? saved : entry))
          : [...state.units, saved],
      },
      actor,
      'unit_saved',
      saved.id,
    )
    return saved
  }

  /**
   * Create or edit an administrator-managed position without granting an authorization role.
   * @param actor - Current administrator.
   * @param input - Global/department position fields and reviewed version.
   * @param members - Retained directory for active affiliation checks.
   * @returns Committed position; in-use deactivation or incompatible moves are rejected.
   */
  async savePosition(
    actor: OfficeMember,
    input: OfficePositionInput,
    members: readonly OfficeMember[],
  ): Promise<OfficePosition> {
    this.admin(actor)
    const parsed = positionInput.safeParse(input)
    if (!parsed.success)
      throw new OfficeError('invalid_input', 'Position fields are invalid')
    const state = this.ready()
    const previous =
      parsed.data.id === null
        ? null
        : state.positions.find(entry => entry.id === parsed.data.id)
    if (parsed.data.id !== null && !previous)
      throw new OfficeError('not_found', 'Position is unavailable')
    if (previous && previous.revision !== parsed.data.revision)
      throw new OfficeError('conflict', 'Position changed after review')
    if (
      parsed.data.unitId !== null &&
      parsed.data.active &&
      !this.assignableUnit(state, parsed.data.unitId)
    )
      throw new OfficeError(
        'invalid_input',
        'Choose an active position department',
      )
    if (
      state.positions.some(
        entry =>
          entry.id !== previous?.id &&
          entry.unitId === parsed.data.unitId &&
          entry.name.toLowerCase() === parsed.data.name.toLowerCase(),
      )
    )
      throw new OfficeError(
        'conflict',
        'This department already has a position with this name',
      )
    if (previous) {
      const active = new Set(
        members.filter(member => member.active).map(member => member.id),
      )
      if (
        state.assignments.some(
          entry =>
            entry.positionId === previous.id &&
            active.has(entry.memberId) &&
            ((previous.active && !parsed.data.active) ||
              (parsed.data.active && parsed.data.unitId !== null &&
                parsed.data.unitId !== entry.unitId)),
        )
      )
        throw new OfficeError(
          'conflict',
          'Reassign active employees before deactivating or moving their position',
        )
    }
    const saved: OfficePosition = {
      ...parsed.data,
      id: previous?.id ?? brandString<OfficePositionId>(randomUUID()),
      revision: this.next(previous?.revision ?? 0),
    }
    await this.commit(
      state,
      {
        positions: previous
          ? state.positions.map(entry =>
            entry.id === saved.id ? saved : entry,
          )
          : [...state.positions, saved],
      },
      actor,
      'position_saved',
      saved.id,
    )
    return saved
  }

  /**
   * Set formal affiliation through an administrator, independently of editable profile labels.
   * @param actor - Current administrator.
   * @param input - Employee, target entities and observed assignment version.
   * @param members - Retained directory; inactive employees may only be unassigned.
   * @returns Committed assignment, retaining null-value version tombstones.
   */
  async assign(
    actor: OfficeMember,
    input: OfficeAssignmentInput,
    members: readonly OfficeMember[],
  ): Promise<OfficeOrganizationAssignment> {
    this.admin(actor)
    const parsed = assignmentInput.safeParse(input)
    if (!parsed.success)
      throw new OfficeError(
        'invalid_input',
        'Organization assignment is invalid',
      )
    const state = this.ready()
    const member = members.find(entry => entry.id === parsed.data.memberId)
    if (!member) throw new OfficeError('not_found', 'Employee is unavailable')
    if (
      !member.active &&
      (parsed.data.unitId !== null || parsed.data.positionId !== null)
    )
      throw new OfficeError(
        'invalid_input',
        'Inactive employees can only be unassigned',
      )
    const previous = state.assignments.find(
      entry => entry.memberId === member.id,
    )
    if ((previous?.revision ?? 0) !== parsed.data.revision)
      throw new OfficeError(
        'conflict',
        'Employee affiliation changed after review',
      )
    if (
      parsed.data.unitId !== null &&
      !this.assignableUnit(state, parsed.data.unitId)
    )
      throw new OfficeError('invalid_input', 'Choose an active department')
    if (parsed.data.positionId !== null) {
      const position = state.positions.find(
        entry => entry.id === parsed.data.positionId && entry.active,
      )
      if (
        !position ||
        (position.unitId !== null && position.unitId !== parsed.data.unitId)
      )
        throw new OfficeError(
          'invalid_input',
          'Choose an active position belonging to this department',
        )
    }
    const saved: OfficeOrganizationAssignment = {
      ...parsed.data,
      revision: this.next(previous?.revision ?? 0),
    }
    await this.commit(
      state,
      {
        assignments: previous
          ? state.assignments.map(entry =>
            entry.memberId === saved.memberId ? saved : entry,
          )
          : [...state.assignments, saved],
      },
      actor,
      'assignment_saved',
      saved.memberId,
    )
    return saved
  }

  private admin(actor: OfficeMember): void {
    if (!actor.active || actor.role !== 'admin')
      throw new OfficeError(
        'forbidden',
        'Only an administrator may manage formal organization',
      )
  }
  private ready(): OrganizationState {
    const state = this.domain.global.get()
    if (!state.initialized)
      throw new OfficeError(
        'invalid_input',
        'Initialize formal organization before editing it',
      )
    return state
  }
  private next(value: number): number {
    if (value === Number.MAX_SAFE_INTEGER)
      throw new OfficeError('conflict', 'Organization revision limit reached')
    return value + 1
  }
  private assignableUnit(state: OrganizationState, id: OfficeUnitId): boolean {
    let current: OfficeUnitId | null = id
    const seen = new Set<OfficeUnitId>()
    while (current !== null) {
      const unit = state.units.find(entry => entry.id === current)
      if (!unit?.active || seen.has(current) || seen.size >= 64) return false
      seen.add(current)
      current = unit.parentId
    }
    return true
  }
  private async commit(
    current: OrganizationState,
    changes: Partial<
      Pick<
        OrganizationState,
        'initialized' | 'units' | 'positions' | 'assignments'
      >
    >,
    actor: OfficeMember,
    action: OrganizationState['audit'][number]['action'],
    targetId: string,
  ): Promise<void> {
    const revision = this.next(current.revision)
    const next = {
      ...current,
      ...changes,
      revision,
      audit: [
        ...current.audit,
        { revision, actorId: actor.id, action, targetId, time: Date.now() },
      ].slice(-1000),
    }
    const parsed = state.safeParse(next)
    if (!parsed.success)
      throw new OfficeError(
        'invalid_input',
        'Formal organization hierarchy or capacity is invalid',
      )
    await this.domain.global.set(parsed.data)
    await this.changed()
  }
}
