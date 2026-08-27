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
  planApprovalLabel,
  skipsWorkApprovalLoop,
  weeklyPptGlanceLabel,
  weeklyPptGlanceStatus,
} from './approval';
import { loadEmployeeRoleMap } from './employee-roles';
import { formatIsoDateInZone } from './ist-clock';
import { pptWeekBounds, saturdayOfPptWeek } from './ppt-week';
import { dayContext } from './day-context';
import { completionPct } from './overview';
import { tallyToday } from './tally';
import { weekBounds } from './week-bounds';

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
      const pptSaturday = saturdayOfPptWeek(pptWeek.start);
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
          saturdayIso: pptSaturday,
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
                  ? 'Missing'
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
  };
}
