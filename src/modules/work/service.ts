import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { assertCsoDomainOwner, isCsoDomainOwner } from '../../shared/domain-owners';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';
import { portalUrl } from '../notifications/mail';
import { listStaffByRole, loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { formatIsoDate } from '../leave/day-count';
import { loadWorkingDays } from '../leave/support';
import { weekBounds, nextWeekStart } from './week-bounds';
import { ensureWeeklyPlan } from './plans';
import { canViewOthersWork } from './access';
import {
  canEditPriorityContent,
  canEditPriorityExecution,
  MIN_WORK_GOAL_MESSAGE,
  skipsWorkApprovalLoop,
  weekAllowsSkillSubmit,
  weekHasWorkGoal,
  type PriorityApprovalStatus,
} from './approval';

const SOFT_CAP = 5;
const TYPES = ['PROJECT', 'REGULAR', 'SKILL'] as const;
const REGULAR_SUBTYPES = [
  'TESTING',
  'PRODUCTION',
  'GENERAL_MANAGEMENT',
  'INVENTORY',
  'OTHER',
] as const;
const LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'BLOCKED',
  'CANCELLED',
  'CARRIED_FORWARD',
] as const;
const FEEDBACK_TYPES = ['POSITIVE', 'IMPROVEMENT', 'SUPPORT'] as const;
const INCOMPLETE_REASONS = [
  'DEPENDENCY',
  'APPROVAL',
  'TECHNICAL',
  'PRIORITY_CHANGE',
  'TIME',
  'URGENT_ASSIGNMENT',
  'OTHER',
] as const;

export type PriorityType = (typeof TYPES)[number];
export type RegularSubtype = (typeof REGULAR_SUBTYPES)[number];
export type PriorityLevel = (typeof LEVELS)[number];
export type PriorityStatus = (typeof STATUSES)[number];
export type IncompleteReason = (typeof INCOMPLETE_REASONS)[number];

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

type PriorityRow = {
  id: string;
  plan_id: string;
  employee_id: string;
  priority_type: string;
  project_id: string | null;
  regular_subtype: string | null;
  regular_subtype_label: string | null;
  title: string;
  description: string;
  expected_outcome: string;
  success_criteria: string;
  priority_level: string;
  status: string;
  incomplete_reason: string | null;
  assigned_by: string | null;
  carried_from_id: string | null;
  approval_status: string;
  cso_comment: string;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  resubmit_requested_at: string | null;
  created_at: string;
  updated_at: string;
  projects?: { name: string; code: string } | { name: string; code: string }[] | null;
};

function asType<T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if (!allowed.includes(value as T[number])) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, `Choose a valid ${label}.`, 400);
  }
  return value as T[number];
}

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function canViewOthers(actor: RequestUser): boolean {
  return canViewOthersWork(actor);
}

function canAssign(actor: RequestUser): boolean {
  return isCsoDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.WORK_ASSIGN);
}

function canManageProjects(actor: RequestUser): boolean {
  return isCsoDomainOwner(actor) && actor.permissions.includes(PERMISSIONS.PROJECTS_MANAGE);
}

/** Resolve project / regular-subtype rules for create + content update. */
function resolveTypeFields(input: {
  type: PriorityType;
  projectId?: string | null;
  regularSubtype?: string | null;
  regularSubtypeLabel?: string | null;
}): {
  projectId: string | null;
  regularSubtype: string | null;
  regularSubtypeLabel: string | null;
} {
  if (input.type === 'PROJECT') {
    const projectId = input.projectId ?? null;
    if (!projectId) {
      throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Pick a project for this R&D priority.', 400);
    }
    return { projectId, regularSubtype: null, regularSubtypeLabel: null };
  }
  if (input.type === 'REGULAR') {
    const regularSubtype = asType(
      String(input.regularSubtype ?? ''),
      REGULAR_SUBTYPES,
      'regular work type',
    );
    const label = (input.regularSubtypeLabel ?? '').trim();
    if (regularSubtype === 'OTHER' && !label) {
      throw new AppError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Describe the regular work type when you choose Other.',
        400,
      );
    }
    return {
      projectId: null,
      regularSubtype,
      regularSubtypeLabel: label || null,
    };
  }
  return { projectId: null, regularSubtype: null, regularSubtypeLabel: null };
}

