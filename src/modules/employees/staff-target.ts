import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';
import { isStaffableDirectoryTarget } from './access';

function firstRel<T>(value: T | T[] | null | undefined): T | null {
  if (!value) {
    return null;
  }
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Staffing (allocations, shifts, work week) targets any non–Super Admin employee.
 * Route-level permission (e.g. leave.allocations.manage) already gates the actor.
 */
export async function assertCanStaffDirectoryTarget(
  supabase: SupabaseClient,
  _actor: RequestUser,
  employeeId: string,
): Promise<void> {
  const { data: employee, error } = await supabase
    .from('employees')
    .select('id, deleted_at')
    .eq('id', employeeId)
    .maybeSingle();
  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee.', 500);
  }
  if (!employee || employee.deleted_at) {
    throw new AppError(API_ERROR_CODES.NOT_FOUND, 'Employee not found.', 404);
  }
  const { data: rows, error: roleError } = await supabase
    .from('employee_roles')
    .select('roles ( code )')
    .eq('employee_id', employeeId);
  if (roleError) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to load employee roles.', 500);
  }
  const codes: string[] = [];
  for (const row of rows ?? []) {
    const code = firstRel((row as { roles?: { code?: string } | { code?: string }[] | null }).roles)?.code;
    if (code) {
      codes.push(code);
    }
  }
  if (!isStaffableDirectoryTarget(codes)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'This account cannot be staffed here.', 403);
  }
}
