import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import { currentPeriod } from '../leave/balance';
import { loadActivePolicy } from '../leave/support';

export const COMP_LEAVE_CODE = 'COMP';

export type CompLeaveType = {
  id: string;
  code: string;
  name: string;
  paid: boolean;
};

export async function loadCompLeaveType(supabase: SupabaseClient): Promise<CompLeaveType> {
  const { data, error } = await supabase
    .from('leave_types')
    .select('id, code, name, paid')
    .eq('code', COMP_LEAVE_CODE)
    .maybeSingle();
  if (error || !data) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Compensatory leave type is not configured.', 500);
  }
  return {
    id: data.id as string,
    code: data.code as string,
    name: (data.name as string) || 'Compensatory Leave',
    paid: data.paid !== false,
  };
}

export async function loadCompEarnCap(supabase: SupabaseClient): Promise<number> {
  const type = await loadCompLeaveType(supabase);
  try {
    const policy = await loadActivePolicy(supabase, type.id);
    return Math.max(0, Number(policy.rules.annualAllocation) || 0);
  } catch {
    return 0;
  }
}

export async function ensureCompAllocation(
  supabase: SupabaseClient,
  employeeId: string,
  period = currentPeriod(),
): Promise<{ id: string; available: number; earned: number }> {
  const type = await loadCompLeaveType(supabase);
  const { data: existing, error } = await supabase
    .from('leave_allocations')
    .select('id, available, earned')
    .eq('employee_id', employeeId)
    .eq('leave_type_id', type.id)
    .eq('period', period)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load compensatory leave balance.', 500);
  }
  if (existing) {
    return {
      id: existing.id as string,
      available: Number(existing.available ?? 0),
      earned: Number(existing.earned ?? 0),
    };
  }

  const { data: created, error: insertError } = await supabase
    .from('leave_allocations')
    .insert({
      employee_id: employeeId,
      leave_type_id: type.id,
      period,
      allocated: 0,
      carried_forward: 0,
      adjusted: 0,
      used: 0,
      available: 0,
    })
    .select('id, available, earned')
    .single();
  if (insertError?.code === '23505') {
    const { data: raced } = await supabase
      .from('leave_allocations')
      .select('id, available, earned')
      .eq('employee_id', employeeId)
      .eq('leave_type_id', type.id)
      .eq('period', period)
      .maybeSingle();
    if (raced) {
      return {
        id: raced.id as string,
        available: Number(raced.available ?? 0),
        earned: Number(raced.earned ?? 0),
      };
    }
  }
  if (insertError || !created) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to open compensatory leave balance.', 500);
  }
  return {
    id: created.id as string,
    available: Number(created.available ?? 0),
    earned: Number(created.earned ?? 0),
  };
}

export async function creditCompEarned(
  supabase: SupabaseClient,
  input: {
    employeeId: string;
    requestId: string;
    quantity: number;
  },
): Promise<number> {
  const quantity = Number(input.quantity);
  if (!(quantity > 0)) return 0;

  const type = await loadCompLeaveType(supabase);
  const allocation = await ensureCompAllocation(supabase, input.employeeId);

  const { error } = await supabase.from('leave_ledger').insert({
    employee_id: input.employeeId,
    leave_type_id: type.id,
    allocation_id: allocation.id,
    transaction_type: 'COMP_EARNED',
    quantity,
    reference_type: 'comp_off_work_request',
    reference_id: input.requestId,
  });
  if (error) {
    if (error.code === '23505') {
      return 0;
    }
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to credit compensatory leave.', 500);
  }
  await supabase.rpc('recompute_leave_allocation', { p_allocation_id: allocation.id });
  return quantity;
}

export async function consumeCompBalance(
  supabase: SupabaseClient,
  input: {
    employeeId: string;
    quantity: number;
    referenceType: string;
    referenceId: string;
  },
): Promise<number> {
  const quantity = Number(input.quantity);
  if (!(quantity > 0)) return 0;

  const type = await loadCompLeaveType(supabase);
  const allocation = await ensureCompAllocation(supabase, input.employeeId);
  if (Number(allocation.available) + 1e-9 < quantity) {
    throw new AppError(
      API_ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE,
      'Not enough compensatory leave balance for this request.',
      400,
    );
  }

  const { error } = await supabase.from('leave_ledger').insert({
    employee_id: input.employeeId,
    leave_type_id: type.id,
    allocation_id: allocation.id,
    transaction_type: 'COMP_ADJUSTMENT',
    quantity: -quantity,
    reference_type: input.referenceType,
    reference_id: input.referenceId,
  });
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to deduct compensatory leave.', 500);
  }
  await supabase.rpc('recompute_leave_allocation', { p_allocation_id: allocation.id });
  return quantity;
}

export async function restoreOriginalLeaveBalance(
  supabase: SupabaseClient,
  input: {
    employeeId: string;
    leaveTypeId: string;
    quantity: number;
    referenceId: string;
  },
): Promise<number> {
  const quantity = Number(input.quantity);
  if (!(quantity > 0)) return 0;

  const period = currentPeriod();
  const { data: allocation, error } = await supabase
    .from('leave_allocations')
    .select('id')
    .eq('employee_id', input.employeeId)
    .eq('leave_type_id', input.leaveTypeId)
    .eq('period', period)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load original leave balance.', 500);
  }
  if (!allocation) return 0;

  const { error: ledgerError } = await supabase.from('leave_ledger').insert({
    employee_id: input.employeeId,
    leave_type_id: input.leaveTypeId,
    allocation_id: allocation.id,
    transaction_type: 'COMP_ADJUSTMENT',
    quantity,
    reference_type: 'comp_off_adjustment',
    reference_id: input.referenceId,
  });
  if (ledgerError) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to restore the original leave balance.', 500);
  }
  await supabase.rpc('recompute_leave_allocation', { p_allocation_id: allocation.id });
  return quantity;
}

export function remainingEarnCap(annualCap: number, earned: number, pending: number): number {
  if (!(annualCap > 0)) return Number.POSITIVE_INFINITY;
  return Number((annualCap - earned - pending).toFixed(2));
}
