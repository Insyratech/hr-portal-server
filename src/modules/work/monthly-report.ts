import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { addUtcDays, formatIsoDate, parseIsoDate } from '../leave/day-count';
import { canViewOthersWork } from './access';
import { defaultMonthRange, monthBounds, monthKeysInclusive, mondaysOverlapping } from './analytics';
import { skipsWorkApprovalLoop } from './approval';
import { loadEmployeeRoleMap } from './employee-roles';
import { percent } from './overview';
import { readWeeklyPptTiming, type WeeklyPptTiming } from './ppt-week';

function assertMonth(value: string | undefined): string {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a valid month (YYYY-MM).', 400);
  }
  return value;
}

function requireTeamView(actor: RequestUser) {
  if (!canViewOthersWork(actor)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view the monthly work report.', 403);
  }
}

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

async function loadEmployeeNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase.from('employees').select('id, full_name').in('id', unique);
  if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee names.', 500);
  return new Map((data ?? []).map((row) => [row.id as string, row.full_name as string]));
}

async function loadWorkLoopPeople(supabase: SupabaseClient) {
  const [{ data: peopleRows, error: peopleError }, rolesByEmployee] = await Promise.all([
    supabase
      .from('employees')
      .select('id, full_name, employee_code, department_id, departments ( name )')
      .eq('status', 'active')
      .order('full_name'),
    loadEmployeeRoleMap(supabase),
  ]);
  if (peopleError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employees.', 500);

  return (peopleRows ?? [])
    .filter((row) => !skipsWorkApprovalLoop(rolesByEmployee.get(row.id as string) ?? []))
    .map((row) => {
      const dept = firstRel(row.departments as { name?: string } | { name?: string }[] | null);
      return {
        employeeId: row.id as string,
        fullName: row.full_name as string,
        employeeCode: (row.employee_code as string | null) ?? null,
        departmentName: dept?.name ?? null,
      };
    });
}

async function loadEmployeeOrThrow(supabase: SupabaseClient, employeeId: string) {
  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name, employee_code, department_id, departments ( name )')
    .eq('id', employeeId)
    .maybeSingle();
  if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee.', 500);
  if (!data) throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
  const dept = firstRel(data.departments as { name?: string } | { name?: string }[] | null);
  return {
    employeeId: data.id as string,
    fullName: data.full_name as string,
    employeeCode: (data.employee_code as string | null) ?? null,
    departmentName: dept?.name ?? null,
  };
}

type PriorityRow = {
  id: string;
  priority_type: string;
  title: string;
  approval_status: string;
  status: string;
  project_id: string | null;
  milestone_id: string | null;
};

export function createMonthlyWorkReportService(supabase: SupabaseClient) {
  return {
    async listPeople(actor: RequestUser) {
      requireTeamView(actor);
      const employees = await loadWorkLoopPeople(supabase);
      return { employees };
    },

    /** Calendar months available to open (no per-employee stats). */
    async listPeriods(actor: RequestUser, monthsBack = 12) {
      requireTeamView(actor);
      const today = formatIsoDate(new Date());
      const range = defaultMonthRange(today, Math.min(Math.max(monthsBack, 1), 18));
      const months = monthKeysInclusive(range.from, range.to).reverse();
      return {
        months: months.map((period) => {
          const bounds = monthBounds(period);
          const weeks = mondaysOverlapping(bounds.start, bounds.end).length;
          const [year, mon] = period.split('-').map(Number);
          const label = new Date(Date.UTC(year, mon - 1, 1)).toLocaleString('en-US', {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          });
          return { period, label, weekCount: weeks };
        }),
      };
    },

    async getDetail(actor: RequestUser, employeeId: string, monthRaw: string) {
      requireTeamView(actor);
      const period = assertMonth(monthRaw);
      const employee = await loadEmployeeOrThrow(supabase, employeeId);
      const bounds = monthBounds(period);
      const weekStarts = mondaysOverlapping(bounds.start, bounds.end);

      const empty: Record<string, unknown>[] = [];
      const [pptRes, planRes, dayRes, jcRes, memberRes] = await Promise.all([
        weekStarts.length === 0
          ? Promise.resolve({ data: empty, error: null })
          : supabase
              .from('weekly_work_updates')
              .select('week_start, week_end, submission_timing, late, submitted_at')
              .eq('employee_id', employeeId)
              .in('week_start', weekStarts),
        weekStarts.length === 0
          ? Promise.resolve({ data: empty, error: null })
          : supabase
              .from('weekly_plans')
              .select(
                'id, week_start, week_end, weekly_priorities ( id, priority_type, title, approval_status, status, project_id, milestone_id )',
              )
              .eq('employee_id', employeeId)
              .in('week_start', weekStarts),
        supabase
          .from('daily_work_days')
          .select('work_date, status, submitted_at')
          .eq('employee_id', employeeId)
          .gte('work_date', bounds.start)
          .lte('work_date', bounds.end),
        supabase
          .from('jc_ppts')
          .select('id, uploaded_at, status, transferred_at, consumed_at')
          .eq('employee_id', employeeId)
          .gte('uploaded_at', `${bounds.start}T00:00:00.000Z`)
          .lte('uploaded_at', `${bounds.end}T23:59:59.999Z`)
          .order('uploaded_at', { ascending: false }),
        supabase
          .from('project_members')
          .select('project_id, projects ( id, name, code, status, lead_employee_id )')
          .eq('employee_id', employeeId),
      ]);
      if (pptRes.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly PPTs.', 500);
      if (planRes.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly priorities.', 500);
      if (dayRes.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load daily work.', 500);
      if (jcRes.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load JC uploads.', 500);
      if (memberRes.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load projects.', 500);

      const projectIds = (memberRes.data ?? [])
        .map((row) => {
          const project = firstRel(row.projects as { id: string } | { id: string }[] | null);
          return project?.id ?? null;
        })
        .filter((id): id is string => Boolean(id));

      const { data: milestoneRows, error: milestoneError } =
        projectIds.length === 0
          ? { data: [] as Record<string, unknown>[], error: null }
          : await supabase
              .from('project_milestones')
              .select('id, project_id, name, status, target_date')
              .in('project_id', projectIds)
              .in('status', ['ACTIVE', 'COMPLETED', 'UPCOMING']);
      if (milestoneError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load milestones.', 500);

      const leadIds = (memberRes.data ?? [])
        .map((row) => {
          const project = firstRel(
            row.projects as
              | { lead_employee_id: string | null }
              | { lead_employee_id: string | null }[]
              | null,
          );
          return project?.lead_employee_id ?? null;
        })
        .filter((id): id is string => Boolean(id));
      const leadNames = await loadEmployeeNames(supabase, leadIds);

      const pptByWeek = new Map(
        (pptRes.data ?? []).map((row) => [
          row.week_start as string,
          {
            weekStart: row.week_start as string,
            weekEnd: row.week_end as string,
            submittedAt: row.submitted_at as string,
            timing: readWeeklyPptTiming(row as never) as WeeklyPptTiming,
          },
        ]),
      );

      const planByWeek = new Map(
        (planRes.data ?? []).map((row) => [
          row.week_start as string,
          {
            weekStart: row.week_start as string,
            weekEnd: row.week_end as string,
            priorities: ((row.weekly_priorities as PriorityRow[] | null) ?? []).filter(
              (p) => p.status !== 'CANCELLED',
            ),
          },
        ]),
      );

      const milestonesByProject = new Map<
        string,
        { id: string; name: string; status: string; targetDate: string | null }[]
      >();
      for (const row of milestoneRows ?? []) {
        const projectId = row.project_id as string;
        const list = milestonesByProject.get(projectId) ?? [];
        list.push({
          id: row.id as string,
          name: row.name as string,
          status: row.status as string,
          targetDate: (row.target_date as string | null) ?? null,
        });
        milestonesByProject.set(projectId, list);
      }

      const projects = (memberRes.data ?? [])
        .map((row) => {
          const project = firstRel(
            row.projects as
              | {
                  id: string;
                  name: string;
                  code: string;
                  status: string;
                  lead_employee_id: string | null;
                }
              | {
                  id: string;
                  name: string;
                  code: string;
                  status: string;
                  lead_employee_id: string | null;
                }[]
              | null,
          );
          if (!project) return null;
          const milestones = milestonesByProject.get(project.id) ?? [];
          const active = milestones.find((m) => m.status === 'ACTIVE') ?? null;
          return {
            projectId: project.id,
            name: project.name,
            code: project.code,
            status: project.status,
            leadName: project.lead_employee_id ? (leadNames.get(project.lead_employee_id) ?? null) : null,
            isLead: project.lead_employee_id === employeeId,
            activeMilestone: active
              ? { id: active.id, name: active.name, targetDate: active.targetDate }
              : null,
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));

      const hasActiveMilestone = projects.some((p) => p.status === 'active' && p.activeMilestone);

      const pptWeeks = weekStarts.map((weekStart) => {
        const end = formatIsoDate(addUtcDays(parseIsoDate(weekStart), 6));
        const uploaded = pptByWeek.get(weekStart) ?? null;
        return {
          weekStart,
          weekEnd: end,
          uploaded: Boolean(uploaded),
          timing: uploaded?.timing ?? null,
          submittedAt: uploaded?.submittedAt ?? null,
        };
      });

      const daysByDate = new Map(
        (dayRes.data ?? []).map((row) => [String(row.work_date).slice(0, 10), row]),
      );

      const weeks = weekStarts.map((weekStart) => {
        const end = formatIsoDate(addUtcDays(parseIsoDate(weekStart), 6));
        const plan = planByWeek.get(weekStart);
        const priorities = plan?.priorities ?? [];
        const approved = priorities.filter((p) => p.approval_status === 'APPROVED');
        const milestoneLinked = priorities.some((p) => Boolean(p.milestone_id));
        const prioritiesUpdated = priorities.length > 0;
        const prioritiesApproved = approved.length > 0;

        let dailyRequired = 0;
        let dailySubmitted = 0;
        let cursor = parseIsoDate(weekStart);
        const last = parseIsoDate(end);
        while (cursor.getTime() <= last.getTime()) {
          const iso = formatIsoDate(cursor);
          if (iso >= bounds.start && iso <= bounds.end) {
            const day = daysByDate.get(iso);
            if (day && (day.status === 'COMPLETED' || day.status === 'MISSING')) {
              dailyRequired += 1;
              if (day.submitted_at) dailySubmitted += 1;
            }
          }
          cursor = addUtcDays(cursor, 1);
        }

        return {
          weekStart,
          weekEnd: end,
          prioritiesUpdated,
          prioritiesApproved,
          priorityCount: priorities.length,
          approvedCount: approved.length,
          milestoneLinked,
          expectsPrioritiesForMilestone: hasActiveMilestone,
          dailyRequired,
          dailySubmitted,
          dailyOk: !prioritiesApproved || dailyRequired === 0 || dailySubmitted >= dailyRequired,
          priorities: priorities.map((p) => ({
            id: p.id,
            type: p.priority_type,
            title: p.title,
            approvalStatus: p.approval_status,
            executionStatus: p.status,
            milestoneId: p.milestone_id,
          })),
        };
      });

      const pptUploaded = pptWeeks.filter((w) => w.uploaded).length;
      const weeksWithPriorities = weeks.filter((w) => w.prioritiesUpdated).length;
      const weeksWithApproved = weeks.filter((w) => w.prioritiesApproved).length;
      const dailyRequired = weeks.reduce((sum, w) => sum + w.dailyRequired, 0);
      const dailySubmitted = weeks.reduce((sum, w) => sum + w.dailySubmitted, 0);

      return {
        period,
        employee,
        projects: projects.filter((p) => p.status === 'active'),
        ppt: {
          expected: pptWeeks.length,
          uploaded: pptUploaded,
          pct: percent(pptUploaded, pptWeeks.length),
          weeks: pptWeeks,
        },
        jc: {
          expected: true,
          count: (jcRes.data ?? []).length,
          uploads: (jcRes.data ?? []).map((row) => ({
            id: row.id as string,
            status: row.status as string,
            uploadedAt: row.uploaded_at as string,
            transferredAt: (row.transferred_at as string | null) ?? null,
            consumedAt: (row.consumed_at as string | null) ?? null,
          })),
        },
        weeks,
        summary: {
          pptPct: percent(pptUploaded, pptWeeks.length),
          prioritiesSetPct: percent(weeksWithPriorities, weeks.length),
          prioritiesApprovedPct: percent(weeksWithApproved, weeks.length),
          dailyPct: percent(dailySubmitted, dailyRequired),
          hasActiveMilestone,
        },
      };
    },
  };
}
