import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { listWorkWeekRows } from '../attendance/work-week';
import { isWorkingDate, parseIsoDate, patternOnDate, weekdayCode, type WeekPattern } from '../leave/day-count';
import { loadHolidayDates, loadWorkingDays } from '../leave/support';
import type { DayContext, WorkDayStatus } from './types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(value: string): string {
  if (!ISO_DATE.test(value)) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a date as YYYY-MM-DD.', 400);
  }
  const parsed = parseIsoDate(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Choose a date as YYYY-MM-DD.', 400);
  }
  return value;
}

/**
 * Derived calendar status for a work update.
 * Leave and holidays skip updates. Non-working weekdays that are not Sat/Sun are NOT_REQUIRED.
 */
export function dayContext(input: {
  isoDate: string;
  workingDays: string[];
  holidayDates: string[];
  weekPattern?: WeekPattern | null;
  onApprovedLeave: boolean;
  submitted: boolean;
}): DayContext {
  const isoDate = input.isoDate;
  const holiday = input.holidayDates.includes(isoDate);
  const working = isWorkingDate(isoDate, input.workingDays, input.holidayDates, input.weekPattern);

  let status: WorkDayStatus;
  if (holiday) {
    status = 'HOLIDAY';
  } else if (input.onApprovedLeave && working) {
    status = 'ON_LEAVE';
  } else if (!working) {
    const code = weekdayCode(parseIsoDate(isoDate));
    status = code === 'SAT' || code === 'SUN' ? 'WEEKEND' : 'NOT_REQUIRED';
  } else if (input.submitted) {
    status = 'COMPLETED';
  } else {
    status = 'MISSING';
  }

  return {
    isoDate,
    required: working && !input.onApprovedLeave,
    status,
    onApprovedLeave: input.onApprovedLeave,
    submitted: input.submitted,
  };
}

async function approvedLeaveOnDate(
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
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load leave for this date.', 500);
  }
  return (data ?? []).length > 0;
}

async function submittedOnDate(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('daily_work_days')
    .select('id, submitted_at')
    .eq('employee_id', employeeId)
    .eq('work_date', isoDate)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load the work update for this date.', 500);
  }
  return Boolean(data?.submitted_at);
}

export async function loadDayContext(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<DayContext> {
  const date = assertIsoDate(isoDate);
  const [workingDays, holidayDates, workWeeks, onApprovedLeave, submitted] = await Promise.all([
    loadWorkingDays(supabase),
    loadHolidayDates(supabase),
    listWorkWeekRows(supabase, employeeId),
    approvedLeaveOnDate(supabase, employeeId, date),
    submittedOnDate(supabase, employeeId, date),
  ]);
  return dayContext({
    isoDate: date,
    workingDays,
    holidayDates,
    weekPattern: patternOnDate(workWeeks, employeeId, date),
    onApprovedLeave,
    submitted,
  });
}
