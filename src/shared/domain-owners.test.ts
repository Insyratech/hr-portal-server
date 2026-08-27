import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from './constants/error-codes';
import { ROLE_CODES, type RoleCode } from './constants/permissions';
import type { RequestUser } from './types/request-user';
import {
  assertCsoDomainOwner,
  assertGmDomainOwner,
  assertHrDomainOwner,
  assertSuperAdminOwner,
  isCsoDomainOwner,
  isGmDomainOwner,
  isHrDomainOwner,
  isSuperAdminOwner,
} from './domain-owners';

function user(roles: RoleCode[]): RequestUser {
  return {
    authUserId: 'a',
    employeeId: 'e-1',
    email: 'a@example.com',
    fullName: 'Test',
    roles,
    permissions: [],
  };
}

describe('domain owners', () => {
  it('recognises each portal owner and excludes Super Admin from staff domains', () => {
    expect(isHrDomainOwner(user([ROLE_CODES.HR_MANAGER]))).toBe(true);
    expect(isGmDomainOwner(user([ROLE_CODES.GENERAL_MANAGER]))).toBe(true);
    expect(isCsoDomainOwner(user([ROLE_CODES.CSO]))).toBe(true);
    expect(isSuperAdminOwner(user([ROLE_CODES.SUPER_ADMIN]))).toBe(true);

    expect(isHrDomainOwner(user([ROLE_CODES.SUPER_ADMIN, ROLE_CODES.HR_MANAGER]))).toBe(false);
    expect(isGmDomainOwner(user([ROLE_CODES.SUPER_ADMIN]))).toBe(false);
    expect(isCsoDomainOwner(user([ROLE_CODES.SUPER_ADMIN]))).toBe(false);
  });

  it('403s wrong roles on domain asserts', () => {
    expect(() => assertHrDomainOwner(user([ROLE_CODES.GENERAL_MANAGER]))).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertGmDomainOwner(user([ROLE_CODES.HR_MANAGER]))).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertCsoDomainOwner(user([ROLE_CODES.HR_MANAGER]))).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertSuperAdminOwner(user([ROLE_CODES.HR_MANAGER]))).toThrow(
      expect.objectContaining({ code: API_ERROR_CODES.FORBIDDEN }),
    );
    expect(() => assertHrDomainOwner(user([ROLE_CODES.HR_MANAGER]))).not.toThrow();
    expect(() => assertGmDomainOwner(user([ROLE_CODES.GENERAL_MANAGER]))).not.toThrow();
    expect(() => assertCsoDomainOwner(user([ROLE_CODES.CSO]))).not.toThrow();
    expect(() => assertSuperAdminOwner(user([ROLE_CODES.SUPER_ADMIN]))).not.toThrow();
  });
});
