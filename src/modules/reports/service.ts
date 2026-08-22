import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { currentPeriod } from '../leave/balance';
import { formatIsoDate } from '../leave/day-count';

function requireReports(actor: RequestUser): void {
  if (!actor.permissions.includes(PERMISSIONS.REPORTS_VIEW) && !actor.permissions.includes(PERMISSIONS.SYSTEM_MANAGE)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view reports.', 403);
  }
}

function monthBounds(now = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const from = formatIsoDate(new Date(Date.UTC(y, m, 1)));
  const to = formatIsoDate(new Date(Date.UTC(y, m + 1, 0)));
  return { from, to };
}

export function createReportService(supabase: SupabaseClient) {
  return {
    async overview(actor: RequestUser, opts?: { from?: string; to?: string; period?: string }) {
      requireReports(actor);
      const period = opts?.period ?? currentPeriod();
      const bounds = monthBounds();
      const from = opts?.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from) ? opts.from : bounds.from;
      const to = opts?.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to) ? opts.to : bounds.to;

      const [
        { data: employees, error: empError },
        { data: allocations, error: allocError },
        { count: pendingLeaves, error: pendingError },
        { data: attendance, error: attError },
        { data: grievances, error: grievError },
      ] = await Promise.all([
        supabase.from('employees').select('id, status, department_id, designation_id, departments (name), designations (name)'),
        supabase
          .from('leave_allocations')
          .select('leave_type_id, used, allocated, available, employees (department_id, departments (name)), leave_types (name, code)')
          .eq('period', period),
        supabase.from('leave_applications').select('id', { count: 'exact', head: true }).eq('status', 'PENDING'),
        supabase
          .from('attendance_records')
          .select('status, overtime_minutes, late_minutes')
          .gte('attendance_date', from)
          .lte('attendance_date', to),
        supabase.from('grievances').select('id, category, status, created_at, resolved_at'),
      ]);

      if (empError || allocError || pendingError || attError || grievError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load report aggregates.', 500);
      }

      const employeeRows = employees ?? [];
      const byDepartment = new Map<string, number>();
      const byDesignation = new Map<string, number>();
      let active = 0;
      let inactive = 0;
      for (const row of employeeRows) {
        if (row.status === 'active') active += 1;
        else inactive += 1;
        const dept = firstName(row.departments as NameRel) ?? 'Unassigned';
        const desig = firstName(row.designations as NameRel) ?? 'Unassigned';
        byDepartment.set(dept, (byDepartment.get(dept) ?? 0) + 1);
        byDesignation.set(desig, (byDesignation.get(desig) ?? 0) + 1);
      }

      const leaveByType = new Map<string, { used: number; allocated: number; available: number }>();
      const leaveByDepartment = new Map<string, number>();
      let leaveUsed = 0;
      let leaveAllocated = 0;
      for (const row of allocations ?? []) {
        const typeRel = row.leave_types as { name?: string; code?: string } | { name?: string; code?: string }[] | null;
        const typeName = (Array.isArray(typeRel) ? typeRel[0]?.name : typeRel?.name) ?? 'Unknown';
        const used = Number(row.used);
        const allocated = Number(row.allocated);
        const available = Number(row.available);
        leaveUsed += used;
        leaveAllocated += allocated;
        const bucket = leaveByType.get(typeName) ?? { used: 0, allocated: 0, available: 0 };
        bucket.used += used;
        bucket.allocated += allocated;
        bucket.available += available;
        leaveByType.set(typeName, bucket);

        const emp = row.employees as
          | { department_id?: string; departments?: NameRel }
          | { department_id?: string; departments?: NameRel }[]
          | null;
        const empOne = Array.isArray(emp) ? emp[0] : emp;
        const deptName = firstName(empOne?.departments ?? null) ?? 'Unassigned';
        leaveByDepartment.set(deptName, (leaveByDepartment.get(deptName) ?? 0) + used);
      }

      const attendanceCounts: Record<string, number> = {
        PRESENT: 0,
        ABSENT: 0,
        LATE: 0,
        MISSING_PUNCH: 0,
        HALF_DAY: 0,
        LEAVE: 0,
        WEEK_OFF: 0,
        HOLIDAY: 0,
      };
      let overtimeMinutes = 0;
      let lateOccurrences = 0;
      for (const row of attendance ?? []) {
        const status = row.status as string;
        attendanceCounts[status] = (attendanceCounts[status] ?? 0) + 1;
        overtimeMinutes += Number(row.overtime_minutes ?? 0);
        if (Number(row.late_minutes ?? 0) > 0 || status === 'LATE') {
          lateOccurrences += 1;
        }
      }

      const grievanceRows = grievances ?? [];
      const openStatuses = new Set(['OPEN', 'UNDER_REVIEW', 'INVESTIGATING']);
      let open = 0;
      let resolved = 0;
      let resolutionMs = 0;
      let resolutionSamples = 0;
      const byCategory = new Map<string, number>();
      for (const row of grievanceRows) {
        const status = row.status as string;
        if (openStatuses.has(status)) open += 1;
        if (status === 'RESOLVED' || status === 'CLOSED') {
          resolved += 1;
          if (row.resolved_at && row.created_at) {
            resolutionMs += new Date(row.resolved_at as string).getTime() - new Date(row.created_at as string).getTime();
            resolutionSamples += 1;
          }
        }
        const category = row.category as string;
        byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      }

      return {
        period,
        attendanceRange: { from, to },
        employees: {
          total: employeeRows.length,
          active,
          inactive,
          byDepartment: [...byDepartment.entries()].map(([name, count]) => ({ name, count })),
          byDesignation: [...byDesignation.entries()].map(([name, count]) => ({ name, count })),
        },
        leave: {
          period,
          used: leaveUsed,
          allocated: leaveAllocated,
          utilizationRate: leaveAllocated > 0 ? Number((leaveUsed / leaveAllocated).toFixed(4)) : 0,
          pendingApprovals: pendingLeaves ?? 0,
          byType: [...leaveByType.entries()].map(([name, stats]) => ({ name, ...stats })),
          byDepartment: [...leaveByDepartment.entries()].map(([name, used]) => ({ name, used })),
        },
        attendance: {
          from,
          to,
          present: attendanceCounts.PRESENT ?? 0,
          absent: attendanceCounts.ABSENT ?? 0,
          late: lateOccurrences,
          missingPunches: attendanceCounts.MISSING_PUNCH ?? 0,
          halfDay: attendanceCounts.HALF_DAY ?? 0,
          onLeave: attendanceCounts.LEAVE ?? 0,
          overtimeMinutes,
          byStatus: Object.entries(attendanceCounts).map(([status, count]) => ({ status, count })),
        },
        grievances: {
          open,
          resolved,
          averageResolutionHours:
            resolutionSamples > 0 ? Number((resolutionMs / resolutionSamples / 3_600_000).toFixed(2)) : null,
          byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })),
        },
      };
    },
  };
}

type NameRel = { name?: string } | { name?: string }[] | null;

function firstName(rel: NameRel): string | null {
  if (!rel) return null;
  if (Array.isArray(rel)) return rel[0]?.name ?? null;
  return rel.name ?? null;
}
