import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';

function dateOnly(value: string): string {
  return String(value).slice(0, 10);
}

function keyOf(employeeId: string, isoDate: string): string {
  return `${employeeId}:${dateOnly(isoDate)}`;
}

/** Keys are `${employeeId}:${YYYY-MM-DD}` for approved compensated leave days (legacy offset). */
export async function loadCompensatedLeaveDateKeys(
  supabase: SupabaseClient,
  start: string,
  end: string,
  employeeId?: string,
): Promise<Set<string>> {
  let query = supabase
    .from('comp_off_work_requests')
    .select('employee_id, leave_date')
    .eq('status', 'APPROVED')
    .not('leave_date', 'is', null)
    .gte('leave_date', dateOnly(start))
    .lte('leave_date', dateOnly(end));
  if (employeeId) {
    query = query.eq('employee_id', employeeId);
  }
  const { data, error } = await query;
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensated leave days.', 500);
  }
  const keys = new Set<string>();
  for (const row of data ?? []) {
    if (!row.leave_date) continue;
    keys.add(keyOf(row.employee_id as string, String(row.leave_date)));
  }
  return keys;
}

export function isLeaveDateCompensated(
  keys: Set<string>,
  employeeId: string,
  isoDate: string,
): boolean {
  return keys.has(keyOf(employeeId, isoDate));
}

export async function isLeaveDateCompensatedForEmployee(
  supabase: SupabaseClient,
  employeeId: string,
  isoDate: string,
): Promise<boolean> {
  const day = dateOnly(isoDate);
  const { data, error } = await supabase
    .from('comp_off_work_requests')
    .select('id')
    .eq('status', 'APPROVED')
    .eq('employee_id', employeeId)
    .eq('leave_date', day)
    .limit(1);
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensated leave day.', 500);
  }
  return (data ?? []).length > 0;
}

export type AdjustedLeaveDay = {
  quantity: number;
  duration: 'full' | 'half';
};

/** Keys are `${employeeId}:${YYYY-MM-DD}` for leave days paid from COMP after an approved adjustment. */
export async function loadAdjustedLeaveDateMap(
  supabase: SupabaseClient,
  start: string,
  end: string,
  employeeId?: string,
): Promise<Map<string, AdjustedLeaveDay>> {
  let query = supabase
    .from('comp_off_adjustments')
    .select('employee_id, leave_date, quantity')
    .eq('status', 'APPROVED')
    .gte('leave_date', dateOnly(start))
    .lte('leave_date', dateOnly(end));
  if (employeeId) {
    query = query.eq('employee_id', employeeId);
  }
  const { data, error } = await query;
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory leave adjustments.', 500);
  }
  const map = new Map<string, AdjustedLeaveDay>();
  for (const row of data ?? []) {
    const quantity = Number(row.quantity) === 0.5 ? 0.5 : 1;
    map.set(keyOf(row.employee_id as string, String(row.leave_date)), {
      quantity,
      duration: quantity === 0.5 ? 'half' : 'full',
    });
  }
  return map;
}

export function adjustedLeaveOnDate(
  map: Map<string, AdjustedLeaveDay>,
  employeeId: string,
  isoDate: string,
): AdjustedLeaveDay | null {
  return map.get(keyOf(employeeId, isoDate)) ?? null;
}
