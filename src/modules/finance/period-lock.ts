import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

/** Reject posting into a locked calendar month (period lock / month close). */
export async function assertPeriodUnlocked(supabase: SupabaseClient, entryDate: string): Promise<void> {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(entryDate.slice(0, 10));
  if (!match) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Invalid entry date.', 400);
  }
  const periodYear = Number(match[1]);
  const periodMonth = Number(match[2]);
  const { data, error } = await supabase
    .from('finance_period_locks')
    .select('id')
    .eq('period_year', periodYear)
    .eq('period_month', periodMonth)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to check period lock.', 500);
  }
  if (data) {
    throw new AppError(
      API_ERROR_CODES.VALIDATION_ERROR,
      `Period ${periodYear}-${String(periodMonth).padStart(2, '0')} is locked. Unlock it before posting.`,
      400,
    );
  }
}
