import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

export async function ensureWeeklyPlan(
  supabase: SupabaseClient,
  employeeId: string,
  start: string,
  end: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from('weekly_plans')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('week_start', start)
    .maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data, error } = await supabase
    .from('weekly_plans')
    .insert({ employee_id: employeeId, week_start: start, week_end: end })
    .select('id')
    .single();
  if (error?.code === '23505') {
    const { data: again } = await supabase
      .from('weekly_plans')
      .select('id')
      .eq('employee_id', employeeId)
      .eq('week_start', start)
      .maybeSingle();
    if (again?.id) return again.id as string;
  }
  if (error || !data) throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to open this week’s plan.', 500);
  return data.id as string;
}
