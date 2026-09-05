import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { listWorkWeekRows } from '../attendance/work-week';
import { formatIsoDate, patternOnDate } from '../leave/day-count';
import { loadHolidayDates, loadWorkingDays } from '../leave/support';
import {
  aggregatePriorityApproval,
  isActivePriorityForGate,
  planApprovalLabel,
  skipsWorkApprovalLoop,
  weeklyPptGlanceLabel,
  weeklyPptGlanceStatus,
} from './approval';
import { loadEmployeeRoleMap } from './employee-roles';
import { formatIsoDateInZone } from './ist-clock';
import { pptWeekBounds, sundayOfPptWeek } from './ppt-week';
import { dayContext } from './day-context';
import { completionPct } from './overview';
import { tallyToday } from './tally';
import { weekBounds } from './week-bounds';
import { canActorApprovePriority, isProjectLead, loadLeadProjectIds } from './priority-approval';

export type WorkBoardFilters = {
  date?: string;
  from?: string;
  to?: string;
  departmentId?: string;
  employeeId?: string;
  type?: string;
  category?: string;
  projectId?: string;
};

function isoOrToday(value?: string): string {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : formatIsoDate(new Date());
}

export type PrioritiesQueueItem = {
  employeeId: string;
  employeeName: string;
  departmentId: string | null;
  departmentName: string | null;
  workGoalCount: number;
  skillCount: number;
  submittedCount: number;
  weekStart: string;
  weekEnd: string;
};

export type PrioritiesApprovedItem = {
  employeeId: string;
  employeeName: string;
  departmentId: string | null;
  departmentName: string | null;
  workGoalCount: number;
  skillCount: number;
  approvedCount: number;
  weekStart: string;
  weekEnd: string;
};

