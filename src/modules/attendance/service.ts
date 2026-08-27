import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { createAttendanceImportService } from './import/service';
import { todayIso } from './support';

type AttendanceRow = {
  id: string;
  employee_id: string;
  attendance_date: string;
  shift_id: string | null;
  scheduled_in: string | null;
  scheduled_out: string | null;
  actual_in: string | null;
  actual_out: string | null;
  worked_minutes: number | null;
  status: string;
  late_minutes: number;
  early_exit_minutes: number;
  overtime_minutes: number;
  employees?: { full_name: string } | { full_name: string }[] | null;
  shifts?: { name: string } | { name: string }[] | null;
};

function first<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function mapAttendance(row: AttendanceRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: first(row.employees)?.full_name ?? null,
    attendanceDate: row.attendance_date,
    shiftId: row.shift_id,
    shiftName: first(row.shifts)?.name ?? null,
    scheduledIn: row.scheduled_in,
    scheduledOut: row.scheduled_out,
    actualIn: row.actual_in,
    actualOut: row.actual_out,
    workedMinutes: row.worked_minutes,
    status: row.status,
    lateMinutes: row.late_minutes,
    earlyExitMinutes: row.early_exit_minutes,
    overtimeMinutes: row.overtime_minutes,
  };
}

export function createAttendanceService(supabase: SupabaseClient) {
  const imports = createAttendanceImportService(supabase);
  return {
    getMine(actor: RequestUser, period?: string) {
      return imports.publishedMine(actor, period);
    },

    async listForDate(actor: RequestUser, date?: string) {
      if (
        !actor.permissions.includes(PERMISSIONS.ATTENDANCE_MANAGE) &&
        !actor.permissions.includes(PERMISSIONS.USERS_VIEW)
      ) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot view attendance records.', 403);
      }
      const attendanceDate = date ?? todayIso();
      const { data, error } = await supabase
        .from('attendance_records')
        .select('*, employees (full_name), shifts (name)')
        .eq('attendance_date', attendanceDate)
        .order('created_at', { ascending: true });
      if (error) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load attendance.', 500);

      const rows = ((data ?? []) as AttendanceRow[]).map(mapAttendance);
      const counts = {
        present: rows.filter((row) => row.status === 'PRESENT').length,
        late: rows.filter((row) => row.status === 'LATE').length,
        absent: rows.filter((row) => row.status === 'ABSENT').length,
        onLeave: rows.filter((row) => row.status === 'LEAVE').length,
        missingPunch: rows.filter((row) => row.status === 'MISSING_PUNCH').length,
      };
      return { date: attendanceDate, counts, records: rows };
    },
  };
}
