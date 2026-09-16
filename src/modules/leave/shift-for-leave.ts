import type { SupabaseClient } from '@supabase/supabase-js';
import { truncateTime, type ShiftRow } from '../attendance/support';
import { listApprovedShiftOverrides, overrideShiftIdOnDate } from '../shift-changes/service';
import type { LeaveNoticeShift } from './types';

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function toNoticeShift(row: ShiftRow): LeaveNoticeShift {
  return {
    name: row.name,
    startTime: truncateTime(row.start_time),
    endTime: truncateTime(row.end_time),
    minimumDurationMinutes: Number(row.minimum_duration_minutes),
    flexible: Boolean(row.flexible),
  };
}

/**
 * Shift that applies on the first leave day: approved shift-change override, else assignment.
 */
export async function loadShiftForLeaveDate(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<LeaveNoticeShift | null> {
  const iso = dateOnly(isoDate);
  const overrides = await listApprovedShiftOverrides(supabase, iso, iso);
  const overrideId = overrideShiftIdOnDate(overrides, employeeId, iso);
  if (overrideId) {
    const { data } = await supabase.from('shifts').select('*').eq('id', overrideId).maybeSingle();
    if (data) return toNoticeShift(data as ShiftRow);
  }

  const { data: assignmentRows } = await supabase
    .from('shift_assignments')
    .select('employee_id, effective_from, effective_to, shifts (*)')
    .eq('employee_id', employeeId);

  const current = (assignmentRows ?? [])
    .filter((row) => {
      const from = dateOnly(String(row.effective_from));
      const to = row.effective_to ? dateOnly(String(row.effective_to)) : null;
      return from <= iso && (!to || to >= iso);
    })
    .sort((a, b) => (String(a.effective_from) < String(b.effective_from) ? 1 : -1))[0];

  const shift = current ? firstRel((current.shifts as ShiftRow | ShiftRow[] | null) ?? null) : null;
  return shift ? toNoticeShift(shift) : null;
}
