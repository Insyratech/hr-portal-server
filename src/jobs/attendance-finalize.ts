import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveAttendance } from '../modules/attendance/rule-engine';
import {
  computeAndPersistStatus,
  hasApprovedLeave,
  loadShiftForEmployee,
  toShiftDefinition,
  type ShiftRow,
} from '../modules/attendance/support';
import { loadHolidayDates, loadWorkingDays } from '../modules/leave/support';
import { needsAttendanceFinalizationWrite, yesterdayIso } from './attendance-finalize-helpers';

export type FinalizeResult = {
  date: string;
  processed: number;
  written: number;
  skipped: number;
};

/**
 * Marks attendance for a calendar day using the same deriveAttendance engine as punch/read.
 * Idempotent: a second run with unchanged punches does not rewrite matching statuses.
 */
export async function finalizeAttendanceForDate(
  supabase: SupabaseClient,
  isoDate = yesterdayIso(),
): Promise<FinalizeResult> {
  const { data: employees, error } = await supabase
    .from('employees')
    .select('id')
    .eq('status', 'active');
  if (error) {
    throw new Error(`Failed to load employees for finalization: ${error.message}`);
  }

  const workingDays = await loadWorkingDays(supabase);
  const holidayDates = await loadHolidayDates(supabase);

  let processed = 0;
  let written = 0;
  let skipped = 0;

  for (const employee of employees ?? []) {
    processed += 1;
    const employeeId = employee.id as string;
    const shift = await loadShiftForEmployee(supabase, employeeId, isoDate);
    const onApprovedLeave = await hasApprovedLeave(supabase, employeeId, isoDate);

    const { data: existing } = await supabase
      .from('attendance_records')
      .select('*')
      .eq('employee_id', employeeId)
      .eq('attendance_date', isoDate)
      .maybeSingle();

    const actualIn = (existing?.actual_in as string | null) ?? null;
    const actualOut = (existing?.actual_out as string | null) ?? null;
    const derived = deriveAttendance({
      isoDate,
      workingDays,
      holidayDates,
      onApprovedLeave,
      shift: shift ? toShiftDefinition(shift) : null,
      actualIn: actualIn ? new Date(actualIn) : null,
      actualOut: actualOut ? new Date(actualOut) : null,
    });

    if (existing && !needsAttendanceFinalizationWrite(existing.status as string, derived.status)) {
      skipped += 1;
      continue;
    }

    if (!existing) {
      const { data: created, error: insertError } = await supabase
        .from('attendance_records')
        .insert({
          employee_id: employeeId,
          attendance_date: isoDate,
          shift_id: shift?.id ?? null,
          status: derived.status,
          scheduled_in: derived.scheduledIn?.toISOString() ?? null,
          scheduled_out: derived.scheduledOut?.toISOString() ?? null,
          worked_minutes: derived.workedMinutes,
          late_minutes: derived.lateMinutes,
          early_exit_minutes: derived.earlyExitMinutes,
          overtime_minutes: derived.overtimeMinutes,
        })
        .select('*')
        .single();
      if (insertError || !created) {
        // Unique race: another writer inserted; recompute that row.
        const { data: raced } = await supabase
          .from('attendance_records')
          .select('*')
          .eq('employee_id', employeeId)
          .eq('attendance_date', isoDate)
          .maybeSingle();
        if (raced) {
          await computeAndPersistStatus(
            supabase,
            {
              id: raced.id as string,
              employee_id: employeeId,
              attendance_date: isoDate,
              shift_id: (raced.shift_id as string | null) ?? null,
              actual_in: (raced.actual_in as string | null) ?? null,
              actual_out: (raced.actual_out as string | null) ?? null,
            },
            shift,
          );
          written += 1;
          continue;
        }
        throw new Error(`Failed to insert attendance for ${employeeId}: ${insertError?.message}`);
      }
      written += 1;
      continue;
    }

    await computeAndPersistStatus(
      supabase,
      {
        id: existing.id as string,
        employee_id: employeeId,
        attendance_date: isoDate,
        shift_id: (existing.shift_id as string | null) ?? null,
        actual_in: actualIn,
        actual_out: actualOut,
      },
      shift as ShiftRow | null,
    );
    written += 1;
  }

  return { date: isoDate, processed, written, skipped };
}
