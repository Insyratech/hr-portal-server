import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

export async function employeeIdsOnLeave(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
): Promise<Map<string, { startDate: string; endDate: string }>> {
  const { data, error } = await supabase
    .from('leave_applications')
    .select('employee_id, start_date, end_date')
    .in('status', ['PENDING', 'APPROVED'])
    .lte('start_date', endDate)
    .gte('end_date', startDate);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check colleague leave.', 500);
  }
  const busy = new Map<string, { startDate: string; endDate: string }>();
  for (const row of data ?? []) {
    const id = String(row.employee_id);
    if (!busy.has(id)) {
      busy.set(id, { startDate: String(row.start_date).slice(0, 10), endDate: String(row.end_date).slice(0, 10) });
    }
  }
  return busy;
}

export async function assertHandoverColleagueFree(
  supabase: SupabaseClient,
  colleagueId: string,
  startDate: string,
  endDate: string,
): Promise<void> {
  const busy = await employeeIdsOnLeave(supabase, startDate, endDate);
  const clash = busy.get(colleagueId);
  if (clash) {
    throw new AppError(
      API_ERROR_CODES.HANDOVER_REQUIRED,
      `This colleague is on leave from ${clash.startDate} to ${clash.endDate}. Choose someone who is at work.`,
      400,
    );
  }
}
