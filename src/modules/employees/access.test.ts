import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '../../shared/constants/error-codes';
import { PERMISSIONS, ROLE_CODES, SA_ASSIGNABLE_ROLE_CODES } from '../../shared/constants/permissions';
import type { RequestUser } from '../../shared/types/request-user';
import {
  assertCanAssignRoles,
  assertCanLifecycleTarget,
  assertCanMutateTarget,
  assignableRoleCodes,
  canWriteDirectoryAllocations,
  canWriteDirectoryMasterPay,
  canWriteDirectoryPayroll,
  canWriteEmployeeCompany,
} from './access';

const superAdmin: RequestUser = {
  authUserId: 'auth-sa',
  employeeId: 'sa-1',
  email: 'sa@example.com',
  fullName: 'Super Admin',
  roles: [ROLE_CODES.SUPER_ADMIN],
  permissions: [PERMISSIONS.USERS_MANAGE],
};

const hrManager: RequestUser = {
  authUserId: 'auth-hr',
  employeeId: 'hr-1',
  email: 'hr@example.com',
  fullName: 'HR Manager',
  roles: [ROLE_CODES.HR_MANAGER],
  permissions: [
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.LEAVE_ALLOCATIONS_MANAGE,
    PERMISSIONS.LEAVE_APPROVE,
    PERMISSIONS.COMPANIES_MANAGE,
  ],
};

const generalManager: RequestUser = {
  authUserId: 'auth-gm',
  employeeId: 'gm-1',
  email: 'gm@example.com',
  fullName: 'General Manager',
  roles: [ROLE_CODES.GENERAL_MANAGER],
  permissions: [PERMISSIONS.USERS_VIEW, PERMISSIONS.PAYROLL_MANAGE, PERMISSIONS.ATTENDANCE_MANAGE],
};

describe('employee access', () => {
  it('lets Super Admin assign Employee, HR, GM, CSO, and Finance', () => {
    expect([...assignableRoleCodes(superAdmin)].sort()).toEqual([...SA_ASSIGNABLE_ROLE_CODES].sort());
    expect(() => assertCanAssignRoles(superAdmin, [ROLE_CODES.EMPLOYEE])).not.toThrow();
    expect(() => assertCanAssignRoles(superAdmin, [ROLE_CODES.HR_MANAGER])).not.toThrow();
    expect(() => assertCanAssignRoles(superAdmin, [ROLE_CODES.GENERAL_MANAGER])).not.toThrow();
    expect(() => assertCanAssignRoles(superAdmin, [ROLE_CODES.CSO])).not.toThrow();
    expect(() => assertCanAssignRoles(superAdmin, [ROLE_CODES.FINANCE_MANAGER])).not.toThrow();
    expect(() => assertCanAssignRoles(superAdmin, [ROLE_CODES.SUPER_ADMIN])).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
  });

  it('blocks HR Manager and General Manager from assigning roles', () => {
    expect([...assignableRoleCodes(hrManager)]).toEqual([]);
    expect([...assignableRoleCodes(generalManager)]).toEqual([]);
    expect(() => assertCanAssignRoles(hrManager, [ROLE_CODES.EMPLOYEE])).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertCanAssignRoles(generalManager, [ROLE_CODES.EMPLOYEE])).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
  });

  it('blocks Super Admin from editing directory rows until an approved edit request', () => {
    expect(() => assertCanMutateTarget(superAdmin, [ROLE_CODES.EMPLOYEE])).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertCanMutateTarget(superAdmin, [ROLE_CODES.HR_MANAGER])).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertCanMutateTarget(superAdmin, [ROLE_CODES.GENERAL_MANAGER])).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertCanMutateTarget(superAdmin, [ROLE_CODES.SUPER_ADMIN])).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
  });

  it('lets Super Admin edit when unlocked for a non–Super Admin target', () => {
    expect(() =>
      assertCanMutateTarget(superAdmin, [ROLE_CODES.EMPLOYEE], { unlocked: true }),
    ).not.toThrow();
    expect(() =>
      assertCanMutateTarget(superAdmin, [ROLE_CODES.HR_MANAGER], { unlocked: true }),
    ).not.toThrow();
    expect(() =>
      assertCanMutateTarget(hrManager, [ROLE_CODES.EMPLOYEE], { unlocked: true }),
    ).toThrow(expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }));
  });

  it('blocks HR Manager and General Manager from directory mutate', () => {
    expect(() => assertCanMutateTarget(hrManager, [ROLE_CODES.EMPLOYEE])).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertCanMutateTarget(generalManager, [ROLE_CODES.EMPLOYEE])).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
  });

  it('lets only Super Admin deactivate or delete accounts', () => {
    expect(() => assertCanLifecycleTarget(superAdmin, [ROLE_CODES.EMPLOYEE], 'emp-2')).not.toThrow();
    expect(() => assertCanLifecycleTarget(superAdmin, [ROLE_CODES.HR_MANAGER], 'hr-2')).not.toThrow();
    expect(() => assertCanLifecycleTarget(superAdmin, [ROLE_CODES.GENERAL_MANAGER], 'gm-2')).not.toThrow();
    expect(() => assertCanLifecycleTarget(superAdmin, [ROLE_CODES.SUPER_ADMIN], 'sa-2')).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertCanLifecycleTarget(superAdmin, [ROLE_CODES.EMPLOYEE], 'sa-1')).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertCanLifecycleTarget(hrManager, [ROLE_CODES.EMPLOYEE], 'emp-2')).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertCanLifecycleTarget(generalManager, [ROLE_CODES.EMPLOYEE], 'emp-2')).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
  });

  it('lets HR write master pay and company; GM does not set master pay', () => {
    expect(canWriteDirectoryMasterPay(superAdmin)).toBe(false);
    expect(canWriteDirectoryPayroll(superAdmin)).toBe(false);
    expect(canWriteDirectoryAllocations(superAdmin)).toBe(false);
    expect(canWriteDirectoryMasterPay(generalManager)).toBe(false);
    expect(canWriteDirectoryAllocations(hrManager)).toBe(true);
    expect(canWriteDirectoryMasterPay(hrManager)).toBe(true);
    expect(canWriteEmployeeCompany(hrManager)).toBe(true);
    expect(canWriteEmployeeCompany(generalManager)).toBe(false);
    expect(canWriteDirectoryAllocations(generalManager)).toBe(false);
  });
});