function mapPriority(row: PriorityRow) {
  const project = firstRel(row.projects);
  return {
    id: row.id,
    planId: row.plan_id,
    employeeId: row.employee_id,
    type: row.priority_type as PriorityType,
    projectId: row.project_id,
    projectName: project?.name ?? null,
    projectCode: project?.code ?? null,
    regularSubtype: (row.regular_subtype as RegularSubtype | null) ?? null,
    regularSubtypeLabel: row.regular_subtype_label ?? null,
    title: row.title,
    description: row.description,
    expectedOutcome: row.expected_outcome,
    successCriteria: row.success_criteria,
    level: row.priority_level as PriorityLevel,
    status: row.status as PriorityStatus,
    incompleteReason: row.incomplete_reason as IncompleteReason | null,
    assignedBy: row.assigned_by,
    carriedFromId: row.carried_from_id,
    approvalStatus: (row.approval_status ?? 'DRAFT') as PriorityApprovalStatus,
    csoComment: row.cso_comment ?? '',
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    resubmitRequestedAt: row.resubmit_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function writeHistory(
  supabase: SupabaseClient,
  input: {
    priorityId: string;
    actorId: string;
    action: string;
    oldValues?: Record<string, unknown> | null;
    newValues?: Record<string, unknown> | null;
  },
): Promise<void> {
  await supabase.from('priority_history').insert({
    priority_id: input.priorityId,
    actor_id: input.actorId,
    action: input.action,
    old_values: input.oldValues ?? null,
    new_values: input.newValues ?? null,
  });
}

export function createWorkService(supabase: SupabaseClient) {
  async function ensurePlan(employeeId: string, start: string, end: string): Promise<string> {
    return ensureWeeklyPlan(supabase, employeeId, start, end);
  }

  async function loadPriorities(planId: string) {
    const { data, error } = await supabase
      .from('weekly_priorities')
      .select('*, projects ( name, code )')
      .eq('plan_id', planId)
      .order('created_at');
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load priorities.', 500);
    return ((data ?? []) as PriorityRow[]).map(mapPriority);
  }

  async function assertProjectAccess(employeeId: string, projectId: string, actor: RequestUser): Promise<void> {
    if (canManageProjects(actor) || canAssign(actor)) {
      const { data } = await supabase.from('projects').select('id, status').eq('id', projectId).maybeSingle();
      if (!data || data.status !== 'active') {
        throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Project not found.', 404);
      }
      await supabase.from('project_members').upsert(
        { project_id: projectId, employee_id: employeeId },
        { onConflict: 'project_id,employee_id' },
      );
      return;
    }
    const { data } = await supabase
      .from('project_members')
      .select('project_id')
      .eq('project_id', projectId)
      .eq('employee_id', employeeId)
      .maybeSingle();
    if (!data) {
      throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You can only pick a project assigned to you.', 403);
    }
  }

  async function loadPriority(id: string): Promise<PriorityRow> {
    const { data, error } = await supabase
      .from('weekly_priorities')
      .select('*, projects ( name, code )')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Priority not found.', 404);
    return data as PriorityRow;
  }

  function assertCanEdit(actor: RequestUser, employeeId: string): void {
    if (actor.employeeId === employeeId) return;
    throw new AppError(
      API_ERROR_CODES.FORBIDDEN,
      'Employees own their weekly priorities. You can view this week but not change it.',
      403,
    );
  }

  async function listAllProjects() {
    const { data, error } = await supabase.from('projects').select('id, name, code, status').eq('status', 'active').order('name');
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load projects.', 500);
    return data ?? [];
  }

  async function loadProjectMemberMap(projectIds: string[]) {
    const map = new Map<string, { employeeId: string; fullName: string }[]>();
    if (projectIds.length === 0) return map;
    const { data: memberRows, error } = await supabase
      .from('project_members')
      .select('project_id, employee_id')
      .in('project_id', projectIds);
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project members.', 500);
    const employeeIds = [...new Set((memberRows ?? []).map((row) => row.employee_id as string))];
    const { data: employees } = employeeIds.length
      ? await supabase.from('employees').select('id, full_name').in('id', employeeIds)
      : { data: [] };
    const nameById = new Map((employees ?? []).map((row) => [row.id as string, row.full_name as string]));
    for (const row of memberRows ?? []) {
      const projectId = row.project_id as string;
      const employeeId = row.employee_id as string;
      const list = map.get(projectId) ?? [];
      list.push({ employeeId, fullName: nameById.get(employeeId) ?? 'Employee' });
      map.set(projectId, list);
    }
    for (const [, list] of map) {
      list.sort((a, b) => a.fullName.localeCompare(b.fullName));
    }
    return map;
  }

  async function listAllProjectsWithMembers() {
    const projects = await listAllProjects();
    const membersByProject = await loadProjectMemberMap(projects.map((row) => row.id as string));
    return projects.map((row) => {
      const members = membersByProject.get(row.id as string) ?? [];
      return {
        id: row.id as string,
        name: row.name as string,
        code: row.code as string,
        status: row.status as string,
        memberCount: members.length,
        members,
      };
    });
  }

  async function assertActiveProject(projectId: string): Promise<void> {
    const { data } = await supabase.from('projects').select('id, status').eq('id', projectId).maybeSingle();
    if (!data || data.status !== 'active') {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Project not found.', 404);
    }
  }

  async function assertActiveEmployee(employeeId: string): Promise<void> {
    const { data } = await supabase
      .from('employees')
      .select('id, status, deleted_at')
      .eq('id', employeeId)
      .maybeSingle();
    if (!data || data.status !== 'active' || data.deleted_at) {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
    }
  }

  async function listMemberProjects(memberId: string) {
    const { data, error } = await supabase
      .from('project_members')
      .select('projects ( id, name, code, status )')
      .eq('employee_id', memberId);
    if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load projects.', 500);
    const rows: { id: string; name: string; code: string; status: string }[] = [];
    for (const row of data ?? []) {
      const project = firstRel(
        (row as { projects?: { id: string; name: string; code: string; status: string } | { id: string; name: string; code: string; status: string }[] })
          .projects,
      );
      if (project && project.status === 'active') rows.push(project);
    }
    return rows;
  }

  return {
    async getWeek(actor: RequestUser, input: { employeeId?: string; date?: string }) {
      const employeeId = input.employeeId ?? actor.employeeId;
      if (employeeId !== actor.employeeId && !canViewOthers(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view another person’s week.', 403);
      }
      const isoDate = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : formatIsoDate(new Date());
      const workingDays = await loadWorkingDays(supabase);
      const week = weekBounds(isoDate, workingDays);
      const planId = await ensurePlan(employeeId, week.start, week.end);
      const priorities = await loadPriorities(planId);
      const projects = canManageProjects(actor) || canAssign(actor)
        ? await listAllProjects()
        : await listMemberProjects(employeeId);
      const { data: feedbackRows } = await supabase
        .from('week_feedback')
        .select('id, feedback_type, comment, actor_id, created_at')
        .eq('plan_id', planId)
        .order('created_at', { ascending: false });
      const actorIds = [...new Set((feedbackRows ?? []).map((row) => row.actor_id as string).filter(Boolean))];
      const { data: actors } = actorIds.length
        ? await supabase.from('employees').select('id, full_name').in('id', actorIds)
        : { data: [] };
      const actorName = new Map((actors ?? []).map((row) => [row.id as string, row.full_name as string]));
      const feedback = (feedbackRows ?? []).map((row) => ({
        id: row.id as string,
        type: row.feedback_type as string,
        comment: row.comment as string,
        actorId: row.actor_id as string,
        actorName: actorName.get(row.actor_id as string) ?? 'Colleague',
        createdAt: row.created_at as string,
      }));
      return {
        week: {
          planId,
          start: week.start,
          end: week.end,
          label: `${week.start} – ${week.end}`,
          isLastWorkingDay: isoDate === week.end,
        },
        priorities,
        projects,
        feedback,
        softCap: SOFT_CAP,
        overCap: priorities.length > SOFT_CAP,
      };
    },

    async listProjects(actor: RequestUser, employeeId?: string) {
      if (canManageProjects(actor) || canAssign(actor)) {
        return listAllProjectsWithMembers();
      }
      const memberId = employeeId ?? actor.employeeId;
      if (memberId !== actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot list another person’s projects.', 403);
      }
      return listMemberProjects(memberId);
    },

    async getProjectMembers(actor: RequestUser, projectId: string) {
      if (!canManageProjects(actor) && !canAssign(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view project members.', 403);
      }
      await assertActiveProject(projectId);
      const membersByProject = await loadProjectMemberMap([projectId]);
      return { projectId, members: membersByProject.get(projectId) ?? [] };
    },

    async setProjectMembers(
      actor: RequestUser,
      projectId: string,
      employeeIds: string[],
      meta: RequestMeta,
    ) {
      if (!canManageProjects(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage projects.', 403);
      }
      await assertActiveProject(projectId);
      const uniqueIds = [...new Set(employeeIds.filter(Boolean))];
      for (const employeeId of uniqueIds) {
        await assertActiveEmployee(employeeId);
      }

      const { data: existingRows, error: existingError } = await supabase
        .from('project_members')
        .select('employee_id')
        .eq('project_id', projectId);
      if (existingError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load current members.', 500);
      }
      const existing = new Set((existingRows ?? []).map((row) => row.employee_id as string));
      const next = new Set(uniqueIds);
      const toRemove = [...existing].filter((id) => !next.has(id));
      const toAdd = uniqueIds.filter((id) => !existing.has(id));

      if (toRemove.length) {
        const { error } = await supabase
          .from('project_members')
          .delete()
          .eq('project_id', projectId)
          .in('employee_id', toRemove);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to remove project members.', 500);
      }
      if (toAdd.length) {
        const { error } = await supabase.from('project_members').upsert(
          toAdd.map((employee_id) => ({ project_id: projectId, employee_id })),
          { onConflict: 'project_id,employee_id' },
        );
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to assign project members.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project.members_set',
        entityType: 'project',
        entityId: projectId,
        newValues: { employeeIds: uniqueIds, added: toAdd, removed: toRemove },
        ...meta,
      });

      const membersByProject = await loadProjectMemberMap([projectId]);
      const members = membersByProject.get(projectId) ?? [];
      return { projectId, memberCount: members.length, members };
    },

    async listEmployeeProjects(actor: RequestUser, employeeId: string) {
      if (!canManageProjects(actor) && !canAssign(actor) && actor.employeeId !== employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view these project assignments.', 403);
      }
      if (actor.employeeId !== employeeId) {
        await assertActiveEmployee(employeeId);
      }
      const projects = await listMemberProjects(employeeId);
      return {
        employeeId,
        projects: projects.map((row) => ({
          id: row.id,
          name: row.name,
          code: row.code,
          status: row.status,
        })),
      };
    },

    async setEmployeeProjects(
      actor: RequestUser,
      employeeId: string,
      projectIds: string[],
      meta: RequestMeta,
    ) {
      if (!canManageProjects(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage projects.', 403);
      }
      await assertActiveEmployee(employeeId);
      const uniqueIds = [...new Set(projectIds.filter(Boolean))];
      for (const projectId of uniqueIds) {
        await assertActiveProject(projectId);
      }

      const current = await listMemberProjects(employeeId);
      const existing = new Set(current.map((row) => row.id));
      const next = new Set(uniqueIds);
      const toRemove = [...existing].filter((id) => !next.has(id));
      const toAdd = uniqueIds.filter((id) => !existing.has(id));

      if (toRemove.length) {
        const { error } = await supabase
          .from('project_members')
          .delete()
          .eq('employee_id', employeeId)
          .in('project_id', toRemove);
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to remove project assignments.', 500);
      }
      if (toAdd.length) {
        const { error } = await supabase.from('project_members').upsert(
          toAdd.map((project_id) => ({ project_id, employee_id: employeeId })),
          { onConflict: 'project_id,employee_id' },
        );
        if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to assign projects.', 500);
      }

      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'employee.projects_set',
        entityType: 'employee',
        entityId: employeeId,
        newValues: { projectIds: uniqueIds, added: toAdd, removed: toRemove },
        ...meta,
      });

      const projects = await listMemberProjects(employeeId);
      return {
        employeeId,
        projects: projects.map((row) => ({
          id: row.id,
          name: row.name,
          code: row.code,
          status: row.status,
        })),
      };
    },

    async createProject(
      actor: RequestUser,
      input: { name: string; code: string; employeeIds?: string[] },
      meta: RequestMeta,
    ) {
      if (!canManageProjects(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage projects.', 403);
      }
      const name = input.name.trim();
      const code = input.code.trim().toUpperCase();
      if (!name || !code) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a project name and code.', 400);
      const { data, error } = await supabase.from('projects').insert({ name, code }).select('*').single();
      if (error || !data) {
        if (error?.code === '23505') throw new AppError(API_ERROR_CODES.CONFLICT, 'A project with this code already exists.', 409);
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create the project.', 500);
      }
      const members = [...new Set([actor.employeeId, ...(input.employeeIds ?? [])])];
      if (members.length) {
        await supabase
          .from('project_members')
          .upsert(
            members.map((employee_id) => ({ project_id: data.id, employee_id })),
            { onConflict: 'project_id,employee_id' },
          );
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project.create',
        entityType: 'project',
        entityId: data.id as string,
        newValues: { name, code, memberIds: members },
        ...meta,
      });
      const membersByProject = await loadProjectMemberMap([data.id as string]);
      const memberList = membersByProject.get(data.id as string) ?? [];
      return {
        id: data.id as string,
        name: data.name as string,
        code: data.code as string,
        status: data.status as string,
        memberCount: memberList.length,
        members: memberList,
      };
    },

    async addProjectMember(actor: RequestUser, projectId: string, employeeId: string, meta: RequestMeta) {
      if (!canManageProjects(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot manage projects.', 403);
      }
      const { error } = await supabase
        .from('project_members')
        .upsert({ project_id: projectId, employee_id: employeeId }, { onConflict: 'project_id,employee_id' });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to assign this person to the project.', 500);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project.member_add',
        entityType: 'project',
        entityId: projectId,
        newValues: { employeeId },
        ...meta,
      });
      return { projectId, employeeId };
    },

    async createPriority(
      actor: RequestUser,
      input: {
        employeeId?: string;
        type: string;
        projectId?: string | null;
        regularSubtype?: string | null;
        regularSubtypeLabel?: string | null;
        title: string;
        description?: string;
        expectedOutcome?: string;
        successCriteria?: string;
        level: string;
      },
      meta: RequestMeta,
    ) {
      const employeeId = input.employeeId ?? actor.employeeId;
      if (employeeId !== actor.employeeId) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'Employees set their own weekly priorities. You can view them, not assign them.',
          403,
        );
      }
      if (!actor.permissions.includes(PERMISSIONS.WORK_OWN)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot set weekly priorities.', 403);
      }
      if (skipsWorkApprovalLoop(actor.roles)) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'Your role does not use the weekly priority and daily update loop.',
          403,
        );
      }
      const type = asType(input.type, TYPES, 'priority type');
      const level = asType(input.level, LEVELS, 'priority level');
      const title = input.title.trim();
      if (!title) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a short priority title.', 400);
      const fields = resolveTypeFields({
        type,
        projectId: input.projectId,
        regularSubtype: input.regularSubtype,
        regularSubtypeLabel: input.regularSubtypeLabel,
      });
      if (type === 'PROJECT' && fields.projectId) {
        await assertProjectAccess(employeeId, fields.projectId, actor);
      }

      const workingDays = await loadWorkingDays(supabase);
      const week = weekBounds(formatIsoDate(new Date()), workingDays);
      const planId = await ensurePlan(employeeId, week.start, week.end);
      const existing = await loadPriorities(planId);

      const { data, error } = await supabase
        .from('weekly_priorities')
        .insert({
          plan_id: planId,
          employee_id: employeeId,
          priority_type: type,
          project_id: fields.projectId,
          regular_subtype: fields.regularSubtype,
          regular_subtype_label: fields.regularSubtypeLabel,
          title,
          description: input.description?.trim() ?? '',
          expected_outcome: input.expectedOutcome?.trim() ?? '',
          success_criteria: input.successCriteria?.trim() ?? '',
          priority_level: level,
          assigned_by: null,
          approval_status: 'DRAFT',
        })
        .select('*, projects ( name, code )')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save this priority.', 500);
      const mapped = mapPriority(data as PriorityRow);
      await writeHistory(supabase, {
        priorityId: mapped.id,
        actorId: actor.employeeId,
        action: 'created',
        newValues: mapped,
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'weekly_priority.create',
        entityType: 'weekly_priority',
        entityId: mapped.id,
        newValues: mapped,
        ...meta,
      });
      const count = existing.length + 1;
      return {
        priority: mapped,
        overCap: count > SOFT_CAP,
        warning:
          count > SOFT_CAP
            ? `You now have ${count} priorities. Try to keep 3–5 so this stays a plan, not a task dump.`
            : count === SOFT_CAP
              ? 'That is 5 priorities — a good weekly maximum.'
              : null,
      };
    },

    async updatePriority(
      actor: RequestUser,
      id: string,
      input: {
        title?: string;
        description?: string;
        expectedOutcome?: string;
        successCriteria?: string;
        level?: string;
        regularSubtype?: string | null;
        regularSubtypeLabel?: string | null;
        status?: string;
        incompleteReason?: string | null;
      },
      meta: RequestMeta,
    ) {
      const existing = await loadPriority(id);
      assertCanEdit(actor, existing.employee_id);
      if (existing.status === 'CARRIED_FORWARD') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This priority was carried forward. Update it on next week’s plan.', 409);
      }
      const approval = (existing.approval_status ?? 'DRAFT') as string;
      const contentTouch =
        input.title !== undefined ||
        input.description !== undefined ||
        input.expectedOutcome !== undefined ||
        input.successCriteria !== undefined ||
        input.level !== undefined ||
        input.regularSubtype !== undefined ||
        input.regularSubtypeLabel !== undefined;
      if (contentTouch && !canEditPriorityContent(approval)) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          approval === 'SUBMITTED'
            ? 'This priority is waiting for CSO review. You can edit it only if CSO asks for a resubmit.'
            : 'Approved priorities stay fixed. Ask CSO to request a resubmit if something must change.',
          409,
        );
      }
      if (input.status !== undefined && !canEditPriorityExecution(approval)) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          'Update progress only after CSO has approved this priority.',
          409,
        );
      }
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a short priority title.', 400);
        patch.title = title;
      }
      if (input.description !== undefined) patch.description = input.description.trim();
      if (input.expectedOutcome !== undefined) patch.expected_outcome = input.expectedOutcome.trim();
      if (input.successCriteria !== undefined) patch.success_criteria = input.successCriteria.trim();
      if (input.level !== undefined) patch.priority_level = asType(input.level, LEVELS, 'priority level');
      if (input.regularSubtype !== undefined || input.regularSubtypeLabel !== undefined) {
        const fields = resolveTypeFields({
          type: existing.priority_type as PriorityType,
          projectId: existing.project_id,
          regularSubtype:
            input.regularSubtype !== undefined ? input.regularSubtype : existing.regular_subtype,
          regularSubtypeLabel:
            input.regularSubtypeLabel !== undefined
              ? input.regularSubtypeLabel
              : existing.regular_subtype_label,
        });
        if (existing.priority_type === 'REGULAR') {
          patch.regular_subtype = fields.regularSubtype;
          patch.regular_subtype_label = fields.regularSubtypeLabel;
          patch.project_id = null;
        }
      }
      if (input.status !== undefined) {
        const status = asType(input.status, STATUSES, 'status');
        if (status === 'CARRIED_FORWARD') {
          return this.carryForward(actor, id, input.incompleteReason ?? null, meta);
        }
        patch.status = status;
        if (input.incompleteReason !== undefined) {
          patch.incomplete_reason = input.incompleteReason
            ? asType(input.incompleteReason, INCOMPLETE_REASONS, 'reason')
            : null;
        }
      } else if (input.incompleteReason !== undefined) {
        patch.incomplete_reason = input.incompleteReason
          ? asType(input.incompleteReason, INCOMPLETE_REASONS, 'reason')
          : null;
      }
      if (Object.keys(patch).length === 0) {
        return mapPriority(existing);
      }
      const { data, error } = await supabase
        .from('weekly_priorities')
        .update(patch)
        .eq('id', id)
        .select('*, projects ( name, code )')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update this priority.', 500);
      const mapped = mapPriority(data as PriorityRow);
      await writeHistory(supabase, {
        priorityId: id,
        actorId: actor.employeeId,
        action: input.status ? 'status' : 'updated',
        oldValues: mapPriority(existing),
        newValues: mapped,
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'weekly_priority.update',
        entityType: 'weekly_priority',
        entityId: id,
        oldValues: mapPriority(existing),
        newValues: mapped,
        ...meta,
      });
      return mapped;
    },

    async carryForward(actor: RequestUser, id: string, incompleteReason: string | null, meta: RequestMeta) {
      const existing = await loadPriority(id);
      assertCanEdit(actor, existing.employee_id);
      if (!canEditPriorityExecution(existing.approval_status ?? 'DRAFT')) {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          'Carry forward only after CSO has approved this priority.',
          409,
        );
      }
      if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Completed or cancelled work is not carried forward.', 400);
      }
      if (existing.status === 'CARRIED_FORWARD') {
        throw new AppError(API_ERROR_CODES.CONFLICT, 'This priority is already carried forward.', 409);
      }
      const { data: plan } = await supabase.from('weekly_plans').select('week_end').eq('id', existing.plan_id).maybeSingle();
      if (!plan) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Weekly plan not found.', 404);
      const workingDays = await loadWorkingDays(supabase);
      const next = weekBounds(nextWeekStart(plan.week_end as string, workingDays), workingDays);
      const nextPlanId = await ensurePlan(existing.employee_id, next.start, next.end);
      const { data: already } = await supabase
        .from('weekly_priorities')
        .select('id')
        .eq('plan_id', nextPlanId)
        .eq('carried_from_id', id)
        .maybeSingle();
      if (already) throw new AppError(API_ERROR_CODES.CONFLICT, 'This priority is already on next week’s plan.', 409);

      const reason = incompleteReason ? asType(incompleteReason, INCOMPLETE_REASONS, 'reason') : existing.incomplete_reason;
      const { data: updated, error: updateError } = await supabase
        .from('weekly_priorities')
        .update({ status: 'CARRIED_FORWARD', incomplete_reason: reason })
        .eq('id', id)
        .select('*, projects ( name, code )')
        .single();
      if (updateError || !updated) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to mark this as carried forward.', 500);

      const { data: created, error: createError } = await supabase
        .from('weekly_priorities')
        .insert({
          plan_id: nextPlanId,
          employee_id: existing.employee_id,
          priority_type: existing.priority_type,
          project_id: existing.project_id,
          regular_subtype: existing.regular_subtype,
          regular_subtype_label: existing.regular_subtype_label,
          title: existing.title,
          description: existing.description,
          expected_outcome: existing.expected_outcome,
          success_criteria: existing.success_criteria,
          priority_level: existing.priority_level,
          assigned_by: existing.assigned_by,
          carried_from_id: id,
          approval_status: 'DRAFT',
        })
        .select('*, projects ( name, code )')
        .single();
      if (createError || !created) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to copy this priority to next week.', 500);

      const original = mapPriority(updated as PriorityRow);
      const nextRow = mapPriority(created as PriorityRow);
      await writeHistory(supabase, {
        priorityId: id,
        actorId: actor.employeeId,
        action: 'carried_forward',
        oldValues: mapPriority(existing),
        newValues: { original, next: nextRow },
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'weekly_priority.carry_forward',
        entityType: 'weekly_priority',
        entityId: id,
        newValues: { originalId: id, nextId: nextRow.id, nextWeek: next },
        ...meta,
      });
      return { original, next: nextRow, nextWeek: next };
    },

    async submitPriorityForApproval(
      actor: RequestUser,
      id: string,
      meta: RequestMeta,
      options?: { notify?: boolean },
    ) {
      const existing = await loadPriority(id);
      assertCanEdit(actor, existing.employee_id);
      if (!actor.permissions.includes(PERMISSIONS.WORK_OWN)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot submit priorities for approval.', 403);
      }
      if (skipsWorkApprovalLoop(actor.roles)) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          'Your role does not use the weekly priority and daily update loop.',
          403,
        );
      }
      if (existing.status === 'CANCELLED' || existing.status === 'CARRIED_FORWARD') {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'This priority cannot be submitted.', 400);
      }
      const approval = existing.approval_status ?? 'DRAFT';
      if (approval !== 'DRAFT' && approval !== 'RESUBMIT_REQUESTED') {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          approval === 'SUBMITTED'
            ? 'This priority is already waiting for CSO review.'
            : 'This priority is already approved.',
          409,
        );
      }
      const wasResubmit = approval === 'RESUBMIT_REQUESTED';
      if (existing.priority_type === 'SKILL') {
        const week = await this.getWeek(actor, { employeeId: existing.employee_id });
        if (!weekAllowsSkillSubmit(week.priorities)) {
          throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, MIN_WORK_GOAL_MESSAGE, 400);
        }
      }
      const { data, error } = await supabase
        .from('weekly_priorities')
        .update({
          approval_status: 'SUBMITTED',
          submitted_at: new Date().toISOString(),
          resubmit_requested_at: null,
        })
        .eq('id', id)
        .select('*, projects ( name, code )')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to submit this priority.', 500);
      const mapped = mapPriority(data as PriorityRow);
      await writeHistory(supabase, {
        priorityId: id,
        actorId: actor.employeeId,
        action: wasResubmit ? 'resubmitted' : 'submitted',
        oldValues: mapPriority(existing),
        newValues: mapped,
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: wasResubmit ? 'weekly_priority.resubmit' : 'weekly_priority.submit',
        entityType: 'weekly_priority',
        entityId: id,
        oldValues: mapPriority(existing),
        newValues: mapped,
        ...meta,
      });

      if (options?.notify === false) {
        return mapped;
      }

      const employee = await loadStaffById(supabase, existing.employee_id);
      const csoStaff = await listStaffByRole(supabase, ROLE_CODES.CSO);
      const reviewHref = portalUrl(
        `/cso/work/priorities?employeeId=${encodeURIComponent(existing.employee_id)}`,
      );
      if (wasResubmit) {
        await notifyStaff(supabase, csoStaff, {
          type: 'work',
          title: 'Priority resubmitted for approval',
          message: `${employee?.fullName ?? 'An employee'} resubmitted “${mapped.title}” after your comment.`,
          referenceType: 'weekly_priority',
          referenceId: existing.employee_id,
          eyebrow: 'Work',
          paragraphs: [
            `${employee?.fullName ?? 'An employee'} updated and resubmitted a weekly priority for your review.`,
            mapped.csoComment ? `Your previous comment: ${mapped.csoComment}` : 'Please approve or ask for another change.',
          ],
          details: [
            { label: 'Employee', value: employee?.fullName ?? existing.employee_id },
            { label: 'Priority', value: mapped.title },
          ],
          ctaLabel: 'Review priorities',
          ctaHref: reviewHref,
        });
      } else {
        await notifyStaff(supabase, csoStaff, {
          type: 'work',
          title: 'Priority submitted for approval',
          message: `${employee?.fullName ?? 'An employee'} submitted “${mapped.title}” for CSO approval.`,
          referenceType: 'weekly_priority',
          referenceId: existing.employee_id,
          eyebrow: 'Work',
          paragraphs: [
            `${employee?.fullName ?? 'An employee'} submitted a weekly priority. Review each line and approve or ask for a resubmit.`,
          ],
          details: [
            { label: 'Employee', value: employee?.fullName ?? existing.employee_id },
            { label: 'Priority', value: mapped.title },
          ],
          ctaLabel: 'Review priorities',
          ctaHref: reviewHref,
        });
      }
      return mapped;
    },

    async submitAllPendingPriorities(actor: RequestUser, meta: RequestMeta) {
      if (!actor.permissions.includes(PERMISSIONS.WORK_OWN)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot submit priorities for approval.', 403);
      }
      const week = await this.getWeek(actor, {});
      const pending = week.priorities.filter(
        (row) =>
          row.status !== 'CANCELLED' &&
          row.status !== 'CARRIED_FORWARD' &&
          (row.approvalStatus === 'DRAFT' || row.approvalStatus === 'RESUBMIT_REQUESTED'),
      );
      if (pending.length === 0) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'No draft priorities to submit. Add week goals first, or wait if everything is already with CSO.',
          400,
        );
      }
      if (!weekHasWorkGoal(week.priorities)) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, MIN_WORK_GOAL_MESSAGE, 400);
      }
      const resubmitCount = pending.filter((row) => row.approvalStatus === 'RESUBMIT_REQUESTED').length;
      const workFirst = [
        ...pending.filter((row) => row.type === 'PROJECT' || row.type === 'REGULAR'),
        ...pending.filter((row) => row.type === 'SKILL'),
      ];
      const submitted = [];
      for (const item of workFirst) {
        submitted.push(await this.submitPriorityForApproval(actor, item.id, meta, { notify: false }));
      }
      const employee = await loadStaffById(supabase, actor.employeeId);
      const csoStaff = await listStaffByRole(supabase, ROLE_CODES.CSO);
      const titles = submitted.map((row) => row.title).join('; ');
      const allResubmits = resubmitCount === pending.length;
      const mixedResubmits = resubmitCount > 0 && !allResubmits;
      const notifyTitle = allResubmits
        ? 'Priorities resubmitted for approval'
        : mixedResubmits
          ? 'Priorities submitted and resubmitted for approval'
          : 'Weekly priorities submitted for approval';
      const notifyMessage = allResubmits
        ? `${employee?.fullName ?? 'An employee'} resubmitted ${submitted.length} priorit${submitted.length === 1 ? 'y' : 'ies'} after your comment.`
        : `${employee?.fullName ?? 'An employee'} submitted ${submitted.length} priorit${submitted.length === 1 ? 'y' : 'ies'} for CSO approval.`;
      await notifyStaff(supabase, csoStaff, {
        type: 'work',
        title: notifyTitle,
        message: notifyMessage,
        referenceType: 'weekly_plan',
        referenceId: actor.employeeId,
        eyebrow: 'Work',
        paragraphs: [
          allResubmits
            ? `${employee?.fullName ?? 'An employee'} updated and resubmitted ${submitted.length} weekly priorit${submitted.length === 1 ? 'y' : 'ies'} for your review.`
            : `${employee?.fullName ?? 'An employee'} submitted ${submitted.length} weekly priorit${submitted.length === 1 ? 'y' : 'ies'} for your review.`,
          titles,
        ],
        details: [
          { label: 'Employee', value: employee?.fullName ?? actor.employeeId },
          { label: 'Count', value: String(submitted.length) },
        ],
        ctaLabel: 'Review priorities',
        ctaHref: portalUrl(`/cso/work/priorities?employeeId=${encodeURIComponent(actor.employeeId)}`),
      });
      return { submitted, week: await this.getWeek(actor, {}) };
    },

    async approvePriority(
      actor: RequestUser,
      id: string,
      meta: RequestMeta,
      options?: { notify?: boolean },
    ) {
      assertCsoDomainOwner(actor, 'approve weekly priorities');
      if (!actor.permissions.includes(PERMISSIONS.WORK_VIEW) && !actor.permissions.includes(PERMISSIONS.WORK_ASSIGN)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot approve priorities.', 403);
      }
      const existing = await loadPriority(id);
      if ((existing.approval_status ?? 'DRAFT') !== 'SUBMITTED') {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          'Only priorities waiting for review can be approved.',
          409,
        );
      }
      const { data, error } = await supabase
        .from('weekly_priorities')
        .update({
          approval_status: 'APPROVED',
          approved_at: new Date().toISOString(),
          approved_by: actor.employeeId,
          resubmit_requested_at: null,
        })
        .eq('id', id)
        .select('*, projects ( name, code )')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to approve this priority.', 500);
      const mapped = mapPriority(data as PriorityRow);
      await writeHistory(supabase, {
        priorityId: id,
        actorId: actor.employeeId,
        action: 'approved',
        oldValues: mapPriority(existing),
        newValues: mapped,
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'weekly_priority.approve',
        entityType: 'weekly_priority',
        entityId: id,
        oldValues: mapPriority(existing),
        newValues: mapped,
        ...meta,
      });
      if (options?.notify === false) {
        return mapped;
      }
      const employee = await loadStaffById(supabase, existing.employee_id);
      await notifyStaff(supabase, employee, {
        type: 'work',
        title: 'Priority approved',
        message: `CSO approved “${mapped.title}”. You can use it in today’s work update once every priority for the week is approved.`,
        referenceType: 'weekly_priority',
        referenceId: id,
        eyebrow: 'Work',
        paragraphs: [
          `Your priority “${mapped.title}” was approved.`,
          'When every priority for this week is approved, you can start today’s work update.',
        ],
        details: [{ label: 'Priority', value: mapped.title }],
        ctaLabel: 'Open priorities',
        ctaHref: portalUrl('/work/priorities'),
      });
      return mapped;
    },

    async approveAllSubmittedPriorities(
      actor: RequestUser,
      input: { employeeId: string; date?: string },
      meta: RequestMeta,
    ) {
      assertCsoDomainOwner(actor, 'approve weekly priorities');
      if (!actor.permissions.includes(PERMISSIONS.WORK_VIEW) && !actor.permissions.includes(PERMISSIONS.WORK_ASSIGN)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot approve priorities.', 403);
      }
      const employeeId = input.employeeId.trim();
      if (!employeeId) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose an employee to approve.', 400);
      }
      const week = await this.getWeek(actor, { employeeId, date: input.date });
      const pending = week.priorities.filter(
        (row) =>
          row.status !== 'CANCELLED' &&
          row.status !== 'CARRIED_FORWARD' &&
          row.approvalStatus === 'SUBMITTED',
      );
      if (pending.length === 0) {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Nothing left to approve for this employee this week.',
          400,
        );
      }
      const approved = [];
      for (const item of pending) {
        approved.push(await this.approvePriority(actor, item.id, meta, { notify: false }));
      }
      const employee = await loadStaffById(supabase, employeeId);
      const titles = approved.map((row) => row.title).join('; ');
      await notifyStaff(supabase, employee, {
        type: 'work',
        title:
          approved.length === 1
            ? 'Priority approved'
            : `${approved.length} priorities approved`,
        message:
          approved.length === 1
            ? `CSO approved “${approved[0].title}”. You can use it in today’s work update once every priority for the week is approved.`
            : `CSO approved ${approved.length} of your weekly priorities.`,
        referenceType: 'weekly_plan',
        referenceId: employeeId,
        eyebrow: 'Work',
        paragraphs: [
          approved.length === 1
            ? `Your priority “${approved[0].title}” was approved.`
            : `CSO approved ${approved.length} priorities for this week.`,
          titles,
          'When every priority for this week is approved, you can start today’s work update.',
        ],
        details: [
          { label: 'Count', value: String(approved.length) },
        ],
        ctaLabel: 'Open priorities',
        ctaHref: portalUrl('/work/priorities'),
      });
      return { approved, week: await this.getWeek(actor, { employeeId, date: input.date }) };
    },

    async requestPriorityResubmit(actor: RequestUser, id: string, comment: string, meta: RequestMeta) {
      assertCsoDomainOwner(actor, 'request priority resubmits');
      if (!actor.permissions.includes(PERMISSIONS.WORK_VIEW) && !actor.permissions.includes(PERMISSIONS.WORK_ASSIGN)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot request a resubmit.', 403);
      }
      const note = comment.trim();
      if (!note) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a short comment so the employee knows what to change.', 400);
      }
      const existing = await loadPriority(id);
      if ((existing.approval_status ?? 'DRAFT') !== 'SUBMITTED') {
        throw new AppError(
          API_ERROR_CODES.CONFLICT,
          'Only priorities waiting for review can be sent back.',
          409,
        );
      }
      const { data, error } = await supabase
        .from('weekly_priorities')
        .update({
          approval_status: 'RESUBMIT_REQUESTED',
          cso_comment: note,
          resubmit_requested_at: new Date().toISOString(),
          approved_at: null,
          approved_by: null,
        })
        .eq('id', id)
        .select('*, projects ( name, code )')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to request a resubmit.', 500);
      const mapped = mapPriority(data as PriorityRow);
      await writeHistory(supabase, {
        priorityId: id,
        actorId: actor.employeeId,
        action: 'resubmit_requested',
        oldValues: mapPriority(existing),
        newValues: mapped,
      });
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'weekly_priority.resubmit_request',
        entityType: 'weekly_priority',
        entityId: id,
        oldValues: mapPriority(existing),
        newValues: mapped,
        ...meta,
      });
      const employee = await loadStaffById(supabase, existing.employee_id);
      await notifyStaff(supabase, employee, {
        type: 'work',
        title: 'Please resubmit this priority',
        message: `CSO asked you to update “${mapped.title}”: ${note}`,
        referenceType: 'weekly_priority',
        referenceId: id,
        eyebrow: 'Work',
        paragraphs: [
          `CSO reviewed “${mapped.title}” and asked for a resubmit.`,
          note,
          'Edit the priority, then submit it again for approval.',
        ],
        details: [
          { label: 'Priority', value: mapped.title },
          { label: 'CSO comment', value: note },
        ],
        ctaLabel: 'Update priorities',
        ctaHref: portalUrl('/work/priorities'),
      });
      return mapped;
    },

    async createFeedback(
      actor: RequestUser,
      input: { employeeId: string; comment: string; type: string },
      meta: RequestMeta,
    ) {
      if (!isCsoDomainOwner(actor) || !actor.permissions.includes(PERMISSIONS.WORK_FEEDBACK)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot leave work feedback.', 403);
      }
      const type = asType(input.type, FEEDBACK_TYPES, 'feedback type');
      const comment = input.comment.trim();
      if (!comment) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Write a short feedback note.', 400);
      const week = await this.getWeek(actor, { employeeId: input.employeeId });
      const { data, error } = await supabase
        .from('week_feedback')
        .insert({
          plan_id: week.week.planId,
          employee_id: input.employeeId,
          actor_id: actor.employeeId,
          feedback_type: type,
          comment,
        })
        .select('id')
        .single();
      if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save feedback.', 500);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'week_feedback.create',
        entityType: 'week_feedback',
        entityId: data.id as string,
        newValues: { employeeId: input.employeeId, type, comment },
        ...meta,
      });
      return this.getWeek(actor, { employeeId: input.employeeId });
    },
  };
}
