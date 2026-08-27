import type { SupabaseClient } from '@supabase/supabase-js';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import type { Permission, RoleCode } from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';

type PermissionRow = { code: string };
type RolePermissionRow = { permissions: PermissionRow | PermissionRow[] | null };
type RoleRow = {
  code: string;
  role_permissions: RolePermissionRow[] | null;
};
type EmployeeRoleRow = { roles: RoleRow | RoleRow[] | null };

type EmployeeAuthRow = {
  id: string;
  user_id: string | null;
  full_name: string;
  email: string;
  status: string;
  deleted_at?: string | null;
  employee_roles: EmployeeRoleRow[] | null;
};

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export async function resolveRequestUser(
  supabase: SupabaseClient,
  authUserId: string,
  tokenEmail: string,
): Promise<RequestUser> {
  const { data, error } = await supabase
    .from('employees')
    .select(
      `
      id,
      user_id,
      full_name,
      email,
      status,
      deleted_at,
      employee_roles (
        roles (
          code,
          role_permissions (
            permissions (code)
          )
        )
      )
    `,
    )
    .eq('user_id', authUserId)
    .maybeSingle();

  if (error) {
    throw new AppError(API_ERROR_CODES.INTERNAL_ERROR, 'Failed to resolve employee.', 500);
  }

  const row = data as EmployeeAuthRow | null;
  if (!row) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'No employee profile is linked to this account.', 403);
  }

  if (row.status !== 'active' || row.deleted_at) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'This employee account is inactive.', 403);
  }

  const roles: RoleCode[] = [];
  const permissionSet = new Set<Permission>();

  for (const employeeRole of asArray(row.employee_roles)) {
    for (const role of asArray(employeeRole.roles)) {
      roles.push(role.code as RoleCode);
      for (const rolePermission of asArray(role.role_permissions)) {
        for (const permission of asArray(rolePermission.permissions)) {
          permissionSet.add(permission.code as Permission);
        }
      }
    }
  }

  return {
    authUserId,
    employeeId: row.id,
    email: row.email || tokenEmail,
    fullName: row.full_name,
    roles,
    permissions: [...permissionSet],
  };
}
