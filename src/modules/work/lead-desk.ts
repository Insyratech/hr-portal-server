import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { formatIsoDate } from '../leave/day-count';
import { loadWorkingDays } from '../leave/support';
import { loadStaffById, notifyStaff } from '../notifications/notify-staff';
import { portalUrl } from '../notifications/mail';
import { listProjectStatusUpdates } from './project-updates';
import { buildProjectReportingChain } from './project-reporting';
import type { MilestoneStatus } from './goals-milestones';
import { weekBounds } from './week-bounds';

function canOpenLeadDesk(actor: RequestUser): boolean {
  return (
    actor.permissions.includes(PERMISSIONS.WORK_OWN) ||
    actor.permissions.includes(PERMISSIONS.WORK_VIEW) ||
    actor.permissions.includes(PERMISSIONS.PROJECTS_MANAGE)
  );
}

export async function notifyProjectLeadAssigned(
  supabase: SupabaseClient,
  input: { projectId: string; projectName: string; projectCode: string; leadEmployeeId: string },
): Promise<void> {
  const lead = await loadStaffById(supabase, input.leadEmployeeId);
  if (!lead) return;
  await notifyStaff(supabase, lead, {
    type: 'work',
    title: 'You are the project lead',
    message: `You are now the project lead for ${input.projectName} (${input.projectCode}).`,
    referenceType: 'project',
    referenceId: input.projectId,
    eyebrow: 'Projects',
    paragraphs: [
      `CSO assigned you as project lead for ${input.projectName}.`,
      'Open My projects to see members, post status updates, and review priorities for this project.',
    ],
    details: [
      { label: 'Project', value: input.projectName },
      { label: 'Code', value: input.projectCode },
    ],
    ctaLabel: 'Open My projects',
    ctaHref: portalUrl(`/work/projects/${input.projectId}`),
  });
}

