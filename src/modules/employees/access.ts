import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import {
  PERMISSIONS,
  ROLE_CODES,
  SA_ASSIGNABLE_ROLE_CODES,
  type RoleCode,
} from '../../shared/constants/permissions';
import { AppError } from '../../shared/errors/app-error';
import type { RequestUser } from '../../shared/types/request-user';

export function isSuperAdmin(actor: RequestUser): boolean {
  return actor.roles.includes(ROLE_CODES.SUPER_ADMIN);
}

export function isHrManager(actor: RequestUser): boolean {
  return actor.roles.includes(ROLE_CODES.HR_MANAGER) && !isSuperAdmin(actor);
}

export function isGeneralManager(actor: RequestUser): boolean {
  return actor.roles.includes(ROLE_CODES.GENERAL_MANAGER) && !isSuperAdmin(actor);
}

export function isCso(actor: RequestUser): boolean {
  return actor.roles.includes(ROLE_CODES.CSO) && !isSuperAdmin(actor);
}

export function isFinanceManager(actor: RequestUser): boolean {
  return actor.roles.includes(ROLE_CODES.FINANCE_MANAGER) && !isSuperAdmin(actor);
}

/**
 * @deprecated Use isGeneralManager. Former ADMIN role was renamed to GENERAL_MANAGER.
 */
export function isHrAdmin(actor: RequestUser): boolean {
  return isGeneralManager(actor) || (actor.roles.includes(ROLE_CODES.ADMIN) && !isSuperAdmin(actor));
}

/** Roles this actor may assign on a profile. Only Super Admin assigns. */
export function assignableRoleCodes(actor: RequestUser): Set<RoleCode> {
  if (isSuperAdmin(actor)) {
    return new Set(SA_ASSIGNABLE_ROLE_CODES);
  }
  return new Set();
}

export function hasRole(roleCodes: string[], code: RoleCode): boolean {
  return roleCodes.includes(code);
}

export function assertCanAssignRoles(actor: RequestUser, roleCodes: string[]): void {
  const allowed = assignableRoleCodes(actor);
  if (allowed.size === 0) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only Super Admin can assign access roles.', 403);
  }
  if (roleCodes.length === 0) {
    throw new AppError(API_ERROR_CODES.VALIDATION_ERROR, 'Select at least one access role.', 400);
  }
  for (const code of roleCodes) {
    if (!allowed.has(code as RoleCode)) {
      throw new AppError(
        API_ERROR_CODES.FORBIDDEN,
        'Super Admin can assign Employee, HR Manager, General Manager, CSO, or Finance Manager.',
        403,
      );
    }
  }
}

/** Only Super Admin may deactivate/delete non–Super Admin accounts. */
export function assertCanLifecycleTarget(
  actor: RequestUser,
  targetRoleCodes: string[],
  targetEmployeeId: string,
): void {
  if (targetEmployeeId === actor.employeeId) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'You cannot deactivate or delete your own account.', 403);
  }
  if (hasRole(targetRoleCodes, ROLE_CODES.SUPER_ADMIN)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'This account cannot be deactivated or deleted here.', 403);
  }
  if (isSuperAdmin(actor)) {
    return;
  }
  throw new AppError(API_ERROR_CODES.FORBIDDEN, 'Only Super Admin can deactivate or delete accounts.', 403);
}

/**
 * Directory profile mutate (PATCH / compensation / payment).
 * Super Admin may edit only when `unlocked` is true (approved HR edit request, not expired).
 */
export function assertCanMutateTarget(
  actor: RequestUser,
  targetRoleCodes: string[],
  options: { unlocked?: boolean } = {},
): void {
  if (hasRole(targetRoleCodes, ROLE_CODES.SUPER_ADMIN)) {
    throw new AppError(API_ERROR_CODES.FORBIDDEN, 'This account cannot be edited here.', 403);
  }
  if (isSuperAdmin(actor) && options.unlocked) {
    return;
  }
  throw new AppError(
    API_ERROR_CODES.FORBIDDEN,
    'Directory details are locked. HR Manager must request an edit before Super Admin can change them.',
    403,
  );
}

/** True when target is a normal directory person (not Super Admin). */
export function isStaffableDirectoryTarget(targetRoleCodes: string[]): boolean {
  return !hasRole(targetRoleCodes, ROLE_CODES.SUPER_ADMIN);
}

/** HR sets master pay + bank (not payroll runs). GM keeps payroll.manage for runs. */
export function canWriteDirectoryMasterPay(actor: RequestUser): boolean {
  return isHrManager(actor) && actor.permissions.includes(PERMISSIONS.COMPANIES_MANAGE);
}

/** @deprecated Use canWriteDirectoryMasterPay. */
export function canWriteDirectoryPayroll(actor: RequestUser): boolean {
  return canWriteDirectoryMasterPay(actor);
}

/** HR assigns company on the employee (catalog + staffing). */
export function canWriteEmployeeCompany(actor: RequestUser): boolean {
  return isHrManager(actor) && actor.permissions.includes(PERMISSIONS.COMPANIES_MANAGE);
}

/** HR writes allocations with leave.allocations.manage. */
export function canWriteDirectoryAllocations(actor: RequestUser): boolean {
  return isHrManager(actor) && actor.permissions.includes(PERMISSIONS.LEAVE_ALLOCATIONS_MANAGE);
}

/** HR assigns shifts with shifts.manage. */
export function canWriteDirectoryShiftAssignments(actor: RequestUser): boolean {
  return isHrManager(actor) && actor.permissions.includes(PERMISSIONS.SHIFTS_MANAGE);
}