export function createWorkBoardService(supabase: SupabaseClient) {
  return {
    async getBoard(actor: RequestUser, filters: WorkBoardFilters) {
      if (
        !actor.permissions.includes(PERMISSIONS.WORK_VIEW) &&
        !actor.permissions.includes(PERMISSIONS.WORK_ASSIGN)
      ) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view the work board.', 403);
      }
      const date = isoOrToday(filters.date);
      const workingDays = await loadWorkingDays(supabase);
      const week = weekBounds(date, workingDays);
      const rangeStart = isoOrToday(filters.from || week.start);
      const rangeEnd = isoOrToday(filters.to || week.end);

      let peopleQuery = supabase
        .from('employees')
        .select('id, full_name, department_id, departments ( name )')
        .eq('status', 'active')
        .order('full_name');
      if (filters.departmentId) peopleQuery = peopleQuery.eq('department_id', filters.departmentId);
      if (filters.employeeId) peopleQuery = peopleQuery.eq('id', filters.employeeId);
      const { data: peopleRows, error: peopleError } = await peopleQuery;
      if (peopleError) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load people for the work board.', 500);

      const rolesByEmployee = await loadEmployeeRoleMap(supabase);
      const people = (peopleRows ?? [])
        .map((row) => {
          const dept = row.departments as { name?: string } | { name?: string }[] | null;
          const departmentName = Array.isArray(dept) ? dept[0]?.name : dept?.name;
          return {
            id: row.id as string,
            name: row.full_name as string,
            departmentId: (row.department_id as string | null) ?? null,
            departmentName: departmentName ?? null,
          };
        })
        .filter((person) => !skipsWorkApprovalLoop(rolesByEmployee.get(person.id) ?? []));
      const ids = people.map((row) => row.id);
      if (ids.length === 0) {
        return {
          date,
          range: { start: rangeStart, end: rangeEnd },
          week,
          today: { expected: 0, submitted: 0, missing: 0, onLeave: 0 },
          weekCompletionPct: 0,
          unplannedVolume: 0,
          openBlockers: [] as { id: string; employeeId: string; employeeName: string; description: string }[],
          people: [],
        };
      }

      const [holidayDates, workWeeks, leaveRows, submittedRows, plans] = await Promise.all([
        loadHolidayDates(supabase),
        listWorkWeekRows(supabase),
        supabase
          .from('leave_applications')
          .select('employee_id')
          .eq('status', 'APPROVED')
          .lte('start_date', date)
          .gte('end_date', date)
          .in('employee_id', ids),
        supabase
          .from('daily_work_days')
          .select('employee_id, submitted_at')
          .eq('work_date', date)
          .in('employee_id', ids),
        supabase.from('weekly_plans').select('id, employee_id').eq('week_start', week.start).in('employee_id', ids),
      ]);
      if (leaveRows.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave for the work board.', 500);
      if (submittedRows.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load submissions for the work board.', 500);
      if (plans.error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly plans.', 500);

      const onLeave = new Set((leaveRows.data ?? []).map((row) => row.employee_id as string));
      const submitted = new Set(
        (submittedRows.data ?? []).filter((row) => row.submitted_at).map((row) => row.employee_id as string),
      );
      const contexts = people.map((person) =>
        dayContext({
          isoDate: date,
          workingDays,
          holidayDates,
          weekPattern: patternOnDate(workWeeks, person.id, date),
          onApprovedLeave: onLeave.has(person.id),
          submitted: submitted.has(person.id),
        }),
      );
      const contextById = new Map(people.map((person, index) => [person.id, contexts[index]]));

      const planIds = (plans.data ?? []).map((row) => row.id as string);
      let priorityQuery = planIds.length
        ? supabase
            .from('weekly_priorities')
            .select('id, plan_id, employee_id, status, approval_status, priority_type, project_id')
            .in('plan_id', planIds)
        : null;
      if (priorityQuery && filters.type) priorityQuery = priorityQuery.eq('priority_type', filters.type);
      if (priorityQuery && filters.projectId) priorityQuery = priorityQuery.eq('project_id', filters.projectId);
      const { data: priorityRows } = priorityQuery ? await priorityQuery : { data: [] };
      const statusesByEmployee = new Map<string, string[]>();
      const approvalRowsByEmployee = new Map<string, { status: string; approvalStatus: string }[]>();
      for (const row of priorityRows ?? []) {
        const employeeId = row.employee_id as string;
        const list = statusesByEmployee.get(employeeId) ?? [];
        list.push(row.status as string);
        statusesByEmployee.set(employeeId, list);
        const approvalList = approvalRowsByEmployee.get(employeeId) ?? [];
        approvalList.push({
          status: row.status as string,
          approvalStatus: (row.approval_status as string) ?? 'DRAFT',
        });
        approvalRowsByEmployee.set(employeeId, approvalList);
      }

      const pptWeek = pptWeekBounds(date);
      const pptDeadline = sundayOfPptWeek(pptWeek.start);
      const todayIso = formatIsoDateInZone(new Date());
      const { data: pptRows } = await supabase
        .from('weekly_work_updates')
        .select('employee_id, late')
        .eq('week_start', pptWeek.start)
        .in('employee_id', ids);
      const pptByEmployee = new Map(
        (pptRows ?? []).map((row) => [row.employee_id as string, { late: Boolean(row.late) }]),
      );

      let entryQuery = supabase
        .from('daily_work_days')
        .select('employee_id, daily_work_entries ( category, project_id )')
        .in('employee_id', ids)
        .gte('work_date', rangeStart)
        .lte('work_date', rangeEnd);
      const { data: dayRows } = await entryQuery;
      let unplannedVolume = 0;
      for (const day of dayRows ?? []) {
        for (const entry of (day.daily_work_entries ?? []) as { category: string; project_id: string | null }[]) {
          if (filters.projectId && entry.project_id !== filters.projectId) continue;
          if (filters.category && entry.category !== filters.category) continue;
          if (entry.category === 'UNPLANNED') unplannedVolume += 1;
        }
      }

      const { data: blockerRows } = await supabase
        .from('work_blockers')
        .select('id, employee_id, description')
        .in('employee_id', ids)
        .is('resolved_at', null)
        .order('created_at', { ascending: false })
        .limit(50);
      const nameById = new Map(people.map((row) => [row.id, row.name]));
      const openBlockers = (blockerRows ?? []).map((row) => ({
        id: row.id as string,
        employeeId: row.employee_id as string,
        employeeName: nameById.get(row.employee_id as string) ?? 'Employee',
        description: row.description as string,
      }));

      const allStatuses = [...statusesByEmployee.values()].flat();
      const peopleOut = people.map((person) => {
        const today = contextById.get(person.id)!;
        const approvalSummary = aggregatePriorityApproval(approvalRowsByEmployee.get(person.id) ?? []);
        const pptRow = pptByEmployee.get(person.id);
        const pptStatus = weeklyPptGlanceStatus({
          hasUpdate: Boolean(pptRow),
          late: pptRow?.late ?? false,
          todayIso,
          deadlineIso: pptDeadline,
        });
        return {
          id: person.id,
          name: person.name,
          departmentName: person.departmentName,
          todayStatus: today.status,
          todayLabel:
            today.status === 'ON_LEAVE'
              ? 'On leave'
              : today.status === 'COMPLETED' || today.submitted
                ? 'Submitted'
                : today.required
                  ? 'Pending'
                  : today.status === 'HOLIDAY'
                    ? 'Holiday'
                    : 'Not expected',
          weekCompletionPct: completionPct(statusesByEmployee.get(person.id) ?? []),
          approvalStatus: approvalSummary,
          approvalLabel: planApprovalLabel(approvalSummary),
          pptStatus,
          pptLabel: weeklyPptGlanceLabel(pptStatus),
        };
      });

      return {
        date,
        range: { start: rangeStart, end: rangeEnd },
        week,
        today: tallyToday(contexts),
        weekCompletionPct: completionPct(allStatuses),
        unplannedVolume,
        openBlockers,
        people: peopleOut,
      };
    },

    async listPriorityDesk(
      actor: RequestUser,
      approvalStatus: 'SUBMITTED' | 'APPROVED',
      filters?: { date?: string; scope?: 'lead' },
    ) {
      const leadScope = filters?.scope === 'lead';
      if (leadScope) {
        if (!actor.permissions.includes(PERMISSIONS.WORK_OWN)) {
          throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view the priorities queue.', 403);
        }
        const leadsAProject = await isProjectLead(supabase, actor.employeeId);
        if (!leadsAProject) {
          const date = isoOrToday(filters?.date);
          const workingDays = await loadWorkingDays(supabase);
          const week = weekBounds(date, workingDays);
          return { week, items: [] as Array<PrioritiesQueueItem | PrioritiesApprovedItem> };
        }
      } else if (
        !actor.permissions.includes(PERMISSIONS.WORK_VIEW) &&
        !actor.permissions.includes(PERMISSIONS.WORK_ASSIGN)
      ) {
        throw new AppError(
          API_ERROR_CODES.FORBIDDEN,
          approvalStatus === 'SUBMITTED'
            ? 'You cannot view the priorities queue.'
            : 'You cannot view approved priorities.',
          403,
        );
      }
      const date = isoOrToday(filters?.date);
      const workingDays = await loadWorkingDays(supabase);
      const week = weekBounds(date, workingDays);

      const { data: peopleRows, error: peopleError } = await supabase
        .from('employees')
        .select('id, full_name, department_id, departments ( name )')
        .eq('status', 'active')
        .order('full_name');
      if (peopleError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load people for the priorities desk.', 500);
      }

      const rolesByEmployee = await loadEmployeeRoleMap(supabase);
      const people = (peopleRows ?? [])
        .map((row) => {
          const dept = row.departments as { name?: string } | { name?: string }[] | null;
          const departmentName = Array.isArray(dept) ? dept[0]?.name : dept?.name;
          return {
            id: row.id as string,
            name: row.full_name as string,
            departmentId: (row.department_id as string | null) ?? null,
            departmentName: departmentName ?? null,
          };
        })
        .filter((person) => !skipsWorkApprovalLoop(rolesByEmployee.get(person.id) ?? []));

      let scopedPeople = people;
      if (leadScope) {
        const leadProjectIds = await loadLeadProjectIds(supabase, actor.employeeId);
        const { data: memberRows } = await supabase
          .from('project_members')
          .select('employee_id')
          .in('project_id', leadProjectIds);
        const memberIds = new Set((memberRows ?? []).map((row) => row.employee_id as string));
        scopedPeople = people.filter((person) => memberIds.has(person.id));
      }

      const ids = scopedPeople.map((row) => row.id);
      if (ids.length === 0) {
        return { week, items: [] as Array<PrioritiesQueueItem | PrioritiesApprovedItem> };
      }

      const { data: plans, error: plansError } = await supabase
        .from('weekly_plans')
        .select('id, employee_id')
        .eq('week_start', week.start)
        .in('employee_id', ids);
      if (plansError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load weekly plans for the priorities desk.', 500);
      }
      const planIds = (plans ?? []).map((row) => row.id as string);
      if (planIds.length === 0) {
        return { week, items: [] as Array<PrioritiesQueueItem | PrioritiesApprovedItem> };
      }

      const { data: priorityRows, error: priorityError } = await supabase
        .from('weekly_priorities')
        .select('id, employee_id, status, approval_status, priority_type, project_id')
        .in('plan_id', planIds)
        .eq('approval_status', approvalStatus);
      if (priorityError) {
        throw new AppError(
          API_ERROR_CODES.INTERNAL_ERROR,
          approvalStatus === 'SUBMITTED'
            ? 'Failed to load submitted priorities.'
            : 'Failed to load approved priorities.',
          500,
        );
      }

      type Tally = { workGoalCount: number; skillCount: number; lineCount: number };
      const tallyByEmployee = new Map<string, Tally>();
      for (const row of priorityRows ?? []) {
        if (!isActivePriorityForGate(row.status as string)) continue;
        if (leadScope) {
          const canApprove = await canActorApprovePriority(supabase, actor.employeeId, {
            id: row.id as string,
            employee_id: row.employee_id as string,
            project_id: (row.project_id as string | null) ?? null,
            priority_type: row.priority_type as string,
          });
          if (!canApprove) continue;
        }
        const employeeId = row.employee_id as string;
        const next = tallyByEmployee.get(employeeId) ?? {
          workGoalCount: 0,
          skillCount: 0,
          lineCount: 0,
        };
        next.lineCount += 1;
        if ((row.priority_type as string) === 'SKILL') next.skillCount += 1;
        else next.workGoalCount += 1;
        tallyByEmployee.set(employeeId, next);
      }

      const personById = new Map(scopedPeople.map((person) => [person.id, person]));
      const items = [...tallyByEmployee.entries()]
        .map(([employeeId, tally]) => {
          const person = personById.get(employeeId);
          if (!person) return null;
          const base = {
            employeeId,
            employeeName: person.name,
            departmentId: person.departmentId,
            departmentName: person.departmentName,
            workGoalCount: tally.workGoalCount,
            skillCount: tally.skillCount,
            weekStart: week.start,
            weekEnd: week.end,
          };
          return approvalStatus === 'SUBMITTED'
            ? ({ ...base, submittedCount: tally.lineCount } as PrioritiesQueueItem)
            : ({ ...base, approvedCount: tally.lineCount } as PrioritiesApprovedItem);
        })
        .filter((row): row is PrioritiesQueueItem | PrioritiesApprovedItem => row != null)
        .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

      return { week, items };
    },

    /** Employees with ≥1 SUBMITTED priority in the planning week containing `date`. */
    async getPrioritiesQueue(actor: RequestUser, filters?: { date?: string }) {
      const result = await this.listPriorityDesk(actor, 'SUBMITTED', filters);
      return { week: result.week, items: result.items as PrioritiesQueueItem[] };
    },

    /** Employees with ≥1 APPROVED priority in the planning week containing `date`. */
    async getApprovedPriorities(actor: RequestUser, filters?: { date?: string }) {
      const result = await this.listPriorityDesk(actor, 'APPROVED', filters);
      return { week: result.week, items: result.items as PrioritiesApprovedItem[] };
    },

    /** Project leads: employees with ≥1 SUBMITTED priority they can approve. */
    async getLeadPrioritiesQueue(actor: RequestUser, filters?: { date?: string }) {
      const result = await this.listPriorityDesk(actor, 'SUBMITTED', { ...filters, scope: 'lead' });
      return { week: result.week, items: result.items as PrioritiesQueueItem[] };
    },

    /** Project leads: employees with ≥1 APPROVED priority they approved or can view on their team. */
    async getLeadApprovedPriorities(actor: RequestUser, filters?: { date?: string }) {
      const result = await this.listPriorityDesk(actor, 'APPROVED', { ...filters, scope: 'lead' });
      return { week: result.week, items: result.items as PrioritiesApprovedItem[] };
    },
  };
}
