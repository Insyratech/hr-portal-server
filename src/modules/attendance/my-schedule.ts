import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { createWorkWeekService } from './work-week';

export type MyScheduleShift = {
  id: string;
  shiftId: string;
  shiftName: string;
  startTime: string | null;
  endTime: string | null;
  flexible: boolean;
  minimumDurationMinutes: number;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type MyScheduleWorkWeek = {
  id: string;
  pattern: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

function sortCurrentFirst<T extends { effectiveFrom: string; effectiveTo: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aCurrent = !a.effectiveTo ? 1 : 0;
    const bCurrent = !b.effectiveTo ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    return b.effectiveFrom.localeCompare(a.effectiveFrom);
  });
}

/** Signed-in employee only — never returns another person’s assignments. */
export function createMyScheduleService(supabase: SupabaseClient) {
  const workWeeks = createWorkWeekService(supabase);

  return {
    async getMine(actor: RequestUser) {
      if (!actor.employeeId) {
        throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Your account is not linked to an employee.', 403);
      }

      const { data: assignmentRows, error: assignmentError } = await supabase
        .from('shift_assignments')
        .select(
          'id, shift_id, effective_from, effective_to, shifts ( name, start_time, end_time, flexible, minimum_duration_minutes )',
        )
        .eq('employee_id', actor.employeeId)
        .order('effective_from', { ascending: false });
      if (assignmentError) {
        throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load your shifts.', 500);
      }

      const shifts: MyScheduleShift[] = sortCurrentFirst(
        (assignmentRows ?? []).map((row) => {
          const shiftRel = row.shifts as
            | {
                name: string;
                start_time: string;
                end_time: string;
                flexible: boolean;
                minimum_duration_minutes: number;
              }
            | {
                name: string;
                start_time: string;
                end_time: string;
                flexible: boolean;
                minimum_duration_minutes: number;
              }[]
            | null;
          const shift = Array.isArray(shiftRel) ? shiftRel[0] : shiftRel;
          return {
            id: row.id as string,
            shiftId: row.shift_id as string,
            shiftName: shift?.name ?? 'Shift',
            startTime: shift?.start_time ? String(shift.start_time).slice(0, 8) : null,
            endTime: shift?.end_time ? String(shift.end_time).slice(0, 8) : null,
            flexible: Boolean(shift?.flexible),
            minimumDurationMinutes: Number(shift?.minimum_duration_minutes ?? 0),
            effectiveFrom: String(row.effective_from).slice(0, 10),
            effectiveTo: row.effective_to ? String(row.effective_to).slice(0, 10) : null,
          };
        }),
      );

      const weekRows = await workWeeks.listForEmployee(actor, actor.employeeId);
      const workWeekHistory: MyScheduleWorkWeek[] = sortCurrentFirst(
        weekRows.map((row) => ({
          id: row.id,
          pattern: row.pattern,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
        })),
      );

      return {
        shift: {
          current: shifts.find((row) => !row.effectiveTo) ?? null,
          history: shifts,
        },
        workWeek: {
          current: workWeekHistory.find((row) => !row.effectiveTo) ?? null,
          history: workWeekHistory,
        },
      };
    },
  };
}
