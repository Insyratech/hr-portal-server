import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { formatIsoDate } from '../leave/day-count';
import { loadHolidayDates, loadWorkingDays } from '../leave/support';
import { deriveAttendance } from './rule-engine';
import type { ShiftDefinition } from './types';

export type ShiftRow = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  minimum_duration_minutes: number;
  grace_period_minutes: number;
  late_threshold_minutes: number;
  early_exit_threshold_minutes: number;
  flexible: boolean;
  active: boolean;
};

export function mapShift(row: ShiftRow) {
  return {
    id: row.id,
    name: row.name,
    startTime: truncateTime(row.start_time),
    endTime: truncateTime(row.end_time),
    minimumDurationMinutes: row.minimum_duration_minutes,
    gracePeriodMinutes: row.grace_period_minutes,
    lateThresholdMinutes: row.late_threshold_minutes,
    earlyExitThresholdMinutes: row.early_exit_threshold_minutes,
    flexible: row.flexible,
    active: row.active,
  };
}

export function toShiftDefinition(row: ShiftRow): ShiftDefinition {
  return {
    startTime: truncateTime(row.start_time),
    endTime: truncateTime(row.end_time),
    minimumDurationMinutes: row.minimum_duration_minutes,
    gracePeriodMinutes: row.grace_period_minutes,
    lateThresholdMinutes: row.late_threshold_minutes,
    earlyExitThresholdMinutes: row.early_exit_threshold_minutes,
    flexible: row.flexible,
  };
}

function truncateTime(value: string): string {
  return value.slice(0, 5);
}

export function todayIso(now = new Date()): string {
  return formatIsoDate(now);
}

export async function loadShiftForEmployee(
  supabase: SupabaseClient,
  employeeId: string,
  onDate: string,
): Promise<ShiftRow | null> {
  const { data: assignment, error } = await supabase
    .from('shift_assignments')
    .select('shift_id, effective_from, effective_to, shifts (*)')
    .eq('employee_id', employeeId)
    .lte('effective_from', onDate)
    .order('effective_from', { ascending: false });

  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load shift assignment.', 500);
  }

  const current = (assignment ?? []).find((row) => {
    const to = row.effective_to as string | null;
    return !to || to >= onDate;
  });

  if (!current) {
    return null;
  }

  const shift = current.shifts as ShiftRow | ShiftRow[] | null;
  const row = Array.isArray(shift) ? shift[0] : shift;
  return row ?? null;
}

export async function hasApprovedLeave(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('leave_applications')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('status', 'APPROVED')
    .lte('start_date', isoDate)
    .gte('end_date', isoDate)
    .limit(1);

  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check leave for attendance.', 500);
  }
  return (data ?? []).length > 0;
}

export async function computeAndPersistStatus(
  supabase: SupabaseClient,
  record: {
    id: string;
    employee_id: string;
    attendance_date: string;
    shift_id: string | null;
    actual_in: string | null;
    actual_out: string | null;
  },
  shift: ShiftRow | null,
): Promise<Record<string, unknown>> {
  const workingDays = await loadWorkingDays(supabase);
  const holidayDates = await loadHolidayDates(supabase);
  const onApprovedLeave = await hasApprovedLeave(supabase, record.employee_id, record.attendance_date);
  const derived = deriveAttendance({
    isoDate: record.attendance_date,
    workingDays,
    holidayDates,
    onApprovedLeave,
    shift: shift ? toShiftDefinition(shift) : null,
    actualIn: record.actual_in ? new Date(record.actual_in) : null,
    actualOut: record.actual_out ? new Date(record.actual_out) : null,
  });

  const patch = {
    shift_id: shift?.id ?? record.shift_id,
    scheduled_in: derived.scheduledIn?.toISOString() ?? null,
    scheduled_out: derived.scheduledOut?.toISOString() ?? null,
    worked_minutes: derived.workedMinutes,
    status: derived.status,
    late_minutes: derived.lateMinutes,
    early_exit_minutes: derived.earlyExitMinutes,
    overtime_minutes: derived.overtimeMinutes,
  };

  const { data, error } = await supabase
    .from('attendance_records')
    .update(patch)
    .eq('id', record.id)
    .select('*')
    .single();

  if (error || !data) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to update attendance status.', 500);
  }
  return data as Record<string, unknown>;
}
