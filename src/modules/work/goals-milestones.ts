import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { writeAuditLog } from '../audit/write-audit-log';

export const MILESTONE_STATUSES = ['UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** Valid manual status transitions for milestone lifecycle. */
export function canTransitionMilestone(from: MilestoneStatus, to: MilestoneStatus): boolean {
  if (from === to) return true;
  if (from === 'UPCOMING') return to === 'ACTIVE' || to === 'CANCELLED';
  if (from === 'ACTIVE') return to === 'COMPLETED' || to === 'CANCELLED';
  return false;
}

const TRACKED_MILESTONE_FIELDS = [
  'name',
  'description',
  'start_date',
  'target_date',
  'status',
  'sequence',
] as const;

type TrackedMilestoneField = (typeof TRACKED_MILESTONE_FIELDS)[number];

export type ProjectGoalOut = {
  id: string;
  projectId: string;
  name: string;
  description: string;
  isPrimary: boolean;
  sequence: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  milestones: ProjectMilestoneOut[];
};

export type ProjectMilestoneOut = {
  id: string;
  goalId: string;
  projectId: string;
  name: string;
  description: string;
  startDate: string | null;
  targetDate: string | null;
  status: MilestoneStatus;
  sequence: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectGoalListItem = Omit<ProjectGoalOut, 'milestones'>;

export type ProjectMilestoneListItem = ProjectMilestoneOut & {
  goalName: string;
};

export type MilestoneHistoryOut = {
  id: string;
  milestoneId: string;
  version: number;
  changedField: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  changedByName: string;
  changedAt: string;
  changeReason: string;
};

type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

function asMilestoneStatus(value: string): MilestoneStatus {
  if ((MILESTONE_STATUSES as readonly string[]).includes(value)) {
    return value as MilestoneStatus;
  }
  throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid milestone status.', 400);
}

function formatFieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export function collectMilestoneFieldChanges(
  before: Record<TrackedMilestoneField, unknown>,
  after: Record<TrackedMilestoneField, unknown>,
): { field: TrackedMilestoneField; oldValue: string | null; newValue: string | null }[] {
  const changes: { field: TrackedMilestoneField; oldValue: string | null; newValue: string | null }[] =
    [];
  for (const field of TRACKED_MILESTONE_FIELDS) {
    const oldValue = formatFieldValue(before[field]);
    const newValue = formatFieldValue(after[field]);
    if (oldValue !== newValue) {
      changes.push({ field, oldValue, newValue });
    }
  }
  return changes;
}

function mapGoalRow(row: Record<string, unknown>): Omit<ProjectGoalOut, 'milestones'> {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    isPrimary: Boolean(row.is_primary),
    sequence: row.sequence as number,
    createdBy: row.created_by as string,
    updatedBy: row.updated_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapMilestoneRow(row: Record<string, unknown>): ProjectMilestoneOut {
  return {
    id: row.id as string,
    goalId: row.goal_id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    startDate: row.start_date ? String(row.start_date).slice(0, 10) : null,
    targetDate: row.target_date ? String(row.target_date).slice(0, 10) : null,
    status: row.status as MilestoneStatus,
    sequence: row.sequence as number,
    createdBy: row.created_by as string,
    updatedBy: row.updated_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createProjectGoalsMilestonesService(supabase: SupabaseClient) {
  async function loadProjectRow(projectId: string) {
    const { data, error } = await supabase
      .from('projects')
      .select('id, name, code, status, lead_employee_id')
      .eq('id', projectId)
      .maybeSingle();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Project not found.', 404);
    }
    return data;
  }

  async function isProjectMember(projectId: string, employeeId: string): Promise<boolean> {
    const { data } = await supabase
      .from('project_members')
      .select('employee_id')
      .eq('project_id', projectId)
      .eq('employee_id', employeeId)
      .maybeSingle();
    return Boolean(data);
  }

  function canStaffRead(actor: RequestUser): boolean {
    return (
      actor.permissions.includes(PERMISSIONS.PROJECTS_MANAGE) ||
      actor.permissions.includes(PERMISSIONS.WORK_VIEW) ||
      actor.roles.includes(ROLE_CODES.SUPER_ADMIN)
    );
  }

  async function assertCanViewProject(actor: RequestUser, projectId: string) {
    const project = await loadProjectRow(projectId);
    if (canStaffRead(actor)) return project;
    const isLead = (project.lead_employee_id as string | null) === actor.employeeId;
    if (isLead) return project;
    if (await isProjectMember(projectId, actor.employeeId)) return project;
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view this project plan.', 403);
  }

  async function assertProjectLead(actor: RequestUser, projectId: string) {
    const project = await loadProjectRow(projectId);
    if ((project.status as string) !== 'active') {
      throw new AppError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'This project is inactive. Reactivate it before changing goals or milestones.',
        400,
      );
    }
    if ((project.lead_employee_id as string | null) !== actor.employeeId) {
      throw new AppError(
        API_ERROR_CODES.FORBIDDEN,
        'Only the current project lead can manage goals and milestones.',
        403,
      );
    }
    return project;
  }

  async function loadGoal(goalId: string) {
    const { data, error } = await supabase.from('project_goals').select('*').eq('id', goalId).maybeSingle();
    if (error || !data) {
      throw new AppError(
        API_ERROR_CODES.NOT_FOUND,
        'Goal not found. Create a goal first — milestones must belong to a goal.',
        404,
      );
    }
    return data as Record<string, unknown>;
  }

  async function loadMilestone(milestoneId: string) {
    const { data, error } = await supabase
      .from('project_milestones')
      .select('*')
      .eq('id', milestoneId)
      .maybeSingle();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Milestone not found.', 404);
    }
    return data as Record<string, unknown>;
  }

  async function nextHistoryVersion(milestoneId: string): Promise<number> {
    const { data } = await supabase
      .from('project_milestone_history')
      .select('version')
      .eq('milestone_id', milestoneId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    return ((data?.version as number | undefined) ?? 0) + 1;
  }

  async function writeMilestoneHistory(
    milestoneId: string,
    actorId: string,
    changeReason: string,
    changes: { field: TrackedMilestoneField; oldValue: string | null; newValue: string | null }[],
  ) {
    if (changes.length === 0) return;
    const version = await nextHistoryVersion(milestoneId);
    const { error } = await supabase.from('project_milestone_history').insert(
      changes.map((change) => ({
        milestone_id: milestoneId,
        version,
        changed_field: change.field,
        old_value: change.oldValue,
        new_value: change.newValue,
        changed_by: actorId,
        change_reason: changeReason,
      })),
    );
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to save milestone history.', 500);
    }
  }

  async function listGoalsWithMilestones(projectId: string): Promise<ProjectGoalOut[]> {
    const { data: goalRows, error: goalError } = await supabase
      .from('project_goals')
      .select('*')
      .eq('project_id', projectId)
      .order('sequence')
      .order('created_at');
    if (goalError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project goals.', 500);
    }

    const { data: milestoneRows, error: milestoneError } = await supabase
      .from('project_milestones')
      .select('*')
      .eq('project_id', projectId)
      .order('sequence')
      .order('created_at');
    if (milestoneError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project milestones.', 500);
    }

    const milestonesByGoal = new Map<string, ProjectMilestoneOut[]>();
    for (const row of milestoneRows ?? []) {
      const mapped = mapMilestoneRow(row as Record<string, unknown>);
      const list = milestonesByGoal.get(mapped.goalId) ?? [];
      list.push(mapped);
      milestonesByGoal.set(mapped.goalId, list);
    }

    return (goalRows ?? []).map((row) => ({
      ...mapGoalRow(row as Record<string, unknown>),
      milestones: milestonesByGoal.get(row.id as string) ?? [],
    }));
  }

  async function assertGoalHasNoPriorityLinks(goalId: string) {
    const { data: milestoneRows, error: milestoneError } = await supabase
      .from('project_milestones')
      .select('id')
      .eq('goal_id', goalId);
    if (milestoneError) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check goal usage.', 500);
    }
    const milestoneIds = (milestoneRows ?? []).map((row) => row.id as string);
    if (milestoneIds.length === 0) return;
    const { count, error } = await supabase
      .from('weekly_priorities')
      .select('id', { count: 'exact', head: true })
      .in('milestone_id', milestoneIds);
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check goal usage.', 500);
    }
    if ((count ?? 0) > 0) {
      throw new AppError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'This goal has milestones linked to employee priorities. Remove or reassign those first.',
        400,
      );
    }
  }

  async function assertMilestoneHasNoPriorityLinks(milestoneId: string) {
    const { count, error } = await supabase
      .from('weekly_priorities')
      .select('id', { count: 'exact', head: true })
      .eq('milestone_id', milestoneId);
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check milestone usage.', 500);
    }
    if ((count ?? 0) > 0) {
      throw new AppError(
        API_ERROR_CODES.VALIDATION_ERROR,
        'This milestone has employee priorities. You cannot remove it while priorities exist.',
        400,
      );
    }
  }

  async function completeOtherActiveMilestones(projectId: string, exceptId: string, actorId: string) {
    const { data: activeRows, error } = await supabase
      .from('project_milestones')
      .select('*')
      .eq('project_id', projectId)
      .eq('status', 'ACTIVE')
      .neq('id', exceptId);
    if (error) {
      throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load active milestones.', 500);
    }
    for (const row of activeRows ?? []) {
      const before = mapMilestoneRow(row as Record<string, unknown>);
      const { data: updated, error: updateError } = await supabase
        .from('project_milestones')
        .update({ status: 'COMPLETED', updated_by: actorId })
        .eq('id', before.id)
        .select('*')
        .single();
      if (updateError || !updated) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to complete the previous milestone.', 500);
      }
      const after = mapMilestoneRow(updated as Record<string, unknown>);
      await writeMilestoneHistory(
        before.id,
        actorId,
        'Another milestone was activated for this project.',
        collectMilestoneFieldChanges(
          {
            name: before.name,
            description: before.description,
            start_date: before.startDate,
            target_date: before.targetDate,
            status: before.status,
            sequence: before.sequence,
          },
          {
            name: after.name,
            description: after.description,
            start_date: after.startDate,
            target_date: after.targetDate,
            status: after.status,
            sequence: after.sequence,
          },
        ),
      );
    }
  }

  return {
    async listProjectGoals(actor: RequestUser, projectId: string) {
      await assertCanViewProject(actor, projectId);
      const { data: goalRows, error } = await supabase
        .from('project_goals')
        .select('*')
        .eq('project_id', projectId)
        .order('sequence')
        .order('created_at');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project goals.', 500);
      }
      const goals = (goalRows ?? []).map((row) => mapGoalRow(row as Record<string, unknown>));
      return { projectId, goals };
    },

    async listProjectMilestones(actor: RequestUser, projectId: string) {
      await assertCanViewProject(actor, projectId);
      const { data: milestoneRows, error } = await supabase
        .from('project_milestones')
        .select('*, project_goals ( name )')
        .eq('project_id', projectId)
        .order('sequence')
        .order('created_at');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project milestones.', 500);
      }
      const milestones: ProjectMilestoneListItem[] = (milestoneRows ?? []).map((row) => {
        const goalRel = row.project_goals as { name: string } | { name: string }[] | null;
        const goalName = Array.isArray(goalRel) ? (goalRel[0]?.name ?? '') : (goalRel?.name ?? '');
        return { ...mapMilestoneRow(row as Record<string, unknown>), goalName };
      });
      return { projectId, milestones };
    },

    async listProjectPlan(actor: RequestUser, projectId: string) {
      await assertCanViewProject(actor, projectId);
      const goals = await listGoalsWithMilestones(projectId);
      return { projectId, goals };
    },

    async createGoal(
      actor: RequestUser,
      projectId: string,
      input: { name: string; description?: string; isPrimary?: boolean; sequence?: number },
      meta: RequestMeta,
    ) {
      await assertProjectLead(actor, projectId);
      const name = input.name.trim();
      if (!name) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a goal name.', 400);
      const isPrimary = input.isPrimary ?? false;
      if (isPrimary) {
        await supabase
          .from('project_goals')
          .update({ is_primary: false, updated_by: actor.employeeId })
          .eq('project_id', projectId)
          .eq('is_primary', true);
      }
      const { data, error } = await supabase
        .from('project_goals')
        .insert({
          project_id: projectId,
          name,
          description: (input.description ?? '').trim(),
          is_primary: isPrimary,
          sequence: input.sequence ?? 1,
          created_by: actor.employeeId,
          updated_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create the goal.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project_goal.create',
        entityType: 'project_goal',
        entityId: data.id as string,
        newValues: { projectId, name, isPrimary },
        ...meta,
      });
      return { ...mapGoalRow(data as Record<string, unknown>), milestones: [] };
    },

    async updateGoal(
      actor: RequestUser,
      goalId: string,
      input: { name?: string; description?: string; isPrimary?: boolean; sequence?: number },
      meta: RequestMeta,
    ) {
      const existing = await loadGoal(goalId);
      await assertProjectLead(actor, existing.project_id as string);
      const patch: Record<string, unknown> = { updated_by: actor.employeeId };
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a goal name.', 400);
        patch.name = name;
      }
      if (input.description !== undefined) patch.description = input.description.trim();
      if (input.sequence !== undefined) patch.sequence = input.sequence;
      if (input.isPrimary === true) {
        await supabase
          .from('project_goals')
          .update({ is_primary: false, updated_by: actor.employeeId })
          .eq('project_id', existing.project_id as string)
          .eq('is_primary', true);
        patch.is_primary = true;
      } else if (input.isPrimary === false) {
        patch.is_primary = false;
      }
      const { data, error } = await supabase
        .from('project_goals')
        .update(patch)
        .eq('id', goalId)
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update the goal.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project_goal.update',
        entityType: 'project_goal',
        entityId: goalId,
        newValues: patch,
        ...meta,
      });
      const milestones = (await listGoalsWithMilestones(existing.project_id as string)).find(
        (goal) => goal.id === goalId,
      )?.milestones;
      return { ...mapGoalRow(data as Record<string, unknown>), milestones: milestones ?? [] };
    },

    async deleteGoal(actor: RequestUser, goalId: string, meta: RequestMeta) {
      const existing = await loadGoal(goalId);
      await assertProjectLead(actor, existing.project_id as string);
      await assertGoalHasNoPriorityLinks(goalId);
      const { error } = await supabase.from('project_goals').delete().eq('id', goalId);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to delete the goal.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project_goal.delete',
        entityType: 'project_goal',
        entityId: goalId,
        ...meta,
      });
      return { goalId };
    },

    async createMilestone(
      actor: RequestUser,
      goalId: string,
      input: {
        name: string;
        description?: string;
        startDate?: string | null;
        targetDate?: string | null;
        status?: string;
        sequence?: number;
      },
      meta: RequestMeta,
    ) {
      const goal = await loadGoal(goalId);
      await assertProjectLead(actor, goal.project_id as string);
      const name = input.name.trim();
      if (!name) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a milestone name.', 400);
      const status = input.status ? asMilestoneStatus(input.status) : 'UPCOMING';
      const { data, error } = await supabase
        .from('project_milestones')
        .insert({
          goal_id: goalId,
          project_id: goal.project_id as string,
          name,
          description: (input.description ?? '').trim(),
          start_date: input.startDate ?? null,
          target_date: input.targetDate ?? null,
          status,
          sequence: input.sequence ?? 1,
          created_by: actor.employeeId,
          updated_by: actor.employeeId,
        })
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'This project already has an active milestone. Complete it before activating another.',
            400,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to create the milestone.', 500);
      }
      const milestoneId = data.id as string;
      if (status === 'ACTIVE') {
        await completeOtherActiveMilestones(goal.project_id as string, milestoneId, actor.employeeId);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project_milestone.create',
        entityType: 'project_milestone',
        entityId: milestoneId,
        newValues: { goalId, name, status },
        ...meta,
      });
      return mapMilestoneRow(data as Record<string, unknown>);
    },

    async updateMilestone(
      actor: RequestUser,
      milestoneId: string,
      input: {
        name?: string;
        description?: string;
        startDate?: string | null;
        targetDate?: string | null;
        status?: string;
        sequence?: number;
        changeReason: string;
      },
      meta: RequestMeta,
    ) {
      const existing = await loadMilestone(milestoneId);
      await assertProjectLead(actor, existing.project_id as string);
      const changeReason = input.changeReason.trim();
      if (!changeReason) {
        throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a reason for this milestone change.', 400);
      }
      const before = mapMilestoneRow(existing);
      const patch: Record<string, unknown> = { updated_by: actor.employeeId };
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Add a milestone name.', 400);
        patch.name = name;
      }
      if (input.description !== undefined) patch.description = input.description.trim();
      if (input.startDate !== undefined) patch.start_date = input.startDate;
      if (input.targetDate !== undefined) patch.target_date = input.targetDate;
      if (input.sequence !== undefined) patch.sequence = input.sequence;
      if (input.status !== undefined) patch.status = asMilestoneStatus(input.status);

      const afterPreview = {
        name: (patch.name as string | undefined) ?? before.name,
        description: (patch.description as string | undefined) ?? before.description,
        start_date: input.startDate !== undefined ? input.startDate : before.startDate,
        target_date: input.targetDate !== undefined ? input.targetDate : before.targetDate,
        status: (patch.status as MilestoneStatus | undefined) ?? before.status,
        sequence: (patch.sequence as number | undefined) ?? before.sequence,
      };
      const changes = collectMilestoneFieldChanges(
        {
          name: before.name,
          description: before.description,
          start_date: before.startDate,
          target_date: before.targetDate,
          status: before.status,
          sequence: before.sequence,
        },
        afterPreview,
      );
      if (changes.length === 0) {
        return before;
      }
      if (afterPreview.status === 'ACTIVE' && before.status !== 'ACTIVE') {
        await completeOtherActiveMilestones(before.projectId, milestoneId, actor.employeeId);
      }
      const { data, error } = await supabase
        .from('project_milestones')
        .update(patch)
        .eq('id', milestoneId)
        .select('*')
        .single();
      if (error || !data) {
        if (error?.code === '23505') {
          throw new AppError(
            API_ERROR_CODES.VALIDATION_ERROR,
            'This project already has an active milestone. Complete it before activating another.',
            400,
          );
        }
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update the milestone.', 500);
      }
      const after = mapMilestoneRow(data as Record<string, unknown>);
      await writeMilestoneHistory(milestoneId, actor.employeeId, changeReason, changes);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project_milestone.update',
        entityType: 'project_milestone',
        entityId: milestoneId,
        newValues: { changes: changes.map((change) => change.field) },
        ...meta,
      });
      return after;
    },

    async activateMilestone(actor: RequestUser, milestoneId: string, input: { changeReason?: string }, meta: RequestMeta) {
      const existing = await loadMilestone(milestoneId);
      await assertProjectLead(actor, existing.project_id as string);
      const before = mapMilestoneRow(existing);
      if (before.status === 'ACTIVE') return before;
      if (before.status === 'CANCELLED' || before.status === 'COMPLETED') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Completed or cancelled milestones cannot be reactivated. Create a new milestone instead.',
          400,
        );
      }
      await completeOtherActiveMilestones(before.projectId, milestoneId, actor.employeeId);
      const changeReason = (input.changeReason ?? 'Milestone activated for the project.').trim();
      const { data, error } = await supabase
        .from('project_milestones')
        .update({ status: 'ACTIVE', updated_by: actor.employeeId })
        .eq('id', milestoneId)
        .select('*')
        .single();
      if (error || !data) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to activate the milestone.', 500);
      }
      const after = mapMilestoneRow(data as Record<string, unknown>);
      await writeMilestoneHistory(milestoneId, actor.employeeId, changeReason, [
        { field: 'status', oldValue: before.status, newValue: after.status },
      ]);
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project_milestone.activate',
        entityType: 'project_milestone',
        entityId: milestoneId,
        ...meta,
      });
      return after;
    },

    async completeMilestone(actor: RequestUser, milestoneId: string, input: { changeReason?: string }, meta: RequestMeta) {
      return this.updateMilestone(
        actor,
        milestoneId,
        {
          status: 'COMPLETED',
          changeReason: (input.changeReason ?? 'Milestone marked complete.').trim(),
        },
        meta,
      );
    },

    async cancelMilestone(actor: RequestUser, milestoneId: string, input: { changeReason?: string }, meta: RequestMeta) {
      const existing = await loadMilestone(milestoneId);
      await assertProjectLead(actor, existing.project_id as string);
      if ((existing.status as string) === 'ACTIVE') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Complete the active milestone before cancelling it, or activate another milestone first.',
          400,
        );
      }
      return this.updateMilestone(
        actor,
        milestoneId,
        {
          status: 'CANCELLED',
          changeReason: (input.changeReason ?? 'Milestone cancelled.').trim(),
        },
        meta,
      );
    },

    async deleteMilestone(actor: RequestUser, milestoneId: string, meta: RequestMeta) {
      const existing = await loadMilestone(milestoneId);
      await assertProjectLead(actor, existing.project_id as string);
      if ((existing.status as string) === 'ACTIVE') {
        throw new AppError(
          API_ERROR_CODES.VALIDATION_ERROR,
          'Complete or hand off the active milestone before deleting it.',
          400,
        );
      }
      await assertMilestoneHasNoPriorityLinks(milestoneId);
      const { error } = await supabase.from('project_milestones').delete().eq('id', milestoneId);
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to delete the milestone.', 500);
      }
      await writeAuditLog(supabase, {
        actorId: actor.employeeId,
        action: 'project_milestone.delete',
        entityType: 'project_milestone',
        entityId: milestoneId,
        ...meta,
      });
      return { milestoneId };
    },

    async getMilestoneHistory(actor: RequestUser, milestoneId: string) {
      const existing = await loadMilestone(milestoneId);
      await assertCanViewProject(actor, existing.project_id as string);
      const { data, error } = await supabase
        .from('project_milestone_history')
        .select('id, milestone_id, version, changed_field, old_value, new_value, changed_by, changed_at, change_reason')
        .eq('milestone_id', milestoneId)
        .order('version', { ascending: false })
        .order('changed_at', { ascending: false });
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load milestone history.', 500);
      }
      const rows = data ?? [];
      const actorIds = [...new Set(rows.map((row) => row.changed_by as string))];
      const { data: employees } = actorIds.length
        ? await supabase.from('employees').select('id, full_name').in('id', actorIds)
        : { data: [] };
      const names = new Map((employees ?? []).map((row) => [row.id as string, row.full_name as string]));
      const items: MilestoneHistoryOut[] = rows.map((row) => ({
        id: row.id as string,
        milestoneId: row.milestone_id as string,
        version: row.version as number,
        changedField: row.changed_field as string,
        oldValue: (row.old_value as string | null) ?? null,
        newValue: (row.new_value as string | null) ?? null,
        changedBy: row.changed_by as string,
        changedByName: names.get(row.changed_by as string) ?? 'Employee',
        changedAt: row.changed_at as string,
        changeReason: row.change_reason as string,
      }));
      return { milestoneId, items };
    },

    async getActiveMilestoneForProject(projectId: string): Promise<ProjectMilestoneOut | null> {
      const { data } = await supabase
        .from('project_milestones')
        .select('*')
        .eq('project_id', projectId)
        .eq('status', 'ACTIVE')
        .maybeSingle();
      return data ? mapMilestoneRow(data as Record<string, unknown>) : null;
    },
  };
}
