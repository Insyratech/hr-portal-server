import type { SupabaseClient } from '@supabase/supabase-js';
import { refreshOpenImportDayReviews } from './service';

/**
 * Re-derive open (unconfirmed) attendance day reviews for one employee/date
 * after leave compensation changes, so LOP/leave overlays refresh before payroll.
 */
export async function refreshOpenImportsForEmployeeDate(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<void> {
  const day = String(isoDate).slice(0, 10);
  const period = day.slice(0, 7);
  const { data: imports, error } = await supabase
    .from('attendance_imports')
    .select('id, period')
    .eq('period', period)
    .in('status', ['IN_REVIEW', 'PARSED']);
  if (error || !imports?.length) return;

  for (const imp of imports) {
    await refreshOpenImportDayReviews(supabase, imp.id as string, String(imp.period), {
      employeeId,
      stampVersion: false,
    });
  }
}