export function createLeadDeskService(supabase: SupabaseClient) {
  async function loadEmployeeNames(employeeIds: string[]) {
    const unique = [...new Set(employeeIds.filter(Boolean))];
    if (unique.length === 0) return new Map<string, string>();
    const { data } = await supabase.from('employees').select('id, full_name').in('id', unique);
    return new Map((data ?? []).map((row) => [row.id as string, row.full_name as string]));
  }

  async function loadProjectForLead(actor: RequestUser, projectId: string) {
    const { data, error } = await supabase
      .from('projects')
      .select('id, name, code, status, lead_employee_id')
      .eq('id', projectId)
      .maybeSingle();
    if (error || !data) {
      throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Project not found.', 404);
    }
    if ((data.status as string) !== 'active') {
      throw new AppError(
        API_ERROR_CODES.FORBIDDEN,
        'This project is inactive. The lead desk is only available for active projects.',
        403,
      );
    }
    if ((data.lead_employee_id as string | null) !== actor.employeeId) {
      throw new AppError(
        API_ERROR_CODES.FORBIDDEN,
        'Only the current project lead can open this desk.',
        403,
      );
    }
    return data;
  }

  return {
    async listLeadProjects(actor: RequestUser) {
      if (!canOpenLeadDesk(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view project lead desks.', 403);
      }
      const { data, error } = await supabase
        .from('projects')
        .select('id, name, code, status, lead_employee_id')
        .eq('lead_employee_id', actor.employeeId)
        .eq('status', 'active')
        .order('name');
      if (error) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load your lead projects.', 500);
      }
      const projects = data ?? [];
      if (projects.length === 0) return [];

      const ids = projects.map((row) => row.id as string);
      const { data: memberRows } = await supabase
        .from('project_members')
        .select('project_id')
        .in('project_id', ids);
      const countByProject = new Map<string, number>();
      for (const row of memberRows ?? []) {
        const projectId = row.project_id as string;
        countByProject.set(projectId, (countByProject.get(projectId) ?? 0) + 1);
      }

      return projects.map((row) => ({
        id: row.id as string,
        name: row.name as string,
        code: row.code as string,
        status: row.status as string,
        leadEmployeeId: row.lead_employee_id as string,
        memberCount: countByProject.get(row.id as string) ?? 0,
      }));
    },

    async getLeadProjectDesk(actor: RequestUser, projectId: string, date?: string) {
      if (!canOpenLeadDesk(actor)) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view project lead desks.', 403);
      }
      const project = await loadProjectForLead(actor, projectId);
      const workingDays = await loadWorkingDays(supabase);
      const isoDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : formatIsoDate(new Date());
      const week = weekBounds(isoDate, workingDays);

      const { data: memberRows, error: memberError } = await supabase
        .from('project_members')
        .select('employee_id')
        .eq('project_id', projectId);
      if (memberError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project members.', 500);
      }
      const memberIds = (memberRows ?? []).map((row) => row.employee_id as string);
      const names = await loadEmployeeNames([
        ...memberIds,
        (project.lead_employee_id as string) ?? '',
      ]);
      const members = memberIds
        .map((employeeId) => ({
          employeeId,
          fullName: names.get(employeeId) ?? 'Employee',
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));

      const { data: planRows } = memberIds.length
        ? await supabase
            .from('weekly_plans')
            .select('id, employee_id')
            .eq('week_start', week.start)
            .in('employee_id', memberIds)
        : { data: [] as { id: string; employee_id: string }[] };
      const planIds = (planRows ?? []).map((row) => row.id as string);
      const planEmployee = new Map(
        (planRows ?? []).map((row) => [row.id as string, row.employee_id as string]),
      );

      type PriorityOut = {
        id: string;
        employeeId: string;
        employeeName: string;
        title: string;
        type: string;
        status: string;
        approvalStatus: string;
        milestoneId: string | null;
        milestoneName: string | null;
        isAdditional: boolean;
      };
      let priorities: PriorityOut[] = [];
      if (planIds.length) {
        const { data: priorityRows, error: priorityError } = await supabase
          .from('weekly_priorities')
          .select(
            'id, plan_id, employee_id, title, priority_type, status, approval_status, milestone_id, is_additional, project_milestones ( name )',
          )
          .in('plan_id', planIds)
          .eq('project_id', projectId)
          .order('created_at', { ascending: true });
        if (priorityError) {
          throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project priorities.', 500);
        }
        priorities = (priorityRows ?? []).map((row) => {
          const employeeId =
            (row.employee_id as string | null) ?? planEmployee.get(row.plan_id as string) ?? '';
          const milestoneRel = row.project_milestones as { name: string } | { name: string }[] | null;
          const milestoneName = Array.isArray(milestoneRel)
            ? (milestoneRel[0]?.name ?? null)
            : (milestoneRel?.name ?? null);
          return {
            id: row.id as string,
            employeeId,
            employeeName: names.get(employeeId) ?? 'Employee',
            title: row.title as string,
            type: row.priority_type as string,
            status: row.status as string,
            approvalStatus: (row.approval_status as string) ?? 'DRAFT',
            milestoneId: (row.milestone_id as string | null) ?? null,
            milestoneName,
            isAdditional: Boolean(row.is_additional),
          };
        });
      }

      const prioritiesByMilestone: {
        milestoneId: string | null;
        milestoneName: string;
        items: PriorityOut[];
      }[] = [];
      const groupMap = new Map<string, { milestoneId: string | null; milestoneName: string; items: PriorityOut[] }>();
      for (const item of priorities) {
        const key = item.milestoneId ?? 'none';
        const group =
          groupMap.get(key) ??
          ({
            milestoneId: item.milestoneId,
            milestoneName: item.milestoneName ?? 'No milestone',
            items: [],
          } as { milestoneId: string | null; milestoneName: string; items: PriorityOut[] });
        group.items.push(item);
        groupMap.set(key, group);
      }
      prioritiesByMilestone.push(...groupMap.values());

      const { data: activeMilestoneRow } = await supabase
        .from('project_milestones')
        .select('id, name, target_date, project_goals ( name )')
        .eq('project_id', projectId)
        .eq('status', 'ACTIVE')
        .maybeSingle();
      const activeGoalRel = activeMilestoneRow?.project_goals as
        | { name: string }
        | { name: string }[]
        | null
        | undefined;
      const activeGoalName = Array.isArray(activeGoalRel)
        ? (activeGoalRel[0]?.name ?? '')
        : (activeGoalRel?.name ?? '');
      const activeMilestone = activeMilestoneRow
        ? {
            id: activeMilestoneRow.id as string,
            name: activeMilestoneRow.name as string,
            goalName: activeGoalName,
            targetDate: activeMilestoneRow.target_date
              ? String(activeMilestoneRow.target_date).slice(0, 10)
              : null,
          }
        : null;

      const { data: dayRows, error: dayError } = memberIds.length
        ? await supabase
            .from('daily_work_days')
            .select(
              'work_date, employee_id, daily_work_entries ( id, category, description, project_id, priority_id )',
            )
            .in('employee_id', memberIds)
            .gte('work_date', week.start)
            .lte('work_date', week.end)
            .order('work_date', { ascending: false })
        : { data: [], error: null };
      if (dayError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load project daily work.', 500);
      }

      const dailyEntries: {
        id: string;
        date: string;
        employeeId: string;
        employeeName: string;
        category: string;
        description: string;
        priorityId: string | null;
      }[] = [];
      for (const day of dayRows ?? []) {
        const employeeId = day.employee_id as string;
        const entries = (day.daily_work_entries ?? []) as {
          id: string;
          category: string;
          description: string;
          project_id: string | null;
          priority_id: string | null;
        }[];
        for (const entry of entries) {
          if (entry.project_id !== projectId) continue;
          dailyEntries.push({
            id: entry.id,
            date: String(day.work_date).slice(0, 10),
            employeeId,
            employeeName: names.get(employeeId) ?? 'Employee',
            category: entry.category,
            description: entry.description,
            priorityId: entry.priority_id,
          });
        }
      }

      const leadEmployeeId = project.lead_employee_id as string;
      const updates = await listProjectStatusUpdates(supabase, projectId);

      const { data: goalRows } = await supabase
        .from('project_goals')
        .select('id, name, sequence, project_milestones ( id, name, status, sequence )')
        .eq('project_id', projectId)
        .order('sequence')
        .order('created_at');
      const reportingGoals = (goalRows ?? []).map((row) => ({
        id: row.id as string,
        name: row.name as string,
        sequence: row.sequence as number,
        milestones: ((row.project_milestones ?? []) as {
          id: string;
          name: string;
          status: string;
          sequence: number;
        }[]).map((milestone) => ({
          id: milestone.id,
          name: milestone.name,
          status: milestone.status as MilestoneStatus,
          sequence: milestone.sequence,
        })),
      }));
      const reportingChain = buildProjectReportingChain({
        goals: reportingGoals,
        priorities,
        dailyEntries,
      });

      return {
        project: {
          id: project.id as string,
          name: project.name as string,
          code: project.code as string,
          status: project.status as string,
          leadEmployeeId,
          leadName: names.get(leadEmployeeId) ?? 'Lead',
          memberCount: members.length,
          members,
        },
        week: { start: week.start, end: week.end },
        activeMilestone,
        updates,
        priorities,
        prioritiesByMilestone,
        dailyEntries,
        reportingChain,
      };
    },
  };
}
